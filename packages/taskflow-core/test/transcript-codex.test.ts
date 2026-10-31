/**
 * Codex `exec --json` transcripts: a `host:"codex"` header routes item events
 * through the codex normaliser. Fixture lines are the real stream from
 * taskflow-hosts/test/codex-runner.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTranscript, parseTranscript } from "../src/transcript.ts";

const HEADER = `{"type":"taskflow_transcript","host":"codex","v":1}`;
const REAL_STREAM = [
	`{"type":"thread.started","thread_id":"t1"}`,
	`{"type":"turn.started"}`,
	`{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"find examples -name '*.json' | wc -l","exit_code":null,"status":"in_progress"}}`,
	`{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"find examples -name '*.json' | wc -l","aggregated_output":"5\\n","exit_code":0,"status":"completed"}}`,
	`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"5"}}`,
	`{"type":"turn.completed","usage":{"input_tokens":48650,"cached_input_tokens":26368,"output_tokens":159,"reasoning_output_tokens":62}}`,
];
const parse = (lines: string[]) => parseTranscript([HEADER, ...lines].join("\n"));

test("codex transcript: header selects the codex normaliser for the real stream", () => {
	assert.deepEqual(parse(REAL_STREAM), [
		{
			type: "tool_call",
			name: "command_execution",
			summary: "$ find examples -name '*.json' | wc -l",
			args: { command: "find examples -name '*.json' | wc -l" },
			toolCallId: "item_2",
		},
		{ type: "tool_result", name: "command_execution", text: "5\n", isError: false, toolCallId: "item_2" },
		{ type: "text", role: "assistant", text: "5" },
	]);
});

test("codex transcript: a failed command item yields one call then an error result", () => {
	const entries = parse([
		`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"false","status":"in_progress"}}`,
		`{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"false","aggregated_output":"boom","exit_code":1,"status":"failed"}}`,
	]);
	assert.deepEqual(
		entries.map((e) => e.type),
		["tool_call", "tool_result"],
	);
	assert.equal(entries[0]?.type === "tool_call" && entries[0].summary, "$ false");
	assert.deepEqual(entries[1], { type: "tool_result", name: "command_execution", text: "boom", isError: true, toolCallId: "i1" });
	assert.ok(formatTranscript(entries).includes("\u2717 command_execution: boom"));
});

test("codex transcript: file_change, mcp_tool_call and reasoning items", () => {
	const entries = parse([
		`{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"plan the edit"}}`,
		`{"type":"item.completed","item":{"id":"f1","type":"file_change","changes":[{"path":"a.ts","kind":"update"},{"path":"b.ts","kind":"add"}],"status":"completed"}}`,
		`{"type":"item.started","item":{"id":"m1","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"status":"in_progress"}}`,
		`{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{"q":"x"},"result":{"content":[{"type":"text","text":"hit"}]},"status":"completed"}}`,
		`{"type":"item.completed","item":{"id":"m2","type":"mcp_tool_call","server":"docs","tool":"search","arguments":{},"error":{"message":"denied"},"status":"failed"}}`,
	]);
	assert.deepEqual(entries, [
		{ type: "thinking", text: "plan the edit" },
		{
			type: "tool_call",
			name: "file_change",
			summary: "edit a.ts, b.ts",
			args: { changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }] },
			toolCallId: "f1",
		},
		{ type: "tool_result", name: "file_change", text: "update a.ts\nadd b.ts", isError: false, toolCallId: "f1" },
		{ type: "tool_call", name: "docs.search", summary: "docs.search", args: { q: "x" }, toolCallId: "m1" },
		{ type: "tool_result", name: "docs.search", text: "hit", isError: false, toolCallId: "m1" },
		{ type: "tool_call", name: "docs.search", summary: "docs.search", args: {}, toolCallId: "m2" },
		{ type: "tool_result", name: "docs.search", text: "denied", isError: true, toolCallId: "m2" },
	]);
});

test("codex transcript: unknown item and event types are skipped", () => {
	assert.deepEqual(
		parse([
			`{"type":"item.completed","item":{"id":"w1","type":"web_search","query":"x"}}`,
			`{"type":"item.updated","item":{"id":"t1","type":"todo_list","items":[]}}`,
			`{"type":"something.new","data":1}`,
			`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"ok"}}`,
		]),
		[{ type: "text", role: "assistant", text: "ok" }],
	);
});
