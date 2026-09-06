import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSteerMessage, type RunState } from "taskflow-core";
import { runAgentTask } from "../src/runner.ts";
import type { AgentConfig } from "taskflow-core";
import { startSteerWatcher } from "../src/steer-watch.ts";
import { InspectorComponent, isSteerable } from "../src/inspector-view.ts";
import { steerNodeIds } from "../src/index.ts";
import { clearActiveRun, getActiveRun, setActiveRun } from "../src/active-run.ts";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tf-steer-host-"));
}

function mkRun(phases: RunState["phases"], phaseIds: string[]): RunState {
	return {
		runId: "flow-abc-1",
		flowName: "demo",
		status: "running",
		createdAt: 1000,
		updatedAt: 1000,
		cwd: "/tmp",
		def: { name: "demo", phases: phaseIds.map((id) => ({ id, agent: "a", task: "t" })) } as any,
		phases,
		args: {},
	} as RunState;
}

// ── child-side watcher ──────────────────────────────────────────────

test("steer watcher: delivers appended messages once, in order", async () => {
	const dir = tmpDir();
	try {
		const file = path.join(dir, "node.jsonl");
		const delivered: string[] = [];
		const stop = startSteerWatcher({ file, deliver: (t) => delivered.push(t), pollMs: 20 });
		try {
			appendSteerMessage(file, "first");
			appendSteerMessage(file, "second");
			await new Promise((r) => setTimeout(r, 120));
			assert.deepEqual(delivered, ["first", "second"]);

			appendSteerMessage(file, "third");
			await new Promise((r) => setTimeout(r, 120));
			assert.deepEqual(delivered, ["first", "second", "third"], "no re-delivery of consumed lines");
		} finally {
			stop();
		}
		appendSteerMessage(file, "after dispose");
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(delivered.length, 3, "a disposed watcher delivers nothing");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("steer watcher: a throwing deliver does not stop later messages", async () => {
	const dir = tmpDir();
	try {
		const file = path.join(dir, "node.jsonl");
		const delivered: string[] = [];
		const stop = startSteerWatcher({
			file,
			deliver: (t) => {
				if (t === "boom") throw new Error("session gone");
				delivered.push(t);
			},
			pollMs: 20,
		});
		try {
			appendSteerMessage(file, "boom");
			appendSteerMessage(file, "ok");
			await new Promise((r) => setTimeout(r, 120));
			assert.deepEqual(delivered, ["ok"]);
		} finally {
			stop();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── runner injection ────────────────────────────────────────────────

test("runAgentTask: steerFile injects the child extension, env, and folds queued messages into the task", async () => {
	const dir = tmpDir();
	const capture = path.join(dir, "capture.json");
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fakePi,
		`import * as fs from "node:fs";\n` +
			`const argv = process.argv.slice(2);\n` +
			`fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({\n` +
			`  hasExtension: argv.includes("--extension"),\n` +
			`  prompt: argv[argv.length - 1],\n` +
			`  steerFile: process.env.PI_TASKFLOW_STEER_FILE ?? null,\n` +
			`  steerOffset: process.env.PI_TASKFLOW_STEER_OFFSET ?? null,\n` +
			`  ctxDir: process.env.PI_TASKFLOW_CTX_DIR ?? null,\n` +
			`  nodeId: process.env.PI_TASKFLOW_NODE_ID ?? null,\n` +
			`}));\n` +
			`process.exit(0);\n`,
	);
	const shim = path.join(dir, "shim.sh");
	fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`);
	fs.chmodSync(shim, 0o755);

	const prevBin = process.env.PI_TASKFLOW_PI_BIN;
	const prevExt = process.env.PI_TASKFLOW_EXT_PATH;
	process.env.PI_TASKFLOW_PI_BIN = shim;
	process.env.PI_TASKFLOW_EXT_PATH = fakePi;
	try {
		const agents: AgentConfig[] = [
			{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" },
		];
		const steerFile = path.join(dir, "steer", "p.jsonl");
		appendSteerMessage(steerFile, "also check the RPC path");

		await runAgentTask(dir, agents, "t", "do work", { steerFile });
		const on = JSON.parse(fs.readFileSync(capture, "utf-8"));
		assert.equal(on.steerFile, steerFile, "steer file passed to the child");
		assert.equal(on.ctxDir, null, "steering does not imply context sharing");
		assert.equal(on.nodeId, null, "ctx identity is not injected for steering alone");
		assert.equal(on.hasExtension, true, "child loads taskflow's extension to run the watcher");
		assert.match(on.prompt, /do work/);
		assert.match(on.prompt, /also check the RPC path/, "queued message folded into the task");
		assert.ok(Number(on.steerOffset) > 0, "offset skips the message already folded in");

		// No steering requested → nothing injected.
		fs.rmSync(capture, { force: true });
		await runAgentTask(dir, agents, "t", "do work", {});
		const off = JSON.parse(fs.readFileSync(capture, "utf-8"));
		assert.equal(off.steerFile, null);
		assert.equal(off.hasExtension, false);
	} finally {
		if (prevBin === undefined) delete process.env.PI_TASKFLOW_PI_BIN;
		else process.env.PI_TASKFLOW_PI_BIN = prevBin;
		if (prevExt === undefined) delete process.env.PI_TASKFLOW_EXT_PATH;
		else process.env.PI_TASKFLOW_EXT_PATH = prevExt;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ── host wiring ─────────────────────────────────────────────────────

test("active run: published while running, cleared only by its own state", () => {
	const a = mkRun({}, ["p"]);
	const b = mkRun({}, ["p"]);
	setActiveRun(a, "/tmp", "/tmp/steer");
	assert.equal(getActiveRun()?.state, a);
	clearActiveRun(b); // a nested sub-flow finishing must not unpublish the parent
	assert.equal(getActiveRun()?.state, a);
	clearActiveRun(a);
	assert.equal(getActiveRun(), undefined);
});

test("steerNodeIds: fans out to every map item node", () => {
	const state = mkRun(
		{
			single: { id: "single", status: "running" },
			many: { id: "many", status: "running", subProgress: { done: 0, total: 3, running: 3, failed: 0 } },
		},
		["single", "many"],
	);
	assert.deepEqual(steerNodeIds(state, "single"), ["single"]);
	assert.deepEqual(steerNodeIds(state, "many"), ["many", "many-0", "many-1", "many-2"]);
});

// ── inspector ───────────────────────────────────────────────────────

test("inspector: only unfinished phases are steerable", () => {
	assert.equal(isSteerable({ id: "p", status: "running" }), true);
	assert.equal(isSteerable({ id: "p", status: "pending" }), true);
	assert.equal(isSteerable(undefined), true, "a phase with no state yet is pending");
	assert.equal(isSteerable({ id: "p", status: "done" }), false);
	assert.equal(isSteerable({ id: "p", status: "failed" }), false);
});

test("inspector: detail shows the activity history and Enter/Esc navigate", () => {
	const state = mkRun(
		{ p: { id: "p", status: "running", liveLog: ["read a.ts", "$ npm test"], model: "haiku" } },
		["p"],
	);
	let result: unknown = "unset";
	const view = new InspectorComponent(state, theme, (r) => { result = r; }, true);
	try {
		assert.ok(view.render(80).join("\n").includes("Taskflow demo"), "list view first");
		view.handleInput("\r"); // Enter → detail
		const detail = view.render(80).join("\n");
		assert.match(detail, /read a\.ts/);
		assert.match(detail, /npm test/);
		assert.match(detail, /s steer/);

		view.handleInput("s");
		assert.deepEqual(result, { action: "steer", phaseId: "p" });

		result = "unset";
		view.handleInput("\x1b"); // Esc → back to list, not closed
		assert.equal(result, "unset");
		assert.ok(view.render(80).join("\n").includes("Taskflow demo"));
	} finally {
		view.dispose();
	}
});

test("inspector: steering a finished phase, or without a channel, does nothing", () => {
	const done = mkRun({ p: { id: "p", status: "done", output: "x" } }, ["p"]);
	let result: unknown = "unset";
	const withChannel = new InspectorComponent(done, theme, (r) => { result = r; }, true);
	withChannel.handleInput("s");
	assert.equal(result, "unset", "a finished phase has no subagent to steer");
	withChannel.dispose();

	const running = mkRun({ p: { id: "p", status: "running" } }, ["p"]);
	const noChannel = new InspectorComponent(running, theme, (r) => { result = r; }, false);
	noChannel.handleInput("s");
	assert.equal(result, "unset", "no steering channel → no steer request");
	assert.match(noChannel.render(80).join("\n"), /steering unavailable/);
	noChannel.dispose();
});
