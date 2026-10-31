import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
	formatWorkspaceReconciliation,
	reconcileResolveOnlyWorkspace,
	WORKSPACE_RECONCILE_ACKNOWLEDGEMENT,
} from "../src/resources/execution.ts";
import {
	defaultProcessIdentity,
	PersistentFileMutex,
	readProcessBirthToken,
	type ProcessIdentity,
} from "../src/resources/persistence.ts";

const JOURNAL_LOCK = "resource-journal.lock";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-repair-root-"));
	const control = fs.mkdtempSync(path.join(os.tmpdir(), "tfws-repair-control-"));
	t.after(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(control, { recursive: true, force: true });
	});
	const reconcile = (acknowledgement = WORKSPACE_RECONCILE_ACKNOWLEDGEMENT) => reconcileResolveOnlyWorkspace(
		{ invocationRoot: root, controlDirectory: control, allowReconcile: true, leaseTimeoutMs: 200 },
		{ acknowledgement, reason: "test orphan repair" },
	);
	return { control, reconcile, lock: path.join(control, JOURNAL_LOCK), queue: path.join(control, `${JOURNAL_LOCK}.queue`) };
}

/** A pre-anchor (legacy) queue: `mkdir -p`, no identity, no initializing intent. */
function legacyQueue(queue: string, tickets: ProcessIdentity[] = []): string[] {
	fs.mkdirSync(queue, { recursive: true });
	return tickets.map((owner, index) => {
		const token = crypto.randomUUID();
		const file = path.join(queue, `ticket-${token}.json`);
		fs.writeFileSync(file, JSON.stringify({
			kind: "ticket", ...owner, token, ticket: index + 1, createdAt: Date.now(), state: "held",
		}));
		return file;
	});
}

function deadOwner(): ProcessIdentity {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid;
	assert.ok(pid);
	return { pid, birthToken: "linux:dead:1", birthTokenKind: "native" };
}

/** A separate live process, so ownership is decided by inspectProcess, not the same-pid shortcut. */
function liveOwner(t: TestContext): ProcessIdentity {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	t.after(() => { child.kill("SIGKILL"); });
	assert.ok(child.pid);
	const birthToken = readProcessBirthToken(child.pid);
	return birthToken === undefined
		? { ...defaultProcessIdentity(), pid: child.pid, birthTokenKind: "opaque" }
		: { pid: child.pid, birthToken, birthTokenKind: "native" };
}

function snapshot(directory: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
		const file = path.join(entry.parentPath, entry.name);
		if (!path.relative(directory, file).includes(".lock.queue")) continue;
		out[path.relative(directory, file)] = entry.isFile() ? fs.readFileSync(file, "hex") : "<dir>";
	}
	return out;
}

test("mutex repair: reconcile removes an empty unanchored unowned queue, then acquire succeeds", async (t) => {
	const { control, reconcile, lock, queue } = fixture(t);
	legacyQueue(queue);
	// Normal bootstrap still fails closed and does not repair.
	await assert.rejects(new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 25 }), /TFWS_MUTEX_IDENTITY/);
	assert.equal(fs.existsSync(`${queue}.identity`), false);
	// Authorization is checked before any repair.
	await assert.rejects(reconcile("yes"), /TFWS_RECONCILE_ACK_REQUIRED/);
	assert.deepEqual(fs.readdirSync(queue), []);
	assert.equal(fs.existsSync(`${queue}.identity`), false);

	const result = await reconcile();
	const repair = result.mutexRepairs.find((entry) => entry.queue === queue);
	assert.equal(repair?.action, "removed");
	assert.deepEqual(repair?.preserved, []);
	assert.match(formatWorkspaceReconciliation(result), /Mutex removed: .*resource-journal\.lock\.queue/);
	assert.equal(fs.readdirSync(control).some((name) => name.includes(".preserved-")), false);
	(await new PersistentFileMutex(lock).acquire({ timeoutMs: 500 }))();
	assert.equal(fs.existsSync(`${queue}.identity`), true);
});

test("mutex repair: reconcile moves leftover ticket evidence aside and restores usability", async (t) => {
	const { reconcile, lock, queue } = fixture(t);
	const [ticket] = legacyQueue(queue, [deadOwner()]);
	const ticketBytes = fs.readFileSync(ticket);
	fs.writeFileSync(`${queue}.initializing`, "{not json");
	await assert.rejects(new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 25 }), /TFWS_MUTEX_IDENTITY/);

	const result = await reconcile();
	const repair = result.mutexRepairs.find((entry) => entry.queue === queue);
	assert.equal(repair?.action, "preserved");
	const moved = new Map(repair!.preserved.map(({ from, to }) => [from, to]));
	assert.deepEqual([...moved.keys()].sort(), [queue, `${queue}.initializing`].sort());
	for (const to of moved.values()) assert.match(path.basename(to), /\.preserved-/);
	assert.deepEqual(fs.readFileSync(path.join(moved.get(queue)!, path.basename(ticket))), ticketBytes);
	assert.equal(fs.readFileSync(moved.get(`${queue}.initializing`)!, "utf8"), "{not json");
	(await new PersistentFileMutex(lock).acquire({ timeoutMs: 500 }))();
	assert.equal(fs.existsSync(`${queue}.identity`), true);
});

test("mutex repair: reconcile refuses a live owner and changes nothing", async (t) => {
	const { control, reconcile, queue } = fixture(t);
	const owner = liveOwner(t);
	legacyQueue(queue, [owner]);
	legacyQueue(path.join(control, "mutation-permits.lock.queue")); // repairable on its own
	const before = snapshot(control);
	assert.equal(Object.keys(before).length, 3);
	await assert.rejects(reconcile(), (error: Error) => {
		assert.match(error.message, /TFWS_MUTEX_REPAIR_REFUSED/);
		assert.match(error.message, new RegExp(`held by live pid ${owner.pid}`));
		assert.match(error.message, /nothing was changed/);
		return true;
	});
	assert.deepEqual(snapshot(control), before);
});

test("mutex repair: reconcile refuses an in-progress bootstrap whose initializer is live", async (t) => {
	const { control, reconcile, queue } = fixture(t);
	const owner = liveOwner(t);
	// Normal bootstrap state between the staged rename and anchor publication.
	legacyQueue(queue);
	const token = crypto.randomUUID();
	fs.writeFileSync(`${queue}.initializing`, JSON.stringify({
		version: 1, token, owner, parent: { dev: 1, ino: 1 }, directory: { dev: 1, ino: 2 },
		stage: `${path.basename(queue)}.staging-${token}`,
	}));
	const before = snapshot(control);
	await assert.rejects(reconcile(), (error: Error) => {
		assert.match(error.message, /TFWS_MUTEX_REPAIR_REFUSED/);
		assert.match(error.message, new RegExp(`initialization owned by live pid ${owner.pid}`));
		return true;
	});
	assert.deepEqual(snapshot(control), before);
});

test("mutex repair: plain acquire() never repairs an orphaned namespace", async (t) => {
	const { control, lock, queue } = fixture(t);
	const shapes: Array<[string, () => void]> = [
		["empty", () => legacyQueue(queue)],
		["dead ticket", () => legacyQueue(queue, [deadOwner()])],
		["garbage intent", () => { legacyQueue(queue); fs.writeFileSync(`${queue}.initializing`, "{not json"); }],
	];
	for (const [shape, build] of shapes) {
		fs.rmSync(queue, { recursive: true, force: true });
		fs.rmSync(`${queue}.initializing`, { force: true });
		build();
		const before = snapshot(control);
		await assert.rejects(
			new PersistentFileMutex(lock, { pollMs: 1 }).acquire({ timeoutMs: 25 }),
			/TFWS_MUTEX_IDENTITY: queue anchor is missing or invalid/,
			shape,
		);
		assert.deepEqual(snapshot(control), before, shape);
		assert.equal(fs.readdirSync(control).some((name) => name.includes(".preserved-")), false, shape);
	}
});
