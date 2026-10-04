/**
 * Work verdict, separate from process outcome (design D6, tasks 4.1/4.2).
 *
 * `PhaseState.verdict` answers "was the work accepted?" — a different question
 * from `status`/`error` ("did the process settle cleanly?"). A clean exit alone
 * must never set it; only an explicit check (a gate decision, or a `script`
 * phase's own deterministic pass/fail) does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { deriveVerdict, phaseVerdict, type RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const dummyAgent: AgentConfig = {
	name: "default",
	description: "dummy",
	systemPrompt: "",
	source: "user",
	filePath: "none",
};

function mkState(def: unknown, runId: string): RunState {
	return {
		runId,
		flowName: (def as { name: string }).name,
		def: def as RunState["def"],
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp/test-verdict",
	};
}

function mockResult(output: string): RunResult {
	return { agent: "default", task: "", exitCode: 0, output, stderr: "", usage: emptyUsage() };
}

// ---------------------------------------------------------------------------
// 4.1 — the pure mapping, and its default
// ---------------------------------------------------------------------------

test("phaseVerdict: absent field defaults to undetermined", () => {
	assert.equal(phaseVerdict({ verdict: undefined }), "undetermined");
	assert.equal(phaseVerdict({ verdict: "accepted" }), "accepted");
	assert.equal(phaseVerdict({ verdict: "rejected" }), "rejected");
});

test("deriveVerdict: no gate, not a script → undefined (no explicit check ran)", () => {
	assert.equal(deriveVerdict("agent", undefined, "done"), undefined);
	assert.equal(deriveVerdict("agent", undefined, "failed"), undefined);
});

test("agent phase: a clean exit has a successful process outcome and an undetermined verdict (4.1)", async () => {
	const def = { name: "verdict-clean", phases: [{ id: "p", type: "agent", task: "do work" }] };
	const state = mkState(def, "verdict-clean-1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async () => mockResult("DONE"),
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases.p?.status, "done", "process outcome: successful");
	assert.equal(state.phases.p?.verdict, undefined, "no explicit check ran — verdict stays undetermined");
	assert.equal(phaseVerdict(state.phases.p!), "undetermined");
});

// ---------------------------------------------------------------------------
// 4.2 — gate verdicts and script acceptance checks write the field
// ---------------------------------------------------------------------------

test("gate: a blocking verdict over a cleanly-exited node yields not-accepted, process outcome untouched (4.2)", async () => {
	const def = {
		name: "verdict-gate",
		phases: [
			{ id: "prod", type: "agent", task: "produce" },
			{
				id: "check",
				type: "gate",
				task: "judge it",
				dependsOn: ["prod"],
			},
		],
	};
	const state = mkState(def, "verdict-gate-1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		// The gate's own subagent call exits cleanly (exitCode 0, no signal) —
		// a successful process outcome — but its text is a BLOCK verdict.
		runTask: async (_cwd, _agents, _an, task) =>
			mockResult(task.includes("judge it") ? "VERDICT: BLOCK" : "produced output"),
	};
	const result = await executeTaskflow(state, deps);
	const gatePhase = state.phases.check;
	assert.equal(result.ok, false, "a blocking gate blocks the run");
	assert.equal(gatePhase?.status, "done", "the gate's own worker settled cleanly — process outcome unaffected");
	assert.equal(gatePhase?.gate?.verdict, "block");
	assert.equal(gatePhase?.verdict, "rejected", "the explicit gate decision writes the work verdict");
	assert.equal(phaseVerdict(gatePhase!), "rejected");
	// The gate verdict write must not invent or touch completionSource — it was
	// never set live (that field is reserved for reattach reconciliation).
	assert.equal(gatePhase?.completionSource, undefined);
});

test("gate: a passing verdict is recorded as accepted (4.2)", async () => {
	const def = {
		name: "verdict-gate-pass",
		phases: [{ id: "check", type: "gate", task: "judge it" }],
	};
	const state = mkState(def, "verdict-gate-pass-1");
	const deps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async () => mockResult("VERDICT: PASS"),
	};
	const result = await executeTaskflow(state, deps);
	assert.equal(result.ok, true);
	assert.equal(state.phases.check?.gate?.verdict, "pass");
	assert.equal(state.phases.check?.verdict, "accepted");
});

test("script: its own deterministic exit IS the acceptance check (4.2)", async () => {
	const defOk = { name: "verdict-script-ok", phases: [{ id: "s", type: "script", run: [process.execPath, "-e", "process.exit(0)"] }] };
	const okState = mkState(defOk, "verdict-script-ok-1");
	const okDeps: RuntimeDeps = {
		cwd: "/tmp",
		agents: [dummyAgent],
		runTask: async () => {
			throw new Error("script phases must not call the agent runner");
		},
	};
	const okResult = await executeTaskflow(okState, okDeps);
	assert.equal(okResult.ok, true);
	assert.equal(okState.phases.s?.status, "done");
	assert.equal(okState.phases.s?.verdict, "accepted");

	const defFail = { name: "verdict-script-fail", phases: [{ id: "s", type: "script", run: [process.execPath, "-e", "process.exit(1)"], optional: true }] };
	const failState = mkState(defFail, "verdict-script-fail-1");
	const failResult = await executeTaskflow(failState, okDeps);
	assert.equal(failResult.ok, true, "optional phase does not block the run");
	assert.equal(failState.phases.s?.status, "failed");
	assert.equal(failState.phases.s?.verdict, "rejected");
});
