# Design

## Context

- `packages/pi-taskflow/src/inspector-view.ts:96-135` — `handleInput` has two modes (`list`, `detail`); list mode binds only `up`/`down`/`return`/`s`/`q`/`escape`.
- `inspector-view.ts:222-230` — list mode renders `renderProgress(...)` plus exactly one phase row (the selected one).
- `inspector-view.ts:152-158` — `openTail` comment: "Fan-out items (`<phase>-<n>.ndjson`) are out of scope: plain phase id."
- `packages/taskflow-core/src/runtime.ts:1603-1604` — `nodeIdFor(suffix)` → `<phaseId>-<idx>`; item transcripts land at `<transcriptDir>/<phaseId>-<n>.ndjson` (`store.ts:399`).
- `packages/taskflow-core/src/runtime.ts:499-553` — `mergePhaseState` collapses fan-out results into one `output` with `### [k/N] <agent>` sections and a `subProgress {done,total,running,failed}`. Per-item usage/model/status are **not** persisted.
- `packages/taskflow-core/src/peek.ts:95-109` — `splitItems(merged)` already parses those sections, keyed by the 1-based label; module-private today.
- `packages/pi-taskflow/src/index.ts:696-701` (`/tf runs`) and `:737-747` (`alt+t`) — both mount via `ctx.ui.custom` with no overlay options.
- `packages/pi-taskflow/src/scroll-pane.ts:22-44` — vim keys already implemented for pane scrolling.

## Goals / Non-Goals

**Goals**
- One navigator covering runs → phases → agents → agent detail.
- Individual subagent output viewing for fan-out phases, from live and stored runs.
- Vim and arrow navigation at every level.

**Non-Goals**
- No run-state schema change. Per-item usage/model/cost stay unpersisted; the agent level shows what already exists (index, agent name, derived status, transcript).
- No run control (pause / stop-one / restart-one) — that is parity gap #15 and depends on the execution model.
- No markdown/diff/syntax rendering of transcripts beyond today's `renderTranscript`.

## Decisions

1. **One component, a level stack — not a second navigator.**
   `InspectorComponent` grows `level: ("phases" | "agents" | "detail")[]` instead of `mode: "list" | "detail"`. `RunHistoryComponent` keeps the run list and, on Enter, constructs an `InspectorComponent` for the selected run and forwards render/input to it; its `onDone` pops back to the run list. Rationale: the existing component already owns transcript tailing, scroll pane, live polling, and steering; a parallel navigator would duplicate all of it.

2. **Agent rows are derived, never stored.**
   `agentRows(ps)` returns `[]` when `ps.subProgress` is absent (non-fan-out → drill straight to detail with the phase's own node id). Otherwise one row per `i in 0..total-1`:
   - label: agent name parsed from the `### [i+1/N] <agent>` section via the now-exported `splitItems`, else `item i+1`;
   - status: `done` when a section exists (or `i < subProgress.done`), `failed` when its label carries `(failed)`, else `running`/`pending` by position.
   Derivation keeps the change read-only against `taskflow-core` apart from one export.

3. **Node id for the agent detail is the existing dash form.**
   `<phaseId>-<idx>` (0-based), identical to `steerNodeIds` (`index.ts:713-721`) and `/tf peek --item` (`peek.ts:132-133`). No new naming scheme.

4. **Fallback body when no transcript file exists.**
   Agent detail with no transcript renders that item's `splitItems` section; if there is none, the existing live activity/output block. A stored run whose transcripts were pruned therefore still shows per-item output.

5. **Key map is one pure function.**
   `listKey(data)` → `"up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "in" | "out" | "close" | undefined`, shared by both components and unit-tested directly. Avoids three copies of the vim alias table.

6. **Steering stays phase-level.**
   `s` at the agent level steers the *owning phase* (all items), matching `steerNodeIds` today. Per-item steering is possible (each item has its own steer file) but is out of scope: the runtime records `steered` per phase, so a per-item flag would need a schema change.

7. **Overlay presentation is a mount option, not a rewrite.**
   `ctx.ui.custom(..., { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 } })`; the component keeps returning plain lines.
