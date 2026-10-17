# Design

## Context

`runtime.ts` has an indexed fan-out worker pool (`runFanout`) but writes only aggregate `subProgress` into `PhaseState`; `inspector-view.ts` assigns per-item status from index thresholds, which fail on out-of-order completion. `safeProgress` emits in-memory updates without persistence, and Pi `runFlow` does not bind `onProgress`. Per-run `UsageStats` already records input/output/cacheRead/cacheWrite/cost/turns. `pi-dynamic-workflows` records per-agent snapshots and formats fresh/cache tokens separately; Taskflow already has an inspector and background-work widget.

## Goals / Non-Goals

**Goals:** source indexed statuses from worker lifecycle, preserve them for stored runs, refresh disk progress without per-event writes, and display trustworthy compact usage.

**Non-Goals:** copy Dynamic Workflows' session-wide run registry, add token-rate sampling, invent per-item acceptance verdicts, or rework transcript syntax highlighting.

## Decisions

1. **Item state belongs to `PhaseState`, indexed by original input position.** Add optional `items` carrying status, agent name, and known usage (plus latest activity when present). `runFanout` updates an item before spawn, on cache hit, while streaming, on settle, and on budget skip. Aggregate `subProgress` remains for existing consumers; terminal `mergePhaseState` attaches the same indexed items without deriving from output text. Alternative: infer from aggregate counts or output sections — impossible while siblings finish out of order; terminal budget skips have no sections.
2. **No fictitious states for legacy runs or non-agent subflows.** `agentRows` receives phase type and reads indexed items only for map/parallel; legacy missing item state displays `unknown` per index. Flow phases' `subProgress` counts child phases, not fan-out agent nodes: drill directly into flow detail instead of creating phantom `flow-0` transcript IDs. Alternative: synthesize done/running counts — recreates reported bug.
3. **Use bounded live persistence for foreground and detached Pi runs.** Bind Pi's `onProgress` to `persistThrottled`; write live snapshots at most once per second, including a trailing update during quiet periods, and always at normal checkpoints. Pi detached launch explicitly opts into the same policy through its launch context; other hosts retain checkpoint-only behavior. Intermediate writes and callbacks fail open. Store is bounded: one status/usage/latest text per item, no duplicate transcript or unbounded log.
4. **Show measured usage only.** Share a small formatter for fresh=input+output+cacheWrite and separate cacheRead, using existing `formatTokens`; phase and item cells show nothing until numbers known. Cost below display precision reads `<$0.0001`. In collapsed card, live usage stays on final changing line to avoid regular-mode full redraw; stable item counts may change only on actual progress. Alternative: port the Dynamic Workflows UI wholesale — adds manager state and rendering churn without improving correctness.

## Risks / Trade-offs

- O(N) item snapshot per live persist for wide fan-outs → limit stored fields; throttle writes. A future scale issue can add deltas, not now.
- Historic runs have no exact per-item state → show unknown rather than lie; completed output can still be viewed in detail.
- Per-item usage may be unreported by provider → omit cell instead of claiming zero.
- Multi-process readers see up to one-second stale state → sufficient for inspection; no execution semantics depend on it.

## Migration Plan

Optional fields only. Existing run files continue loading; no migration rewrite. Regression tests cover out-of-order completion, cache/skip, cross-process snapshot, legacy state, flow drilldown, width and cost precision. Rollback drops new fields with no change to run execution.
