/**
 * Unit tests for `parseTranscript` (transcript.ts): parses a run node's raw
 * NDJSON event stream (attempt markers + message_end events) into ordered
 * renderable entries, tolerant of a partial trailing line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { formatTranscript, parseTranscript, TranscriptTail } from "../src/transcript.ts";

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

const line = (o: unknown): string => JSON.stringify(o);
const header = (host: string): string => line({ type: "taskflow_transcript", host, v: 1 });
const assistant = (content: unknown[]): string => line({ type: "message_end", message: { role: "assistant", content } });
const piToolResult = (toolCallId: string, toolName: string, text: string, extra: Record<string, unknown> = {}): string =>
	line({
		type: "message_end",
		message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, ...extra },
	});

test("parseTranscript: legacy fixture (no tool_execution_end, no ids) yields no new fields", () => {
	const entries = parseTranscript(fs.readFileSync(fixturePath, "utf8"));
	for (const e of entries) {
		assert.equal("toolCallId" in e, false);
		assert.equal("durationMs" in e, false);
		assert.equal("details" in e, false);
	}
});

test("parseTranscript: thinking precedes the message's text and tool entries", () => {
	const entries = parseTranscript(
		assistant([
			{ type: "thinking", thinking: "plan the listing" },
			{ type: "text", text: "Listing" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
		]),
	);
	assert.deepEqual(entries, [
		{ type: "thinking", text: "plan the listing" },
		{ type: "text", role: "assistant", text: "Listing" },
		{ type: "tool_call", name: "bash", summary: "$ ls", args: { command: "ls" }, toolCallId: "c1" },
	]);
});

test("parseTranscript: empty (redacted) thinking produces no entry", () => {
	assert.deepEqual(parseTranscript(assistant([{ type: "thinking", thinking: "", redacted: true }])), []);
});

test("parseTranscript: tool_execution_end durationMs attaches to the toolResult with the same id", () => {
	const entries = parseTranscript(
		[
			assistant([
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "pwd" } },
			]),
			line({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", isError: false, durationMs: 50 }),
			line({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, durationMs: 1234 }),
			piToolResult("c1", "bash", "a\nb"),
			piToolResult("c2", "bash", "/tmp"),
			piToolResult("c3", "bash", "untimed"),
		].join("\n"),
	);
	const results = entries.filter((e) => e.type === "tool_result");
	assert.deepEqual(results, [
		{ type: "tool_result", name: "bash", text: "a\nb", isError: false, toolCallId: "c1", durationMs: 1234 },
		{ type: "tool_result", name: "bash", text: "/tmp", isError: false, toolCallId: "c2", durationMs: 50 },
		{ type: "tool_result", name: "bash", text: "untimed", isError: false, toolCallId: "c3" },
	]);
	assert.ok(formatTranscript(entries).includes("\u2713 bash \u00b7 1.2s"));
	assert.ok(formatTranscript(entries).includes("\u2713 bash: untimed"));
});

test("parseTranscript: toolResult details pass through unchanged", () => {
	const details = { diff: "-a\n+b", firstChangedLine: 3 };
	const [entry] = parseTranscript(piToolResult("e1", "edit", "Edited", { details }));
	assert.equal(entry?.type, "tool_result");
	assert.deepEqual(entry?.type === "tool_result" ? entry.details : undefined, details);
	// Legacy part-shaped result: details may sit on the part.
	const [legacy] = parseTranscript(
		line({ type: "message_end", message: { role: "user", content: [{ type: "toolResult", name: "edit", text: "ok", details }] } }),
	);
	assert.deepEqual(legacy, { type: "tool_result", name: "edit", text: "ok", isError: false, details });
});

test("TranscriptTail: tool timing seen in one poll attaches to a result read in the next", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-transcript-"));
	try {
		const file = path.join(dir, "n.ndjson");
		fs.writeFileSync(file, `${line({ type: "tool_execution_end", toolCallId: "c1", durationMs: 700 })}\n`);
		const tail = new TranscriptTail(file);
		tail.poll();
		fs.appendFileSync(file, `${piToolResult("c1", "bash", "done")}\n`);
		tail.poll();
		assert.deepEqual(tail.entries, [
			{ type: "tool_result", name: "bash", text: "done", isError: false, toolCallId: "c1", durationMs: 700 },
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("formatTranscript: thinking renders as a one-line collapsed marker", () => {
	const long = "x".repeat(100);
	assert.equal(formatTranscript([{ type: "thinking", text: `first line\nsecond` }]), "\u2234 thinking: first line");
	assert.equal(formatTranscript([{ type: "thinking", text: long }]), `\u2234 thinking: ${"x".repeat(80)}\u2026`);
});

test("parseTranscript: a headerless file and a host:pi file parse identically", () => {
	const body = fs.readFileSync(fixturePath, "utf8");
	assert.deepEqual(parseTranscript(`${header("pi")}\n${body}`), parseTranscript(body));
});

test("parseTranscript: an unknown host falls back to pi without throwing", () => {
	const body = fs.readFileSync(fixturePath, "utf8");
	assert.deepEqual(parseTranscript(`${header("no-such-host")}\n${body}`), parseTranscript(body));
	assert.deepEqual(parseTranscript(`${line({ type: "taskflow_transcript", v: 1 })}\n${body}`), parseTranscript(body));
});

test("parseTranscript: a header written after an attempt marker is honoured", () => {
	const entries = parseTranscript(
		[line({ type: "taskflow_attempt", attempt: 1, at: 5 }), header("pi"), assistant([{ type: "text", text: "hi" }])].join("\n"),
	);
	assert.deepEqual(entries, [
		{ type: "attempt", attempt: 1, at: 5 },
		{ type: "text", role: "assistant", text: "hi" },
	]);
});
