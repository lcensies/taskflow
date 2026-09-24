/**
 * Parses a run node's raw NDJSON transcript file (the child's untouched event
 * stream, teed by `onRawLine`, plus `taskflow_attempt` retry markers) into a
 * flat, ordered list of renderable entries. Host-neutral and UI-free: the
 * pi host's transcript viewer (peek/inspector/runs-view) renders these; this
 * module only parses.
 */

import { summarizeToolCall } from "./runner-core.ts";

export interface TranscriptAttemptEntry {
	type: "attempt";
	attempt: number;
	at?: number;
}
export interface TranscriptTextEntry {
	type: "text";
	role: string;
	text: string;
}
export interface TranscriptToolCallEntry {
	type: "tool_call";
	name: string;
	summary: string;
	args: Record<string, unknown>;
}
export interface TranscriptToolResultEntry {
	type: "tool_result";
	name: string;
	text: string;
	isError: boolean;
}
export type TranscriptEntry =
	| TranscriptAttemptEntry
	| TranscriptTextEntry
	| TranscriptToolCallEntry
	| TranscriptToolResultEntry;

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
			case "tool_call":
				return `\u25b8 ${e.summary}`;
			case "tool_result":
				return `${e.isError ? "\u2717" : "\u2713"} ${e.name || "result"}: ${e.text}`;
		}
	});
	return blocks.join("\n\n");
}

/** Best-effort text extraction from a tool-result content part. Hosts vary in
 * whether the result lands in `text`, `output`, `result`, or a nested `content`
 * array (MCP-style `{type:"text",text}` blocks); this tries each in order. */
function toolResultText(part: Record<string, unknown>): string {
	if (typeof part.text === "string") return part.text;
	if (typeof part.output === "string") return part.output;
	if (typeof part.result === "string") return part.result;
	const content = part.content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
			.filter(Boolean)
			.join("\n");
	}
	const fallback = part.result ?? part.output ?? "";
	if (!fallback) return "";
	try { return JSON.stringify(fallback); } catch { return String(fallback); }
}

/**
 * Parse a transcript file's full text into ordered entries. Tolerant of a
 * partial trailing line (the file may be read mid-write): a line that fails
 * to parse as JSON is silently skipped rather than throwing, wherever it
 * occurs in the file — matching `foldEventLine`'s tolerance of noise.
 */
export function parseTranscript(text: string): TranscriptEntry[] {
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
		if (e.type === "taskflow_attempt") {
			const attempt = Number(e.attempt);
			entries.push({
				type: "attempt",
				attempt: Number.isFinite(attempt) ? attempt : 0,
				at: typeof e.at === "number" ? e.at : undefined,
			});
			continue;
		}
		if (e.type !== "message_end" || !e.message || typeof e.message !== "object") continue;
		const message = e.message as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "";
		const content = Array.isArray(message.content) ? message.content : [];
		for (const rawPart of content) {
			if (!rawPart || typeof rawPart !== "object") continue;
			const part = rawPart as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
				entries.push({ type: "text", role, text: part.text });
			} else if (part.type === "toolCall") {
				const name = typeof part.name === "string" ? part.name : "";
				const args = (part.arguments && typeof part.arguments === "object" ? part.arguments : {}) as Record<string, unknown>;
				entries.push({ type: "tool_call", name, summary: summarizeToolCall(name, args), args });
			} else if (part.type === "toolResult") {
				const name = typeof part.name === "string" ? part.name : "";
				entries.push({ type: "tool_result", name, text: toolResultText(part), isError: Boolean(part.isError) });
			}
		}
	}
	return entries;
}
