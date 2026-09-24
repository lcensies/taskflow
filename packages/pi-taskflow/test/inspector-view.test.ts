import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PhaseState, RunState } from "taskflow-core";
import { agentRows, InspectorComponent, type ListAction, listKey } from "../src/inspector-view.ts";

/** Identity theme — strips styling so assertions see plain structure. */
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mkRun(phases: RunState["phases"], phaseIds: string[]): RunState {
	return {
		runId: "flow-abc-1",
		flowName: "demo",
		status: "running",
		createdAt: 1000,
		updatedAt: 1000,
		cwd: "/tmp",
		def: { name: "demo", phases: phaseIds.map((id) => ({ id, agent: "a", task: "t" })) } as any,
		phases,
		args: {},
	} as RunState;
}

function messageEnd(role: string, content: unknown[]): string {
	return `${JSON.stringify({ type: "message_end", message: { role, content } })}\n`;
}

/** An inspector in detail view over `file`, with a fixed terminal height. */
function detailView(file: string, rows = 20) {
	const state = mkRun({ p: { id: "p", status: "running", model: "haiku" } }, ["p"]);
	const view = new InspectorComponent(
		state,
		theme,
		() => {},
		true,
		() => {}, // requestRender: enables the 250 ms tail timer
		() => rows,
		() => file,
	);
	view.handleInput("\r"); // Enter → detail
	return view;
}

/** A two-item fan-out phase whose merged output carries both labelled sections. */
const fanPhase = {
	id: "fan",
	status: "running",
	liveLog: ["read a.ts"],
	output: "### [1/2] reviewer\n\nlooks fine\n\n---\n\n### [2/2] auditor (failed)\n\nboom",
	subProgress: { done: 1, total: 2, running: 0, failed: 1 },
} as PhaseState;

test("listKey: each alias pair maps to the same action", () => {
	const aliases: Array<[ListAction, string, string]> = [
		["up", "\x1b[A", "k"],
		["down", "\x1b[B", "j"],
		["pageUp", "\x1b[5~", "\x15"], // PgUp / ctrl+u
		["pageDown", "\x1b[6~", "\x04"], // PgDn / ctrl+d
		["top", "\x1b[H", "g"],
		["bottom", "\x1b[F", "G"],
		["in", "\r", "l"],
		["out", "\x1b", "h"],
		["close", "q", "\x03"], // q / ctrl+c
	];
	for (const [action, a, b] of aliases) {
		assert.equal(listKey(a), action, `${JSON.stringify(a)} → ${action}`);
		assert.equal(listKey(b), action, `${JSON.stringify(b)} → ${action}`);
	}
	// Enter/→/l and Esc/←/h are three-way aliases.
	assert.equal(listKey("\x1b[C"), "in", "→ enters");
	assert.equal(listKey("\x1b[D"), "out", "← leaves");
	assert.equal(listKey("s"), undefined, "unbound keys fall through to the owner");
	assert.equal(listKey("x"), undefined);
});

test("inspector hints: each level advertises only the keys that act there", () => {
	const view = new InspectorComponent(
		mkRun({ fan: fanPhase }, ["fan"]),
		theme,
		() => {},
		true,
		undefined,
		() => 24,
		() => undefined,
	);
	try {
		const hint = () => view.render(100).at(-2) ?? "";
		// Phase level: the root has nothing to go back to.
		assert.match(hint(), /↑↓\/jk move · →\/l open · s steer · q close/);
		assert.doesNotMatch(hint(), /back/);

		view.handleInput("\r"); // → agents level
		assert.match(hint(), /←\/h back/, "the agent level hint mentions back");
		assert.match(hint(), /↑↓\/jk move · →\/l open · ←\/h back · s steer · q close/);

		view.handleInput("\r"); // → detail level
		assert.match(hint(), /↑↓\/jk scroll · PgUp\/PgDn page · G follow · \^O full · s steer · Esc back/);
	} finally {
		view.dispose();
	}
});

test("inspector phases: 30 phases are all reachable and every line fits the width", () => {
	const ids = Array.from({ length: 30 }, (_, i) => `phase-${i}`);
	const phases: RunState["phases"] = {};
	for (const [i, id] of ids.entries()) {
		phases[id] = { id, status: i === 0 ? "done" : "pending" } as RunState["phases"][string];
	}
	phases["phase-1"] = {
		id: "phase-1",
		status: "running",
		steered: true,
		subProgress: { done: 2, total: 5, running: 3, failed: 0 },
	} as RunState["phases"][string];
	const view = new InspectorComponent(mkRun(phases, ids), theme, () => {}, true, undefined, () => 20);
	try {
		const seen = new Set<string>();
		for (let i = 0; i < ids.length; i++) {
			const out = view.render(40);
			for (const line of out) assert.ok(visibleWidth(line) <= 40, `too wide: ${line}`);
			const text = out.join("\n");
			const row = text.split("\n").find((l) => l.includes("❯ "));
			assert.ok(row, "a cursor row is always rendered");
			seen.add(row.replace(/.*❯ /, "").trim().split(" ")[1]);
			view.handleInput("j");
		}
		assert.deepEqual([...seen].sort(), [...ids].sort(), "every phase id is reachable");
		// Fan-out progress and the steered marker ride on the phase row.
		view.handleInput("g");
		view.handleInput("j");
		const atFanout = view.render(40).join("\n");
		assert.match(atFanout, /phase-1 2\/5 ⇢/);
		assert.match(atFanout, /↓ \d+ more/, "the window shows what is below");
	} finally {
		view.dispose();
	}
});

test("inspector detail: renders the node's transcript", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inspector-"));
	try {
		const file = path.join(dir, "p.ndjson");
		fs.writeFileSync(
			file,
			messageEnd("assistant", [{ type: "text", text: "planning the change" }]) +
				messageEnd("assistant", [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }]) +
				messageEnd("tool", [{ type: "toolResult", name: "bash", text: "ok" }]),
		);
		const view = detailView(file);
		try {
			const out = view.render(80).join("\n");
			assert.match(out, /planning the change/);
			assert.match(out, /npm test/);
			assert.match(out, /haiku/, "header keeps the accounting");
			assert.match(out, /G follow/, "hint advertises the scroll keys");
		} finally {
			view.dispose();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inspector detail: scroll keys move the window, follow shows new entries", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inspector-"));
	try {
		const file = path.join(dir, "p.ndjson");
		let ndjson = "";
		for (let i = 0; i < 40; i++) ndjson += messageEnd("assistant", [{ type: "text", text: `entry ${i}` }]);
		fs.writeFileSync(file, ndjson);
		const view = detailView(file, 20);
		try {
			// Follow is on by default → the newest entry is visible, the first is not.
			assert.match(view.render(80).join("\n"), /entry 39/);
			assert.doesNotMatch(view.render(80).join("\n"), /entry 0\b/);

			view.handleInput("g"); // Home → top, drops follow
			const top = view.render(80).join("\n");
			assert.match(top, /entry 0\b/);
			assert.doesNotMatch(top, /entry 39/);

			view.handleInput("\x1b[B"); // ↓ past the first entry (a header line + its text)
			view.handleInput("\x1b[B");
			assert.doesNotMatch(view.render(80).join("\n"), /entry 0\b/);

			view.handleInput("G"); // End → follow again
			assert.match(view.render(80).join("\n"), /entry 39/);

			// The file grows while the pane is following.
			fs.appendFileSync(file, messageEnd("assistant", [{ type: "text", text: "the newest thing" }]));
			await new Promise((r) => setTimeout(r, 400)); // the 250 ms tail timer
			assert.match(view.render(80).join("\n"), /the newest thing/);
		} finally {
			view.dispose();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inspector detail: width-safe at 50 cols", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inspector-"));
	try {
		const file = path.join(dir, "p.ndjson");
		const long = "word ".repeat(200).trim();
		fs.writeFileSync(
			file,
			messageEnd("assistant", [{ type: "text", text: long }]) +
				messageEnd("tool", [{ type: "toolResult", name: "bash", text: `${long}\n${long}` }]),
		);
		const view = detailView(file);
		try {
			for (const line of view.render(50)) assert.ok(visibleWidth(line) <= 50, `too wide: ${line}`);
		} finally {
			view.dispose();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inspector detail: falls back to the live activity block with no transcript file", () => {
	const state = mkRun({ p: { id: "p", status: "running", liveLog: ["read a.ts"], output: "partial" } }, ["p"]);
	const view = new InspectorComponent(
		state,
		theme,
		() => {},
		true,
		undefined,
		() => 40,
		() => "/nonexistent/p.ndjson",
	);
	try {
		view.handleInput("\r");
		const out = view.render(80).join("\n");
		assert.match(out, /recorded activity \(no transcript available\)/, "the fallback says where the body came from");
		assert.match(out, /read a\.ts/);
		assert.match(out, /partial/);
	} finally {
		view.dispose();
	}
});

test("agent detail: shows only that item's transcript", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inspector-"));
	try {
		fs.writeFileSync(path.join(dir, "fan-0.ndjson"), messageEnd("assistant", [{ type: "text", text: "item one work" }]));
		fs.writeFileSync(path.join(dir, "fan-1.ndjson"), messageEnd("assistant", [{ type: "text", text: "item two work" }]));
		const view = new InspectorComponent(
			mkRun({ fan: fanPhase }, ["fan"]),
			theme,
			() => {},
			true,
			undefined,
			() => 24,
			(nodeId) => path.join(dir, `${nodeId}.ndjson`),
		);
		try {
			view.handleInput("\r"); // → agents level
			view.handleInput("j"); // second item
			view.handleInput("\r"); // → its detail
			const out = view.render(80).join("\n");
			assert.match(out, /item two work/);
			assert.doesNotMatch(out, /item one work/, "a sibling's transcript never leaks in");
			assert.doesNotMatch(out, /looks fine/, "the transcript wins over the merged output");
		} finally {
			view.dispose();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("agent detail: no transcript file falls back to that item's output section", () => {
	const view = new InspectorComponent(
		mkRun({ fan: fanPhase }, ["fan"]),
		theme,
		() => {},
		true,
		undefined,
		() => 24,
		() => undefined,
	);
	try {
		view.handleInput("\r"); // → agents level
		view.handleInput("j"); // second item
		view.handleInput("\r"); // → its detail
		const out = view.render(80).join("\n");
		assert.match(out, /### \[2\/2\] auditor/);
		assert.match(out, /boom/);
		assert.doesNotMatch(out, /looks fine/, "only the selected item's section renders");
		assert.doesNotMatch(out, /activity/, "the live block is the last resort, not this one");
	} finally {
		view.dispose();
	}
});

test("steering: s at the agent level and in an item's detail steers the owning phase", () => {
	let result: unknown = "unset";
	const view = new InspectorComponent(
		mkRun({ fan: fanPhase }, ["fan"]),
		theme,
		(r) => {
			result = r;
		},
		true,
		undefined,
		() => 24,
		() => undefined,
	);
	try {
		view.handleInput("\r"); // → agents level
		view.handleInput("j"); // second item
		view.handleInput("s");
		assert.deepEqual(result, { action: "steer", phaseId: "fan" }, "the phase id, never the item node id");

		result = "unset";
		view.handleInput("\r"); // → that item's detail
		view.handleInput("s");
		assert.deepEqual(result, { action: "steer", phaseId: "fan" }, "item detail steers the owning phase too");
	} finally {
		view.dispose();
	}
});

test("agentRows: labels and statuses come from the merged two-item output", () => {
	const output = [
		"### [1/2] reviewer\n\nlooks fine",
		"### [2/2] auditor (failed)\n\nboom",
	].join("\n\n---\n\n");
	const rows = agentRows({
		id: "p",
		status: "running",
		output,
		subProgress: { done: 1, total: 2, running: 0, failed: 1 },
	} as PhaseState);
	assert.deepEqual(rows, [
		{ index: 0, label: "reviewer", status: "done" },
		{ index: 1, label: "auditor", status: "failed" },
	]);
});

test("agentRows: no output yet → positional statuses; no subProgress → []", () => {
	assert.deepEqual(
		agentRows({ id: "p", status: "running", subProgress: { done: 0, total: 2, running: 2, failed: 0 } } as PhaseState),
		[
			{ index: 0, label: "item 1", status: "running" },
			{ index: 1, label: "item 2", status: "running" },
		],
	);
	assert.deepEqual(agentRows({ id: "p", status: "done", output: "plain" } as PhaseState), []);
	assert.deepEqual(agentRows(undefined), []);
});

test("inspector agents: a fan-out phase lists its items, a plain phase drills straight to detail", () => {
	const phases: RunState["phases"] = {
		fan: {
			id: "fan",
			status: "running",
			output: "### [1/2] reviewer\n\nok\n\n---\n\n### [2/2] auditor\n\nok",
			subProgress: { done: 2, total: 2, running: 0, failed: 0 },
		} as RunState["phases"][string],
		solo: { id: "solo", status: "done", liveLog: ["read a.ts"] } as RunState["phases"][string],
	};
	const opened: string[] = [];
	const view = new InspectorComponent(
		mkRun(phases, ["fan", "solo"]),
		theme,
		() => {},
		true,
		undefined,
		() => 20,
		(nodeId) => {
			opened.push(nodeId);
			return undefined;
		},
	);
	try {
		view.handleInput("\r"); // fan-out phase → agents level, no transcript opened yet
		const list = view.render(60).join("\n");
		assert.match(list, /\[1\] reviewer/);
		assert.match(list, /\[2\] auditor/);
		assert.deepEqual(opened, [], "listing items opens no transcript");

		view.handleInput("j"); // second item
		view.handleInput("l"); // → its detail
		assert.deepEqual(opened, ["fan-1"], "the item node id carries its index");

		view.handleInput("\x1b"); // back to the item list
		assert.match(view.render(60).join("\n"), /\[2\] auditor/);
		view.handleInput("h"); // back to the phase list
		view.handleInput("j"); // select the non-fan-out phase
		view.handleInput("\r");
		assert.deepEqual(opened, ["fan-1", "solo"], "a non-fan-out phase pushes detail with the phase id");
		assert.match(view.render(60).join("\n"), /read a\.ts/, "detail, not an item list");
	} finally {
		view.dispose();
	}
});

test("inspector detail: ctrl+o toggles the full transcript and the flag survives navigation", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-inspector-"));
	try {
		const file = path.join(dir, "p.ndjson");
		const result = Array.from({ length: 100 }, (_, i) => `out ${i}`).join("\n");
		fs.writeFileSync(file, messageEnd("tool", [{ type: "toolResult", name: "bash", text: result }]));
		// A tall viewport so nothing is cut by the pane: the line count is the body's.
		const view = detailView(file, 200);
		try {
			const compact = view.render(80).length;
			assert.match(view.render(80).join("\n"), /\(\+60 lines\)/, "the default caps the result");

			view.handleInput("\x0f"); // ctrl+o
			const full = view.render(80).length;
			assert.ok(full > compact, `full (${full}) shows more lines than compact (${compact})`);
			assert.match(view.render(80).join("\n"), /out 99/, "the tail of the result is visible");
			assert.doesNotMatch(view.render(80).join("\n"), /\(\+60 lines\)/);

			view.handleInput("\x1b"); // back to the phase list
			view.handleInput("\r"); // re-enter the node
			assert.equal(view.render(80).length, full, "the flag persists across re-entry");

			view.handleInput("\x0f"); // ctrl+o again → back to compact
			assert.equal(view.render(80).length, compact);
		} finally {
			view.dispose();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inspector detail: the footer advertises the toggle and flips with ctrl+o", () => {
	const state = mkRun({ p: { id: "p", status: "running", liveLog: ["read a.ts"] } }, ["p"]);
	const view = new InspectorComponent(
		state,
		theme,
		() => {},
		false,
		undefined,
		() => 40,
		() => "/nonexistent/p.ndjson",
	);
	try {
		const hint = () => view.render(80).at(-2) ?? "";
		assert.doesNotMatch(hint(), /\^O/, "the toggle only acts at the detail level");

		view.handleInput("\r"); // → detail
		assert.match(hint(), /\^O full/, "compact detail offers the full view");

		view.handleInput("\x0f"); // ctrl+o
		assert.match(hint(), /\^O compact/, "full detail offers the way back");
		assert.doesNotMatch(hint(), /\^O full/);

		view.handleInput("\x0f");
		assert.match(hint(), /\^O full/);
	} finally {
		view.dispose();
	}
});
