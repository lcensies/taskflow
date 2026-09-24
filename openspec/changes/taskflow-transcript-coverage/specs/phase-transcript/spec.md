## Purpose
Persists each subagent's full transcript per run node, for every run mode and every kind of subagent call, and addresses those files by a single sanitized node identity shared by writer and readers.

## ADDED Requirements

### Requirement: Per-node transcript persistence

For every subagent invocation a run performs — a phase, a map/parallel item, a tournament variant, a tournament or scoring judge, a loop iteration, a race branch, and each retried attempt — the host SHALL append the child's raw event stream to a transcript file unique to that run node, in every run mode including detached/background runs. Retries of the same node SHALL append to the same file, separated by an attempt marker. Transcript writing SHALL remain fail-open and size-bounded.

#### Scenario: Detached run records transcripts

- **WHEN** a run is started in detached/background mode
- **THEN** its nodes' transcripts are written to the same location a foreground run would use
- **AND** the navigator and the peek command can read them while the run is still executing

#### Scenario: Every call kind has its own node

- **WHEN** a flow runs a tournament with a judge, a loop, and a race
- **THEN** the judge, each loop iteration, and each race branch each have their own transcript file
- **AND** no two of them share a file

#### Scenario: Fan-out items have separate transcripts

- **WHEN** a map or parallel phase runs N items
- **THEN** N distinct transcript files exist, one per item node

#### Scenario: Unwritable transcript directory

- **WHEN** the transcript directory cannot be created or written
- **THEN** the run proceeds and completes exactly as it would without transcripts

### Requirement: Sanitized node-id addressing

The helper that resolves a node's transcript path SHALL apply the same node-id sanitization the writer applies, so that a caller passing an unsanitized identifier resolves to the file that was actually written. The resolved path SHALL remain inside the run's transcript directory for any input, including identifiers containing path separators or parent-directory segments.

#### Scenario: Phase id outside the safe charset

- **WHEN** a flow defines a phase whose id contains characters outside the sanitized set and a reader asks for that phase's transcript
- **THEN** the reader receives the transcript the runtime wrote for that phase

#### Scenario: Traversal attempt

- **WHEN** a node identifier contains parent-directory segments or separators
- **THEN** the resolved path is still inside the run's transcript directory
