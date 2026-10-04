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
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "taskflow-core";

export { TranscriptTail } from "taskflow-core";

/** Tool results are the bulk of a transcript; show a head and count the rest. */
const MAX_RESULT_LINES = 40;

export interface RenderTranscriptOptions {
	/** Uncapped tool results, and wrapping instead of truncation. */
	full?: boolean;
}

export function renderTranscript(
	entries: TranscriptEntry[],
	width: number,
	theme: Theme,
	opts: RenderTranscriptOptions = {},
): string[] {
	const w = Math.max(10, Math.floor(width));
	const out: string[] = [];
	const push = opts.full
		? (line: string) => {
				if (line) out.push(...wrapTextWithAnsi(line, w));
				else out.push("");
			}
		: (line: string) => out.push(truncateToWidth(line, w));
	for (const e of entries) {
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
			case "tool_call":
				push(`${theme.fg("accent", "▸")} ${e.summary}`);
				break;
			case "tool_result": {
				const lines = e.text ? e.text.split("\n") : [];
				const shown = opts.full ? lines : lines.slice(0, MAX_RESULT_LINES);
				const badge = e.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				push(`${badge} ${theme.fg("dim", e.name || "result")}`);
				for (const l of shown) push(theme.fg("dim", l));
				if (lines.length > shown.length) {
					push(theme.fg("muted", `… (+${lines.length - shown.length} lines)`));
				}
				break;
			}
		}
	}
	return out;
}
