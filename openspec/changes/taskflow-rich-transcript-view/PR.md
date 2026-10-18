# PR draft (upstream: heggria/taskflow)

**Title:** feat(pi): rich transcript view — Ctrl+O per-phase tails, pi-native tool rows, transcripts for every host

## Summary

The pi host records every pi subagent's raw `--mode json` stream to `runs/<flow>/<runId>/<node>.ndjson`, but the chat view never shows it and the parser drops most of what it carries. This change makes the recorded stream the primary source for all three viewers (tool result, `/tf runs` inspector, `peek`) and extends recording to the codex/claude/opencode/grok hosts.

## Changes

- **Parser** (`taskflow-core/src/transcript.ts`): new `thinking` entry; `tool_result` carries `toolCallId`, `durationMs` (from `tool_execution_end`) and `details`. Transcript files start with `{"type":"taskflow_transcript","host":"<pi|codex|claude|opencode|grok>","v":1}`; headerless files parse as pi (back-compat). Per-host normalisers in `transcript/<host>.ts`.
- **Tee for every host**: `openTranscriptTee` moves from the pi runner into `runSubagentProcess` (`runner-core.ts`); the four `taskflow-hosts` runners forward `transcriptFile`. No host carries its own copy.
- **Pi-native tool rows** (`pi-taskflow/src/transcript-view.ts`): `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` pairs render through pi's exported `createAllToolDefinitions(cwd)[name].renderCall/renderResult` — diffs, highlighting, `expanded`-aware truncation. Unknown tools or a throwing renderer fall back to the existing summary row.
- **Ctrl+O expanded result** (`pi-taskflow/src/render.ts`): per phase, the last 12 transcript entries and the phase's output as Markdown; fan-out items folded after 6; `liveLog` fallback when no transcript. Collapsed rendering unchanged.
- **Streaming live text**: pi `text_delta` events update `liveText` at the render heartbeat (in memory only; `liveLog` and persistence stay turn-granular).

## Why not …

- `ToolExecutionComponent` — needs a `TUI` handle (image conversion); the tool definitions' renderers don't.
- `@openai/codex-sdk` / `@anthropic-ai/claude-agent-sdk` for types — zero-dep policy; each normaliser is ~40 lines against a stable JSONL shape.
- Sniffing host format per line — ambiguous (`type:"text"` exists in two hosts); the header is explicit.

## Compatibility

- Existing `.ndjson` files (no header) parse exactly as before.
- `RunState`/`PhaseState` schema unchanged. No new dependencies.
- Pi type pin is 0.80.3 while runtime pi is 1.1.0; the renderer bridge is guarded, degrading to today's output on API drift.

## Testing

- `pnpm run typecheck && pnpm test`.
- New: `transcript.test.ts` (thinking, duration attach, legacy fixture parity), `transcript-{codex,claude,opencode,grok}.test.ts` (from host runner fixtures), `transcript-view.test.ts` (edit → diff rows, throwing renderer → fallback, width safety), `render.test.ts` (expanded order, collapsed byte-identical, fan-out fold, open-once), `runner.test.ts` (delta throttle, `message_end` wins).
- Manual: 3-phase inline flow — Ctrl+O while running and after completion; `/tf runs` → phase → detail shows an edit diff; a codex/claude phase yields a transcript with the host header.

## Spec

`openspec/changes/taskflow-rich-transcript-view/` — proposal, design (D1–D6), specs `phase-transcript` + `expanded-run-view`, tasks.
