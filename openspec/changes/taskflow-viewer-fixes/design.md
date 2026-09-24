## Context

- Rendering path: `runFlow()` heartbeat (`index.ts:515`, 120 ms) → `onUpdate` → pi `tool_execution_update` → `renderResult` → `renderRunResult` (`render.ts:395`), which builds a fresh `Container/Text/Markdown` tree each frame. pi-tui diffs lines; any changed line **above the viewport top** forces `fullRender(true)` (clear screen + scrollback) — see `pi-tui/dist/tui.js` "firstChanged < viewportTop". A taskflow block taller than the terminal has its animated header (spinner, elapsed) above the viewport → full clear 8×/s. `clearOnShrink` (default off) plus liveText sub-lines appearing/disappearing also change block height. `↳ deps` suffix (`render.ts:336`) is not width-clamped (pi throws on overflow).
- `/tf runs`: `RunHistoryComponent.poll()` (`runs-view.ts:93`) repaints only when `hasChanged()` sees a different root `status`/`updatedAt`. `persist` runs only at checkpoints (`runtime.ts safeEmit`, phase start/end) — never on live updates — so during a long phase the file is static, elapsed timers freeze and phase live text never refreshes. Same-process active runs are available in memory via `getActiveRun()` (`active-run.ts`) but the panel reads disk only.
- Phase schema (`schema.ts:169`) has no display field; `renderProgress` labels rows with `phase.id` only. `openspec2taskflow.py:pid()` produces `t1-2`.
- Subagent transcript: `EventAccumulator.messages` lives in memory only; `PhaseState` keeps `liveLog` (20 lines) + `output`. Child is spawned with `--no-session`. `runSubagentProcess` (`runner-core.ts:~520`) already splits stdout into complete lines (`consumeStdout`) before `foldLine`. Steering shows the plumbing shape for a per-node file: `RuntimeDeps.steerDir` → `runOne(…, ctxNodeId)` → `RunOptions.steerFile` (`runtime.ts:1752`), `nodeIdFor()` (`runtime.ts:1586`).
- Scrolling pattern already exists in `approval-view.ts` (`scrollOffset`, `clampScroll`, ↑↓/PgUp/PgDn/Home/End/j/k/g/G).

## Goals / Non-Goals

**Goals:**
- Flicker-free, width-safe in-flight rendering of the taskflow tool call, regardless of DAG size or terminal height.
- `/tf runs` repaints continuously while any listed run is running (timers tick, live text refreshes), using in-memory state for a same-process run.
- Human-readable phase rows for compiled OpenSpec flows without changing interpolation ids.
- Full subagent transcript per node persisted on disk and browsable (scroll) from the inspector and the runs panel, live while running and after the fact; also from `/tf peek`.

**Non-Goals:**
- Changing pi-tui's renderer, or pi's tool-execution component.
- Persisting transcripts for non-pi hosts (codex/claude/opencode runners) — the hook is host-neutral, wiring them is follow-up.
- Steering from inside the transcript view beyond what the inspector already offers.
- Search/filter inside transcripts.

## Decisions

1. **Flicker — keep changed lines inside the viewport and keep block height stable.**
   - Animated bits (spinner, run elapsed, cost) move from the header to a single **footer** line, which is the last line of the block (always visible while the block is the pending tool). Header keeps a static `▸` while running.
   - Per-phase elapsed is shown only on running rows and updates at most once per second (heartbeat renders spinner at 120 ms but the row string quantizes elapsed to seconds — already the case). Per-row spinner glyph is replaced by static `◐` on running rows; the only per-frame animation is the footer spinner.
   - `renderProgress` output is capped in the **collapsed** view: when the block would exceed `maxRows` (default 14: header + rows + footer), show running/failed rows plus their immediate neighbours and fold the rest into `… N done · M pending` lines. Expanded (Ctrl+O) view shows everything. The cap is computed from row count, not terminal height (renderer has no height).
   - Every line emitted by `renderProgress`/`renderRunningActivity` is passed through `truncateToWidth` with the width given to `render(width)`; `renderRunResult` therefore returns a component whose `render(width)` truncates (a small `Lines`-style component wrapping the string builder) instead of `new Text(...)`.
   - `emit()` in `runFlow` skips the `onUpdate` call when a cheap fingerprint (phase statuses, liveText, usage totals, footer second) is unchanged since the last emit → no redundant `tool_execution_update` → no diff work.
   - Verification: `PI_DEBUG_REDRAW=1` must show no `firstChanged < viewportTop` full renders during a run whose block is taller than the terminal.
   - Alternative rejected: lowering the heartbeat to 1 s — hides the stall but keeps the full-clear path for tall blocks.

2. **`/tf runs` — repaint on a progress fingerprint + always while running.**
   - `hasChanged()` replaced by `runFingerprint(r)`: `status|updatedAt|` + per-phase `status:liveText:usage.turns`. Polling compares fingerprints.
   - Additionally, if any listed run is `running`, `poll()` invalidates + requests render every tick regardless (elapsed timers must move).
   - `refresh()` merges `getActiveRun()?.state` (same process, live object) over the disk copy with the same `runId`, so a run executing in this process shows live text without waiting for a checkpoint persist.
   - `runFlow.persistThrottled` is also invoked from `onProgress` (throttled to 1 s, already exists) so detached/other-process viewers see live text at ≤1 s latency. Persist stays cheap (already throttled).

3. **Phase `label` — display-only, optional, ignored by identity.**
   - `PhaseSchema.label?: string` (1–120 chars, no newlines). Validation error otherwise.
   - Not part of the cache fingerprint (`cache.ts`), FlowIR hash (`flowir/`), interpolation, or the DSL erase output beyond pass-through. Tests assert that adding/changing `label` does not change `hashFlowIR` or a phase's `inputHash`.
   - Rendering: `renderProgress`, inspector `phaseLine`, runs-panel detail, `peek listPhases` show `label ?? id`; label column is capped at 40 cells with `…`; when a label is shown the id appears dim in the detail header (`t1-2 · 1.2 Add CSV utils`) so `{steps.<id>}` references remain discoverable. `↳ deps` continue to use ids.
   - `openspec2taskflow.py`: `"label": f"{number} {text}"` truncated to 80 chars at a word boundary; the tail phases get labels too (`build`, `spec-review`, … stay as-is since ids are already words).
   - Alternative rejected: making the id itself readable (`t1-2-add-csv-utils`) — breaks `{steps.t1-2.output}` references and `{needs:}` mapping, and widens every column.

4. **Transcript — tee raw child NDJSON per node; parse on read.**
   - `runner-core.runSubagentProcess` gains `onRawLine?: (line: string) => void`, called in `consumeStdout` for each complete stdout line (before `foldLine`, after the oversized-line guard). Fail-open: a throwing sink is caught once and disabled.
   - `RunOptions.transcriptFile?: string`; `RuntimeDeps.transcriptDir?: string`. Runtime resolves `transcriptFile = path.join(transcriptDir, \`${nodeId}.ndjson\`)` for every `runOne` call exactly where `steerFile` is resolved (`runtime.ts:~1752`), using the same `ctxNodeId`/`nodeIdFor` (so map/parallel items get `phase-0.ndjson`, judges `phase-judge.ndjson`, retries append to the same file). A retry appends a marker line `{"type":"taskflow_attempt","attempt":N,"at":ms}` first.
   - pi runner opens `fs.createWriteStream(transcriptFile, {flags:"a"})` when set; writes each raw line + `\n`; caps at 16 MiB per file (`PI_TASKFLOW_TRANSCRIPT_MAX_BYTES` override) then writes one `{"type":"taskflow_truncated"}` line and stops. Stream errors disable writing; never fail the run.
   - `store.ts`: `transcriptDirFor(runsRoot, flowName, runId)` → `<flowRunDir>/<runId>/` (sibling of `<runId>.json`); `transcriptFileFor(dir, nodeId)`; `listTranscripts(runsRoot, flowName, runId)` → nodeIds. Run cleanup (`store.ts:~1004`, where `.trace.jsonl` is removed) also removes the directory via the existing `removeArtifactDirectoryInsideRunsRoot`.
   - Host wiring (`index.ts runFlow`): `transcriptDir` is always set (headless included) — `peek --transcript` is useful without a UI.
   - Parsing: `transcript.ts` in `taskflow-core` exports `parseTranscript(text): TranscriptEntry[]` — walks `message_end` events; emits `{kind:"attempt"}`, `{kind:"text", role, text}`, `{kind:"tool_call", name, summary, args}`, `{kind:"tool_result", name, text, isError}`; tolerant of partial trailing line. `renderTranscript(entries, width, theme)` in `pi-taskflow/src/transcript-view.ts` → `string[]` (assistant text as-is wrapped, tool calls as `▸ bash $ cmd`, tool results dim, capped at 40 lines per result with `… (+N lines)`), each line `truncateToWidth`.
   - Viewer: `ScrollPane` (`pi-taskflow/src/scroll-pane.ts`) — offset, `handleKey(data): boolean` (↑↓/PgUp/PgDn/Home/End/j/k/g/G), `view(lines, visible)` returning the slice plus a `↑ N more / ↓ N more` indicator line, `follow` flag (stick to bottom while true; any manual scroll up clears it, `G` restores). `approval-view.ts` keeps its own logic (not refactored; out of scope).
   - Inspector detail (`inspector-view.ts`): header (label/id, status, model, usage) + transcript pane. Tails the file on the existing 250 ms timer with a byte offset (`fs.statSync` size check before reading). If no transcript file exists yet, falls back to today's activity/output block. `s` steer unchanged.
   - Runs panel detail (`runs-view.ts`): detail view gains a phase cursor (↑↓ moves over phase rows, highlighted), Enter opens that phase's transcript in the same pane layout as the inspector, Esc returns. Live refresh (1 s) tails the file for running phases.
   - `/tf peek <runId> <phaseId> --transcript [--item n] [--limit chars]` prints the rendered transcript tail (plain, no theme colours).
   - Visible height: `ctx.ui.custom` components receive only width; the pane derives visible rows from `tui.terminal.rows` passed in by the host (as `approval-view` already does with `() => tui.terminal.rows`), minus header/footer lines.

## Risks / Trade-offs

- Transcript files grow disk usage: 16 MiB cap per node + removal with the run keeps it bounded by `maxKeptRuns`.
- Tailing a file at 250 ms from the inspector is I/O on the hot path of the UI, not the run; reads are size-gated so an idle phase costs one `stat`.
- Collapsing rows in the collapsed view hides some phases; expanded view and the inspector still show everything.
- `label` is a schema addition; older `taskflow-core` consumers with `additionalProperties:false` would reject flows carrying it — all packages in this monorepo share the schema, and skills are regenerated.
