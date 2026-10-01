# Spec Delta

## Purpose

Lets a user remove taskflow history and saved definitions they no longer want — individual stored runs, all finished runs at once, and saved flow definitions — without hand-editing files on disk.

## ADDED Requirements

### Requirement: Deleting a stored run

The system SHALL support deleting one stored run by id. Deletion SHALL remove every artifact belonging to that run — the run record, its replay trace, its per-node transcripts, its context-tree and isolated-workspace artifacts, and its history-index entry — so the run no longer appears in run listings. A run that is currently executing SHALL NOT be deleted; the attempt SHALL fail with a reason and leave the run untouched. Deleting an unknown run id SHALL report that it was not found rather than raising an error. A failed or partial deletion SHALL NOT corrupt the history index or other runs.

#### Scenario: Deleting a finished run

- **WHEN** a user deletes a stored run that has completed, failed, or is blocked
- **THEN** the run no longer appears in the run list
- **AND** its stored record, trace, transcripts and per-run artifacts are gone from disk

#### Scenario: Refusing to delete a running run

- **WHEN** a user attempts to delete a run whose status is running
- **THEN** the deletion is refused with a reason
- **AND** the run and all of its artifacts remain intact

#### Scenario: Deleting an unknown run

- **WHEN** a user attempts to delete a run id that does not exist
- **THEN** the system reports that no such run was found
- **AND** no other run is affected

### Requirement: Clearing all finished runs

The system SHALL support clearing every finished run in one operation. Runs that are still executing SHALL be preserved. The operation SHALL report how many runs were removed.

#### Scenario: Clearing finished runs while one is active

- **WHEN** the stored history holds several finished runs and one running run, and the user clears finished runs
- **THEN** every finished run is deleted and the count of removed runs is reported
- **AND** the running run remains listed and intact

### Requirement: Deleting a saved flow definition

The system SHALL support deleting a saved flow definition by name, from either the user or the project scope. Deletion SHALL remove the definition and its metadata sidecar, and the flow SHALL no longer appear in saved-flow listings or be invocable by name. Stored runs produced by that flow SHALL NOT be deleted. Deleting an unknown flow name SHALL report that it was not found rather than raising an error.

#### Scenario: Deleting a saved flow

- **WHEN** a user deletes a saved flow by name
- **THEN** the flow no longer appears in the saved-flow list and cannot be invoked by that name
- **AND** runs previously produced by that flow remain in the run history

#### Scenario: Deleting an unknown flow

- **WHEN** a user attempts to delete a flow name that is not saved
- **THEN** the system reports that no such flow was found
- **AND** no saved flow is modified

### Requirement: Deletion is reachable from the host

Deletion SHALL be reachable both from the orchestration tool (by run id or flow name) and interactively from the host's run and flow lists. An interactive delete SHALL require an explicit confirmation step before anything is removed, and SHALL report the outcome. Cancelling the confirmation SHALL delete nothing.

#### Scenario: Deleting from the run list

- **WHEN** the user presses the delete key on a selected run in the run list and confirms
- **THEN** that run is deleted and the list no longer shows it
- **AND** the selection moves to a remaining run

#### Scenario: Cancelling a delete

- **WHEN** the user presses the delete key on a selected run and then cancels the confirmation
- **THEN** nothing is deleted and the list is unchanged

#### Scenario: Deleting through the tool

- **WHEN** the agent invokes the orchestration tool's delete action with a run id or a flow name
- **THEN** the corresponding run or saved flow is deleted and the result states what was removed
