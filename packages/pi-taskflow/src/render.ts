/**
 * TUI rendering for the taskflow tool and commands.
 *
 * Design goals: high information density, column alignment, and width-safe
 * single-cell status glyphs (no double-width emoji that break alignment).
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	aggregateUsage,
	dependenciesOf,
	emptyUsage,
	finalPhase,
	formatTokens,
	type Phase,
	runsDir,
	topoLayers,
	type TranscriptEntry,
	transcriptDirFor,
	transcriptFileFor,
	type UsageStats,
} from "taskflow-core";
import type { PhaseState, RunState } from "taskflow-core";
import { renderTranscript, TranscriptTail } from "./transcript-view.ts";

// Single-width glyphs (Geometric Shapes / check marks) — keep columns aligned.
const ICON: Record<PhaseState["status"], { ch: string; color: string }> = {
	done: { ch: "✓", color: "success" },
	running: { ch: "◐", color: "warning" },
	failed: { ch: "✗", color: "error" },
	skipped: { ch: "⊘", color: "muted" },
	pending: { ch: "○", color: "dim" },
};

function icon(status: PhaseState["status"], theme: Theme): string {
	// Static glyph even while running — the footer carries the only animation,
	// so a per-frame redraw never touches a row above it.
	const i = ICON[status] ?? ICON.pending;
	return theme.fg(i.color as any, i.ch);
}

function shortModel(model?: string): string {
	if (!model) return "";
	return model.split("/").pop() ?? model;
}

// Braille dots spinner (ora classic) — smooth, clockwise, single-width.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Repaint cadence for time-driven content. The host only redraws the card when
 *  `renderFingerprint` changes, so anything animated must advance on the same
 *  bucket — a faster spinner would skip frames and read as a random glyph. */
export const TICK_MS = 1000;
function tick(): number {
	return Math.floor(Date.now() / TICK_MS);
}
function spinnerFrame(): string {
	return SPINNER[tick() % SPINNER.length];
}

// Elapsed as 5s / 3m30s / 1h05m
function elapsed(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) {
		const m = Math.floor(s / 60);
		const ss = s % 60;
		return `${m}m${ss.toString().padStart(2, "0")}s`;
	}
	const h = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	return `${h}h${mm.toString().padStart(2, "0")}m`;
}

function phaseElapsed(ps: PhaseState): number {
	if (!ps.startedAt) return 0;
	// Guard against a stale/clock-skewed endedAt that precedes startedAt (e.g. a
	// resumed phase that still carries a previous attempt's endedAt): treat such
	// an end time as absent and fall back to now. Finally clamp to >= 0 so the
	// TUI never shows a negative (and frozen) elapsed time.
	const end = ps.endedAt && ps.endedAt >= ps.startedAt ? ps.endedAt : Date.now();
	return Math.max(0, end - ps.startedAt);
}

function miniBar(done: number, total: number, theme: Theme, width = 8): string {
	if (total <= 0) return "";
	const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
	return theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

/** Role column text: agent name, or the command for a script phase (the type badge already says "script"). */
export function roleOf(phase: Phase): string {
	if (phase.type === "script" && phase.run) {
		const cmd = (Array.isArray(phase.run) ? phase.run.join(" ") : phase.run).replace(/\s+/g, " ").trim();
		return `$ ${cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd}`;
	}
	return phase.agent ?? phase.type ?? "agent";
}

function agentRole(phase: Phase, ps: PhaseState | undefined, theme: Theme, planned?: string): string {
	const role = roleOf(phase);
	// `~` marks a model that is only planned (resolved from the definition /
	// agent) rather than the one a started phase actually ran on.
	const model = ps?.model ? shortModel(ps.model) : planned ? `~${shortModel(planned)}` : "";
	if (!model) return theme.fg("accent", role);
	return theme.fg("accent", role) + theme.fg("dim", `（${model}）`);
}

/**
 * Control flow that returns to an earlier stage — invisible in a topologically
 * layered list, which is why a looping flow otherwise reads as a pipeline.
 * Both sources are static properties of the definition, so the annotation shows
 * before the phase runs; the loop count is added once the run reports it.
 */
export function backEdgeAnnotation(phase: Phase, ps: PhaseState | undefined, theme: Theme): string {
	if ((phase.type ?? "agent") === "loop") {
		const n = ps?.loop?.iterations;
		return theme.fg("toolTitle", `  ↻ self${n ? `×${n}` : ""}`);
	}
	if (phase.type === "gate" && phase.onBlock === "retry") {
		const deps = dependenciesOf(phase);
		if (deps.length === 0) return theme.fg("toolTitle", "  ↺ retry");
		return theme.fg("toolTitle", `  ↺ retry → ${deps.join(", ")}`);
	}
	return "";
}

export function formatCost(cost: number): string {
	return cost > 0 && cost < 1e-4 ? "<$0.0001" : `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

export function formatUsage(usage: UsageStats | undefined): string {
	if (!usage) return "";
	const fresh = usage.input + usage.output + usage.cacheWrite;
	return fresh || usage.cacheRead ? `${formatTokens(fresh)} tok${usage.cacheRead ? ` · ${formatTokens(usage.cacheRead)} cached` : ""}` : "";
}

function costStr(usage: UsageStats | undefined, theme: Theme): string {
	return usage?.cost ? theme.fg("muted", formatCost(usage.cost)) : "";
}

function aggregateCost(state: RunState): number {
	let c = 0;
	for (const p of Object.values(state.phases)) c += p.usage?.cost ?? 0;
	return c;
}

function runElapsed(state: RunState): number {
	const starts = Object.values(state.phases)
		.map((p) => p.startedAt)
		.filter((x): x is number => !!x);
	if (starts.length === 0) return 0;
	const min = Math.min(...starts);
	const ends = Object.values(state.phases).map((p) => p.endedAt ?? Date.now());
	const max = ends.length ? Math.max(...ends) : Date.now();
	return Math.max(0, max - min);
}

/**
 * Phase entries are created lazily when a phase starts, so counting `state.phases`
 * alone reports a total that grows during the run ("0/0" → "1/3"). Graft-promoted
 * phases go the other way: they exist in `state.phases` but never in `def.phases`.
 */
function phaseTotal(state: RunState): number {
	return Math.max(state.def?.phases?.length ?? 0, Object.keys(state.phases).length);
}

export function summarizeRun(state: RunState): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = phaseTotal(state);
	const bits = [`${done}/${total} done`];
	if (running) bits.push(`${running} running`);
	if (failed) bits.push(`${failed} failed`);
	return bits.join(", ");
}

/** Build the detail column for a phase (the right-hand info). */
function phaseDetail(phase: Phase, ps: PhaseState | undefined, theme: Theme, planned?: string): string {
	const detail = phaseDetailInner(phase, ps, theme, planned);
	// Side-effect marker: the phase declared idempotent:false — it is never
	// cached and transient errors are not auto-retried.
	if (ps?.sideEffect) return detail + theme.fg("warning", "  ⚡");
	return detail;
}

function phaseDetailInner(phase: Phase, ps: PhaseState | undefined, theme: Theme, planned?: string): string {
	const type = phase.type ?? "agent";
	// Not started: show what it WILL run as (role + planned model) instead of a
	// dash — the model a step is about to use is the thing users ask for.
	if (!ps || ps.status === "pending") {
		const role = roleOf(phase);
		const model = planned ? theme.fg("dim", `（~${shortModel(planned)}）`) : "";
		return theme.fg("dim", role) + model;
	}

	if (ps.status === "skipped") {
		const reason = (ps.error ?? "upstream failed").replace(/\s+/g, " ");
		const snip = reason.length > 52 ? `${reason.slice(0, 52)}…` : reason;
		return theme.fg("muted", `skipped · ${snip}`) + (ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "");
	}

	const isFanout = type === "map" || type === "parallel" || type === "flow";

	if (ps.status === "failed") {
		const e = (ps.error ?? "failed").replace(/\s+/g, " ");
		const snip = e.length > 56 ? `${e.slice(0, 56)}…` : e;
		const tag = ps.timedOut ? theme.fg("warning", "⏱ ") : "";
		if (isFanout && ps.subProgress) {
			const { done, total, failed } = ps.subProgress;
			return (
				theme.fg("toolOutput", `${done - failed}/${total}`) +
				theme.fg("error", ` ${failed}✗`) +
				(snip ? tag + theme.fg("error", `  ${snip}`) : tag) +
				(ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "")
			);
		}
		return tag + theme.fg("error", snip) + (ps.warnings?.length ? theme.fg("warning", `  ⚠${ps.warnings.length}`) : "");
	}

	const t = ps.status === "running" ? 0 : phaseElapsed(ps);
	const time = t ? theme.fg("dim", elapsed(t)) : "";

	if (ps.status === "running") {
		const roleLabel = agentRole(phase, ps, theme, planned);
		if (isFanout && ps.subProgress) {
			const { done, total, running, failed } = ps.subProgress;
			let s = `${miniBar(done, total, theme)} ${theme.fg("toolOutput", `${done}/${total}`)}`;
			if (running) s += theme.fg("dim", ` · ${running} run`);
			if (failed) s += theme.fg("error", ` · ${failed}✗`);
			s += `  ${roleLabel}`;
			if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
			return s;
		}
		let s = roleLabel;
		if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return s;
	}

	// done
	// Cross-run cache hit: show a compact badge and the $0 cost.
	if (ps.cacheHit === "cross-run") {
		let c = theme.fg("success", "✓") + " " + theme.fg("toolOutput", theme.bold("CACHED")) + theme.fg("dim", " cross-run");
		if (ps.warnings?.length) c += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return c;
	}
	if (isFanout) {
		const { done = 0, total = 0, failed = 0 } = ps.subProgress ?? {};
		let s = theme.fg("success", `${total}✓`);
		if (failed) s = theme.fg("toolOutput", `${done - failed}/${total}`) + theme.fg("error", ` ${failed}✗`);
		const cost = costStr(ps.usage, theme);
		if (cost) s += `  ${cost}`;
		if (time) s += `  ${time}`;
		if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return s;
	}
	// single-agent done
	const roleLabel = agentRole(phase, ps, theme, planned);
	const cost = costStr(ps.usage, theme);
	if (ps.approval) {
		const d = ps.approval.decision;
		const color = d === "reject" ? "error" : d === "edit" ? "warning" : "success";
		let a = theme.fg("warning", "⚠") + " " + theme.fg(color as Parameters<typeof theme.fg>[0], theme.bold(d.toUpperCase()));
		if (ps.approval.auto) a += theme.fg("dim", " auto");
		if (cost) a += `  ${cost}`;
		if (time) a += `  ${time}`;
		if (ps.warnings?.length) a += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return a;
	}
	if (ps.gate) {
		const badge =
			ps.gate.verdict === "block" ? theme.fg("error", theme.bold("BLOCK")) : theme.fg("success", "PASS");
		let g = badge;
		// Scoring gate: show the combined deterministic/judge score next to the verdict.
		if (ps.gate.scores) g += theme.fg("toolOutput", ` ${ps.gate.scores.combined.toFixed(2)}`);
		if (ps.gate.reason) {
			const r = ps.gate.reason.replace(/\s+/g, " ");
			g += theme.fg("dim", ` ${r.length > 44 ? `${r.slice(0, 44)}…` : r}`);
		}
		const cost = costStr(ps.usage, theme);
		if (cost) g += `  ${cost}`;
		if (time) g += `  ${time}`;
		if (ps.warnings?.length) g += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return g;
	}
	if (ps.loop) {
		const stopLabel =
			ps.loop.stop === "until"
				? theme.fg("success", "done")
				: ps.loop.stop === "converged"
					? theme.fg("toolOutput", "converged")
					: ps.loop.stop === "maxIterations"
						? theme.fg("warning", "max")
						: theme.fg("error", "failed");
		let l = theme.fg("toolTitle", `↻${ps.loop.iterations}`) + " " + stopLabel;
		const cost = costStr(ps.usage, theme);
		if (cost) l += `  ${cost}`;
		if (time) l += `  ${time}`;
		if (ps.warnings?.length) l += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return l;
	}
	if (ps.tournament) {
		const { variants, winner, mode } = ps.tournament;
		let w =
			theme.fg("toolTitle", `⚑ ${variants}→`) +
			theme.fg("success", mode === "aggregate" ? "aggregate" : `#${winner}`);
		if (ps.tournament.reason) {
			const r = ps.tournament.reason.replace(/\s+/g, " ");
			w += theme.fg("dim", ` ${r.length > 36 ? `${r.slice(0, 36)}…` : r}`);
		}
		const cost = costStr(ps.usage, theme);
		if (cost) w += `  ${cost}`;
		if (time) w += `  ${time}`;
		if (ps.warnings?.length) w += theme.fg("warning", `  ⚠${ps.warnings.length}`);
		return w;
	}
	let s = roleLabel;
	if (cost) s += `  ${cost}`;
	if (ps.attempts && ps.attempts > 1) s += theme.fg("warning", `  ↻${ps.attempts - 1}`);
	if (time) s += `  ${time}`;
	if (ps.warnings?.length) s += theme.fg("warning", `  ⚠${ps.warnings.length}`);
	return s;
}

/** Header line: static status glyph + name + compact totals (no per-frame animation — see footerLine). */
function headerLine(state: RunState, theme: Theme): string {
	const phases = Object.values(state.phases);
	const done = phases.filter((p) => p.status === "done").length;
	const failed = phases.filter((p) => p.status === "failed").length;
	const running = phases.filter((p) => p.status === "running").length;
	const total = phaseTotal(state);

	const head =
		state.status === "completed"
			? theme.fg("success", "✓")
			: state.status === "failed"
				? theme.fg("error", "✗")
				: state.status === "blocked"
					? theme.fg("error", "⊗")
					: state.status === "paused"
						? theme.fg("warning", "‖")
						: theme.fg("warning", "▸");

	let line =
		`${head} ${theme.fg("toolTitle", theme.bold("taskflow"))} ` +
		theme.fg("accent", state.flowName) +
		theme.fg("muted", `  ${done}/${total}`);
	if (running) line += theme.fg("warning", ` · ${running}▸`);
	if (failed) line += theme.fg("error", ` · ${failed}✗`);
	if (state.status === "blocked") line += theme.fg("error", " · blocked");
	return line;
}

/**
 * Footer line: the last line of the block and the only one carrying
 * time-based content (spinner, run elapsed, cost).
 */
function footerLine(state: RunState, theme: Theme, liveText?: string): string {
	const spin = state.status === "running" ? theme.fg("warning", spinnerFrame()) : theme.fg("dim", "·");
	let line = `  ${spin}`;
	const cost = aggregateCost(state);
	const budget = state.def.budget;
	if (budget?.maxUSD !== undefined) line += theme.fg("muted", ` · ${formatCost(cost)}/$${budget.maxUSD}`);
	else if (cost) line += theme.fg("muted", ` · ${formatCost(cost)}`);
	const usage = formatUsage(aggregateUsage(Object.values(state.phases).map((ps) => ps.usage ?? emptyUsage())));
	if (usage) line += theme.fg("dim", ` · ${usage}`);
	const el = runElapsed(state);
	if (el) line += theme.fg("dim", ` · ${elapsed(el)}`);
	if (liveText) line += theme.fg("muted", ` · › ${liveText.replace(/\s+/g, " ").trim()}`);
	return line;
}

/**
 * Left-gutter rail glyph for a phase at `i` within a parallel group of `size`.
 * A group is a topological layer with >1 phase (they run concurrently); the
 * bracket (┌ ├ └) visually fans them out from the preceding layer. Single-phase
 * layers get a blank gutter so the column stays quiet.
 */
function railGlyph(i: number, size: number): string {
	if (size <= 1) return " ";
	if (i === 0) return "┌";
	if (i === size - 1) return "└";
	return "├";
}

const LABEL_MAX = 40;

/**
 * The full dense progress block: header, DAG-ordered phase rows, footer.
 *
 * `width`, when given, truncates every emitted line (no wrapping — wrapping
 * would break the column grid). `maxRows`, when given (`renderRunResult`
 * passes 14 for its collapsed view, counting the header and footer),
 * collapses the body: running/failed rows and their immediate neighbours are
 * kept, everything else is folded into `… N done · M pending` lines. Omit
 * `maxRows` for an unbounded render (the expanded view, and every other
 * caller that hasn't opted in).
 */
export function renderProgress(
	state: RunState,
	theme: Theme,
	opts?: { width?: number; maxRows?: number; plannedModel?: (phase: Phase) => string | undefined },
): string {
	const phases = state.def.phases;
	const labelOf = (p: Phase) => p.label ?? p.id;
	const idW = Math.min(LABEL_MAX, Math.max(...phases.map((p) => labelOf(p).length), 2));
	const typeW = Math.max(...phases.map((p) => (p.type ?? "agent").length), 4);
	const defIndex = new Map(phases.map((p, i) => [p.id, i]));

	// Render in topological order: each layer is a set of phases that can run
	// concurrently; later layers depend on earlier ones. This makes the DAG's
	// flow legible top-to-bottom without drawing a full graph.
	const layers = topoLayers(phases);
	const rendered = new Set<string>();
	const order: { phase: Phase; rail: string; prevLayerIds: Set<string> }[] = [];

	let prevLayerIds = new Set<string>();
	for (const layer of layers) {
		const ordered = [...layer].sort((a, b) => (defIndex.get(a.id) ?? 0) - (defIndex.get(b.id) ?? 0));
		ordered.forEach((phase, i) => {
			order.push({ phase, rail: railGlyph(i, ordered.length), prevLayerIds });
			rendered.add(phase.id);
		});
		prevLayerIds = new Set(ordered.map((p) => p.id));
	}
	// Safety net: include any phase a malformed DAG left out of the layering.
	for (const phase of phases) {
		if (!rendered.has(phase.id)) order.push({ phase, rail: " ", prevLayerIds });
	}

	const renderRow = (phase: Phase, rail: string, prevLayerIds: Set<string>): string => {
		const ps = state.phases[phase.id];
		const status = ps?.status ?? "pending";
		const id = truncateToWidth(labelOf(phase), idW).padEnd(idW);
		const type = (phase.type ?? "agent").padEnd(typeW);
		const detail = phaseDetail(phase, ps, theme, opts?.plannedModel?.(phase));

		// Annotate only "long" edges — dependencies that skip past the adjacent
		// layer. Edges into the immediately-preceding layer are implied by position
		// (and the rail), so showing them would just add noise. Deps always show
		// ids (not labels) — {steps.<id>} references use ids.
		const longEdges = dependenciesOf(phase).filter((d) => !prevLayerIds.has(d));
		const dep = longEdges.length
			? theme.fg("dim", `  ↳ ${longEdges.join(", ")}`)
			: "";

		const gutter = rail === " " ? " " : theme.fg("borderMuted", rail);
		// "Where is the run right now": occupies the blank cell that already sat
		// between gutter and status glyph, so row width is unchanged.
		const now = status === "running" ? theme.fg("warning", "▸") : " ";
		const label = status === "running" ? theme.bold(theme.fg("text", id)) : theme.fg(status === "pending" ? "dim" : "text", id);
		let row =
			`  ${gutter}${now}${icon(status, theme)} ` +
			label +
			"  " +
			theme.fg("dim", type) +
			"  " +
			detail +
			dep +
			backEdgeAnnotation(phase, ps, theme);

		// Compact tool card puts live activity on its final line. An earlier
		// phase can scroll above the viewport, where edits force a full clear.
		if (!opts?.maxRows && status === "running" && ps?.liveText) {
			const indent = " ".repeat(2 + 2 + 2 + idW + 2);
			const msg = ps.liveText.replace(/\s+/g, " ").trim();
			const snip = msg.length > 88 ? `${msg.slice(0, 88)}…` : msg;
			row += `\n${indent}${theme.fg("dim", "› ")}${theme.fg("muted", snip)}`;
		}
		return row;
	};

	// Collapse the body when it would blow the row budget: keep every
	// running/failed row plus one neighbour on each side, fold contiguous runs
	// of everything else into a single summary line.
	// Capping is opt-in: omitting maxRows renders every phase (existing callers
	// that don't pass opts keep their current unbounded behaviour).
	const maxRows = opts?.maxRows;
	const bodyBudget = maxRows === undefined ? Number.POSITIVE_INFINITY : Math.max(1, maxRows - 2); // header + footer reserve one line each

	const important = new Set<number>();
	order.forEach(({ phase }, i) => {
		const status = state.phases[phase.id]?.status;
		if (status === "running" || status === "failed") important.add(i);
	});
	const keep = new Set<number>();
	for (const i of important) {
		keep.add(i);
		if (i > 0) keep.add(i - 1);
		if (i < order.length - 1) keep.add(i + 1);
	}

	const bodyLines: string[] = [];
	if (order.length <= bodyBudget || keep.size >= order.length) {
		for (const { phase, rail, prevLayerIds } of order) bodyLines.push(renderRow(phase, rail, prevLayerIds));
	} else {
		let foldStart = -1;
		const flushFold = (endExclusive: number) => {
			if (foldStart < 0) return;
			const group = order.slice(foldStart, endExclusive);
			const doneCount = group.filter(({ phase }) => state.phases[phase.id]?.status === "done").length;
			const pendingCount = group.length - doneCount;
			bodyLines.push(theme.fg("dim", `  … ${doneCount} done · ${pendingCount} pending`));
			foldStart = -1;
		};
		order.forEach(({ phase, rail, prevLayerIds }, i) => {
			if (keep.has(i)) {
				flushFold(i);
				bodyLines.push(renderRow(phase, rail, prevLayerIds));
			} else if (foldStart < 0) {
				foldStart = i;
			}
		});
		flushFold(order.length);
	}

	const liveText = maxRows === undefined ? undefined : [...order].reverse().map(({ phase }) => state.phases[phase.id]).find((ps) => ps?.status === "running" && ps.liveText)?.liveText;
	const lines = [headerLine(state, theme), ...bodyLines.flatMap((l) => l.split("\n")), footerLine(state, theme, liveText)];
	const { width } = opts ?? {};
	return (width ? lines.map((l) => truncateToWidth(l, width)) : lines).join("\n");
}

/**
 * Cheap identity for "did anything visible change" — phase statuses, liveText
 * and usage turns cover everything a row can show; the current footer second
 * is folded in so a caller comparing fingerprints still redraws the
 * spinner/elapsed footer on its own 1s tick.
 */
export function renderFingerprint(state: RunState): string {
	const phaseParts = Object.entries(state.phases)
		.map(([id, ps]) => `${id}:${ps.status}:${ps.liveText ?? ""}:${ps.usage?.turns ?? 0}`)
		.join("|");
	return `${state.status}#${phaseParts}#${tick()}`;
}

/** Transcript entries shown per single-agent phase / per fan-out item in the expanded result. */
const TAIL_ENTRIES = 12;
const ITEM_TAIL_ENTRIES = 4;
const MAX_ITEMS = 6;

/**
 * Per-node transcript tails of one run. A node is polled (incrementally) while
 * the run is running, then once more after it finished, then never again.
 */
class TranscriptSet {
	private readonly tails = new Map<string, TranscriptTail | undefined>();
	private readonly settled = new Set<string>();
	private readonly dir: string;
	constructor(dir: string) {
		this.dir = dir;
	}
	entries(nodeId: string, live: boolean): TranscriptEntry[] {
		if (!this.tails.has(nodeId)) {
			let tail: TranscriptTail | undefined;
			try {
				tail = new TranscriptTail(transcriptFileFor(this.dir, nodeId));
			} catch {
				tail = undefined; // unsafe node id: no transcript
			}
			this.tails.set(nodeId, tail);
		}
		const tail = this.tails.get(nodeId);
		if (!tail || this.settled.has(nodeId)) return tail?.entries ?? [];
		tail.poll();
		if (!live) this.settled.add(nodeId);
		return tail.entries;
	}
}

/** pi rebuilds the result component on every update of a running run, always
 * with the same `RunState` object; keying on it keeps the read offsets. */
const transcriptSets = new WeakMap<RunState, TranscriptSet>();

/** Section heading for one phase: status, label, type, role/model/cost and tokens. */
function phaseHeading(phase: Phase, ps: PhaseState | undefined, theme: Theme, planned?: string): string {
	const status = ps?.status ?? "pending";
	const usage = formatUsage(ps?.usage);
	return (
		`${icon(status, theme)} ${theme.bold(theme.fg("text", phase.label ?? phase.id))}  ` +
		theme.fg("dim", phase.type ?? "agent") +
		`  ${phaseDetail(phase, ps, theme, planned)}` +
		(usage ? theme.fg("dim", `  ${usage}`) : "")
	);
}

/**
 * Expanded body of the result card: per phase in definition order, its
 * heading, the tail of its transcript (or its `liveLog` when it has none) and,
 * for a `done` non-final phase, its output. The final phase's output is the
 * caller's `─── Result ───` block.
 */
function renderPhaseSections(
	state: RunState,
	theme: Theme,
	width: number,
	transcripts: TranscriptSet,
	plannedModel?: (phase: Phase) => string | undefined,
): string[] {
	const live = state.status === "running";
	const finalId = state.def.phases.length ? finalPhase(state.def.phases).id : undefined;
	const inner = Math.max(1, width - 2);
	const out: string[] = [];
	const indent = (lines: string[]) => {
		for (const l of lines) out.push(`  ${l}`);
	};
	const tail = (entries: TranscriptEntry[], n: number) =>
		renderTranscript(entries.slice(-n), inner, theme, { expanded: true, cwd: state.cwd });

	for (const phase of state.def.phases) {
		const ps = state.phases[phase.id];
		out.push("");
		out.push(phaseHeading(phase, ps, theme, plannedModel?.(phase)));
		let shown = false;
		const type = phase.type ?? "agent";
		if ((type === "map" || type === "parallel") && ps?.subProgress) {
			const total = ps.subProgress.total;
			for (let i = 0; i < Math.min(total, MAX_ITEMS); i++) {
				const item = ps.items?.[i];
				const label = `[${i + 1}]${item?.agent ? ` ${item.agent}` : ""}`;
				out.push(`  ${icon(item?.status ?? "pending", theme)} ${theme.fg("accent", label)}`);
				const entries = transcripts.entries(`${phase.id}-${i}`, live);
				if (entries.length) {
					indent(tail(entries, ITEM_TAIL_ENTRIES));
					shown = true;
				}
			}
			if (total > MAX_ITEMS) out.push(theme.fg("dim", `  … +${total - MAX_ITEMS} items`));
		} else {
			const entries = transcripts.entries(phase.id, live);
			if (entries.length) {
				indent(tail(entries, TAIL_ENTRIES));
				shown = true;
			}
		}
		if (!shown && ps?.liveLog?.length) {
			out.push(theme.fg("muted", "  ─ recorded activity ─"));
			for (const l of ps.liveLog) out.push(`  ${theme.fg("dim", "› ")}${theme.fg("muted", l)}`);
		}
		if (ps?.status === "done" && phase.id !== finalId && ps.output?.trim()) {
			out.push(theme.fg("muted", "  ─ output ─"));
			indent(new Markdown(ps.output.trim(), 0, 0, getMarkdownTheme()).render(inner));
		}
	}
	return out.map((l) => truncateToWidth(l, width));
}

/**
 * A component wrapping a string-producing render function. Used instead of a
 * pre-built `Text` for the progress block so truncation runs against the real
 * viewport width on every render (`Text` word-wraps, which would break the
 * column grid).
 */
class Lines implements Component {
	private readonly fn: (width: number) => string;
	constructor(fn: (width: number) => string) {
		this.fn = fn;
	}
	render(width: number): string[] {
		return this.fn(width).split("\n");
	}
	/** No-op — `fn` recomputes from `state` every render. */
	invalidate(): void {}
}

export function renderRunResult(
	state: RunState,
	finalOutput: string,
	theme: Theme,
	expanded: boolean,
	plannedModel?: (phase: Phase) => string | undefined,
): Component {
	const progress = new Lines((width) => {
		let text = renderProgress(state, theme, expanded ? { width, plannedModel } : { width, maxRows: 14, plannedModel });
		if (!expanded) text = text.replace(/\n([^\n]*)$/, `\n  ${theme.fg("dim", "Ctrl+O to expand")}\n$1`);
		return text;
	});

	if (!expanded) return progress;

	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(progress);
	let transcripts = transcriptSets.get(state);
	if (!transcripts) {
		transcripts = new TranscriptSet(transcriptDirFor(runsDir(state.cwd), state.flowName, state.runId));
		transcriptSets.set(state, transcripts);
	}
	container.addChild(new Lines((width) => renderPhaseSections(state, theme, width, transcripts, plannedModel).join("\n")));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
	if (finalOutput.trim()) {
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	} else {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	}
	return container;
}
