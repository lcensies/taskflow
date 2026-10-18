import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseTranscript, type TranscriptEntry } from "taskflow-core";
import { renderTranscript, TranscriptTail } from "../src/transcript-view.ts";

// pi's built-in renderers style through pi's global theme.
initTheme("dark");

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	italic: (s: string) => s,
	inverse: (s: string) => s,
	underline: (s: string) => s,
	strikethrough: (s: string) => s,
};

const plain = (rows: string[]): string[] => rows.map((l) => l.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));

function messageEnd(role: string, content: unknown[]): string {
	return JSON.stringify({ type: "message_end", message: { role, content } });
}

test("transcript-view: every line fits the width at 50 cols", () => {
	const long = "word ".repeat(200).trim();
	const entries = parseTranscript(
		[
			JSON.stringify({ type: "taskflow_attempt", attempt: 2, at: 1 }),
			messageEnd("assistant", [{ type: "text", text: long }]),
			messageEnd("assistant", [
				{ type: "toolCall", name: "bash", arguments: { command: long } },
			]),
			messageEnd("tool", [{ type: "toolResult", name: "bash", text: `${long}\n${long}` }]),
		].join("\n"),
	);
	const out = renderTranscript(entries, 50, theme);
	assert.ok(out.length > 0);
	for (const l of out) assert.ok(visibleWidth(l) <= 50, `overflow: ${JSON.stringify(l)}`);
	assert.ok(out.some((l) => l.includes("─── attempt 2 ───")));
	assert.ok(plain(out).some((l) => l.startsWith("$ word")), "bash renders through pi's renderer");
});

test("transcript-view: tool results are capped at 40 lines", () => {
	const text = Array.from({ length: 105 }, (_, i) => `out-${i}`).join("\n");
	const entries = parseTranscript(messageEnd("tool", [{ type: "toolResult", name: "bash", text }]));
	const out = renderTranscript(entries, 80, theme);
	assert.ok(out.includes("out-39"));
	assert.ok(!out.includes("out-40"));
	assert.ok(out.includes("… (+65 lines)"));
});

test("transcript-view: full mode uncaps tool results and wraps instead of truncating", () => {
	const long = "word ".repeat(60).trim();
	const lines = Array.from({ length: 100 }, (_, i) => `out-${i}`);
	lines[7] = long; // a result row wider than the panel
	const entries = parseTranscript(
		messageEnd("tool", [{ type: "toolResult", name: "bash", text: lines.join("\n") }]),
	);
	const countOut = (rows: string[]) => rows.filter((l) => /^out-\d+$/.test(l)).length;

	const compact = renderTranscript(entries, 50, theme);
	assert.equal(countOut(compact), 39); // 40 shown rows, one of them the long line
	assert.ok(compact.includes("… (+60 lines)"));
	assert.ok(compact.some((l) => l.startsWith("word word") && visibleWidth(l) === 50));

	const full = renderTranscript(entries, 50, theme, { full: true });
	assert.equal(countOut(full), 99);
	assert.ok(full.includes("out-99"));
	assert.ok(!full.some((l) => l.startsWith("… (+")));
	for (const l of full) assert.ok(visibleWidth(l) <= 50, `overflow: ${JSON.stringify(l)}`);
	// The long row is wrapped onto extra rows instead of being cut.
	const wrapped = full.filter((l) => l.startsWith("word"));
	assert.ok(wrapped.length > 1);
	assert.equal(wrapped.join(" "), long);
});

test("transcript-view: TranscriptTail picks up appended lines and ignores a partial one", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-transcript-"));
	const file = path.join(dir, "phase.ndjson");
	const tail = new TranscriptTail(file);

	// Missing file: empty, no throw.
	assert.equal(tail.poll(), false);
	assert.equal(tail.entries.length, 0);

	fs.writeFileSync(file, `${messageEnd("assistant", [{ type: "text", text: "first" }])}\n`);
	assert.equal(tail.poll(), true);
	assert.equal(tail.entries.length, 1);

	// A half-written trailing line is not consumed…
	fs.appendFileSync(file, `${messageEnd("assistant", [{ type: "text", text: "second" }])}`);
	assert.equal(tail.poll(), false);
	assert.equal(tail.entries.length, 1);
	// …until its newline arrives.
	fs.appendFileSync(file, "\n");
	assert.equal(tail.poll(), true);
	assert.equal(tail.entries.length, 2);
	assert.deepEqual(
		tail.entries.map((e) => (e.type === "text" ? e.text : e.type)),
		["first", "second"],
	);

	// Nothing new → no re-parse of earlier bytes.
	assert.equal(tail.poll(), false);
	assert.equal(tail.entries.length, 2);
	fs.rmSync(dir, { recursive: true, force: true });
});

const editCall: TranscriptEntry = {
	type: "tool_call",
	name: "edit",
	summary: "edit src/a.ts",
	args: { path: "src/a.ts", edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }] },
	toolCallId: "c1",
};
const editResult: TranscriptEntry = {
	type: "tool_result",
	name: "edit",
	text: "Successfully replaced 1 block(s) in src/a.ts.",
	isError: false,
	toolCallId: "c1",
	details: { diff: "-1 const before = 1;\n+1 const after = 2;", firstChangedLine: 1 },
};

test("transcript-view: an edit pair renders pi's diff, not the raw result text", () => {
	const out = plain(renderTranscript([editCall, editResult], 80, theme, { cwd: "/tmp" }));
	assert.ok(out.some((l) => /^\s*-1 const before = 1;/.test(l)), out.join("\n"));
	assert.ok(out.some((l) => /^\s*\+1 const after = 2;/.test(l)), out.join("\n"));
	assert.ok(!out.some((l) => l.includes("Successfully replaced")), "the raw result text is not shown");
	assert.ok(!out.some((l) => l.startsWith("▸ ")), "no fallback summary row");
});

test("transcript-view: a throwing pi renderer falls back to the summary row", () => {
	const entries: TranscriptEntry[] = [
		{ type: "tool_call", name: "bash", summary: "$ npm test", args: { command: "npm test" }, toolCallId: "b1" },
		{ type: "tool_result", name: "bash", text: "ok\ndone", isError: false, toolCallId: "b1" },
	];
	const toolRenderers = () => ({
		bash: {
			renderCall: () => ({ render: () => ["never"], invalidate() {} }),
			renderResult: () => {
				throw new Error("renderer drift");
			},
		},
	});
	const out = renderTranscript(entries, 80, theme, { toolRenderers });
	assert.deepEqual(out, ["▸ $ npm test", "✓ bash", "ok", "done"]);
	const unavailable = renderTranscript(entries, 80, theme, {
		toolRenderers: () => {
			throw new Error("cannot create definitions");
		},
	});
	assert.deepEqual(unavailable, out);
});

test("transcript-view: a non-built-in tool uses the summary row and dimmed result lines", () => {
	const out = renderTranscript(
		[
			{ type: "tool_call", name: "taskflow_peek", summary: "taskflow_peek", args: { runId: "r" } },
			{ type: "tool_result", name: "taskflow_peek", text: "line one\nline two", isError: false },
		],
		80,
		theme,
	);
	assert.deepEqual(out, ["▸ taskflow_peek", "✓ taskflow_peek", "line one", "line two"]);
});

test("transcript-view: a result's duration rides on the pair's header row", () => {
	const bash: TranscriptEntry[] = [
		{ type: "tool_call", name: "bash", summary: "$ sleep 2", args: { command: "sleep 2" }, toolCallId: "s1" },
		{ type: "tool_result", name: "bash", text: "", isError: false, toolCallId: "s1", durationMs: 2500 },
	];
	const native = plain(renderTranscript(bash, 60, theme));
	const header = native.find((l) => l.includes("sleep 2"));
	assert.ok(header?.includes("· 2.5s"), native.join("\n"));
	for (const l of native) assert.ok(visibleWidth(l) <= 60, `overflow: ${JSON.stringify(l)}`);

	const fallback = renderTranscript(bash, 60, theme, { toolRenderers: () => ({}) });
	assert.ok(fallback.includes("✓ bash · 2.5s"), fallback.join("\n"));
});

test("transcript-view: results pair by toolCallId across parallel calls", () => {
	const call = (id: string, cmd: string): TranscriptEntry => ({
		type: "tool_call",
		name: "probe",
		summary: `probe ${cmd}`,
		args: {},
		toolCallId: id,
	});
	const result = (id: string, text: string): TranscriptEntry => ({
		type: "tool_result",
		name: "probe",
		text,
		isError: false,
		toolCallId: id,
	});
	const out = renderTranscript([call("a", "A"), call("b", "B"), result("b", "out-B"), result("a", "out-A")], 80, theme);
	assert.deepEqual(out, ["▸ probe A", "✓ probe", "out-A", "", "▸ probe B", "✓ probe", "out-B"]);
});

test("transcript-view: thinking renders a dim first-line row, every line when expanded", () => {
	const entries: TranscriptEntry[] = [{ type: "thinking", text: "first idea\nsecond idea" }];
	assert.deepEqual(renderTranscript(entries, 80, theme), ["∴ thinking first idea"]);
	assert.deepEqual(renderTranscript(entries, 80, theme, { expanded: true }), ["∴ thinking", "first idea", "second idea"]);
	const dims: string[] = [];
	const spy: any = { ...theme, fg: (c: string, s: string) => (dims.push(c), s) };
	renderTranscript(entries, 80, spy, { full: true });
	assert.deepEqual([...new Set(dims)], ["dim"]);
});

test("transcript-view: native rows fit the width with a 300-char result line", () => {
	const long = "x".repeat(300);
	const entries: TranscriptEntry[] = [
		{ type: "tool_call", name: "bash", summary: `$ echo ${long}`, args: { command: `echo ${long}` }, toolCallId: "w1" },
		{ type: "tool_result", name: "bash", text: `${long}\n${long}`, isError: false, toolCallId: "w1", durationMs: 1200 },
		{ type: "tool_call", name: "read", summary: "read a.ts", args: { path: long }, toolCallId: "w2" },
		{ type: "tool_result", name: "read", text: long, isError: false, toolCallId: "w2" },
		editCall,
		editResult,
		{ type: "thinking", text: long },
	];
	for (const opts of [{}, { expanded: true }, { full: true, expanded: true }]) {
		const out = renderTranscript(entries, 50, theme, opts);
		for (const l of out) assert.ok(visibleWidth(l) <= 50, `overflow (${JSON.stringify(opts)}): ${JSON.stringify(l)}`);
	}
});

test("transcript-view: terminal control sequences in transcript text never reach the output", () => {
	const osc = "\u001b]52;c;Zm9v\u0007";
	const entries: TranscriptEntry[] = [
		{ type: "text", role: "assistant", text: `said ${osc}hi\u001b[2J` },
		{ type: "thinking", text: `mull ${osc}` },
		{ type: "tool_call", name: "bash", summary: `$ echo ${osc}`, args: { command: `echo ${osc}` }, toolCallId: "x1" },
		{ type: "tool_result", name: "bash", text: `out ${osc}\r\nnext`, isError: false, toolCallId: "x1" },
	];
	for (const opts of [{}, { expanded: true }, { full: true }]) {
		const fallback = renderTranscript(entries, 80, theme, { ...opts, toolRenderers: () => ({}) }).join("\n");
		assert.ok(!fallback.includes("\u001b"), `ESC in fallback output: ${JSON.stringify(fallback)}`);
		assert.ok(!fallback.includes("\u0007") && !fallback.includes("\r"), JSON.stringify(fallback));
		assert.match(fallback, /said hi/);
		assert.match(fallback, /out \nnext/);
		// pi's own renderers style with SGR; nothing else may come through.
		const native = renderTranscript(entries, 80, theme, opts).join("\n");
		assert.ok(!native.replace(/\x1b\[[0-9;]*m/g, "").includes("\u001b"), `ESC in native output: ${JSON.stringify(native)}`);
		assert.ok(!native.includes("Zm9v"), JSON.stringify(native));
	}
});
