/**
 * The worker record written at spawn by the process that owns the child
 * (`runSubagentProcess` in runner-core.ts). It must name the child's real
 * process group, and it must still be readable once the spawning process is
 * gone — that is the whole point: a later process probes liveness from it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runSubagentProcess, type SubagentAccumulator } from "../src/runner-core.ts";
import { readWorkerRecord, workerFileFor, type WorkerRecord } from "../src/store.ts";

const POSIX_ONLY = { skip: process.platform === "win32" };
const NODE_ID = "review:api";

const emptyAcc = (): SubagentAccumulator => ({
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	finalText: "",
	lastActivity: "",
});

/** A worker that reports the process group the OS actually put it in, then
 *  either exits or stays alive until killed. */
const WORKER = `
const { execSync } = require("node:child_process");
const pgid = execSync("ps -o pgid= -p " + process.pid).toString().trim();
require("node:fs").writeFileSync(process.argv[2], pgid);
if (process.argv[3] === "exit") process.exit(0);
setInterval(() => {}, 1000);
`;

function workerFixture(dir: string): string {
	const file = path.join(dir, "worker.cjs");
	fs.writeFileSync(file, WORKER);
	return file;
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = fs.readFileSync(file, "utf-8").trim();
			if (text) return text;
		} catch { /* not written yet */ }
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${file}`);
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

test("worker record: the recorded id is the spawned child's process group", POSIX_ONLY, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-worker-"));
	try {
		const reported = path.join(dir, "pgid.txt");
		await runSubagentProcess({
			agent: "test",
			task: "worker record",
			bin: process.execPath,
			args: [workerFixture(dir), reported, "exit"],
			cwd: process.cwd(),
			outcomeDir: dir,
			nodeId: NODE_ID,
			acc: emptyAcc(),
			foldLine: () => null,
		});

		const record = readWorkerRecord(dir, NODE_ID);
		assert.ok(record, "a worker record is written for an observed child");
		assert.equal(record.pgid, Number(await waitForFile(reported)));
		assert.equal(record.pid, record.pgid, "a detached child leads its own group");
		assert.ok(record.startedAt <= Date.now());
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("worker record: readable after the spawning process is gone", POSIX_ONLY, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-worker-crash-"));
	const runnerModule = pathToFileURL(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/runner-core.ts"),
	).href;
	const reported = path.join(dir, "pgid.txt");
	let pgid: number | undefined;
	try {
		// A spawner that will be killed without ever observing its child settle.
		const spawner = spawn(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`
			import { runSubagentProcess } from ${JSON.stringify(runnerModule)};
			await runSubagentProcess({
				agent: "test",
				task: "worker record",
				bin: process.execPath,
				args: [${JSON.stringify(workerFixture(dir))}, ${JSON.stringify(reported)}],
				cwd: process.cwd(),
				outcomeDir: ${JSON.stringify(dir)},
				nodeId: ${JSON.stringify(NODE_ID)},
				acc: ${JSON.stringify(emptyAcc())},
				foldLine: () => null,
			});
			`,
		], { stdio: "ignore" });

		const reportedPgid = Number(await waitForFile(reported));
		const spawnerExit = new Promise<void>((resolve) => spawner.once("exit", () => resolve()));
		spawner.kill("SIGKILL");
		await spawnerExit;

		const record = JSON.parse(fs.readFileSync(workerFileFor(dir, NODE_ID), "utf-8")) as WorkerRecord;
		assert.equal(record.pgid, reportedPgid, "the surviving record names the live worker's group");
		pgid = record.pgid;
		assert.equal(groupAlive(pgid!), true, "the recorded group is probeable after its observer died");
	} finally {
		if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
