/**
 * The in-flight run registry.
 *
 * While the `taskflow` tool executes, it owns the host turn: slash input is
 * queued, so `/tf peek` and `/tf runs` cannot be reached during the exact
 * window a user wants them. A shortcut handler can still run, and it needs the
 * live `RunState` object the runtime is mutating — the persisted copy lags up
 * to a second and detached runs are only on disk.
 */

import type { RunState } from "taskflow-core";

export interface ActiveRun {
	state: RunState;
	cwd: string;
	/** Steering root for this run, when the channel was opened. */
	steerDir?: string;
}

let active: ActiveRun | undefined;

export function setActiveRun(state: RunState, cwd: string, steerDir?: string): void {
	active = { state, cwd, steerDir };
}

/** Clear only if `state` is still the published run (a nested sub-flow that
 *  finished must not unpublish its parent). */
export function clearActiveRun(state: RunState): void {
	if (active?.state === state) active = undefined;
}

export function getActiveRun(): ActiveRun | undefined {
	return active;
}
