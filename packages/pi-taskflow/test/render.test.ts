import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFingerprint, renderProgress, renderRunningActivity, summarizeRun } from "../src/render.ts";
import { emptyUsage } from "taskflow-core";
import type { Taskflow } from "taskflow-core";
import type { PhaseState, RunState } from "taskflow-core";

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
	assert.match(s, /1\/3 done/);
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

test("renderRunningActivity: only running phases, most recent lines, empty when idle", () => {
	const def: Taskflow = {
		name: "x",
		phases: [
			{ id: "a", type: "agent", task: "t" },
			{ id: "b", type: "agent", task: "t", final: true },
		],
	};
	const state = mkState(def, {
		a: { id: "a", status: "running", liveLog: ["one", "two", "three"] },
		b: { id: "b", status: "done", liveLog: ["finished work"], usage: emptyUsage() },
	});
	const out = renderRunningActivity(state, theme, 2);
	assert.match(out, /Activity/);
	assert.match(out, /two/);
	assert.match(out, /three/);
	assert.doesNotMatch(out, /one\b/, "older lines beyond the per-phase cap are dropped");
	assert.doesNotMatch(out, /finished work/, "a finished phase is not live activity");

	const idle = mkState(def, { a: done("a"), b: done("b") }, "completed");
	assert.equal(renderRunningActivity(idle, theme), "", "nothing running → no activity block");
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

test("renderFingerprint: stable for an unchanged state within the same second", () => {
	const def: Taskflow = { name: "x", phases: [{ id: "p", type: "agent", task: "t", final: true }] };
	const state = mkState(def, { p: done("p") }, "completed");
	assert.equal(renderFingerprint(state), renderFingerprint(state));
});
