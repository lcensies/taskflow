# Visible, crash-durable subagent workers

## Why

Taskflow can already run a DAG of isolated workers, but a worker is a blackbox
while it runs and its outcome is lost if the orchestrating process dies. Those
two gaps are what pushes users to drive agents from tmux by hand instead, and
hand-driven tmux then reintroduces the opposite problem: an interactive agent
**idles at a prompt when it is done**, so "finished" and "waiting" are the same
observable and the orchestrator misses completions.

Concretely, today:

1. **A running worker has no attachable surface.** `openTranscriptTee`
   (`packages/pi-taskflow/src/runner.ts:86-129`) already writes every raw child
   event line to `<runs>/transcripts/<flow>/<runId>/<nodeId>.ndjson`, and
   `peek` already reads it — but only on demand, from the host session. There is
   no way to watch one worker live, side by side with the others, the way a tmux
   window per task gives.

2. **Outcome lives only in the orchestrating process's memory until it settles.**
   `runSubagentProcess` classifies completion well (`completionSource` at
   `packages/taskflow-core/src/runner-core.ts:1024-1030`: `process-exit` /
   `terminal-reap` / `idle-timeout` / `phase-timeout` / `abort` /
   `protocol-error` / `external-signal`) and reaps the child's process group on
   exit. But the classification is written to `RunState` only by the surviving
   parent. If the parent dies between a child finishing and the next checkpoint,
   the work happened and the record does not. On reload that phase is
   indistinguishable from one that never ran.

3. **No orphan detection.** A node left `running` in a stored run has three real
   possible states — still running, finished-and-unrecorded, dead-without-record
   — and the store cannot tell them apart. The third case stalls forever.

4. **Exit code is treated as the verdict.** A child that exits 0 having done
   nothing is recorded as a successful phase. Process outcome and work verdict
   are different facts and need to be separately readable.

## What Changes

- **A worker is watched in a tmux window by default.** Each node that spawns a
  child gets a tmux window tailing that node's transcript through
  `peek --follow`. The window is a **viewer**, never the parent — closing it
  does not touch the worker, and the worker exiting does not depend on the
  window or on a tmux server being alive. Steering from that window uses the
  existing channel (`appendSteerMessage` → the child's 1s watcher), so no new
  transport. Windows are capped per run, so a wide fan-out degrades to "the
  first N nodes get windows, the rest are named" instead of flooding tmux.

- **`peek` gains `--follow`**, so the same reader the navigator uses can be the
  window's renderer instead of a second implementation.

- **Each node's outcome is recorded durably by the process that observed it**,
  at settle time, before the parent does anything else: `completionSource`,
  exit code, signal, timings. The record is written next to the transcript, so
  it survives the parent's death and a later load can read what happened.

- **Reattach classifies a stale `running` node** into `running` /
  `finished-unrecorded` / `orphaned` by probing the recorded process group and
  the outcome record, instead of trusting the status field.

- **Verdict is separate from exit.** A phase carries the process outcome and,
  independently, whether its work was accepted. Nothing infers the second from
  the first.

## Capabilities

### New Capabilities

- `tmux-worker-window`: an attachable live view of one running worker, whose
  lifecycle is independent of the worker's.
- `worker-outcome-durability`: a worker's observed outcome is durable
  independent of the orchestrating process, and a stale `running` node is
  classifiable on reattach.

### Modified Capabilities

- `run-observability`: the tmux window joins the inspector as a live surface,
  under the same non-destructive guarantee.

## Impact

- `packages/taskflow-core/src/store.ts` — outcome record path helper beside
  `transcriptFileFor`; outcome read on load.
- `packages/taskflow-core/src/runner-core.ts` — write the outcome record in
  `finish()`, where `completionSource` is already computed.
- `packages/taskflow-core/src/peek.ts` — `--follow`.
- `packages/taskflow-core/src/exec/{events,fold}.ts` — worker-lifecycle events;
  unknown-kind tolerance in the fold.
- `packages/pi-taskflow/src/tmux-viewer.ts` (new) — window open/close, opt-in.
- `packages/pi-taskflow/src/transcript-view.ts` — reused as the follow renderer.
- Tests: `packages/taskflow-core/test/{store,peek,runner-core}.test.ts`,
  `packages/pi-taskflow/test/tmux-viewer.test.ts`.

## Non-goals

- **No new `SubagentRunner`.** Workers stay `pi --mode json -p` children of the
  runtime. A tmux-parented worker would lose the exit code when the window or
  the tmux server dies — that is the bug, not the fix.
- **No workmux dependency.** The window is raw `tmux new-window`. Persistent
  task worktrees and branch integration stay workmux's job, reached from a
  `script` phase; `cwd: "worktree"` stays ephemeral as documented.
- **No interactive takeover of a live worker.** Children spawn with
  `--no-session` and resume is always a fork (`forkRunForResume`), so a running
  headless worker cannot be promoted to an interactive session. Out of scope
  here; see design.md open question Q1.
- **No integration policy** (`merge` / `push` / `pr-only` / `none`). Separate
  change.
- **No control-plane admission** (claims, leases, fencing epochs,
  `orphan-suspect`). That is `taskflow-control` S3/S4; this change must not
  grow a second, incompatible claim protocol — see design.md D4.
