# Proposal

## Why

Taskflow's Pi inspector guesses per-agent status from aggregate fan-out counts. Recon agents finish out of order, so the panel reports the wrong agent as done or running. Compared with locally installed pi-dynamic-workflows, useful token/cache breakdown and live agent detail are missing even though Taskflow already records phase usage.

## What Changes

- Record indexed map/parallel item states through live updates and at completion, including cached, failed, and budget-skipped items. Stop inferring item identity from counts or parsing output labels as state.
- Refresh persisted progress for foreground and detached Pi runs at a bounded cadence so other sessions can inspect ongoing fan-out; preserve checkpoint semantics for run decisions. Other hosts remain checkpoint-only.
- Show concise fresh/cache token usage and cost in the Pi run card and inspector, with per-item usage where known; keep changes width-safe and avoid repainting lines above the viewport on idle ticks.
- Do not copy Dynamic Workflows' session-wide panel, rolling token-rate sampler, syntax-highlighted transcript renderer, or empty-fleet heuristic: they add new state/UI complexity without resolving the reported recognition bug. Existing `/tf runs`, Pi's background-work widget, and transcript inspector cover basic navigation.

## Capabilities

### Modified Capabilities

- `run-observability`: Report true indexed subagent status/usage during fan-out and from stored runs, and show trustworthy token/cache totals without disrupting existing non-destructive inspection.

## Impact

`packages/taskflow-core/src/store.ts`, `runtime.ts`, Pi `render.ts`, `inspector-view.ts`, `runs-view.ts`, `index.ts`, focused tests, and `openspec/specs/run-observability/spec.md`. No new dependencies. Existing run files remain readable without per-item state.
