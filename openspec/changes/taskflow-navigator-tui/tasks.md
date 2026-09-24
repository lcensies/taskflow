# Tasks

## 1. Core surface [sequential]

- [x] 1.1 Export `splitItems` from `packages/taskflow-core/src/peek.ts` (add `export` to the existing function; it is already re-exported via `src/index.ts`'s `export * from "./peek.ts"`). Verify: `node --experimental-strip-types -e 'import("./packages/taskflow-core/src/index.ts").then(m=>console.log(typeof m.splitItems))'` prints `function`.

## 2. Navigator component [sequential]

- [x] 2.1 Add a shared pure key map `listKey(data)` in `packages/pi-taskflow/src/inspector-view.ts` returning `"up"|"down"|"pageUp"|"pageDown"|"top"|"bottom"|"in"|"out"|"close"|undefined`, binding `↑/k`, `↓/j`, `PgUp/ctrl+u`, `PgDn/ctrl+d`, `Home/g`, `End/G`, `Enter/→/l`, `Esc/←/h`, `q/ctrl+c`. Export it. Verify: unit test asserts each alias pair maps to the same action.
- [x] 2.2 Replace `InspectorComponent.mode` with a level stack `("phases"|"agents"|"detail")[]` plus per-level cursors; keep the public constructor signature unchanged. Verify: existing `inspector-view.test.ts` still passes.
- [x] 2.3 Render the full phase list at the `phases` level (one row per phase: badge, id, fan-out `done/total`, steered marker), windowed to the viewport around the cursor. Verify: test with 30 phases asserts every phase id is reachable and no line exceeds width.
- [x] 2.4 Add `agentRows(ps)` deriving fan-out item rows from `subProgress` + `splitItems(ps.output)` (index, agent label, status). Return `[]` for non-fan-out phases. Verify: unit test over a merged two-item output asserts labels and statuses.
- [x] 2.5 Wire the `agents` level: entering a fan-out phase lists its items; entering a non-fan-out phase pushes `detail` directly with node id `<phaseId>`. Verify: test asserts both paths. {needs: 2.4}
- [x] 2.6 Agent detail opens the tail for node `<phaseId>-<idx>`; when the file is missing, render that item's `splitItems` section; when that is missing too, the existing live activity/output block. Verify: test writes one item transcript and asserts only its entries render; second test with no file asserts the section body. {needs: 2.5}
- [x] 2.7 Keep `s` steering the owning phase at every level (unchanged `InspectorResult`). Verify: existing steering test passes; new test asserts `s` at the agent level emits the phase id.

## 3. Run history integration [sequential]

- [x] 3.1 Extend `RunHistoryComponent` with an optional `transcriptFile: (run: RunState, nodeId: string) => string | undefined` and `rows: () => number`; on Enter, construct an `InspectorComponent` for the selected run (`steerAvailable: false`) and delegate `render`/`handleInput`/`dispose` to it until it pops back. Verify: test asserts Enter on a run reaches its phase list and Esc returns to the run list. {needs: 2.2}
- [x] 3.2 Bind `listKey` in the run list level (vim aliases + paging). Verify: test asserts `j`/`k` move selection and `q` closes.
- [x] 3.3 In `packages/pi-taskflow/src/index.ts`, pass the transcript resolver (`transcriptFileFor(transcriptDirFor(runsDir(ctx.cwd), run.flowName, run.runId), nodeId)`) and `() => tui.terminal.rows` into `RunHistoryComponent`. Verify: `pnpm -C packages/pi-taskflow exec tsc --noEmit` clean. {needs: 3.1}

## 4. Presentation [sequential]

- [x] 4.1 Mount both panels with `{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", margin: 1 } }` in `index.ts`, and render a bordered header/footer in the component. Verify: manual `/tf runs` shows a bordered overlay; width test still passes.
- [x] 4.2 Update the footer hint per level to list the active keys (`↑↓/jk move · →/l open · ←/h back · s steer · q close`). Verify: test asserts the agent level hint mentions `back`.

## 5. Docs [sequential]

- [x] 5.1 Update the inspector section of `packages/pi-taskflow/skills/taskflow/SKILL.md` source (`skills-src/taskflow/*.md`) and `README.md` to describe the four levels and key map, then `npm run build:skills`. Verify: generated SKILL.md contains the agent level. {needs: 2.6}
- [x] 5.2 Mark parity gap #14 as closed in `docs/internal/claude-dynamic-workflows-parity.md`. Verify: row 14 reads ✅.
