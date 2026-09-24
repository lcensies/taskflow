/**
 * Renders a node's parsed transcript for the TUI, and tails its file.
 *
 * `taskflow-core/transcript.ts` owns parsing and the plain-text (peek) format;
 * this is the themed, width-safe variant: every emitted line goes through
 * `truncateToWidth` so pi-tui never throws on an overflowing row. In `full`
 * mode nothing is dropped: result lines are uncapped and overflowing rows are
 * wrapped instead of cut.
 */

import * as fs from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parseTranscript, type TranscriptEntry } from "taskflow-core";

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

/**
 * Incremental reader for a transcript file: `poll()` stats the file and parses
 * only the bytes appended since the last poll, stopping at the last complete
 * line (so a half-written line is re-read next time). A missing or unreadable
 * file yields no entries and never throws.
 */
export class TranscriptTail {
	private accumulated: TranscriptEntry[] = [];
	private offset = 0;
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	get entries(): TranscriptEntry[] {
		return this.accumulated;
	}

	/** True when new entries were appended by this poll. */
	poll(): boolean {
		let size: number;
		try {
			size = fs.statSync(this.file).size;
		} catch {
			return false;
		}
		if (size < this.offset) {
			// File was replaced/truncated — start over.
			this.offset = 0;
			this.accumulated = [];
		}
		if (size <= this.offset) return false;
		let text: string;
		try {
			const fd = fs.openSync(this.file, "r");
			try {
				const buf = Buffer.allocUnsafe(size - this.offset);
				const read = fs.readSync(fd, buf, 0, buf.length, this.offset);
				text = buf.subarray(0, read).toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return false;
		}
		const cut = text.lastIndexOf("\n");
		if (cut < 0) return false;
		const complete = text.slice(0, cut + 1);
		this.offset += Buffer.byteLength(complete);
		const added = parseTranscript(complete);
		if (!added.length) return false;
		this.accumulated = this.accumulated.concat(added);
		return true;
	}
}
