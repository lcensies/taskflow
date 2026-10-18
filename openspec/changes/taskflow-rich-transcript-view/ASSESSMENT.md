# Assessment: what pi-taskflow's run view can reuse to render subagent sessions

Scope: the `taskflow` tool result in pi's chat (`renderResult` → `renderRunResult`), the `/tf runs` inspector, and `peek`. All file refs are repo-relative; line numbers as of this assessment.

## 1. Current state (what we have, what gets dropped)

| Layer | File | Status |
|-------|------|--------|
| Raw capture | `packages/pi-taskflow/src/runner.ts:238-280` `openTranscriptTee`, wired at `:527`, `:600` | Pi subagents only. Tees every `pi --mode json` line to `runs/<flow>/<runId>/<node>.ndjson`, 16 MB cap, fail-open. |
| Parser | `packages/taskflow-core/src/transcript.ts:84` `parseTranscript`, `:134` `TranscriptTail` | Folds **only** `message_end`. Drops `thinking` parts, `tool_execution_end` (`durationMs`, `isError`), all `message_update` deltas. |
| Themed render | `packages/pi-taskflow/src/transcript-view.ts:27` `renderTranscript` | `▸ summary` for calls, dim result head (40 lines), `full` mode via `^O` in inspector. No diffs, no highlighting. |
| Inspector | `packages/pi-taskflow/src/inspector-view.ts:366` `detailLines` | Transcript if present, else `liveLog` ring (20 one-liners). |
| Chat view | `packages/pi-taskflow/src/render.ts:560` `renderRunResult` | Collapsed: phase grid ≤14 rows + "Ctrl+O to expand". Expanded: uncapped grid + last 6 `liveLog` lines per *running* phase + final Markdown. Never touches the transcript. |
| Non-pi hosts | `packages/taskflow-hosts/src/{codex,claude,opencode,grok}-runner.ts` | Fold events for `finalText`/usage/one-line activity; **ignore `transcriptFile`** → no `.ndjson`, inspector falls back to `liveLog`. Grok parses no tool events at all. |

Net: the richest data (full tool calls, results, thinking, timings) exists on disk for pi nodes and is reachable only through two levels of `/tf runs` navigation; for other hosts it is never written.

## 2. Reusable parsers / libraries

### 2a. Pi itself — `@earendil-works/pi-coding-agent` (already a peer dep; zero new deps)

Verified against `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.80.3/.../dist/index.d.ts` (runtime pi is 1.1.0 — same exports, see risk note).

| Export | What it gives the view |
|--------|------------------------|
| `createAllToolDefinitions(cwd)` → `Record<ToolName, ToolDefinition>` with `renderCall(args, theme, ctx)` / `renderResult(result, {expanded, isPartial}, theme, ctx)` | **Pi-native tool rows**: `bash` with highlighted command + head/tail output, `edit` as a coloured diff, `read`/`grep`/`find`/`ls` with path/pattern formatting, honouring `expanded`. Context needs only `{args, toolCallId, invalidate, lastComponent, state, cwd}` — no TUI handle (`core/extensions/types.d.ts:306`). This is exactly how `ToolExecutionComponent` renders pi's own session (`modes/interactive/components/tool-execution.js:37,226,248`). |
| `renderDiff`, `highlightCode`, `getLanguageFromPath` | Standalone diff/highlight for hosts whose results aren't pi `details` payloads (codex `file_change`, claude `Edit`). |
| `AssistantMessageComponent(message, hideThinking, mdTheme)` | Renders a full `AgentMessage` (text + thinking + tool-call stubs) as Markdown. `message_end.message` in the transcript *is* an `AgentMessage` → one call per turn. |
| `getMarkdownTheme`, `truncateToVisualLines` | Already used; keep. |
| `parseSessionEntries`, `SessionManager`, `buildSessionContext` | Pi session JSONL (`~/.pi/agent/sessions/`). **Not needed**: subagents run `--no-session`; our `.ndjson` tee is the richer source (includes `tool_execution_*` timing which session files lack). |

Pi `--mode json` events not yet consumed (`docs/json.md`): `tool_execution_start/end {toolCallId, toolName, result, isError, durationMs}` → per-tool duration + error badge; `message_update.assistantMessageEvent.text_delta` → streaming live text.

### 2b. Codex — `@openai/codex-sdk` (types only; do not add as dep)

`sdk/typescript/src/events.ts` + `items.ts` (verified from source): `ThreadEvent = thread.started | turn.started | turn.completed{usage} | turn.failed | item.started | item.updated | item.completed | error`; `ThreadItem = agent_message{text} | reasoning{text} | command_execution{id, command, aggregated_output, exit_code?, status} | file_change{changes[{path,kind}], status} | mcp_tool_call{server, tool, arguments, result?, error?, status} | web_search{query} | todo_list | error`.

Our fold (`codex-runner.ts:86-142`) already handles `agent_message`/`command_execution`; the item schema is small enough to vendor as a 40-line normaliser rather than import the SDK (zero-dep policy, and the SDK pulls `@modelcontextprotocol/sdk`). What it adds: `reasoning` → thinking rows, `file_change` → "edit a.ts, b.ts ✓/✗", `mcp_tool_call` → named tool rows with results, `exit_code` → error badge.

### 2c. Claude Code — `claude -p --output-format stream-json`

`@anthropic-ai/claude-agent-sdk` exports `SDKMessage` types (`system/init`, `assistant`, `user`, `result`). Content blocks are Anthropic Messages API shapes: `text`, `thinking`, `tool_use{id,name,input}`, `tool_result{tool_use_id, content, is_error}`. Our fold (`claude-runner.ts:~180-245`) reads `assistant` only and **drops `user` events** — which carry every tool result. Normaliser cost: ~40 lines. Gain: tool results, thinking, `tool_use_id` pairing. SDK not worth adding for types alone.

External viewers for reference only (no reuse — Python/HTML): `daaain/claude-code-log`, `claude-log-viewer` (PyPI). Their UX worth copying: fold tool results by default, show duration + error badge in the header, group a tool call with its result.

### 2d. OpenCode — `opencode run --format json`

Events `text`, `tool_use{part.tool, part.state{status,input,output,error,title}}`, `step_start`, `step_finish{tokens,cost}`. Our fold clears `finalText` on every tool call (`opencode-runner.ts:138-142`). Normaliser: `tool_use` on first sight → call; `state.status ∈ completed|error` → result. No separate library exists; the shape is stable.

### 2e. Grok — `grok -p --output-format streaming-json`

`text`, `thought`, `end`, `error`, `max_turns_reached`. No tool events in current fixtures → text/thinking only. Nothing to reuse.

### 2f. Not applicable

- `pi-dynamic-workflows` (installed): has a session-wide panel + rolling transcript renderer, but it's a separate extension with its own state model; the prior change `taskflow-agent-progress-parity` already decided not to copy it.
- Generic JSONL viewers (`jq`, `fx`, `jless`) — out of process, not TUI-embeddable.

## 3. Concrete UX gains, ranked by cost

| # | Change | Files | Size | User-visible effect |
|---|--------|-------|------|---------------------|
| 1 | Parser: emit `thinking`; attach `durationMs`/`isError`/`details`/`toolCallId` from `tool_execution_end` + `message_end` | `taskflow-core/src/transcript.ts` | S | `✓ bash · 1.2s`, `✗ edit · 0.3s`, dim `∴ thinking …` rows; slow/failed steps visible at a glance. |
| 2 | Ctrl+O expanded view reads the transcript tail per phase + per-phase output Markdown | `pi-taskflow/src/render.ts:560` | S | Expanding the tool result shows what each phase *did* and *produced*, not just the grid. No navigation needed. |
| 3 | Pi-native tool rows via `createAllToolDefinitions(cwd)[name].renderCall/renderResult` | `pi-taskflow/src/transcript-view.ts` | M | Subagent `edit` shows a real diff, `bash` shows highlighted command + trimmed output — identical look to pi's own session. Applies to inspector and Ctrl+O. |
| 4 | Move tee into `runSubagentProcess`; hosts pass `transcriptFile`; per-host normalisers + header line `{"type":"taskflow_transcript","host":…}` | `taskflow-core/src/runner-core.ts`, `transcript/<host>.ts`, `taskflow-hosts/src/*-runner.ts` | M | Codex/Claude/OpenCode nodes get transcripts; inspector/peek/Ctrl+O work for every host. |
| 5 | Stream `text_delta` into `liveText` (throttled 120 ms, memory only) | `pi-taskflow/src/runner.ts:339`, `taskflow-core/src/runtime.ts:665` | M | Running rows show text as it arrives instead of freezing until `message_end`. |

Pitfalls recorded in the change's `design.md`: pi type pin 0.80.3 vs runtime 1.1.0 (guard with try/catch → fallback row); heartbeat re-renders must not re-read files (cache `TranscriptTail` per node on the component, poll only while running); collapsed rendering must stay byte-identical.

## 4. Proposed Ctrl+O approach (actionable)

Ctrl+O is pi's global `app.tools.expand`; a tool renderer only receives `expanded: boolean` (`index.ts:2036`). No per-tool hotkey exists, so the design is: **collapsed = status, expanded = evidence**.

```
renderRunResult(state, finalOutput, theme, expanded)      // render.ts:560
  collapsed → unchanged (grid ≤14 rows, "Ctrl+O to expand")
  expanded  →
    for phase in state.def.phases:
      <grid row for phase>                                 // reuse renderProgress row
      tail = TranscriptTail(transcriptFileFor(dir, nodeId)).entries.slice(-12)
      tail.length ? renderTranscript(tail, width, theme, {expanded:true, cwd})
                  : liveLog block labelled "recorded activity"
      if phase done && !final: "─ output ─" + Markdown(ps.output)
      fan-out: items <phase>-<i> for i<6, slice(-4) each, then "… +N items"
    "─── Result ───" + Markdown(finalOutput)
```

- Transcript dir: `transcriptDirFor(runsDir(state.cwd), state.flowName, state.runId)` (`store.ts:419-435`); `state.cwd` is already used by `plannedModelResolver` in `index.ts:2043`.
- Cache: `Map<nodeId, TranscriptTail>` on the `Lines` component (`render.ts:548`); `poll()` in `render()` only while `state.status === "running"`. pi rebuilds the component only on toggle, so the cache lives exactly as long as the expanded state.
- `renderTranscript` stays a `string[]` producer → `ScrollPane` in the inspector and `peek --follow` unaffected.
- Inspector keeps `^O full/compact` as the *complete* view; Ctrl+O in chat is the *tail* view. Same renderer, different slice.

Full spec: `openspec/changes/taskflow-rich-transcript-view/` (`proposal.md`, `design.md` D1–D6, `specs/{phase-transcript,expanded-run-view}/spec.md`, `tasks.md` 14 tasks in 7 groups). Validated `--strict`.
