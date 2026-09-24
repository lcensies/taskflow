# Design

## Context

- `packages/taskflow-core/src/detached-runner.ts` — builds `RuntimeDeps` with no `transcriptDir` (grep for it returns nothing); the foreground host sets it at `packages/pi-taskflow/src/index.ts:632`.
- `packages/taskflow-core/src/store.ts:394-400` — `transcriptDirFor(runsRoot, flowName, runId)` and `transcriptFileFor(dir, nodeId) = join(dir, nodeId + ".ndjson")` (raw join).
- `packages/taskflow-core/src/steer.ts:27-29` — the sanitizing sibling to copy.
- `packages/taskflow-core/src/runtime.ts:1603-1604` — `nodeIdFor(suffix)`; `:1770-1771` — `transcriptFile` only set when `ctxNodeId` is present.
- Callers without `ctxNodeId`: `runtime.ts:2719` (gate retry), `:2863` (race branches), `:3420` (loop iterations), `:3637` (tournament judge). Compare `:2508` (`nodeIdFor("judge")`) and `:2188` (`nodeIdFor(String(idx))`), which do pass one.
- `packages/pi-taskflow/src/transcript-view.ts:13,38-46` — `MAX_RESULT_LINES = 40` and the per-line `truncateToWidth`.
- `packages/pi-taskflow/src/inspector-view.ts` — `detailLines()` picks `renderTranscript(...)` when the tail has entries, else `fallbackBody(ps)`.

## Goals / Non-Goals

**Goals**
- A transcript exists for every subagent call, in every run mode.
- One node identity, sanitized once, used by writer and every reader.
- A key that reveals the complete output of the node being viewed.

**Non-Goals**
- No change to the transcript file format or to `parseTranscript`.
- No cross-node "whole run log" view — the navigator's per-node model stays.
- No raw-ndjson debug mode.
- No change to `LIVE_LOG_MAX`: with transcripts present, `liveLog` stops being the primary source.

## Decisions

1. **Sanitize inside `transcriptFileFor`, not at each call site.**
   Reuse the `steerFileFor` rule (`[^A-Za-z0-9._-]+` → `_`, reject `.`/`..`). Every existing caller keeps its current argument; the writer already passes a sanitized id, so the mapping is idempotent and no stored file needs migration.

2. **New node ids follow the existing dash form.**
   `nodeIdFor("judge")` already exists; add `nodeIdFor("iter-" + n)` for loop bodies, `nodeIdFor("branch-" + idx)` for race branches, and let a gate's retry attempt reuse the phase's own node id so its attempts append to one file behind an attempt marker (matching retry semantics elsewhere).

3. **Detached runner mirrors the host wiring, not a new mechanism.**
   `transcriptDirFor(runsRoot, flowName, runId)` computed from the run's own state, so a detached run's files land where `/tf peek`, the navigator, and run retention already look.

4. **The toggle is a render flag, not a second renderer.**
   `renderTranscript(entries, width, theme, { full })`: `full` drops `MAX_RESULT_LINES` and routes every line through `wrapTextWithAnsi` instead of `truncateToWidth`. Default stays today's behaviour, so the existing width tests still hold.

5. **`Ctrl+O` is owned by the detail level and checked before `ScrollPane`.**
   It lives on the component, not in `listKey` (it is not a navigation intent). Toggling resets the pane offset to keep the view anchored, and the footer shows `^O full`/`^O compact`.
