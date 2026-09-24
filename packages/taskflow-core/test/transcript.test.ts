/**
 * Unit tests for `parseTranscript` (transcript.ts): parses a run node's raw
 * NDJSON event stream (attempt markers + message_end events) into ordered
 * renderable entries, tolerant of a partial trailing line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTranscript } from "../src/transcript.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/transcript-sample.ndjson", import.meta.url));

test("parseTranscript: parses text, tool_call, tool_result and skips a truncated trailing line", () => {
	const text = fs.readFileSync(fixturePath, "utf8");
	assert.equal(text.endsWith("\n"), false, "fixture must end mid-record to exercise the partial-line guard");
	const entries = parseTranscript(text);

	assert.deepEqual(entries, [
		{ type: "attempt", attempt: 1, at: 1000 },
		{ type: "text", role: "assistant", text: "Looking into it" },
		{ type: "tool_call", name: "bash", summary: "$ ls -la", args: { command: "ls -la" } },
		{ type: "tool_result", name: "bash", text: "file1.txt\nfile2.txt", isError: false },
	]);
});

test("parseTranscript: empty input yields no entries", () => {
	assert.deepEqual(parseTranscript(""), []);
});

test("parseTranscript: blank lines and non-JSON noise are skipped without throwing", () => {
	const text = [
		"",
		"not json at all",
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
		"   ",
	].join("\n");
	assert.deepEqual(parseTranscript(text), [{ type: "text", role: "assistant", text: "ok" }]);
});

test("parseTranscript: a fatal-error event without message_end contributes no entry", () => {
	const text = `${JSON.stringify({ type: "fatal", error: "boom" })}\n`;
	assert.deepEqual(parseTranscript(text), []);
});
