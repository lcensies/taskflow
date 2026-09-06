/**
 * Steering channel — the file seam that carries a user message from the host
 * into a running subagent.
 *
 * One append-only JSONL file per node (phase, or fan-out item). The host
 * appends; the taskflow extension loaded INSIDE the child tails the file from a
 * byte offset and delivers each new line to its own session. A plain file is
 * enough because the two sides live in different processes and the child's
 * spawn arguments are fixed once it starts — there is no other channel.
 *
 * Delivery is exactly-once by construction: readers only ever consume bytes
 * past the offset they last reported, and a partial trailing line (a write
 * observed mid-append) is left for the next read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateRunId } from "./store.ts";

/** Per-run steering root: <runsRoot>/steer/<runId>/ */
export function steerDirFor(runsRoot: string, runId: string): string {
	if (!validateRunId(runId)) throw new Error(`Unsafe runId for steer dir: ${runId}`);
	return path.join(runsRoot, "steer", runId);
}

/** Per-node steering file. `nodeId` is sanitized the same way the runtime builds it. */
export function steerFileFor(steerDir: string, nodeId: string): string {
	const safe = nodeId.replace(/[^A-Za-z0-9._-]+/g, "_");
	if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe nodeId for steer file: ${nodeId}`);
	return path.join(steerDir, `${safe}.jsonl`);
}

/** Append one message. Best-effort: a steering write must never break a run. */
export function appendSteerMessage(file: string, text: string): boolean {
	const line = text.trim();
	if (!line) return false;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), text: line })}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

export interface SteerRead {
	messages: string[];
	/** Byte offset to pass to the next read. */
	offset: number;
}

/**
 * Read messages appended after `offset`. A trailing partial line is not
 * consumed: `offset` only advances past complete lines.
 */
export function readSteerMessages(file: string, offset = 0): SteerRead {
	let buf: Buffer;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			if (size <= offset) return { messages: [], offset: Math.min(offset, size) };
			buf = Buffer.alloc(size - offset);
			fs.readSync(fd, buf, 0, buf.length, offset);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { messages: [], offset };
	}
	const text = buf.toString("utf8");
	const lastNl = text.lastIndexOf("\n");
	if (lastNl < 0) return { messages: [], offset };
	const complete = text.slice(0, lastNl);
	const messages: string[] = [];
	for (const line of complete.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { text?: unknown };
			if (typeof parsed.text === "string" && parsed.text.trim()) messages.push(parsed.text);
		} catch {
			// Tolerate a hand-written plain line rather than dropping the message.
			messages.push(line);
		}
	}
	return { messages, offset: offset + Buffer.byteLength(complete, "utf8") + 1 };
}
