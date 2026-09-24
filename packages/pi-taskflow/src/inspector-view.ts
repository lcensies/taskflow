/**
 * Live inspector for an in-flight run (`alt+t`).
 *
 * Navigation is a level stack (`phases` → `agents` → `detail`) with one cursor
 * per level. `phases`: one row per phase of the run, windowed to the viewport.
 * `agents`: one row per fan-out item of the selected phase (skipped entirely by
 * a phase that ran a single subagent). `detail`: one node's accounting header
 * plus a scrollable pane over its subagent transcript (falling back to that
 * item's section of the merged output, then to the in-memory activity/output,
 * when no transcript file exists). Read-only
 * except for `s`, which asks the host to steer that phase (the host owns the
 * text prompt so this component stays a renderer).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type PhaseState, type RunState, splitItems } from "taskflow-core";
import { ScrollPane } from "./scroll-pane.ts";
import { renderTranscript, TranscriptTail } from "./transcript-view.ts";

/** Terminal height assumed when the host gives us no `rows` accessor. */
const FALLBACK_ROWS = 24;

export interface InspectorResult {
	action: "steer";
	phaseId: string;
}

/** One navigation intent, shared by every list-shaped panel. */
export type ListAction = "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "in" | "out" | "close";

/**
 * The one key map for list navigation: arrows plus the vim aliases.
 * Pure — the caller decides what each action means at its level.
 */
export function listKey(data: string): ListAction | undefined {
	if (matchesKey(data, "up") || data === "k") return "up";
	if (matchesKey(data, "down") || data === "j") return "down";
	if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) return "pageUp";
	if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) return "pageDown";
	if (matchesKey(data, "home") || data === "g") return "top";
	if (matchesKey(data, "end") || data === "G") return "bottom";
	if (matchesKey(data, "return") || matchesKey(data, "right") || data === "l") return "in";
	if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "h") return "out";
	if (data === "q" || matchesKey(data, "ctrl+c")) return "close";
	return undefined;
}

/** Content columns inside the panel border (`│ ` … ` │`). */
export function boxInner(width: number): number {
	return Math.max(1, width - 4);
}

/** Top border with the panel title embedded: `╭─ Title ─────╮`. */
export function boxTop(title: string, width: number, theme: Theme): string {
	const t = truncateToWidth(` ${title} `, Math.max(0, width - 6));
	const fill = Math.max(0, width - 4 - visibleWidth(t));
	return theme.fg("border", "╭─") + theme.fg("accent", t) + theme.fg("border", `${"─".repeat(fill)}─╮`);
}

/** One body row, padded to the full panel width so the overlay composites cleanly. */
export function boxRow(content: string, width: number, theme: Theme): string {
	const inner = boxInner(width);
	const t = truncateToWidth(content, inner);
	return `${theme.fg("border", "│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${theme.fg("border", "│")}`;
}

/** A horizontal rule: the footer separator (`├┤`) or the bottom border (`╰╯`). */
export function boxRule(width: number, left: string, right: string, theme: Theme): string {
	return theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
}

/** Phases whose subagent can still receive a message. */
export function isSteerable(ps: PhaseState | undefined): boolean {
	const status = ps?.status ?? "pending";
	return status === "running" || status === "pending";
}

/**
 * First visible row index so `cursor` stays inside a `visible`-row window,
 * centred while there is list on both sides and clamped at the ends.
 */
export function windowStart(count: number, cursor: number, visible: number): number {
	if (count <= visible) return 0;
	return Math.max(0, Math.min(cursor - (visible >> 1), count - visible));
}

/** One fan-out item of a phase; its node id is `<phaseId>-<index>`. */
export interface AgentRow {
	/** 0-based position within the fan-out. */
	index: number;
	/** Agent name from the merged output's `### [k/N] <agent>` label, else `item k`. */
	label: string;
	status: "done" | "failed" | "running" | "pending";
}

/**
 * Fan-out item rows of a phase, derived (never stored) from `subProgress` plus
 * the merged output's labelled sections. `[]` for a phase that ran a single
 * subagent — those drill straight to detail.
 */
export function agentRows(ps: PhaseState | undefined): AgentRow[] {
	const sub = ps?.subProgress;
	if (!sub) return [];
	const sections = ps?.output ? splitItems(ps.output) : new Map<number, string>();
	const rows: AgentRow[] = [];
	for (let index = 0; index < sub.total; index++) {
		const section = sections.get(index + 1);
		const head = section?.split("\n", 1)[0]?.match(/^### \[\d+\/\d+\]\s*(.*)$/)?.[1]?.trim() ?? "";
		const failed = head.endsWith("(failed)");
		const agent = (failed ? head.slice(0, -"(failed)".length) : head).trim();
		// No section: the item is either budget-skipped or still in flight, so fall
		// back to counting positions off subProgress.
		const status: AgentRow["status"] = section
			? failed
				? "failed"
				: "done"
			: index < sub.done
				? "done"
				: index < sub.done + sub.running
					? "running"
					: "pending";
		rows.push({ index, label: agent || `item ${index + 1}`, status });
	}
	return rows;
}

function statusBadge(status: string, theme: Theme): string {
	if (status === "done") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "running") return theme.fg("warning", "◐");
	if (status === "skipped") return theme.fg("muted", "⊘");
	return theme.fg("dim", "○");
}

function phaseLine(ps: PhaseState | undefined, id: string, theme: Theme): string {
	const badge = statusBadge(ps?.status ?? "pending", theme);
	const sub = ps?.subProgress;
	const fanout = sub ? theme.fg("muted", ` ${sub.done}/${sub.total}`) : "";
	const steered = ps?.steered ? theme.fg("accent", " ⇢") : "";
	return `${badge} ${id}${fanout}${steered}`;
}

function agentLine(row: AgentRow, theme: Theme): string {
	return `${statusBadge(row.status, theme)} ${theme.fg("dim", `[${row.index + 1}]`)} ${row.label}`;
}

/** One rung of the navigator: run phases → a phase's fan-out items → one node's detail. */
export type InspectorLevel = "phases" | "agents" | "detail";

export class InspectorComponent {
	/** Navigation stack, deepest last; `cursors` holds one cursor per entry. */
	private levelStack: InspectorLevel[] = ["phases"];
	private cursors: number[] = [0];
	private pane = new ScrollPane();
	/** Detail pane renders uncapped, wrapped transcripts; survives navigation. */
	private full = false;
	private tail?: TranscriptTail;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private timer?: ReturnType<typeof setInterval>;

	private state: RunState;
	private theme: Theme;
	private onDone: (result?: InspectorResult) => void;
	/** False when this host/run has no steering channel. */
	private steerAvailable: boolean;
	private rows: () => number;
	/** nodeId → transcript file; undefined when the host keeps no transcripts. */
	private transcriptFile?: (nodeId: string) => string | undefined;

	constructor(
		state: RunState,
		theme: Theme,
		onDone: (result?: InspectorResult) => void,
		steerAvailable: boolean,
		requestRender?: () => void,
		rows?: () => number,
		transcriptFile?: (nodeId: string) => string | undefined,
	) {
		this.state = state;
		this.theme = theme;
		this.onDone = onDone;
		this.steerAvailable = steerAvailable;
		this.rows = rows ?? (() => FALLBACK_ROWS);
		this.transcriptFile = transcriptFile;
		if (requestRender) {
			// The runtime mutates `state` in place; repaint on a timer rather than
			// subscribing, so the inspector never perturbs the run.
			this.timer = setInterval(() => {
				this.tail?.poll();
				this.invalidate();
				requestRender();
			}, 250);
			(this.timer as { unref?: () => void }).unref?.();
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private phaseIds(): string[] {
		return (this.state.def.phases ?? []).map((p) => p.id);
	}

	private get level(): InspectorLevel {
		return this.levelStack[this.levelStack.length - 1] ?? "phases";
	}

	/** Cursor of the deepest level. */
	private get cursor(): number {
		return this.cursors[this.cursors.length - 1] ?? 0;
	}

	private set cursor(n: number) {
		this.cursors[this.cursors.length - 1] = n;
	}

	/** The phase every level hangs off: the `phases` cursor, which never pops. */
	private currentPhaseId(): string | undefined {
		return this.phaseIds()[this.cursors[0] ?? 0];
	}

	/** Fan-out items of the selected phase; `[]` when it ran a single subagent. */
	private currentAgentRows(): AgentRow[] {
		const id = this.currentPhaseId();
		return agentRows(id ? this.state.phases[id] : undefined);
	}

	/** Node the detail level shows: the phase, or `<phaseId>-<idx>` under `agents`. */
	private currentNodeId(): string | undefined {
		const id = this.currentPhaseId();
		if (!id) return undefined;
		const agentsAt = this.levelStack.indexOf("agents");
		return agentsAt < 0 ? id : `${id}-${this.cursors[agentsAt] ?? 0}`;
	}

	private push(level: InspectorLevel): void {
		this.levelStack.push(level);
		this.cursors.push(0);
	}

	/** Pops one level; at the root there is nothing to pop and the panel closes. */
	private pop(): void {
		if (this.levelStack.length <= 1) {
			this.onDone();
			return;
		}
		this.levelStack.pop();
		this.cursors.pop();
		this.tail = undefined;
	}

	handleInput(data: string): void {
		this.invalidate();
		if (this.level === "detail") {
			if (matchesKey(data, "escape")) {
				this.pop();
				return;
			}
			if (matchesKey(data, "ctrl+o")) {
				this.full = !this.full;
				// The body length changes wholesale; an old offset would point nowhere.
				this.pane.offset = 0;
				return;
			}
			if (this.pane.handleKey(data)) return;
			if (data === "s") this.requestSteer(this.currentPhaseId());
			return;
		}
		const count = this.level === "agents" ? this.currentAgentRows().length : this.phaseIds().length;
		switch (listKey(data)) {
			case "up":
				if (count) this.cursor = (this.cursor - 1 + count) % count;
				return;
			case "down":
				if (count) this.cursor = (this.cursor + 1) % count;
				return;
			case "top":
				this.cursor = 0;
				return;
			case "bottom":
				this.cursor = Math.max(0, count - 1);
				return;
			case "in":
				// A phase that fanned out gets its item list first; a single-subagent
				// phase drills straight to the detail of node `<phaseId>`.
				if (this.level === "phases" && this.currentAgentRows().length) {
					this.push("agents");
					return;
				}
				this.push("detail");
				this.openTail(this.currentNodeId());
				return;
			case "out":
				this.pop();
				return;
			case "close":
				this.onDone();
				return;
		}
		if (data === "s") this.requestSteer(this.currentPhaseId());
	}

	private openTail(nodeId: string | undefined): void {
		this.pane = new ScrollPane();
		this.tail = undefined;
		const file = nodeId ? this.transcriptFile?.(nodeId) : undefined;
		if (!file) return;
		this.tail = new TranscriptTail(file);
		this.tail.poll();
	}

	private requestSteer(phaseId: string | undefined): void {
		if (!phaseId || !this.steerAvailable) return;
		if (!isSteerable(this.state.phases[phaseId])) return;
		this.onDone({ action: "steer", phaseId });
	}

	/** Detail rows for the selected node, sized to `width` content columns. */
	private detailLines(width: number): string[] {
		const th = this.theme;
		const id = this.currentPhaseId();
		const ps = id ? this.state.phases[id] : undefined;
		const lines: string[] = [];
		lines.push(`${th.fg("accent", id ?? "?")} ${th.fg("dim", ps?.status ?? "pending")}`);
		const meta: string[] = [];
		if (ps?.model) meta.push(ps.model);
		if (ps?.usage) meta.push(`${ps.usage.input + ps.usage.output} tok`);
		if (ps?.attempts && ps.attempts > 1) meta.push(`${ps.attempts} attempts`);
		if (ps?.steered) meta.push("steered");
		if (meta.length) lines.push(th.fg("dim", meta.join(" · ")));
		lines.push("");

		// Transcript when the node has one on disk; for a fan-out item without one,
		// its own section of the merged output; else today's in-memory block.
		const entries = this.tail?.entries ?? [];
		const body = entries.length
			? renderTranscript(entries, Math.max(10, width), th, { full: this.full })
			: (this.itemBody(ps) ?? this.fallbackBody(ps));
		// Leave room for the header already emitted plus the panel chrome
		// (top border, footer separator, hint, bottom border).
		const visible = Math.max(3, Math.floor(this.rows()) - lines.length - 4);
		for (const line of this.pane.view(body, visible)) lines.push(line);
		return lines;
	}

	/** The selected fan-out item's section of the merged output, when there is one. */
	private itemBody(ps: PhaseState | undefined): string[] | undefined {
		const agentsAt = this.levelStack.indexOf("agents");
		if (agentsAt < 0 || !ps?.output) return undefined;
		const section = splitItems(ps.output).get((this.cursors[agentsAt] ?? 0) + 1);
		return section ? section.split("\n") : undefined;
	}

	private fallbackBody(ps: PhaseState | undefined): string[] {
		const th = this.theme;
		const body: string[] = [];
		const log = ps?.liveLog ?? [];
		body.push(th.fg("muted", "─── recorded activity (no transcript available) ───"));
		if (log.length === 0) body.push(th.fg("dim", "(no activity recorded)"));
		for (const line of log) body.push(`${th.fg("dim", "› ")}${line}`);
		if (ps?.output) {
			body.push("");
			body.push(th.fg("muted", "─── output ───"));
			for (const line of ps.output.split("\n")) body.push(line);
		}
		if (ps?.error) {
			body.push("");
			body.push(th.fg("error", ps.error));
		}
		return body;
	}

	/** Pre-rendered rows of the active list level, windowed around its cursor. */
	private listLines(rows: string[], cursor: number): string[] {
		const th = this.theme;
		// Leave room for the panel chrome and the "N more" markers, which cost one
		// row each when they show.
		const cap = Math.max(3, Math.floor(this.rows()) - 6);
		const body = rows.length <= cap ? cap : Math.max(1, cap - 2);
		const start = windowStart(rows.length, cursor, body);
		const shown = rows.slice(start, start + body);
		const lines: string[] = [];
		if (start > 0) lines.push(th.fg("dim", `↑ ${start} more`));
		shown.forEach((row, i) => {
			const marker = start + i === cursor ? th.fg("accent", "❯ ") : "  ";
			lines.push(`${marker}${row}`);
		});
		const below = rows.length - start - shown.length;
		if (below > 0) lines.push(th.fg("dim", `↓ ${below} more`));
		return lines;
	}

	/** Footer keys of the active level — only the ones that act here. */
	private hint(): string {
		const th = this.theme;
		const steer = this.steerAvailable ? "s steer · " : "";
		const keys =
			this.level === "detail"
				? `↑↓/jk scroll · PgUp/PgDn page · G follow · ^O ${this.full ? "compact" : "full"} · ${steer}Esc back`
				: this.level === "agents"
					? `↑↓/jk move · →/l open · ←/h back · ${steer}q close`
					: `↑↓/jk move · →/l open · ${steer}q close`;
		const unavailable = this.steerAvailable || this.level === "detail" ? "" : th.fg("dim", " · steering unavailable");
		return th.fg("dim", keys) + unavailable;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const body =
			this.level === "detail"
				? this.detailLines(boxInner(width))
				: this.listLines(
						this.level === "agents"
							? this.currentAgentRows().map((row) => agentLine(row, th))
							: this.phaseIds().map((id) => phaseLine(this.state.phases[id], id, th)),
						this.cursor,
					);
		const lines = [
			boxTop(`Taskflow ${this.state.flowName}`, width, th),
			...body.map((line) => boxRow(line, width, th)),
			boxRule(width, "├", "┤", th),
			boxRow(this.hint(), width, th),
			boxRule(width, "╰", "╯", th),
		];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
