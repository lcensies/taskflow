import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../src/agents.ts";
import type { RunOptions } from "../src/runner-core.ts";
import { emptyUsage } from "../src/usage.ts";
import { executeTaskflow, type RuntimeDeps } from "../src/runtime.ts";
import type { Taskflow } from "../src/schema.ts";
import type { RunState } from "../src/store.ts";
import { transcriptFileFor } from "../src/store.ts";

const AGENTS: AgentConfig[] = [
	{ name: "a", description: "test agent", systemPrompt: "", source: "user", filePath: "" },
];

function mkState(def: Taskflow): RunState {
	return {
		runId: "test-run",
		flowName: def.name,
		def,
		args: {},
		status: "running",
		phases: {},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
	};
}

test("transcriptFileFor: a phase id with separators resolves to the path the runtime writes", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-transcript-path-"));
	const def: Taskflow = {
		name: "sanitize-transcript",
		phases: [{ id: "review:api", type: "agent", agent: "a", task: "review", final: true }],
	};
	const transcriptFiles: (string | undefined)[] = [];
	const runTask: RuntimeDeps["runTask"] = async (_cwd, _agents, agentName, task, o: RunOptions) => {
		transcriptFiles.push(o.transcriptFile);
		return { agent: agentName, task, exitCode: 0, output: "ok", stderr: "", usage: emptyUsage(), stopReason: "end" };
	};
	const deps: RuntimeDeps = { cwd: "/tmp", agents: AGENTS, runTask, transcriptDir: dir, persist: () => {}, onProgress: () => {} };
	try {
		const res = await executeTaskflow(mkState(def), deps);
		assert.equal(res.ok, true);
		// A reader that only knows the phase id must land on the file the runtime wrote.
		assert.deepEqual(transcriptFiles, [transcriptFileFor(dir, "review:api")]);
		assert.equal(transcriptFileFor(dir, "review:api"), path.join(dir, "review_api.ndjson"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("transcriptFileFor: traversal in a node id stays inside the transcript dir", () => {
	const dir = path.join(os.tmpdir(), "tf-transcript-guard");
	const file = transcriptFileFor(dir, "../x");
	assert.equal(path.dirname(file), dir);
	assert.ok(path.resolve(file).startsWith(`${path.resolve(dir)}${path.sep}`));
	assert.throws(() => transcriptFileFor(dir, ".."), /Unsafe nodeId/);
	assert.throws(() => transcriptFileFor(dir, "."), /Unsafe nodeId/);
	assert.throws(() => transcriptFileFor(dir, ""), /Unsafe nodeId/);
});
