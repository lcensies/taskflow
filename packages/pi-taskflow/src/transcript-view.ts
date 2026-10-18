/**
 * Renders a node's parsed transcript for the TUI.
 *
 * `taskflow-core/transcript.ts` owns parsing, the plain-text (peek) format and
 * the incremental file tail (`TranscriptTail`, re-exported here so the
 * inspector and `peek --follow` read a transcript the same way); this is the
 * themed, width-safe renderer: every emitted line goes through
 * `truncateToWidth` so pi-tui never throws on an overflowing row. In `full`
 * mode nothing is dropped: result lines are uncapped and overflowing rows are
 * wrapped instead of cut.
 *
 * A pi built-in tool's call/result pair renders through that tool's own
 * `renderCall`/`renderResult` (diffs for `edit`, previews for `bash`, …); any
 * other tool, or a built-in whose renderer is missing or throws, renders as
 * the summary row plus dimmed result lines.
 */

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripControlSequences, stripTerminalControls } from "taskflow-core";
import type { TranscriptEntry, TranscriptToolCallEntry, TranscriptToolResultEntry } from "taskflow-core";

export { TranscriptTail } from "taskflow-core";

/** Tool results are the bulk of a transcript; show a head and count the rest. */
const MAX_RESULT_LINES = 40;

export type ToolRenderers = Pick<ToolDefinition, "renderCall" | "renderResult">;

export interface RenderTranscriptOptions {
	/** Uncapped tool results, and wrapping instead of truncation. */
	full?: boolean;
	/** Passed to pi's tool renderers as `expanded`; thinking shows every line. */
	expanded?: boolean;
	/** Working directory handed to pi's tool renderers (path display). */
	cwd?: string;
	/** Renderers by tool name; defaults to pi's built-ins for `cwd`. */
	toolRenderers?: (cwd: string) => Record<string, ToolRenderers | undefined>;
}

/** Factory export per built-in tool. Looked up on the namespace so a pi that
 * lacks one degrades to the fallback row instead of failing this import. */
const BUILT_IN_FACTORIES: Record<string, string> = {
	bash: "createBashToolDefinition",
	read: "createReadToolDefinition",
	write: "createWriteToolDefinition",
	edit: "createEditToolDefinition",
	grep: "createGrepToolDefinition",
	find: "createFindToolDefinition",
	ls: "createLsToolDefinition",
};

const builtInsByCwd = new Map<string, Record<string, ToolRenderers>>();

/** pi's built-in tool definitions for `cwd`, created once per cwd. */
export function builtInToolRenderers(cwd: string): Record<string, ToolRenderers> {
	let defs = builtInsByCwd.get(cwd);
	if (defs) return defs;
	defs = {};
	const ns = piCodingAgent as unknown as Record<string, unknown>;
	for (const [name, factory] of Object.entries(BUILT_IN_FACTORIES)) {
		const create = ns[factory];
		if (typeof create !== "function") continue;
		try {
			defs[name] = (create as (cwd: string) => ToolRenderers)(cwd);
		} catch {
			// This tool falls back to the summary row.
		}
	}
	builtInsByCwd.set(cwd, defs);
	return defs;
}

const isBlank = (line: string): boolean => !stripControlSequences(line);

/** Transcript strings are subagent-authored and JSON may decode to a raw ESC
 * (OSC 52 clipboard, title, CSI): strip terminal controls from every string —
 * text, summary, args, details — before it is styled or handed to pi. */
function sanitize<T>(value: T): T {
	if (typeof value === "string") return stripTerminalControls(value) as T;
	if (Array.isArray(value)) return value.map(sanitize) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) as T;
	}
	return value;
}

const durationSuffix = (r: TranscriptToolResultEntry | undefined): string =>
	r?.durationMs === undefined ? "" : ` · ${(r.durationMs / 1000).toFixed(1)}s`;

/** Index of each tool_call's result: the next unclaimed tool_result sharing
 * its `toolCallId`, or simply the next one when either side has no id. An
 * attempt marker ends the search — a retry never answers an earlier call. */
function pairResults(entries: TranscriptEntry[]): Map<number, number> {
	const pairs = new Map<number, number>();
	const claimed = new Set<number>();
	for (let i = 0; i < entries.length; i++) {
		const call = entries[i];
		if (call?.type !== "tool_call") continue;
		for (let j = i + 1; j < entries.length; j++) {
			const r = entries[j];
			if (r?.type === "attempt") break;
			if (r?.type !== "tool_result" || claimed.has(j)) continue;
			if (call.toolCallId && r.toolCallId && call.toolCallId !== r.toolCallId) continue;
			pairs.set(i, j);
			claimed.add(j);
			break;
		}
	}
	return pairs;
}

/** The pair through pi's own renderers, or undefined to use the fallback. */
function renderNative(
	call: TranscriptToolCallEntry,
	result: TranscriptToolResultEntry | undefined,
	width: number,
	theme: Theme,
	opts: RenderTranscriptOptions,
): string[] | undefined {
	try {
		const cwd = opts.cwd ?? process.cwd();
		const def = (opts.toolRenderers ?? builtInToolRenderers)(cwd)[call.name];
		if (!def?.renderCall || !def.renderResult) return undefined;
		const expanded = opts.expanded ?? false;
		// One state object per pair: renderers share it between call and result
		// (edit moves its diff into the call component from renderResult).
		const ctx = {
			args: call.args,
			toolCallId: call.toolCallId ?? "",
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd,
			// Not started / args incomplete: no live timers and no edit-preview file reads.
			executionStarted: false,
			argsComplete: false,
			isPartial: false,
			expanded,
			showImages: false,
			isError: result?.isError ?? false,
		};
		const callComponent = def.renderCall(call.args, theme, ctx);
		const resultComponent = result
			? def.renderResult(
					{ content: [{ type: "text", text: result.text }], details: result.details },
					{ expanded, isPartial: false },
					theme,
					ctx,
				)
			: undefined;
		const suffix = durationSuffix(result);
		const lines = callComponent.render(Math.max(1, width - visibleWidth(suffix)));
		if (suffix) {
			const header = lines.findIndex((l) => !isBlank(l));
			if (header >= 0) lines[header] += theme.fg("dim", suffix);
		}
		if (resultComponent) lines.push(...resultComponent.render(width));
		return lines;
	} catch {
		return undefined;
	}
}

export function renderTranscript(
	entries: TranscriptEntry[],
	width: number,
	theme: Theme,
	opts: RenderTranscriptOptions = {},
): string[] {
	entries = entries.map(sanitize);
	const w = Math.max(10, Math.floor(width));
	const out: string[] = [];
	const push = opts.full
		? (line: string) => {
				if (line) out.push(...wrapTextWithAnsi(line, w));
				else out.push("");
			}
		: (line: string) => out.push(truncateToWidth(line, w));
	const pushResult = (e: TranscriptToolResultEntry) => {
		const lines = e.text ? e.text.split("\n") : [];
		const shown = opts.full ? lines : lines.slice(0, MAX_RESULT_LINES);
		const badge = e.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		push(`${badge} ${theme.fg("dim", `${e.name || "result"}${durationSuffix(e)}`)}`);
		for (const l of shown) push(theme.fg("dim", l));
		if (lines.length > shown.length) {
			push(theme.fg("muted", `… (+${lines.length - shown.length} lines)`));
		}
	};
	const pairs = pairResults(entries);
	const paired = new Set(pairs.values());
	for (const [i, e] of entries.entries()) {
		if (paired.has(i)) continue;
		if (out.length) push("");
		switch (e.type) {
			case "attempt":
				push(theme.fg("muted", `─── attempt ${e.attempt} ───`));
				break;
			case "text":
				push(theme.fg("dim", `[${e.role || "assistant"}]`));
				for (const raw of e.text.split("\n")) {
					if (!raw.trim()) {
						push("");
						continue;
					}
					for (const l of wrapTextWithAnsi(raw, w)) push(l);
				}
				break;
			case "thinking":
				if (opts.full || opts.expanded) {
					push(theme.fg("dim", "∴ thinking"));
					for (const raw of e.text.split("\n")) {
						for (const l of raw.trim() ? wrapTextWithAnsi(raw, w) : [""]) push(theme.fg("dim", l));
					}
				} else {
					const first = e.text.split("\n").find((l) => l.trim()) ?? "";
					push(theme.fg("dim", `∴ thinking ${first.trim()}`));
				}
				break;
			case "tool_call": {
				const j = pairs.get(i);
				const result = j === undefined ? undefined : (entries[j] as TranscriptToolResultEntry);
				const native = renderNative(e, result, w, theme, opts);
				if (native) {
					for (const l of native) push(l);
					break;
				}
				push(`${theme.fg("accent", "▸")} ${e.summary}`);
				if (result) pushResult(result);
				break;
			}
			case "tool_result":
				pushResult(e);
				break;
		}
	}
	return out;
}
