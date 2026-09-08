import { test } from "node:test";
import assert from "node:assert/strict";
import { jsRuntimeExecPath } from "../src/detached-control.ts";

const withoutOverride = (fn: () => void) => {
	const prev = process.env.PI_TASKFLOW_NODE_BIN;
	delete process.env.PI_TASKFLOW_NODE_BIN;
	try { fn(); } finally { if (prev !== undefined) process.env.PI_TASKFLOW_NODE_BIN = prev; }
};

test("plain node/bun hosts spawn the detached runner with their own execPath", () => {
	withoutOverride(() => {
		assert.equal(jsRuntimeExecPath("/usr/bin/node", "linux"), "/usr/bin/node");
		assert.equal(jsRuntimeExecPath("/home/u/.bun/bin/bun", "linux"), "/home/u/.bun/bin/bun");
		assert.equal(jsRuntimeExecPath("C:\\Program Files\\nodejs\\node.exe", "win32"), "C:\\Program Files\\nodejs\\node.exe");
	});
});

test("a compiled single-file host falls back to node from PATH", () => {
	withoutOverride(() => {
		assert.equal(jsRuntimeExecPath("/nix/store/abc-pi-0.85.1/libexec/pi/pi", "linux"), "node");
		assert.equal(jsRuntimeExecPath("C:\\pi\\pi.exe", "win32"), "node");
	});
});

test("PI_TASKFLOW_NODE_BIN overrides both", () => {
	const prev = process.env.PI_TASKFLOW_NODE_BIN;
	process.env.PI_TASKFLOW_NODE_BIN = "/opt/node22/bin/node";
	try {
		assert.equal(jsRuntimeExecPath("/nix/store/abc-pi/libexec/pi/pi", "linux"), "/opt/node22/bin/node");
		assert.equal(jsRuntimeExecPath("/usr/bin/node", "linux"), "/opt/node22/bin/node");
	} finally {
		if (prev === undefined) delete process.env.PI_TASKFLOW_NODE_BIN;
		else process.env.PI_TASKFLOW_NODE_BIN = prev;
	}
});
