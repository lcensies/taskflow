## Purpose
Gives a running subagent an attachable live view in a tmux window, so a fan-out of workers can be watched and redirected the way separate terminals allow, without the window ever owning the worker's lifecycle.

## ADDED Requirements

### Requirement: Attachable live view of a running worker

When per-node windows are enabled, a node that spawns a subagent SHALL become viewable in a tmux window that renders that node's transcript as it is produced. Windows SHALL be disabled by default: the feature's own window and the host inspector are the primary surfaces, and per-node windows are an explicit opt-in. When enabled, a window SHALL be created lazily at or after the node's first output, SHALL be identifiable from the run id and node id alone, and the number a single run may open SHALL be bounded by a configured limit.

#### Scenario: Window shows work as it happens

- **WHEN** a node with worker windows enabled produces output
- **THEN** a tmux window exists for that node
- **AND** output appended to the node's transcript appears in that window without the user taking any action

#### Scenario: Fan-out gets one view per worker

- **WHEN** a map or parallel phase runs several items with worker windows enabled
- **THEN** each item node has its own window
- **AND** no two item nodes share a window

#### Scenario: Off unless asked for

- **WHEN** a run starts a worker and per-node windows have not been enabled
- **THEN** no tmux window is created
- **AND** the run behaves exactly as it did before this capability existed

#### Scenario: Enabled by configuration

- **WHEN** per-node windows are enabled and a run starts a worker
- **THEN** that worker's window appears without further action

#### Scenario: Per-phase override

- **WHEN** per-node windows are enabled globally but disabled for one phase by override
- **THEN** no window is created for that phase's nodes, and other phases are unaffected

#### Scenario: A large fan-out does not open a window per item

- **WHEN** worker windows are enabled and a phase fans out beyond the configured window limit
- **THEN** the run proceeds without exceeding that limit
- **AND** the user is told which nodes have no window rather than the run failing

### Requirement: Window lifecycle is independent of worker lifecycle

A worker window SHALL hold no control over the worker it displays. Closing, killing, or never opening the window SHALL NOT affect the worker's execution, its result, or how its completion is classified. A worker finishing SHALL NOT require the window, the tmux server, or any tmux client to exist.

#### Scenario: Closing the window during work

- **WHEN** the user closes a worker's window while that worker is still running
- **THEN** the worker continues and its phase result is the same as if the window had never been opened

#### Scenario: No tmux available

- **WHEN** worker windows are enabled but tmux is not installed or no server can be reached
- **THEN** the run executes unchanged and reports that windows are unavailable, rather than failing the run or any phase

#### Scenario: Worker outlives the viewer

- **WHEN** the tmux server is terminated while workers are running
- **THEN** each worker still runs to completion and its completion is classified exactly as it would have been without windows

#### Scenario: Window after the worker has finished

- **WHEN** a worker finishes
- **THEN** its window remains readable with the completed transcript until the user closes it

### Requirement: Following a transcript is a reader, not a second renderer

The follow view SHALL be produced by the same transcript reader the host's inspector uses, so that a node's rendering is identical in both surfaces. Following SHALL be non-destructive: it SHALL NOT modify the transcript, the run state, or the worker.

#### Scenario: Same node renders the same in both surfaces

- **WHEN** a node is viewed in the inspector and in its tmux window
- **THEN** both show the same transcript content for that node

#### Scenario: Following a node that has no transcript yet

- **WHEN** the follow view is opened for a node before any output exists
- **THEN** it waits and begins rendering when output appears, rather than erroring

#### Scenario: Following a finished node

- **WHEN** the follow view is opened on a transcript whose worker has finished
- **THEN** it renders the complete transcript and reports that the node is finished
