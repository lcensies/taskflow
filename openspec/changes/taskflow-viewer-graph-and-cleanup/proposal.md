# Proposal

## Why

Four viewer complaints from daily pi-host use:

1. **Old runs and saved flows pile up with no way to clear them.** `/tf runs` lists up to 50 stored runs and `/tf list` lists every saved flow; neither panel nor the tool can delete one. Retention is only the opportunistic age/count sweep inside `saveRun`, so a user who wants a clean list has to delete JSON files by hand.
2. **Models are not shown per step.** The progress card only prints a model for a phase that has already started (`PhaseState.model`); pending rows show `—`, so a user cannot see which model a step is *about* to use. The run navigator's phase list shows no agent or model at all.
3. **A DAG is rendered as a pipeline.** `renderProgress` lays phases out in topological layers and annotates only "long" forward edges. Edges that go *backwards* — a `loop` phase's own iteration, and a `gate` with `onBlock:"retry"` that re-runs its upstream dependencies — are invisible, so a flow that can return to an earlier stage reads as a straight pipeline. The navigator's phase list has no edge information at all.
4. **The currently executing stage is not identifiable.** Status glyphs distinguish `◐ running` from `○ pending`, but nothing marks "this is where the run is right now", and — worse — a run opened from `/tf runs` is a stale snapshot: the panel's poll replaces its run objects while the open navigator keeps the object it was constructed with, so phase statuses never advance.

## What Changes

- **Delete stored runs**: the runs panel gains a delete key with an inline confirm, plus "clear all finished runs"; `taskflow-core` gains `deleteRun(cwd, runId)` and `deleteTerminalRuns(cwd)` that remove the run file, trace, transcripts, context/workspace artifacts and index entry under the existing locks, and refuse a `running` run.
- **Delete saved flow definitions**: `deleteFlow(cwd, name, scope)` in `taskflow-core`, surfaced as `taskflow` tool `action="delete"` (with `name` for a flow, `runId` for a run) and as a delete key in the flow list.
- **Model per step**: phase rows resolve a model for *every* phase — `PhaseState.model` once known, else the phase's authored/role-resolved model, shown dimmed as "planned" — in the progress card, the navigator phase list, and the navigator detail header.
- **Back-edges rendered**: `loop` phases render a self-loop marker with their iteration count; a `gate` with `onBlock:"retry"` renders a retry edge back to each dependency it would re-run; both the progress card and the navigator phase list show them, so a flow that can return to an earlier stage no longer reads as a pipeline.
- **Current stage marked**: the running phase(s) get an explicit current-stage marker distinct from the status glyph, and the navigator cursor starts on the running phase; the runs panel pushes refreshed run state into an open navigator so a stored or detached run advances live.

## Capabilities

### New Capabilities

- `run-cleanup`: deleting stored runs and saved flow definitions — the engine operations, their safety rules, and the UI/tool entry points.

### Modified Capabilities

- `run-observability`: phase views must identify the model for every phase (planned or actual), mark the currently executing phase, render back-edges (loop iteration, gate retry-to-upstream) rather than a flat pipeline, and keep an open navigator in sync with refreshed run state.

## Impact

- `packages/taskflow-core/src/store.ts` — `deleteRun`, `deleteTerminalRuns`, `deleteFlow` (reusing the existing lock/snapshot/artifact-removal helpers); barrel export in `index.ts`.
- `packages/pi-taskflow/src/render.ts` — planned-model column, current-stage marker, loop/retry back-edge rendering.
- `packages/pi-taskflow/src/inspector-view.ts` — model + edge info in phase rows, current-stage marker, cursor defaults to the running phase, state refresh entry point.
- `packages/pi-taskflow/src/runs-view.ts` — delete/clear keys with confirm, pushes refreshed state into the open navigator.
- `packages/pi-taskflow/src/index.ts` — `action="delete"` wiring, flow-list delete.
- Tests under `packages/taskflow-core/test` and `packages/pi-taskflow/test`; skills/docs for the new tool action.
