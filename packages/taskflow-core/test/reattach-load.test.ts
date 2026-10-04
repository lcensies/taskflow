/**
 * Reattach reconciliation on run load (design D5): a stored phase marked
 * `running` is reconciled against the records its worker left on disk.
 * Spawn-free — liveness is probed against a pid that cannot be alive.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	loadRun,
	runsDir,
	saveRun,
	transcriptDirFor,
	writeOutcomeRecord,
	writeWorkerRecord,
	type RunState,
} from "../src/store.ts";

function tmpCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "reattach-load-"));
}

/** A run with one phase stored as `running` (the orchestrator died mid-flight). */
function mkRunningRun(cwd: string, runId: string): RunState {
	return {
		runId,
		flowName: "f",
		def: { name: "f", phases: [], concurrency: 1 },
		args: {},
		status: "running",
		phases: { scan: { id: "scan", status: "running", startedAt: 1 } },
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function transcriptDir(cwd: string, runId: string): string {
	return transcriptDirFor(runsDir(cwd), "f", runId);
}

test("loadRun: a stored-running phase with an outcome record loads as finished from the record", () => {
	const cwd = tmpCwd();
	try {
		saveRun(mkRunningRun(cwd, "r-adopt"));
		writeOutcomeRecord(transcriptDir(cwd, "r-adopt"), "scan", {
			completionSource: "terminal-reap",
			exitCode: 0,
			startedAt: 1,
			endedAt: 42,
		});

		const phase = loadRun(cwd, "r-adopt")?.phases.scan;
		assert.equal(phase?.reattach, "finished-unrecorded");
		assert.equal(phase?.completionSource, "terminal-reap");
		assert.equal(phase?.status, "done", "a clean recorded exit is finished, not still running");
		assert.equal(phase?.endedAt, 42);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRun: a record naming a non-clean settle is finished as failed, carrying its completionSource", () => {
	const cwd = tmpCwd();
	try {
		saveRun(mkRunningRun(cwd, "r-killed"));
		writeOutcomeRecord(transcriptDir(cwd, "r-killed"), "scan", {
			completionSource: "idle-timeout",
			exitCode: 0,
			signal: "SIGKILL",
			startedAt: 1,
			endedAt: 9,
		});

		const phase = loadRun(cwd, "r-killed")?.phases.scan;
		assert.equal(phase?.reattach, "finished-unrecorded");
		assert.equal(phase?.completionSource, "idle-timeout");
		assert.equal(phase?.status, "failed");
		assert.match(String(phase?.error), /idle-timeout/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRun: no outcome record and a dead worker pid loads as orphaned, not failed or done", () => {
	const cwd = tmpCwd();
	try {
		saveRun(mkRunningRun(cwd, "r-orphan"));
		// 0x7ffffffe: inside the probeable pid range, but no such process exists.
		writeWorkerRecord(transcriptDir(cwd, "r-orphan"), "scan", {
			pid: 0x7ffffffe,
			pgid: 0x7ffffffe,
			startedAt: 1,
		});

		const phase = loadRun(cwd, "r-orphan")?.phases.scan;
		assert.equal(phase?.reattach, "orphaned");
		assert.equal(phase?.status, "running", "orphaned is reported as itself, never rewritten");
		assert.equal(phase?.error, undefined);
		assert.equal(phase?.completionSource, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadRun: a live worker with no record stays running, and a run with no records is untouched", () => {
	const cwd = tmpCwd();
	try {
		saveRun(mkRunningRun(cwd, "r-live"));
		writeWorkerRecord(transcriptDir(cwd, "r-live"), "scan", { pid: process.pid, startedAt: 1 });
		const live = loadRun(cwd, "r-live")?.phases.scan;
		assert.equal(live?.status, "running");
		assert.equal(live?.reattach, undefined);

		saveRun(mkRunningRun(cwd, "r-legacy"));
		const legacy = loadRun(cwd, "r-legacy")?.phases.scan;
		assert.deepEqual(legacy, { id: "scan", status: "running", startedAt: 1 });
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
