/**
 * Shared transcript entry vocabulary and the per-host normaliser contract.
 * Every host's raw event stream is mapped to these entries so viewers render
 * one vocabulary regardless of which CLI ran the node.
 */

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
export interface TranscriptThinkingEntry {
	type: "thinking";
	text: string;
}
export interface TranscriptToolCallEntry {
	type: "tool_call";
	name: string;
	summary: string;
	args: Record<string, unknown>;
	toolCallId?: string;
}
export interface TranscriptToolResultEntry {
	type: "tool_result";
	name: string;
	text: string;
	isError: boolean;
	toolCallId?: string;
	durationMs?: number;
	details?: unknown;
}
export type TranscriptEntry =
	| TranscriptAttemptEntry
	| TranscriptTextEntry
	| TranscriptThinkingEntry
	| TranscriptToolCallEntry
	| TranscriptToolResultEntry;

/**
 * Maps one parsed host event to zero or more entries. `st` is a per-file
 * state object (fresh `{}` per transcript) the normaliser may use to carry
 * correlation data across events, e.g. tool timing seen before its result.
 * Unknown events must yield `[]`, never throw.
 */
export type Normaliser<S extends object = object> = (event: Record<string, unknown>, st: S) => TranscriptEntry[];
