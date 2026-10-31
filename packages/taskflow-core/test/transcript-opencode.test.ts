/**
 * OpenCode `run --format json` transcripts: a `host:"opencode"` header routes
 * text/tool_use parts through the opencode normaliser. Fixture lines are the
 * real streams from taskflow-hosts/test/opencode-runner.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../src/transcript.ts";

const HEADER = `{"type":"taskflow_transcript","host":"opencode","v":1}`;
const TOOL_STREAM = [
	`{"type":"step_start","part":{"type":"step-start"}}`,
	`{"type":"text","part":{"type":"text","text":"let me check"}}`,
	`{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\\n","title":"echo hi"}}}`,
	`{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":15233,"input":15169,"output":47,"reasoning":17,"cache":{"write":0,"read":0}},"cost":0}}`,
	`{"type":"step_start","part":{"type":"step-start"}}`,
	`{"type":"text","part":{"type":"text","text":"done"}}`,
	`{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":15274,"input":18,"output":2,"reasoning":22,"cache":{"write":0,"read":15232}},"cost":0}}`,
];
const parse = (lines: string[]) => parseTranscript([HEADER, ...lines].join("\n"));
const toolUse = (status: string, state: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", callID: "c2", state: { status, input: { filePath: "/a.ts" }, ...state } } });

test("opencode transcript: real tool stream yields text, call+result, text", () => {
	assert.deepEqual(parse(TOOL_STREAM), [
		{ type: "text", role: "assistant", text: "let me check" },
		{ type: "tool_call", name: "bash", summary: "$ echo hi", args: { command: "echo hi" }, toolCallId: "c1" },
		{ type: "tool_result", name: "bash", text: "hi\n", isError: false, toolCallId: "c1" },
		{ type: "text", role: "assistant", text: "done" },
	]);
});

test("opencode transcript: a running tool emits its call once, then the result on completion", () => {
	assert.deepEqual(parse([toolUse("pending"), toolUse("running"), toolUse("error", { error: "ENOENT" })]), [
		{ type: "tool_call", name: "read", summary: "read /a.ts", args: { filePath: "/a.ts" }, toolCallId: "c2" },
		{ type: "tool_result", name: "read", text: "ENOENT", isError: true, toolCallId: "c2" },
	]);
});

test("opencode transcript: unknown events and empty text are skipped", () => {
	assert.deepEqual(
		parse([
			`{"type":"reasoning","part":{"type":"reasoning","text":"hmm"}}`,
			`{"type":"text","part":{"type":"text","text":"  "}}`,
			`{"type":"error","error":{"name":"X"}}`,
			`{"type":"text","part":{"id":"p1","type":"text","text":"pong","time":{"start":1,"end":2}}}`,
		]),
		[{ type: "text", role: "assistant", text: "pong" }],
	);
});
