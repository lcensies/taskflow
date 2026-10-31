/**
 * OpenCode `run --format json` normaliser. `text` parts → text; a `tool_use`
 * part → tool_call on first sight of its `callID` (or part `id`) and
 * tool_result once `state.status` is `completed` or `error`. OpenCode's
 * stream carries no thinking and no per-tool timing; other events are skipped.
 * Entries keep OpenCode's tool name; only the summary maps it onto the shared
 * verbs (`glob`→find, `list`→ls, `filePath`→path).
 */

import { summarizeToolCall } from "../runner-core.ts";
import type { Normaliser, TranscriptEntry } from "./types.ts";
import { contentText, obj, str } from "./util.ts";

export interface OpencodeNormaliserState {
	/** Call ids whose tool_call was already emitted. */
	calls?: Set<string>;
}

const SUMMARY_NAMES: Record<string, string> = { glob: "find", list: "ls" };

export const normaliseOpencode: Normaliser<OpencodeNormaliserState> = (e, st) => {
	const part = obj(e.part);
	if (!part) return [];
	if (e.type === "text") {
		return typeof part.text === "string" && part.text.trim() ? [{ type: "text", role: "assistant", text: part.text }] : [];
	}
	if (e.type !== "tool_use") return [];
	const name = str(part.tool) ?? "tool";
	const state = obj(part.state) ?? {};
	const args = obj(state.input) ?? {};
	const toolCallId = str(part.callID) ?? str(part.id);
	const id = toolCallId ? { toolCallId } : {};
	const entries: TranscriptEntry[] = [];
	if (!toolCallId || !st.calls?.has(toolCallId)) {
		const summaryArgs = typeof args.filePath === "string" ? { ...args, path: args.filePath } : args;
		entries.push({ type: "tool_call", name, summary: summarizeToolCall(SUMMARY_NAMES[name] ?? name, summaryArgs), args, ...id });
	}
	if (state.status === "completed" || state.status === "error") {
		const isError = state.status === "error";
		entries.push({ type: "tool_result", name, text: contentText(isError ? state.error : state.output), isError, ...id });
		if (toolCallId) st.calls?.delete(toolCallId);
	} else if (toolCallId) {
		(st.calls ??= new Set()).add(toolCallId);
	}
	return entries;
};
