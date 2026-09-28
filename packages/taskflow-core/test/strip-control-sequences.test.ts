import test from "node:test";
import assert from "node:assert/strict";
import { foldEventLine, newAccumulator, sanitizeErrorMessage, stripControlSequences } from "../src/runner-core.ts";

const ESC = "\u001b";

test("stripControlSequences: removes CSI, OSC and stray C0 from subagent text", () => {
	assert.equal(stripControlSequences(`before${ESC}[2Jafter`), "beforeafter");
	assert.equal(stripControlSequences(`${ESC}[1;31mred${ESC}[0m`), "red");
	assert.equal(stripControlSequences(`${ESC}]0;title\u0007tail`), "tail");
	assert.equal(stripControlSequences(`${ESC}]8;;http://x${ESC}\\link`), "link");
	assert.equal(stripControlSequences("a\u0007\u0000b"), "a b");
	assert.equal(stripControlSequences("  multi \n line \t here "), "multi line here");
});

test("stripControlSequences: plain text is only whitespace-collapsed", () => {
	assert.equal(stripControlSequences("grep foo   bar"), "grep foo bar");
	assert.equal(stripControlSequences("代码审查 — ok"), "代码审查 — ok");
});

test("liveText from a subagent cannot carry a screen-clearing sequence", () => {
	const acc = newAccumulator();
	const live = foldEventLine(
		acc,
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: `done${ESC}[2J${ESC}[H` }] },
		}),
	);
	assert.equal(live?.text, "done");
});

test("sanitizeErrorMessage strips control sequences too", () => {
	assert.equal(sanitizeErrorMessage(`boom${ESC}[2J`), "boom");
});
