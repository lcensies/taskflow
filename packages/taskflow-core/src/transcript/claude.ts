/**
 * Claude Code `stream-json` normaliser. `assistant` events carry
 * text / thinking / tool_use blocks; `user` events carry tool_result blocks
 * keyed by `tool_use_id`. Synthetic assistant messages (model `<synthetic>`,
 * harness diagnostics) and `system` / `result` / unknown events are skipped.
 * Entries keep Claude's native tool name; only the summary maps it onto the
 * shared verbs. Claude reports no per-tool timing.
 */

import { summarizeToolCall } from "../runner-core.ts";
import type { Normaliser, TranscriptEntry } from "./types.ts";
import { contentText, obj, str } from "./util.ts";

export interface ClaudeNormaliserState {
	/** tool_use id → tool name, so a result can name its tool. */
	names?: Map<string, string>;
}

const SUMMARY_NAMES: Record<string, string> = {
	Bash: "bash",
	Read: "read",
	Edit: "edit",
	Write: "write",
	Grep: "grep",
	Glob: "find",
};

const blocks = (e: Record<string, unknown>): Record<string, unknown>[] => {
	const content = obj(e.message)?.content;
	return Array.isArray(content) ? content.flatMap((b): Record<string, unknown>[] => {
				const o = obj(b);
				return o ? [o] : [];
			}) : [];
};

export const normaliseClaude: Normaliser<ClaudeNormaliserState> = (e, st) => {
	const entries: TranscriptEntry[] = [];
	if (e.type === "assistant") {
		if (obj(e.message)?.model === "<synthetic>") return [];
		for (const b of blocks(e)) {
			if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
				entries.push({ type: "text", role: "assistant", text: b.text });
			} else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
				entries.push({ type: "thinking", text: b.thinking });
			} else if (b.type === "tool_use") {
				const name = str(b.name) ?? "";
				const args = obj(b.input) ?? {};
				const toolCallId = str(b.id);
				if (toolCallId) (st.names ??= new Map()).set(toolCallId, name);
				entries.push({
					type: "tool_call",
					name,
					summary: summarizeToolCall(SUMMARY_NAMES[name] ?? name, args),
					args,
					...(toolCallId ? { toolCallId } : {}),
				});
			}
		}
	} else if (e.type === "user") {
		for (const b of blocks(e)) {
			if (b.type !== "tool_result") continue;
			const toolCallId = str(b.tool_use_id);
			entries.push({
				type: "tool_result",
				name: (toolCallId && st.names?.get(toolCallId)) || "",
				text: contentText(b.content),
				isError: b.is_error === true,
				...(toolCallId ? { toolCallId } : {}),
			});
		}
	}
	return entries;
};
