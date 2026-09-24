import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollPane } from "../src/scroll-pane.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line-${i}`);

test("scroll-pane: content shorter than the viewport is returned as-is", () => {
	const p = new ScrollPane();
	assert.deepEqual(p.view(lines(3), 10), ["line-0", "line-1", "line-2"]);
	assert.equal(p.offset, 0);
});

test("scroll-pane: follow pins the window to the bottom and shows an ↑ indicator", () => {
	const p = new ScrollPane();
	const out = p.view(lines(100), 10);
	assert.equal(out.length, 10);
	assert.equal(out[8], "line-99");
	assert.equal(out[9], "↑ 91 more");
	assert.equal(p.offset, 91);
});

test("scroll-pane: manual scroll up clears follow, End/G restores it", () => {
	const p = new ScrollPane();
	p.view(lines(100), 10);
	assert.equal(p.handleKey("k"), true);
	assert.equal(p.follow, false);
	let out = p.view(lines(100), 10);
	assert.equal(out[0], "line-90");
	assert.equal(out[9], "↑ 90 more · ↓ 1 more");
	assert.equal(p.handleKey("G"), true);
	out = p.view(lines(100), 10);
	assert.equal(p.follow, true);
	assert.equal(out[8], "line-99");
});

test("scroll-pane: Home/g jumps to the top, offset clamps at both ends", () => {
	const p = new ScrollPane();
	p.view(lines(100), 10);
	p.handleKey("g");
	const out = p.view(lines(100), 10);
	assert.equal(p.offset, 0);
	assert.equal(out[0], "line-0");
	assert.equal(out[9], "↓ 91 more");
	// Scrolling above the top clamps to 0.
	for (let i = 0; i < 5; i++) p.handleKey("k");
	p.view(lines(100), 10);
	assert.equal(p.offset, 0);
	// Scrolling far past the end clamps to the last window.
	for (let i = 0; i < 500; i++) p.handleKey("j");
	p.view(lines(100), 10);
	assert.equal(p.offset, 91);
});

test("scroll-pane: PgUp/PgDn move by a page of the last viewport", () => {
	const p = new ScrollPane();
	p.view(lines(100), 10); // follow → offset 91, page = 9
	p.handleKey("\x1b[5~"); // PgUp
	assert.equal(p.view(lines(100), 10)[0], "line-82");
	p.handleKey("\x1b[6~"); // PgDn
	assert.equal(p.view(lines(100), 10)[0], "line-91");
});

test("scroll-pane: non-scroll keys are not consumed", () => {
	const p = new ScrollPane();
	assert.equal(p.handleKey("s"), false);
	assert.equal(p.handleKey("\r"), false);
});
