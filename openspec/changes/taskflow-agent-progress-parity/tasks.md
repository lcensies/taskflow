# Tasks

## 1. Indexed fan-out lifecycle [sequential]

- [x] 1.1 Add optional bounded per-item status, agent, usage and live-text fields to `PhaseState` and update `runFanout` to set each by original index on start, stream, cache hit, budget skip and finish; carry indexed records into `mergePhaseState`. Verify an out-of-order map test distinguishes completed high-index item from running low-index item and a cache/skip test preserves original indices and final status.
- [x] 1.2 Make the Pi inspector use indexed records for map/parallel rows, indicate unknown for legacy runs without them, and avoid fabricating item rows for `flow` phases. Verify `inspector-view.test.ts` covers out-of-order state, skipped, legacy, and flow drill-in.

## 2. Live persistence [sequential]

- [x] 2.1 Wire foreground and detached Pi live progress into bounded `saveRun` paths without changing core checkpoint semantics; detached Pi launch opts in while other hosts remain checkpoint-only. Keep callback/write failures fail-open and flush updates during quiet periods. Verify host tests see in-flight indexed state on disk for both execution modes, no-opt-in hosts stay checkpoint-only, and one failing intermediate write leaves the run result unchanged.
- [x] 2.2 Refresh `/tf runs` when indexed progress/activity changes or a listed run is running, and merge same-process active state over disk; verify `runs-view.test.ts` covers long quiet phase, live in-memory state, and changed subagent status.

## 3. Usage surfaces [sequential]

- [x] 3.1 Add small shared formatter using existing `UsageStats` and `formatTokens`; display measured fresh tokens (input+output+cacheWrite) and cacheRead separately plus `<$0.0001` for tiny positive costs in Pi progress footer and inspector phase/item detail. Verify tests for cache split, whole-phase cross-run cache hits carrying no stale per-item spend, missing usage, small cost, 40-column rendering, and no above-footer timer mutation in the collapsed card.

## 4. Integration [sequential]

- [x] 4.1 Run `pnpm run typecheck` and `env -u PI_TASKFLOW_PI_BIN pnpm test` plus `openspec validate taskflow-agent-progress-parity --strict`; record any live Pi redraw check as pending unless actually run. Verify all commands pass.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm test`: 2,571 passed; 0 failed. Cleared inherited `PI_TASKFLOW_PI_BIN`, `PI_TASKFLOW_STEER_FILE`, `PI_TASKFLOW_STEER_OFFSET`, `PI_TASKFLOW_CTX_DIR`, and `PI_TASKFLOW_NODE_ID` for child-run checks.
- `openspec validate taskflow-agent-progress-parity --strict` and `git diff --check`: passed.
- Final read-only review: no blocking findings; 77 focused tests passed.
- Live Pi redraw check: pending; not performed.

## Non-blocking follow-ups

- Foreground timer still saves unchanged running state once per second; dirty-only persistence could reduce synchronous disk work.
- Event-kernel nested flow progress forwards counts but not activity text; kernel remains off by default.
- Tournament variant drill-down is outside this map/parallel scope; current inspector opens phase detail instead.
