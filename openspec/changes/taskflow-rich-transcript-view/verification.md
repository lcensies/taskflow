# Verification

Run 2026-10-19 from a taskflow subagent, with `PI_TASKFLOW_CTX_DIR`, `PI_TASKFLOW_NODE_ID` and `PI_TASKFLOW_STEER_FILE` unset (they leak into the tests, see below).

## Automated

| Command | Result |
|---|---|
| `node scripts/build-skills.mjs` | OK, generated skill files rewritten for all hosts |
| `node --conditions=development --experimental-strip-types --test packages/pi-taskflow/test/skills-build.test.ts` | 3/3 pass |
| `grep -n taskflow_transcript skills-src/taskflow/core.md` | hit (line 937) |
| `pnpm run typecheck` | exit 0 |
| `pnpm test` | exit 1: 3195 tests, 3177 pass, 18 fail |

### The 18 failures are not caused by this change

They are the known failures also recorded on the shared blackboard (`test-env.preexisting-core-failures`). They still failed with HEAD `runtime.ts` swapped in:

- `flow-def.test.ts`: 16 `flow{def} ...` tests, each hitting a 10 s timeout.
- `trace.test.ts`: "a context-sharing phase emits an unreplayable decision marker" (10 s timeout).
- `workspace-baseline.test.ts`: "probe collector honors the Hermes binary override without claiming sandbox support" (`spawnSync uname` ENOENT on NixOS PATH).

No rich-transcript test (core transcript/tee, hosts runners, pi `transcript-view`/`render`/`inspector-view`) failed. I did not re-run these 18 in isolation. The cause is unconfirmed; the blackboard suspects the uncommitted `verify-slot.ts` / `runner-core.ts` work or the shared `/tmp` cwd. The subagent env also still has `TASKFLOW_DETACHED_*` variables set, which I did not unset.

Environment note: running the suite inside a taskflow subagent needs `env -u PI_TASKFLOW_CTX_DIR -u PI_TASKFLOW_NODE_ID -u PI_TASKFLOW_STEER_FILE`, otherwise `index.ts` registers `ctx_*` tools instead of `taskflow` and about 20 pi tests fail spuriously.

## Manual (pi), for the human

- [ ] 3-phase inline flow: press Ctrl+O while it runs. Streaming assistant text and tool rows with durations (`✓ bash · 1.2s`) are visible.
- [ ] After completion, Ctrl+O shows per-phase outputs (`─ output ─`) and transcript tails, with the final result last under `─── Result ───`. Collapsed view is unchanged.
- [ ] `/tf runs` → phase → detail shows a diff for an `edit` tool call.
- [ ] One `codex` or `claude` phase yields `runs/<flow>/<runId>/<node>.ndjson` starting with `{"type":"taskflow_transcript","host":"codex|claude",...}`, and it renders in the inspector.
- [ ] A fan-out phase shows 6 items and `… +N items`.

## TUI verification (pi 1.1.0 in tmux, 2026-10-18)

Flow `rtv-demo` (3 phases, executor-fast; bash/read/edit tool calls) run via `/tf run rtv-demo`
in an interactive pi inside `tmux -L rtv`. Screen captures in `evidence/`:

- `tui-ctrl-o-while-running.ansi.txt` — Ctrl+O during the run: phases `scan`/`edit` done with
  `∴ thinking`, pi-native `read` (file body), `edit` as a diff (`-2 beta` / `+2 BETA (edited)`,
  SGR-coloured), `$ cat …` bash with output, `· 0.0s` durations (durationMs 2 in the transcript),
  `─ output ─` per phase; `◐ summary` running with its tail; `─── Result ───` `(no output)`.
- `tui-collapsed-after-completion.txt` — collapsed grid, `Ctrl+O to expand` hint, unchanged layout.
- `tui-ctrl-o-after-completion.txt` / `.ansi.txt` — every phase's full tail + output; final
  Markdown result rendered once. `+2 BETA (edited)` row carries pi's diff colour
  (`38;2;166;227;161` on diff background).

Not a regression but noticed: finished-run footer reads `· · $0.02 …` (pre-existing spinner
placeholder in `footerLine`, untouched by this change).
