# Design — tmux-worker-visibility

## Context

Four production bugs motivated this, all observed while driving agents from tmux
by hand:

1. coordination state does not survive a harness restart
2. workers finish without the orchestrator noticing
3. integration policy is per-repo but hardcoded (out of scope here)
4. a worker finishes and its result is never received

(1), (2) and (4) are one root cause: **the orchestrator's knowledge is volatile,
and completion is reported in-band by the worker.** The fix is to invert both —
record the outcome from the side that *observed* it, and make reattach derive
state from disk rather than trust it.

## Decisions

### D1 — No new runner; tmux is a viewer, not a parent

The worker stays a `pi --mode json -p --no-session` child of the runtime
(`runner.ts:428-483` argv, `runner-core.ts:606` spawn, `detached: true` so each
child already owns a process group). The tmux window runs
`peek --follow <transcriptFile>` — it holds no handle on the worker.

Rejected: `tmux new-window "pi …"`, i.e. tmux as the worker's parent. That is
how hand-driven tmux works today and it is precisely why completions get lost:
the exit status belongs to a pane that can be closed, and an interactive agent
that finishes just idles at a prompt, which is observationally identical to
being stuck. Keeping the runtime as parent preserves the whole completion
taxonomy already implemented at `runner-core.ts:1024-1030`.

Consequence, accepted: no agent TUI, and no shell of your own in that pane. The
window is read-only plus steering.

### D2 — Steering reuses the existing channel verbatim

`appendSteerMessage` → `<runs>/steer/<runId>/<nodeId>.jsonl` → child watcher
polling at 1s (`steer-watch.ts:22-39`) → `sendUserMessage(text, {deliverAs:
"steer"})`. Delivery lands after the current turn's tool calls, before the next
model call.

This is not a downgrade from typing into an interactive pane: typed input also
only takes effect at a turn boundary. Same latency class, and it already has
exactly-once delivery via the byte offset.

### D3 — Outcome is written by the observer, at settle, not by the parent later

`finish()` in `runner-core.ts:849-895` already computes everything needed and
runs in the process that watched the child exit. It writes
`<transcriptDir>/<nodeId>.outcome.json` there, before resolving, so the record
exists even if the parent dies immediately after.

`RunState` stays the fast path; the outcome file is the durable one. On load,
a node whose stored status is `running` but which has an outcome file is
reconciled from the file.

Rejected: a shell wrapper writing `echo $? > status`. The runtime already owns
the child and classifies more states than an exit code can carry
(`idle-timeout` vs `abort` vs `protocol-error` are all exit-code-indistinct).

### D4 — Interim claim state only; do not invent a second claim protocol

`taskflow-control` already has the frozen wire contracts for admission —
`CoordinatorLease {holderId, fencingEpoch, endpoint, expiresAt}`,
`ConcurrencyReservation` with `reserved | committed | released | expired |
orphan-suspect`, and ADR P16's crash matrix and `normalRelease`/`forceRelease`
predicates. S3 (stores) and S4 (admission/reconcile) are not built, and nothing
depends on the package yet.

So this change records **observations** (outcome, liveness probe result) and
deliberately records no claims, leases, or epochs. When S3/S4 land, admission
sits above these observations unchanged. Adding a lightweight claim here would
guarantee a migration conflict with a protocol that is already specified.

Named consequence: concurrent orchestrators over one run directory are **not**
made safe by this change. They are not safe today either.

### D5 — Three-state reattach, with the third state explicit

```
stored status == running  ⇒  probe:
  outcome file exists                        → finished-unrecorded (adopt it)
  no outcome file, process group alive        → running
  no outcome file, process group gone         → orphaned
```

`orphaned` is a distinct recorded state, never silently rewritten to `failed`.
It is the only honest answer when the machine died mid-write, and P16 treats the
equivalent (`orphan-suspect`) as capacity-holding and operator-visible rather
than auto-reclaimable. Matching that now avoids contradicting S4 later.

The process group is probed from the pid already stored for detached runs;
`detached-runner.ts:196` has the heartbeat registry precedent.

### D6 — Verdict is a separate field from process outcome

`PhaseState` gains a verdict distinct from `status`/`error`. Exit 0 sets the
process outcome only. Acceptance comes from a gate, a `script` check, or an
explicit verdict write — never inferred from the exit code.

### D7 — Self-similar by construction

A taskflow run is itself a worker from its parent's view: `RunState.parentRunId`
already models the nesting, `detachedCancel {requestedAt, reason}` is already a
durable cancel record rather than a signal, and each child is already its own
process group. So "a nested run goes out of control" is handled by the same
three mechanisms at every depth, with no per-level bookkeeping: kill the group,
read the outcome file, probe on reattach.

### D8 — Windows are opt-in, one per node, capped

The unit of layout is the **feature**, not the worker: a feature already owns one
tmux window (the interactive session that dispatched the run), and the taskflow
inspector already renders any node's transcript on demand. Auto-opening a window
per node would be a second on-demand surface for the same artifact, competing
with the one that already exists.

So per-node windows default to **off** and are opened only when asked for. When
enabled: one window per node, named `tf:<runId-short>:<nodeId>`, created lazily
on first output, bounded by a per-run cap, with the nodes past the cap named
rather than silently dropped. Rejected: one window with a pane per node — panes
read better up to roughly six workers and become unreadable past that.

Revised from the original decision (auto-open, default on). The argument for
auto-open — "a view you must remember to request is a view you look at after the
problem" — is answered by the inspector being reachable mid-run without the
agent being idle: the on-demand surface is already one keystroke away.

What a window still buys over the inspector: it persists after the inspector is
closed, survives in scrollback, and can sit beside another node for comparison.
Worth keeping as a capability, not as a default.

### D9 — The dispatch contract is a generic task, not a plan format

A worker is handed a task string and reports an outcome. Nothing in the
dispatch path knows about openspec, `tasks.md`, or any other plan format, and
nothing here should learn about them later.

Whether a worker is a single agent or itself runs a taskflow DAG over a
decomposed plan is the worker's own business, decided inside the worker. This is
D7 restated at the input side: one contract at every nesting level.

Rejected: teaching the dispatcher to read a plan format and fan out from it.
Plan shapes are not knowable in advance, so a dispatcher that understands one
of them fails on every task that is not written in it, and the special case
then has to be maintained at every level of nesting.

### D10 — Worker authority is host-minted, and `isolated` constrains D9

`taskflow.piChild.resourceProfile` decides what a worker can reach:
`isolated` (default) passes `--no-extensions`; `allowlist` adds only the
canonical absolute paths configured on the host; `inherit` restores ambient
discovery. It is deliberately not a DSL field — "a flow may consume authority,
never mint it" (`taskflow-core/src/agents.ts`). Credentials are not gated this
way: the child inherits `process.env` minus the principal variables.

Two consequences this change must not paper over.

First, **MCP is extension-delivered** in this host (`--mcp-config` is an
extension-registered flag), so under `isolated` a worker has built-in tools and
nothing else — no MCP, no codegraph, no memory. Taskflow's own extension is
injected regardless, so `ctx_*` and steering survive.

Second, **`isolated` contradicts D9 as written.** D9 says a worker may decide to
decompose into its own taskflow DAG; under `isolated` the worker has no
`taskflow` tool and structurally cannot. Self-decomposing workers require the
taskflow extension to be allowlisted. Keep that a host decision per deployment,
not a flow-level one — but do not write prompts that assume a capability the
profile denies.

Rejected: `inherit` as the default. On a fan-out it boots every MCP server once
per worker, and any stateful server (memory especially) then has N concurrent
writers to one store — the double-writer failure this change exists to remove.

## Open questions

- **Q1 — Post-mortem takeover. Resolved: wanted, as a follow-up change.**
  Children run `--no-session`, so there is nothing to resume interactively. A
  separate change (`worker-session-takeover`) drops `--no-session` for worker
  nodes, persists a session id per node, and lets a finished or orphaned worker
  be opened in a real interactive `pi` and continued by hand. It is deliberately
  not part of this change: it adds per-worker session storage and a retention
  question, and nothing here depends on it. The invariant it must preserve is
  D1 — takeover opens a *new* interactive session over a stored history; it
  never makes tmux the parent of a live worker.
- **Q4 — Does `foldEvents` tolerate unknown event kinds today?** If not, adding
  worker-lifecycle kinds breaks replay of older traces, and the fold needs the
  tolerance first (task 1.1 verifies this before anything else is added).
