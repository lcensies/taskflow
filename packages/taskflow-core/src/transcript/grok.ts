/**
 * Grok Build `streaming-json` normaliser — text and thinking only: the
 * headless stream has no tool events (`text` / `thought` / `end` / `error` /
 * `max_turns_reached` / `auto_compact_*`), so no tool_call or tool_result
 * entries are produced.
 *
 * `text` and `thought` events are chunks of one segment; consecutive chunks of
 * the same kind are buffered and emitted as one entry when the kind changes or
 * the turn ends (`end` / `error` / `max_turns_reached`). Like a pi message
 * without `message_end`, a segment still open when the stream stops (killed
 * child, read mid-write) is not emitted. Other events are skipped and do not
 * split a segment.
 */

import type { Normaliser, TranscriptEntry } from "./types.ts";

export interface GrokNormaliserState {
	pending?: { type: "text" | "thinking"; text: string };
	sawText?: boolean;
}

function flush(st: GrokNormaliserState): TranscriptEntry[] {
	const p = st.pending;
	st.pending = undefined;
	if (!p?.text.trim()) return [];
	return [p.type === "text" ? { type: "text", role: "assistant", text: p.text } : { type: "thinking", text: p.text }];
}

export const normaliseGrok: Normaliser<GrokNormaliserState> = (e, st) => {
	const kind = e.type === "text" ? "text" : e.type === "thought" ? "thinking" : undefined;
	if (kind) {
		const data = typeof e.data === "string" ? e.data : "";
		if (kind === "text" && data) st.sawText = true;
		if (st.pending?.type === kind) {
			st.pending.text += data;
			return [];
		}
		const out = flush(st);
		st.pending = { type: kind, text: data };
		return out;
	}
	if (e.type !== "end" && e.type !== "error" && e.type !== "max_turns_reached") return [];
	const out = flush(st);
	// Some builds put the whole answer on `end` instead of streaming it.
	if (e.type === "end" && !st.sawText && typeof e.text === "string" && e.text.trim()) {
		out.push({ type: "text", role: "assistant", text: e.text });
	}
	return out;
};
