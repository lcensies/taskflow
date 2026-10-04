/**
 * The durable outcome record written by the process that observed a worker
 * settle (`runSubagentProcess` in runner-core.ts). Every settle path must leave
 * a record naming how the completion was classified, and an unwritable record
 * location must not change the RunResult at all.
 *
 * Driven against real short-lived child processes, like runner-process.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSubagentProcess, type SubagentAccumulator } from "../src/runner-core.ts";
import { outcomeFileFor, type OutcomeRecord } from "../src/store.ts";
import type { LiveUpdate, RunResult } from "../src/host/runner-types.ts";

interface TerminalAcc extends SubagentAccumulator {
	terminalSeen?: boolean;
}

function makeAcc(): TerminalAcc {
	return {
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		finalText: "",
		lastActivity: "",
		terminalSeen: false,
	};
}

const foldLine = (acc: TerminalAcc, line: string): LiveUpdate | null => {
	const event = JSON.parse(line) as { type?: string; text?: string };
	if (event.type === "final" && event.text) {
		acc.finalText = event.text;
		acc.stopReason = "end";
		return { text: event.text, usage: { ...acc.usage } };
	}
	if (event.type === "terminal") acc.terminalSeen = true;
	return null;
};

/** Spawn a fake child (`node -e <script>`) with the terminal-event policy the
 *  process-backed hosts use, optionally recording its outcome into `dir`. */
function run(
	script: string,
	opts: { dir?: string; nodeId?: string; idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
	return runSubagentProcess({
		agent: "test",
		task: "outcome",
		bin: process.execPath,
		args: ["-e", script],
		cwd: process.cwd(),
		idleTimeoutMs: opts.idleTimeoutMs,
		signal: opts.signal,
		outcomeDir: opts.dir,
		nodeId: opts.nodeId ?? "review:api",
		acc: makeAcc(),
		foldLine,
		completionPolicy: {
			terminalGraceMs: 50,
			classifyEvent(_acc, event) {
				const type = (event as { type?: string }).type;
				if (type === "terminal") return "terminal-candidate";
				if (type === "activity" || type === "final") return "activity";
				return "ignore";
			},
			canCommitTerminal: (acc) => Boolean(acc.terminalSeen && acc.finalText.trim()),
		},
		requireTerminalEvent: true,
		terminalEventLabel: "terminal",
	});
}

function readRecord(dir: string, nodeId = "review:api"): OutcomeRecord {
	return JSON.parse(fs.readFileSync(outcomeFileFor(dir, nodeId), "utf-8")) as OutcomeRecord;
}

const EMIT = `const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");`;
const CLEAN = `${EMIT}emit({type:"final",text:"DONE"});emit({type:"terminal"});`;

test("outcome record: every settle path leaves a record naming the completion source", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-outcome-"));
	try {
		// process-exit: the child emits its terminal event and exits on its own.
		const exited = await run(CLEAN, { dir });
		assert.equal(exited.completionSource, "process-exit");
		const exitedRecord = readRecord(dir);
		assert.equal(exitedRecord.completionSource, "process-exit");
		assert.equal(exitedRecord.exitCode, 0);
		assert.equal(exitedRecord.signal, undefined);
		assert.equal(typeof exitedRecord.pid, "number");
		assert.ok(exitedRecord.startedAt <= exitedRecord.endedAt);
		assert.ok(exitedRecord.endedAt <= Date.now());

		// terminal-reap: a committed terminal event, then a leaked handle reaped.
		const reaped = await run(`${CLEAN}setInterval(()=>{},1000);`, { dir });
		assert.equal(reaped.completionSource, "terminal-reap");
		assert.equal(readRecord(dir).completionSource, "terminal-reap");

		// idle-timeout: the watchdog kills a child that never answers.
		const stalled = await run(`${EMIT}emit({type:"terminal"});setInterval(()=>{},1000);`, {
			dir,
			idleTimeoutMs: 80,
		});
		assert.equal(stalled.completionSource, "idle-timeout");
		const stalledRecord = readRecord(dir);
		assert.equal(stalledRecord.completionSource, "idle-timeout");
		if (process.platform !== "win32") assert.ok(stalledRecord.signal, "a killed child records its signal");

		// abort: the orchestrator cancels mid-flight.
		const ac = new AbortController();
		const pending = run(`${EMIT}emit({type:"activity"});setInterval(()=>{},1000);`, {
			dir,
			idleTimeoutMs: 60_000,
			signal: ac.signal,
		});
		setTimeout(() => ac.abort(), 30);
		const aborted = await pending;
		assert.equal(aborted.completionSource, "abort");
		assert.equal(readRecord(dir).completionSource, "abort");

		// protocol-error: a truncated record fails the transport contract.
		const broken = await run(`process.stdout.write('{"type":"final"');`, { dir });
		assert.equal(broken.completionSource, "protocol-error");
		const brokenRecord = readRecord(dir);
		assert.equal(brokenRecord.completionSource, "protocol-error");
		assert.equal(brokenRecord.exitCode, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test(
	"outcome record: an unwritable location leaves the RunResult byte-identical",
	{ skip: process.platform === "win32" || process.getuid?.() === 0 },
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "taskflow-outcome-ro-"));
		try {
			const withoutRecording = await run(CLEAN);
			fs.chmodSync(dir, 0o500);
			const withUnwritableDir = await run(CLEAN, { dir });
			assert.equal(JSON.stringify(withUnwritableDir), JSON.stringify(withoutRecording));
			assert.equal(fs.existsSync(outcomeFileFor(dir, "review:api")), false);
		} finally {
			fs.chmodSync(dir, 0o700);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);
