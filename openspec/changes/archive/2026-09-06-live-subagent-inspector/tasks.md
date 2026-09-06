## 1. Core: activity history

- [x] 1.1 Add `liveLog?: string[]` and `steered?: true` to `PhaseState` in `packages/taskflow-core/src/store.ts`; verify `pnpm run typecheck` passes.
- [x] 1.2 Add a bounded `pushLive(ps, text)` helper in `runtime.ts` (cap 20, drop-oldest, skip duplicate of last) and call it at every site that assigns `liveText` (`liveSink`, fan-out `refresh`, ctx-tree branch); verify a new unit test asserts ordering, dedup, and the cap.

## 2. Core: steering seam

- [x] 2.1 Add optional `steerFile?: string` to `RunOptions` in `packages/taskflow-core/src/host/runner-types.ts` and pass `nodeId` unconditionally from `baseRun` in `runtime.ts`; verify existing runner tests still pass (`pnpm test`).
- [x] 2.2 Add `steerDirFor(runsRoot, runId)` + `steerFileFor(runsRoot, runId, nodeId)` with the same `validateRunId` guard as `ctxDirFor`; verify a unit test rejects a traversal runId and returns the expected path shape.
- [x] 2.3 Thread `steerFile` into `RunOptions` in `baseRun` when `deps.steerDir` is set, for single-agent, fan-out, tree-reduce, and spawned-child calls; verify a runtime test with a mock runner sees a distinct `steerFile` per phase and per fan-out item.
- [x] 2.4 Add `steered?: () => boolean` to `PhaseCacheCtx` and an early return in `recordCache`; verify a unit test shows a steered done phase is not written to the cross-run cache while an unsteered sibling is.

## 3. pi host: child-side delivery

- [x] 3.1 In `packages/pi-taskflow/src/runner.ts`, inject taskflow's own extension path plus `PI_TASKFLOW_STEER_FILE`/`PI_TASKFLOW_NODE_ID` when `opts.steerFile` is set, reusing the existing `extensionPaths` block (works with `--no-extensions`); verify a unit test on the arg/env builder shows the extension and env present with steering and absent without.
- [x] 3.2 Drain lines already queued for a node at spawn, append them to the task prompt under an explicit heading, and persist the byte offset; verify a unit test shows pre-queued lines land in the prompt exactly once.
- [x] 3.3 In `packages/pi-taskflow/src/index.ts` child mode, start a steer watcher (`fs.watch` + 1s poll, offset-based reads) that calls `pi.sendUserMessage(line, { deliverAs: "steer" })` per new line and stops on session end; verify a unit test drives the watcher against a temp file and asserts two appended lines produce two ordered deliveries with no re-delivery.

## 4. pi host: inspector

- [x] 4.1 Publish the in-flight `RunState` from `runFlow` to a module-level active-run registry and clear it in `finally`; verify a unit test shows the registry is empty after a run resolves and after a run throws.
- [x] 4.2 Add a phase-detail component (activity log, partial output, status, model, usage, attempts, scrolling) and reuse it from both the inspector and `/tf runs`; verify a render test snapshots a phase with and without activity history.
- [x] 4.3 Register the inspector shortcut (default `ctrl+alt+t`, overridable via settings) opening the overlay on the active run, falling back to stored runs; verify a unit test covers shortcut registration and the fallback selection logic.
- [x] 4.4 Add the steer action in the phase detail view (prompt for text → append to the phase's steer file → mark the live phase `steered`), disabled with a reason when steering is unavailable; verify a unit test shows the file line written and the phase marked, and that a phase on a non-steering host reports unavailable instead of writing.
- [x] 4.5 Show recent activity per running phase in the expanded (Ctrl+O) render while `isPartial`; verify a render test asserts activity lines appear during a run and the final result block still appears after it.

## 5. Configuration and docs

- [x] 5.1 Add `taskflow.steering` to settings parsing with defaults (on with a UI, off headless/detached) and honor it in the runner; verify a settings unit test covers default, explicit-on, and explicit-off.
- [x] 5.2 Update `skills-src/taskflow/*` and `README.md` with the inspector shortcut and steering semantics, then run `node scripts/build-skills.mjs`; verify `packages/pi-taskflow/test/skills-build.test.ts` passes (drift guard).

## 6. Verification

- [x] 6.1 Run `pnpm run typecheck` and `pnpm test`; verify both pass with the new tests included.
- [x] 6.2 Confirm host neutrality: `taskflow-core` imports no host SDK and the codex/claude/opencode/grok runner arg tests are unchanged; verify `pnpm run test:hosts` passes.
