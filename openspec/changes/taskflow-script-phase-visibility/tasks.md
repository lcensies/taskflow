# Tasks

## 1. Core live activity [sequential]

- [x] 1.1 Add optional `onLive(text)` to `runScriptCommand`; emit the latest non-empty line from each stdout/stderr chunk. In the `runtime.ts` script dispatch, push `$ <command>` at spawn and wire `onLive` to `pushLive` + `emitProgress`. Verify a `script.test.ts` case sees the command then streamed lines in `liveLog` and unchanged `output`.

## 2. Pi render [sequential]

- [x] 2.1 Show truncated command instead of `script` in the role column of `render.ts` (pending/running/done) and `inspector-view.ts` phase line. Verify `render.test.ts` covers pending + running script rows with live text.

## 3. Integration [sequential]

- [x] 3.1 `pnpm run typecheck`, `env -u PI_TASKFLOW_PI_BIN pnpm test`, `openspec validate taskflow-script-phase-visibility --strict`.

## Verification

- `pnpm run typecheck`: passed.
- Focused: `script.test.ts`, `render.test.ts`, `inspector-view.test.ts` — 85 passed.
- Full `pnpm test`: 3124 passed, 18 failed — all pre-existing on a clean tree (`flow-def.test.ts` 10s timeouts, one `trace` unreplayable-marker test, one Hermes probe test); unrelated to this change.
