# Spec Delta

## ADDED Requirements

### Requirement: Indexed fan-out agent state
For a map or parallel phase, the stored run and Pi inspector SHALL identify each item by its original zero-based index and SHALL report its actual pending, running, done, failed, or skipped state rather than infer state from aggregate counts. Item state and available usage SHALL remain readable after the phase ends. Historical runs lacking item records SHALL remain readable without inventing item states.

#### Scenario: Out-of-order recon agents
- **WHEN** item 3 finishes before item 0 in a four-item running fan-out
- **THEN** item 3 reads done and item 0 retains its actual state, independent of the aggregate done count

#### Scenario: Cached and budget-skipped items
- **WHEN** a high-index item is served from cache and a different item is skipped by the budget cap
- **THEN** the cached item reads done, the skipped item reads skipped, and no low-index item is incorrectly marked done

#### Scenario: Historical run lacks item state
- **WHEN** an older run has aggregate subProgress but no indexed item records
- **THEN** the inspector indicates individual states are unknown instead of claiming an index-specific state

### Requirement: Cross-process live fan-out visibility
A stored running Pi run, whether foreground or detached, SHALL expose bounded-latency fan-out item state, activity, and usage updates to readers in other processes without writing to disk on every subagent event. A progress persistence failure SHALL NOT alter the run outcome. Other hosts retain their existing checkpoint-only persistence policy.

#### Scenario: Long recon phase without checkpoints
- **WHEN** a fan-out phase remains in flight without starting or finishing another phase
- **THEN** another process reading its run record sees recently completed and running items within a few seconds

#### Scenario: Detached Pi fan-out
- **WHEN** a detached Pi fan-out emits indexed progress and then remains quiet without another checkpoint
- **THEN** another process sees the latest indexed state, activity, and usage within a few seconds
- **AND** hosts that do not opt into live persistence keep their checkpoint-only policy

#### Scenario: Progress storage is unavailable
- **WHEN** an intermediate progress write fails
- **THEN** the phase continues and returns its normal result

### Requirement: Trustworthy compact usage display
The Pi tool card and inspector SHALL display known fresh and cache-read token usage separately, and SHALL avoid displaying a positive cost as zero after rounding. Unknown per-item usage SHALL not be shown as zero. A live tool card SHALL preserve width bounds and avoid changing off-screen rows solely because of time-based usage decoration.

#### Scenario: Recon agent usage
- **WHEN** a running recon agent reports usage including cache reads
- **THEN** its inspector detail identifies fresh tokens separately from cache-read tokens without double-counting them

#### Scenario: Small nonzero cost
- **WHEN** a run costs less than the card's smallest precise display unit
- **THEN** it reads as a positive threshold rather than `$0.0000`
