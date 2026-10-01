# Spec Delta

## ADDED Requirements

### Requirement: Model shown for every phase

Every phase view SHALL identify the model that phase runs on. For a phase that has started, the view SHALL show the model actually used. For a phase that has not started, the view SHALL show the model it is planned to run on, resolved from the phase's own model, its agent's model, or the configured role default, and SHALL mark it as planned rather than actual. When no model can be resolved for a phase that has not started, the view SHALL show nothing rather than a misleading value.

#### Scenario: Running or finished phase

- **WHEN** a phase has started and its model is known
- **THEN** the phase row and its detail view show that model

#### Scenario: Pending phase with a resolvable model

- **WHEN** a phase has not started and a model can be resolved for it
- **THEN** the phase row shows that model, visually distinguished as planned rather than actual

#### Scenario: Pending phase with no resolvable model

- **WHEN** a phase has not started and no model can be resolved for it
- **THEN** the phase row shows no model instead of a placeholder or a wrong one

### Requirement: Currently executing phase is identifiable

Phase views SHALL mark which phase the run is executing right now, distinctly from the pending/done status glyphs, in both the progress block and the navigator's phase list. When several phases run concurrently, each SHALL be marked. When a navigator is opened on a run that has a running phase, its cursor SHALL start on a running phase.

#### Scenario: One phase running

- **WHEN** a run is executing a single phase
- **THEN** that phase's row carries a current-stage marker that no other row carries

#### Scenario: Several phases running

- **WHEN** a run is executing several phases concurrently
- **THEN** every running phase's row carries the current-stage marker

#### Scenario: Navigator opens on the running phase

- **WHEN** the user opens the navigator on a run with a running phase
- **THEN** the cursor is positioned on a running phase rather than on the first phase

### Requirement: Back-edges are rendered

Phase views SHALL show control flow that can return to an earlier stage, so a flow containing such control flow is not presented as a straight pipeline. A phase that repeats itself SHALL be shown as repeating, with its iteration count once known. A gate that re-runs its upstream dependencies when it blocks SHALL be shown with an edge back to those dependencies, and that edge SHALL be visible before the gate ever blocks — it is a property of the flow, not of the run.

#### Scenario: Looping phase

- **WHEN** a flow contains a phase that iterates until a stop condition
- **THEN** that phase's row shows it loops back to itself
- **AND** once the run reports iterations, the row shows how many

#### Scenario: Gate that retries upstream

- **WHEN** a flow contains a gate that re-runs its upstream dependencies on a blocking verdict
- **THEN** that gate's row shows a retry edge naming the dependencies it would re-run
- **AND** the edge is shown while the run is still pending, before any verdict exists

#### Scenario: Plain pipeline is unchanged

- **WHEN** a flow has no looping phase and no retrying gate
- **THEN** no back-edge annotation is added to any row

### Requirement: Open navigator follows refreshed run state

When a navigator is open on a run whose state is being refreshed from storage or from an in-process run, the navigator SHALL render the refreshed state. A run that progresses while its navigator is open SHALL show its new phase statuses, activity and results without the user closing and reopening the view.

#### Scenario: Stored run progresses while open

- **WHEN** the user opens a run from the run list and that run (executing in another process) advances
- **THEN** the open navigator shows the updated phase statuses and progress

#### Scenario: Navigation state survives a refresh

- **WHEN** refreshed state arrives while the user is inside a phase or item view
- **THEN** the current level and cursor position are preserved
