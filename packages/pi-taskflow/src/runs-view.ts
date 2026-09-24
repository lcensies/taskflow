/**
 * Interactive run-history view for `/tf runs` (ctx.ui.custom).
 * List view: navigate runs; Enter → the run's navigator (read-only inspector);
 * r → resume; Esc/q → close.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { boxRow, boxRule, boxTop, InspectorComponent, listKey } from "./inspector-view.ts";
import { summarizeRun } from "./render.ts";
import type { RunState } from "taskflow-core";

export interface RunHistoryResult {
	action: "resume";
	runId: string;
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
		this.inspector = new InspectorComponent(
			run,
			this.theme,
			() => this.closeInspector(),
			false, // a stored run has no steering channel
			this.requestRender,
			this.rows,
			transcriptFile && ((nodeId: string) => transcriptFile(run, nodeId)),
		);
	}

	private closeInspector(): void {
		this.inspector?.dispose();
		this.inspector = undefined;
		this.invalidate();
	}

	/** Visible run rows — the step PgUp/PgDn moves the selection by. */
	private page(): number {
		return Math.max(3, Math.floor(this.rows?.() ?? 24) - 6);
	}

	handleInput(data: string): void {
		this.invalidate();
		if (this.inspector) {
			this.inspector.handleInput(data);
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
		lines.push(boxRow(`${th.fg("dim", "↑↓/jk move · →/l open · r resume · q close")}${liveHint}`, width, th));
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
