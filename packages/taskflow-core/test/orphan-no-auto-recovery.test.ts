/**
 * Orphaned nodes stay out of automatic recovery (design D5): loading, listing
 * and resuming a run with an orphaned node must neither retry nor complete it,
 * and the state has to reach the user. Spawn-free — liveness is probed against
 * a pid that cannot be alive.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { forkRunForResume, validateResumeRequest } from "../src/resume.ts";
import type { Taskflow } from "../src/schema.ts";
import {
	listRuns,
	loadRun,
	runsDir,
	saveRun,
	transcriptDirFor,
	writeWorkerRecord,
	type RunState,
} from "../src/store.ts";

const FLOW: Taskflow = {
	name: "orphan-flow",
	phases: [
		{ id: "prep", type: "agent", agent: "a", task: "do-prep" },
		{ id: "scan", type: "agent", agent: "a", task: "do-scan", dependsOn: ["prep"], final: true },
	],
};

/** A stored run whose `scan` node was left running by a dead orchestrator: a
 *  worker record exists (so liveness is probeable) and no outcome record does. */
function storeOrphanedRun(cwd: string, runId: string): RunState {
	const state: RunState = {
		runId,
		flowName: FLOW.name,
		def: FLOW,
		args: {},
		// The orchestrator recorded the run itself as failed before dying, so the
		// run is resumable and only the node's own state is in question.
		status: "failed",
		phases: {
			prep: { id: "prep", status: "done", output: "OUT-PREP", inputHash: "hp" },
			scan: { id: "scan", status: "running", startedAt: 1 },
		},
		createdAt: 1,
		updatedAt: 2,
		cwd,
	};
	saveRun(state);
	// 0x7ffffffe: inside the probeable pid range, but no such process exists.
	writeWorkerRecord(transcriptDirFor(runsDir(cwd), FLOW.name, runId), "scan", {
		pid: 0x7ffffffe,
		pgid: 0x7ffffffe,
		startedAt: 1,
	});
	return state;
}

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "orphan-recovery-"));
}

test("loading and listing a run with an orphaned node reports it as orphaned, not retried or completed", () => {
	const cwd = tmpCwd();
	try {
		storeOrphanedRun(cwd, "r-orphan-load");

		const loaded = loadRun(cwd, "r-orphan-load");
		assert.equal(loaded?.phases.scan?.reattach, "orphaned", "the state has to reach the user");
		assert.equal(loaded?.phases.scan?.status, "running", "never completed or failed on a guess");
		assert.equal(loaded?.phases.scan?.output, undefined, "no result invented for work nobody observed");
		assert.equal(loaded?.status, "failed", "the run is not reported as done");

		const listed = listRuns(cwd).find((r) => r.runId === "r-orphan-load");
		assert.equal(listed?.phases.scan?.reattach, "orphaned", "listing surfaces the state too");
		assert.equal(listed?.phases.scan?.status, "running");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("resume of a run with an orphaned node is refused — the node is not silently re-run", () => {
	const cwd = tmpCwd();
	try {
		storeOrphanedRun(cwd, "r-orphan-resume");
		const prev = loadRun(cwd, "r-orphan-resume")!;

		const plain = validateResumeRequest(prev);
		assert.equal(plain.ok, false);
		assert.match(plain.errors.join(" "), /orphaned node\(s\) scan/);
		assert.throws(() => forkRunForResume(prev), /orphaned node\(s\) scan/);

		// An override naming a DIFFERENT phase does not unlock the orphan either.
		const elsewhere = validateResumeRequest(prev, { phaseId: "prep", task: "redo-prep" });
		assert.equal(elsewhere.ok, false);
		assert.match(elsewhere.errors.join(" "), /orphaned node\(s\) scan/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("an explicit override naming the orphaned node re-runs it; other runs resume unaffected", () => {
	const cwd = tmpCwd();
	try {
		storeOrphanedRun(cwd, "r-orphan-override");
		const prev = loadRun(cwd, "r-orphan-override")!;

		const explicit = validateResumeRequest(prev, { phaseId: "scan", task: "redo-scan" });
		assert.deepEqual(explicit.errors, []);
		const child = forkRunForResume(prev, { overrides: { phaseId: "scan", task: "redo-scan" } });
		assert.deepEqual(Object.keys(child.phases), ["prep"], "the orphan is cleared so it re-runs, on request");
		assert.equal(child.def.phases.find((p) => p.id === "scan")?.task, "redo-scan");

		// A run with the same stored shape but no orphan classification resumes
		// normally: the guard keys on the reattach state, nothing else.
		const healthy = loadRun(cwd, "r-orphan-override")!;
		delete healthy.phases.scan.reattach;
		assert.equal(validateResumeRequest(healthy).ok, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
