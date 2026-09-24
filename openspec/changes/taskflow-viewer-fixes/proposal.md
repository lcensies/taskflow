## Why

Four pi-host viewer problems reported in daily use:

1. In-flight taskflow tool call flickers ("glitters") while rendering.
2. `/tf runs` panel sometimes stops re-rendering while a run is active.
3. Flows compiled from OpenSpec `tasks.md` show phase rows as `t1-2` — the task number, not what the task does.
4. Subagent output is not viewable: the inspector only has a 20-line activity ring + final `output`; the full transcript is discarded when the child exits. Users want to open a phase and scroll through what the subagent actually did, the way pi's native subagent view allows.

## What Changes

- **Flicker**: stop constructing a fresh `Container`/`Text`/`Markdown` tree on every 120 ms heartbeat; clamp every emitted line to terminal width (the `↳ deps` suffix is unbounded today); skip the emit when nothing visible changed.
- **`/tf runs` refresh**: `hasChanged()` compares only `status` + `updatedAt`, and `updatedAt` is stamped only on the on-disk clone with a 1 s persist throttle. Compare a cheap per-run progress fingerprint (phase statuses + live text) instead, and always repaint when any listed run is `running`.
- **Phase labels**: add optional `label` to the Phase schema (display-only, ignored by interpolation/cache/FlowIR); `renderProgress`, inspector and runs panel show `label` when set, else `id`. `openspec2taskflow.py` emits `label` from the task text (`1.2 Add CSV utils…`, truncated).
- **Transcript viewer**: the pi subagent runner tees the child's raw NDJSON to `runs/<flow>/<runId>/<nodeId>.ndjson`. The inspector and runs-panel detail views gain a scrollable transcript pane (↑↓/PgUp/PgDn/Home/End/j/k/g/G, same conventions as approval view) that renders assistant text + tool calls + tool results from that file and tails it while the phase runs. `peek` gains `--transcript`.

## Capabilities

### New Capabilities
- `phase-transcript`: per-node subagent transcript persistence and an interactive, scrollable transcript viewer.
- `phase-label`: display label on phases, distinct from the interpolation id.

### Modified Capabilities
- `run-observability`: live rendering must be flicker-free and width-safe; the stored-run panel must repaint while any run is active; phase rows show labels.

## Impact

- `packages/taskflow-core/src/schema.ts` (Phase `label`), `store.ts` (transcript path helper + cleanup), `runner-core.ts` (`onRawLine` hook), `peek.ts`.
- `packages/pi-taskflow/src/{render,runs-view,inspector-view,runner,index}.ts` + new `transcript-view.ts`.
- `~/.pi/agent/skills/openspec-taskflow/scripts/openspec2taskflow.py` (emit `label`).
- Tests under `packages/taskflow-core/test` and `packages/pi-taskflow/test`.
