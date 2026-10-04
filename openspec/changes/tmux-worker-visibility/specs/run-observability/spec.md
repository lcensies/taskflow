## ADDED Requirements

### Requirement: Worker windows are a live surface under the inspection guarantees

A worker's tmux window SHALL be governed by the same guarantees as the inspector: it SHALL NOT alter run execution, run state, or the host conversation, SHALL NOT consume model tokens, and SHALL NOT insert content into the host's context window. Its availability SHALL be reported rather than assumed.

#### Scenario: Watching does not disturb the run

- **WHEN** worker windows are open for several running nodes and the user reads and closes them during a run
- **THEN** the run's phase results, timings, and final output are the same as if no window had been opened
- **AND** no additional message is added to the host conversation

### Requirement: Orphaned and unrecorded nodes are visible in inspection

Inspection surfaces SHALL distinguish a node that is still running from one that finished without being recorded in run state and from one that is orphaned, rather than showing all three as running.

#### Scenario: Inspecting a run after a harness restart

- **WHEN** the user inspects a stored run whose nodes were left running when the previous orchestrating process died
- **THEN** each such node is shown as still running, finished, or orphaned according to what is recorded and probed
- **AND** an orphaned node is visually distinct from a running one
