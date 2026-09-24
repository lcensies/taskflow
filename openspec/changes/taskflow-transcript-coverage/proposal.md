# Transcript coverage + full-output toggle

## Why

The navigator added in `taskflow-navigator-tui` renders a per-node detail view, but for most real runs it has nothing good to render:

1. **Detached runs write no transcripts at all.** `detached-runner.ts` builds its `RuntimeDeps` without `transcriptDir`, so every `detach: true` run produces zero `.ndjson` files. The navigator then falls back to `PhaseState.liveLog`, which core bounds at 20 entries of already-summarized text — that is the "compact output" a user sees after any background run.
2. **Several node kinds never get a transcript even in the foreground.** The tournament judge (`runtime.ts:3637`), loop-body iterations (`:3420`), race branches (`:2863`) and a gate's `onBlock: retry` second attempt (`:2719`) call `runOne` without a `ctxNodeId`, so `transcriptFile` stays undefined.
3. **Reader/writer node-id mismatch.** The writer sanitizes (`nodeIdFor` → `[A-Za-z0-9._-]`), but `transcriptFileFor` joins the id raw and both readers (`peek.ts`, the navigator) pass unsanitized phase ids. A phase id like `review:api` is written as `review_api.ndjson` and read as `review:api.ndjson` → "no transcript", silently. The same raw join lets a flow-authored id containing `..` address a path outside the run directory.
4. **Even with a transcript, the detail view is capped.** Tool results are cut at 40 lines and every line is hard-truncated to the panel width, with no way to see the rest.

## What Changes

- **Detached runs record transcripts** — the detached runner wires `transcriptDir` exactly as the foreground host does.
- **Every subagent call gets a node id** — judge, loop iteration, race branch, and gate-retry calls pass a distinct `ctxNodeId`, so each has its own transcript and its own navigator row.
- **One sanitizer for node ids**, applied in `transcriptFileFor` itself (like `steerFileFor` already does), so writer and reader agree and path traversal is impossible.
- **`Ctrl+O` toggles full output** in the detail view: no tool-result line cap, long lines wrapped instead of truncated. The toggle persists while the navigator is open and is shown in the footer.
- **Transcript beats liveLog**: when a node has a transcript the detail view uses it; the activity block is the fallback, and says so.

## Capabilities

### New Capabilities

- `full-output-toggle`: a keyboard toggle between the bounded reading view and the complete, wrapped node output.

### Modified Capabilities

- `phase-transcript`: transcripts are recorded for detached runs and for every subagent call kind; node-id sanitization is owned by the path helper.

## Impact

- `packages/taskflow-core/src/detached-runner.ts` — pass `transcriptDir`.
- `packages/taskflow-core/src/store.ts` — sanitize in `transcriptFileFor`.
- `packages/taskflow-core/src/runtime.ts` — `ctxNodeId` for judge / loop / race / gate-retry calls.
- `packages/pi-taskflow/src/inspector-view.ts`, `transcript-view.ts` — `Ctrl+O` full mode, transcript-over-liveLog preference.
- Tests: `packages/taskflow-core/test/{runtime,peek}.test.ts`, `packages/pi-taskflow/test/{inspector-view,transcript-view}.test.ts`.
