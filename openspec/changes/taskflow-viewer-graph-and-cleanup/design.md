# Design

## Context

All four problems live in the pi host's viewer plus one missing engine capability (deletion). The engine already records everything the viewer needs except a planned model for a phase that has not started, and `store.ts` already owns every lock/containment/artifact-removal helper deletion needs — the opportunistic retention sweep (`cleanupTerminalRuns` + `cleanupRunArtifactsIfSnapshotMatches`) does exactly the work an explicit delete must do.

## Goals / Non-Goals

**Goals**
- Explicit deletion of a stored run, of all finished runs, and of a saved flow definition — reusing the existing retention machinery rather than writing a second unlink path.
- A model on every phase row, including phases that have not started.
- Loop and gate-retry back-edges visible in both phase views.
- An unmistakable "running now" marker, and an open navigator that tracks refreshed state.

**Non-Goals**
- No ASCII box-and-arrow graph renderer. Rows stay a topologically ordered list; edges are annotations on rows.
- No MCP/host-adapter surface for deletion in this change (pi host + core only).
- No change to retention defaults or to `saveRun`'s automatic sweep.

## Decisions

### 1. Deletion reuses the retention path

`store.ts` gains:

```ts
export type DeleteRunResult = { ok: true } | { ok: false; reason: "running" | "missing" };
export function deleteRun(cwd: string, runId: string): DeleteRunResult;
export function deleteTerminalRuns(cwd: string): number;      // returns runs removed
export function deleteFlow(cwd: string, name: string): boolean;
```

`deleteRun` loads the run (`loadRun`), refuses when `status === "running"`, drops its entry under the index lock, then calls the existing `cleanupRunArtifactsIfSnapshotMatches(root, extractIndexEntry(state, relPath))`. That helper already re-validates the snapshot under the per-run lock and removes the run file, `.trace.jsonl`, transcript dir, `ctx/<runId>`, `ws/<seg>` and detached control records. `relPath` comes from the index entry when present, else is derived as `<safeFlowDirName(flow)>/<runId>.json` for the legacy flat/unindexed layout.

*Why not a fresh unlink routine:* every path-traversal, symlink and device/inode guard is already in that helper. A second copy is a second place to get them wrong.

`deleteTerminalRuns` is `listRuns` → `deleteRun` for each non-running run, counting successes. `deleteFlow` resolves the definition through `getFlow` (so it only ever touches a discovered flow file), unlinks the file under its `.lock` and the adjacent `.meta.json`, and returns `false` when the name is unknown.

**Alternative rejected:** a `taskflow_delete` MCP tool and host-adapter plumbing. Out of scope; the pi tool action plus the panel keys cover the reported need.

### 2. Planned model is resolved by the host, not stored

`PhaseState.model` stays "the model that actually ran". For a phase that has not started, the viewer resolves `phase.model ?? agents[phase.agent]?.model` (the agent map already has `{{role}}` references resolved by `discoverAgents`). Core exports a one-line helper so the resolution rule lives in one place:

```ts
export function plannedModelFor(phase: Phase, agents: Map<string, AgentConfig>): string | undefined;
```

The viewer takes an optional `plannedModel?: (phase: Phase) => string | undefined` resolver; the pi host builds it once per panel from `discoverAgents(ctx.cwd, …)`. A planned model renders dimmed and parenthesised as `（model）` with a leading `~`, distinct from an actual model; with no resolver and no `PhaseState.model`, nothing is printed.

**Alternative rejected:** stamping the planned model into run state at flow start. It would make `PhaseState.model` ambiguous (planned vs actual) and bloat every stored run.

### 3. Back-edges are row annotations

Two sources of "the run can return to an earlier stage" exist in the DSL, and both are static properties of the definition:

| Source | Annotation |
|---|---|
| `type: "loop"` | `↻ self` plus `×N` once `PhaseState.loop.iterations` is known |
| `type: "gate"` + `onBlock: "retry"` | `↺ <dep1, dep2>` — the dependencies that get re-run, capped by `retry.max` |

Rendered in the same column as the existing `↳ long-edge` annotation, in both `render.ts` rows and the navigator's phase rows, and present while the phase is still pending. A flow with neither is byte-identical to today.

**Alternative rejected:** a real graph renderer (box drawing with routed back-arrows). Large, width-fragile, and the complaint is "I can't see that it can go back", which an annotation answers.

### 4. Current stage is its own column

A one-cell "now" column between the rail gutter and the status glyph holds `▸` for a running phase and a space otherwise; the running row's label renders bold. The navigator's phase rows use the same marker, and a navigator opened on a run with a running phase starts its cursor there (first running phase in definition order).

*Why not reuse the `◐` glyph:* `◐` is a status (one of five); "where is the run right now" must survive scanning a 30-row list, and concurrent phases need the same marker on several rows.

### 5. The runs panel pushes state into the open navigator

`InspectorComponent` gains `setState(state: RunState)` (replaces the rendered state, keeps the level stack and cursors, invalidates the cache). `RunHistoryComponent.poll()` calls it for the open run when the refreshed list contains a run with the same `runId`. This is the fix for the stale-snapshot bug: the panel already re-reads from disk every second, but the navigator kept the object it was constructed with.

### 6. Interactive delete needs a confirm

`d` on the runs list arms a confirmation shown in the footer (`delete <flow> <runId>? y/n`); only `y` deletes, any other key cancels. `D` arms the same confirmation for "clear all finished runs" with the count in the prompt. A running run refuses with a notice instead of arming. After a successful delete the list refreshes and the selection clamps to a remaining run; deleting the last run closes the panel.

The tool gains `action: "delete"` taking `runId` (a run) or `name` (a saved flow), reporting what was removed. `/tf` gains a `delete <name>` subcommand for saved flows. A `/tf:<name>` command registered for a deleted flow stays registered until the next session — noted in the output, not worked around.

## Risks / Trade-offs

- **Deleting a run another process is writing.** The status check plus the per-run lock and snapshot re-validation inside the reused helper mean a racing `saveRun` wins and the delete is refused (fail-open, run kept). Acceptable: the user retries.
- **Row width.** The "now" column plus back-edge annotations add cells; every emitted line already goes through `truncateToWidth`, and tests assert width safety at 40 cols.
- **Planned model can be wrong** if settings change between panel open and execution. It is marked as planned (`~`) for exactly this reason.

## Migration

None. New API is additive, the renderer changes are display-only, and flows/runs on disk are untouched.
