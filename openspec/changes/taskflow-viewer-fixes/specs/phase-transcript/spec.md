## Purpose
Persists each subagent's full transcript per run node and lets a user browse it interactively — scrolling through assistant text, tool calls and tool results — both while the phase runs and after the run has finished.

## ADDED Requirements

### Requirement: Per-node transcript persistence

For every subagent invocation a run performs (a phase, a map/parallel item, a tournament variant, a judge), the pi host SHALL append the child's raw event stream to a transcript file that is unique to that run node and stored alongside the run's persisted state. Retries of the same node SHALL append to the same file, separated by an attempt marker. Transcript writing SHALL be fail-open: an unwritable or failing transcript file SHALL never fail, abort, or slow the subagent run. Each transcript file SHALL be bounded in size; on reaching the bound the host writes a single truncation marker and stops appending.

#### Scenario: Transcript is written while the phase runs

- **WHEN** a phase's subagent emits events
- **THEN** those events are appended to that node's transcript file as they arrive, not only at the end of the phase

#### Scenario: Fan-out items have separate transcripts

- **WHEN** a map or parallel phase runs N items
- **THEN** N distinct transcript files exist, one per item node, plus none for the phase itself unless the phase invoked its own subagent

#### Scenario: Retry appends with a marker

- **WHEN** a node is retried
- **THEN** the second attempt's events follow the first attempt's in the same file, preceded by an attempt marker

#### Scenario: Unwritable transcript directory

- **WHEN** the transcript directory cannot be created or written
- **THEN** the run proceeds and completes exactly as it would without transcripts

#### Scenario: Transcripts are removed with the run

- **WHEN** a stored run is deleted by retention cleanup
- **THEN** its transcript files are deleted too

### Requirement: Scrollable transcript viewer

The live inspector and the stored-run panel SHALL let the user open a phase (or a fan-out item) and read its transcript in a scrollable pane. The pane SHALL render assistant text, tool calls (with a one-line summary of the call) and tool results (bounded per result), in order. Keys: ↑/↓ (or k/j) one line, PgUp/PgDn one page, Home/End (or g/G) jump. While the node is running the pane SHALL follow the tail by default; scrolling up SHALL stop following, and jumping to the end SHALL resume it. Long lines SHALL be wrapped or truncated so that no rendered line exceeds the terminal width.

#### Scenario: Reading a running phase

- **WHEN** the user opens a running phase's transcript in the inspector
- **THEN** new transcript entries appear in the pane without reopening it
- **AND** the pane stays scrolled to the newest entry until the user scrolls up

#### Scenario: Reading a finished run

- **WHEN** the user opens `/tf runs`, selects a completed run, selects a phase and opens it
- **THEN** the full transcript of that phase is readable by scrolling from beginning to end

#### Scenario: Phase without transcript

- **WHEN** the selected phase has no transcript file (script phase, cached hit, run predating transcripts)
- **THEN** the detail view shows the phase's recorded activity history and output instead of an error

#### Scenario: Viewing does not disturb the run

- **WHEN** the user opens, scrolls and closes a transcript during a run
- **THEN** run execution, run state and the host conversation are unaffected

### Requirement: Transcript available from peek

`/tf peek <runId> <phaseId> --transcript` SHALL print the rendered transcript (plain text, subject to the peek character limit, tail-first) so a transcript can be read without an interactive UI.

#### Scenario: Peek transcript

- **WHEN** the user runs `/tf peek <runId> <phaseId> --transcript`
- **THEN** the output contains that phase's transcript entries in order, truncated from the front when longer than the limit
