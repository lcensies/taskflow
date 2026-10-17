/**
 * Pi host live persistence, foreground and detached: a fan-out's indexed item
 * state reaches disk while the phase is in flight, a quiet update is flushed,
 * and failed intermediate writes neither crash the run nor change its result.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isProcessAlive, listRuns, loadRun, runsDir, type RunState } from "taskflow-core";

const extension = (await import("../src/index.ts")).default;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = probe();
		if (v !== undefined) return v;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const fanoutItems = (run: RunState | null | undefined) => run && Object.values(run.phases).find((p) => p.items)?.items;

/** Fake `pi`: FAST_ITEM finishes at once; SLOW_ITEM reports activity, emits one
 *  more message when the poke file appears, then stays quiet until release. */
const FAKE_PI =
	`import fs from "node:fs";\n` +
	`const emit = (x) => process.stdout.write(JSON.stringify(x) + "\\n");\n` +
	`const usage = (cacheRead) => ({ input: 10, output: 5, cacheRead, cacheWrite: 0, totalTokens: 15 + cacheRead, cost: { total: 0.00002 } });\n` +
	`const message = (text, stopReason) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }, ...(stopReason === "toolUse" ? [{ type: "toolCall", id: text, name: "read", arguments: {} }] : [])], usage: usage(100), stopReason } });\n` +
	`const finish = (text) => { message(text, "stop"); emit({ type: "agent_end" }); emit({ type: "agent_settled" }); process.exit(0); };\n` +
	`emit({ type: "agent_start" }); emit({ type: "turn_start" });\n` +
	`if (!process.argv.at(-1).includes("SLOW_ITEM")) finish("FAST_DONE");\n` +
	`message("scanning", "toolUse");\n` +
	`let poked = false;\n` +
	`const t = setInterval(() => {\n` +
	`  if (!poked && fs.existsSync(process.env.TF_TEST_POKE)) { poked = true; message("poked", "toolUse"); }\n` +
	`  if (fs.existsSync(process.env.TF_TEST_RELEASE)) { clearInterval(t); finish("SLOW_DONE"); }\n` +
	`}, 25);\n`;

async function exerciseLivePersistence(detach: boolean): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-live-persist-"));
	const cwd = path.join(dir, "proj");
	const agentDir = path.join(dir, "agent");
	const release = path.join(dir, "release");
	const poke = path.join(dir, "poke");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: test\n---\nwork\n");
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(fakePi, `#!${process.execPath}\n${FAKE_PI}`);
	fs.chmodSync(fakePi, 0o755);

	const env: Record<string, string> = {
		PI_TASKFLOW_PI_BIN: fakePi,
		TASKFLOW_AGENT_DIR: agentDir,
		TF_TEST_RELEASE: release,
		TF_TEST_POKE: poke,
		// The detached runner child resolves workspace packages from source.
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=development`.trim(),
	};
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	let pending: Promise<any> | undefined;
	let runFile: string | undefined;
	let detachedPid: number | undefined;
	try {
		let tool: any;
		extension({
			registerTool: (t: any) => { if (t.name === "taskflow") tool = t; },
			registerCommand: () => {},
			on: () => {},
			sendUserMessage: () => {},
		} as any);
		const ctx = { cwd, hasUI: false, ui: { notify: () => {}, setStatus: () => {} }, sessionManager: { getSessionId: () => "s1" } };
		pending = tool.execute("id", {
			action: "run",
			detach,
			tasks: [{ agent: "worker", task: "SLOW_ITEM" }, { agent: "worker", task: "FAST_ITEM" }],
		}, undefined, undefined, ctx);
		if (detach) {
			const text: string = (await pending).content[0].text;
			detachedPid = Number(text.match(/pid: (\d+)/)?.[1]) || undefined;
			assert.match(text, /started in background/);
		}

		// Item 1 finishes before item 0 while no other checkpoint occurs.
		const inFlight = await waitFor(() => {
			const run = listRuns(cwd, 5)[0];
			const disk = run && loadRun(cwd, run.runId);
			const items = fanoutItems(disk);
			return disk && items?.[1]?.status === "done" && items[0]?.status === "running" && items[0].liveText ? disk : undefined;
		}, "in-flight item state on disk");
		const item = fanoutItems(inFlight)![0];
		assert.equal(inFlight.status, "running");
		assert.equal(inFlight.detached === true, detach);
		assert.equal(item.usage?.cacheRead, 100, "running item usage persisted");
		assert.match(item.liveText!, /scanning|read/);

		// Fault window > 2 ticks: the run record is a directory, so every save
		// attempted in it (the poke makes one due) fails on rename.
		runFile = path.join(runsDir(cwd), inFlight.flowName, `${inFlight.runId}.json`);
		fs.rmSync(runFile);
		fs.mkdirSync(runFile);
		fs.writeFileSync(poke, "");
		await sleep(2_500);
		assert.ok(fs.statSync(runFile).isDirectory(), "no intermediate write succeeded");
		fs.rmdirSync(runFile);
		runFile = undefined;

		// The quiet poke update still lands, and the run keeps going.
		const recovered = await waitFor(() => {
			const disk = loadRun(cwd, inFlight.runId);
			return disk?.status === "running" && /poked/.test(fanoutItems(disk)?.[0]?.liveText ?? "") ? disk : undefined;
		}, "quiet update after the failed writes");
		assert.equal(fanoutItems(recovered)![1].status, "done");

		fs.writeFileSync(release, "");
		if (!detach) {
			const result = await pending;
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /SLOW_DONE/);
			assert.match(result.content[0].text, /FAST_DONE/);
		}
		const final = await waitFor(() => {
			const disk = loadRun(cwd, inFlight.runId);
			return disk?.status === "running" ? undefined : disk ?? undefined;
		}, "terminal state");
		assert.equal(final.status, "completed", "terminal save stays authoritative");
		assert.deepEqual(fanoutItems(final)!.map((i) => i.status), ["done", "done"]);
		assert.match(final.finalOutput ?? "", /SLOW_DONE/);
	} finally {
		// Never leave the fake pi (or a detached runner) waiting on release.
		if (runFile) fs.rmSync(runFile, { recursive: true, force: true });
		fs.writeFileSync(release, "");
		await pending?.catch(() => {});
		if (detachedPid) {
			const exited = () => (isProcessAlive(detachedPid!) ? undefined : true);
			// SIGTERM aborts the run, and the runner reaps its fake pi children.
			await waitFor(exited, "detached exit").catch(() => {
				process.kill(detachedPid!, "SIGTERM");
				return waitFor(exited, "detached abort");
			}).catch(() => {});
		}
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("pi foreground: in-flight indexed items reach disk; failed intermediate writes leave the result unchanged", () =>
	exerciseLivePersistence(false));

test("pi detached: launch opts into live persistence with the same guarantees", () => exerciseLivePersistence(true));
