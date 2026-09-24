import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PEEK_DEFAULT_LIMIT, PEEK_MAX_LIMIT, peekRun } from "../src/peek.ts";
import { runsDir, saveRun, transcriptDirFor, transcriptFileFor, type RunState } from "../src/store.ts";
import type { Taskflow } from "../src/schema.ts";

function mkTmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-peek-"));
}

const DEF: Taskflow = {
	name: "peekflow",
	phases: [
		{ id: "scan", type: "agent", task: "scan", output: "json" },
		{ id: "audit", type: "map", over: "{steps.scan.json}", task: "audit {item}", dependsOn: ["scan"] },
		{ id: "report", type: "agent", task: "report", dependsOn: ["audit"], final: true },
	],
};

function seedRun(cwd: string): RunState {
	const mapOutput = [
		'### [1/2] analyst\n\nfinding one',
		'### [2/2] analyst\n\nfinding two',
	].join("\n\n---\n\n");
	const state: RunState = {
		runId: "peekflow-abc123",
		flowName: "peekflow",
		def: DEF,
		args: {},
		status: "completed",
		phases: {
			scan: { id: "scan", status: "done", output: '["a","b"]', json: ["a", "b"], endedAt: 1 },
			audit: {
				id: "audit", status: "done", output: mapOutput,
				subProgress: { done: 2, total: 2, running: 0, failed: 0 }, endedAt: 2,
			},
			report: { id: "report", status: "done", output: "x".repeat(10_000), endedAt: 3 },
		},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
	saveRun(state);
	return state;
}

test("peek: missing run and missing phase return actionable errors", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const noRun = peekRun(cwd, "nope-run");
		assert.equal(noRun.ok, false);
		assert.match(noRun.text, /Run not found/);

		const noPhase = peekRun(cwd, "peekflow-abc123", { phaseId: "bogus" });
		assert.equal(noPhase.ok, false);
		assert.match(noPhase.text, /Phases: scan, audit, report/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: without phaseId lists phases with status and output size", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const res = peekRun(cwd, "peekflow-abc123");
		assert.equal(res.ok, true);
		assert.match(res.text, /scan \[done\]/);
		assert.match(res.text, /audit \[done · 2\/2 items\]/);
		assert.match(res.text, /10000 chars/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: phase text output is returned with a status header", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const res = peekRun(cwd, "peekflow-abc123", { phaseId: "scan" });
		assert.equal(res.ok, true);
		assert.match(res.text, /peekflow-abc123 › scan \[done\]/);
		assert.match(res.text, /\["a","b"\]/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: --json returns pretty-printed parsed JSON", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const res = peekRun(cwd, "peekflow-abc123", { phaseId: "scan", json: true });
		assert.equal(res.ok, true);
		assert.match(res.text, /\[\n\s+"a",\n\s+"b"\n\]/);

		const noJson = peekRun(cwd, "peekflow-abc123", { phaseId: "report", json: true });
		assert.equal(noJson.ok, false);
		assert.match(noJson.text, /no parsed JSON/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: --item extracts one section of a map output; out-of-range errors", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const one = peekRun(cwd, "peekflow-abc123", { phaseId: "audit", item: 2 });
		assert.equal(one.ok, true);
		assert.match(one.text, /finding two/);
		assert.doesNotMatch(one.text, /finding one/);

		const oob = peekRun(cwd, "peekflow-abc123", { phaseId: "audit", item: 3 });
		assert.equal(oob.ok, false);
		assert.match(oob.text, /available: 1, 2/);

		const notMap = peekRun(cwd, "peekflow-abc123", { phaseId: "scan", item: 1 });
		assert.equal(notMap.ok, false);
		assert.match(notMap.text, /no item sections/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: --item keys by positional label, not section order (budget-skip gaps)", () => {
	const cwd = mkTmp();
	try {
		const state = seedRun(cwd);
		// Simulate a budget-skipped item 1: mergePhaseState omits its section
		// entirely, so the merged output starts at label [2/3].
		state.phases.audit.output = [
			"### [2/3] analyst\n\nsurvivor two",
			"### [3/3] analyst\n\nsurvivor three",
		].join("\n\n---\n\n");
		saveRun(state);
		const two = peekRun(cwd, state.runId, { phaseId: "audit", item: 2 });
		assert.equal(two.ok, true);
		assert.match(two.text, /survivor two/);
		const one = peekRun(cwd, state.runId, { phaseId: "audit", item: 1 });
		assert.equal(one.ok, false);
		assert.match(one.text, /budget-skipped/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: a spurious separator inside item content does not steal a later label", () => {
	const cwd = mkTmp();
	try {
		const state = seedRun(cwd);
		// Item 1's CONTENT contains the separator + a fake "[2/2]" label. The
		// genuine [2/2] section comes later; first-label-wins must keep the real one.
		state.phases.audit.output = [
			"### [1/2] analyst\n\nreport with embedded\n\n---\n\n### [2/2] fake heading inside item one",
			"### [2/2] analyst\n\ngenuine item two",
		].join("\n\n---\n\n");
		saveRun(state);
		const two = peekRun(cwd, state.runId, { phaseId: "audit", item: 2 });
		assert.equal(two.ok, true);
		assert.match(two.text, /fake heading inside item one|genuine item two/);
		// item 1 must still resolve to the real first section
		const one = peekRun(cwd, state.runId, { phaseId: "audit", item: 1 });
		assert.equal(one.ok, true);
		assert.match(one.text, /report with embedded/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: output is hard-truncated at the default limit and the cap is enforced", () => {
	const cwd = mkTmp();
	try {
		seedRun(cwd);
		const res = peekRun(cwd, "peekflow-abc123", { phaseId: "report" });
		assert.equal(res.ok, true);
		assert.equal(res.truncated, true);
		assert.match(res.text, new RegExp(`truncated at ${PEEK_DEFAULT_LIMIT} chars`));
		assert.ok(res.text.length < 10_000);

		// A limit beyond the ceiling clamps to PEEK_MAX_LIMIT; garbage limits use the default.
		const big = peekRun(cwd, "peekflow-abc123", { phaseId: "report", limit: 1_000_000 });
		assert.ok(big.text.length <= PEEK_MAX_LIMIT + 200);
		const garbage = peekRun(cwd, "peekflow-abc123", { phaseId: "report", limit: -5 });
		assert.match(garbage.text, new RegExp(`truncated at ${PEEK_DEFAULT_LIMIT} chars`));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: --transcript reads and formats the node's transcript file", () => {
	const cwd = mkTmp();
	try {
		const state = seedRun(cwd);
		const dir = transcriptDirFor(runsDir(cwd), state.flowName, state.runId);
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({ type: "taskflow_attempt", attempt: 2, at: 1 }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "scanning the repo" }] } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] } }),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolResult", name: "read", text: "file contents", isError: false }] } }),
		].join("\n");
		fs.writeFileSync(transcriptFileFor(dir, "scan"), lines);

		const res = peekRun(cwd, state.runId, { phaseId: "scan", transcript: true });
		assert.equal(res.ok, true);
		assert.match(res.text, /attempt 2/);
		assert.match(res.text, /scanning the repo/);
		assert.match(res.text, /read/);
		assert.match(res.text, /file contents/);

		const missing = peekRun(cwd, state.runId, { phaseId: "report", transcript: true });
		assert.equal(missing.ok, false);
		assert.match(missing.text, /No transcript/);

		// --item selects the per-item node file (`<phase>-<item>`).
		fs.writeFileSync(
			transcriptFileFor(dir, "audit-1"),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "item one activity" }] } }),
		);
		const itemRes = peekRun(cwd, state.runId, { phaseId: "audit", item: 1, transcript: true });
		assert.equal(itemRes.ok, true);
		assert.match(itemRes.text, /item one activity/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: --transcript truncates from the front, keeping the tail", () => {
	const cwd = mkTmp();
	try {
		const state = seedRun(cwd);
		const dir = transcriptDirFor(runsDir(cwd), state.flowName, state.runId);
		fs.mkdirSync(dir, { recursive: true });
		const events = Array.from({ length: 50 }, (_, i) =>
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `line-${i}` }] } }),
		).join("\n");
		fs.writeFileSync(transcriptFileFor(dir, "scan"), events);

		const res = peekRun(cwd, state.runId, { phaseId: "scan", transcript: true, limit: 200 });
		assert.equal(res.ok, true);
		assert.equal(res.truncated, true);
		assert.match(res.text, /truncated \d+ chars from start/);
		assert.match(res.text, /line-49/);
		assert.doesNotMatch(res.text, /line-0[^0-9]/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("peek: is read-only (run state file unchanged)", () => {
	const cwd = mkTmp();
	try {
		const state = seedRun(cwd);
		const runFile = path.join(cwd, ".pi", "taskflows", "runs", "peekflow", `${state.runId}.json`);
		const before = fs.readFileSync(runFile, "utf8");
		peekRun(cwd, state.runId, { phaseId: "audit", item: 1 });
		peekRun(cwd, state.runId);
		const after = fs.readFileSync(runFile, "utf8");
		assert.equal(after, before);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
