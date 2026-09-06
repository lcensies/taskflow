import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { appendSteerMessage, readSteerMessages, steerDirFor, steerFileFor } from "../src/steer.ts";
import { executeTaskflow, LIVE_LOG_MAX, type RuntimeDeps } from "../src/runtime.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-steer-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

// ---------------------------------------------------------------------------
// steer file transport
// ---------------------------------------------------------------------------

test("steer: messages are read once, in order, past the offset", () => {
	const dir = tmpDir();
	try {
		const file = steerFileFor(steerDirFor(dir, "run-1"), "phase-a");
		assert.deepEqual(readSteerMessages(file), { messages: [], offset: 0 });

		appendSteerMessage(file, "first");
		appendSteerMessage(file, "second");
		const first = readSteerMessages(file);
		assert.deepEqual(first.messages, ["first", "second"]);

		// Nothing new: same offset, no re-delivery.
		const second = readSteerMessages(file, first.offset);
		assert.deepEqual(second.messages, []);
		assert.equal(second.offset, first.offset);

		appendSteerMessage(file, "third");
		const third = readSteerMessages(file, second.offset);
		assert.deepEqual(third.messages, ["third"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("steer: a partial trailing line is not consumed until it completes", () => {
	const dir = tmpDir();
	try {
		const file = path.join(dir, "node.jsonl");
		fs.writeFileSync(file, `${JSON.stringify({ text: "complete" })}\n{"text":"partial`, "utf8");
		const read = readSteerMessages(file);
		assert.deepEqual(read.messages, ["complete"]);

		fs.appendFileSync(file, '"}\n', "utf8");
		assert.deepEqual(readSteerMessages(file, read.offset).messages, ["partial"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("steer: empty messages are ignored and a traversal runId is rejected", () => {
	const dir = tmpDir();
	try {
		const file = path.join(dir, "node.jsonl");
		assert.equal(appendSteerMessage(file, "   "), false);
		assert.equal(fs.existsSync(file), false);
		assert.throws(() => steerDirFor(dir, "../escape"));
		assert.throws(() => steerFileFor(dir, ".."));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// runtime wiring
// ---------------------------------------------------------------------------

test("steer: the runtime hands each phase and fan-out item its own steer file", async () => {
	const cwd = tmpDir();
	try {
		const seen: string[] = [];
		const def: Taskflow = {
			name: "f",
			phases: [
				{ id: "one", agent: "a", task: "t", output: "json" },
				{
					id: "many",
					type: "map",
					agent: "a",
					over: "{steps.one.json}",
					task: "t {item}",
					dependsOn: ["one"],
				},
			],
		};
		const state = mkState(def, cwd);
		const deps: RuntimeDeps = {
			cwd,
			agents: AGENTS,
			steerDir: steerDirFor(cwd, state.runId),
			runTask: async (_c, _a, agentName, task, o: RunOptions): Promise<RunResult> => {
				seen.push(o.steerFile ? path.basename(o.steerFile) : "(none)");
				return {
					agent: agentName,
					task,
					exitCode: 0,
					output: task === "t" ? '["x","y"]' : "ok",
					stderr: "",
					usage: emptyUsage(),
					stopReason: "end",
				};
			},
		};
		await executeTaskflow(state, deps);
		assert.deepEqual(seen.sort(), ["many-0.jsonl", "many-1.jsonl", "one.jsonl"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("steer: a steered phase is not written to the cross-run cache", async () => {
	const cwd = tmpDir();
	try {
		const def: Taskflow = {
			name: "f",
			phases: [
				{ id: "steered", agent: "a", task: "t", cache: { scope: "cross-run" } },
				{ id: "plain", agent: "a", task: "t2", cache: { scope: "cross-run" } },
			],
		};
		let calls = 0;
		const runTask = async (_c: string, _a: AgentConfig[], agentName: string, task: string): Promise<RunResult> => {
			calls++;
			return {
				agent: agentName,
				task,
				exitCode: 0,
				output: `out-${task}`,
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		};

		const first = mkState(def, cwd);
		await executeTaskflow(first, {
			cwd,
			agents: AGENTS,
			runTask,
			// Mark the phase as steered exactly like the host does: on the live state.
			onProgress: (s) => {
				if (s.phases.steered?.status === "running") s.phases.steered.steered = true;
			},
		});
		assert.equal(first.phases.steered.steered, true);

		const callsAfterFirst = calls;
		const second = mkState(def, cwd);
		await executeTaskflow(second, { cwd, agents: AGENTS, runTask });
		// `plain` came from the cache; `steered` had to run again.
		assert.equal(calls - callsAfterFirst, 1);
		assert.equal(second.phases.plain.cacheHit, "cross-run");
		assert.equal(second.phases.steered.cacheHit, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// activity history
// ---------------------------------------------------------------------------

test("liveLog: bounded, ordered, and free of consecutive duplicates", async () => {
	const cwd = tmpDir();
	try {
		const def: Taskflow = { name: "f", phases: [{ id: "p", agent: "a", task: "t" }] };
		const state = mkState(def, cwd);
		await executeTaskflow(state, {
			cwd,
			agents: AGENTS,
			runTask: async (_c, _a, agentName, task, o: RunOptions): Promise<RunResult> => {
				o.onLive?.({ text: "read a.ts", usage: emptyUsage() });
				o.onLive?.({ text: "read a.ts", usage: emptyUsage() }); // duplicate tick
				for (let i = 0; i < LIVE_LOG_MAX + 5; i++) {
					o.onLive?.({ text: `step ${i}`, usage: emptyUsage() });
				}
				return {
					agent: agentName,
					task,
					exitCode: 0,
					output: "ok",
					stderr: "",
					usage: emptyUsage(),
					stopReason: "end",
				};
			},
		});
		const log = state.phases.p.liveLog ?? [];
		assert.equal(log.length, LIVE_LOG_MAX);
		assert.equal(log[log.length - 1], `step ${LIVE_LOG_MAX + 4}`);
		// Oldest entries were dropped, not reordered.
		assert.ok(log.every((line, i) => i === 0 || line !== log[i - 1]));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
