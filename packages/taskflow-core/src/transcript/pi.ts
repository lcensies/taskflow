/**
 * Pi `--mode json` normaliser. Entries come from `message_end` messages
 * (authoritative content); `tool_execution_end` only contributes timing,
 * which precedes the `message_end` of the matching toolResult and is
 * attached by `toolCallId`.
 */

import { summarizeToolCall } from "../runner-core.ts";
import type { Normaliser, TranscriptEntry, TranscriptToolResultEntry } from "./types.ts";
import { str } from "./util.ts";

export interface PiNormaliserState {
	durations?: Map<string, number>;
}

/** Best-effort text extraction from a tool result. Hosts vary in whether the
 * result lands in `text`, `output`, `result`, or a nested `content` array
 * (MCP-style `{type:"text",text}` blocks); this tries each in order. */
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

function toolResult(
	st: PiNormaliserState,
	name: string,
	text: string,
	isError: boolean,
	toolCallId: string | undefined,
	details: unknown,
): TranscriptToolResultEntry {
	const entry: TranscriptToolResultEntry = { type: "tool_result", name, text, isError };
	if (toolCallId) {
		entry.toolCallId = toolCallId;
		const durationMs = st.durations?.get(toolCallId);
		if (durationMs !== undefined) {
			entry.durationMs = durationMs;
			st.durations?.delete(toolCallId);
		}
	}
	if (details !== undefined) entry.details = details;
	return entry;
}

export const normalisePi: Normaliser<PiNormaliserState> = (e, st) => {
	if (e.type === "tool_execution_end") {
		const id = str(e.toolCallId);
		if (id && typeof e.durationMs === "number" && Number.isFinite(e.durationMs)) {
			(st.durations ??= new Map()).set(id, e.durationMs);
		}
		return [];
	}
	if (e.type !== "message_end" || !e.message || typeof e.message !== "object") return [];
	const message = e.message as Record<string, unknown>;
	const role = typeof message.role === "string" ? message.role : "";
	if (role === "toolResult") {
		return [
			toolResult(st, str(message.toolName) ?? "", toolResultText(message), Boolean(message.isError), str(message.toolCallId), message.details),
		];
	}
	const entries: TranscriptEntry[] = [];
	const content = Array.isArray(message.content) ? message.content : [];
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			entries.push({ type: "text", role, text: part.text });
		} else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
			entries.push({ type: "thinking", text: part.thinking });
		} else if (part.type === "toolCall") {
			const name = str(part.name) ?? "";
			const args = (part.arguments && typeof part.arguments === "object" ? part.arguments : {}) as Record<string, unknown>;
			const toolCallId = str(part.id) ?? str(part.toolCallId);
			entries.push({ type: "tool_call", name, summary: summarizeToolCall(name, args), args, ...(toolCallId ? { toolCallId } : {}) });
		} else if (part.type === "toolResult") {
			entries.push(
				toolResult(
					st,
					str(part.name) ?? "",
					toolResultText(part),
					Boolean(part.isError),
					str(message.toolCallId) ?? str(part.toolCallId),
					message.details ?? part.details,
				),
			);
		}
	}
	return entries;
};
