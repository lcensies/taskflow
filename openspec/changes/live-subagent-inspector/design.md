## Context

See proposal.md — Why. Constraints that shape the approach:

- Taskflow subagents on pi are **separate processes** (`pi --mode json -p --no-session`, `pi-taskflow/src/runner.ts`), not in-process sessions. There is no session file to open and no stdin channel after spawn.
- The parent already folds each child's NDJSON into an `EventAccumulator` (`runner-core.ts`) that carries `lastActivity` per assistant turn; the runtime mirrors it into `PhaseState.liveText` at three sites (`runtime.ts` `liveSink`, the fan-out `refresh`, and the ctx-tree branch).
- Run state is persisted throttled at ≤1/s (`pi-taskflow/src/index.ts`), so anything stored on `PhaseState` is automatically available to `peek`, `/tf runs`, and detached runs.
- While the `taskflow` tool blocks the turn, pi **queues** slash input. Only `pi.registerShortcut` handlers and `ctx.ui.custom` overlays run — the existing approval popup already proves overlays work mid-tool.
- The child process **already loads taskflow's own extension** via `--extension <selfPath>` whenever the Shared Context Tree is on; `pi-taskflow/src/index.ts` branches on `PI_TASKFLOW_CTX_DIR` + `PI_TASKFLOW_NODE_ID` into "child mode" and registers `ctx_*` tools instead of the host tool.
- `taskflow-core` must not import a host SDK, and codex/claude/opencode/grok runners must keep working untouched.

## Goals / Non-Goals

**Goals:**
- Inspection surface reachable while the host turn is blocked, backed by data that also survives to disk.
- Steering delivered without rewriting the runner or the child protocol.
- Zero behavior change for hosts and configurations that do not opt in.

**Non-Goals:**
- Interrupting a child mid-tool-call (needs `--mode rpc` or a signal protocol).
- Full child transcript rendering / resumable child sessions (needs dropping `--no-session`).
- A persistent always-on widget: the taskflow tool-call block is already the live surface; a second panel would duplicate it.
- Steering on codex/claude/opencode/grok.

## Decisions

### 1. Activity history lives on `PhaseState`, not in a side channel

`PhaseState.liveLog?: string[]`, appended wherever `liveText` is already assigned, bounded to the last 20 entries (drop-oldest), and deduplicated against the previous entry.

*Why:* it rides the existing throttled persistence, so live view, `peek`, detached runs, and post-hoc debugging all get it from one change. Alternatives rejected: a parallel in-memory registry in the pi adapter (invisible to detached runs and to `peek`); mirroring child NDJSON to disk per phase (a second artifact format to version, for data we already hold).

*Bound rationale:* 20 lines × ~200 chars × N phases keeps run-state growth negligible while covering "what has this thing been doing for the last minute".

### 2. Inspector = shortcut + overlay, reusing the existing views

`pi.registerShortcut(<configurable, default ctrl+alt+t>)` opens `ctx.ui.custom` with a two-level component: run/phase list → phase detail. It reads a module-level `activeRun: RunState | undefined` published by `runFlow` (the same object the heartbeat renderer already mutates), and falls back to `listRuns()`/`loadRun()` from the store when nothing is active.

*Why the live object rather than the store:* it is always current, whereas the store lags up to 1s. The store path is kept for detached and finished runs, so one component serves both.

*Why a shortcut and not a command:* slash input is queued during the blocking tool call — a command cannot open during the exact window that matters.

*Why not a persistent widget:* rejected, see Non-Goals.

### 3. Steering rides the existing child-extension seam, not a new protocol

Steering is delivered by taskflow's own extension **running inside the child**:

- Host side: the user's message is appended as one JSON line to `<runsRoot>/steer/<runId>/<nodeId>.jsonl`.
- Child side: when `PI_TASKFLOW_STEER_FILE` is set, child mode watches that file (`fs.watch` **plus** a 1s poll — `fs.watch` is unreliable on network/overlay filesystems), reads only the bytes past its last offset, and calls `pi.sendUserMessage(text, { deliverAs: "steer" })` per new line.
- The runner injects the extension and the env when steering is enabled, reusing the `extensionPaths` block that already exists for `ctx_*` (both triggers now share it).
- `nodeId` becomes unconditional in `RunOptions` (today it is passed only when the ctx tree is on); it is already computed for every phase and fan-out item by `nodeIdFor`.

*Why:* `deliverAs: "steer"` is pi's own queue — the message lands after the current assistant turn's tool calls and before the next model call, which is exactly the steering semantics every other pi delegation extension offers. No stdin protocol, no runner rewrite.

*Alternative rejected:* switching children to `pi --mode rpc` and sending `{"type":"prompt", streamingBehavior:"steer"}`. It also buys interrupts and a full event stream, but costs a runner rewrite, strict LF JSONL framing, and child session lifecycle management. Deferred; the file seam does not block it.

*Alternative rejected:* delivering through the Shared Context Tree blackboard (`ctx_*`). Pull-only — the child sees it only if the model chooses to call `ctx_read`.

### 4. Steer messages for a not-yet-started phase are drained into the task

At spawn the runner reads any lines already queued for that node and appends them to the task prompt under an explicit heading, then advances the offset so the watcher does not re-deliver them.

*Why:* one file, one ordering, no separate "pending" concept, and it makes "tell phase 3 to also check X" work before phase 3 starts.

### 5. Steered phases are excluded from cross-run cache writes

`PhaseState.steered?: true` is set by the host when it queues a message for a running phase. `PhaseCacheCtx` gains a `steered?: () => boolean` predicate closing over the live phase state, and `recordCache` returns early when it is true.

*Why:* a steered result did not follow from the flow definition; replaying it later for an unchanged definition would be a lie. `recordCache` is the single write choke point (map per-item records spread the same `cc`), so one guard covers every path. Within-run resume reuse is deliberately left alone — that phase really did complete.

### 6. Opt-out configuration and host capability

`settings.taskflow.steering` (default: on when the host has a UI, off for headless/detached runs) gates the child extension injection so a run that will never be steered does not pay the extra `--extension` load. `RunOptions.steerFile` is optional and host-neutral; runners that ignore it behave exactly as today. The inspector reports steering as unavailable rather than erroring when no channel exists.

## Risks / Trade-offs

- **`--no-extensions` interaction** (`piChild.resourceProfile: "allowlist"` passes `--no-extensions`) → taskflow's own extension path must be re-added explicitly, exactly as the existing `ctx_*` injection already does.
- **Extra child startup cost** for every phase when steering is on → gated by config; the same extension is already loaded whenever context sharing is on, so the cost is known.
- **Delivery is not immediate** (next tool-call boundary; never mid-tool) → documented in the spec and surfaced in the inspector hint. Aborting a phase remains the way to stop work now.
- **File watching can miss events** on odd filesystems → poll fallback and offset-based reads make delivery at-least-once-checked and exactly-once-delivered.
- **A steered child could be told something harmful** → the message goes to the child as an ordinary user message under the same tool permissions it already had; no privilege change.
- **Run-state growth from `liveLog`** → hard bound of 20 entries per phase, dropped oldest first.
- **`nodeId` now always passed** → it only becomes meaningful to a runner that also gets `ctxDir`/`steerFile`; existing hosts ignore it.
