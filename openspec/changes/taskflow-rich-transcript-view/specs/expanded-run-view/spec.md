## Purpose
Defines what the `taskflow` tool result shows in the pi chat when the user toggles tool output (Ctrl+O, pi's `app.tools.expand`): per-phase transcript tails rendered with pi's own tool renderers, per-phase outputs, and live text that streams instead of updating per turn.

## ADDED Requirements

### Requirement: Expanded result shows per-phase transcript tails and outputs

When rendered with `expanded: true`, the `taskflow` result SHALL show, per phase in definition order: a heading (status, label or id, model, usage), the last 12 transcript entries of that phase's node, and the phase's `output` as Markdown for `done` non-final phases. A phase without a transcript SHALL show its `liveLog` instead of the tail. The final phase's output SHALL appear once, under `─── Result ───`. Collapsed rendering SHALL be unchanged.

#### Scenario: Finished three-phase run

- **WHEN** a completed run with phases `a`, `b`, `c` (each with a transcript) is rendered expanded
- **THEN** the output contains headings for `a`, `b`, `c` in that order, each followed by transcript rows, `a` and `b` are followed by an output block, and `c`'s output appears only once under `─── Result ───`

#### Scenario: Phase without transcript

- **WHEN** a phase has no transcript file but has `liveLog` entries
- **THEN** its section shows the `liveLog` lines labelled as recorded activity

#### Scenario: Collapsed unchanged

- **WHEN** the same run is rendered with `expanded: false`
- **THEN** the output is identical to the pre-change collapsed rendering (phase grid capped at 14 rows plus the `Ctrl+O to expand` hint)

#### Scenario: Fan-out phase

- **WHEN** a map phase with 8 item nodes is rendered expanded
- **THEN** the first 6 items show a tail of at most 4 entries each and a single `… +2 items` row follows

### Requirement: Expanded rendering is width-safe and does not re-read finished transcripts

Every emitted row SHALL fit the render width. Transcript entries SHALL be read incrementally (stat + append) and only while the run is `running`; a finished run's transcripts SHALL be read at most once per render component instance.

#### Scenario: Narrow terminal

- **WHEN** an expanded run with a 300-character tool result line is rendered at width 50
- **THEN** no emitted row exceeds 50 visible columns

#### Scenario: Finished run re-rendered

- **WHEN** a completed run's expanded component is rendered twice
- **THEN** the transcript file is opened at most once

### Requirement: Built-in pi tools render with pi's own renderers

A `tool_call`/`tool_result` pair for a pi built-in tool (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) SHALL render through that tool's exported `renderCall`/`renderResult` from `@earendil-works/pi-coding-agent`, given `args`, result text, `details` and the `expanded` flag, in the inspector and the expanded result alike.

#### Scenario: Edit renders as a diff

- **WHEN** a transcript contains an `edit` tool_call with its tool_result carrying diff `details`
- **THEN** the rendered rows include pi's diff rendering (`+`/`-` lines) rather than the raw result text

### Requirement: Non-native tool rows fall back to the summary rendering

Unavailable or throwing pi renderers, and tools that are not pi built-ins, SHALL render as the summary row plus dimmed result lines. A `thinking` entry SHALL render as a dim `∴ thinking` row.

#### Scenario: Renderer unavailable

- **WHEN** the pi tool definition for `bash` cannot be created or its `renderResult` throws
- **THEN** the pair renders as `▸ $ <cmd>` followed by dimmed result lines, and no error escapes

#### Scenario: Unknown tool

- **WHEN** a transcript contains a `tool_call` named `taskflow_peek`
- **THEN** it renders with the summary row and dimmed result lines

#### Scenario: Duration shown

- **WHEN** a tool_result has `durationMs: 2500`
- **THEN** its header row includes `2.5s`

### Requirement: Live text streams for pi subagents

While a pi subagent is running, assistant text deltas (`message_update` with `text_delta`) SHALL update the phase's `liveText` with the tail of the streaming text at most once per render heartbeat (120 ms). Streaming updates SHALL NOT append to `liveLog` and SHALL NOT force a persist. On `message_end` the authoritative text replaces the streamed tail exactly as today.

#### Scenario: Delta updates liveText

- **WHEN** a pi child emits three `text_delta` events within 50 ms followed by none for 200 ms
- **THEN** `liveText` reflects the concatenated tail after at most one emitted live update
- **AND** `liveLog` is unchanged

#### Scenario: Message end wins

- **WHEN** `message_end` arrives after streamed deltas
- **THEN** `liveText` equals the message's final text summary and `liveLog` gains exactly one entry
