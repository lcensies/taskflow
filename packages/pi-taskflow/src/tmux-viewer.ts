/**
 * tmux worker windows — one read-only window per run node, running
 * `peek --follow <transcriptFile>`.
 *
 * The window is a VIEWER, never the worker's parent (design D1): it is handed a
 * transcript path and nothing else — no pid, no child handle, no signal path —
 * so closing it, killing the tmux server, or never opening it cannot change how
 * a worker runs or how its completion is classified.
 *
 * Opened lazily on a node's first output (see `openTranscriptTee` in
 * ./runner.ts), idempotent per node, and capped per run so a map fan-out does
 * not open a window per item (design D8).
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { readSubagentSettings } from "taskflow-core";

/** Per-run cap on automatically opened windows. */
export const DEFAULT_MAX_WORKER_WINDOWS = 10;
export const TMUX_BIN_ENV = "PI_TASKFLOW_TMUX_BIN";
export const TMUX_MAX_WINDOWS_ENV = "PI_TASKFLOW_TMUX_MAX_WINDOWS";

/**
 * - `opened`   — a window was created for this node
 * - `exists`   — this node already has one (second call is a no-op)
 * - `capped`   — the run hit its window cap; the node runs windowless and is
 *                listed by `skippedWorkerWindows`
 * - `disabled` — windows are off for this node (setting or per-phase override);
 *                tmux is never invoked
 * - `unavailable` — no tmux client session, or tmux refused/was absent
 */
export type WorkerWindowResult = "opened" | "exists" | "capped" | "disabled" | "unavailable";

/** Diagnostic a caller records on the phase when a window could not be opened.
 *  Fail-open: the worker, its result and its classification are untouched. */
export const WORKER_WINDOW_UNAVAILABLE_WARNING =
	"worker window unavailable: tmux did not open a viewer window for this node (not installed, no reachable server, or no current session) — the run is unaffected; set taskflow.workerWindows=false to stop trying";

export interface WorkerWindowOptions {
	/** Per-run cap. Default: $PI_TASKFLOW_TMUX_MAX_WINDOWS, else 10. */
	max?: number;
	/** tmux executable. Default: $PI_TASKFLOW_TMUX_BIN, else `tmux`. */
	tmuxBin?: string;
	/** Shell command the window runs. Default: `peek --follow <file>`. */
	followCommand?: (transcriptFile: string) => string;
	/** Per-phase override (`Phase.workerWindow`). Wins over the setting. */
	enabled?: boolean;
}

export interface WorkerWindowTarget {
	runId: string;
	nodeId: string;
	transcriptFile: string;
}

/** ponytail: per-run window bookkeeping lives in a module map, keyed by runId —
 *  the "first output" seam has no run-level object to hang it on. Ceiling: one
 *  small entry per run id for the life of the host process; `forgetWorkerWindows`
 *  drops one. Upgrade path: pass a run-scoped registry down from the runtime. */
const runWindows = new Map<string, { opened: Set<string>; skipped: string[] }>();

function stateFor(runId: string): { opened: Set<string>; skipped: string[] } {
	let state = runWindows.get(runId);
	if (!state) {
		state = { opened: new Set(), skipped: [] };
		runWindows.set(runId, state);
	}
	return state;
}

/** Trailing random segment of `newRunId`'s `<flow>-<ts36>-<hex>` form. */
export function shortRunId(runId: string): string {
	return runId.split("-").pop() || runId;
}

/** `tf:<runId-short>:<nodeId>` — derivable from the run id and node id alone. */
export function workerWindowName(runId: string, nodeId: string): string {
	return `tf:${shortRunId(runId)}:${nodeId}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultFollowCommand(transcriptFile: string): string {
	return `peek --follow ${shellQuote(transcriptFile)}`;
}

function configuredMax(): number {
	const override = Number(process.env[TMUX_MAX_WINDOWS_ENV]);
	return Number.isFinite(override) && override >= 0 ? override : DEFAULT_MAX_WORKER_WINDOWS;
}

/**
 * Windows are off by default (design D8, revised): the per-phase override
 * wins, then the `taskflow.workerWindows` setting, and absent both, windows
 * stay off — opt in explicitly to get one.
 * ponytail: one settings.json read per node's first output, not memoized, so a
 * mid-run settings change takes effect. Ceiling: one small JSON parse per node.
 */
export function workerWindowsEnabled(override?: boolean): boolean {
	if (override !== undefined) return override;
	return readSubagentSettings().taskflow.workerWindows;
}

/**
 * Open this node's window if windows are enabled, it has none, and the run is
 * under its cap. Fail-open: any tmux failure yields `unavailable` and nothing
 * else changes.
 */
export function openWorkerWindow(target: WorkerWindowTarget, opts: WorkerWindowOptions = {}): WorkerWindowResult {
	if (!workerWindowsEnabled(opts.enabled)) return "disabled";
	// Without $TMUX there is no current session to put a window in; do not
	// start a server behind the user's back.
	if (!process.env.TMUX) return "unavailable";
	const state = stateFor(target.runId);
	if (state.opened.has(target.nodeId)) return "exists";
	const max = opts.max ?? configuredMax();
	if (state.opened.size >= max) {
		if (!state.skipped.includes(target.nodeId)) state.skipped.push(target.nodeId);
		return "capped";
	}
	const command = (opts.followCommand ?? defaultFollowCommand)(target.transcriptFile);
	// ponytail: synchronous spawn — one short tmux call on a node's first output,
	// and nothing is kept afterwards (no handle to track or clean up).
	try {
		execFileSync(opts.tmuxBin ?? process.env[TMUX_BIN_ENV] ?? "tmux", [
			"new-window",
			"-d", // never steal focus from the orchestrator's window
			"-n",
			workerWindowName(target.runId, target.nodeId),
			command,
		], { stdio: "ignore", timeout: 5_000 });
	} catch {
		return "unavailable";
	}
	state.opened.add(target.nodeId);
	return "opened";
}

/** Node ids of this run that ran windowless because the cap was reached. */
export function skippedWorkerWindows(runId: string): string[] {
	return [...(runWindows.get(runId)?.skipped ?? [])];
}

/** Node ids of this run that have a window. */
export function openedWorkerWindows(runId: string): string[] {
	return [...(runWindows.get(runId)?.opened ?? [])];
}

/** Forget a run's (or every) window bookkeeping. Never kills a window. */
export function forgetWorkerWindows(runId?: string): void {
	if (runId === undefined) runWindows.clear();
	else runWindows.delete(runId);
}

/**
 * Open a window from a transcript path alone: `transcriptFileFor` writes
 * `<runsRoot>/<flow>/<runId>/<nodeId>.ndjson`, so the path carries both ids the
 * window name needs.
 */
export function openWorkerWindowForTranscript(
	transcriptFile: string,
	opts: WorkerWindowOptions = {},
): WorkerWindowResult {
	const nodeId = path.basename(transcriptFile).replace(/\.ndjson$/, "");
	const runId = path.basename(path.dirname(transcriptFile));
	if (!nodeId || !runId || runId === "." || runId === path.sep) return "unavailable";
	return openWorkerWindow({ runId, nodeId, transcriptFile }, opts);
}
