import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseTranscript } from "taskflow-core";
import { renderTranscript, TranscriptTail } from "../src/transcript-view.ts";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

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
	assert.ok(out.some((l) => l.startsWith("▸ ")));
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
