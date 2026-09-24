## Purpose
Gives a phase a human-readable display name separate from its interpolation id, so generated flows (e.g. compiled from an OpenSpec task list) show what each phase does instead of an opaque id.

## ADDED Requirements

### Requirement: Optional phase label

A phase MAY declare a `label`: a single-line string of 1–120 characters used only for display. A label SHALL NOT affect phase identity: interpolation references, dependency edges, cache fingerprints, FlowIR hashes and resume matching SHALL be unchanged by adding, removing or editing a label.

#### Scenario: Label does not change identity

- **WHEN** a flow is compiled to FlowIR with and without a label on one phase
- **THEN** both compilations yield the same FlowIR hash
- **AND** a phase's cache input hash is identical in both cases

#### Scenario: Invalid label rejected

- **WHEN** a phase label is empty, longer than 120 characters, or contains a newline
- **THEN** validation fails with an error naming the phase and the `label` constraint

### Requirement: Label shown wherever a phase is listed

The progress block, the live inspector, the stored-run panel and `peek`'s phase listing SHALL show a phase's label when present, else its id. Where a label is shown in a detail view the id SHALL remain visible (dimmed) so `{steps.<id>}` references stay discoverable. Dependency annotations SHALL continue to use ids.

#### Scenario: Compiled OpenSpec flow

- **WHEN** a flow generated from an OpenSpec task list is run
- **THEN** each task phase row reads like `1.2 Add CSV formatting utilities…` rather than `t1-2`

#### Scenario: Long label

- **WHEN** a label is wider than the label column
- **THEN** it is truncated with an ellipsis and the row still fits the terminal width
