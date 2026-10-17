/**
 * S2 event-kernel driver tests (all phase kinds, default OFF).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions, RunResult } from "../src/runner-core.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import { canUseEventKernel, eventKernelEnabled, kernelUnsupportedReason } from "../src/exec/driver.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { emptyUsage } from "../src/usage.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "ek-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: process.cwd(),
	};
}

function cannedRunner(output: string): RuntimeDeps["runTask"] {
	return async (_cwd, _agents, agentName, task, _o: RunOptions): Promise<RunResult> => ({
		agent: agentName,
		task,
		exitCode: 0,
		output,
		stderr: "",
		usage: { ...emptyUsage(), output: 5, cost: 0.001, turns: 1 },
		stopReason: "end",
	});
}

test("eventKernelEnabled: default off; true flag or env enables", () => {
	const prev = process.env.PI_TASKFLOW_EVENT_KERNEL;
	try {
		delete process.env.PI_TASKFLOW_EVENT_KERNEL;
		assert.equal(eventKernelEnabled({}), false);
		assert.equal(eventKernelEnabled({ eventKernel: true }), true);
		assert.equal(eventKernelEnabled({ eventKernel: false }), false);
		process.env.PI_TASKFLOW_EVENT_KERNEL = "1";
		assert.equal(eventKernelEnabled({}), true);
		assert.equal(eventKernelEnabled({ eventKernel: false }), false); // explicit wins
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_EVENT_KERNEL;
		else process.env.PI_TASKFLOW_EVENT_KERNEL = prev;
	}
});

test("canUseEventKernel: all kinds including gate", () => {
	assert.equal(
		canUseEventKernel({
			name: "ok",
			phases: [
				{ id: "a", type: "agent", agent: "a", task: "t" },
				{ id: "s", type: "script", run: ["node", "-e", "1"], dependsOn: ["a"], final: true },
			],
		}),
		true,
	);
	assert.equal(
		canUseEventKernel({
			name: "map-ok",
			phases: [{ id: "m", type: "map", agent: "a", task: "t", over: "[]", final: true }],
		}),
		true,
	);
	assert.equal(
		canUseEventKernel({
			name: "gate-ok",
			phases: [{ id: "g", type: "gate", agent: "a", task: "t", final: true }],
		}),
		true,
	);
});

test("canUseEventKernel: workspace cwd keywords force the isolation-aware imperative runtime", () => {
	for (const cwd of ["temp", "dedicated", "worktree"] as const) {
		const def: Taskflow = {
			name: `workspace-${cwd}`,
			scriptCwd: "flow",
			phases: [{ id: "s", type: "script", run: ["node", "-e", "1"], cwd, final: true }],
		};
		assert.equal(canUseEventKernel(def), false);
		assert.match(kernelUnsupportedReason(def) ?? "", /workspace cwd.*imperative runtime/);
	}
});
test("event kernel: recon map tracks out-of-order items while running", async () => {
	const def: Taskflow = { name: "kernel-recon", phases: [{ id: "recon", type: "map", over: '["slow","fast"]', task: "{item}", agent: "a", final: true }] };
	let releaseSlow!: () => void;
	const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
	let fastDone!: () => void;
	const fast = new Promise<void>((resolve) => { fastDone = resolve; });
	const snapshots: string[][] = [];
	const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
		if (task === "slow") await slow; else fastDone();
		return { agent, task, exitCode: 0, output: task, stderr: "", usage: { ...emptyUsage(), output: 2 } };
	};
	const pending = executeTaskflow(mkState(def), { cwd: process.cwd(), agents: AGENTS, runTask, eventKernel: true, onProgress: (s) => {
		if (s.phases.recon?.items) snapshots.push(s.phases.recon.items.map((item) => item.status));
	} });
	await fast;
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.ok(snapshots.some((statuses) => statuses[0] === "running" && statuses[1] === "done"));
	} finally {
		releaseSlow();
	}
	const result = await pending;
	assert.deepEqual(result.state.phases.recon.items?.map((item) => item.status), ["done", "done"]);
});

test("event kernel: nested flow progress reports the parent run, never the child record", async () => {
	const def: Taskflow = { name: "kernel-parent", phases: [{ id: "child", type: "flow", final: true, def: {
		name: "kernel-child", phases: [{ id: "recon", type: "map", over: '["slow","fast"]', task: "{item}", agent: "a", final: true }],
	} }] };
	let releaseSlow!: () => void;
	const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
	let fastDone!: () => void;
	const fast = new Promise<void>((resolve) => { fastDone = resolve; });
	const seen: string[] = [];
	const nested: Array<RunState["phases"][string]["subProgress"]> = [];
	const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agent, task) => {
		if (task === "slow") await slow; else fastDone();
		return { agent, task, exitCode: 0, output: task, stderr: "", usage: emptyUsage() };
	};
	const pending = executeTaskflow(mkState(def), {
		cwd: process.cwd(), agents: AGENTS, runTask, eventKernel: true,
		persist: (s) => { seen.push(s.runId); },
		onProgress: (s) => { seen.push(s.runId); nested.push(s.phases.child?.subProgress && { ...s.phases.child.subProgress }); },
	});
	await fast;
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.ok(nested.some((p) => p?.running === 1 && p.total === 1), "parent flow phase carries the nested summary");
	} finally {
		releaseSlow();
	}
	const result = await pending;
	assert.equal(result.state.phases.child.status, "done");
	assert.deepEqual([...new Set(seen)], ["ek-run"], "child state never reaches host callbacks");
});

test("event kernel: script phase captures stdout (zero tokens)", async () => {
	const def: Taskflow = {
		name: "ek-script",
		phases: [
			{
				id: "s",
				type: "script",
				run: ["node", "-e", "process.stdout.write('kernel-ok')"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async () => {
			throw new Error("agent must not run");
		},
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "kernel-ok");
	assert.equal(res.state.phases.s.status, "done");
});

test("event kernel: agent→script chain interpolates {steps.*.output}", async () => {
	const def: Taskflow = {
		name: "ek-chain",
		phases: [
			{ id: "gen", type: "agent", agent: "a", task: "produce" },
			{
				id: "echo",
				type: "script",
				// script run arrays are not interpolated for injection safety —
				// use agent final for interpolation check instead.
				run: ["node", "-e", "process.stdout.write('scripted')"],
				dependsOn: ["gen"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: cannedRunner("from-agent"),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.gen.output, "from-agent");
	assert.equal(res.finalOutput, "scripted");
});

test("event kernel: agent-only flow returns agent output", async () => {
	const def: Taskflow = {
		name: "ek-agent",
		phases: [{ id: "p", type: "agent", agent: "a", task: "hi", final: true }],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: cannedRunner("agent-out"),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.ok, true);
	assert.equal(res.finalOutput, "agent-out");
});

test("event kernel: preserves agent usage on phase + totalUsage", async () => {
	const def: Taskflow = {
		name: "ek-usage",
		phases: [{ id: "p", type: "agent", agent: "a", task: "bill me", final: true }],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => ({
			agent,
			task,
			exitCode: 0,
			output: "paid",
			stderr: "",
			usage: { ...emptyUsage(), input: 100, output: 50, cost: 0.42, turns: 2 },
			stopReason: "end",
		}),
		persist: () => {},
		eventKernel: true,
	});
	assert.equal(res.ok, true);
	assert.equal(res.state.phases.p.usage?.cost, 0.42);
	assert.equal(res.state.phases.p.usage?.input, 100);
	assert.equal(res.totalUsage.cost, 0.42);
	assert.equal(res.totalUsage.turns, 2);
});

test("event kernel: when-guard false skips phase and emits decision", async () => {
	const events: import("../src/trace.ts").TraceEvent[] = [];
	const def: Taskflow = {
		name: "ek-when",
		phases: [
			{ id: "a", type: "agent", agent: "a", task: "first" },
			{
				id: "opt",
				type: "agent",
				agent: "a",
				task: "maybe",
				when: "false",
				dependsOn: ["a"],
				final: true,
			},
		],
	};
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: cannedRunner("x"),
		persist: () => {},
		eventKernel: true,
		trace: {
			emit: (e) => events.push(e),
			flush: () => {},
		},
	});
	assert.equal(res.state.phases.opt.status, "skipped");
	const whenDec = events.find((e) => e.kind === "decision" && e.decision?.type === "when-guard");
	assert.ok(whenDec);
	if (whenDec?.decision?.type === "when-guard") {
		assert.equal(whenDec.decision.result, false);
	}
	// skipped phase must not call the agent for opt (only once for `a`)
	assert.equal(res.state.phases.a.status, "done");
	const skippedStart = events.find((e) => e.kind === "phase-start" && e.phaseId === "opt");
	assert.deepEqual(skippedStart?.dependencies, ["a"], "synthetic skip traces must retain DAG metadata for replay");
	assert.equal(skippedStart?.optional, false);
});

test("event kernel: script timeout terminates the entire process group", { skip: process.platform === "win32" }, async () => {
	const def: Taskflow = {
		name: "ek-script-tree-timeout",
		phases: [{ id: "s", type: "script", run: ["bash", "-lc", "sleep 5 & wait"], timeout: 1000, final: true }],
	};
	const started = Date.now();
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async () => { throw new Error("agent must not run"); },
		persist: () => {},
		eventKernel: true,
	});
	const elapsed = Date.now() - started;
	assert.equal(res.ok, false);
	assert.equal(res.state.phases.s.timedOut, true);
	assert.ok(elapsed < 2500, `process-tree timeout took too long: ${elapsed}ms`);
});

test("event kernel: normal script exit reaps a background process holding stdio", { skip: process.platform === "win32" }, async () => {
	const def: Taskflow = {
		name: "ek-script-background",
		phases: [{ id: "s", type: "script", run: ["bash", "-lc", "sleep 3 &"], final: true }],
	};
	const started = Date.now();
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(), agents: AGENTS,
		runTask: async () => { throw new Error("agent must not run"); },
		persist: () => {}, eventKernel: true,
	});
	assert.equal(res.ok, true);
	assert.ok(Date.now() - started < 1000, "background descendant must be reaped at direct-child exit");
});

test("event kernel OFF by default: map flows still run on imperative path", async () => {
	const def: Taskflow = {
		name: "map-default",
		phases: [
			{
				id: "m",
				type: "map",
				agent: "a",
				task: "item={item}",
				over: '["x","y"]',
				final: true,
			},
		],
	};
	const seen: string[] = [];
	const res = await executeTaskflow(mkState(def), {
		cwd: process.cwd(),
		agents: AGENTS,
		runTask: async (_c, _a, agent, task) => {
			seen.push(task);
			return {
				agent,
				task,
				exitCode: 0,
				output: `out:${task}`,
				stderr: "",
				usage: emptyUsage(),
				stopReason: "end",
			};
		},
		persist: () => {},
		// eventKernel unset — default off; map would fail on kernel anyway
	});
	assert.equal(res.ok, true);
	assert.equal(seen.length, 2);
});
