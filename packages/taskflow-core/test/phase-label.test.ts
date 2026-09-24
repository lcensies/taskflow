import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import { CacheStore } from "../src/cache.ts";
import { compileTaskflowToIR } from "../src/flowir/index.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { RunResult, RunOptions } from "../src/runner-core.ts";
import type { Taskflow } from "../src/schema.ts";
import { validateTaskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-phase-label-"));
}

function mkState(def: Taskflow, cwd: string): RunState {
	return {
		runId: `run-${Math.random().toString(36).slice(2, 8)}`,
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd,
	};
}

function countingRunner(counter: { n: number }): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => {
		counter.n++;
		return {
			agent: agentName,
			task,
			exitCode: 0,
			output: `out:${task}#${counter.n}`,
			stderr: "",
			usage: { ...emptyUsage(), output: 10, cost: 0.001, turns: 1 },
			stopReason: "end",
		};
	};
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test("validateTaskflow: accepts a valid label", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: "Fix login bug", final: true }],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("validateTaskflow: accepts a flow without a label (backward compat)", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", final: true }],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("validateTaskflow: rejects an empty label", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: "", final: true }],
	});
	assert.equal(r.ok, false);
	assert.match(r.errors.join("\n"), /Phase 'p': label must be/);
});

test("validateTaskflow: rejects a label over 120 characters", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: "x".repeat(121), final: true }],
	});
	assert.equal(r.ok, false);
	assert.match(r.errors.join("\n"), /Phase 'p': label must be/);
});

test("validateTaskflow: accepts a label at exactly 120 characters", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: "x".repeat(120), final: true }],
	});
	assert.equal(r.ok, true, r.errors.join("; "));
});

test("validateTaskflow: rejects a label containing a newline", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: "two\nlines", final: true }],
	});
	assert.equal(r.ok, false);
	assert.match(r.errors.join("\n"), /Phase 'p': label must be/);
});

test("validateTaskflow: rejects a non-string label", () => {
	const r = validateTaskflow({
		name: "x",
		phases: [{ id: "p", type: "agent", agent: "a", task: "t", label: 42, final: true }],
	});
	assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// hashFlowIR: label must not move the compiled-IR content hash
// ---------------------------------------------------------------------------

test("hashFlowIR: identical with and without a phase label", async () => {
	const mk = (label?: string): Taskflow => ({
		name: "label-hash",
		phases: [
			{ id: "p", type: "agent", agent: "a", task: "t", ...(label !== undefined ? { label } : {}), final: true },
		],
	});
	const withoutLabel = await compileTaskflowToIR(mk());
	const withLabel = await compileTaskflowToIR(mk("Do the thing"));
	assert.equal(withoutLabel.errors.length, 0, withoutLabel.errors.map((e) => e.message).join("; "));
	assert.ok(withoutLabel.hash);
	assert.equal(withLabel.hash, withoutLabel.hash, "compiled IR hash must be label-invariant");
});

// ---------------------------------------------------------------------------
// Cache inputHash: label must not move a phase's cache key
// ---------------------------------------------------------------------------

test("cache inputHash: identical with and without a phase label", async () => {
	const dir = tmpDir();
	const store = new CacheStore(dir);
	const mk = (label?: string): Taskflow => ({
		name: "label-cache",
		phases: [
			{
				id: "p",
				type: "agent",
				agent: "a",
				task: "t",
				cache: { scope: "cross-run" },
				...(label !== undefined ? { label } : {}),
				final: true,
			},
		],
	});
	const counter = { n: 0 };
	const deps: RuntimeDeps = { cwd: dir, agents: AGENTS, runTask: countingRunner(counter), cacheStore: store };

	const r1 = await executeTaskflow(mkState(mk(), dir), deps);
	const inputHashNoLabel = r1.state.phases.p.inputHash;
	assert.ok(inputHashNoLabel);

	const r2 = await executeTaskflow(mkState(mk("Do the thing"), dir), deps);
	const inputHashWithLabel = r2.state.phases.p.inputHash;

	assert.equal(inputHashWithLabel, inputHashNoLabel, "phase inputHash must be label-invariant");
	// Confirms the label truly didn't perturb the cache key: the second run
	// hits the first run's cross-run cache entry instead of re-executing.
	assert.equal(counter.n, 1, "second run (labelled) hits the first run's cache entry");
	assert.equal(r2.state.phases.p.cacheHit, "cross-run");

	fs.rmSync(dir, { recursive: true, force: true });
});
