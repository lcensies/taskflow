/**
 * Claude Code `stream-json` transcripts: a `host:"claude"` header routes
 * assistant/user content blocks through the claude normaliser. Fixture lines
 * are the real stream from taskflow-hosts/test/claude-runner.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../src/transcript.ts";

const HEADER = `{"type":"taskflow_transcript","host":"claude","v":1}`;
const REAL_STREAM = [
	`{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"a1e55e9c","tools":["Task","Bash","Read"],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","claude_code_version":"2.1.178","uuid":"c5cf546f"}`,
	`{"type":"assistant","message":{"id":"msg_1","model":"claude-haiku-4-5","role":"assistant","type":"message","usage":{"input_tokens":4,"output_tokens":78,"cache_creation_input_tokens":2515,"cache_read_input_tokens":13629},"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo taskflow-probe","description":"Echo probe"}}]},"parent_tool_use_id":null,"session_id":"a1e55e9c","uuid":"u1"}`,
	`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"taskflow-probe"}]},"session_id":"a1e55e9c","uuid":"u2"}`,
	`{"type":"assistant","message":{"id":"msg_2","model":"claude-haiku-4-5","role":"assistant","type":"message","usage":{"input_tokens":6,"output_tokens":5,"cache_creation_input_tokens":94,"cache_read_input_tokens":16144},"content":[{"type":"text","text":"done"}]},"parent_tool_use_id":null,"session_id":"a1e55e9c","uuid":"u3"}`,
	`{"type":"result","subtype":"success","is_error":false,"duration_ms":4180,"duration_api_ms":3980,"num_turns":2,"result":"done","stop_reason":"end_turn","session_id":"a1e55e9c","total_cost_usd":0.0034,"usage":{"input_tokens":10,"cache_creation_input_tokens":2609,"cache_read_input_tokens":29773,"output_tokens":83},"permission_denials":[],"uuid":"u4"}`,
];
const parse = (lines: string[]) => parseTranscript([HEADER, ...lines].join("\n"));
const assistant = (content: unknown[], model = "claude-haiku-4-5") =>
	JSON.stringify({ type: "assistant", message: { role: "assistant", model, content } });
const user = (content: unknown[]) => JSON.stringify({ type: "user", message: { role: "user", content } });

test("claude transcript: real stream yields call, result, text; system/result skipped", () => {
	assert.deepEqual(parse(REAL_STREAM), [
		{
			type: "tool_call",
			name: "Bash",
			summary: "$ echo taskflow-probe",
			args: { command: "echo taskflow-probe", description: "Echo probe" },
			toolCallId: "toolu_1",
		},
		{ type: "tool_result", name: "Bash", text: "taskflow-probe", isError: false, toolCallId: "toolu_1" },
		{ type: "text", role: "assistant", text: "done" },
	]);
});

test("claude transcript: tool pair scenario (block-list content, is_error)", () => {
	const entries = parse([
		assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
		user([{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }]),
		assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x.ts" } }]),
		user([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "no such file" }], is_error: true }]),
	]);
	assert.deepEqual(entries, [
		{ type: "tool_call", name: "Bash", summary: "$ ls", args: { command: "ls" }, toolCallId: "t1" },
		{ type: "tool_result", name: "Bash", text: "a\nb", isError: false, toolCallId: "t1" },
		{ type: "tool_call", name: "Read", summary: "read /x.ts", args: { file_path: "/x.ts" }, toolCallId: "t2" },
		{ type: "tool_result", name: "Read", text: "no such file", isError: true, toolCallId: "t2" },
	]);
});

test("claude transcript: thinking precedes text; Glob/Write/Edit/Grep summaries use shared verbs", () => {
	const entries = parse([
		assistant([
			{ type: "thinking", thinking: "look around", signature: "s" },
			{ type: "text", text: "Searching" },
			{ type: "tool_use", id: "g", name: "Glob", input: { pattern: "**/*.ts" } },
			{ type: "tool_use", id: "w", name: "Write", input: { file_path: "a.md", content: "x" } },
			{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "b.md", old_string: "a", new_string: "b" } },
			{ type: "tool_use", id: "r", name: "Grep", input: { pattern: "TODO" } },
			{ type: "tool_use", id: "o", name: "WebFetch", input: { url: "u" } },
		]),
	]);
	assert.deepEqual(
		entries.map((e) => (e.type === "tool_call" ? e.summary : e.type)),
		["thinking", "text", "find **/*.ts", "write a.md", "edit b.md", "grep TODO", "WebFetch"],
	);
	assert.deepEqual(entries[0], { type: "thinking", text: "look around" });
});

test("claude transcript: synthetic assistant text and unknown events are skipped", () => {
	assert.deepEqual(
		parse([
			assistant([{ type: "text", text: "Invalid API key" }], "<synthetic>"),
			`{"type":"stream_event","event":{"type":"content_block_delta"}}`,
			user([{ type: "text", text: "the prompt" }]),
			assistant([{ type: "text", text: "real" }]),
		]),
		[{ type: "text", role: "assistant", text: "real" }],
	);
});
