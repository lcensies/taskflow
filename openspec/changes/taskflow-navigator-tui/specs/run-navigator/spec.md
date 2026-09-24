## Purpose
An interactive, keyboard-driven navigator over taskflow runs, their phases, and each phase's individual subagents, so a user can reach one fan-out item's own transcript and output without leaving the TUI.

## ADDED Requirements

### Requirement: Four-level navigation

The pi host SHALL provide a navigator with four levels — runs, phases of a run, agents of a phase, and one agent's detail — where entering a level pushes it onto a stack and leaving pops it. Leaving the outermost level SHALL close the navigator. Opening the navigator while a run is in flight SHALL start at that run's phases; opening it with no run in flight SHALL start at the run list.

#### Scenario: Drilling from a run to one subagent

- **WHEN** the user opens the run list, selects a run, enters it, selects a fan-out phase, enters it, selects an item, and enters it
- **THEN** the navigator shows that single subagent's detail
- **AND** pressing the back key four times returns to the run list and then closes the navigator

#### Scenario: Live run opens at its phases

- **WHEN** a taskflow run is executing and the user presses the inspector shortcut
- **THEN** the navigator opens at the phase level for the active run

#### Scenario: Non-fan-out phase skips the agent level

- **WHEN** the user enters a phase that ran a single subagent
- **THEN** the navigator shows that subagent's detail directly
- **AND** the back key returns to the phase list

### Requirement: Individual subagent output viewing

For a phase that fanned out over N items, the navigator SHALL list one row per item showing the item's position, its agent name when known, and its status. Entering a row SHALL show that item's own transcript. When no transcript file exists for that item, the navigator SHALL show that item's section of the phase's merged output instead, and when neither exists, the phase's recorded activity.

#### Scenario: Item transcript is shown

- **WHEN** the user enters item *k* of a fan-out phase and a transcript file exists for that item's node
- **THEN** the navigator renders that file's transcript, and no other item's events

#### Scenario: Stored run without transcripts

- **WHEN** the user enters an item of a completed run whose transcript files are gone
- **THEN** the navigator renders that item's section of the phase's merged output

#### Scenario: Live fan-out before items produce output

- **WHEN** the user enters a fan-out phase whose items have all started but produced no output yet
- **THEN** one row per item is listed with a running status
- **AND** entering a row shows an empty-but-valid detail view rather than an error

### Requirement: Vim and arrow navigation

Every list level of the navigator SHALL accept both arrow-key and vim-style navigation: previous/next item, page up/down, jump to first/last, drill in, and go back. The detail level SHALL keep the existing scroll-pane keys.

#### Scenario: Equivalent key pairs

- **WHEN** the user presses `j`, `k`, `g`, `G`, `l`, or `h` at a list level
- **THEN** the effect is identical to `↓`, `↑`, `Home`, `End`, `→`, and `←` respectively

#### Scenario: Paging a long phase list

- **WHEN** a run has more phases than fit the viewport and the user presses `Ctrl+D` or `PageDown`
- **THEN** the selection and visible window advance by roughly one viewport
- **AND** the selected row stays visible

### Requirement: Full phase list rendering

The phase level SHALL render every phase of the run as its own row with a status badge and a selection cursor, and SHALL show fan-out progress on phases that have it. When the phase list is longer than the viewport, it SHALL scroll with the selection.

#### Scenario: All phases visible

- **WHEN** the user opens a run with several phases
- **THEN** each phase appears as a separate row with its status
- **AND** the currently selected phase is marked

#### Scenario: Width safety

- **WHEN** the navigator renders at a narrow terminal width
- **THEN** no emitted line exceeds the available width
