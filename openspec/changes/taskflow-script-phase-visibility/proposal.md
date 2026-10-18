# Proposal

## Why

A running `script` phase is a black box in the Pi tool card: the row reads `build  script  script` — type badge and role column both say `script`, the command is never shown, and no live activity line appears while the command runs (agent phases get `› <latest tool call>`). `runScriptCommand` buffers stdout/stderr until exit and never touches `PhaseState.liveText`/`liveLog`, so the inspector's "recorded activity" block is also empty for scripts, both live and post-hoc.

## What Changes

- Script phases record the command as the first activity line (`$ <run>`) at spawn and stream the latest stdout/stderr line into `liveText`/`liveLog` through the existing `pushLive` ring, so the card, inspector, and `peek` see what a script is doing without new state or UI.
- The Pi card and inspector role column show the (truncated) command for `script` phases in pending, running, and done states instead of repeating the type name.
- Nothing is added to `output`; stdout capture, caps, exit semantics, and caching are unchanged.

## Capabilities

### Modified Capabilities

- `run-observability`: script phases expose their command and live output through the same activity fields agent phases already use.

## Impact

`packages/taskflow-core/src/runtime/phases/script.ts` (optional `onLive` callback), `runtime.ts` (script dispatch wires `pushLive` + `emitProgress`), Pi `render.ts` + `inspector-view.ts` (role column), focused tests. No new dependencies; stored runs gain `liveLog` entries for script phases, readable by existing viewers.

## Non-goals

- Event-kernel (`exec/step.ts`, default OFF) script streaming — single-agent kernel phases do not push `liveText` either; out of scope.
- Streaming full stdout into the card; only the latest line, same as agent activity.
- Other hosts' TUIs (MCP hosts render their own progress).
