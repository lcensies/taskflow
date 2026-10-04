/**
 * tmux worker windows (items 6.1, 6.2, 6.3, 6.6): one window per node, opt-in
 * (default off — design D8 revised), idempotent, capped, never handed anything
 * that could touch the worker, and fail-open when tmux is absent or unreachable.
 * Most tests below pass `{ enabled: true }` (or an agent dir whose settings.json
 * turns windows on) to exercise the open/cap/pid-safety mechanics directly;
 * the "no configuration present" tests assert the opt-in default itself.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig, PhaseState, RunState, Taskflow } from "taskflow-core";
import { executeTaskflow } from "taskflow-core";
import { runAgentTask } from "../src/runner.ts";
import {
	TMUX_BIN_ENV,
	TMUX_MAX_WINDOWS_ENV,
	WORKER_WINDOW_UNAVAILABLE_WARNING,
	forgetWorkerWindows,
	openWorkerWindow,
	openWorkerWindowForTranscript,
	skippedWorkerWindows,
	workerWindowName,
} from "../src/tmux-viewer.ts";

/** A tmux stand-in that records each invocation's argv, one per line. */
function stubTmux(dir: string): { bin: string; invocations: () => string[][] } {
	const log = path.join(dir, "tmux.log");
	const bin = path.join(dir, "fake-tmux.mjs");
	fs.writeFileSync(
		bin,
		`#!${process.execPath}\n` +
			`import {appendFileSync} from "node:fs";\n` +
			`appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
	);
	fs.chmodSync(bin, 0o755);
	return {
		bin,
		invocations: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[])
				: [],
	};
}

function withTmuxEnv<T>(bin: string | undefined, fn: () => T, agentDir?: string): T {
	const restore = setTmuxEnv(bin, agentDir);
	try {
		return fn();
	} finally {
		restore();
	}
}

/** Set $TMUX (+ the tmux stub, + the agent dir the setting is read from) and
 *  return the restore function. */
function setTmuxEnv(bin: string | undefined, agentDir?: string): () => void {
	const prevTmux = process.env.TMUX;
	const prevBin = process.env[TMUX_BIN_ENV];
	const prevAgentDir = process.env.TASKFLOW_AGENT_DIR;
	process.env.TMUX = "/tmp/tmux-1000/default,1,0";
	if (bin) process.env[TMUX_BIN_ENV] = bin;
	// Keep the `taskflow.workerWindows` lookup off the real ~/.pi/agent.
	process.env.TASKFLOW_AGENT_DIR = agentDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tf-agentdir-"));
	return () => {
		if (prevTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = prevTmux;
		if (prevBin === undefined) delete process.env[TMUX_BIN_ENV];
		else process.env[TMUX_BIN_ENV] = prevBin;
		if (prevAgentDir === undefined) delete process.env.TASKFLOW_AGENT_DIR;
		else process.env.TASKFLOW_AGENT_DIR = prevAgentDir;
	};
}

/** An agent dir whose settings.json sets `taskflow.workerWindows`. */
function agentDirWithSetting(dir: string, workerWindows: boolean): string {
	const agentDir = path.join(dir, `agent-${workerWindows}`);
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ taskflow: { workerWindows } }));
	return agentDir;
}

/** A pi stand-in that emits one assistant turn and exits. */
function writeFakePi(dir: string): string {
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`#!${process.execPath}\n` +
			`const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n");\n` +
			`emit({type:"agent_start"}); emit({type:"turn_start"});\n` +
			`emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"DONE"}],stopReason:"stop"}});\n` +
			`emit({type:"agent_end"});\n`,
	);
	fs.chmodSync(fakePi, 0o755);
	return fakePi;
}

function nameOf(argv: string[]): string {
	return argv[argv.indexOf("-n") + 1];
}

test("tmux viewer: one window per node, and a second call opens no duplicate", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-"));
	const tmux = stubTmux(dir);
	const runId = "flow-abc-deadbe";
	try {
		withTmuxEnv(tmux.bin, () => {
			for (const nodeId of ["one", "two", "three"]) {
				assert.equal(
					openWorkerWindow(
						{ runId, nodeId, transcriptFile: path.join(dir, runId, `${nodeId}.ndjson`) },
						{ enabled: true },
					),
					"opened",
				);
			}
			assert.equal(
				openWorkerWindow(
					{ runId, nodeId: "two", transcriptFile: path.join(dir, runId, "two.ndjson") },
					{ enabled: true },
				),
				"exists",
			);
		});
		const argvs = tmux.invocations();
		assert.equal(argvs.length, 3, "one tmux invocation per node, none for the repeat call");
		assert.deepEqual(argvs.map(nameOf), [
			"tf:deadbe:one",
			"tf:deadbe:two",
			"tf:deadbe:three",
		]);
		assert.equal(new Set(argvs.map(nameOf)).size, 3, "no two nodes share a window");
		assert.equal(workerWindowName(runId, "one"), "tf:deadbe:one");
	} finally {
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("tmux viewer: the cap is honoured and the skipped nodes are reported", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-cap-"));
	const tmux = stubTmux(dir);
	const runId = "flow-abc-capped";
	try {
		const results = withTmuxEnv(tmux.bin, () =>
			["n1", "n2", "n3", "n4"].map((nodeId) =>
				openWorkerWindow(
					{ runId, nodeId, transcriptFile: path.join(dir, runId, `${nodeId}.ndjson`) },
					{ max: 2, enabled: true },
				),
			),
		);
		assert.deepEqual(results, ["opened", "opened", "capped", "capped"]);
		assert.equal(tmux.invocations().length, 2, "never more windows than the cap");
		assert.deepEqual(skippedWorkerWindows(runId), ["n3", "n4"], "windowless nodes are listed, the run goes on");
	} finally {
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("tmux viewer: the window only ever gets the transcript path, never the worker's pid", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-plain-"));
	const tmux = stubTmux(dir);
	const runId = "flow-abc-nopid";
	const transcriptFile = path.join(dir, runId, "worker.ndjson");
	try {
		withTmuxEnv(tmux.bin, () => openWorkerWindowForTranscript(transcriptFile, { enabled: true }));
		const argvs = tmux.invocations();
		assert.equal(argvs.length, 1);
		assert.deepEqual(argvs[0], [
			"new-window",
			"-d",
			"-n",
			"tf:nopid:worker",
			`peek --follow '${transcriptFile}'`,
		]);
		const flat = argvs.flat().join(" ");
		assert.ok(!flat.includes(String(process.pid)), "no pid is passed to tmux");
		assert.ok(!/kill|send-keys|respawn/.test(flat), "no invocation that could reach the worker process");
	} finally {
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("tmux viewer: a node's window opens on its first transcript output", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-hook-"));
	const tmux = stubTmux(dir);
	const fakePi = writeFakePi(dir);
	const runId = "flow-abc-hooked";
	const transcriptFile = path.join(dir, runId, "phase-1.ndjson");
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	const restoreTmux = setTmuxEnv(tmux.bin);
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", { transcriptFile, idleTimeoutMs: 10_000, workerWindow: true });
		assert.equal(res.exitCode, 0);
		const argvs = tmux.invocations();
		assert.equal(argvs.length, 1, "exactly one window for the node, opened on first output");
		assert.equal(nameOf(argvs[0]), "tf:hooked:phase-1");
	} finally {
		restoreTmux();
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── item 6.6: windows default off (D8 revised), opt-in by setting or override ──

test("worker windows: no tmux invocation occurs with no configuration present", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-default-"));
	const tmux = stubTmux(dir);
	const runId = "flow-abc-default";
	try {
		// Empty agent dir: no settings.json at all, so nothing enables windows.
		const result = withTmuxEnv(tmux.bin, () =>
			openWorkerWindow({ runId, nodeId: "n1", transcriptFile: path.join(dir, runId, "n1.ndjson") }),
		);
		assert.equal(result, "disabled", "windows are off by default (design D8, revised: opt-in)");
		assert.equal(tmux.invocations().length, 0, "no tmux invocation with no configuration present");
	} finally {
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("worker windows: the setting enables/disables them, and the per-phase override wins over it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-disabled-"));
	const tmux = stubTmux(dir);
	const off = agentDirWithSetting(dir, false);
	const on = agentDirWithSetting(dir, true);
	const runId = "flow-abc-disabled";
	const target = (nodeId: string) => ({ runId, nodeId, transcriptFile: path.join(dir, runId, `${nodeId}.ndjson`) });
	try {
		// setting off → no tmux invocation at all
		assert.equal(withTmuxEnv(tmux.bin, () => openWorkerWindow(target("n1")), off), "disabled");
		assert.equal(tmux.invocations().length, 0, "the setting suppresses every tmux invocation");

		// setting on, no override → the setting alone opens it
		assert.equal(withTmuxEnv(tmux.bin, () => openWorkerWindow(target("n0")), on), "opened");
		assert.deepEqual(tmux.invocations().map(nameOf), ["tf:disabled:n0"], "enabling by setting opens one window per node");

		// setting on + per-phase override off → still no invocation
		assert.equal(
			withTmuxEnv(tmux.bin, () => openWorkerWindow(target("n2"), { enabled: false }), on),
			"disabled",
		);
		assert.equal(tmux.invocations().length, 1, "the per-phase override suppresses every tmux invocation");

		// setting off + per-phase override on → the override wins
		assert.equal(
			withTmuxEnv(tmux.bin, () => openWorkerWindow(target("n3"), { enabled: true }), off),
			"opened",
		);
		assert.deepEqual(tmux.invocations().map(nameOf), ["tf:disabled:n0", "tf:disabled:n3"], "the override wins over the setting");
		assert.deepEqual(skippedWorkerWindows(runId), [], "a disabled node is not a capped node");
	} finally {
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("worker windows: a fan-out past the configured cap opens exactly cap windows", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-fanout-"));
	const tmux = stubTmux(dir);
	const runId = "flow-abc-fanout";
	const prevMax = process.env[TMUX_MAX_WINDOWS_ENV];
	process.env[TMUX_MAX_WINDOWS_ENV] = "2";
	try {
		const nodes = ["i0", "i1", "i2", "i3", "i4"];
		const results = withTmuxEnv(tmux.bin, () =>
			nodes.map((nodeId) =>
				openWorkerWindow(
					{ runId, nodeId, transcriptFile: path.join(dir, runId, `${nodeId}.ndjson`) },
					{ enabled: true },
				),
			),
		);
		assert.deepEqual(results, ["opened", "opened", "capped", "capped", "capped"]);
		assert.deepEqual(tmux.invocations().map(nameOf), ["tf:fanout:i0", "tf:fanout:i1"], "exactly cap windows");
		assert.deepEqual(skippedWorkerWindows(runId), ["i2", "i3", "i4"], "the remaining node ids are reported");
	} finally {
		if (prevMax === undefined) delete process.env[TMUX_MAX_WINDOWS_ENV];
		else process.env[TMUX_MAX_WINDOWS_ENV] = prevMax;
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("worker windows: a phase override of false suppresses the window at the first-output seam", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-phaseoff-"));
	const tmux = stubTmux(dir);
	const fakePi = writeFakePi(dir);
	const runId = "flow-abc-phaseoff";
	const transcriptFile = path.join(dir, runId, "phase-1.ndjson");
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	const restoreTmux = setTmuxEnv(tmux.bin);
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const res = await runAgentTask(dir, agents, "t", "do work", {
			transcriptFile,
			idleTimeoutMs: 10_000,
			workerWindow: false,
		});
		assert.equal(res.exitCode, 0, "the run is unchanged with windows off");
		assert.equal(tmux.invocations().length, 0, "no tmux invocation for a phase that opted out");
		assert.ok(fs.existsSync(transcriptFile), "the transcript is still written");
	} finally {
		restoreTmux();
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		forgetWorkerWindows(runId);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── item 6.3: tmux absent / unreachable fails open with a warning ─────────────

/** A tmux stand-in that logs its argv and then fails, as `tmux` does when no
 *  server can be reached (and as the shell does when it is not installed). */
function stubFailingTmux(dir: string): { bin: string; invocations: () => string[][] } {
	const stub = stubTmux(dir);
	fs.appendFileSync(stub.bin, 'process.stderr.write("no server running\\n"); process.exit(1);\n');
	return stub;
}

/** Drop the fields that differ between any two runs, so what is left is the
 *  phase result proper. */
function stablePhases(phases: Record<string, PhaseState>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(phases).map(([id, ps]) => {
			const { startedAt, endedAt, warnings, ...rest } = ps;
			return [id, rest];
		}),
	);
}

test("worker windows: a failing tmux leaves the phase results untouched and records a warning", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-tmux-failopen-"));
	const tmux = stubFailingTmux(dir);
	const fakePi = writeFakePi(dir);
	const def: Taskflow = { name: "wf", phases: [{ id: "p", agent: "t", task: "do work" }] };
	const agents: AgentConfig[] = [
		{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
	];
	const mkState = (): RunState => ({
		runId: "flow-abc-failopen",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: 0,
		updatedAt: 0,
		cwd: dir,
	});
	const run = async (transcriptDir: string, agentDir: string) => {
		const restoreTmux = setTmuxEnv(tmux.bin, agentDir);
		try {
			return await executeTaskflow(mkState(), {
				cwd: dir,
				agents,
				runTask: runAgentTask,
				transcriptDir,
			});
		} finally {
			restoreTmux();
		}
	};
	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	process.env.PI_TASKFLOW_PI_BIN = fakePi;
	try {
		// Windows on, but every tmux call fails.
		const failing = await run(path.join(dir, "run-failing"), agentDirWithSetting(dir, true));
		// Windows off: the baseline this run must be identical to.
		const disabled = await run(path.join(dir, "run-disabled"), agentDirWithSetting(dir, false));

		assert.ok(tmux.invocations().length >= 1, "tmux was tried (and failed) in the windows-on run");
		assert.equal(failing.ok, disabled.ok, "a failing tmux does not change the run's verdict");
		assert.deepEqual(
			stablePhases(failing.state.phases),
			stablePhases(disabled.state.phases),
			"phase results are identical to a run with windows disabled",
		);
		assert.deepEqual(
			failing.state.phases.p.warnings,
			[WORKER_WINDOW_UNAVAILABLE_WARNING],
			"the unavailable window is reported as a phase warning",
		);
		assert.equal(disabled.state.phases.p.warnings, undefined, "a disabled window warns about nothing");
		assert.equal(failing.state.phases.p.status, "done", "the worker's own result is unaffected");
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		forgetWorkerWindows();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
