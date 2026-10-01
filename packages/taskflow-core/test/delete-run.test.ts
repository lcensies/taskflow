/**
 * Explicit deletion: one stored run, all finished runs, one saved flow.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Taskflow } from "../src/schema.ts";
import {
	deleteFlow,
	deleteRun,
	deleteTerminalRuns,
	listFlows,
	listRuns,
	loadRun,
	newRunId,
	runsDir,
	saveFlow,
	saveRun,
	transcriptDirFor,
	transcriptFileFor,
	type RunState,
} from "../src/store.ts";

function makeTmpCwd(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-delete-test-"));
	fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
	return tmp;
}

function minimalFlow(name: string): Taskflow {
	return { name, phases: [{ id: "p1", type: "agent", agent: "a", task: "do something" }] };
}

function mkRun(cwd: string, overrides: Partial<RunState> = {}): RunState {
	const flowName = overrides.flowName ?? "del-flow";
	return {
		runId: overrides.runId ?? newRunId(flowName),
		flowName,
		def: minimalFlow(flowName),
		args: {},
		status: "completed",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
		...overrides,
	};
}

/** A saved run plus the artifacts deletion is expected to take with it. */
function saveRunWithArtifacts(cwd: string, overrides: Partial<RunState> = {}): RunState {
	const state = mkRun(cwd, overrides);
	saveRun(state, { maxKeep: 0, maxAgeDays: 0 });
	const root = runsDir(cwd);
	const tdir = transcriptDirFor(root, state.flowName, state.runId);
	fs.mkdirSync(tdir, { recursive: true });
	fs.writeFileSync(transcriptFileFor(tdir, "p1"), '{"type":"text"}\n');
	return state;
}

test("deleteRun: removes a finished run and its artifacts", () => {
	const cwd = makeTmpCwd();
	try {
		const run = saveRunWithArtifacts(cwd);
		const tdir = transcriptDirFor(runsDir(cwd), run.flowName, run.runId);
		assert.equal(fs.existsSync(tdir), true);

		assert.deepEqual(deleteRun(cwd, run.runId), { ok: true });

		assert.equal(loadRun(cwd, run.runId), null);
		assert.equal(listRuns(cwd).some((r) => r.runId === run.runId), false);
		assert.equal(fs.existsSync(tdir), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteRun: refuses a running run and leaves it intact", () => {
	const cwd = makeTmpCwd();
	try {
		const run = saveRunWithArtifacts(cwd, { status: "running" });
		assert.deepEqual(deleteRun(cwd, run.runId), { ok: false, reason: "running" });
		assert.notEqual(loadRun(cwd, run.runId), null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteRun: unknown id reports missing", () => {
	const cwd = makeTmpCwd();
	try {
		assert.deepEqual(deleteRun(cwd, "no-such-run"), { ok: false, reason: "missing" });
		assert.deepEqual(deleteRun(cwd, "../escape"), { ok: false, reason: "missing" });
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteTerminalRuns: clears finished runs, keeps the running one", () => {
	const cwd = makeTmpCwd();
	try {
		saveRunWithArtifacts(cwd, { status: "completed" });
		saveRunWithArtifacts(cwd, { status: "failed" });
		const live = saveRunWithArtifacts(cwd, { status: "running" });

		assert.equal(deleteTerminalRuns(cwd), 2);
		const left = listRuns(cwd);
		assert.deepEqual(left.map((r) => r.runId), [live.runId]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteFlow: removes the definition and its sidecar, runs survive", () => {
	const cwd = makeTmpCwd();
	try {
		const { filePath } = saveFlow(cwd, minimalFlow("doomed"), "project");
		const sidecar = filePath.replace(/\.json$/, ".meta.json");
		fs.writeFileSync(sidecar, JSON.stringify({ purpose: "x" }));
		const run = saveRunWithArtifacts(cwd, { flowName: "doomed" });

		assert.equal(deleteFlow(cwd, "doomed"), true);
		assert.equal(listFlows(cwd).some((f) => f.name === "doomed"), false);
		assert.equal(fs.existsSync(filePath), false);
		assert.equal(fs.existsSync(sidecar), false);
		assert.notEqual(loadRun(cwd, run.runId), null);

		assert.equal(deleteFlow(cwd, "doomed"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
