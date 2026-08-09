# Date/time scheduling UX — prompt index

**Read this first.** Compaction-proof authority on what this programme
is, where its decisions live, and what order its prompts run in.

- **Design doc** (why, current-state findings, decisions):
  `docs/superpowers/specs/2026-08-07-datetime-scheduling-ux-design.md`
- **Full narrative plan** (this index's source):
  `docs/superpowers/plans/2026-08-07-datetime-scheduling-ux.md`
- **Project-wide standing rules — read this too**:
  `docs/superpowers/RULES.md`. Agent topology for every dispatch below:
  Scout=Sonnet High, Implementer=Sonnet xHigh, Reviewer=Sonnet xHigh.
  Every task ultimately owes all 4 test types (unit, E2E, smoke,
  regression) — Prompts 01-04, 07, 08 are unit+regression only because
  nothing new is E2E/smoke-visible yet at that point; **Prompt 09 is
  where cumulative E2E + smoke coverage for the whole feature set
  lands.**

## Standing rules for this programme

- Self-contained prompts — a subagent should not need to re-read this
  index or the design doc to execute one, though both are the right
  place to check *why* if something looks surprising.
- **Do NOT file new issues.** Fix inline or ask; escalate only if a fix
  would widen the blast radius past the prompt's stated files.
- Run each prompt's own verify command before considering it done.
- Output cap per prompt: final message under 15 lines.

## Execution order

```
01 (shared component) → 02, 03, 04 (three independent conversions to
that component — DIFFERENT files each, safe to parallelize if you want,
sequential is simpler) → 05 (board segmentation, independent of 02-04)
→ 06 (blackout editor UI, needs 01) → 07 (confirm blackout round-trip,
needs 06 — verification only, expect zero backend changes) → 08
(court-removal guard, independent of 06/07) → 09 (E2E + smoke, needs
02-08 all done — this is where the whole feature set becomes testable
together) → 10 (regression audit, needs 08 done — checks whether an
existing test's premise became stale)
```

## Status

**Every SHA below is POST-REBASE.** The branch was rebased onto `origin/main`
(`ece80fc8`, +22 commits from PR #493) on 2026-08-09, so any SHA quoted in an
older section of this file or in a commit message is the pre-rebase one and no
longer resolves. `git range-diff` confirmed all 24 patches came through
byte-identical. Pre-rebase tip was `f0921f28`.

| # | Prompt | State |
|---|---|---|
| 01 | Shared `DateTimeField` component | **done** — `426f79ca`, `82767777` |
| 02 | Convert `division-builder.tsx` | **done** — `4d602f94` |
| 03 | Convert `competition-wizard.tsx` | **done** — `ff9e9cf3`, `8100485f` |
| 04 | Convert `settings-panel.tsx` | **done** — `6873cd39`, `9830b49e` |
| 05 | Board segmentation (real gcd step) | **done** — `a4fdc316` |
| 06 | Blackout editor UI + fix broken pointer | **done** — `e5136e19` |
| 07 | Confirm blackout round-trip (verification only) | **done** — `6ddffe18`. Premise CONFIRMED: zero backend changes needed. |
| 08 | Court-removal guard | **done** — `761b4ff4` |
| 08b | Widen guard to OCCUPYING-not-movable | **done** — `c05ad9ed`. Owner ruling applied; `FIXED_OCCUPYING` derived, never a literal list. |
| 11 | All 3 date/time fields resolve via `settings.orgTz` | **done** — `1372437b`, `fa289a71`, `3cdf6b33` |
| 09 | E2E + smoke coverage | not started |
| 10 | Regression audit (`disruption-signals.test.ts`) | not started — must run AFTER 08b, which changed the premise being audited |

## Parallel execution

Safe to run alongside the sibling `2026-08-07-cpsat-service-prompts/`
programme in a SEPARATE worktree/branch — file sets are disjoint except
a soft overlap in `apps/web/src/dictionaries/*/ui.json` (this programme
adds blackout-editor/court-removal keys via Prompts 06/08; the other
adds one `cp-sat` engine-label key) — a merge-time conflict at worst,
not a live-clobber risk, as long as each runs in its own worktree
rather than the same working directory. Do not run both in the same
checkout simultaneously.

## Owner decisions — settled, do not re-ask

| Decision | Answer |
|---|---|
| Component strategy | Native inputs, componentized into ONE shared `DateTimeField` — no custom picker, no hybrid. Used everywhere including the blackout editor. |
| Board segmentation | Matches the backend's real `gcd(matchMinutes, gapMinutes)` step, not a snap-to-{15,30,60} display rule. Extracted into a SHARED helper (`packages/engine/src/scheduling/grid-step.ts`) both sides import, so they can't drift apart again. |
| Blackout editor scope | Supplements the AI natural-language console, does not replace it. Writes into the EXISTING `config.blackouts` field — confirmed by reading `schedule.ts:146-155`'s `usesConstraints()`, no new backend endpoint needed (Prompt 07 verifies this rather than Prompt 06 building something new). |
| Court-removal guard | Hard reject (not override-with-confirmation) when the removed court has pinned/frozen fixtures. Does not block removing a court whose fixtures are all unlocked — AUTO already relocates those correctly today. |
| `DateTimeField.labelHidden` | Added in `8348a5af` (P04). Renders `<span className="label sr-only">` — the label element is **always** rendered, only visually hidden, because dropping it leaves the control unnamed. Needed where an enclosing `<legend>` already states the name (the play-hours pair): visible labels there duplicated the legend AND grew the block 20px, breaking the `sm:grid-cols-2` baseline. Strictly better than the `aria-label` those bare inputs had before — a real wrapping `<label>` means implicit association holds and `getByLabel` resolves. Its test's load-bearing half is "the span still renders". |
| `DateTimeField.required` | Added in `d80a680a` (P03). Sets `aria-required="true"` and **never** the native `required` attribute — the native one fires the browser's own English validation tooltip, which preempts the localized message (#376). The component owns that policy so no call site rediscovers it. Its test asserts BOTH halves; the native-absence half is the load-bearing one (an impl emitting both passes without it). Use this prop for any mandatory date/time field, including Prompt 06's. |
| Blackout edge cases (P06) | Inverted AND zero-length ranges are REFUSED with a localized message and a disabled save (`to` is exclusive in the engine, so `from === to` blacks out nothing — a control that silently does not work). Overlaps are ALLOWED and unwarned: the engine unions them, so an overlap is exactly its union. A half-filled row is "unfinished" in slate, not an error in red. A window naming a since-deleted court KEEPS its `<option>` — without one the select falls back to the first entry and the next save silently re-scopes the window to the whole division. Such a window is inert in the engine (`courtBlocked` skips it for every real court); Prompt 08 owns the pinned-fixture half of court removal. |
| Blackout save model (P06) | The sheet's other rows save on every change; the blackout block does NOT. It holds a draft and commits with one "Save blackout windows" button that appears only when dirty — a datetime pair cannot be saved per keystroke, and a half-typed row has no representation in the stored shape. Deliberate divergence within one card; the button names its scope so it cannot be read as saving the sheet. |
| Row height | No fixed value pre-committed — Prompt 05 decides via screenshot comparison at implementation time, per the design doc's own deferral. |

## False premises found during execution — do not re-derive

| Prompt | The plan said | What is actually true |
|---|---|---|
| 01 | `text-base sm:text-sm` is needed so iOS does not zoom on focus. | **False.** `globals.css` Pattern 5 (`@media (max-width:39.99rem){input,select,textarea{font-size:16px}}`) already forces 16px repo-wide; measured identical at 375px with and without. `sm:text-sm` only shrank the control to 14px/38px on **desktop**, beside `.input` siblings at 16px/42px — breaking the "styled identically to the division-wizard inputs" criterion the component exists for. Dropped in `615dd3ff`; the test asserts its **absence**. Do not re-add it in Prompts 02-04/06. |
| 02, 03, 04 | Each names a test file after its component (`division-builder.test.tsx`, `competition-wizard.test.tsx`, `board/__tests__/settings-panel.test.tsx`). | **None of the three exist.** The real owners are behaviour-named suites in `apps/web/src/components/v2/__tests__/`: `division-builder-schedule-seed.test.tsx`, `competition-end-date-required.test.tsx`, `schedule-settings-no-timezone.test.tsx`. Locate the real owner before writing; never create a parallel file for a component that already has one. Assume the same for any later prompt that names a test path. |
| 02 | (gap, not a premise) A call-site test can drive `DateTimeField`'s `min` prop. | It cannot: `DivisionBuilder` calls `useLocale()`, which throws outside a `DictProvider`, so `renderIsland` can only pin the *absence* case. `min` forwarding is red-proven in `DateTimeField`'s own suite instead. Expect the same wall in 03/04; Prompt 09's E2E is where the wired-up case gets real coverage. |
| 05 | Create `gridStepMinutes` in a new `grid-step.ts`. | **It already existed** in `build-grid.ts`, taking a config object. P05 is an extract-and-retype to `(matchMinutes, gapMinutes)`, not a create — which forces call-site edits (`build-rest-lattice.test.ts`, `repair.ts`, `index.ts`, and a `./scheduling/grid-step` export subpath in `packages/engine/package.json` so the board takes a leaf import and the schedule page does not ship the solvers). `REPAIR_GRID_MINUTES` is now an alias of `GRID_FLOOR_MINUTES`, one owner, no way to disagree. |
| 05 | Row height is a matter of changing `h-10` on the cell. | **False.** The place-button's `min-h-8` is the real row floor; changing the cell alone screenshots pixel-identical. Chosen: step ≥30 keeps `h-10`/`min-h-8` (41px, unchanged); step <30 uses `h-7`/`min-h-6` (33px, −19%), floored at 24px for WCAG 2.5.8. Plus `max-h-[70vh] overflow-y-auto` + sticky header. |
| 05 | (trap, not a premise) The two pre-existing board suites would have caught a wrong step. | **They could not.** Both use a 30/0 config — the one shape where `gcd` and `matchMinutes+gapMinutes` coincide. That is why neither needed editing and why neither ever failed. Any new board test must use a config where the two DISAGREE (30/10, 45/15, 60/20) or it is vacuous. The step assertion must also compare against spacing **measured off the slots `buildGrid` actually emitted**, never against `grid.stepMinutes`, which is only buildGrid's claim about itself. |
| 06 | The blackout shape is `{ court?: string; from: number; to: number }`. | **That is the ENGINE type** (`packages/engine/src/scheduling/calendar.ts`, epoch ms). The STORED/wire shape the UI must write is `schemas.ts` `ScheduleConfig.blackouts` = `{ court?: string; from: IsoDateTime; to: IsoDateTime }` (`.max(200)`, court `.max(100)`), and the server converts to ms. Writing numbers is a 400, not a unit difference. **Prompt 07 verifies the round-trip — assert ISO on the wire.** |
| 06 | The editor writes "via the panel's existing `onChange(config)` prop". | **`ConstraintsPanel` has no `onChange` prop.** Its props are `{divisionId, initialSettings, canEdit}` and it self-saves with a read-modify-write: GET `/api/v1/divisions/{id}/schedule-settings`, then PUT `{config: {...current.config, <patch>}}`. P06 generalised the existing `save()` into `savePatch(patch, applied)`; `constraints` and `blackouts` are now two callers of one function. No `tz` key is ever re-sent (V305). |
| 06 | "Replace the read-only `{startWindows.length} start window(s) set` block." | **Different constraint family.** That line counts `constraints.startWindows` (per-entrant/pool `notBefore`/`notAfter`, AI-parser-authored); blackouts had NO display in this panel at all. Deleting it would drop the only surface for AI-authored start windows, so it was LEFT ALONE and the editor was added as a new full-width row at the end of the sheet. |
| 06 | "Read how `constraints-panel.tsx` already resolves its other time-based fields to the org tz." | **It has none.** Before P06 the panel's controls were two checkboxes, three number inputs and one select — zero date/time handling, zero tz conversion. The path followed instead is the settings panel's: `toLocalInput(iso)` in / `new Date(localInput).toISOString()` out, i.e. the BROWSER's zone, matching the sibling `boardset.startAt` field. **Open gap:** that is not `settings.orgTz`, so an organiser in a different zone from the venue types venue-wrong instants — the same pre-existing behaviour as every other absolute-time field in the panel, not a P06 regression. |
| 06 | "Two `DateTimeField kind="time"` fields (from/to)." | Used `kind="datetime-local"`. A blackout is an ABSOLUTE instant range; a time-only pair would have to be expanded across N days (the `dailyHoursToWindows` trick session windows use) and would NOT round-trip — which is exactly what Prompt 07 checks. One row = one stored window, losslessly. |
| 06 | (finding, not a premise) `boardset.customWindows` "points at itself". | It lives in `settings-panel.tsx` and pointed at the constraints panel, which has never had a session-window editor. The slot is still needed — it is the only explanation for the two daily-hours inputs being absent — so the COPY was repointed in all four locales, not deleted. Separately: **nothing in the app writes a non-uniform `sessionWindows` set** (this panel is the only writer and always expands one daily pattern), so that state can only arrive through the API. |
| 07 | The test file is `schedule.test.ts`. | **Right for once** — the fifth path this plan names and the first that exists. `putScheduleSettings` is imported by 21 suites; `schedule.test.ts` is the one that already holds `putScheduleSettings` + `getScheduleSettings` + `loadSettings` + `withTenant`, so the round-trip belongs there. P08 shares the file: P07's work is one banner-delimited block at the end of the DB section with its own helpers, nothing above it touched. |
| 07 | (trap, not a premise) An `autoSchedule` test proves the solver honours a stored blackout. | **Only if the window is placed where the solver cannot dodge it.** z3's lattice opens at LOCAL MIDNIGHT on the governing clock — `applyWindow` derives the universe from `startAt`'s DAY, not from `startAt`. Measured: window at 11:00 with `startAt` 10:00, z3 relocated the whole 6-fixture board to 00:00–02:30, so "nothing landed inside the window" was true of a solver that never looked at it. Put the window just after local midnight instead. |
| 07 | ~~"A stored blackout flips the run from greedy onto z3, so control and guarded are different code paths."~~ | **CORRECTED BY P09 — this was P07's own config generalised too far.** P07's 2-fixture board did come back `engine: "z3"`, but P09's six 30-min fixtures / one court / 60-min window at `dayStart+30min` returned `engine: "greedy", status: "ok", elapsed_ms: 1` for BOTH the control and the guarded run — greedy's sequential placement is itself blackout-aware, and z3 looks like an escalation for boards the cheap pass cannot clear, not something any non-empty `blackouts` triggers. **Never assert an engine name on a guarded run; assert the observable contract instead.** Measure `solver.engine` for your own config rather than extrapolating from either data point. |
| 07 | (P09 finding) `metrics.makespan_minutes` is a fine stand-in for "the guarded board finishes later". | **False, and vacuous in the dangerous direction.** Makespan is first-start-to-last-finish among PLACED fixtures, so a solver that skips the whole pre-window period and packs a contiguous run right after it reports the SAME makespan as the control — both spans are `6 × matchMinutes`, merely shifted. Only the absolute finish time moves. Compute it from `max(assignments[].ends_at)`, never by hand from `scheduled_at + matchMinutes`. |
| 07 | (trap, not a premise) A blackout leaves a HOLE in the board. | **No — z3 pushes the whole board past it**, because a contiguous 3h packing after the window beats 30min + a gap + 2.5h. Asserting "fixtures exist on both sides of the window" is red against correct behaviour. The honest, arrangement-independent assertion is that the guarded board FINISHES LATER than the control's. |
| 01 | Test with `@testing-library/react` + `screen.getByLabelText`; component uses `useId`/`htmlFor`. | **Not available.** `apps/web` has no jsdom and no `@testing-library` (vitest `environment: "node"`) — that suite cannot collect. Repo convention is `renderToStaticMarkup` + element-tree walk, which needs the component **hookless**; association is implicit via the wrapping `<label>`, matching the division wizard. Later prompts' tests must follow the same pattern. |

## Prompt 09 recon — done ahead of dispatch, its spec is largely fiction

Scouted read-only before P09 runs. Every row below contradicts the
prompt's own text, so do not follow that snippet literally.

| Prompt 09 says | Truth |
|---|---|
| Create `e2e/schedule-datetime-ux.spec.ts` | e2e lives at **`apps/web/e2e/`**, not the repo root — 73 specs, config `apps/web/playwright.config.ts`. |
| `[data-testid="board-cell"][data-hour="12"]` | **Neither attribute exists anywhere in `apps/web/src`.** Board cells are bare `<td>` (`board-grid.tsx:140`). The real handles are the table's `aria-label` (`board-grid.tsx:103`) and the empty-cell button's `aria-label` "Place picked match at {time} on {court}" (`board-grid.tsx:177`, key `board.grid.placeAriaCourt`). Testids that DO exist: `board-tray`, `board-tray-mobile`, `schedule-result-strip/-headline/-budget`. |
| Three separate routes | **One route, three tabs**: `/o/{org}/c/{comp}/d/{div}/schedule?tab=board\|settings\|constraints` (`schedule/page.tsx:37`). Build it with `divisionPath()` — `apps/web/e2e/helpers.ts:753`. |
| copy regexes (`/add blackout/i`, `/remove court 2/i`, `/auto.?schedule/i`) | Violates the standing convention in this exact area: **"SELECTORS ARE IDS, NEVER COPY (#465)"** (`z3-auto-schedule.spec.ts:21`). `board.autoSchedule` is "Auto-schedule {name}" — interpolated, so copy matching is fragile too. |
| "seed via the real helper" for a pinned fixture | **No such helper exists.** The pattern is `PATCH /api/v1/fixtures/{id} {schedule_locked:true}` (`schedule-board.spec.ts:249`), after `addEntrantsViaApi` (`helpers.ts:790`) + `createStageAndGenerate` (`helpers.ts:807`). |
| hand-rolled `scrollWidth`/`clientWidth` | `expectNoHorizontalScroll(...)` already exists — `helpers.ts:43`. |

Other facts P09 needs: auth is the `setup` project → `e2e/.auth/pro.json`,
BASE `http://localhost:3000` (**not 3100**); projects are
`setup`/`parallel`/`serial`/`mobile-se`(375×667)/`mobile-14`(390×844);
`globalSetup` aborts unless a prod server is already on BASE;
`test:e2e` is **three chained runs**, so a parallel-phase failure means
serial and mobile NEVER RAN. Auto-schedule via
`POST /api/v1/stages/{stageId}/schedule/auto {only_unlocked}`.
Smoke is `npm run test:smoke` (`node --experimental-strip-types
scripts/smoke.ts`); every assertion is `check(label, cond)`
(`smoke.ts:82`) and the "control-run" idiom is: assert the gated case,
then an identically-shaped ungated one through the same path
(`smoke.ts:5168`, `:8071`).

Vocabulary, which differs per layer: DB `fixtures.schedule_locked`
(`V214__fixtures.sql:39`), engine `pinned` (`build-grid.ts:49`), UI copy
uses both (📌/🔒). Prompt 08's guard must speak `schedule_locked` at the
DB layer.

Corroboration for Prompt 07: an existing spec already seeds blackouts
with `PUT /api/v1/divisions/{id}/schedule-settings` carrying
`blackouts:[…]` (`ai-architect.spec.ts:1219`) — independent evidence
from the e2e side that no new endpoint is needed.

## Session state — 2026-08-09, FIRST HALF (SUPERSEDED — see the final section at the bottom of this file)

The section immediately below was written mid-session, before the rebase and
before Prompts 08b/09/10/11 landed. **Its commit SHAs are all pre-rebase and no
longer resolve**, and it lists work as in-flight that is now done. Kept for its
rulings and its reasoning, not for its status. Read the LAST section first.

**Branch/worktree**: `worktree-datetime-ux` at
`/Users/ashokhein/github/seazn.club/.claude/worktrees/datetime-ux`.
Env symlinks, real `pnpm install`, `@seazn/engine` verified resolving
INSIDE the worktree, `.claude/agent-memory` symlinked.

**Throwaway Postgres for the DB-backed server suites**:
`postgresql://postgres@127.0.0.1:54371/seazn_test`, `DATABASE_SSL=disable`,
`data_directory` verified as this session's scratchpad. **The local dev DB
CANNOT run `schedule.test.ts`** — it lacks `division_has_results(uuid)` and
yields 9 reds that read exactly like a branch regression.

**Measured gates** (by the orchestrator, not reported by an agent):
- web `v2/__tests__` + `v2/shared/__tests__` + `v2/board/__tests__`:
  **760 / 760 / 0 failed / 251 suites / 0 pending / 0 off-worktree** (after P06).
- engine full: **2857 passed / 2858 total / 1 pending / 735 suites** (after P05).
- `schedule.test.ts` + `schedule-settings-wire.test.ts` on the DB above:
  **36 / 36 / 0 pending** (after P07); P08 took it to 42/42.
- `apps/web` `tsc --noEmit`: exit 0, 0 lines.

**Two owner rulings taken mid-session, both IN FLIGHT:**
1. **Widen the court-removal guard.** Rejection must also fire when the
   removed court holds a fixture whose `status` is in `OCCUPYING` but is
   not `MOVABLE_STATUS` — `schedule.ts:87` is `"scheduled"` alone while
   `:92` is `["scheduled","in_play","decided","finalized","forfeited"]`,
   so a `decided` fixture occupies a court, is immutable (doc 12 §6), is
   NOT `schedule_locked`, and was being silently orphaned. Derive the set
   FROM those constants; never hand-type a status list. The
   `scheduled`-only removal must still SUCCEED — that is the regression
   most at risk from over-widening.
2. **Resolve all three local-datetime fields through `settings.orgTz`.**
   Blackout from/to, `boardset.startAt`/`endAt`, and
   `dailyHoursToWindows` all resolve via the BROWSER zone today
   (`settings.tz` is DISPLAY, `orgTz` is the governing clock, #448). One
   shared bidirectional helper taking the zone explicitly — not three
   local fixes. Server is CORRECT and must not change. Tests must use
   zones that DISAGREE (`America/Los_Angeles` vs `Pacific/Auckland`, as
   P07 does); equal zones make the test vacuous against broken code.

**Remaining**: 09 (E2E + smoke — see the recon section above, its spec is
largely fiction) and 10 (regression audit of `disruption-signals.test.ts`,
whose premise the WIDENED guard may have changed — run it after the
widening lands, not before).

**Subagent topology for this session**: owner overrode `RULES.md` — first
to Opus xHigh, then to **Sonnet Max**. Set in `.claude/agents/*.md`
frontmatter in the MAIN checkout (tracked files, left dirty there; revert
at session end). Every prompt has been run by an implementer subagent with
an inline self-contained brief, then gate-verified by the orchestrator.

**Process that has been working and should continue**: every prompt's
brief restates the false premises found so far; every agent must prove its
test is not vacuous by MUTATION (revert the production file, confirm the
red reappears AND `numTotalTests` holds); the orchestrator re-runs the gate
itself at each boundary rather than trusting a summary.

## Rebase onto origin/main — 2026-08-09

Branch rebased from the stale local `main` (`fa1114e7`) onto `origin/main`
(`ece80fc8`): **+22 commits, all of PR #493** (pick-a-template AI demo, #364).
Now 24 ahead / 0 behind.

- **Zero conflicts.** Only 1 of our 24 commits touches i18n (`e5136e19`), and
  the dict additions on both sides landed on disjoint lines.
- **`git range-diff fa1114e7..f0921f28 origin/main..HEAD` printed only `=`
  rows** — every patch came through byte-identical. This is the check worth
  repeating on any future rebase here; a clean exit code alone does not prove
  patches survived intact.
- Post-rebase drift gates all clean: `openapi:gen`, `i18n:gen-keys`,
  `schema:snapshot --workspace packages/engine` → `git status --porcelain`
  empty.
- Post-rebase env re-verified (a rebase can invalidate it): `readlink -f
  node_modules/@seazn/engine` resolves INSIDE the worktree, both `.env.local`
  symlinks intact, and the only incoming dep-file change was one new npm
  script (`capture:ai-demo`) — no lockfile churn, so no reinstall.

## Post-rebase wave gate — the one real regression it caught

Full `apps/web` suite on a fresh throwaway PG (`:54373`, `data_directory`
confirmed ours): **6139 passed / 6202 total / 10 failed / 53 pending**, 0
suites resolving outside the worktree path.

All 10 failures were one file,
`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/schedule/__tests__/officials-loads-deferred.test.tsx`,
one cause: `TypeError: Cannot read properties of undefined (reading
'timezone')` at `schedule/page.tsx:70`.

**Not a production bug — a stale test mock.** `page-auth.ts:28` declares
`org: OrgMembership` as REQUIRED, so production always supplies it; the
suite's `vi.mock` factory omitted `org` entirely and only typechecked because
**a `vi.mock` factory is untyped**. It stayed harmless for exactly as long as
nothing read the field.

Two things worth carrying forward:

1. **A scoped gate cannot see this class of break.** P11 ran
   `v2/__tests__ + shared + board` and measured a legitimate 780/780; the
   suite that broke lives under the *page* directory, outside that glob. When
   a change edits a `page.tsx`, the page's own `__tests__` sibling must be in
   the gate — or only the full-suite wave boundary will catch it.
2. **`page.org.timezone` genuinely can be undefined in production.** The payer
   placeholder branch (`page-auth.ts:179`) builds `org` from four fields and
   casts `as unknown as OrgMembership`, so tsc will never flag the gap.
   `resolveVenueTz` is what makes it safe (missing zone → `DEFAULT_TZ`,
   `tz.ts:44-51`). Now pinned by a test that asserts the UTC fallback AND a
   control with `Pacific/Auckland` present, so it cannot pass for a page that
   ignores `org.timezone` altogether.

## Follow-ups handed back by P11 — outside its scope, NOT done

- `move-panel.tsx` (fixture reschedule) still resolves through the BROWSER
  zone — same bug class as the three fields P11 fixed.
- `stages-panel.tsx` and `registration-settings.tsx` each keep a private
  `toLocalInput` copy rather than the shared helper.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` (the
  competition-level board) took the same `resolveVenueTz(null,
  page.org.timezone)` line but has **no page-level test suite at all**, so
  nothing covers its org-zone resolution. Candidate for P09.

**Ruling recorded by P11 on stored instants: (a), no migration.** The stored
value is an absolute instant; only its RESOLUTION was wrong, so a changed
display is the truth surfacing. A migration is also impossible in principle —
it would need each writer's browser zone at write time, which was never
recorded.

## Prompt 10 — audited inline, NO CHANGE NEEDED

The plan asks whether P08's guard made `disruption-signals.test.ts`'s
`court_gone` scenario unreachable. It did not, and the worry is structurally
impossible rather than merely unfounded:

- The `court_gone` case (`disruption-signals.test.ts:70-77`) seeds
  `fx({ id: "a", court_label: "Court 2" })`, and `fx` defaults to
  `status: "scheduled"` (line 17) with no lock.
- **`DisruptionFixtureInput` has no lock field at all** — there is no
  `schedule_locked` anywhere in the type — so this suite could never have
  seeded a pinned fixture, and the plan's premise ("it was written to test a
  pinned fixture on a removed court") cannot have been true.
- P08b's guard deliberately ALLOWS removing a court whose fixtures are all
  `scheduled` and unlocked. That is precisely this scenario, so it stays
  reachable through the save path.

Consistent on the other side too: the suite's
`it.each(["in_play","decided","finalized","abandoned","forfeited","cancelled"])`
"never flags" case covers the statuses P08b now rejects at save time, so the
two layers do not overlap or contradict.

Per the prompt's own Step 2 instruction ("if it still passes unmodified, leave
the file alone"), the file is untouched.

---

# FINAL SESSION STATE — 2026-08-09 (READ THIS FIRST AFTER A COMPACTION)

**The programme is COMPLETE. All ten prompts are done and committed.** What is
left is release mechanics and a short list of deliberate non-goals, both below.

## Where the work is

Worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/datetime-ux`,
branch `worktree-datetime-ux`, **29 commits, rebased onto `origin/main`
(`ece80fc8`), 0 behind**. Nothing pushed. No PR. Tree clean.

Always prefix `cd <that abs path> &&` in the SAME call as any command you judge
— the shell cwd resets to the main checkout between tool calls, and it bit this
session twice (a `git add` ran from `packages/engine` and failed with
"pathspec did not match"; a `git status` reported the MAIN checkout's dirty
`.claude/agents/*.md` as if it were the worktree's).

Prompt→commit map is the **Status** table near the top of this file. Every SHA
there is post-rebase; anything quoted in a commit message body is pre-rebase and
will not resolve.

## Gates, as measured by the orchestrator (not agent-reported)

| Gate | Result |
|---|---|
| `packages/engine` `vitest run --coverage` | **3005 / 3006**, 0 failed, 1 pending, 128 files, exit 0 — coverage thresholds held |
| `apps/web` full suite, pre-fix | 6139 / 6202, 10 failed (one file, since fixed) |
| `apps/web` the two fixed suites | **31 / 31** |
| `apps/web` full re-run, post-P09 | **STILL IN FLIGHT at compaction — re-run it, this is the one number missing** |
| `tsc --noEmit` both workspaces | exit 0, clean |
| eslint | web 0 errors / 79 warnings, engine clean; **no warning in any file this branch touches** |
| Drift gates | `openapi:gen`, `i18n:gen-keys`, `schema:snapshot` → `git status --porcelain` empty |
| e2e (P09, agent-run) | 5/5 in the `parallel` project; serial + mobile phases NOT run |

**The one outstanding verification** is the post-P09 full `apps/web` run. Command:
```
cd <worktree>/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54373/seazn_test \
  DATABASE_SSL=disable npx vitest run --maxWorkers=3 --reporter=json --outputFile=<out>.json
```

## Environment facts that cost real time this session

- **Throwaway Postgres on `:54373`** (`postgresql://postgres@127.0.0.1:54373/seazn_test`,
  `DATABASE_SSL=disable`), migrated + `sync:sports`. `data_directory` verified
  ours. It may still be up — check `pg_ctl -D <scratch>/pg54373 status`. **The
  dev DB on :5432 cannot run `schedule.test.ts`** (missing
  `division_has_results(uuid)`, 9 reds that mimic a branch regression), and is
  off-limits anyway.
- **The engine suite hangs, it does not merely run slow.** Its own
  `vitest.config.ts` documents 46–57 s. A run sat at 23 minutes; `ps -M` showed
  the process idle with its workers gone and the log's only line was
  `received "cleanupThread" command from terminated worker: 1`. The cap is
  computed from `totalmem()` (16 GB → 5 workers), **not available memory**, so
  with other sessions running plus coverage instrumentation it overcommits.
  **Run it with `--maxWorkers=2`** — green in ~2 min.
- The harness reported that killed run as **"exit code 0"**. The script's own
  `echo "ENGINE_EXIT=$?"` caught the real `143`. Always have the command write
  its own exit code.
- **Ports 3000 and 3100 were both squatted** by other sessions. P09 used 3200
  with `PLAYWRIGHT_BASE=http://localhost:3200`. Use `localhost`, never
  `127.0.0.1` — the session cookie is `Secure` and 127.0.0.1 401s every API
  call while the browser still looks signed in.
- Magic-link is rate-limited **5 per 5 min per IP, fail-closed**; `auth.setup`
  spends 2.

## Screenshots — the programme's screenshot debt is CLEARED

10 PNGs, 5 surfaces × {1280, 375}, at
`<session scratchpad>/p09-screenshots/`. **Scratchpad is ephemeral** — if these
need to outlive the session, copy them somewhere durable. Orchestrator-verified
three of them: the blackout editor showing a valid AND a refused row with save
disabled; board settings showing `labelHidden` working (legend names the pair,
no duplicated From/To rows, shared baseline); the board on a 5-minute grid.

## Deliberate non-goals and known-unfixed — do NOT "discover" these as bugs

- **`move-panel.tsx` still resolves fixture reschedule through the BROWSER
  zone** — same bug class P11 fixed, outside its three-field scope.
  `stages-panel.tsx` and `registration-settings.tsx` keep private
  `toLocalInput` copies. Handed back by P11, not done.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` (the
  competition-level board) took the same `resolveVenueTz(null,
  page.org.timezone)` line but has **no page-level test suite at all**.
- **`putScheduleSettings` takes no `pg_advisory_xact_lock`** — pre-existing on a
  hot endpoint, not introduced here.
- **API `HttpError` messages are plain English and are rendered raw to the user**
  (`settings-panel.tsx:65` does `setError(err.message)`). This violates the
  4-locale rule, but it is the convention of every `HttpError` in `usecases/`
  — blast radius is hundreds of strings across ~40 files. Flagged, not fixed.
- e2e **serial and mobile phases never ran** (`test:e2e` is three chained runs;
  P09 ran the `parallel` project only).
- The 79 eslint warnings in `apps/web` are all in untouched files.

## Housekeeping owed at session end

`.claude/agents/{implementer,reviewer,scout}.md` are **tracked files left dirty
in the MAIN checkout** (set to `model: sonnet`, `effort: max` per the owner's
instruction for this session). Revert them unless the owner wants that kept.

## Process that worked, and should continue

Every prompt ran as an implementer subagent with a self-contained brief that
restated the false premises found so far; every agent proved its test
non-vacuous by MUTATION (revert the production line, confirm the red returns
AND `numTotalTests` holds, confirm the file restored); the orchestrator re-ran
the gate itself at each boundary rather than trusting a summary.

That last rule earned its keep twice this session: the post-rebase full suite
caught 10 failures a scoped agent gate could not see, and P09 disproved a claim
this very file had asserted as general.

## Owner-raised 2026-08-09, NOT actioned: minimum rest appears in TWO tabs

The owner spotted from the P09 screenshots that "minimum rest" is editable in
both the Settings tab and the Constraints tab. Investigated; recording the
answer so nobody re-derives it, and so nobody "fixes" it by deleting a field.

**Two fields, deliberately, and they are NOT duplicates:**

| Tab | Field | Framing (`calendar.ts:89-101`) |
|---|---|---|
| Settings | `config.perEntrantMinRest` | "the shape of the day" |
| Constraints | `config.constraints.restMin` | "a rule about entrants" |

Both live in the SAME `PUT /divisions/{id}/schedule-settings` payload
(`schemas.ts:738` and `:753`).

**The engine already reconciles them and the old fork is CLOSED.**
`effectiveRestMinutes` (`calendar.ts:102-117`) returns the strictest of
`perEntrantMinRest`, `constraints.restMin`, `restByGroup` and `noBackToBack` —
**MAX, not precedence** (#459, owner ruling 2026-08-04). It is exported
specifically so the placer and the verifier answer identically; its own comment
records that they used to disagree, which is the recurring bug class in this
area. **Do not "simplify" this to one field or to `??`** — `0 ?? x` is `0`, and
that erased a division rule rather than adding nothing.

**What IS wrong is the UI, and it is unfixed:**
- Both controls render the same hint ("Breathing room between one entrant's
  matches"), so they read as the same setting duplicated.
- Neither states that the effective floor is the MAX of the two, and neither
  shows the other's current value. Set Settings=30 and Constraints=10 and the
  organiser gets 30, with nothing on screen explaining why the 10 did nothing.
- A fix should surface the effective floor (and which field is winning) rather
  than remove either control — the two framings are intentional.

**Also found, pre-existing, NOT this programme's doing:** the constraints
panel's rule rows are **hardcoded English**, not `msg()` calls — "Minimum rest",
"Breathing room between one entrant's matches.", "At least one break between a
team's matches", "No entrant plays two rounds running.", "Enforced across every
division…". Verified present on `origin/main`. This violates the 4-locale rule
and is a separate piece of work from the duplication above.
