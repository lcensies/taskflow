/**
 * Reattach classification (design D5): a stored node marked `running` is
 * reconciled from disk, not trusted. Pure function, so no process is spawned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReattach, type OutcomeRecord, type PhaseState } from "../src/store.ts";

const RECORD: OutcomeRecord = { completionSource: "process-exit", exitCode: 0, startedAt: 1, endedAt: 2 };

function phase(status: PhaseState["status"]): Pick<PhaseState, "status"> {
	return { status };
}

/** A probe that fails the test if it is consulted. */
function noProbe(): boolean {
	throw new Error("liveness probe must not be consulted");
}

test("classifyReattach: outcome record present wins over liveness", () => {
	assert.equal(classifyReattach(phase("running"), RECORD, noProbe), "finished-unrecorded");
});

test("classifyReattach: no record, group alive → running", () => {
	assert.equal(classifyReattach(phase("running"), undefined, () => true), "running");
});

test("classifyReattach: no record, group gone → orphaned", () => {
	assert.equal(classifyReattach(phase("running"), undefined, () => false), "orphaned");
});

test("classifyReattach: a stored status that already agrees has nothing to reconcile", () => {
	for (const status of ["done", "failed", "skipped", "pending"] as const) {
		assert.equal(classifyReattach(phase(status), RECORD, noProbe), undefined, status);
		assert.equal(classifyReattach(phase(status), undefined, noProbe), undefined, status);
	}
});
