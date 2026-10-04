import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { followTranscript, TranscriptFollower } from "../src/peek.ts";
import { outcomeFileFor, transcriptFileFor, writeOutcomeRecord, type OutcomeRecord } from "../src/store.ts";

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-follow-"));
}

/** One assistant message, as the child's teed NDJSON stream carries it. */
function msg(text: string): string {
	return `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

const RECORD: OutcomeRecord = { completionSource: "process-exit", exitCode: 0, startedAt: 1, endedAt: 2 };

test("follow: tails appended lines, rendering each exactly once", () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	const f = new TranscriptFollower(file);

	fs.writeFileSync(file, msg("first"));
	const a = f.step();
	assert.equal(a.done, false);
	assert.deepEqual(a.lines, ["[assistant] first"]);

	// A poll with nothing appended must not re-render what was already shown.
	assert.deepEqual(f.step().lines, []);

	fs.appendFileSync(file, msg("second"));
	assert.deepEqual(f.step().lines, ["[assistant] second"]);

	fs.appendFileSync(file, msg("third"));
	fs.appendFileSync(file, msg("fourth"));
	assert.deepEqual(f.step().lines, ["[assistant] third", "", "[assistant] fourth"]);
});

test("follow: a half-written line is held back, then rendered once complete", () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	const f = new TranscriptFollower(file);
	const whole = msg("spanning");
	fs.writeFileSync(file, whole.slice(0, 20));
	assert.deepEqual(f.step().lines, []);
	fs.appendFileSync(file, whole.slice(20));
	assert.deepEqual(f.step().lines, ["[assistant] spanning"]);
});

test("follow: a missing transcript is waited on, not an error", async () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	const f = new TranscriptFollower(file);
	assert.deepEqual(f.step(), { lines: [], done: false });
	assert.equal(fs.existsSync(file), false, "following must not create the file");

	// The async loop keeps polling until output appears, then finishes.
	const lines: string[] = [];
	const done = followTranscript(file, { write: (l) => lines.push(l), intervalMs: 5 });
	await new Promise((r) => setTimeout(r, 25));
	assert.deepEqual(lines, [], "nothing rendered while the file is absent");
	fs.writeFileSync(file, msg("late output"));
	writeOutcomeRecord(dir, "scan", RECORD);
	await done;
	assert.deepEqual(lines, ["[assistant] late output", "─── node finished: process-exit (exit 0) ───"]);
});

test("follow: the finished banner follows the outcome record, and the trailing output", () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	const f = new TranscriptFollower(file);
	assert.equal(f.outcomeFile, outcomeFileFor(dir, "scan"));

	fs.writeFileSync(file, msg("working"));
	const before = f.step();
	assert.equal(before.done, false);
	assert.ok(!before.lines.some((l) => l.includes("finished")), "no banner before the record exists");

	// Output written between the last poll and the record is flushed BEFORE the
	// banner, so the banner is always the last row.
	fs.appendFileSync(file, msg("last words"));
	writeOutcomeRecord(dir, "scan", { ...RECORD, completionSource: "idle-timeout", exitCode: 0, signal: "SIGKILL" });
	const after = f.step();
	assert.equal(after.done, true);
	assert.deepEqual(after.lines, ["[assistant] last words", "─── node finished: idle-timeout (signal SIGKILL) ───"]);
	assert.deepEqual(f.step(), { lines: [], done: true }, "nothing is emitted after finishing");
});

test("follow: renders through the injected renderer (the inspector's path)", async () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	fs.writeFileSync(file, msg("themed"));
	writeOutcomeRecord(dir, "scan", RECORD);
	const lines: string[] = [];
	await followTranscript(file, {
		intervalMs: 1,
		write: (l) => lines.push(l),
		render: (entries) => entries.map((e) => `R:${e.type}`),
	});
	assert.deepEqual(lines, ["R:text", "─── node finished: process-exit (exit 0) ───"]);
});

test("follow: aborting stops the loop without a banner", async () => {
	const dir = mkTmp();
	const file = transcriptFileFor(dir, "scan");
	fs.writeFileSync(file, msg("still running"));
	const ac = new AbortController();
	const lines: string[] = [];
	const done = followTranscript(file, { write: (l) => lines.push(l), intervalMs: 5, signal: ac.signal });
	await new Promise((r) => setTimeout(r, 15));
	ac.abort();
	await done;
	assert.deepEqual(lines, ["[assistant] still running"]);
});
