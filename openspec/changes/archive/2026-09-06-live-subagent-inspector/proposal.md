## Why

While a taskflow run is executing, the host TUI shows one activity line per running phase and nothing else. `/tf peek` and `/tf runs` exist, but slash input is queued while the `taskflow` tool blocks the turn, so they are unreachable exactly when the user wants them. The user cannot see what a subagent is doing, cannot read its recent activity, and cannot redirect it — the only options are wait or abort the whole run. Competing pi delegation extensions (pi-subagents, @tintinweb/pi-subagents, pi-crew, pi-muselinn-harness) all solve this with a live inspector plus mid-run steering; taskflow's process-isolated subagents currently cannot be inspected or steered at all.

## What Changes

- **Per-phase activity log**: `PhaseState` gains a bounded `liveLog` ring (last N activity lines) alongside the existing single `liveText`. It rides the existing throttled run persistence, so it is available live, post-hoc via `peek`, and for detached runs.
- **Live inspector overlay (pi host)**: a keyboard shortcut (default `ctrl+alt+t`) opens an interactive overlay *during* an active run — phase list, per-phase detail (activity log, partial output, usage, model, attempts), falling back to stored runs when nothing is active. Shortcuts are the only input path that works while the turn is blocked.
- **Mid-run steering (pi host)**: from the inspector the user can send a message to a running phase's subagent. Delivery reuses the existing child-side extension seam: the spawned child already loads taskflow's own extension for `ctx_*` tools; it gains a watcher on a per-node steer file and delivers each line via `sendUserMessage(text, { deliverAs: "steer" })`. A message written before a phase starts is drained into that phase's task prompt at spawn.
- **Steered phases are not cache-reusable**: a phase that received steering is marked so cross-run cache reuse cannot replay a pre-steering answer for a definition that no longer produced it.
- **Expanded (Ctrl+O) tool rendering while running** shows recent activity lines per running phase instead of only the (still empty) final result.
- Steering is opt-in-able and host-scoped: hosts without the capability (codex, claude, opencode, grok) are unaffected and keep working unchanged.

## Capabilities

### New Capabilities
- `run-observability`: live inspection of an in-flight taskflow run — per-phase activity history, an interactive inspector surface reachable while the host turn is blocked, and its read-only guarantees.
- `subagent-steering`: delivering user messages into a running (or not-yet-started) phase's subagent, its delivery semantics, and the consequences for caching.

### Modified Capabilities
<!-- none: no existing openspec specs in this repo yet -->

## Impact

- `packages/taskflow-core/src/store.ts` — `PhaseState.liveLog`, `steered` markers.
- `packages/taskflow-core/src/runtime.ts` — append to `liveLog` where `liveText` is set; always pass `nodeId` in `RunOptions`; drain pending steer messages into a phase task; suppress cross-run cache reuse for steered phases.
- `packages/taskflow-core/src/host/runner-types.ts` — optional `steerDir` passthrough in `RunOptions` (host-neutral, ignorable).
- `packages/pi-taskflow/src/runner.ts` — inject taskflow's own extension + steer env into the child when steering is enabled (reuses the `ctx_*` injection path).
- `packages/pi-taskflow/src/index.ts` — child-mode steer watcher; host-mode active-run registry, shortcut registration, overlay wiring.
- `packages/pi-taskflow/src/runs-view.ts` / `render.ts` — phase-detail view reused for live and stored runs; expanded live rendering.
- Settings: `taskflow.steering` (enable/disable), shortcut override.
- No new runtime dependencies. No change to the tool schema or the DSL.
