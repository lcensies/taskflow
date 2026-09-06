# run-observability Specification

## Purpose
Lets a user see what a taskflow run's subagents are actually doing while the run is still executing, instead of a single activity line, and keeps that history available afterwards for post-hoc inspection.

## Requirements

### Requirement: Per-phase activity history

A run's stored state SHALL record a bounded, ordered history of recent activity lines for each phase that executes subagent work, in addition to the single latest activity line. The history SHALL be bounded so that a long-running or looping phase cannot grow run state without limit, keeping the most recent entries when the bound is reached.

#### Scenario: Activity accumulates while a phase runs

- **WHEN** a running phase's subagent reports successive activity (assistant text or tool calls)
- **THEN** each reported activity line is appended to that phase's activity history in order
- **AND** the phase's latest activity line continues to reflect the most recent entry

#### Scenario: History is bounded

- **WHEN** a phase reports more activity lines than the configured bound
- **THEN** the phase's activity history retains only the most recent entries up to that bound
- **AND** no error is raised and the run continues normally

#### Scenario: History survives to stored run state

- **WHEN** a run finishes, fails, or is inspected after the fact
- **THEN** each phase's activity history is readable from the stored run state
- **AND** phases that never executed subagent work have no activity history

### Requirement: Inspector reachable during an active run

The pi host SHALL provide a keyboard-activated inspector that opens while a taskflow run is executing and the host turn is blocked. The inspector SHALL NOT require the agent to be idle and SHALL NOT depend on slash-command input, which is queued during an active turn.

#### Scenario: Opening the inspector mid-run

- **WHEN** a taskflow run is executing and the user presses the inspector shortcut
- **THEN** an interactive overlay opens showing the active run's phases with their status, elapsed time, model, and usage

#### Scenario: Opening the inspector with no active run

- **WHEN** no taskflow run is executing and the user presses the inspector shortcut
- **THEN** the inspector opens on the stored run history instead of failing

#### Scenario: Inspecting one phase

- **WHEN** the user selects a phase in the inspector and opens its detail
- **THEN** the detail view shows that phase's recent activity history, any output produced so far, its status, model, usage, and attempt count
- **AND** content longer than the viewport can be scrolled

#### Scenario: Closing returns control

- **WHEN** the user closes the inspector
- **THEN** the overlay is dismissed and the run continues unaffected

### Requirement: Inspection is non-destructive

Opening, navigating, and closing the inspector SHALL NOT alter run execution, run state, or the host conversation. Inspector activity SHALL NOT consume model tokens and SHALL NOT insert content into the host's context window.

#### Scenario: Inspecting does not disturb the run

- **WHEN** the user opens the inspector, navigates phases, and closes it during a run
- **THEN** the run's phase results, timings, and final output are the same as if the inspector had never been opened
- **AND** no additional message is added to the host conversation

### Requirement: Live rendering of in-flight phase activity

While a taskflow run is in progress, the host's expanded rendering of the run SHALL show recent activity for each running phase rather than only the (not yet available) final result.

#### Scenario: Expanding a running taskflow call

- **WHEN** the user expands the in-progress taskflow tool call
- **THEN** the expanded view shows the phase progress block plus recent activity lines for phases that are currently running

#### Scenario: Expanding a completed taskflow call

- **WHEN** the user expands a taskflow call after the run has finished
- **THEN** the expanded view shows the final result as before
