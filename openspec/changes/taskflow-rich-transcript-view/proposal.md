# Rich transcript view: Ctrl+O expanded run, pi-native tool rendering, all hosts

## Why

The pi host already records every pi subagent's raw `--mode json` stream to `runs/<flow>/<runId>/<node>.ndjson` and parses it (`taskflow-core/src/transcript.ts`) for the inspector and `peek --transcript`. But most of what the stream carries is thrown away, and the chat view never shows it:

1. **Ctrl+O on the `taskflow` tool result shows almost nothing new.** Expanded mode (`render.ts:560 renderRunResult`) is the uncapped phase grid, the last 6 `liveLog` one-liners for *running* phases, and the final Markdown. `liveLog` is a 20-entry ring of summaries (`$ cmd`, `read path`). Per-phase outputs, tool calls, tool results, and thinking are unreachable from the chat; the user must open `/tf runs` → phase → detail.
2. **The parser drops what the stream has.** `parseTranscript` folds only `message_end`: `thinking` content parts are skipped, and `tool_execution_end` (`toolName`, `durationMs`, `isError`) is ignored, so a transcript cannot show how long a tool took or mark a slow/failed step.
3. **Tool calls render as one dim line.** `renderTranscript` prints `▸ summary` and a dimmed result head. Pi renders the same tool calls for its own session with syntax-highlighted bash, diffs for edits, and per-tool collapse — and it exports those renderers (`createAllToolDefinitions(cwd)[name].renderCall/renderResult`, `renderDiff`, `AssistantMessageComponent`, `highlightCode`).
4. **Only pi subagents have transcripts.** `codex`, `claude`, `opencode`, `grok` runners (`taskflow-hosts/src/*-runner.ts`) ignore `transcriptFile`, so for those hosts the inspector falls back to the 20-line ring. Their event streams (`item.completed`, `assistant`/`user`, `tool_use`/`step_finish`, `text`/`thought`) carry the same information in different shapes.
5. **Live text is turn-granular.** A phase's row updates only at `message_end`; a long assistant turn looks frozen although `message_update` text deltas stream the whole time.

## What Changes

- **Richer parser** (`taskflow-core/src/transcript.ts`): new `thinking` entry; `tool_result` carries `durationMs` and the raw `details`/`toolCallId` (from `tool_execution_end` matched to the preceding `toolCall`); an optional transcript header line `{"type":"taskflow_transcript","host":"pi|codex|claude|opencode|grok"}` selects a per-host normaliser. Plain-text `formatTranscript` prints durations and a collapsed thinking marker.
- **Transcripts for every host**: `openTranscriptTee` moves from `pi-taskflow/src/runner.ts` into `taskflow-core/src/runner-core.ts`; `runSubagentProcess` tees `onRawLine` for every runner given `opts.transcriptFile`; the four `taskflow-hosts` runners pass it through. Per-host normalisers map codex/claude/opencode/grok events to `TranscriptEntry`.
- **Pi-native tool rendering** (`pi-taskflow/src/transcript-view.ts`): a `tool_call`+`tool_result` pair whose name is a pi built-in (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) renders via pi's own `renderCall`/`renderResult` (diffs, highlighting, head/tail truncation honouring `expanded`); unknown tools keep the current summary + dimmed result. Thinking renders as a dim collapsed marker with the first line.
- **Ctrl+O expanded run view** (`pi-taskflow/src/render.ts`): expanded mode shows, per phase, a transcript tail (last N entries, pi-native tool rows, `✓/✗ name · 1.2s`) read from the run's transcript dir, plus the phase's own output as Markdown; collapsed mode is unchanged. Falls back to `liveLog` when no transcript exists. Entries are read through `TranscriptTail` and cached on the render component so the 120 ms heartbeat does not re-read files.
- **Streaming live text**: the pi runner folds `message_update` `text_delta` into an in-memory `liveText` tail (throttled to the existing heartbeat, never persisted per delta); running rows and the expanded activity block show text as it streams instead of per turn.

## Capabilities

### New Capabilities

- `expanded-run-view`: what the `taskflow` tool result shows when the user toggles tool output (Ctrl+O): per-phase transcript tails, per-phase outputs, pi-native tool rows, streaming live text.

### Modified Capabilities

- `phase-transcript`: transcripts for every host; parser carries thinking, tool duration/error and tool details; transcript header selects the host format.

## Impact

- `packages/taskflow-core/src/transcript.ts`, `runner-core.ts` (tee + header), `host/runner-types.ts` (doc only), `peek.ts` (format of durations).
- `packages/taskflow-hosts/src/{codex,claude,opencode,grok}-runner.ts` — pass `transcriptFile`; per-host `toTranscriptEntries` lives in core (`transcript/<host>.ts`) because hosts depend on core, not vice versa.
- `packages/pi-taskflow/src/{runner,render,transcript-view,inspector-view,index}.ts`.
- Tests in `packages/taskflow-core/test`, `packages/taskflow-hosts/test`, `packages/pi-taskflow/test` (fixtures from each host's existing `*-runner.test.ts`).
- `skills-src/taskflow/core.md` (inspector + Ctrl+O section), CHANGELOG.
- No new dependencies. pi renderers come from the already peer-depended `@earendil-works/pi-coding-agent`; local type pin is 0.80.3 while runtime pi is 1.1.0 — the renderer bridge is typed against the exported `ToolDefinition` and guarded at runtime (missing renderer → current fallback).

## Non-goals

- Replacing the inspector (`/tf runs`) — it stays the full scrollable view; Ctrl+O shows tails.
- Persisting `message_update` deltas to disk or trace.
- Image content in tool results (pi handles kitty images inside `ToolExecutionComponent`, which needs a TUI handle; text only here).
- A session-wide panel or any new keybinding beyond pi's global `app.tools.expand`.
