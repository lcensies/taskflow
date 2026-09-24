# Mapping: taskflow-navigator-tui Unchecked Items

**Generated:** 2026-09-20 | **Scope:** Items 3.1, 3.2, 3.3, 4.1, 4.2, 5.2 (6 unchecked items)

---

## 3. Run history integration [sequential]

### 3.1: Extend RunHistoryComponent with transcript & rows accessors

**Task:** Extend `RunHistoryComponent` with an optional `transcriptFile: (run: RunState, nodeId: string) => string | undefined` and `rows: () => number`; on Enter, construct an `InspectorComponent` for the selected run (`steerAvailable: false`) and delegate `render`/`handleInput`/`dispose` to it until it pops back.

#### Files to touch:
1. `packages/pi-taskflow/src/runs-view.ts` (lines 56–189)

#### Key functions/structs with line ranges:
- **RunHistoryComponent class** (lines 58–222):
  - Constructor (lines 58–84): has `opts?: { transcriptFile?: ...; rows?: () => number }`
  - Field `transcriptFile?: (run: RunState, nodeId: string) => string | undefined` (line 69)
  - Field `rows?: () => number` (line 70)
  - Method `openInspector()` (lines 132–146): constructs `InspectorComponent` for selected run
  - Method `closeInspector()` (lines 148–153)
  - Method `handleInput(data: string)` (lines 155–172): delegates to inspector when active

- **InspectorComponent constructor** (inspector-view.ts, lines 145–171):
  - Accepts `steerAvailable: boolean`, `rows?: () => number`, `transcriptFile?: (nodeId: string) => string | undefined`
  - When called from `RunHistoryComponent.openInspector()`, passes `steerAvailable: false` (no steering for stored runs)

#### Every caller:
- `packages/pi-taskflow/src/index.ts`, line 697: `new RunHistoryComponent(runs, theme, (r) => done(r), { refresh: ..., requestRender: ..., intervalMs: ... })`
  - **Currently does NOT pass** `transcriptFile` or `rows` options

- `packages/pi-taskflow/src/index.ts`, line 727: `await openRunHistory(pi, ctx)` — entry point from `/tf runs` command

#### Existing tests:
- `packages/pi-taskflow/test/runs-view.test.ts`:
  - Line 99–125: `"runs-view: Enter opens the run's phase list, Esc returns to the run list"` — already asserts the drill-in + pop behavior
  - Line 42–56: `"runs-view: live refresh re-reads"` — test setup for live refresh (not directly relevant to 3.1 but shows structure)
  - Line 60–72: `"runs-view: no requestRender when refreshed"` — guards against spurious refreshes

#### Build/test command:
```bash
pnpm test                             # full suite (tests runs-view.test.ts)
pnpm -C packages/pi-taskflow test     # pi-taskflow only
pnpm run test:pi                      # pi adapter tests only
pnpm -C packages/pi-taskflow exec tsc --noEmit  # typecheck
```

---

### 3.2: Bind listKey in run list level

**Task:** Bind `listKey` in the run list level (vim aliases + paging). Verify: test asserts `j`/`k` move selection and `q` closes.

#### Files to touch:
1. `packages/pi-taskflow/src/runs-view.ts` (lines 155–172)

#### Key functions/structs with line ranges:
- **listKey(data: string)** (inspector-view.ts, lines 28–39):
  - Returns: `"up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "in" | "out" | "close" | undefined`
  - Bindings: `↑/k`, `↓/j`, `PgUp/ctrl+u`, `PgDn/ctrl+d`, `Home/g`, `End/G`, `Enter/→/l`, `Esc/←/h`, `q/ctrl+c`

- **RunHistoryComponent.handleInput()** (runs-view.ts, lines 155–172):
  - Currently uses `matchesKey(data, "escape")`, `matchesKey(data, "up")`, `matchesKey(data, "down")`
  - Must be refactored to call `listKey(data)` and switch on its result
  - Currently hardcoded: only arrow keys + Escape + `r` for resume; must add vim aliases + paging

#### Every caller:
- `packages/pi-taskflow/src/index.ts`, line 706: `tui.requestRender()` trigger (repaint on input)
- Host TUI input loop: passes raw key data to `handleInput()`

#### Existing tests:
- `packages/pi-taskflow/test/runs-view.test.ts`, line 99–125: test already exercises Enter and Esc
  - Must add new test for `j`/`k` movement and `q` close

- `packages/pi-taskflow/test/inspector-view.test.ts`, line 53–63: `listKey: each alias pair maps to the same action` — full coverage of `listKey()` itself

#### Build/test command:
```bash
pnpm -C packages/pi-taskflow test
pnpm run test:pi
```

---

### 3.3: Pass transcript resolver and rows callback to RunHistoryComponent

**Task:** In `packages/pi-taskflow/src/index.ts`, pass the transcript resolver (`transcriptFileFor(transcriptDirFor(runsDir(ctx.cwd), run.flowName, run.runId), nodeId)`) and `() => tui.terminal.rows` into `RunHistoryComponent`.

#### Files to touch:
1. `packages/pi-taskflow/src/index.ts` (lines 683–711)

#### Key functions/structs with line ranges:
- **openRunHistory()** (lines 683–711):
  - Line 697: `new RunHistoryComponent(runs, theme, (r) => done(r), { ... })` call
  - Must pass additional `opts` properties:
    - `transcriptFile: (run: RunState, nodeId: string) => transcriptFileFor(transcriptDirFor(runsDir(ctx.cwd), run.flowName, run.runId), nodeId)`
    - `rows: () => tui.terminal.rows`

- **Imports already present** (lines 40–41, 51):
  - `transcriptDirFor`, `transcriptFileFor` from `taskflow-core` (line 41)
  - `runsDir` from `taskflow-core` (line 51)

- **store.ts helpers** (taskflow-core):
  - `transcriptDirFor(runsRoot: string, flowName: string, runId: string): string` (line 394)
  - `transcriptFileFor(dir: string, nodeId: string): string` (line 399)
  - `runsDir(cwd: string): string` (returns runs root directory)

#### Every caller:
- `/tf runs` command: invokes `openRunHistory(pi, ctx)` (line 727)
- Host `ui.custom()`: receives component and requests renders

#### Existing tests:
- `packages/pi-taskflow/test/runs-view.test.ts`, line 99–125: already passes both callbacks in the test constructor
  - Must verify integration with `openRunHistory()` in a system-level test (or manual verification)

#### Build/test command:
```bash
pnpm -C packages/pi-taskflow exec tsc --noEmit     # typecheck
pnpm -C packages/pi-taskflow test
pnpm run test:pi
```

---

## 4. Presentation [sequential]

### 4.1: Mount both panels with overlay options and borders

**Task:** Mount both panels with `{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 } }` in `index.ts`, and render a bordered header/footer in the component.

#### Files to touch:
1. `packages/pi-taskflow/src/index.ts` (lines 683–711, 720–760)
2. `packages/pi-taskflow/src/runs-view.ts` (lines 175–222)
3. `packages/pi-taskflow/src/inspector-view.ts` (lines 305–380)

#### Key functions/structs with line ranges:
- **openRunHistory()** (index.ts, lines 683–711):
  - Line 696: `const result = await ctx.ui.custom<RunHistoryResult | undefined>((tui, theme, _kb, done) => new RunHistoryComponent(...)`
  - Must add second parameter: `{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 } }`

- **openInspector()** (index.ts, lines 720–760):
  - Line 737: `const result = await ctx.ui.custom<InspectorResult | undefined>((tui, theme, _kb, done) => new InspectorComponent(...)`
  - Must add same overlay options

- **RunHistoryComponent.render(width: number)** (runs-view.ts, lines 175–207):
  - Currently renders header/footer without borders (lines 189–209)
  - Must add border chars: `th.fg("borderMuted", "─".repeat(...))` for top/bottom
  - Lines already use `th.fg("borderMuted", "─")` for minimal borders (line 189); must expand to full perimeter

- **InspectorComponent.render(width: number)** (inspector-view.ts, lines 305–380):
  - Currently renders level-specific output without full borders
  - Must add top/bottom border lines using theme `borderMuted` color

- **ApprovalViewComponent reference** (approval-view.ts, lines 138–182):
  - Already uses overlay options (line 564–568 in index.ts): `overlayOptions: { width: "80%", minWidth: 60, maxHeight: "85%", anchor: "center" }`
  - Shows the pattern for pi TUI overlay mounting

#### Every caller:
- `ctx.ui.custom()`: host TUI integration point (pi-coding-agent)
- Render flow: pi calls `component.render(terminalWidth)` repeatedly

#### Existing tests:
- `packages/pi-taskflow/test/inspector-view.test.ts`, line 82–102: `"inspector phases: 30 phases are all reachable and every line fits the width"`
  - **Must still pass** after adding borders (width test)
  - Already checks `visibleWidth(line) <= 40` for all lines

- `packages/pi-taskflow/test/runs-view.test.ts`, line 99–125: `"runs-view: Enter opens…"`
  - Must still pass; borders don't affect semantic structure

#### Build/test command:
```bash
pnpm -C packages/pi-taskflow test
pnpm run test:pi
```

---

### 4.2: Update footer hint per level

**Task:** Update the footer hint per level to list the active keys (`↑↓/jk move · →/l open · ←/h back · s steer · q close`).

#### Files to touch:
1. `packages/pi-taskflow/src/runs-view.ts` (lines 175–222)
2. `packages/pi-taskflow/src/inspector-view.ts` (lines 305–380)

#### Key functions/structs with line ranges:
- **RunHistoryComponent.render()** (runs-view.ts, lines 202–206):
  - Footer hint (line 205): currently `"↑↓ select · Enter details · r resume · q close"`
  - Must update when inspector is open: at "agents" level, add "back" key hint

- **InspectorComponent.render()** (inspector-view.ts, lines 338–365):
  - Currently has a single footer hint
  - Must differentiate by level:
    - **phases level:** `↑↓/jk move · →/l open · ↕/PgUp/PgDn scroll · Home/g top · End/G bottom · s steer · q close`
    - **agents level:** `↑↓/jk move · →/l open · ←/h back · ↕ scroll · Home/g · End/G · s steer · q close`
    - **detail level:** `↑↓/jk scroll · ←/h back · PgUp/PgDn page · Home/g top · End/G follow · q close`

- **Helper: getHintForLevel(level: InspectorLevel)** — new pure function
  - Takes `level: "phases" | "agents" | "detail"`
  - Returns hint string appropriate to that level

#### Every caller:
- `render()` method: calls helper to build footer line
- Theme: uses `th.fg("dim", hint)` for muted styling (existing pattern)

#### Existing tests:
- `packages/pi-taskflow/test/inspector-view.test.ts`, line 298–310: `"inspector detail: …"` — can check hint text
  - Must add assertion: `assert.match(out, /back/)` for agent level hint

#### Build/test command:
```bash
pnpm -C packages/pi-taskflow test
pnpm run test:pi
```

---

## 5. Docs [sequential]

### 5.2: Mark parity gap #14 as closed

**Task:** Mark parity gap #14 as closed in `docs/internal/claude-dynamic-workflows-parity.md`. Verify: row 14 reads ✅.

#### Files to touch:
1. `docs/internal/claude-dynamic-workflows-parity.md` (line 30)

#### Key content:
- **Row 14 current state** (line 30):
  ```
  | 14 | 进度面板：按 phase 看 agent 数/token/耗时，drill into 单 agent | 有 DAG 渲染，缺 per-agent drill-in 明细 | ⚠️ 部分缺 |
  ```
- **Row 14 target state** (after 3.1–3.2 complete):
  ```
  | 14 | 进度面板：按 phase 看 agent 数/token/耗时，drill into 单 agent | 进度面板 drill-in 单 agent 明细已实现 | ✅ |
  ```
  - Change judgment column from `⚠️ 部分缺` to `✅`
  - Update status column to reflect completed feature

#### Every caller:
- Documentation reference only; no functional callers
- Used by: project planning, feature parity tracking

#### Existing tests:
- None directly; documentation-only change

#### Build/test command:
```bash
# No build/test required; documentation change only
# Optionally verify markdown syntax:
grep "| 14 |" docs/internal/claude-dynamic-workflows-parity.md
```

---

## Summary Table

| Item | File(s) | Primary Target(s) | Task Type |
|------|---------|------------------|-----------|
| 3.1 | `runs-view.ts` | `RunHistoryComponent` + `InspectorComponent` wiring | Implement drill-in navigation |
| 3.2 | `runs-view.ts` | `handleInput()` + `listKey()` | Bind vim aliases + paging in run list |
| 3.3 | `index.ts` | `openRunHistory()` call site | Wire transcript resolver + rows callback |
| 4.1 | `index.ts`, `runs-view.ts`, `inspector-view.ts` | `ctx.ui.custom()` options + `render()` borders | Add overlay mount options + border rendering |
| 4.2 | `runs-view.ts`, `inspector-view.ts` | `render()` footer hints | Per-level hint text with active key bindings |
| 5.2 | `claude-dynamic-workflows-parity.md` | Row 14 verdict column | Change `⚠️ 部分缺` → `✅` + update description |

---

## Build/Test Command Reference

**Full test suite (all packages):**
```bash
pnpm test
```

**Pi-taskflow only:**
```bash
pnpm -C packages/pi-taskflow test
pnpm run test:pi
```

**Typecheck (required for 3.3):**
```bash
pnpm -C packages/pi-taskflow exec tsc --noEmit
```

**E2E (optional, requires live pi):**
```bash
node --experimental-strip-types packages/pi-taskflow/test/e2e.mts
```

