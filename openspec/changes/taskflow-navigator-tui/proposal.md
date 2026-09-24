# Unified taskflow navigator TUI

## Why

1. **No drill-in to an individual subagent.** A map/parallel phase runs N subagents, but the inspector stops at the phase: it shows one merged output blob and one interleaved activity log with no item attribution. The per-item transcripts already exist on disk (`<phaseId>-<n>.ndjson`) and `/tf peek --item n` can read them — the TUI cannot. This is gap #14 ("per-agent drill-in") in `docs/internal/claude-dynamic-workflows-parity.md`.
2. **The inspector's phase list is not a list.** `inspector-view.ts` list mode renders the progress block plus a single line for the *selected* phase, so the user navigates a list they cannot see.
3. **Two disjoint panels.** `/tf runs` (run history) and `alt+t` (live inspector) are separate components; from a stored run you can see progress and resume, but you can never reach that run's phases, transcripts, or per-item output.
4. **Navigation is arrow-only at list level.** `ScrollPane` already supports vim keys (`j/k/g/G/ctrl+d/ctrl+u`), but the list levels of both panels only bind `↑/↓`, and there is no `→/l` to drill in or `←/h` to go back.

## What Changes

- **Unified 4-level navigator**: `runs → phases → agents → agent detail`, with `Esc`/`←`/`h` popping one level and closing at the top. Entering `alt+t` with a live run starts at `phases` for that run; `/tf runs` starts at `runs`.
- **Agent level (new)**: for a fan-out phase, one row per item (index, agent name, status), derived from `subProgress` while running and from the merged `### [k/N] <agent>` sections once done. Non-fan-out phases drill straight to the single agent detail.
- **Agent detail (new)**: that item's own transcript (`<phaseId>-<n>.ndjson`) in the existing scroll pane, falling back to the item's output section when no transcript exists.
- **Real phase list**: list mode renders every phase with status badge, cursor, and fan-out counts.
- **Vim + arrow keys at every list level**: `j/k`, `↑/↓`, `g/G`, `ctrl+d`/`ctrl+u`, `PgUp`/`PgDn`, `Enter`/`→`/`l` to drill in, `Esc`/`←`/`h` to go back.
- **Dedicated overlay presentation**: the navigator mounts as a bordered overlay panel instead of an inline block.
- `splitItems` is exported from `taskflow-core` so the TUI reuses the same section parser `/tf peek` uses.

## Capabilities

### New Capabilities

- `run-navigator`: an interactive, keyboard-driven navigator over taskflow runs, their phases, and each phase's individual subagents.

### Modified Capabilities

- `run-observability`: the inspector's phase view becomes a full navigable list and gains a per-subagent level.

## Impact

- `packages/pi-taskflow/src/inspector-view.ts` — level stack, phase list, agent list, agent detail, vim keys.
- `packages/pi-taskflow/src/runs-view.ts` — run list keys; detail level delegates to the inspector component.
- `packages/pi-taskflow/src/index.ts` — pass transcript-file resolver + overlay options to both panels.
- `packages/taskflow-core/src/peek.ts` — export `splitItems`.
- `packages/pi-taskflow/test/inspector-view.test.ts`, `runs-view.test.ts` — navigation + drill-in coverage.
