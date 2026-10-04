/**
 * Peek — post-hoc inspection of a run's intermediate phase outputs.
 *
 * The runtime's context-isolation contract only returns the FINAL phase output
 * to the host conversation; every intermediate transcript stays in the
 * persisted RunState. Peek is the explicit, human-invoked escape hatch for
 * debugging: read one phase's output from a stored run, hard-truncated so a
 * peek can never flood the caller's context window.
 *
 * Exposed as `/tf peek <runId> <phaseId>` (pi) and `taskflow_peek` (codex MCP).
 * Read-only: never mutates run state. `followTranscript` is the live variant
 * (`peek --follow <transcriptFile>`), used by the tmux worker window.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OutcomeRecord, PhaseState, RunState } from "./store.ts";
import { loadRun, runsDir, transcriptDirFor, transcriptFileFor } from "./store.ts";
import { formatTranscript, parseTranscript, TranscriptTail, type TranscriptEntry } from "./transcript.ts";

/** Default poll interval while following a transcript (ms). */
export const FOLLOW_POLL_MS = 250;

/** Default hard cap on peeked text (chars). */
export const PEEK_DEFAULT_LIMIT = 4000;
/** Ceiling a caller may raise the limit to. */
export const PEEK_MAX_LIMIT = 32000;

export interface PeekOptions {
	/** Phase to inspect. Omit to get a phase listing for the run. */
	phaseId?: string;
	/** Return the parsed JSON (`ps.json`) instead of the text output. */
	json?: boolean;
	/** For map/parallel phases: extract the 1-based n-th item's section. */
	item?: number;
	/** Truncation cap in chars (default PEEK_DEFAULT_LIMIT, max PEEK_MAX_LIMIT). */
	limit?: number;
	/** Read the node's raw transcript instead of its folded output. Node id is
	 *  the phase id, or `<phase>-<item>` when `item` is set. Tail-truncated
	 *  (oldest content dropped first) so the most recent activity survives. */
	transcript?: boolean;
}

export interface PeekResult {
	ok: boolean;
	/** Human-readable peeked content (or the error / listing). */
	text: string;
	truncated?: boolean;
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return PEEK_DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), PEEK_MAX_LIMIT);
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	return { text: `${text.slice(0, limit)}\n… [truncated at ${limit} chars — total ${text.length}]`, truncated: true };
}

/** Truncate from the front, keeping the most recent (tail) content — used for
 *  transcripts, where the latest activity matters most. */
function truncateTail(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const dropped = text.length - limit;
	return { text: `… [truncated ${dropped} chars from start — total ${text.length}]\n${text.slice(-limit)}`, truncated: true };
}

/** Minimal inline ANSI dim, matching the convention used by peek's other
 *  plain-text consumers (no theme dependency in taskflow-core). */
function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

function fmtStatus(ps: PhaseState): string {
	const bits: string[] = [ps.status];
	if (ps.timedOut) bits.push("timed-out");
	if (ps.cacheHit) bits.push(`cache:${ps.cacheHit}`);
	if (ps.gate) bits.push(`gate:${ps.gate.verdict}`);
	if (ps.subProgress) bits.push(`${ps.subProgress.done}/${ps.subProgress.total} items`);
	return bits.join(" · ");
}

function listPhases(state: RunState): string {
	const lines = state.def.phases.map((p) => {
		const ps = state.phases[p.id];
		const status = ps ? fmtStatus(ps) : "pending";
		const size = ps?.output ? ` — ${ps.output.length} chars` : "";
		const name = p.label ? `${dim(p.id)} · ${p.label}` : p.id;
		return `  ${name} [${status}]${size}`;
	});
	return `Run ${state.runId} (${state.flowName}) — ${state.status}\n\nPhases:\n${lines.join("\n")}\n\nPeek one with: peek ${state.runId} <phaseId>`;
}

/** Split a merged map/parallel output back into its labelled item sections,
 *  keyed by the 1-based position parsed from each "### [k/N]" label — NOT by
 *  section order. mergePhaseState labels positionally but omits budget-skipped
 *  items entirely, so section order can have gaps; keying by label keeps
 *  `--item k` aligned with the original `over[k-1]`. */
export function splitItems(merged: string): Map<number, string> {
	// mergePhaseState labels sections "### [k/N] <agent>" joined by "\n\n---\n\n".
	const out = new Map<number, string>();
	const parts = merged.split(/\n\n---\n\n(?=### \[\d+\/\d+\])/);
	for (const part of parts) {
		const m = part.match(/^### \[(\d+)\/\d+\]/);
		// First label wins on duplicates. Known limitation: an item whose CONTENT
		// embeds the separator + a fake label can shadow a later genuine section —
		// unambiguous splitting needs a collision-free separator in mergePhaseState
		// (tracked as follow-up). Labels keyed positionally so budget-skip gaps
		// never shift indices.
		if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), part);
	}
	return out;
}

/**
 * Peek at a stored run. Pure read: loads the persisted RunState and formats
 * the requested slice, hard-truncated. Never throws on missing data — every
 * miss returns `{ok: false}` with an actionable message.
 */
export function peekRun(cwd: string, runId: string, opts: PeekOptions = {}): PeekResult {
	const state = loadRun(cwd, runId);
	if (!state) return { ok: false, text: `Run not found: ${runId} (see runs with /tf runs)` };

	if (!opts.phaseId) return { ok: true, text: listPhases(state) };

	const ps = state.phases[opts.phaseId];
	if (!ps) {
		const known = state.def.phases.map((p) => p.id).join(", ");
		return { ok: false, text: `Phase '${opts.phaseId}' not found in run ${runId}. Phases: ${known}` };
	}

	const limit = clampLimit(opts.limit);
	const header = `${runId} › ${ps.id} [${fmtStatus(ps)}]${ps.error ? `\nerror: ${ps.error.slice(0, 500)}` : ""}`;

	if (opts.transcript) {
		const nodeId = opts.item !== undefined ? `${ps.id}-${opts.item}` : ps.id;
		const file = transcriptFileFor(transcriptDirFor(runsDir(cwd), state.flowName, runId), nodeId);
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			return { ok: false, text: `No transcript for '${nodeId}' in run ${runId} (transcripts are only recorded while the run executes).` };
		}
		const formatted = formatTranscript(parseTranscript(raw));
		const t = truncateTail(formatted, limit);
		return { ok: true, text: `${header}\n\n${t.text}`, truncated: t.truncated };
	}

	let body: string;
	if (opts.item !== undefined) {
		const items = splitItems(ps.output ?? "");
		if (items.size === 0) return { ok: false, text: `Phase '${ps.id}' has no item sections (not a map/parallel output).` };
		const idx = Math.floor(opts.item);
		const section = items.get(idx);
		if (section === undefined) {
			const available = [...items.keys()].sort((a, b) => a - b).join(", ");
			return { ok: false, text: `Item ${opts.item} not found for phase '${ps.id}' (available: ${available}; budget-skipped items have no section).` };
		}
		body = section;
	} else if (opts.json) {
		if (ps.json === undefined) return { ok: false, text: `Phase '${ps.id}' has no parsed JSON (set output:"json" on the phase, or peek the text output).` };
		try {
			body = JSON.stringify(ps.json, null, 2);
		} catch {
			body = String(ps.json);
		}
	} else {
		if (ps.output === undefined) return { ok: false, text: `Phase '${ps.id}' has no output (status: ${ps.status}).` };
		body = ps.output;
	}

	const t = truncate(body, limit);
	return { ok: true, text: `${header}\n\n${t.text}`, truncated: t.truncated };
}

/** Outcome record a node's follow view reports as "finished" — sibling of the
 *  transcript, the path `outcomeFileFor` writes (both derive from the same
 *  already-sanitized node segment). */
function outcomeFileForTranscript(file: string): string {
	return path.join(path.dirname(file), `${path.basename(file, ".ndjson")}.outcome.json`);
}

function readOutcome(file: string): OutcomeRecord | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const rec = JSON.parse(raw) as OutcomeRecord;
		return rec && typeof rec === "object" && typeof rec.completionSource === "string" ? rec : undefined;
	} catch {
		// Mid-write (a non-atomic writer): treat as not yet present and retry.
		return undefined;
	}
}

function finishedBanner(rec: OutcomeRecord): string {
	const how = rec.signal ? `signal ${rec.signal}` : `exit ${rec.exitCode}`;
	return `─── node finished: ${rec.completionSource} (${how}) ───`;
}

export interface FollowOptions {
	/** Render newly appended entries. Defaults to the host-neutral plain-text
	 *  format; the pi host injects `renderTranscript` so a node looks identical
	 *  in the follow view and in the inspector. */
	render?: (entries: TranscriptEntry[]) => string[];
	/** Override the outcome record path (default: sibling of the transcript). */
	outcomeFile?: string;
}

/**
 * Tails one node's transcript, emitting each entry exactly once, and reports
 * the node finished when its outcome record appears.
 *
 * Non-blocking and step-wise so the caller owns the clock: `step()` polls the
 * file once and returns only the rows not yet emitted. A transcript that does
 * not exist yet is not an error — it yields no rows, and the caller keeps
 * stepping until the worker writes.
 */
export class TranscriptFollower {
	private readonly tail: TranscriptTail;
	private readonly render: (entries: TranscriptEntry[]) => string[];
	private emitted = 0;
	private done = false;
	readonly outcomeFile: string;
	readonly file: string;

	constructor(file: string, opts: FollowOptions = {}) {
		this.file = file;
		this.tail = new TranscriptTail(file);
		this.render = opts.render ?? ((entries) => formatTranscript(entries).split("\n"));
		this.outcomeFile = opts.outcomeFile ?? outcomeFileForTranscript(file);
	}

	/** One poll. `done` is true once the finished banner has been emitted. */
	step(): { lines: string[]; done: boolean } {
		if (this.done) return { lines: [], done: true };
		this.tail.poll();
		const lines = this.drain();
		const rec = readOutcome(this.outcomeFile);
		if (!rec) return { lines, done: false };
		// Flush whatever the worker wrote between that poll and the record, so
		// the banner is always the last row.
		this.tail.poll();
		lines.push(...this.drain(), finishedBanner(rec));
		this.done = true;
		return { lines, done: true };
	}

	private drain(): string[] {
		const entries = this.tail.entries;
		if (entries.length <= this.emitted) return [];
		const added = entries.slice(this.emitted);
		this.emitted = entries.length;
		return this.render(added);
	}
}

export interface FollowTranscriptOptions extends FollowOptions {
	/** Row sink (default: stdout, one row per line). */
	write?: (line: string) => void;
	/** Poll interval in ms (default FOLLOW_POLL_MS). */
	intervalMs?: number;
	/** Stop following early. */
	signal?: AbortSignal;
}

/** `peek --follow <transcriptFile>`: render a node's transcript as it is
 *  written, until its outcome record appears (or the caller aborts). Read-only
 *  — it touches neither the transcript, the run state, nor the worker. */
export async function followTranscript(file: string, opts: FollowTranscriptOptions = {}): Promise<void> {
	const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const interval = opts.intervalMs ?? FOLLOW_POLL_MS;
	const follower = new TranscriptFollower(file, opts);
	for (;;) {
		const { lines, done } = follower.step();
		for (const line of lines) write(line);
		if (done || opts.signal?.aborted) return;
		try {
			await delay(interval, undefined, { signal: opts.signal });
		} catch {
			return; // aborted
		}
	}
}
