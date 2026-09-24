# Recon Map: taskflow-transcript-coverage

Comprehensive source, function, test, and build information for every unchecked item in tasks.md.

---

## 1 (Node identity)

### Item 1.1: Sanitize inside `transcriptFileFor`

**Files:**
1. `packages/taskflow-core/src/store.ts` (lines 399-402) — `transcriptFileFor` function; must add sanitization
2. `packages/taskflow-core/src/steer.ts` (lines 27-29) — Reference implementation: `steerFileFor` with sanitization rule
3. `packages/taskflow-core/src/runtime.ts` (lines 50, 1771, 1892) — Callers of `transcriptFileFor`
4. `packages/taskflow-core/test/steer.test.ts` (lines 1-200) — Reference test patterns for sanitization

**Current Implementation:**
```typescript
// store.ts:399-402
export function transcriptFileFor(dir: string, nodeId: string): string {
	return path.join(dir, `${nodeId}.ndjson`);
}

// steer.ts:27-29 (REFERENCE)
export function steerFileFor(steerDir: string, nodeId: string): string {
	const safe = nodeId.replace(/[^A-Za-z0-9._-]+/g, "_");
	if (!safe || safe === "." || safe === "..") throw new Error(`Unsafe nodeId for steer file: ${nodeId}`);
	return path.join(steerDir, `${safe}.jsonl`);
}
```

**Key Functions by Name:**
- `transcriptFileFor(dir: string, nodeId: string): string` — store.ts:399-402 (needs modification)
- `steerFileFor(steerDir: string, nodeId: string): string` — steer.ts:27-29 (reference implementation)
- `validateRunId(runId: string): boolean` — store.ts:413-420+ (path safety validator)

**Callers of `transcriptFileFor`:**
1. `runtime.ts:1771` — in `runOne` function, line ~1771: `transcriptFileFor(deps.transcriptDir, ctxNodeId)`
2. `runtime.ts:1892` — in `appendAttemptMarker` call
3. `peek.ts:133` — in transcript display/fetch logic

**Existing Tests:**
- `packages/taskflow-core/test/steer.test.ts` (lines 43, 86) — Tests for `steerFileFor` safety: `steerFileFor(dir, "..")` throws; can copy pattern
- `packages/taskflow-core/test/store-extended.test.ts` — Storage safety tests (check for sanitization coverage)

**Build/Test Commands:**
- Full test: `pnpm test` or `pnpm test:pi` (runs all)
- Targeted: `pnpm --filter taskflow-core test 'test/store*.test.ts'`
- Typecheck: `pnpm typecheck`

---

## 2 (Transcript coverage)

### Item 2.1: Wire `transcriptDir` into detached-runner RuntimeDeps

**Files:**
1. `packages/taskflow-core/src/detached-runner.ts` (lines 120-180+) — Main entry, builds `RuntimeDeps`
2. `packages/taskflow-core/src/store.ts` (lines 394-396) — `transcriptDirFor(runsRoot, flowName, runId)`
3. `packages/pi-taskflow/src/index.ts` (lines 630-650) — Reference: foreground wiring of `transcriptDir`
4. `packages/taskflow-core/test/detached.test.ts` (lines 1-300) — Detached run tests

**Current Implementation (detached-runner.ts ~line 150):**
Detached context loads config, calls `executeTaskflow(state, {...})` but **does not pass** `transcriptDir` in the `RuntimeDeps` object.

**Key Functions by Name:**
- `transcriptDirFor(runsRoot: string, flowName: string, runId: string): string` — store.ts:394-396
- `runsDir(cwd: string): string` — store.ts:~380
- `traceFilePath(runsRoot, flowName, runId)` — store.ts (shows parallel pattern for other artifacts)
- `executeTaskflow(state: RunState, deps: RuntimeDeps): Promise<...>` — runtime.ts:~400

**Callers of `transcriptDirFor`:**
1. `pi-taskflow/src/index.ts:632` — foreground run entry (shows correct usage pattern)
2. `store.ts:1024` — in run cleanup (artifact removal)
3. `store.ts:2063` — in transcript directory operations

**Existing Tests:**
- `packages/taskflow-core/test/detached.test.ts` — Has detached spawn tests; check for transcript verification
- `packages/pi-taskflow/test/detached-spawn.test.ts` — Pi-specific detached tests
- Look for transcript-related assertions in these files

**Build/Test Commands:**
- Detached tests: `pnpm --filter taskflow-core test 'test/detached*.test.ts'`
- Pi adapter: `pnpm --filter pi-taskflow test 'test/detached*.test.ts'`
- All: `pnpm test`

---

### Item 2.2: Pass distinct `ctxNodeId` to `runOne` calls (4 locations)

**Files:**
1. `packages/taskflow-core/src/runtime.ts` — Main orchestration
   - Lines 1603-1605: `nodeIdFor()` function definition
   - Lines 2508, 3637, 3420, 2719: The four `runOne` callsites needing modification

**Current Implementation:**
```typescript
// runtime.ts:1603-1605
const nodeIdFor = (suffix?: string): string =>
	`${phase.id}${suffix ? `-${suffix}` : ""}`.replace(/[^A-Za-z0-9._-]+/g, "_");

// runtime.ts:2508 (TOURNAMENT JUDGE) — NEEDS nodeIdFor("judge")
const r = await runOne(judgeAgent, fullJudgeTask, liveSink(...), nodeIdFor("judge"));

// runtime.ts:3637 (TOURNAMENT WITHOUT FAN-OUT) — CURRENTLY MISSING ctxNodeId
const judgeRes = await runOne(judgeAgent, judgeTask, liveSink(...)); // ← add nodeIdFor("judge")

// runtime.ts:3420 (LOOP ITERATIONS) — CURRENTLY MISSING ctxNodeId, i is iteration number
const r = await runOne(agentName, body, liveSink(...), undefined, contractCheck); // ← add nodeIdFor(`iter-${i}`)

// runtime.ts:2719 (GATE onBlock:retry) — CURRENTLY MISSING ctxNodeId
const retryR = await runOne(agentName, retryTask, liveSink(...), undefined, contractCheck); // ← add nodeIdFor() (use phase's own id)
```

**Callsites Needing `ctxNodeId` (4 total):**

| Line | Context | Current | Needed |
|------|---------|---------|--------|
| 3637 | Tournament judge | `runOne(..., undefined)` | `runOne(..., nodeIdFor("judge"))` |
| 3420 | Loop iterations (in for loop) | `runOne(..., undefined, contractCheck)` | `runOne(..., nodeIdFor("iter-" + i), contractCheck)` where i is iteration counter |
| 2863 | Race branches (in raceRunOne lambda) | `runOne(agent, task, undefined, undefined, undefined, branchSignal)` | `runOne(agent, task, undefined, nodeIdFor("branch-" + idx), undefined, branchSignal)` |
| 2719 | Gate onBlock:retry second attempt | `runOne(agentName, retryTask, liveSink(...), undefined, contractCheck)` | `runOne(agentName, retryTask, liveSink(...), nodeIdFor(), contractCheck)` (use phase's own node id) |

**Key Functions by Name:**
- `nodeIdFor(suffix?: string): string` — runtime.ts:1603-1605
- `runOne(agentName, task, onLive?, ctxNodeId?, check?, extraSignal?, callCwd?)` — runtime.ts:~1820+ (definition)
- `executePhase(phase, state, deps, prior, emitProgress, _retryDepth?, opts?)` — runtime.ts main handler
- `executeRaceBranches(...)` — runtime/phases/race.ts (imported at line 2850)

**Callers of `runOne`:**
- 10+ calls throughout runtime.ts (add ctxNodeId to the 4 that lack it)

**Existing Tests:**
- `packages/taskflow-core/test/runtime.test.ts` — Main phase execution tests
- `packages/taskflow-core/test/tournament.test.ts` — Tournament-specific tests
- `packages/taskflow-core/test/loop.test.ts` — Loop-specific tests
- `packages/taskflow-core/test/race-expand.test.ts` — Race phase tests
- `packages/taskflow-core/test/gate-*.test.ts` — Gate/verdict tests

**Build/Test Commands:**
- Runtime tests: `pnpm --filter taskflow-core test 'test/runtime*.test.ts'` or `pnpm --filter taskflow-core test 'test/tournament.test.ts'`
- Specific phase tests: `pnpm --filter taskflow-core test 'test/loop.test.ts'` / `'test/race*.test.ts'` / `'test/gate*.test.ts'`
- All: `pnpm test`

---

## 3 (Full-output toggle)

### Item 3.1: Add `full` option to `renderTranscript`

**Files:**
1. `packages/pi-taskflow/src/transcript-view.ts` (lines 17-56) — `renderTranscript` function
2. `packages/pi-taskflow/src/transcript-view.ts` (line 14) — `MAX_RESULT_LINES` constant
3. `packages/pi-taskflow/src/inspector-view.ts` (line 333) — Caller of `renderTranscript`
4. `packages/pi-taskflow/test/transcript-view.test.ts` (lines 1-100) — Tests for renderTranscript

**Current Implementation:**
```typescript
// transcript-view.ts:14
const MAX_RESULT_LINES = 40;

// transcript-view.ts:17-56
export function renderTranscript(entries: TranscriptEntry[], width: number, theme: Theme): string[] {
	const w = Math.max(10, Math.floor(width));
	const out: string[] = [];
	const push = (line: string) => out.push(truncateToWidth(line, w));
	for (const e of entries) {
		// ...
		case "tool_result": {
			const lines = e.text ? e.text.split("\n") : [];
			const shown = lines.slice(0, MAX_RESULT_LINES);
			// ...render shown lines...
			if (lines.length > shown.length) {
				push(theme.fg("muted", `… (+${lines.length - shown.length} lines)`));
			}
			break;
		}
	}
	return out;
}
```

**Imports:**
- `truncateToWidth, wrapTextWithAnsi` from `@earendil-works/pi-tui`

**Key Functions by Name:**
- `renderTranscript(entries: TranscriptEntry[], width: number, theme: Theme): string[]` — transcript-view.ts:17
- `truncateToWidth(line: string, width: number): string` — from pi-tui
- `wrapTextWithAnsi(text: string, width: number): string[]` — from pi-tui

**Callers of `renderTranscript`:**
1. `inspector-view.ts:333` — `renderTranscript(entries, Math.max(10, width), th)`

**Existing Tests:**
- `packages/pi-taskflow/test/transcript-view.test.ts` (lines 25-46) — "tool results are capped at 40 lines" test
  - Assert: 105-line output shows only 40 lines + "… (+65 lines)" suffix
- Same file (lines 18-33) — "every line fits the width at 50 cols" test

**Build/Test Commands:**
- Pi adapter: `pnpm --filter pi-taskflow test 'test/transcript-view.test.ts'`
- Specific test: `pnpm --filter pi-taskflow test -- --grep "capped at 40"`
- All: `pnpm test`

---

### Item 3.2: Toggle `ctrl+o` in inspector detail level, hold `full` flag

**Files:**
1. `packages/pi-taskflow/src/inspector-view.ts` (lines 151+) — `InspectorComponent` class
   - Lines 151-200: Class definition, constructor
   - Lines 330-350: `renderDetail()` method (where renderTranscript is called)
   - Lines 370-400: `handleInput()` method (where key handling lives)
   - Lines 200-250: State/level tracking (`levelStack`, `cursors`)

2. `packages/pi-taskflow/src/scroll-pane.ts` — ScrollPane component for detail pane
3. `packages/pi-taskflow/test/inspector-view.test.ts` (lines 1-150) — Inspector tests

**Current Implementation:**
```typescript
// inspector-view.ts:151 (class definition)
export class InspectorComponent {
	private levelStack: InspectorLevel[] = ["phases"];
	private cursors: number[] = [0];
	// ... no 'full' flag yet
	
	// Lines ~330-350: renderDetail()
	private renderDetail(): string[] {
		// ...
		const entries = this.tail?.entries ?? [];
		const body = entries.length
			? renderTranscript(entries, Math.max(10, width), th)
			: (this.itemBody(ps) ?? this.fallbackBody(ps));
		// ...
	}
	
	// Lines ~370+: handleInput(data: string)
	handleInput(data: string): void | InspectorResult {
		// Currently handles up/down/pageUp/pageDown/home/end/return/escape/q/ctrl+c/s
		// Need to add handling for ctrl+o
	}
}
```

**Key Functions/Properties by Name:**
- `class InspectorComponent` — inspector-view.ts:151
- `renderDetail(): string[]` — inspector-view.ts:~330 (renders the detail level)
- `handleInput(data: string): void | InspectorResult` — inspector-view.ts:~370
- `listKey(data: string): ListAction | undefined` — inspector-view.ts:36 (list navigation handler)
- `ScrollPane` — scroll-pane.ts (manages the pane offset)
- `renderTranscript(entries, width, theme)` — imported from transcript-view.ts

**Callers of `renderDetail` / Related:**
- Called internally by `render()` method when `levelStack[0] === "detail"`

**Existing Tests:**
- `packages/pi-taskflow/test/inspector-view.test.ts` (lines 50-100+)
  - "inspector hints: each level advertises only the keys that act there" — shows key handling per level
  - Tests check for specific hint text (e.g., "↑↓/jk scroll · PgUp/PgDn page · G follow · s steer · Esc back")
  - Patterns: `view.handleInput("\r")` → navigate level

**Build/Test Commands:**
- Pi-taskflow: `pnpm --filter pi-taskflow test 'test/inspector-view.test.ts'`
- Specific: `pnpm --filter pi-taskflow test -- --grep "inspector"`
- All: `pnpm test`

---

### Item 3.3: Label fallback block, show toggle state in detail footer

**Files:**
1. `packages/pi-taskflow/src/inspector-view.ts` (lines 300-360) — Detail rendering + fallback
   - Lines ~320-350: `renderDetail()` and `fallbackBody()` methods
   - Lines ~300-310: Footer assembly (where hint/toggle state goes)

2. `packages/pi-taskflow/test/inspector-view.test.ts` — Inspector tests

**Current Implementation:**
```typescript
// inspector-view.ts:~330-350
private renderDetail(): string[] {
	// ... header assembly ...
	const entries = this.tail?.entries ?? [];
	const body = entries.length
		? renderTranscript(entries, Math.max(10, width), th)
		: (this.itemBody(ps) ?? this.fallbackBody(ps)); // ← fallback label needed
	// ... footer assembly ...
	// Currently footer is just the hint text, no toggle state display
}

private fallbackBody(ps: PhaseState | undefined): string[] | undefined {
	// Returns the in-memory liveLog or output fallback
	// Need to add label like "recorded activity (no transcript available)"
}
```

**Key Functions/Properties by Name:**
- `renderDetail(): string[]` — inspector-view.ts:~330
- `fallbackBody(ps: PhaseState | undefined): string[] | undefined` — inspector-view.ts:~345+
- Footer rendering logic (check where hint lines are assembled)

**Dependencies on 3.2:**
- Requires `full` flag to be stored on the component (item 3.2)
- Footer must display toggle state: `^O full` or `^O compact` based on the flag

**Existing Tests:**
- `packages/pi-taskflow/test/inspector-view.test.ts` — Check for footer hint assertions
  - Pattern: `assert.match(hint(), /↑↓\/jk move · →\/l open · s steer · q close/)`

**Build/Test Commands:**
- Same as 3.2: `pnpm --filter pi-taskflow test 'test/inspector-view.test.ts'`

---

## 4 (Docs)

### Item 4.1: Document toggle and transcript coverage in skills-src

**Files:**
1. `skills-src/taskflow/core.md` (lines 1-2000+) — Main skills doc, contains inspector section
   - Search for "inspector" section to find where to add docs
   - Look for existing toggles/keys documented (e.g., "G follow", "s steer")

2. `scripts/build-skills.mjs` — Skill builder (copies/compiles core.md to dist)

3. **Generated (auto-built from skills-src):**
   - `packages/pi-taskflow/skills/taskflow/SKILL.md` — Compiled pi skill (will mention `Ctrl+O` after rebuild)

**Current State:**
- `skills-src/taskflow/core.md` documents the inspector and its keys (e.g., `s` for steer, `G` for follow)
- No mention yet of full/compact toggle or wider transcript coverage

**Key Functions/Build Targets:**
- Build script: `scripts/build-skills.mjs` — compiles `skills-src/` → `packages/*/skills/`
- Source: `skills-src/taskflow/core.md`
- Output targets:
  - `packages/pi-taskflow/skills/taskflow/SKILL.md` (pi)
  - `packages/codex-taskflow/skills/taskflow/SKILL.md` (codex, includes same core content)
  - etc. (other hosts)

**Callers / Where Docs Are Loaded:**
- Generated SKILL.md files are loaded by the host agents when the taskflow tool/extension loads
- Users see these docs in help, command palettes, etc.

**Existing Tests:**
- `packages/pi-taskflow/test/skills-build.test.ts` — Verifies skill generation is in sync with sources
  - Check: do not edit generated files; rebuilding must be part of the flow

**Build/Test Commands:**
- Build skills: `pnpm run build:skills` (compiles skills-src/ → all packages/*/skills/)
- Verify generated: `pnpm --filter pi-taskflow test 'test/skills-build.test.ts'`
- Full build (includes skills): `pnpm run build`
- Type-check after edit: `pnpm typecheck`

---

## Summary

**Items Mapped:** 1.1, 2.1, 2.2, 3.1, 3.2, 3.3, 4.1

**Key Source Files:**
- `packages/taskflow-core/src/store.ts` — Artifact paths + sanitization
- `packages/taskflow-core/src/runtime.ts` — Core orchestration, `nodeIdFor`, `runOne`, phase types
- `packages/taskflow-core/src/detached-runner.ts` — Background run entry
- `packages/pi-taskflow/src/transcript-view.ts` — Transcript rendering
- `packages/pi-taskflow/src/inspector-view.ts` — Detail UI + toggle logic
- `skills-src/taskflow/core.md` — Documentation source

**Key Test Files:**
- `packages/taskflow-core/test/steer.test.ts` — Path safety patterns
- `packages/taskflow-core/test/runtime*.test.ts` — Phase execution
- `packages/taskflow-core/test/tournament.test.ts`, `loop.test.ts`, `race*.test.ts`, `gate*.test.ts` — Specific phases
- `packages/pi-taskflow/test/transcript-view.test.ts` — Transcript rendering
- `packages/pi-taskflow/test/inspector-view.test.ts` — Inspector UI
- `packages/pi-taskflow/test/skills-build.test.ts` — Skill generation

**Build/Test Execution:**
- Run all: `pnpm test`
- By package: `pnpm --filter <package> test`
- By file: `pnpm --filter <package> test 'test/<name>.test.ts'`
- Type-check: `pnpm typecheck`
- Build skills: `pnpm run build:skills`
- Build all: `pnpm run build`

