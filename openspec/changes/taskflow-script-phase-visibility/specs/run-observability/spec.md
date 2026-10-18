# Spec Delta

## ADDED Requirements

### Requirement: Script phase live activity
A `script` phase SHALL record its command as an activity line when the process is spawned and SHALL update the phase's latest-activity line with the most recent non-empty stdout or stderr line as the process writes, using the same bounded activity history agent phases use. Activity updates SHALL trigger the live progress callback and SHALL NOT change the phase's captured `output`, caps, exit handling, or cache behavior.

#### Scenario: Long-running build script
- **WHEN** a script phase runs a command that prints several lines over time
- **THEN** the run state's latest-activity line for that phase follows the most recent printed line while the command runs
- **AND** the activity history starts with the command and is readable after the phase ends

#### Scenario: Silent script
- **WHEN** a script phase runs a command that prints nothing
- **THEN** the activity history contains the command line only and the phase output is unchanged

### Requirement: Script phase role column shows the command
The Pi tool card and inspector SHALL show a truncated form of the script command in the role column for `script` phases in pending, running, and done states instead of repeating the phase type.

#### Scenario: Pending and running script rows
- **WHEN** a flow contains a script phase that has not started and one that is running
- **THEN** both rows show the command text, and the running row additionally shows the latest activity line
