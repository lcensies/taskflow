## Purpose
Extends per-node transcripts to every subagent host and enriches the parsed entries with thinking, tool timing and tool details, so every viewer (inspector, peek, expanded run view) renders the same vocabulary regardless of which CLI ran the node.

## ADDED Requirements

### Requirement: Transcript header declares the host format

A transcript file SHALL begin with a header line `{"type":"taskflow_transcript","host":<host>,"v":1}` written by the tee before the first raw event line, where `<host>` is one of `pi`, `codex`, `claude`, `opencode`, `grok`. The parser SHALL select the host normaliser from this header. A file without a header SHALL be parsed as a pi transcript.

#### Scenario: Header selects the normaliser

- **WHEN** a transcript starts with `{"type":"taskflow_transcript","host":"codex","v":1}` followed by codex `item.*` events
- **THEN** `parseTranscript` yields text, tool_call and tool_result entries derived from those codex events

#### Scenario: Legacy pi transcript without header

- **WHEN** a transcript written before this change (no header line) is parsed
- **THEN** it is parsed exactly as before — pi `message_end` events become entries and no entry is lost

### Requirement: Transcripts for every host

Every host runner that delegates to `runSubagentProcess` SHALL tee the child's raw stdout lines to `opts.transcriptFile` when it is set, with the host's header line, using the same fail-open, size-bounded tee the pi runner uses today. The tee SHALL live in `taskflow-core` so no host carries its own copy.

#### Scenario: Codex node has a transcript

- **WHEN** a phase runs on the codex host with a `transcriptFile`
- **THEN** after the node finishes the file exists, starts with the codex header, and `parseTranscript` returns at least the node's final `agent_message` as a text entry

#### Scenario: Unwritable transcript path on a non-pi host

- **WHEN** the transcript directory is not writable for a claude node
- **THEN** the node completes with the same `RunResult` it would produce without a transcript

### Requirement: Entries carry thinking, duration and tool details

The parsed entry vocabulary SHALL include a `thinking` entry; `tool_call` and `tool_result` entries SHALL carry `toolCallId` when the stream has one; `tool_result` SHALL carry `durationMs` when the stream reports tool timing (pi `tool_execution_end`) and `details` when the host's result message carries a structured details payload. The plain-text `formatTranscript` SHALL print the duration next to the result badge and a one-line collapsed marker for thinking.

#### Scenario: Pi tool timing attached to the result

- **WHEN** a pi transcript contains `tool_execution_end {toolCallId:"c1", durationMs: 1234}` followed by a `message_end` whose toolResult has `toolCallId:"c1"`
- **THEN** the tool_result entry for `c1` has `durationMs === 1234`
- **AND** `formatTranscript` renders `✓ bash · 1.2s`

#### Scenario: Thinking preserved

- **WHEN** an assistant message contains a `thinking` content part
- **THEN** a `thinking` entry with its text appears in order before the message's text/tool entries

#### Scenario: Edit details preserved

- **WHEN** a pi `edit` toolResult message carries `details` (diff payload)
- **THEN** the tool_result entry's `details` is that object unchanged

### Requirement: Host normalisers map native events to the shared vocabulary

Each non-pi host SHALL have a pure normaliser mapping its native events to `TranscriptEntry` values — codex `item.*` items, claude `assistant`/`user` content blocks, opencode `text`/`tool_use`, grok `text`/`thought` and tool events when present. Unknown event types SHALL be skipped silently. A host whose stream lacks tool results SHALL document that only text/thinking are produced.

#### Scenario: Claude tool pair

- **WHEN** a claude transcript has an `assistant` event with a `tool_use {id:"t1", name:"Bash", input:{command:"ls"}}` block and a later `user` event with `tool_result {tool_use_id:"t1", content:"a\nb", is_error:false}`
- **THEN** the entries are a tool_call (`name:"Bash"`, `toolCallId:"t1"`, summary `$ ls`) followed by a tool_result (`toolCallId:"t1"`, `text:"a\nb"`, `isError:false`)

#### Scenario: Codex command item

- **WHEN** a codex transcript has `item.started` and `item.completed` for the same `command_execution` item with `exit_code: 1`
- **THEN** one tool_call entry (`$ <command>`) and one tool_result entry with `isError: true` and the `aggregated_output` text are produced, in that order

#### Scenario: Unknown host event

- **WHEN** a host transcript contains an event type the normaliser does not know
- **THEN** no entry is produced for it and parsing continues
