/**
 * The shared transcript tee (`openTranscriptTee`) and its wiring through
 * `runSubagentProcess({ transcriptFile, transcriptHost })`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	openTranscriptTee,
	runSubagentProcess,
	type SubagentAccumulator,
} from "../src/runner-core.ts";
import type { LiveUpdate } from "../src/host/runner-types.ts";

const header = (host: string) => JSON.stringify({ type: "taskflow_transcript", host, v: 1 });

/** The tee's stream flushes asynchronously after close(); poll until `done`. */
async function readWhen(file: string, done: (text: string) => boolean): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
		if (done(text)) return text;
		await new Promise((r) => setTimeout(r, 20));
	}
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return fn().finally(() => {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	});
}

function makeAcc(): SubagentAccumulator {
	return { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, finalText: "", lastActivity: "" };
}
const foldLine = (acc: SubagentAccumulator, line: string): LiveUpdate | null => {
	acc.finalText = line.trim();
	return null;
};
const EMIT = `for (const t of ["a","b","c"]) process.stdout.write(JSON.stringify({type:t})+"\\n");`;

function run(transcriptFile: string | undefined, onRawLine?: (line: string) => void) {
	return runSubagentProcess({
		agent: "test", task: "t", bin: process.execPath, args: ["-e", EMIT], cwd: process.cwd(),
		acc: makeAcc(), foldLine, transcriptFile, transcriptHost: "codex", onRawLine,
	});
}

test("openTranscriptTee: header line comes first, then raw lines verbatim", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tee-"));
	try {
		const file = path.join(dir, "nested", "n.ndjson");
		const tee = openTranscriptTee(file, "claude");
		assert.ok(tee);
		tee.onRawLine('{"type":"x"}');
		tee.close();
		const text = await readWhen(file, (t) => t.includes('"x"'));
		assert.deepEqual(text.split("\n").filter(Boolean), [header("claude"), '{"type":"x"}']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("openTranscriptTee: cap writes one truncation marker and stops", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tee-cap-"));
	try {
		const file = path.join(dir, "n.ndjson");
		const cap = Buffer.byteLength(`${header("pi")}\n{"type":"a"}\n`);
		await withEnv("PI_TASKFLOW_TRANSCRIPT_MAX_BYTES", String(cap), async () => {
			const tee = openTranscriptTee(file, "pi");
			assert.ok(tee);
			for (const t of ["a", "b", "c"]) tee.onRawLine(JSON.stringify({ type: t }));
			tee.close();
		});
		const text = await readWhen(file, (t) => t.includes("taskflow_truncated"));
		assert.deepEqual(text.split("\n").filter(Boolean), [header("pi"), '{"type":"a"}', '{"type":"taskflow_truncated"}']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("openTranscriptTee: an unwritable directory yields no tee", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tee-bad-"));
	try {
		const blocker = path.join(dir, "not-a-dir");
		fs.writeFileSync(blocker, "x");
		assert.equal(openTranscriptTee(path.join(blocker, "n.ndjson"), "pi"), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagentProcess: transcriptFile tees the stream behind the host header", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tee-run-"));
	try {
		const file = path.join(dir, "n.ndjson");
		const seen: string[] = [];
		// A throwing caller observer is disabled on its own; the tee keeps writing.
		const r = await run(file, (line) => {
			seen.push(line);
			throw new Error("observer boom");
		});
		assert.equal(r.exitCode, 0);
		assert.deepEqual(seen, ['{"type":"a"}']);
		const text = await readWhen(file, (t) => t.includes('"c"'));
		assert.deepEqual(text.split("\n").filter(Boolean), [header("codex"), '{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagentProcess: an unwritable transcriptFile leaves the RunResult unchanged", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tee-run-bad-"));
	try {
		const blocker = path.join(dir, "not-a-dir");
		fs.writeFileSync(blocker, "x");
		const baseline = await run(undefined);
		const teed = await run(path.join(blocker, "n.ndjson"));
		for (const key of ["exitCode", "output", "stderr", "errorMessage", "stopReason"] as const) {
			assert.equal(teed[key], baseline[key], key);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
