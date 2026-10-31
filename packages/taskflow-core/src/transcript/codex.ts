/**
 * Codex `exec --json` normaliser. Only `item.started` / `item.completed`
 * carry content:
 *   - `agent_message` → text, `reasoning` → thinking (on completion only)
 *   - `command_execution` / `file_change` / `mcp_tool_call` → a tool_call on
 *     first sight of the item id (started, or completed without a start) and
 *     a tool_result on completion. Codex reports no tool timing, so
 *     `durationMs` stays unset.
 * Other item types (web_search, todo_list, error, …) and event types are skipped.
 */

import { summarizeToolCall } from "../runner-core.ts";
import type { Normaliser, TranscriptEntry, TranscriptToolCallEntry, TranscriptToolResultEntry } from "./types.ts";
import { contentText, obj, str } from "./util.ts";

export interface CodexNormaliserState {
	/** Ids whose tool_call was already emitted by `item.started`. */
	started?: Set<string>;
}

function paths(item: Record<string, unknown>): { path: string; kind: string }[] {
	const changes = Array.isArray(item.changes) ? item.changes : [];
	return changes.flatMap((c) => {
		const path = str(obj(c)?.path);
		return path ? [{ path, kind: str(obj(c)?.kind) ?? "update" }] : [];
	});
}

function toolCall(item: Record<string, unknown>, toolCallId: string | undefined): TranscriptToolCallEntry | undefined {
	const id = toolCallId ? { toolCallId } : {};
	switch (item.type) {
		case "command_execution": {
			const args = { command: str(item.command) ?? "" };
			return { type: "tool_call", name: "command_execution", summary: summarizeToolCall("bash", args), args, ...id };
		}
		case "file_change": {
			const changes = paths(item);
			const summary = summarizeToolCall("edit", { path: changes.map((c) => c.path).join(", ") });
			return { type: "tool_call", name: "file_change", summary, args: { changes }, ...id };
		}
		case "mcp_tool_call": {
			const name = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`;
			return { type: "tool_call", name, summary: name, args: obj(item.arguments) ?? {}, ...id };
		}
		default:
			return undefined;
	}
}

function toolResult(item: Record<string, unknown>, name: string, toolCallId: string | undefined): TranscriptToolResultEntry {
	const failed = item.status === "failed" || item.status === "declined";
	let text: string;
	let isError: boolean;
	if (item.type === "command_execution") {
		text = str(item.aggregated_output) ?? "";
		isError = typeof item.exit_code === "number" ? item.exit_code !== 0 : failed;
	} else if (item.type === "file_change") {
		text = paths(item)
			.map((c) => `${c.kind} ${c.path}`)
			.join("\n");
		isError = failed;
	} else {
		const error = item.error;
		text = error ? (str(obj(error)?.message) ?? contentText(error)) : contentText(item.result);
		isError = Boolean(error) || failed;
	}
	return { type: "tool_result", name, text, isError, ...(toolCallId ? { toolCallId } : {}) };
}

export const normaliseCodex: Normaliser<CodexNormaliserState> = (e, st) => {
	if (e.type !== "item.started" && e.type !== "item.completed") return [];
	const item = obj(e.item);
	if (!item) return [];
	const completed = e.type === "item.completed";
	if (item.type === "agent_message" || item.type === "reasoning") {
		const text = str(item.text);
		if (!completed || !text?.trim()) return [];
		return [item.type === "agent_message" ? { type: "text", role: "assistant", text } : { type: "thinking", text }];
	}
	const id = str(item.id);
	const call = toolCall(item, id);
	if (!call) return [];
	const out: TranscriptEntry[] = [];
	if (!id || !st.started?.has(id)) out.push(call);
	if (completed) {
		out.push(toolResult(item, call.name, id));
		if (id) st.started?.delete(id);
	} else if (id) {
		(st.started ??= new Set()).add(id);
	}
	return out;
};
