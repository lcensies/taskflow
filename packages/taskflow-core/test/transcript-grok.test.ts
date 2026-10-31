/**
 * Grok Build `streaming-json` transcripts: a `host:"grok"` header routes
 * text/thought chunks through the grok normaliser (text/thinking only — the
 * stream has no tool events). Fixture lines follow
 * taskflow-hosts/test/grok-runner.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTranscript, TranscriptTail } from "../src/transcript.ts";

const HEADER = `{"type":"taskflow_transcript","host":"grok","v":1}`;
const parse = (lines: string[]) => parseTranscript([HEADER, ...lines].join("\n"));
const ev = (o: unknown) => JSON.stringify(o);

test("grok transcript: chunks coalesce per segment; end flushes", () => {
	assert.deepEqual(
		parse([
			ev({ type: "thought", data: "planning" }),
			ev({ type: "thought", data: "\u2026" }),
			ev({ type: "auto_compact_start" }),
			ev({ type: "text", data: "Hello" }),
			ev({ type: "text", data: " world" }),
			ev({ type: "end", stopReason: "EndTurn", sessionId: "abc" }),
		]),
		[
			{ type: "thinking", text: "planning\u2026" },
			{ type: "text", role: "assistant", text: "Hello world" },
		],
	);
});

test("grok transcript: error flushes the open segment; unterminated segment is withheld", () => {
	assert.deepEqual(parse([ev({ type: "text", data: "partial" }), ev({ type: "error", message: "auth failed" })]), [
		{ type: "text", role: "assistant", text: "partial" },
	]);
	assert.deepEqual(parse([ev({ type: "text", data: "still typing" })]), []);
});

test("grok transcript: full text on end is used only when no chunks streamed", () => {
	assert.deepEqual(parse([ev({ type: "end", stopReason: "EndTurn", text: "whole" })]), [
		{ type: "text", role: "assistant", text: "whole" },
	]);
	assert.deepEqual(parse([ev({ type: "text", data: "a" }), ev({ type: "end", text: "a" })]), [
		{ type: "text", role: "assistant", text: "a" },
	]);
});

test("grok transcript: a new attempt header drops the previous attempt's open segment", () => {
	assert.deepEqual(
		parse([
			ev({ type: "text", data: "killed mid-" }),
			ev({ type: "taskflow_attempt", attempt: 2, at: 1 }),
			HEADER,
			ev({ type: "text", data: "fresh" }),
			ev({ type: "end" }),
		]),
		[
			{ type: "attempt", attempt: 2, at: 1 },
			{ type: "text", role: "assistant", text: "fresh" },
		],
	);
});

test("grok transcript: TranscriptTail across polls matches a one-shot parse", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-grok-transcript-"));
	try {
		const file = path.join(dir, "n.ndjson");
		const lines = [HEADER, ev({ type: "text", data: "Hel" }), ev({ type: "text", data: "lo" }), ev({ type: "end" })];
		fs.writeFileSync(file, `${lines.slice(0, 2).join("\n")}\n`);
		const tail = new TranscriptTail(file);
		assert.equal(tail.poll(), false);
		fs.appendFileSync(file, `${lines.slice(2).join("\n")}\n`);
		assert.equal(tail.poll(), true);
		assert.deepEqual(tail.entries, parseTranscript(lines.join("\n")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
