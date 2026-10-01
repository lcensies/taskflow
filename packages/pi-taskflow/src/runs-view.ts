/**
 * Interactive run-history view for `/tf runs` (ctx.ui.custom).
 * List view: navigate runs; Enter → the run's navigator (read-only inspector);
 * r → resume; d/D → delete one / clear finished (confirmed); Esc/q → close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxRow, boxRule, boxTop, InspectorComponent, listKey } from "./inspector-view.ts";
import { summarizeRun } from "./render.ts";
import type { Phase, RunState } from "taskflow-core";

export interface RunHistoryResult {
	action: "resume";
	runId: string;
}

/** Deletion the host performs on the panel's behalf (the panel stays a renderer). */
export interface RunDeleteOps {
	run: (runId: string) => { ok: boolean; reason?: string };
	allFinished: () => number;
}

function statusBadge(status: RunState["status"], theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓ done");
		case "failed":
			return theme.fg("error", "✗ failed");
		case "blocked":
			return theme.fg("error", "⊗ blocked");
		case "paused":
			return theme.fg("warning", "‖ paused");
		default:
			return theme.fg("warning", "◐ running");
	}
}

function timeAgo(ts: number): string {
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function isResumable(r: RunState): boolean {
	return r.status === "paused" || r.status === "failed";
}

/** Detect whether a refreshed run list differs from the current one in any way
 * the panel renders (status, updatedAt, phase progress, membership). */
function hasChanged(prev: RunState[], next: RunState[]): boolean {
	if (prev.length !== next.length) return true;
	const byId = new Map(prev.map((r) => [r.runId, r]));
	for (const n of next) {
		const p = byId.get(n.runId);
		if (!p) return true;
		if (p.status !== n.status || p.updatedAt !== n.updatedAt) return true;
	}
	return false;
}

export class RunHistoryComponent {
	private runs: RunState[];
	private theme: Theme;
	private onDone: (result?: RunHistoryResult) => void;
	private selected = 0;
	/** Non-null while a run is open: every key and repaint belongs to it. */
	private inspector?: InspectorComponent;
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Live-refresh wiring: re-read run state from disk while the panel is open
	 * so background (detached) runs show live progress without reopening. */
	private timer?: ReturnType<typeof setInterval>;
	private refresh?: () => RunState[];
	private requestRender?: () => void;
	/** Transcript file for one node of a run; undefined when the host keeps none. */
	private transcriptFile?: (run: RunState, nodeId: string) => string | undefined;
	private rows?: () => number;
	private plannedModel?: (phase: Phase) => string | undefined;
	/** Host-provided deletion; absent when the host wires none (tests, read-only). */
	private del?: RunDeleteOps;
	/** Armed destructive action awaiting `y`; shown in place of the hint line. */
	private confirm?: { kind: "run" | "all"; prompt: string };
	/** One-shot footer message (refusals, results). */
	private notice?: string;
	/** Run the open navigator belongs to, so refreshes reach the right copy. */
	private openRunId?: string;

	constructor(
		runs: RunState[],
		theme: Theme,
		onDone: (result?: RunHistoryResult) => void,
		/** Optional live-refresh hooks. When both are provided the panel polls
		 * `refresh()` on an interval and calls `requestRender()` if anything changed. */
		live?: { refresh: () => RunState[]; requestRender: () => void; intervalMs?: number },
		/** What the run's navigator needs: where transcripts live, how tall the terminal is. */
		opts?: {
			transcriptFile?: (run: RunState, nodeId: string) => string | undefined;
			rows?: () => number;
			plannedModel?: (phase: Phase) => string | undefined;
			delete?: RunDeleteOps;
		},
	) {
		if (!runs.length) {
			throw new Error("RunHistoryComponent requires at least one run");
		}
		this.runs = runs;
		this.theme = theme;
		this.onDone = onDone;
		this.transcriptFile = opts?.transcriptFile;
		this.rows = opts?.rows;
		this.plannedModel = opts?.plannedModel;
		this.del = opts?.delete;
		if (live) {
			this.refresh = live.refresh;
			this.requestRender = live.requestRender;
			const intervalMs = Math.max(250, live.intervalMs ?? 1000);
			this.timer = setInterval(() => this.poll(), intervalMs);
			// Don't keep the event loop alive just for the panel refresh.
			(this.timer as { unref?: () => void }).unref?.();
		}
	}

	/** Re-read run state; if anything changed, refresh the cached render. */
	private poll(): void {
		if (!this.refresh) return;
		let next: RunState[];
		try {
			next = this.refresh();
		} catch {
			return; // transient read/lock error — try again next tick
		}
		if (!next.length) return;
		if (!hasChanged(this.runs, next)) return;
		// Preserve the user's selection by runId across refreshes.
		const selectedId = this.runs[this.selected]?.runId;
		this.runs = next;
		const idx = next.findIndex((r) => r.runId === selectedId);
		this.selected = idx >= 0 ? idx : Math.min(this.selected, next.length - 1);
		// The navigator holds its own copy; without this a run that advances while
		// it is open renders frozen until the user closes and reopens it.
		const open = this.openRunId && next.find((r) => r.runId === this.openRunId);
		if (open) this.inspector?.setState(open);
		this.invalidate();
		this.requestRender?.();
	}

	/** Stop the refresh timer when the panel closes. */
	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.closeInspector();
	}

	/** Open the selected run's navigator; its `onDone` pops back to this list. */
	private openInspector(): void {
		const run = this.runs[this.selected];
		if (!run) return;
		const transcriptFile = this.transcriptFile;
		this.openRunId = run.runId;
		this.inspector = new InspectorComponent(
			run,
			this.theme,
			() => this.closeInspector(),
			false, // a stored run has no steering channel
			this.requestRender,
			this.rows,
			transcriptFile && ((nodeId: string) => transcriptFile(run, nodeId)),
			this.plannedModel,
		);
	}

	private closeInspector(): void {
		this.inspector?.dispose();
		this.inspector = undefined;
		this.openRunId = undefined;
		this.invalidate();
	}

	/** Visible run rows — the step PgUp/PgDn moves the selection by. */
	private page(): number {
		return Math.max(3, Math.floor(this.rows?.() ?? 24) - 6);
	}

	/** Arm a destructive action. Nothing is removed until the user presses `y`. */
	private armDelete(all: boolean): void {
		if (!this.del) {
			this.notice = "deletion unavailable here";
			return;
		}
		if (all) {
			const finished = this.runs.filter((r) => r.status !== "running").length;
			if (finished === 0) {
				this.notice = "no finished runs to clear";
				return;
			}
			this.confirm = { kind: "all", prompt: `clear ${finished} finished run(s)? y/n` };
			return;
		}
		const run = this.runs[this.selected];
		if (!run) return;
		if (run.status === "running") {
			this.notice = "run is still executing — cannot delete";
			return;
		}
		this.confirm = { kind: "run", prompt: `delete ${run.flowName} ${run.runId}? y/n` };
	}

	private performDelete(kind: "run" | "all"): void {
		if (!this.del) return;
		let local: RunState[];
		if (kind === "all") {
			const removed = this.del.allFinished();
			this.notice = `cleared ${removed} run(s)`;
			local = this.runs.filter((r) => r.status === "running");
		} else {
			const run = this.runs[this.selected];
			if (!run) return;
			const res = this.del.run(run.runId);
			if (!res.ok) {
				this.notice = `delete failed: ${res.reason ?? "unknown"}`;
				return;
			}
			this.notice = `deleted ${run.runId}`;
			local = this.runs.filter((r) => r.runId !== run.runId);
		}
		// Prefer a re-read; without a refresh hook fall back to the local removal so
		// the list never shows a run that no longer exists.
		let next: RunState[];
		try {
			next = this.refresh?.() ?? local;
		} catch {
			next = local;
		}
		if (next.length === 0) {
			this.onDone();
			return;
		}
		this.runs = next;
		this.selected = Math.min(this.selected, next.length - 1);
	}

	handleInput(data: string): void {
		this.invalidate();
		if (this.inspector) {
			this.inspector.handleInput(data);
			return;
		}
		if (this.confirm) {
			const armed = this.confirm;
			this.confirm = undefined;
			if (data === "y" || data === "Y") this.performDelete(armed.kind);
			return;
		}
		this.notice = undefined;
		if (data === "d" || data === "D") {
			this.armDelete(data === "D");
			return;
		}
		const n = this.runs.length;
		switch (listKey(data)) {
			case "up":
				this.selected = (this.selected - 1 + n) % n;
				return;
			case "down":
				this.selected = (this.selected + 1) % n;
				return;
			case "pageUp":
				this.selected = Math.max(0, this.selected - this.page());
				return;
			case "pageDown":
				this.selected = Math.min(n - 1, this.selected + this.page());
				return;
			case "top":
				this.selected = 0;
				return;
			case "bottom":
				this.selected = n - 1;
				return;
			case "in":
				this.openInspector();
				return;
			// The run list is the root level: "out" has nothing to pop back to.
			case "out":
			case "close":
				this.onDone();
				return;
		}
		if (data === "r" && isResumable(this.runs[this.selected])) {
			this.onDone({ action: "resume", runId: this.runs[this.selected].runId });
		}
	}

	render(width: number): string[] {
		if (this.inspector) return this.inspector.render(width);
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [boxTop("Taskflow runs", width, th)];

		this.runs.forEach((run, i) => {
			const sel = i === this.selected;
			const marker = sel ? th.fg("accent", "❯ ") : "  ";
			const badge = statusBadge(run.status, th);
			const name = sel ? th.fg("text", run.flowName) : th.fg("muted", run.flowName);
			const meta = th.fg("dim", `${summarizeRun(run)} · ${timeAgo(run.updatedAt)}`);
			lines.push(boxRow(`${marker}${badge}  ${name}  ${meta}`, width, th));
		});

		const anyRunning = this.runs.some((r) => r.status === "running");
		const liveHint = this.timer && anyRunning ? th.fg("success", " ● live") : "";
		lines.push(boxRule(width, "├", "┤", th));
		const footer = this.confirm
			? th.fg("warning", this.confirm.prompt)
			: this.notice
				? th.fg("warning", this.notice)
				: `${th.fg("dim", "↑↓/jk move · →/l open · r resume · d delete · D clear finished · q close")}${liveHint}`;
		lines.push(boxRow(footer, width, th));
		lines.push(boxRule(width, "╰", "╯", th));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
