/** Operator-acknowledged recovery of orphaned mutex namespaces: a queue
 * directory with no `.identity` anchor. bindMutexQueue must keep refusing this
 * state, because only an operator can assert that no pre-anchor (legacy) writer
 * is active. Namespaces a live process still owns are refused here too. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mutexNamespacePaths } from "./mutex-bootstrap.ts";
import {
	defaultProcessIdentity,
	defaultProcessInspector,
	fsyncDirectory,
	isPersistedOwnerStale,
	type ProcessIdentity,
	type ProcessInspector,
} from "./persistence.ts";

export interface MutexNamespaceRepair {
	queue: string;
	action: "removed" | "preserved" | "untouched";
	detail: string;
	preserved: Array<{ from: string; to: string }>;
}

export interface MutexRepairOptions {
	processIdentity?: ProcessIdentity;
	inspectProcess?: ProcessInspector;
	now?: () => number;
}

interface NamespacePlan {
	queue: string;
	/** Anchored or otherwise not an orphan: never modified. */
	untouched?: string;
	entries: string[];
	siblings: string[];
	/** Reasons this namespace must not be repaired (live owner, not a directory). */
	refusals: string[];
}

function exists(file: string): boolean {
	try { fs.lstatSync(file); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function ownerOf(file: string): ProcessIdentity & { state?: unknown } | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		const owner = (value.kind === undefined ? value.owner : value) as Record<string, unknown> | undefined;
		if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 ||
			typeof owner.birthToken !== "string") return undefined;
		return { ...(owner as unknown as ProcessIdentity), state: value.state };
	} catch {
		return undefined; // unreadable records are evidence, not owners
	}
}

function inspectNamespace(queue: string, identity: ProcessIdentity, inspect: ProcessInspector): NamespacePlan {
	const { anchor, journal, completed } = mutexNamespacePaths(queue);
	const plan: NamespacePlan = { queue, entries: [], siblings: [], refusals: [] };
	if (exists(anchor)) return { ...plan, untouched: "anchored; not orphaned" };
	if (!fs.lstatSync(queue).isDirectory()) {
		return { ...plan, refusals: ["queue path is not a real directory; inspect it manually"] };
	}
	const live = (record: ProcessIdentity) => !isPersistedOwnerStale(record, identity, inspect);
	plan.entries = fs.readdirSync(queue).sort();
	for (const name of plan.entries) {
		const inFlight = /\.tmp\.(\d+)\.[0-9a-f]+$/.exec(name);
		if (inFlight) {
			if (inspect(Number(inFlight[1])).alive) plan.refusals.push(`${name}: in-flight write by live pid ${inFlight[1]}`);
			continue;
		}
		if (!/^(choosing|ticket)-[0-9a-f-]+\.json$/.test(name)) continue;
		const owner = ownerOf(path.join(queue, name));
		if (owner && owner.state !== "done" && live(owner)) plan.refusals.push(`${name}: held by live pid ${owner.pid}`);
	}
	plan.siblings = [journal, completed].filter(exists);
	// A completed namespace no longer depends on its initializer's liveness.
	if (plan.siblings.includes(journal) && !plan.siblings.includes(completed)) {
		const owner = ownerOf(journal);
		if (owner && live(owner)) plan.refusals.push(`${path.basename(journal)}: initialization owned by live pid ${owner.pid}`);
	}
	return plan;
}

function applyPlan(plan: NamespacePlan, now: () => number): MutexNamespaceRepair {
	const base = { queue: plan.queue, preserved: [] as Array<{ from: string; to: string }> };
	if (plan.untouched) return { ...base, action: "untouched", detail: plan.untouched };
	if (plan.entries.length === 0 && plan.siblings.length === 0) {
		try { fs.rmdirSync(plan.queue); }
		catch (error) {
			// Another reconciler won; a writer that raced in makes rmdir fail with ENOTEMPTY.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		fsyncDirectory(path.dirname(plan.queue));
		return { ...base, action: "removed", detail: "empty unanchored queue with no owner removed" };
	}
	const suffix = `preserved-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
	// The queue moves last: an interrupted repair still leaves a detectable orphan.
	for (const from of [...plan.siblings, plan.queue]) {
		const to = `${from}.${suffix}`;
		fs.renameSync(from, to);
		base.preserved.push({ from, to });
	}
	fsyncDirectory(path.dirname(plan.queue));
	return {
		...base,
		action: "preserved",
		detail: `unanchored queue with evidence (${plan.entries.length} queue entr${plan.entries.length === 1 ? "y" : "ies"}` +
			`${plan.siblings.length ? `, ${plan.siblings.map((file) => path.basename(file)).join(", ")}` : ""}) moved aside`,
	};
}

/** Inspect every `*.lock.queue` in a control directory. If any orphan is still
 * owned by a live process (or is not a plain directory), throw
 * TFWS_MUTEX_REPAIR_REFUSED before changing anything. Otherwise remove empty
 * orphans, move orphans with evidence aside, and leave anchored namespaces
 * untouched so the next acquire() bootstraps a fresh anchor. */
export function repairOrphanedMutexNamespaces(directory: string, options: MutexRepairOptions = {}): MutexNamespaceRepair[] {
	const identity = options.processIdentity ?? defaultProcessIdentity();
	const inspect = options.inspectProcess ?? defaultProcessInspector;
	const queues = fs.readdirSync(directory).filter((name) => name.endsWith(".lock.queue")).sort();
	const plans = queues.map((name) => inspectNamespace(path.join(directory, name), identity, inspect));
	const refused = plans.filter((plan) => plan.refusals.length > 0);
	if (refused.length > 0) {
		throw new Error(
			"TFWS_MUTEX_REPAIR_REFUSED: nothing was changed; a mutex namespace is still owned by a live process or is not repairable: " +
			refused.map((plan) => `${plan.queue} (${plan.refusals.join("; ")})`).join(", "),
		);
	}
	return plans.map((plan) => applyPlan(plan, options.now ?? Date.now));
}
