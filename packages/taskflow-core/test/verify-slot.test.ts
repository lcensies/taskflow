import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTaskflow } from "../src/compile.ts";
import { preflightTaskflow } from "../src/preflight.ts";
import { validateTaskflow, type Phase, type Taskflow } from "../src/schema.ts";
import { verifyTaskflow } from "../src/verify.ts";
import { expandVerify, VERIFY_TAIL_IDS as I } from "../src/verify-slot.ts";

const impl = (id: string, deps?: string[], agent = "executor"): Phase => ({ id, type: "agent", agent, task: `implement ${id}`, dependsOn: deps });

function flow(phases: Phase[], extra: Partial<Taskflow> = {}): Taskflow {
	return { name: "f", phases, ...extra } as Taskflow;
}

const byId = (f: Taskflow) => Object.fromEntries(f.phases.map((p) => [p.id, p]));

/** Every {steps.X.*} ref in task/run/when/eval names a phase in dependsOn. */
function assertNoDanglingRefs(phases: Phase[]) {
	for (const p of phases) {
		const deps = new Set([...(p.dependsOn ?? []), ...(p.from ?? [])]);
		const texts = [p.task, p.when, ...(Array.isArray(p.run) ? p.run : [p.run]), ...(p.eval ?? [])].filter((t): t is string => typeof t === "string");
		for (const t of texts) for (const m of t.matchAll(/\{steps\.([a-zA-Z0-9_-]+)\./g)) assert.ok(deps.has(m[1]), `${p.id} references steps.${m[1]} without depending on it`);
	}
}

test("verify omitted + impl agents: canonical tail appended, wired to terminals", () => {
	const out = expandVerify(flow([impl("a"), impl("b", ["a"]), impl("c", ["a"], "test-engineer")]));
	const p = byId(out);
	for (const id of [I.fix, I.fixHarness, I.operator, "spec-review", "risk-review", "security-review", "quality-review", I.verdict, I.report]) assert.ok(p[id], id);
	assert.deepEqual(p[I.fix].dependsOn, ["b", "c"]);
	assert.deepEqual(p[I.fixHarness].dependsOn, ["b", "c"]);
	assert.ok(!p[I.build], "no test command -> no build phase");
	assert.deepEqual(p[I.operator].dependsOn, [I.fix, I.fixHarness]);
	for (const lens of ["spec-review", "risk-review", "security-review", "quality-review"]) {
		assert.deepEqual(p[lens].dependsOn, [I.fix, I.fixHarness], lens);
		assert.equal(p[lens].output, "json");
		assert.ok(p[I.verdict].eval!.includes(`{steps.${lens}.json.blocking} == 0`), lens);
	}
	assert.equal(p[I.verdict].type, "gate");
	assert.equal(p[I.verdict].onBlock, "retry");
	assert.equal(p[I.verdict].retry?.max, 2);
	assert.equal(p[I.verdict].dependsOn![0], I.fix, "BLOCK must re-run from the fixer");
	assert.ok(p[I.verdict].eval!.includes(`{steps.${I.operator}.json.all_pass} == true`));
	assert.ok(!p[I.verdict].tools!.includes("read"), "arbiter judges evidence only");
	assert.equal(p[I.report].final, true);
	assert.match(p["spec-review"].task!, /implement a/, "impl brief injected when no spec files");
	assert.deepEqual(out.verify, []);
	assertNoDanglingRefs(out.phases);
	assert.ok(validateTaskflow(out).ok, validateTaskflow(out).errors.join("; "));
	assert.ok(verifyTaskflow(out).ok, JSON.stringify(verifyTaskflow(out).issues));
});

test("verify object: testCmd adds build; harness/replay/redteam add their phases", () => {
	const out = expandVerify(
		flow([impl("a")], {
			verify: { testCmd: "just test", harnessUp: 'echo {"base_url":"x"}', harnessDown: "true", replay: "pytest tests/e2e", redteam: true, rounds: 3, specs: ["specs/x.md"], design: ["design.md"] },
		}),
	);
	const p = byId(out);
	assert.deepEqual(p[I.build].dependsOn, [I.fix, I.fixHarness]);
	assert.equal(p[I.build].optional, true);
	assert.match(String(p[I.build].run), /just test.*BUILD_OK/);
	assert.deepEqual(p[I.harnessUp].dependsOn, [I.build]);
	assert.deepEqual(p[I.operator].dependsOn, [I.harnessUp, I.replay]);
	assert.deepEqual(p[I.harnessDown].dependsOn, [I.operator, I.redteam]);
	assert.equal(p[I.harnessDown].join, "any");
	assert.deepEqual(p["spec-review"].dependsOn, [I.harnessDown]);
	assert.deepEqual(p[I.verdict].dependsOn, [I.fix, I.build, I.harnessUp, I.replay, I.operator, I.redteam, I.harnessDown, "spec-review", "risk-review", "security-review", "quality-review"]);
	assert.equal(p[I.verdict].retry?.max, 3);
	assert.ok(p[I.verdict].eval!.includes(`{steps.${I.replay}.json.failed} == 0`));
	assert.ok(p[I.verdict].eval!.includes(`{steps.${I.redteam}.json.critical} == 0`));
	assert.deepEqual(p[I.operator].context, ["specs/x.md"], "operator never sees design.md");
	assert.deepEqual(p["spec-review"].context, ["specs/x.md", "design.md"]);
	assertNoDanglingRefs(out.phases);
	assert.ok(validateTaskflow(out).ok, validateTaskflow(out).errors.join("; "));
	assert.ok(verifyTaskflow(out).ok, JSON.stringify(verifyTaskflow(out).issues));
});

test("no impl agents: nothing appended", () => {
	const f = flow([{ id: "a", type: "agent", agent: "scout", task: "look", final: true }]);
	assert.equal(expandVerify(f), f);
	assert.ok(verifyTaskflow(f).ok);
});

test("verify:false opts out, lint stays quiet", () => {
	const f = flow([impl("a")], { verify: false });
	assert.equal(expandVerify(f), f);
	assert.ok(validateTaskflow(f).ok);
	assert.ok(verifyTaskflow(f).ok);
});

test("explicit verify:[...] is appended as-is; missing dependsOn hangs off terminals", () => {
	const out = expandVerify(
		flow([impl("a"), impl("b", ["a"])], {
			verify: [
				{ id: "fixit", type: "agent", agent: "executor", task: "fix" },
				{ id: "gate", type: "gate", agent: "reviewer", onBlock: "retry", retry: { max: 1 }, dependsOn: ["fixit"], task: "judge", final: true },
			],
		}),
	);
	const p = byId(out);
	assert.deepEqual(p.fixit.dependsOn, ["b"]);
	assert.deepEqual(p.gate.dependsOn, ["fixit"]);
	assert.ok(verifyTaskflow(out).ok);
});

test("existing gate counts as verification: nothing appended, lint quiet", () => {
	const f = flow([impl("a"), { id: "review", type: "gate", agent: "reviewer", task: "judge", dependsOn: ["a"], final: true }]);
	assert.equal(expandVerify(f), f);
	assert.ok(!verifyTaskflow(f).issues.some((i) => i.category === "verify-tail"));
});

test("explicit verify without a gate is a lint error; impl final is demoted", () => {
	const out = expandVerify(flow([impl("a", undefined), { ...impl("b", ["a"]), final: true }], { verify: [{ id: "x", type: "agent", agent: "reviewer", task: "look", final: true }] }));
	assert.equal(byId(out).b.final, undefined);
	const r = verifyTaskflow(out);
	assert.ok(!r.ok);
	assert.ok(r.issues.some((i) => i.category === "verify-tail" && i.severity === "error"));
});

test("expansion is idempotent", () => {
	const once = expandVerify(flow([impl("a")]));
	const twice = expandVerify(once);
	assert.deepEqual(twice.phases.map((p) => p.id), once.phases.map((p) => p.id));
});

test("tail id collision throws", () => {
	assert.throws(() => expandVerify(flow([impl("fix")])), /collides/);
});

test("compile and preflight see the expanded flow", () => {
	const c = compileTaskflow(flow([impl("a")]));
	assert.ok(c.verification.ok, JSON.stringify(c.verification.issues));
	assert.match(c.mermaid, /verdict/);
	const pf = preflightTaskflow(flow([impl("a")]));
	assert.ok(pf.phases.some((p) => p.id === I.verdict), "plan lists the verdict gate");
});

test("literal {steps.X} in an impl task does not become a dangling ref in the brief", () => {
	const out = expandVerify(flow([{ ...impl("a"), task: 'emit when: "{steps.build.output} contains X"' }]));
	assertNoDanglingRefs(out.phases.filter((p) => p.id !== "a"));
	assert.match(byId(out)["spec-review"].task!, /steps\.build\.output/, "brief still reads the same to a human");
	assert.ok(verifyTaskflow(out).ok, JSON.stringify(verifyTaskflow(out).issues));
});
