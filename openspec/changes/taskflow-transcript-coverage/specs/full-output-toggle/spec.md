## Purpose
Lets a user switch one node's detail view between the bounded reading view and the complete output, so nothing a subagent produced is unreachable from the TUI.

## ADDED Requirements

### Requirement: Full-output toggle

The detail level of the navigator SHALL provide a key that toggles between a bounded view and a full view of the current node's output. In the full view the per-entry line caps SHALL NOT be applied and long lines SHALL be wrapped rather than truncated. The active mode SHALL be indicated in the footer and SHALL persist while the navigator stays open, including across moving to another node.

#### Scenario: Revealing a capped tool result

- **WHEN** a node's transcript contains a tool result longer than the bounded view's cap and the user presses the toggle key
- **THEN** every line of that tool result is present in the rendered output
- **AND** pressing the key again restores the bounded view

#### Scenario: Long lines are wrapped, not cut

- **WHEN** the full view renders a line wider than the panel
- **THEN** the line continues on the following rows
- **AND** no rendered row exceeds the panel width

#### Scenario: Mode survives node switching

- **WHEN** the user enables the full view, goes back a level, and enters a different node
- **THEN** that node's detail also renders in the full view

### Requirement: Transcript preferred over activity log

When a node has a transcript, the detail view SHALL render it. The bounded activity/output block SHALL be used only when no transcript exists for that node, and in that case the view SHALL state that it is showing recorded activity rather than a transcript.

#### Scenario: Transcript present

- **WHEN** a node has a transcript file with entries
- **THEN** the detail view renders the transcript, not the activity log

#### Scenario: No transcript

- **WHEN** a node has no transcript file
- **THEN** the detail view renders the recorded activity and output
- **AND** labels that block so the user knows a transcript was unavailable
