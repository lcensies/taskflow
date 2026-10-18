/**
 * Parses a run node's raw NDJSON transcript file (the child's untouched event
 * stream, teed by `onRawLine`, plus `taskflow_attempt` retry markers) into a
 * flat, ordered list of renderable entries. Host-neutral and UI-free: the
 * pi host's transcript viewer (peek/inspector/runs-view) renders these; this
 * module only parses.
 */

import * as fs from "node:fs";
import { normaliseClaude } from "./transcript/claude.ts";
import { normaliseCodex } from "./transcript/codex.ts";
import { normaliseGrok } from "./transcript/grok.ts";
import { normaliseOpencode } from "./transcript/opencode.ts";
import { normalisePi } from "./transcript/pi.ts";
import type { Normaliser, TranscriptEntry } from "./transcript/types.ts";

export type {
	Normaliser,
	TranscriptAttemptEntry,
	TranscriptEntry,
	TranscriptTextEntry,
	TranscriptThinkingEntry,
	TranscriptToolCallEntry,
	TranscriptToolResultEntry,
} from "./transcript/types.ts";

/** Host normalisers keyed by the header's `host`; unknown hosts fall back to pi. */
const NORMALISERS: Record<string, Normaliser> = {
	pi: normalisePi,
	codex: normaliseCodex,
	claude: normaliseClaude,
	opencode: normaliseOpencode,
	grok: normaliseGrok,
};

const firstLine = (s: string): string => {
	const line = s.trim().split("\n", 1)[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 80)}\u2026` : line;
};

/** Render parsed entries as plain text (no theming/colour) — used by `peek`
 * and any other host-neutral consumer. UI-rich rendering (wrapping, dim
 * results, width safety) lives in the pi host's transcript-view instead. */
export function formatTranscript(entries: TranscriptEntry[]): string {
	const blocks = entries.map((e) => {
		switch (e.type) {
			case "attempt":
				return `--- attempt ${e.attempt} ---`;
			case "text":
				return `[${e.role || "assistant"}] ${e.text}`;
			case "thinking":
				return `\u2234 thinking: ${firstLine(e.text)}`;
			case "tool_call":
				return `\u25b8 ${e.summary}`;
			case "tool_result": {
				const duration = e.durationMs === undefined ? "" : ` \u00b7 ${(e.durationMs / 1000).toFixed(1)}s`;
				return `${e.isError ? "\u2717" : "\u2713"} ${e.name || "result"}${duration}: ${e.text}`;
			}
		}
	});
	return blocks.join("\n\n");
}

/**
 * Stateful line parser for one transcript file. A
 * `{"type":"taskflow_transcript","host":...}` header selects the host
 * normaliser for the lines after it (the tee writes one per attempt, after
 * the runtime's `taskflow_attempt` marker); a headerless file is pi.
 * Normaliser state (e.g. pi tool timing) persists across `push` calls so an
 * incremental reader sees the same entries as a one-shot parse, and is reset
 * on every header so nothing left open by one attempt leaks into the next.
 */
class TranscriptParser {
	private normalise: Normaliser = normalisePi;
	private state: object = {};

	/** Parse `text` line by line; a line that is not valid JSON (e.g. a
	 * partial trailing line read mid-write) is skipped, never thrown on. */
	push(text: string): TranscriptEntry[] {
		const entries: TranscriptEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (!event || typeof event !== "object") continue;
			const e = event as Record<string, unknown>;
			if (e.type === "taskflow_transcript") {
				const host = typeof e.host === "string" ? e.host : "pi";
				this.normalise = NORMALISERS[host] ?? normalisePi;
				this.state = {};
				continue;
			}
			if (e.type === "taskflow_attempt") {
				const attempt = Number(e.attempt);
				entries.push({
					type: "attempt",
					attempt: Number.isFinite(attempt) ? attempt : 0,
					at: typeof e.at === "number" ? e.at : undefined,
				});
				continue;
			}
			entries.push(...this.normalise(e, this.state));
		}
		return entries;
	}
}

/**
 * Parse a transcript file's full text into ordered entries. Tolerant of a
 * partial trailing line (the file may be read mid-write): a line that fails
 * to parse as JSON is silently skipped rather than throwing, wherever it
 * occurs in the file — matching `foldEventLine`'s tolerance of noise.
 */
export function parseTranscript(text: string): TranscriptEntry[] {
	return new TranscriptParser().push(text);
}

/**
 * Incremental reader for a transcript file: `poll()` stats the file and parses
 * only the bytes appended since the last poll, stopping at the last complete
 * line (so a half-written line is re-read next time). A missing or unreadable
 * file yields no entries and never throws — a follower can poll before the
 * worker has written anything.
 */
export class TranscriptTail {
	private accumulated: TranscriptEntry[] = [];
	private offset = 0;
	private parser = new TranscriptParser();
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
			this.parser = new TranscriptParser();
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
		const added = this.parser.push(complete);
		if (!added.length) return false;
		this.accumulated = this.accumulated.concat(added);
		return true;
	}
}
