/**
 * Every host runner forwards `opts.transcriptFile` to `runSubagentProcess`
 * with its host tag: the transcript starts with that host's header and holds
 * the child's raw lines verbatim. Each host runs against a fake CLI that
 * prints a minimal successful stream.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, RunOptions, RunResult } from "taskflow-core";
import { runClaudeAgentTask } from "../src/claude-runner.ts";
import { runCodexAgentTask } from "../src/codex-runner.ts";
import { runGrokAgentTask } from "../src/grok-runner.ts";
import { runOpencodeAgentTask } from "../src/opencode-runner.ts";

type Run = (cwd: string, agents: AgentConfig[], agent: string, task: string, opts: RunOptions) => Promise<RunResult>;

const HOSTS: { host: string; env: Record<string, string>; run: Run; stream: string[] }[] = [
	{
		host: "codex",
		env: { PI_TASKFLOW_CODEX_BIN: "" },
		run: runCodexAgentTask,
		stream: [
			`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"5"}}`,
			`{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}`,
		],
	},
	{
		host: "claude",
		env: { PI_TASKFLOW_CLAUDE_BIN: "" },
		run: runClaudeAgentTask,
		stream: [
			`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
			`{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"done","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}`,
		],
	},
	{
		host: "opencode",
		env: { PI_TASKFLOW_OPENCODE_BIN: "" },
		run: runOpencodeAgentTask,
		stream: [
			`{"type":"text","part":{"id":"p1","type":"text","text":"pong"}}`,
			`{"type":"step_finish","part":{"id":"p2","type":"step-finish","reason":"stop","tokens":{"input":1,"output":1,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}`,
		],
	},
	{
		host: "grok",
		env: { PI_TASKFLOW_GROK_BIN: "", PI_TASKFLOW_GROK_READONLY_SANDBOX_PROFILE: "taskflow-readonly" },
		run: runGrokAgentTask,
		stream: [`{"type":"text","data":"Hello"}`, `{"type":"end","stopReason":"EndTurn","sessionId":"abc"}`],
	},
];

const AGENTS: AgentConfig[] = [{ name: "t", description: "t", systemPrompt: "", source: "user", filePath: "" }];

async function readWhen(file: string, done: (text: string) => boolean): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
		if (done(text)) return text;
		await new Promise((r) => setTimeout(r, 20));
	}
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

for (const { host, env, run, stream } of HOSTS) {
	test(`${host} runner: transcriptFile gets the ${host} header then the raw stream`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tf-${host}-tee-`));
		const bin = path.join(dir, `fake-${host}.mjs`);
		fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stream.join("\n") + "\n")});\n`);
		fs.chmodSync(bin, 0o755);
		const transcriptFile = path.join(dir, "transcripts", "node.ndjson");
		// The empty-valued key is the host's bin override; point it at the fake.
		const vars = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v || bin]));
		const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
		Object.assign(process.env, vars);
		try {
			const result = await run(dir, AGENTS, "t", "do work", {
				transcriptFile,
				idleTimeoutMs: 10_000,
				// Read-only tools pass every host's pre-spawn permission gate.
				tools: ["read"],
			});
			assert.equal(result.exitCode, 0, result.errorMessage ?? result.stderr);
			const text = await readWhen(transcriptFile, (t) => t.includes(stream.at(-1)!));
			assert.deepEqual(text.split("\n").filter(Boolean), [
				JSON.stringify({ type: "taskflow_transcript", host, v: 1 }),
				...stream,
			]);
		} finally {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}
