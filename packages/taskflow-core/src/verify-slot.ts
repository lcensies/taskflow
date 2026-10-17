/**
 * Flow-level `verify` slot — the reviewer/fixer loop + black-box tester that
 * every implementation flow gets unless it opts out.
 *
 *   verify: undefined   → canonical tail appended when impl agents are present
 *   verify: { ...opts } → canonical tail with options (testCmd, specs, harness…)
 *   verify: Phase[]     → author's own tail; phases without dependsOn hang off
 *                         the terminal phases of `phases`
 *   verify: false       → opt out
 *
 * `expandVerify` is the single desugar step; hosts call it right after a
 * definition is resolved (inline / defineFile / saved) and before validate.
 * It is idempotent: the expanded flow carries `verify: []`.
 *
 * The canonical tail is a verbatim port of the `tail_phases` compiler that
 * used to live in the openspec-taskflow skill (python). Prompts are data; keep
 * them here, not in the runtime.
 */

import { dependenciesOf, type Phase, type Taskflow } from "./schema.ts";
import type { VerificationIssue } from "./verify.ts";

export interface VerifyTailOptions {
	/** Full test command; `build` script phase emits BUILD_OK on success. Omitted → no build phase. */
	testCmd?: string;
	/** Spec / task files the lenses and operator read (pre-read via `context`). */
	specs?: string[];
	/** Design / rationale files only the white-box lenses see (never the operator). */
	design?: string[];
	/** Where the arbiter writes FINDINGS.md between rounds. Default `.pi/taskflows`. */
	findingsDir?: string;
	/** Shell command starting the system under test; last stdout line is JSON. Needs `harnessDown`. */
	harnessUp?: string;
	/** Idempotent shell command stopping the system. */
	harnessDown?: string;
	/** Shell command replaying the frozen e2e corpus; last stdout line JSON {passed,failed,errors}. */
	replay?: string;
	/** Add the runtime red-team lens (off by default: trips provider content filters). */
	redteam?: boolean;
	/** Max fix/verdict rounds before the tail ends blocked. Default 2. */
	rounds?: number;
	/** Agent overrides. */
	fixer?: string;
	operator?: string;
}

export type VerifySlot = false | Phase[] | VerifyTailOptions;

/** Phases whose agent writes code: the presence of any of these means the flow needs a tail. */
export const IMPL_AGENT_RE = /^(executor(-[a-z]+)?|test-engineer)$/;

export const VERIFY_TAIL_IDS = {
	fix: "fix",
	fixHarness: "fix-harness",
	build: "build",
	harnessUp: "harness-up",
	replay: "replay",
	operator: "exercise-operator",
	redteam: "exercise-redteam",
	harnessDown: "harness-down",
	verdict: "verdict",
	report: "report",
} as const;

const FIXER_AGENT = "executor-expert";
const HARNESS_FIXER_AGENT = "executor-fast";
const OPERATOR_AGENT = "blackbox-operator";
const REDTEAM_AGENT = "edge-func-checker";
const ARBITER_AGENT = "final-arbiter";

// White-box review lenses: siblings off `build` (or `harness-down`), each reads
// the diff + specs and emits one JSON line. Split by the reviewer routing
// (reviewer defers security/risk to the specialists).
const REVIEW_LENSES: ReadonlyArray<readonly [id: string, agent: string, focus: string]> = [
	[
		"spec-review",
		"reviewer",
		"spec conformance: unmet requirements and scenarios, scope creep, missing tests the " +
			"spec calls for, and DOMAIN consistency - the same rule/term/invariant implemented " +
			"differently in two places, naming or units that contradict the spec",
	],
	[
		"risk-review",
		"risk-reviewer",
		"edge cases and failure modes on the paths the spec covers: boundary inputs, empty/None, " +
			"error handling, concurrency, idempotency, state transitions, data integrity, silent " +
			"corruption, regressions of previously working behaviour",
	],
	[
		"security-review",
		"security-reviewer",
		"security at trust boundaries: injection, authn/authz, secrets, unsafe fs/network, " +
			"insecure defaults, dependency risk",
	],
	[
		"quality-review",
		"reviewer",
		"architecture and code quality of the ADDED code only: duplication of helpers that already " +
			"exist in the repo, unrequested abstraction (interface with one impl, config for a " +
			"constant), dead code, review-history comments, net growth a smaller diff would avoid. " +
			"These are almost never blocking - rate them major/minor",
	],
];

// Shared severity contract. Only `blocking` drives another fix round; without a
// floor the loop chases nits, and each fix round adds code for the next round
// to find nits in.
const SEVERITY_RULES =
	"Severity contract (fixed, do not invent levels): `blocking` ONLY for (a) a violation of a " +
	"spec requirement or `#### Scenario` you can cite by file+heading, (b) build/test failure, " +
	"(c) data loss or corruption, (d) an exploitable security issue at a trust boundary, " +
	"(e) a regression: previously working behaviour the diff breaks. `major` = a real defect " +
	"with a concrete repro that fits none of a-e. `minor` = style, naming, duplication, " +
	"structure, hypothetical edge cases with no repro. When unsure, it is NOT blocking. " +
	"`blocking` in the JSON is the COUNT of blocking-severity findings. Every finding cites " +
	"evidence (file:line you read, or spec heading); no evidence, no finding. ";

const REVIEW_SCHEMA =
	'Output ONLY JSON {"findings":[{"severity":"blocking|major|minor","category":"",' +
	'"file":"","line":0,"issue":"","evidence":"","fix":""}],"blocking":0}.';

const REVIEW_EXPECT = {
	type: "object",
	required: ["findings", "blocking"],
	properties: { findings: { type: "array" }, blocking: { type: "number" } },
};

/** Upstream task text quoted into a tail prompt must not read as a live ref. */
function escapeLiteralRefs(text: string): string {
	return text.replace(/\{(steps|args|item|previous)\./g, "{\u200b$1.");
}

/** The implementation phases' own task texts, so lenses have a spec to review
 *  against even when no spec files are wired. */
function implBrief(phases: Phase[]): string {
	const lines = phases
		.filter((p) => typeof p.task === "string" && p.task.trim())
		.map((p) => `### ${p.id}\n${escapeLiteralRefs(p.task!.trim()).slice(0, 2000)}`);
	return lines.length ? `Implementation phases this run executed (their task text IS the spec when no spec files are in context):\n${lines.join("\n\n")}\n\n` : "";
}

/** Build the canonical tail. `terminals` are the phases the tail hangs off. */
export function canonicalVerifyTail(terminals: string[], implPhases: Phase[], o: VerifyTailOptions = {}): Phase[] {
	const I = VERIFY_TAIL_IDS;
	const findingsDir = o.findingsDir ?? ".pi/taskflows";
	const findings = `${findingsDir}/FINDINGS.md`;
	const findingsPrev = `${findingsDir}/FINDINGS.prev.md`;
	const harness = Boolean(o.harnessUp && o.harnessDown);
	const rounds = o.rounds ?? 2;
	const specs = o.specs ?? [];
	const contextSpecs = specs;
	const contextAll = [...specs, ...(o.design ?? [])];
	const brief = implBrief(implPhases);
	const fixer = o.fixer ?? FIXER_AGENT;
	const operator = o.operator ?? OPERATOR_AGENT;

	const phases: Phase[] = [
		{
			id: I.fix,
			type: "agent",
			agent: fixer,
			dependsOn: [...terminals],
			task:
				`Read ${findings} if it exists. If missing or empty, reply NOOP without ` +
				"changing anything. Otherwise fix ONLY the items under `## BLOCKING` and `## DESIGN`. " +
				"`## Deferred` and `## Unverifiable` are not yours: do not fix them, do not fix " +
				"anything else you notice on the way - every unrequested edit is fresh surface for " +
				"the next review round. Before editing, read the WHOLE function/module a finding " +
				`points at (not just the cited line) and ${findingsPrev} if present (last round's ` +
				"list). Decide per item and say which in your report: a local fix (wrong default, " +
				"missing guard/await, one-line logic) is a patch; a fix that would add another " +
				"branch to a path that was already patched last round, or anything under " +
				"`## DESIGN`, is a rewrite of that unit from the spec. Growth guard: prefer " +
				"deleting or reusing an existing helper over adding; no new files, modules, " +
				"helpers, config knobs or abstractions unless the cited spec line requires them; " +
				"if your diff is larger than the function you are fixing, stop and reconsider. " +
				"Never widen behaviour outside the finding's unit to satisfy a lens (making a node " +
				"act on state the request did not carry, changing pipeline semantics): if no spec " +
				"line asks for it, leave the code and report a spec gap. Delete review-history " +
				"narration comments you encounter; keep comments that state constraints. " +
				"Report the files you changed, net lines added/removed, and per item: patch or rewrite.",
		},
		{
			id: I.fixHarness,
			type: "agent",
			agent: HARNESS_FIXER_AGENT,
			dependsOn: [...terminals],
			optional: true,
			task:
				`Read ${findings} if it exists. If it has no 'Unverifiable' section, reply ` +
				"NOOP. Otherwise close each listed harness gap by extending tests/harness/ " +
				"(fakes, harness.py methods, compose overrides, README) and, when the gap " +
				"was 'no test', adding the pytest to tests/e2e/. Additive only: never change " +
				"an existing method or test's signature/semantics. Do not touch application " +
				"source. Report the files you changed.",
		},
	];
	const verdictDeps: string[] = [I.fix];
	let reviewDeps: string[] = [I.fix, I.fixHarness];
	let buildBlock = "";
	const evalTerms: string[] = [];

	if (o.testCmd) {
		phases.push({
			id: I.build,
			type: "script",
			run: `set -o pipefail; ( ${o.testCmd} ) && echo BUILD_OK`,
			timeout: 300000,
			optional: true,
			dependsOn: [I.fix, I.fixHarness],
		});
		verdictDeps.push(I.build);
		reviewDeps = [I.build];
		buildBlock = `BUILD:\n{steps.${I.build}.output}\n\n`;
		evalTerms.push(`{steps.${I.build}.output} contains BUILD_OK`);
	}

	let operatorDeps = [...reviewDeps];
	let harnessLine = "";
	let replayLine = "";
	if (harness) {
		phases.push({
			id: I.harnessUp,
			type: "script",
			run: o.harnessUp!,
			timeout: 300000, // host max; up must background long builds (tmux + done-file)
			...(o.testCmd ? { when: `{steps.${I.build}.output} contains BUILD_OK` } : {}),
			dependsOn: [...reviewDeps],
		});
		operatorDeps = [I.harnessUp];
		harnessLine = `Harness: {steps.${I.harnessUp}.output}\n`;
		if (o.replay) {
			phases.push({
				id: I.replay,
				type: "script",
				run: o.replay,
				timeout: 300000,
				optional: true,
				dependsOn: [I.harnessUp],
			});
			operatorDeps = [I.harnessUp, I.replay];
			replayLine = `Replay of tests/e2e (last line JSON: passed/failed/errors):\n{steps.${I.replay}.output}\n`;
		}
	}

	// Operator is always present: with a harness it exercises the running
	// system; without one it black-boxes the change through its public surface.
	phases.push({
		id: I.operator,
		type: "agent",
		agent: operator,
		dependsOn: operatorDeps,
		context: contextSpecs.length ? contextSpecs : undefined,
		output: "json",
		expect: {
			type: "object",
			required: ["scenarios", "all_pass", "spec_gaps"],
			properties: { scenarios: { type: "array" }, all_pass: { type: "boolean" }, spec_gaps: { type: "array" } },
		},
		retry: { max: 1 },
		timeout: 1200000,
		task:
			harnessLine +
			replayLine +
			(harness
				? "Black-box exercise the running system against the specs and tasks in context. "
				: "No harness is wired: black-box the change through its public surface only (CLI, " +
					"tests, API, built artifact) against the specs/tasks in context and the brief below. ") +
			brief +
			"Reading implementation source is forbidden. A build/launch " +
			"failure is itself a finding. Derive scenarios from every `#### Scenario` (or from the " +
			"brief when no spec files are in context); skip those already in replay.passed. " +
			"Explore in the execute kernel (Harness preloaded) when available, then freeze each " +
			"verified scenario as a test per your contract. " +
			'Output ONLY JSON {"scenarios":[{"name":"","expected":"","actual":"",' +
			'"pass":true,"test":""}],"all_pass":true,"spec_gaps":[],"unverifiable":[],' +
			'"harness_changes":[]}.',
	});
	verdictDeps.push(...(harness ? [I.harnessUp, ...(o.replay ? [I.replay] : [])] : []), I.operator);
	evalTerms.push(`{steps.${I.operator}.json.all_pass} == true`);
	if (harness && o.replay) evalTerms.push(`{steps.${I.replay}.json.failed} == 0`);

	if (harness && o.redteam) {
		phases.push({
			id: I.redteam,
			type: "agent",
			agent: REDTEAM_AGENT,
			dependsOn: [I.harnessUp],
			context: contextSpecs.length ? contextSpecs : undefined,
			output: "json",
			expect: {
				type: "object",
				required: ["attempts", "critical", "high"],
				properties: { attempts: { type: "array" }, critical: { type: "number" }, high: { type: "number" } },
			},
			retry: { max: 1 },
			timeout: 1200000,
			task:
				harnessLine +
				"Runtime-attack the system per the specs and tasks in context. Reading " +
				"implementation source is forbidden. A build/launch failure is itself a " +
				'finding. Output ONLY JSON {"attempts":[{"name":"","vector":"","result":"",' +
				'"severity":"critical|high|medium|low|info"}],"critical":0,"high":0}.',
		});
		verdictDeps.push(I.redteam);
		evalTerms.push(`{steps.${I.redteam}.json.critical} == 0`);
	}

	if (harness) {
		phases.push({
			id: I.harnessDown,
			type: "script",
			run: o.harnessDown!,
			timeout: 60000,
			optional: true,
			join: "any",
			dependsOn: [I.operator, ...(o.redteam ? [I.redteam] : [])],
		});
		verdictDeps.push(I.harnessDown);
		reviewDeps = [I.harnessDown];
	}

	for (const [lensId, agent, focus] of REVIEW_LENSES) {
		phases.push({
			id: lensId,
			type: "agent",
			agent,
			dependsOn: [...reviewDeps],
			context: contextAll.length ? contextAll : undefined,
			output: "json",
			expect: REVIEW_EXPECT,
			retry: { max: 1 },
			task:
				"Run `git diff` and review it adversarially against the spec/design/tasks files " +
				`in context. Your lens, and ONLY this lens (siblings cover the rest): ${focus}. ` +
				brief +
				SEVERITY_RULES +
				"Read the whole unit around a hunk before judging it, not just the hunk. " +
				REVIEW_SCHEMA,
		});
		verdictDeps.push(lensId);
		evalTerms.push(`{steps.${lensId}.json.blocking} == 0`);
	}

	phases.push({
		id: I.verdict,
		type: "gate",
		agent: ARBITER_AGENT,
		onBlock: "retry",
		retry: { max: rounds },
		dependsOn: verdictDeps,
		eval: evalTerms,
		tools: ["write", "bash"],
		task:
			"Lens results:\n" +
			buildBlock +
			(harness && o.replay ? `REPLAY (tests/e2e):\n{steps.${I.replay}.output}\n\n` : "") +
			`EXERCISE (operator JSON):\n{steps.${I.operator}.output}\n\n` +
			(harness && o.redteam ? `EXERCISE (edge JSON):\n{steps.${I.redteam}.output}\n\n` : "") +
			REVIEW_LENSES.map(([id]) => `${id.toUpperCase()} (JSON):\n{steps.${id}.output}\n\n`).join("") +
			"Merge these lens results. Dedupe (same file+issue from two lenses is one finding), " +
			"drop false positives (a harness/fixture limitation is NOT a code defect - list it " +
			"under a final '## Unverifiable' section with the missing harness capability instead). " +
			SEVERITY_RULES +
			"Re-grade every lens finding against that contract yourself; lenses over-rate. " +
			"Do not re-derive from source; you have no read tool on purpose - judge only the " +
			`evidence above. Convergence rule: if ${findingsPrev} exists (bash: cat it) this is ` +
			"round 2+, and a finding may be blocking ONLY if it was blocking there too, or is a " +
			"regression in a unit the last fix round changed, or is a build/replay/operator " +
			"failure, or an exploitable security issue. Anything else newly surfaced is Deferred, " +
			"however real - the blocking set must shrink every round, never grow. Recurrence: a " +
			"file/function blocking in both rounds goes first under `## DESIGN` with the round " +
			"history - the fixer treats that as 'rewrite this unit', not 'patch again'. " +
			`Before writing a new FINDINGS.md, \`mkdir -p ${findingsDir} && mv ${findings} ${findingsPrev}\` if it exists. ` +
			`If nothing is blocking: run \`rm -f ${findings}\`, list the major/minor items under ` +
			"`## Deferred` in your reply for the human, and respond VERDICT: PASS. Otherwise: " +
			`write ${findings} (use the write tool) with sections in this order: \`## DESIGN\`, ` +
			"`## BLOCKING`, `## Deferred` (major+minor, never fixed by the loop), `## Unverifiable` " +
			"(each item: severity, source lens, file:line or repro, required fix), then respond " +
			"VERDICT: BLOCK. The file MUST exist on disk before you answer BLOCK.",
	});

	phases.push({
		id: I.report,
		type: "reduce",
		from: [I.verdict],
		dependsOn: [I.verdict],
		agent: "doc-writer",
		task:
			"Summarize the verification tail outcome: rounds used, final verdict, files " +
			"changed, and the arbiter's `## Deferred` list verbatim (it is the human's backlog; " +
			"the loop deliberately did not fix it).",
		final: true,
	});

	// Drop undefined `context` so the schema's additionalProperties/optional checks stay clean.
	for (const p of phases) if (p.context === undefined) delete p.context;
	return phases;
}

/** Phase ids nothing else depends on. */
export function terminalPhaseIds(phases: Phase[]): string[] {
	const depended = new Set<string>();
	for (const p of phases) for (const d of dependenciesOf(p)) depended.add(d);
	return phases.filter((p) => !depended.has(p.id)).map((p) => p.id);
}

export function hasImplAgents(phases: Phase[]): boolean {
	return phases.some(
		(p) =>
			(typeof p.agent === "string" && IMPL_AGENT_RE.test(p.agent)) ||
			(Array.isArray(p.branches) && p.branches.some((b) => typeof b?.agent === "string" && IMPL_AGENT_RE.test(b.agent))),
	);
}

/** True when `phases` already carry a review gate of their own (any `gate`:
 *  a halting reviewer is a deliberate shape, not a missing tail). */
export function hasVerifyGate(phases: Phase[]): boolean {
	return phases.some((p) => p.type === "gate");
}

/**
 * Resolve the `verify` slot into plain phases. Returns a new definition with
 * `verify: false` (so a second call is a no-op). Pure; throws on id collision.
 */
export function expandVerify(def: Taskflow): Taskflow {
	const slot = def.verify as VerifySlot | undefined;
	if (slot === false) return def;
	const phases = Array.isArray(def.phases) ? def.phases.filter((p) => p && typeof p === "object") : [];
	if (!phases.length) return def;

	let tail: Phase[];
	if (Array.isArray(slot)) {
		const terminals = terminalPhaseIds(phases);
		tail = slot.map((p) => (p.dependsOn?.length || p.from?.length ? p : { ...p, dependsOn: [...terminals] }));
	} else {
		if (!hasImplAgents(phases) || hasVerifyGate(phases)) return def;
		tail = canonicalVerifyTail(terminalPhaseIds(phases), phases, slot ?? {});
	}

	const ids = new Set(phases.map((p) => p.id));
	for (const p of tail) {
		if (ids.has(p.id)) throw new Error(`verify: tail phase id '${p.id}' collides with an existing phase — rename it or pass verify:[...] / verify:false`);
	}
	// The tail's report is the result; an impl phase marked final would be a
	// second final (validation error) and the wrong answer anyway.
	const tailHasFinal = tail.some((p) => p.final);
	const body = phases.map((p) => {
		if (!tailHasFinal || !p.final) return p;
		const { final: _final, ...rest } = p;
		return rest as Phase;
	});
	// `[]` marks an expanded flow: re-expanding appends nothing, and the
	// verify-tail detector still runs (only `false` silences it).
	return { ...def, phases: [...body, ...tail], verify: [] };
}

/** Built-in detector: impl agents without a self-healing review loop. */
export function detectMissingVerifyTail(flow: { phases: Phase[]; verify?: unknown }): VerificationIssue[] {
	if (flow.verify === false) return [];
	if (!hasImplAgents(flow.phases) || hasVerifyGate(flow.phases)) return [];
	return [
		{
			category: "verify-tail",
			severity: "error",
			message:
				"flow has implementation agents but no verification tail (no `gate` phase). " +
				"Omit `verify` to get the canonical reviewer/fixer loop + black-box tester, pass `verify: [...]` " +
				"with your own loop, or `verify: false` to opt out.",
		},
	];
}
