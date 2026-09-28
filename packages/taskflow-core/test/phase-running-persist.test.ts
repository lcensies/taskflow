import assert from "node:assert/strict";
import { test } from "node:test";
import { executeTaskflow, type RunState, type RuntimeDeps, type Taskflow } from "../src/index.ts";

/**
 * Regression test for the "in-flight phase renders as pending" bug: a phase
 * that has started but not yet finished must be PERSISTED with
 * `status: "running"` (and a `startedAt`), not merely held in memory. A
 * detached run is polled from disk (or its viewer reads the saved RunState),
 * so a running phase that is never flushed until it completes is
 * indistinguishable from a phase that never started — the viewer falls back
 * to "pending" for it.
 */
async function assertRunningPhasePersisted(eventKernel: boolean): Promise<void> {
	const def: Taskflow = {
		name: "inflight-persist",
		phases: [{ id: "work", type: "agent", agent: "executor", task: "work", final: true }],
	};
	const now = Date.now();
	const state: RunState = {
		runId: "inflight-persist-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: now,
		updatedAt: now,
		cwd: process.cwd(),
	};

	// Gate: the mock runTask blocks until the test explicitly releases it, so
	// we can inspect the persisted snapshots taken WHILE the phase is in flight.
	let releaseTask: () => void = () => {};
	const taskGate = new Promise<void>((resolve) => {
		releaseTask = resolve;
	});

	const snapshots: RunState[] = [];
	const deps: RuntimeDeps = {
		cwd: process.cwd(),
		eventKernel,
		agents: [{
			name: "executor",
			description: "test",
			systemPrompt: "test",
			source: "built-in",
			filePath: "test",
		}],
		runTask: async () => {
			await taskGate;
			return {
				agent: "executor",
				task: "work",
				exitCode: 0,
				output: "done",
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
				stopReason: "end",
			};
		},
		persist: (snapshot) => snapshots.push(structuredClone(snapshot)),
	};

	const runPromise = executeTaskflow(state, deps);

	// Let the phase-start checkpoint flush before releasing the mock task.
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(
		snapshots.some((s) => s.phases.work?.status === "running" && typeof s.phases.work?.startedAt === "number"),
		`expected a persisted snapshot with phases.work.status === "running" (eventKernel=${eventKernel}); got: ${JSON.stringify(snapshots.map((s) => s.phases.work?.status))}`,
	);

	releaseTask();
	const result = await runPromise;
	assert.equal(result.finalOutput, "done");
	assert.equal(result.state.phases.work?.status, "done");
}

for (const eventKernel of [false, true]) {
	test(
		`runtime: in-flight phase is persisted as "running" before it completes (${eventKernel ? "event kernel" : "imperative"})`,
		() => assertRunningPhasePersisted(eventKernel),
	);
}
