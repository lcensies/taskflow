/**
 * The taskflow tool's `action="delete"` branch: a stored run by runId, a saved
 * flow by name, the refusals, and the usage error.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { listFlows, loadRun, newRunId, saveFlow, saveRun, type RunState } from "taskflow-core";

const extension = (await import("../src/index.ts")).default;

/** Register the extension and hand back the `taskflow` tool's execute(). */
function taskflowTool() {
	let tool: any;
	const mockPi = {
		registerTool: (t: any) => {
			if (t.name === "taskflow") tool = t;
		},
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
	};
	extension(mockPi as any);
	return (params: any, cwd: string) =>
		tool.execute("id", params, undefined, undefined, { cwd, ui: { notify: () => {} } });
}

function tmpCwd(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-delete-action-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	return dir;
}

function storeRun(cwd: string, status: RunState["status"]): string {
	const runId = newRunId("demo");
	saveRun(
		{
			runId, flowName: "demo", def: { name: "demo", phases: [{ id: "p", task: "t" }] },
			args: {}, status, phases: {}, createdAt: Date.now(), updatedAt: Date.now(), cwd,
		} as RunState,
		{ maxKeep: 0, maxAgeDays: 0 },
	);
	return runId;
}

const text = (r: any): string => r.content[0].text;

test("action=delete: removes a stored run by runId", async () => {
	const cwd = tmpCwd();
	try {
		const exec = taskflowTool();
		const runId = storeRun(cwd, "completed");
		const res = await exec({ action: "delete", runId }, cwd);
		assert.equal(res.isError, undefined);
		assert.match(text(res), /Deleted run/);
		assert.equal(loadRun(cwd, runId), null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("action=delete: refuses a running run and an unknown id", async () => {
	const cwd = tmpCwd();
	try {
		const exec = taskflowTool();
		const live = storeRun(cwd, "running");
		const busy = await exec({ action: "delete", runId: live }, cwd);
		assert.equal(busy.isError, true);
		assert.match(text(busy), /still executing/);
		assert.notEqual(loadRun(cwd, live), null);

		const gone = await exec({ action: "delete", runId: "nope" }, cwd);
		assert.equal(gone.isError, true);
		assert.match(text(gone), /no run with that id/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("action=delete: removes a saved flow by name, unknown name is an error", async () => {
	const cwd = tmpCwd();
	try {
		const exec = taskflowTool();
		saveFlow(cwd, { name: "doomed", phases: [{ id: "p", task: "t" }] }, "project");
		const res = await exec({ action: "delete", name: "doomed" }, cwd);
		assert.match(text(res), /Deleted saved flow/);
		assert.equal(listFlows(cwd).some((f) => f.name === "doomed"), false);

		const missing = await exec({ action: "delete", name: "doomed" }, cwd);
		assert.equal(missing.isError, true);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("action=delete: without runId or name it explains what it needs", async () => {
	const cwd = tmpCwd();
	try {
		const res = await taskflowTool()({ action: "delete" }, cwd);
		assert.equal(res.isError, true);
		assert.match(text(res), /requires either runId .* or name/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
