## MODIFIED Requirements

### Requirement: Live rendering of in-flight phase activity

While a taskflow run is in progress, the host's expanded rendering of the run SHALL show recent activity for each running phase rather than only the (not yet available) final result. Live rendering SHALL be stable: no rendered line may exceed the terminal width, the block SHALL NOT be re-emitted when nothing visible changed, and per-frame animation SHALL be confined to the last line of the block so that a block taller than the terminal does not force full-screen redraws. The collapsed view SHALL bound its height; when a run has more phases than fit, it shows running and failed phases with their neighbours and folds the rest into summary lines. The expanded view shows all phases.

#### Scenario: Expanding a running taskflow call

- **WHEN** the user expands the in-progress taskflow tool call
- **THEN** the expanded view shows the phase progress block plus recent activity lines for phases that are currently running

#### Scenario: Expanding a completed taskflow call

- **WHEN** the user expands a taskflow call after the run has finished
- **THEN** the expanded view shows the final result as before

#### Scenario: Tall run does not flicker

- **WHEN** a run with more phases than the terminal has rows is in flight
- **THEN** the terminal does not clear and repaint the whole screen on each heartbeat
- **AND** only the block's last line changes between two heartbeats where no phase progressed

#### Scenario: Wide dependency list

- **WHEN** a phase depends on more phases than fit on one line
- **THEN** the row is truncated to the terminal width and the host does not crash

## ADDED Requirements

### Requirement: Stored-run panel repaints while a run is active

The `/tf runs` panel SHALL repaint at least once per second while any listed run is running, so elapsed timers advance and per-phase activity text refreshes. A run executing in the same host process SHALL be shown from its live in-memory state, not from its last checkpoint on disk. A run executing in another process SHALL be shown from disk with at most a few seconds of latency.

#### Scenario: Same-process run

- **WHEN** a taskflow run is executing in this host and `/tf runs` is open
- **THEN** the run's phase rows update within one second of a subagent activity line

#### Scenario: Long phase, no checkpoint

- **WHEN** a single phase runs for minutes without any phase starting or ending
- **THEN** the panel's elapsed time keeps advancing and the phase's latest activity text keeps changing
