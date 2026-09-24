# Tasks

## 1. Node identity [sequential]

- [x] 1.1 Sanitize inside `transcriptFileFor` in `packages/taskflow-core/src/store.ts` using the same rule as `steerFileFor` (`packages/taskflow-core/src/steer.ts:27-29`): map `[^A-Za-z0-9._-]+` to `_` and reject `.`/`..`. Verify: new test in `packages/taskflow-core/test/` asserts `transcriptFileFor(d, "review:api")` equals the path the runtime writes for a phase id `review:api`, and that `"../x"` resolves inside `d`.

## 2. Transcript coverage [sequential]

- [x] 2.1 In `packages/taskflow-core/src/detached-runner.ts`, wire `transcriptDir: transcriptDirFor(runsRoot, state.flowName, state.runId)` into the `RuntimeDeps` it builds, mirroring `packages/pi-taskflow/src/index.ts:632`. Verify: a detached run in `packages/taskflow-core/test/` (or the existing detached test) produces a `.ndjson` under the run's transcript dir.
- [x] 2.2 Pass a distinct `ctxNodeId` to the `runOne` calls that currently omit it in `packages/taskflow-core/src/runtime.ts`: tournament judge (~:3637) → `nodeIdFor("judge")`, loop iterations (~:3420) → `nodeIdFor("iter-" + iteration)`, race branches (~:2863) → `nodeIdFor("branch-" + idx)`, gate `onBlock: retry` second attempt (~:2719) → the phase's own node id. Verify: `packages/taskflow-core/test/runtime.test.ts` asserts one transcript file per judge / iteration / branch with a fake host.

## 3. Full-output toggle [sequential]

- [x] 3.1 Add an options argument to `renderTranscript` in `packages/pi-taskflow/src/transcript-view.ts` (`{ full?: boolean }`): when `full`, skip the `MAX_RESULT_LINES` cap and wrap lines with `wrapTextWithAnsi` instead of `truncateToWidth`. Default behaviour unchanged. Verify: test asserts a 100-line tool result shows 40 lines by default and 100 with `full`, and that no wrapped row exceeds the width.
- [x] 3.2 In `packages/pi-taskflow/src/inspector-view.ts`, hold a `full` flag on the component, toggle it on `ctrl+o` at the detail level (checked before `ScrollPane.handleKey`), reset the pane offset on toggle, and pass it to `renderTranscript`. Verify: test asserts `ctrl+o` changes the rendered line count for a long tool result and that the flag persists after leaving and re-entering a node. {needs: 3.1}
- [x] 3.3 Label the fallback block as recorded activity (no transcript available) and show the toggle state in the detail footer (`^O full` / `^O compact`). Verify: test asserts the footer text flips with `ctrl+o` and that the fallback body carries the label. {needs: 3.2}

## 4. Docs [sequential]

- [x] 4.1 Document the toggle and the widened transcript coverage in `skills-src/taskflow/core.md` (inspector section) and rebuild with `node scripts/build-skills.mjs`. Verify: generated `packages/pi-taskflow/skills/taskflow/SKILL.md` mentions `Ctrl+O`.
