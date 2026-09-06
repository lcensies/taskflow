# subagent-steering Specification

## Purpose
Lets a user redirect a taskflow subagent while it is still working — sending it a message instead of waiting for a wrong answer or aborting the entire run — and defines what that does to the run's results and caching.

## Requirements

### Requirement: Steering a running phase

On a host that supports steering, the user SHALL be able to send a text message to a phase whose subagent is currently running. The message SHALL be delivered to that subagent as a user message at the next safe boundary — after the subagent's current assistant turn finishes executing its tool calls and before its next model call — so that the subagent can change course without being restarted.

#### Scenario: Message reaches a running subagent

- **WHEN** the user sends a steering message to a running phase
- **THEN** the phase's subagent receives that message as a user message before its next model call
- **AND** the phase continues from its current state rather than restarting

#### Scenario: Multiple messages are delivered in order

- **WHEN** the user sends several steering messages to the same running phase
- **THEN** each message is delivered exactly once, in the order it was sent

#### Scenario: Steering does not interrupt a tool call

- **WHEN** a steering message arrives while the subagent is executing a tool call
- **THEN** the in-flight tool call runs to completion before the message is delivered

### Requirement: Steering a phase that has not started

The user SHALL be able to address a message to a phase that has not started yet. Such a message SHALL be delivered as part of that phase's initial instructions when it starts.

#### Scenario: Message queued before the phase starts

- **WHEN** the user sends a message to a pending phase and that phase later starts
- **THEN** the message is included in the phase's initial task instructions
- **AND** it is not delivered a second time after the phase starts

#### Scenario: Message for a phase that never runs

- **WHEN** the user sends a message to a phase that is later skipped or never reached
- **THEN** the run completes normally and the message is discarded without error

### Requirement: Steering is an optional host capability

Steering SHALL be optional. A host that cannot deliver messages into a running subagent SHALL continue to execute runs unchanged, and the user-facing surface SHALL indicate that steering is unavailable rather than failing the run. Steering SHALL be disableable by configuration.

#### Scenario: Host without steering support

- **WHEN** a run executes on a host that does not support steering
- **THEN** the run behaves exactly as it did before this capability existed
- **AND** the inspector reports steering as unavailable instead of erroring

#### Scenario: Steering disabled by configuration

- **WHEN** steering is disabled in configuration and a run executes
- **THEN** no steering channel is established for its subagents
- **AND** the inspector remains available for read-only inspection

#### Scenario: Delivery failure does not fail the run

- **WHEN** a steering message cannot be delivered (the subagent already finished, or the channel is unavailable)
- **THEN** the run is unaffected and the failure is reported to the user, not to the phase's result

### Requirement: Steered phases are excluded from cross-run reuse

A phase that received a steering message SHALL be recorded as steered, and its result SHALL NOT be reused by a later run through the cross-run cache, because its output no longer follows from the flow definition alone.

#### Scenario: A steered phase is not replayed from cache

- **WHEN** a phase received a steering message in one run
- **AND** a later run with cross-run caching enabled executes the same phase with unchanged inputs
- **THEN** the later run executes the phase instead of restoring the steered result

#### Scenario: Unsteered phases keep caching behavior

- **WHEN** a run contains both steered and unsteered phases
- **THEN** only the steered phases are excluded from cross-run reuse
- **AND** the unsteered phases cache exactly as before
