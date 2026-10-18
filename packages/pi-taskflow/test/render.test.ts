import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { formatCost, formatUsage, renderFingerprint, renderProgress, renderRunResult, summarizeRun } from "../src/render.ts";
import { emptyUsage, runsDir, transcriptDirFor, transcriptFileFor } from "taskflow-core";
import type { Taskflow } from "taskflow-core";
import type { PhaseState, RunState } from "taskflow-core";

// Markdown output blocks style through pi's global theme.
initTheme("dark");

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mkState(def: Taskflow, phases: Record<string, PhaseState>, status: RunState["status"] = "running"): RunState {
	return {
		runId: "r",
		flowName: def.name,
		def,
		args: {},
		status,
		phases,
		createdAt: 0,
		updatedAt: 0,
		cwd: ".",
	};
}

function done(id: string): PhaseState {
	return { id, status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1 };
}

test("renderProgress: surfaces a ⚠ badge when a phase carries warnings", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, {
		p: { id: "p", status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1, warnings: ["unresolved {steps.ghost}"] },
	});
	const out = renderProgress(state, theme as any);
	assert.match(out, /⚠1/, "warnings badge should appear in rendered output");
});

test("renderProgress: skipped + warnings shows both the reason and the badge", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, {
		p: {
			id: "p",
			status: "skipped",
			error: "Upstream dependency not satisfied",
			endedAt: 1,
			usage: emptyUsage(),
			warnings: ["x"],
		},
	});
	const out = renderProgress(state, theme as any);
	assert.match(out, /skipped/);
	assert.match(out, /⚠1/);
});

// A fan-out → fan-in DAG with a long (layer-skipping) edge:
//   discover ─┬─ writeA ─┐
//             ├─ writeB ─┼─ verify ─┐
//             └─ fix ────────────────┴─ report
const diamond: Taskflow = {
	name: "diamond",
	phases: [
		{ id: "discover", type: "agent", task: "t" },
		{ id: "writeA", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "writeB", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "fix", type: "agent", task: "t", dependsOn: ["discover"] },
		{ id: "verify", type: "gate", task: "t", dependsOn: ["writeA", "writeB"] },
		{ id: "report", type: "reduce", from: ["verify", "fix"], task: "t", dependsOn: ["verify", "fix"], final: true },
	],
};

test("renderProgress: parallel layer gets a bracket rail (┌ ├ └)", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const lines = renderProgress(state, theme).split("\n");

	const rowOf = (id: string) => lines.find((l) => l.includes(` ${id} `) || l.endsWith(` ${id}`) || l.includes(`${id}  `))!;
	// The three-phase parallel layer (writeA/writeB/fix) is bracketed.
	assert.ok(rowOf("writeA").includes("┌"), `writeA should open the bracket: ${rowOf("writeA")}`);
	assert.ok(rowOf("writeB").includes("├"), `writeB should be a mid bracket: ${rowOf("writeB")}`);
	assert.ok(rowOf("fix").includes("└"), `fix should close the bracket: ${rowOf("fix")}`);
});

test("renderProgress: single-phase layers have no rail glyph", () => {
	const state = mkState(diamond, { discover: done("discover") });
	const discoverRow = renderProgress(state, theme)
		.split("\n")
		.find((l) => l.includes("discover"))!;
	assert.ok(!/[┌├└]/.test(discoverRow), `root should have no rail: ${discoverRow}`);
});

test("renderProgress: renders in topological order (deps before dependents)", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const text = renderProgress(state, theme);
	const pos = (id: string) => text.indexOf(`${id} `) >= 0 ? text.indexOf(id) : -1;
	assert.ok(pos("discover") < pos("writeA"), "discover before writeA");
	assert.ok(pos("writeA") < pos("verify"), "writeA before verify");
	assert.ok(pos("verify") < pos("report"), "verify before report");
});

test("renderProgress: annotates only long (layer-skipping) edges with ↳", () => {
	const state = mkState(
		diamond,
		Object.fromEntries(["discover", "writeA", "writeB", "fix", "verify", "report"].map((id) => [id, done(id)])),
	);
	const lines = renderProgress(state, theme).split("\n");
	const verifyRow = lines.find((l) => l.includes("verify"))!;
	const reportRow = lines.find((l) => l.includes("report"))!;

	// verify depends only on the adjacent layer (writeA/writeB) → no annotation.
	assert.ok(!verifyRow.includes("↳"), `verify deps are adjacent, should not annotate: ${verifyRow}`);
	// report depends on verify (adjacent) + fix (skips a layer) → annotate only the long edge.
	assert.ok(reportRow.includes("↳ fix"), `report should annotate its long edge: ${reportRow}`);
	assert.ok(!reportRow.includes("verify,") && !reportRow.includes("↳ verify"), `report should not annotate the adjacent edge: ${reportRow}`);
});

test("renderProgress: linear chains stay flat (no rails, no annotations)", () => {
	const chain: Taskflow = {
		name: "chain",
		phases: [
			{ id: "a", type: "agent", task: "t" },
			{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
			{ id: "c", type: "agent", task: "t", dependsOn: ["b"], final: true },
		],
	};
	const state = mkState(chain, { a: done("a"), b: done("b"), c: done("c") });
	const body = renderProgress(state, theme).split("\n").slice(1).join("\n"); // drop header
	assert.ok(!/[┌├└]/.test(body), `linear chain should have no rails: ${body}`);
	assert.ok(!body.includes("↳"), `linear chain should have no edge annotations: ${body}`);
});

test("renderProgress: handles a malformed DAG without dropping phases", () => {
	// `ghost` depends on a non-existent phase; topoLayers may exclude it.
	// The safety net must still render every declared phase.
	const broken: Taskflow = {
		name: "broken",
		phases: [
			{ id: "root", type: "agent", task: "t" },
			{ id: "ghost", type: "agent", task: "t", dependsOn: ["missing"] },
		],
	};
	const state = mkState(broken, { root: done("root"), ghost: done("ghost") });
	const text = renderProgress(state, theme);
	assert.ok(text.includes("root"), "root rendered");
	assert.ok(text.includes("ghost"), "ghost rendered despite broken dep");
});

test("summarizeRun: reports done / running / failed counts", () => {
	const state = mkState(
		diamond,
		{
			discover: done("discover"),
			writeA: { id: "writeA", status: "running", usage: emptyUsage() },
			writeB: { id: "writeB", status: "failed", usage: emptyUsage(), error: "boom" },
		},
	);
	const s = summarizeRun(state);
	// Total comes from the definition, not the lazily-created phase entries: 3 of the
	// diamond's 6 phases have started, so a just-started run must not report "1/3".
	assert.match(s, /1\/6 done/);
	assert.match(s, /1 running/);
	assert.match(s, /1 failed/);
});

test("renderProgress: never shows negative elapsed for a running phase with stale endedAt", () => {
	// Regression: a resumed running phase that still carried a previous attempt's
	// endedAt (endedAt < startedAt) rendered as a frozen negative time, e.g. "-44s".
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const ps: PhaseState = {
		id: "p",
		status: "running",
		startedAt: 1_000_000, // started "now"
		endedAt: 950_000,     // stale: from a previous attempt, BEFORE startedAt
		usage: emptyUsage(),
	};
	const out = renderProgress(mkState(def, { p: ps }), theme);
	assert.ok(!/-\d+s/.test(out), `output must not contain a negative elapsed time:\n${out}`);
});

test("renderProgress: every line stays within a given width even with a 12-dep phase and long liveText", () => {
	const deps = Array.from({ length: 12 }, (_, i) => `d${i}`);
	const def: Taskflow = {
		name: "wide",
		phases: [
			...deps.map((id) => ({ id, type: "agent" as const, task: "t" })),
			{ id: "running", type: "agent", task: "t", dependsOn: deps },
			{ id: "collector", type: "reduce", from: deps.concat("running"), task: "t", dependsOn: deps.concat("running"), final: true },
		],
	};
	const phases: Record<string, PhaseState> = Object.fromEntries(deps.map((id) => [id, done(id)]));
	phases.running = {
		id: "running",
		status: "running",
		startedAt: Date.now(),
		usage: emptyUsage(),
		liveText: "x".repeat(90),
	};
	const state = mkState(def, phases);
	const out = renderProgress(state, theme, { width: 40 });
	for (const line of out.split("\n")) {
		assert.ok(visibleWidth(line) <= 40, `line exceeds 40 cols: "${line}" (${visibleWidth(line)})`);
	}
});

test("renderProgress: collapsed mode caps a 30-phase run at 14 rows", () => {
	const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
	const def: Taskflow = { name: "many", phases: ids.map((id) => ({ id, type: "agent", task: "t" })) };
	const phases: Record<string, PhaseState> = Object.fromEntries(ids.map((id) => [id, done(id)]));
	phases.p5 = { id: "p5", status: "failed", usage: emptyUsage(), error: "boom" };
	phases.p15 = { id: "p15", status: "running", startedAt: Date.now(), usage: emptyUsage() };
	const state = mkState(def, phases);
	const lines = renderProgress(state, theme, { maxRows: 14 }).split("\n");
	assert.ok(lines.length <= 14, `expected ≤14 rows, got ${lines.length}:\n${lines.join("\n")}`);
	assert.ok(lines.some((l) => l.includes("done") && l.includes("pending")), "folded rows should summarize done/pending counts");
});

test("renderProgress: two renders 100ms apart of an unchanged state differ only in the last line", async () => {
	const def: Taskflow = {
		name: "stable",
		phases: [
			{ id: "a", type: "agent", task: "t" },
			{ id: "b", type: "agent", task: "t", dependsOn: ["a"], final: true },
		],
	};
	// No phase is individually "running" so no row depends on wall-clock time —
	// only the footer (overall spinner/elapsed) is time-based.
	const state = mkState(def, { a: done("a"), b: { id: "b", status: "pending", usage: emptyUsage() } }, "running");
	const first = renderProgress(state, theme).split("\n");
	await new Promise((r) => setTimeout(r, 100));
	const second = renderProgress(state, theme).split("\n");
	assert.equal(first.length, second.length);
	assert.deepEqual(first.slice(0, -1), second.slice(0, -1), "only the footer (last) line may change over time");
});

test("renderProgress: a labelled phase shows its label instead of its id", () => {
	const def: Taskflow = {
		name: "labelled",
		phases: [{ id: "t1-2", type: "agent", task: "t", label: "1.2 Add CSV formatting utilities", final: true }],
	};
	const state = mkState(def, { "t1-2": done("t1-2") });
	const out = renderProgress(state, theme);
	assert.match(out, /1\.2 Add CSV formatting utilities/);
});

test("renderProgress: unchanged running phases change only footer across seconds", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: { id: "p", status: "running", startedAt: 10_000, usage: emptyUsage() } });
	const now = Date.now;
	try {
		Date.now = () => 11_000;
		const first = renderProgress(state, theme).split("\n");
		Date.now = () => 12_000;
		const second = renderProgress(state, theme).split("\n");
		assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
		assert.notEqual(first.at(-1), second.at(-1));
	} finally {
		Date.now = now;
	}
});

test("renderProgress: cached phases remain unchanged while another phase runs", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "cached", type: "agent", task: "t" }, { id: "active", type: "agent", task: "t" }] };
	const state = mkState(def, {
		cached: { ...done("cached"), cacheHit: "cross-run", endedAt: 1000 },
		active: { id: "active", status: "running", startedAt: 10_000, usage: emptyUsage() },
	});
	const now = Date.now;
	try {
		Date.now = () => 11_000;
		const first = renderProgress(state, theme).split("\n");
		Date.now = () => 13_000;
		const second = renderProgress(state, theme).split("\n");
		assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
	} finally {
		Date.now = now;
	}
});

test("renderRunResult: collapsed card keeps live activity on last line", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: { id: "p", status: "running", startedAt: Date.now(), liveText: "one", usage: emptyUsage() } });
	const first = renderRunResult(state, "", theme, false).render(80);
	state.phases.p.liveText = "two";
	const second = renderRunResult(state, "", theme, false).render(80);
	assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
	assert.match(second.at(-1)!, /two/);
});

test("renderRunResult: script rows show the command, not the type, plus live text while running", () => {
	const def: Taskflow = {
		name: "x",
		phases: [
			{ id: "build", type: "script", run: "pnpm run build" },
			{ id: "test", type: "script", run: ["node", "--test", "a-very-long-test-file-name-that-keeps-going.test.ts"], dependsOn: ["build"], final: true },
		],
	};
	const state = mkState(def, {
		build: { id: "build", status: "running", startedAt: Date.now(), liveText: "compiling 12 files", usage: emptyUsage() },
	});
	const out = renderRunResult(state, "", theme, false).render(120).join("\n");
	assert.match(out, /\$ pnpm run build/);
	assert.match(out, /compiling 12 files/);
	assert.match(out, /\$ node --test a-very-long-test-file-name-t…/);
	assert.doesNotMatch(out, /keeps-going/);
	assert.doesNotMatch(out, /script\s+script/);
});

test("renderRunResult: collapsed card keeps timer on last line", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const usage = { ...emptyUsage(), input: 1200, output: 300, cacheRead: 5000, cost: 0.00005 };
	const state = mkState(def, { p: { id: "p", status: "running", startedAt: 10_000, usage } });
	const now = Date.now;
	try {
		Date.now = () => 11_000;
		const first = renderRunResult(state, "", theme, false).render(80);
		Date.now = () => 12_000;
		const second = renderRunResult(state, "", theme, false).render(80);
		assert.deepEqual(first.slice(0, -1), second.slice(0, -1));
		assert.notEqual(first.at(-1), second.at(-1));
		assert.match(second.at(-1)!, /1\.5k tok · 5\.0k cached/);
		assert.match(first.at(-2)!, /Ctrl\+O/);
	} finally {
		Date.now = now;
	}
});

test("render usage: separates fresh/cache tokens and preserves small costs", () => {
	const usage = { ...emptyUsage(), input: 10, output: 5, cacheWrite: 2, cacheRead: 100, cost: 0.00003 };
	assert.equal(formatUsage(undefined), "");
	assert.equal(formatUsage(emptyUsage()), "");
	assert.equal(formatUsage(usage), "17 tok · 100 cached");
	assert.equal(formatCost(usage.cost), "<$0.0001");
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: { id: "p", status: "running", startedAt: Date.now(), usage } });
	const lines = renderRunResult(state, "", theme, false).render(40);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.match(lines.at(-1)!, /17 tok · 100 cached/);
	assert.match(lines.at(-1)!, /<\$0\.0001/);
});

test("renderFingerprint: stable for an unchanged state within the same second", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: done("p") }, "completed");
	assert.equal(renderFingerprint(state), renderFingerprint(state));
});

test("renderFingerprint: a streamed tick with an unchanged tail does not change it; a new tail does", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: { id: "p", status: "running", liveText: "Hello world" } });
	const before = renderFingerprint(state);
	state.phases.p.liveText = "Hello world";
	assert.equal(renderFingerprint(state), before);
	state.phases.p.liveText = "Hello world, again";
	assert.notEqual(renderFingerprint(state), before);
});

// --- back-edges, current-stage marker, planned model -----------------------

const loopy: Taskflow = {
	name: "loopy",
	phases: [
		{ id: "draft", type: "agent", agent: "executor", task: "t" },
		{ id: "polish", type: "loop", task: "t", until: "true", dependsOn: ["draft"] },
		{ id: "check", type: "gate", task: "t", onBlock: "retry", dependsOn: ["draft", "polish"], final: true },
	],
};

test("renderProgress: loop and retrying-gate rows show their back-edges while pending", () => {
	const out = renderProgress(mkState(loopy, {}), theme as any);
	assert.match(out, /↻ self/, "loop phase should show a self back-edge");
	assert.match(out, /↺ retry → draft, polish/, "retrying gate should name the deps it re-runs");
});

test("renderProgress: loop row shows the iteration count once the run reports it", () => {
	const state = mkState(loopy, {
		polish: {
			id: "polish", status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1,
			loop: { iterations: 3, stop: "until" },
		},
	});
	assert.match(renderProgress(state, theme as any), /↻ self×3/);
});

test("renderProgress: a plain pipeline gets no back-edge annotation", () => {
	const out = renderProgress(mkState(diamond, {}), theme as any);
	assert.doesNotMatch(out, /↻|↺/);
});

test("renderProgress: only the running rows carry the ▸ current-stage marker", () => {
	const state = mkState(loopy, {
		draft: { id: "draft", status: "running", usage: emptyUsage(), startedAt: 0 },
		polish: { id: "polish", status: "running", usage: emptyUsage(), startedAt: 0 },
	});
	// The header carries its own ▸ run-status glyph; only count phase rows.
	const marked = renderProgress(state, theme as any)
		.split("\n")
		.filter((l) => l.includes("▸") && /draft|polish|check/.test(l));
	assert.equal(marked.length, 2);
	assert.ok(marked.every((l) => /draft|polish/.test(l)));
});

test("renderProgress: pending rows show the planned model, started rows the actual one", () => {
	const state = mkState(loopy, {
		draft: { id: "draft", status: "done", usage: emptyUsage(), startedAt: 0, endedAt: 1, model: "anthropic/claude-sonnet-4-5" },
	});
	const out = renderProgress(state, theme as any, {
		plannedModel: (p) => (p.id === "polish" ? "openai/gpt-5" : undefined),
	});
	const lines = out.split("\n");
	assert.match(lines.find((l) => l.includes("draft"))!, /（claude-sonnet-4-5）/);
	assert.match(lines.find((l) => l.includes("polish"))!, /（~gpt-5）/);
	// No resolver result for `check` — show nothing rather than a wrong model.
	assert.doesNotMatch(lines.find((l) => l.includes("check"))!, /（/);
});

// --- collapsed snapshot (taken before the expanded transcript view landed) ---

function snapshotState(): RunState {
	const usage = { ...emptyUsage(), input: 1200, output: 300, cost: 0.02 };
	const def: Taskflow = {
		name: "three",
		phases: [
			{ id: "a", type: "agent", task: "t" },
			{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
			{ id: "c", type: "agent", task: "t", dependsOn: ["b"], final: true },
			{ id: "m", type: "map", over: "x", task: "t", dependsOn: ["a"] } as Taskflow["phases"][number],
		],
	};
	return mkState(def, {
		a: { id: "a", status: "done", usage, startedAt: 1000, endedAt: 4000, model: "anthropic/claude-x", output: "A out" },
		b: { id: "b", status: "running", usage, startedAt: 4000, liveText: "working", liveLog: ["l1"] },
		m: { id: "m", status: "running", usage, startedAt: 4000, subProgress: { done: 3, total: 8, running: 2, failed: 1 } },
	});
}

test("renderRunResult: collapsed output is byte-identical to the pre-change snapshot", () => {
	const now = Date.now;
	try {
		Date.now = () => 20_000;
		const state = snapshotState();
		assert.deepEqual(renderRunResult(state, "", theme, false).render(80), [
			"▸ taskflow three  1/4 · 2▸",
			"    ✓ a   agent  agent（claude-x）  $0.02  3s",
			"  ┌▸◐ b   agent  agent",
			"  └▸◐ m   map    ━━━───── 3/8 · 2 run · 1✗  map",
			"    ○ c   agent  agent",
			"  Ctrl+O to expand",
			"  ⠋ · $0.06 · 4.5k tok · 19s · › working",
		]);
		assert.deepEqual(renderRunResult(state, "", theme, false).render(30), [
			"▸ taskflow three  1/4 · 2▸",
			"    ✓ a   agent  agent（cla\u001b[0m...\u001b[0m",
			"  ┌▸◐ b   agent  agent",
			"  └▸◐ m   map    ━━━───── 3\u001b[0m...\u001b[0m",
			"    ○ c   agent  agent",
			"  Ctrl+O to expand",
			"  ⠋ · $0.06 · 4.5k tok · 19\u001b[0m...\u001b[0m",
		]);
		const usage = state.phases.a.usage;
		state.status = "completed";
		state.phases.b = { id: "b", status: "done", usage, startedAt: 4000, endedAt: 9000, output: "B" };
		state.phases.m = { id: "m", status: "done", usage, startedAt: 4000, endedAt: 9000, subProgress: { done: 8, total: 8, running: 0, failed: 0 } };
		state.phases.c = { id: "c", status: "done", usage, startedAt: 9000, endedAt: 12000, output: "C" };
		assert.deepEqual(renderRunResult(state, "C final", theme, false).render(80), [
			"✓ taskflow three  4/4",
			"    ✓ a   agent  agent（claude-x）  $0.02  3s",
			"  ┌ ✓ b   agent  agent  $0.02  5s",
			"  └ ✓ m   map    8✓  $0.02  5s",
			"    ✓ c   agent  agent  $0.02  3s",
			"  Ctrl+O to expand",
			"  · · $0.08 · 6.0k tok · 11s",
		]);
	} finally {
		Date.now = now;
	}
});

// --- expanded (Ctrl+O) per-phase transcript view ---------------------------

const textLine = (text: string) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

/** A temp cwd whose run `r` of flow `def.name` has the given node transcripts. */
function withTranscripts(def: Taskflow, files: Record<string, string[]>): { cwd: string; cleanup: () => void } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tf-render-"));
	const dir = transcriptDirFor(runsDir(cwd), def.name, "r");
	fs.mkdirSync(dir, { recursive: true });
	for (const [nodeId, lines] of Object.entries(files)) fs.writeFileSync(transcriptFileFor(dir, nodeId), `${lines.join("\n")}\n`);
	return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

const chain3: Taskflow = {
	name: "chain3",
	phases: [
		{ id: "a", type: "agent", task: "t" },
		{ id: "b", type: "agent", task: "t", dependsOn: ["a"] },
		{ id: "c", type: "agent", task: "t", dependsOn: ["b"], final: true },
	],
};

function finished3(cwd: string): RunState {
	const state = mkState(
		chain3,
		{
			a: { ...done("a"), output: "A-OUTPUT" },
			b: { ...done("b"), output: "B-OUTPUT" },
			c: { ...done("c"), output: "C-OUTPUT" },
		},
		"completed",
	);
	state.cwd = cwd;
	return state;
}

test("renderRunResult expanded: per-phase headings, transcript tails, non-final outputs, final output once", () => {
	const { cwd, cleanup } = withTranscripts(chain3, {
		a: [textLine("said-by-a")],
		b: [textLine("said-by-b")],
		c: [textLine("said-by-c")],
	});
	try {
		const lines = renderRunResult(finished3(cwd), "C-OUTPUT", theme, true).render(100);
		const at = (pred: (l: string) => boolean) => lines.findIndex(pred);
		const heading = (id: string) => at((l) => l.startsWith(`✓ ${id}  agent`));
		const [ha, hb, hc, result] = [heading("a"), heading("b"), heading("c"), at((l) => l.includes("─── Result ───"))];
		assert.ok(ha >= 0 && ha < hb && hb < hc && hc < result, `headings out of order:\n${lines.join("\n")}`);
		for (const [id, from, to] of [["a", ha, hb], ["b", hb, hc], ["c", hc, result]] as const) {
			const section = lines.slice(from, to).join("\n");
			assert.match(section, new RegExp(`said-by-${id}`), `${id} transcript row`);
		}
		assert.match(lines.slice(ha, hb).join("\n"), /─ output ─[\s\S]*A-OUTPUT/);
		assert.match(lines.slice(hb, hc).join("\n"), /─ output ─[\s\S]*B-OUTPUT/);
		assert.doesNotMatch(lines.slice(hc, result).join("\n"), /─ output ─/);
		assert.equal(lines.filter((l) => l.includes("C-OUTPUT")).length, 1, "final output appears once");
		assert.ok(at((l) => l.includes("C-OUTPUT")) > result, "final output sits under ─── Result ───");
	} finally {
		cleanup();
	}
});

test("renderRunResult expanded: a phase without a transcript shows its liveLog as recorded activity", () => {
	const { cwd, cleanup } = withTranscripts(chain3, { a: [textLine("said-by-a")] });
	try {
		const state = finished3(cwd);
		state.phases.b.liveLog = ["read src/x.ts", "ran tests"];
		const out = renderRunResult(state, "C-OUTPUT", theme, true).render(100).join("\n");
		assert.match(out, /─ recorded activity ─\n\s+› read src\/x\.ts\n\s+› ran tests/);
		assert.equal(out.match(/recorded activity/g)?.length, 1, "only the phase with a liveLog and no transcript");
	} finally {
		cleanup();
	}
});

test("renderRunResult expanded: fan-out shows 6 items with ≤4 entries each, then one fold row", () => {
	const def: Taskflow = { name: "fan", phases: [{ id: "m", type: "map", over: "x", task: "t", final: true } as Taskflow["phases"][number]] };
	const files: Record<string, string[]> = {};
	for (let i = 0; i < 8; i++) files[`m-${i}`] = Array.from({ length: 6 }, (_, k) => textLine(`item${i}-entry${k}`));
	const { cwd, cleanup } = withTranscripts(def, files);
	try {
		const state = mkState(def, { m: { ...done("m"), subProgress: { done: 8, total: 8, running: 0, failed: 0 } } }, "completed");
		state.cwd = cwd;
		const out = renderRunResult(state, "", theme, true).render(100).join("\n");
		for (let i = 0; i < 6; i++) {
			assert.match(out, new RegExp(`\\[${i + 1}\\]`));
			for (let k = 0; k < 6; k++) {
				const shown = new RegExp(`item${i}-entry${k}\\b`).test(out);
				assert.equal(shown, k >= 2, `item ${i} entry ${k} shown=${shown}`);
			}
		}
		assert.doesNotMatch(out, /item[67]-entry/);
		assert.equal(out.match(/… \+2 items/g)?.length, 1);
	} finally {
		cleanup();
	}
});

test("renderRunResult expanded: every row fits a 50-column width", () => {
	const long = "z".repeat(300);
	const { cwd, cleanup } = withTranscripts(chain3, {
		a: [
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `echo ${long}` } }] } }),
			JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: "t1", content: [{ type: "text", text: long }] } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "taskflow_peek", arguments: { q: long } }] } }),
			JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "taskflow_peek", toolCallId: "t2", content: [{ type: "text", text: long }] } }),
		],
	});
	try {
		const state = finished3(cwd);
		state.phases.a.output = long;
		state.phases.b.liveLog = [long];
		const lines = renderRunResult(state, long, theme, true).render(50);
		for (const line of lines) assert.ok(visibleWidth(line) <= 50, `row exceeds 50 cols (${visibleWidth(line)}): ${line}`);
	} finally {
		cleanup();
	}
});

test("renderRunResult expanded: a finished run's transcripts are opened at most once per component", () => {
	const { cwd, cleanup } = withTranscripts(chain3, { a: [textLine("said-by-a")] });
	const open = mock.method(fsModule, "openSync");
	const stat = mock.method(fsModule, "statSync");
	syncBuiltinESMExports();
	try {
		const component = renderRunResult(finished3(cwd), "C-OUTPUT", theme, true);
		const onA = (calls: { arguments: unknown[] }[]) => calls.filter((c) => String(c.arguments[0]).endsWith("a.ndjson")).length;
		const transcriptOpens = () => onA(open.mock.calls);
		assert.match(component.render(100).join("\n"), /said-by-a/);
		assert.equal(transcriptOpens(), 1);
		assert.match(component.render(100).join("\n"), /said-by-a/);
		assert.equal(transcriptOpens(), 1, "second render re-uses the parsed entries");
		assert.equal(onA(stat.mock.calls), 1, "a finished run is not polled again");
	} finally {
		open.mock.restore();
		stat.mock.restore();
		syncBuiltinESMExports();
		cleanup();
	}
});

test("renderRunResult expanded: a rebuilt component for the same running state reads only appended bytes", () => {
	const { cwd, cleanup } = withTranscripts(chain3, { a: [textLine("first-line")] });
	const file = transcriptFileFor(transcriptDirFor(runsDir(cwd), "chain3", "r"), "a");
	const open = mock.method(fsModule, "openSync");
	const read = mock.method(fsModule, "readSync");
	syncBuiltinESMExports();
	try {
		const state = finished3(cwd);
		state.status = "running";
		const initial = fs.statSync(file).size;
		assert.match(renderRunResult(state, "", theme, true).render(100).join("\n"), /first-line/);
		const appended = `${textLine("second-line")}\n`;
		fs.appendFileSync(file, appended);
		assert.match(renderRunResult(state, "", theme, true).render(100).join("\n"), /first-line[\s\S]*second-line/);
		const fds = new Set(open.mock.calls.filter((c) => c.arguments[0] === file).map((c) => c.result));
		// readSync(fd, buf, offset, length, position)
		const reads = read.mock.calls
			.map((c) => c.arguments as unknown[])
			.filter((a) => fds.has(a[0] as number))
			.map((a) => [a[3], a[4]]);
		assert.deepEqual(reads, [[initial, 0], [Buffer.byteLength(appended), initial]]);
	} finally {
		open.mock.restore();
		read.mock.restore();
		syncBuiltinESMExports();
		cleanup();
	}
});

test("renderRunResult expanded: a running run picks up appended transcript lines", () => {
	const { cwd, cleanup } = withTranscripts(chain3, { a: [textLine("first-line")] });
	try {
		const state = finished3(cwd);
		state.status = "running";
		const component = renderRunResult(state, "", theme, true);
		assert.doesNotMatch(component.render(100).join("\n"), /second-line/);
		fs.appendFileSync(transcriptFileFor(transcriptDirFor(runsDir(cwd), "chain3", "r"), "a"), `${textLine("second-line")}\n`);
		assert.match(component.render(100).join("\n"), /second-line/);
	} finally {
		cleanup();
	}
});
