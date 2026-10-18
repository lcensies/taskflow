# Design

## Context

- Writer: `pi-taskflow/src/runner.ts` `openTranscriptTee` (fail-open, 16 MB cap, `taskflow_truncated` marker) → `runSubagentProcess({ onRawLine })` in `taskflow-core/src/runner-core.ts`. Attempt markers (`taskflow_attempt`) are written by `runtime.ts`.
- Reader: `taskflow-core/src/transcript.ts` `parseTranscript` / `TranscriptTail`; plain `formatTranscript` for `peek`; themed `pi-taskflow/src/transcript-view.ts` `renderTranscript` for the inspector (`inspector-view.ts:366 detailLines`).
- Chat view: `index.ts:2036 renderResult(result, {expanded}, theme)` → `render.ts:560 renderRunResult`. `details.state` is the `RunState` (has `cwd`, `flowName`, `runId`); transcript dir = `transcriptDirFor(runsDir(state.cwd), state.flowName, state.runId)`.
- Pi exports (runtime 1.1.0, types 0.80.3): `createAllToolDefinitions(cwd)` → `Record<ToolName, ToolDefinition>` with `renderCall(args, theme, ctx)` / `renderResult(result, {expanded,isPartial}, theme, ctx)`; `ctx = {args, toolCallId, invalidate, lastComponent, state, cwd}`. `AssistantMessageComponent`, `renderDiff`, `highlightCode`, `getMarkdownTheme`.
- Pi `--mode json` (`docs/json.md`): `message_update.assistantMessageEvent.type ∈ text_delta|thinking_delta|toolcall_*`; `tool_execution_end {toolCallId, toolName, result, isError, durationMs}`; `message_end.message` is an `AgentMessage` whose `toolResult` role carries `content`, `details`, `isError`, `toolCallId`.

## Decisions

### D1. Host format is declared, not sniffed
`openTranscriptTee(file, host)` writes one header line `{"type":"taskflow_transcript","host":"<host>","v":1}` before the first raw line. `parseTranscript` reads it and dispatches to `transcript/<host>.ts`; a file without a header is pi (back-compat with every transcript written so far). Normalisers live in core because `taskflow-hosts` depends on core.

Alternative rejected: shape-sniffing per line — ambiguous (`type:"text"` exists in opencode and grok) and silently wrong on new event kinds.

### D2. One `TranscriptEntry` vocabulary, extended minimally
```ts
{ type: "thinking"; text: string }
{ type: "tool_call"; name; summary; args; toolCallId?: string }
{ type: "tool_result"; name; text; isError; toolCallId?: string; durationMs?: number; details?: unknown }
```
`durationMs` comes from `tool_execution_end` (pi) matched by `toolCallId` to the result emitted at `message_end`; since `tool_execution_end` precedes `message_end` for the same call, the parser keeps a `Map<toolCallId, durationMs>` and attaches on emit. Other hosts fill `durationMs` only when their stream has it (codex `item.completed` has none → undefined; render omits).

### D3. Pi-native tool rows through the exported definitions, not `ToolExecutionComponent`
`ToolExecutionComponent` needs a `TUI` handle (image conversion) that a tool renderer does not have. The bridge in `transcript-view.ts`:
```ts
const defs = memo(cwd => createAllToolDefinitions(cwd));  // once per cwd
const def = defs[entry.name]; if (!def?.renderResult) fallback();
def.renderResult({content:[{type:"text",text}], details}, {expanded, isPartial:false}, theme, ctx)
```
`ctx.state` is a fresh `{}` per pair (renderers initialise lazily), `invalidate` is a no-op, `lastComponent` undefined. Both `renderCall` and `renderResult` components are rendered to lines (`component.render(width)`) and concatenated — `renderTranscript` stays a `string[]` producer, so the inspector's `ScrollPane` and `peek --follow` need no change. Guarded by `try/catch` → fallback row; a renderer API drift in a future pi degrades to today's output instead of breaking the view.

Thinking entries: `∴ thinking` dim + first line truncated (`full` mode: whole text, dim). No ctrl+t dependency.

### D4. Ctrl+O expanded = per-phase tails, inspector = full
`renderRunResult(expanded=true)`: for each phase in definition order with a transcript file → heading row (status glyph, label, model, usage), last `TAIL_ENTRIES=12` entries via `renderTranscript(entries, width, theme, {expanded:true})`, then `─ output ─` + `Markdown(ps.output)` when the phase is `done` and is not the final phase (the final phase's output is the existing `─── Result ───` block). Phases without transcript keep today's `liveLog` block. Collapsed mode untouched.

Caching: `Lines` (render.ts:548) gets an optional per-node `TranscriptTail` map held on the component instance; `render(width)` calls `tail.poll()` (stat + incremental read) — cheap, and only while `state.status === "running"`; finished runs read once. The component is rebuilt by pi only when `expanded` flips, so the map lives as long as the toggle state.

Fan-out phases: show the aggregate phase row + each item node (`<phase>-<i>`) tail capped to 4 entries, items beyond 6 folded into `… +N items`.

### D5. Streaming live text — in-memory only
`foldPiEventLine` handles `message_update` with `assistantMessageEvent.type === "text_delta"`: append `delta` to `acc.streamText`, emit `LiveUpdate{text: tail(streamText, 200), streaming: true}` at most once per `LIVE_STREAM_MS=120` (matches the render heartbeat). `message_end` resets `streamText` and emits the authoritative line as today. `pushLive` (runtime.ts:665) writes `liveText` for streaming updates but **does not** append to `liveLog` (ring stays turn-granular; dedupe unaffected). `persist` throttling is already 1 s; streaming updates do not force a persist. Non-pi hosts: unchanged (claude/codex streams are turn-level already).

### D6. Host runners pass `transcriptFile`, nothing else
Each of `codex|claude|opencode|grok-runner.ts` forwards `opts.transcriptFile` to `runSubagentProcess` with its host tag; the tee is opened inside `runSubagentProcess` (so pi's runner loses its private copy). Normalisers (`transcript/codex.ts` etc.) are pure `(event) => TranscriptEntry[]` and reuse each host's existing fixture lines from `taskflow-hosts/test/*-runner.test.ts`:

| host | text | thinking | tool_call | tool_result |
|------|------|----------|-----------|-------------|
| codex | `item.completed agent_message` | `item.completed reasoning` | `item.started command_execution|file_change|mcp_tool_call` | `item.completed` same item (exit_code → isError, `aggregated_output`) |
| claude | `assistant` content `text` | `thinking` block | `tool_use` (name, input, id) | `user` content `tool_result` (`tool_use_id`, `content`, `is_error`) |
| opencode | `text` | — | `tool_use` (`part.tool`, `part.state.input`) | `tool_use` with `part.state.status==="completed"` (`state.output`, `error`) |
| grok | `text` | `thought` | `tool_call` if present in stream | `tool_result` if present |

Grok's stream has no tool events in the fixtures; its normaliser emits text/thinking only and is documented as such.

## Risks

- **pi API drift (0.80.3 types vs 1.1.0 runtime).** Mitigated by the try/catch fallback in D3 and a test that stubs `createAllToolDefinitions` to throw and asserts the fallback row.
- **Expanded view cost on big runs.** 12 entries × N phases × tool rows; `renderResult` is rebuilt by pi only on toggle, and `Lines` re-renders from cached entries. A 30-phase run with `full` tool results is still bounded by pi's own head/tail truncation inside `renderResult(expanded=true)`.
- **Streaming flicker.** Throttle equals the heartbeat; `renderFingerprint` already folds `liveText`, so a delta that does not change the visible tail does not redraw.

## Verification

`pnpm run typecheck && pnpm test`. Manual: run a 3-phase inline flow in pi, press Ctrl+O while running (streaming text visible, tool rows with durations), after completion (per-phase outputs + tails), open `/tf runs` → phase → detail (pi-native edit diff), run one `codex`/`claude` phase and confirm a transcript exists and renders.
