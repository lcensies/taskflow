## Purpose
Makes a worker's outcome a durable fact recorded by whichever process observed it, so that work which happened is never lost when the orchestrating process dies, and a node left mid-flight is classifiable rather than ambiguous.

## ADDED Requirements

### Requirement: Outcome recorded by the observer at settle time

When a subagent settles, the process that observed it SHALL durably record that node's outcome before the result is handed back to the orchestration logic. The record SHALL carry how the completion was classified, the exit status or terminating signal, and the start and end times. Recording SHALL be fail-open: a record that cannot be written SHALL NOT change the phase's result.

#### Scenario: Outcome survives the orchestrator

- **WHEN** a subagent finishes and the orchestrating process dies before it next checkpoints the run
- **THEN** that node's outcome record is readable afterwards
- **AND** it states how the completion was classified

#### Scenario: Every settle path records

- **WHEN** a subagent settles by exiting, by a committed terminal event, by the idle watchdog, by its phase timeout, by abort, or by a protocol error
- **THEN** an outcome record exists for that node in each case, naming which of those it was

#### Scenario: Unwritable outcome location

- **WHEN** the outcome record cannot be written
- **THEN** the phase completes with exactly the result it would have had otherwise

### Requirement: Stored state reconciles from recorded outcomes

Loading a run SHALL prefer a node's recorded outcome over a stored phase status that contradicts it. A node whose stored status says it is still running, but which has a recorded outcome, SHALL be reported as finished with that outcome.

#### Scenario: Adopting an unrecorded completion

- **WHEN** a run is loaded whose stored state marks a node as running, and that node has an outcome record
- **THEN** the node is reported as finished according to the record
- **AND** the run is not reported as still executing that node

#### Scenario: Stored state and record agree

- **WHEN** a run is loaded whose stored node status already matches its outcome record
- **THEN** the reported state is unchanged

### Requirement: A stale running node is classified into three states

For a node whose stored status is running, the system SHALL determine which of three states holds: still running, finished but unrecorded in run state, or orphaned — meaning no outcome was recorded and the worker is gone. Orphaned SHALL be a reported state of its own and SHALL NOT be presented as a successful or failed result of the work.

#### Scenario: Still running

- **WHEN** a node has no outcome record and its worker process group is alive
- **THEN** it is reported as still running

#### Scenario: Finished but unrecorded

- **WHEN** a node has an outcome record while stored state still says running
- **THEN** it is reported as finished from that record

#### Scenario: Orphaned

- **WHEN** a node has no outcome record and its worker process group is gone
- **THEN** it is reported as orphaned
- **AND** it is not reported as completed, and not reported as a failure of the work itself

#### Scenario: Orphaned nodes need a decision

- **WHEN** a run contains an orphaned node
- **THEN** that state is surfaced to the user
- **AND** the system does not silently retry, discard, or complete it

### Requirement: Work verdict is recorded separately from process outcome

A node's process outcome and the acceptance of its work SHALL be separate recorded facts. A successful process outcome SHALL NOT by itself be recorded as an accepted verdict, and a verdict SHALL only come from an explicit check or decision.

#### Scenario: Clean exit is not an accepted verdict

- **WHEN** a worker exits successfully and no acceptance check has run
- **THEN** the node's process outcome is recorded as successful
- **AND** its work verdict is recorded as not yet determined

#### Scenario: Verdict from an explicit check

- **WHEN** an acceptance check or decision runs for a node
- **THEN** that result is recorded as the node's work verdict
- **AND** the process outcome recorded earlier is unchanged

#### Scenario: Rejected work after a clean exit

- **WHEN** a worker exits successfully but its acceptance check rejects the work
- **THEN** the node is reported as not accepted
- **AND** both facts remain separately readable
