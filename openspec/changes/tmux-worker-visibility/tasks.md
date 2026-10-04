# Tasks

## 1. Event-log tolerance (must precede any new event kind) [sequential]

- [x] 1.1 Determine whether `foldEvents` in `packages/taskflow-core/src/exec/fold.ts` ignores an event whose `kind` it does not know, and whether `upgradeTraceEvent` in `packages/taskflow-core/src/exec/events.ts` preserves it. If either drops or throws, make unknown kinds inert. Verify: test in `packages/taskflow-core/test/` folds a trace containing an unknown `kind` and asserts the `FoldedRun` equals the fold of the same trace with that line removed, with no throw. Answers design Q4.

## 2. Durable outcome record [sequential]

- [x] 2.1 Add `outcomeFileFor(transcriptDir, nodeId)` beside `transcriptFileFor` in `packages/taskflow-core/src/store.ts`, reusing the same node-id sanitization so writer and readers agree and no input escapes the run's transcript directory. Verify: test asserts `outcomeFileFor(d, "review:api")` matches the path the runtime writes and that `"../x"` resolves inside `d`.
- [x] 2.2 Write the outcome record from `finish()` in `packages/taskflow-core/src/runner-core.ts` (~:849-895), after `completionSource` is computed (~:1024-1030) and **before** the promise resolves: `completionSource`, exit code, terminating signal, `startedAt`/`endedAt`, child pid. Atomic write (tmp + rename), wrapped so a failure is swallowed. Verify: test with a fake child asserts a record exists for each of `process-exit`, `terminal-reap`, `idle-timeout`, `abort`, `protocol-error`, and that an unwritable directory leaves `RunResult` byte-identical. {needs: 2.1}
- [x] 2.3 Record the worker's pid/process-group id where a later process can find it, following the `heartbeatDetachedProcessRegistry` precedent in `packages/taskflow-core/src/detached-runner.ts:196`. Verify: test asserts the recorded id matches the spawned child's group and is readable after the spawning process exits. {needs: 2.2}

## 3. Reattach classification [sequential]

- [x] 3.1 Add a classifier that takes a stored node with status `running` and returns `running` / `finished-unrecorded` / `orphaned` per design D5: outcome record present → `finished-unrecorded`; absent and group alive → `running`; absent and group gone → `orphaned`. Pure function over (stored phase, outcome record, liveness probe) so it is testable without processes. Verify: unit test covers all three branches plus the case of a record for a node whose stored status already agrees. {needs: 2.3}
- [x] 3.2 Apply the classifier on run load in `packages/taskflow-core/src/store.ts`, adopting a `finished-unrecorded` outcome into the returned phase state and marking `orphaned` as its own reported state — never rewritten to `failed` or `completed`. Verify: test writes a run whose stored phase is `running` plus an outcome record, loads it, and asserts the loaded phase is finished with that `completionSource`; a second case with no record and a dead pid asserts `orphaned`. {needs: 3.1}
- [x] 3.3 Keep `orphaned` out of automatic recovery: assert that loading, listing, and resuming a run containing an orphaned node neither retries nor completes it, and that the state reaches the user. Verify: test asserts `resume` of such a run does not silently re-run the orphaned node without an explicit override. {needs: 3.2}

## 4. Verdict separate from exit [sequential]

- [x] 4.1 Add a verdict field to `PhaseState` in `packages/taskflow-core/src/store.ts`, distinct from `status`/`error`, defaulting to undetermined. A clean exit SHALL NOT set it. Verify: test asserts a phase whose worker exited 0 with no check has a successful process outcome and an undetermined verdict. {needs: 2.2}
- [x] 4.2 Have gate verdicts and `script` acceptance checks write the verdict field, leaving the recorded process outcome untouched. Verify: test asserts a blocking gate over a cleanly-exited node yields not-accepted while the node's `completionSource` stays `process-exit`/`terminal-reap`. {needs: 4.1}

## 5. Follow reader [sequential]

- [x] 5.1 Add `--follow` to `packages/taskflow-core/src/peek.ts`: tail the node's transcript, render through the same path the inspector uses (`renderTranscript` in `packages/pi-taskflow/src/transcript-view.ts`), wait rather than error when the file does not exist yet, and report the node as finished once its outcome record appears. Verify: test appends lines to a transcript while following and asserts each is rendered once, that a missing file is waited on, and that the finished banner follows the outcome record. {needs: 2.1}

## 6. tmux window surface [sequential]

- [x] 6.1 New `packages/pi-taskflow/src/tmux-viewer.ts`: open a window per node named `tf:<runId-short>:<nodeId>` running `peek --follow <transcriptFile>`, lazily on first output, idempotent per node, capped by a configured maximum. No handle on the worker is retained. **Hook it from `openTranscriptTee` in `packages/pi-taskflow/src/runner.ts` (~:86-129, opened at ~:393), which is already the "first output" seam — do NOT wire it from `runFlow` in `packages/pi-taskflow/src/index.ts`, which carries unrelated uncommitted work and must not be modified by any task in this change.** Verify: test with a stubbed tmux command asserts one window per node, no duplicate for a second call, the cap honoured with the skipped nodes reported, and no tmux invocation that references the worker's pid. {needs: 5.1}
- [x] 6.2 Default windows **on** (design D8): opened automatically when a node first produces output, bounded by a configured per-run cap; a setting and a per-phase override can disable them. Verify: test asserts a window is opened for a worker with no configuration present, that disabling via setting and via per-phase override each suppress every tmux invocation, that the override wins over the setting, and that a fan-out past the cap opens exactly cap windows with the remaining node ids reported. {needs: 6.1}
- [x] 6.3 Fail open when tmux is absent or no server is reachable: record a `warnings` diagnostic on the phase, change nothing else. Verify: test with a failing tmux stub asserts the run's phase results are identical to a run with windows disabled, and the warning is present. {needs: 6.1}
- [ ] 6.4 CANCELLED — steer-from-window. The inspector's `s` already steers a running phase through the same channel; a second entry point for the same action is redundant now that windows are opt-in.
- [ ] 6.5 CANCELLED — "do not close windows on finish" is satisfied by construction: 6.1 retains no handle on the worker and issues no `kill-window`.
- [x] 6.6 Flip the default to **off** (design D8 revised): per-node windows are opt-in, opened only when explicitly enabled. Keep the cap, the per-phase override, and the fail-open behaviour from 6.1-6.3. Verify: test asserts no tmux invocation occurs with no configuration present, and that enabling by setting (and by per-phase override) still opens exactly one window per node up to the cap.

## 7. Inspector surfacing [sequential]

- [x] 7.1 Render `orphaned` and `finished-unrecorded` distinctly from `running` in the inspector. Verify: test asserts distinct glyphs/labels for the three states. (The window indicator is dropped: windows are opt-in and the inspector is the primary per-node surface.) {needs: 3.2}

## 8. Docs [sequential]

- [x] 8.1 Document worker windows, the outcome record, and the three reattach states in `skills-src/taskflow/` (advanced + core as appropriate), then rebuild with `node scripts/build-skills.mjs`. Verify: generated `packages/pi-taskflow/skills/taskflow/*.md` mention `--follow`, the opt-in setting, and `orphaned`. {needs: 7.1}
