/**
 * Child-side half of the steering channel.
 *
 * Runs INSIDE a spawned subagent (the dual-identity branch of index.ts) and
 * tails the per-node steer file the host appends to, delivering each new
 * message into this session as a user message.
 */

import * as fs from "node:fs";
import { readSteerMessages } from "taskflow-core";

export interface SteerWatcherOptions {
	file: string;
	/** Byte offset the spawning runner already consumed into the task prompt. */
	offset?: number;
	deliver: (text: string) => void;
	/** fs.watch misses events on network/overlay filesystems; poll as well. */
	pollMs?: number;
}

/** Start tailing `file`. Returns a dispose function. */
export function startSteerWatcher(opts: SteerWatcherOptions): () => void {
	let offset = opts.offset ?? 0;
	let disposed = false;

	const drain = () => {
		if (disposed) return;
		const read = readSteerMessages(opts.file, offset);
		offset = read.offset;
		for (const message of read.messages) {
			try {
				opts.deliver(message);
			} catch {
				// A finished/disposed session must not crash the child.
			}
		}
	};

	const timer = setInterval(drain, opts.pollMs ?? 1000);
	(timer as { unref?: () => void }).unref?.();

	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fs.watch(opts.file, { persistent: false }, drain);
	} catch {
		// The file may not exist until the first message; the poll covers it.
	}

	return () => {
		disposed = true;
		clearInterval(timer);
		watcher?.close();
	};
}
