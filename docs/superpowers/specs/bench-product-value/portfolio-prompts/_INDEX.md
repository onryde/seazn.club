# Product portfolio (7 follow-ups) — session index

**One session per row.** Read `docs/superpowers/RULES.md`, then this file,
then the session's prompt file. This file is the compaction anchor: every
ruling, false premise, and status change gets written here **as it
happens** (the scoringpad/release-2 pattern).

Programme origin: bench spec §14 (`../designs/2026-08-12-scheduler-bench-design.md`).
**Whole programme is creative-complete but BUILD-GATED: owner green-light
required per session.** Two extra hard gates: P8–P10 wait for the
release-2 C-chain (shared `schedule.ts`/`build.ts`); P11 waits for
ScoringPad S13 (scoring-ingest cutover). The bench itself stays
strict-wait (S13+C8) per its own spec — it is NOT a row here.

Specs of record (all in `../designs/`):

| D | Feature | Spec |
|---|---|---|
| D1 | Format templates | `../designs/2026-08-13-format-templates-design.md` |
| D2 | Capacity pre-check | `../designs/2026-08-13-capacity-precheck-design.md` |
| D3 | Schedule health | `../designs/2026-08-13-schedule-health-design.md` |
| D4 | Stage progression + TBD fixtures | `../designs/2026-08-13-stage-progression-design.md` |
| D5 | Venues & courts | `../designs/2026-08-13-venues-courts-design.md` |
| D6 | Batch event import | `../designs/2026-08-13-batch-event-import-design.md` |
| D7 | News enrichment + digest | `../designs/2026-08-13-news-enrichment-design.md` |

## Order

Ratified build order: **P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11.**
P1–P4 are mutually independent (any subset may run, order above is the
recommendation); P5→P6→P7 strict; P8→P9→P10 strict; P11 independent but
S13-gated. New-branch-in-worktree rule applies to every session.

| Session | Feature | Prompt file | Depends on | External gate | Status |
|---|---|---|---|---|---|
| P1 | D2 capacity lib + route guard + card | `P01-capacity-precheck.md` | — | green-light | **MERGED** `78c8618f` (#544) |
| P2 | D3 health lib + route + panel | `P02-schedule-health.md` | — (P1 pattern reuse, soft) | green-light | **MERGED** `651c56c3` (#547) |
| P3 | D7 enrichment + weekly digest | `P03-news-enrichment.md` | — | green-light | **MERGED** `51601495` (#545), V358 |
| P4 | D1a template catalog + instantiation + wizard | `P04-templates-single-stage.md` | — | green-light | **MERGED** `e35efff1` (#548) |
| P5 | D4a seeding rules + TBD fixtures + fill engine | `P05-progression-engine.md` | — | green-light | **MERGED** `776ba389` (#554), V360 |
| P6 | D4b proposal UI + confirm flow | `P06-progression-ui.md` | P5 | green-light | **MERGED** `cdcc3bef` (#568), V362 |
| P7 | D1b multi-stage templates | `P07-templates-multi-stage.md` | P4, P5 (StageSeeding merged) | green-light | TODO — **started then HELD by owner 2026-08-14**; re-pinned citations, rulings and T1–T5 briefs handed over (see below) |
| P8 | D5a venues/courts schema + API + org UI | `P08-venues-schema-ui.md` | — | green-light + **release-2 C-chain done** | TODO |
| P9 | D5b scheduler integration + stored-config migration | `P09-venues-scheduler.md` | P8 | same as P8 | TODO |
| P10 | D5c calendars + window compiler | `P10-venues-calendars.md` | P9 | same as P8 | TODO |
| P11 | D6 batch import | `P11-batch-import.md` | — | green-light + **ScoringPad S13 done** | TODO |

## Decisions already made (do not re-open)

All owner-ratified 2026-08-13 in the design session:

- Deliverable: **7 separate full specs** + this prompt directory;
  **creative-only** — nothing builds without a per-session green-light.
- D2: advisory card; Solve hard-blocked ONLY on `verdict:"impossible"`;
  suggestions quantified by re-running the arithmetic (`flipsVerdict`).
- D3: per-metric bars 0–100, **no composite grade**.
- D4: propose + confirm (never fully automatic); **TBD placeholder
  fixtures for all stages at setup time** (owner's addition) — confirm
  FILLS existing fixtures, never regenerates; applied schedules survive
  seeding. One fill pathway shared with intra-bracket `fillSlot`.
- D5: full v1 = entities + scheduler integration + **tags** (owner's
  suggestion, replaces typed attribute columns) + **calendars in v1**.
  Stored-config migration converts court strings → court rows (the
  `ScheduleConfig`-is-the-read-path trap, handled by migration not by a
  permanent tolerant union).
- D1: **curated built-ins only**; templates carry i18n keys, never
  strings; catalog uses DB-checked StageKinds only.
- D6: KEPT after "why do we need this" challenge (career-pages-day-one +
  paper catch-up); **JSON only, finished matches only**; dry-run fold
  before any write; appends through the ONE production writer.
- D7: enrich existing drafts **and** add `weekly_digest` kind; digest
  trigger v1 = button (cron only if a job runner already exists — none
  assumed); enrichment is fail-open (plain draft, never a missing draft).
- Shared-lib contracts that also bind the future bench: `capacity.ts`,
  `health.ts`, `court-windows.ts` (pure, no DB/solver/clock), dry-run-fold
  shape (D6 ↔ bench stage-0). Pack schema ⊃ template schema.
- The bench programme's §14 now defers to THIS index for the 7 items.

## Standing constraints (restate in every dispatch brief)

- All four test types per session (unit / e2e / smoke / regression),
  stated in acceptance criteria; deferrals named in the PR body.
- i18n ×4 locales for every user-facing string (flat dotted keys);
  `content/help/**` stays English-only.
- UI verified 1280/320/768, no horizontal page scroll; `/admin` surfaces
  functional-bar only (P11's import page qualifies).
- Structured logging (pino) in new server code; never in tests or
  `src/core/**`.
- Pre-commit: `npm run openapi:gen && git status --porcelain` empty.
- No new GitHub issues: fix inline if in blast radius, else escalate.
- Worktree per session branch; `pnpm install --frozen-lockfile`.
- **Scout re-pin before touching anything** — every file:line in the
  specs/prompts predates C1/S10+ landings by design.
- **Schema work** (P4, P5, P8, P9, P11 create tables / update columns /
  add DB indexes): load the `supabase-postgres-best-practices` skill
  BEFORE writing any migration. Baseline owed regardless: every FK gets
  an index; array/jsonb columns queried by containment get GIN (e.g.
  `courts.tags` for `@>`); uniqueness lives in DDL (unique index), never
  app-side checks; greenfield stance — correct schema over backwards
  compatibility; re-verify the next free `V<n>` at execution, never
  trust the prompt's number.

## Status log

(append here as sessions run)

- 2026-08-13 — programme authored: 7 specs + 11 prompts committed,
  build-gated. C1 + S10 in flight at authoring time; S9 + C0 merged.
- 2026-08-13 — **wave 1 green-lit and started** (P1 ∥ P3, one worktree and
  one dedicated Postgres each). Ratified wave plan for the rest:
  W2 = P2 ∥ P4, W3 = P5 alone (two migrations must never run
  concurrently — mid-wave `V<n>` collision), W4 = P6 ∥ P7. P8→P9→P10 and
  P11 stay strictly sequential behind their external gates.

### False premises found by wave-1 scouts (rulings, do not re-derive)

Seven citations in the D2/D7 specs were wrong at authoring time. All are
now rulings; the specs below are corrected in place.

**D2 / P1**

1. `capacity.impossible` matched **no** convention in the tree. Typed
   codes here are ALL_CAPS_SNAKE, no dots (`EngineErrorCode`:
   `STAGE_NOT_READY`; `HttpError`: `AI_PLAN_FAILED`); dotted-lowercase
   `capacity.*` exists in source only as i18n keys. **Ruling: the code is
   `CAPACITY_IMPOSSIBLE`**, thrown as
   `new HttpError(422, msg, "CAPACITY_IMPOSSIBLE", { report })`. The
   engine enum and `ENGINE_HTTP` map are NOT widened — the lib stays pure
   and throws nothing; the web layer throws.
2. **There is no competition-scope `/schedule/auto` route.** The prompt's
   "joint competition variant" does not exist under that name. Ruling:
   guard the stage auto route + `aiPlanForCompetition` (assess
   per-division, 422 with the impossible set); leave the apply route
   alone.
3. `ScheduleConfig`'s real field is **`matchMinutes`**, not the spec's
   `m`/`matchDuration`.

**D7 / P3**

4. **`standings_snapshots` has no history** — `writeSnapshot`
   (`engine-db/competition.ts:224-236`) is `on conflict do update` keyed
   `(stage_id, pool_id)` and clobbers the prior row. The spec's
   "standings moves" enrichment therefore had **no data source at all**.
   Ruling: add `previous_positions jsonb`, preserved on upsert via
   `case when positions is distinct from excluded.positions then …`.
   The `is distinct from` guard is load-bearing — `recomputeStandings` is
   idempotent and re-runs, and an unguarded assignment erases the delta
   on the second run. This makes P3 a schema session, which the table
   above did not anticipate.
5. **`post_drafted` does not exist** (`git grep` = 0 hits; the
   structured-logging wave `989e0ba8` touched no news files). The spec
   cited it as an existing event to extend. It is being created.
6. **Round-recap is not a separate trigger** — it is drafted inline by
   `draftPostsForDecidedFixture` when `TABLE_KINDS.has(stage_kind)`. One
   call site, not two.
7. **A job runner already exists** — GitHub Actions `schedule:` cron →
   `x-cron-secret`-guarded endpoint (funnel-reminders, billing-events,
   billing-grant, billing-quantity, ai-preview-sweep, all `-stg`). D7's
   conditional ("cron only if a runner exists") therefore resolves to
   **ship the cron**, following that shape, stg-only.

Watch item for every wave-1/2 session: `PostKind` is declared **twice**
(`org-posts.ts:32` and `schemas.ts:2941`) and may also carry a DB CHECK —
the same API-enum-⊃-DB-CHECK mismatch already flagged for D1's
`americano`/`page_playoff`. Verify all three sites, never two.

### Live-branch collisions during wave 1

- `feat/c1-round-ordering` edits `usecases/schedule.ts` (the exact file
  P1's guard touches) + `engine/src/scheduling/build.ts`. P1's edit to
  that file is kept minimal and additive for this reason.
- `feat/s10-w8-chassis-renderer` edits all four `dictionaries/*/ui.json`
  + `lib/i18n-keys.ts`. P1 and P3 both add keys there too, so keys are
  namespaced disjointly: **P1 `schedule.capacity.*`, P3 `news.*` /
  `digest.*`** (note `register.capacity.*` already exists, unrelated).

### P3 completion notes (2026-08-13)

Implemented on `feat/p3-news-enrichment` (11 commits), not yet PR'd.
V358 migration applied to the session's own test DB. Two things beyond
the scout's four rulings, found during implementation:

- Ruling 4 said `previous_positions`; the real column is `rows` (JSON
  array of `StandingsRow`, not `positions`), so the migration/code use
  `previous_rows` — same `is distinct from` guard, adapted name.
- **New finding, not scouted**: `org_posts_auto_once` (V295) keys on
  `(org_id, trigger, fixture_id, division_id, stage_id, round_no)` —
  none of which a digest has, so every digest after an org's first
  would collide and silently no-op. V358 also narrows that index's
  `where` clause to exempt `trigger = 'weekly_digest'`. Consequence:
  the button is deliberately NOT idempotent (every press is a fresh
  draft); the cron (ruling 7) relies on its own weekly schedule as the
  only dedup, and skips an org with nothing to report rather than
  posting an empty digest weekly — see `digestForOrg`'s docstring in
  `org-posts.ts`.
- `key-scopes.test.ts` (every v1 route classified for API keys) only
  reds under a FULL `apps/web` sweep, not a news-scoped one — the new
  digest route needed an explicit entry. Worth a standing note for
  every session adding a route: run the full suite at least once
  before calling it done, not just the feature's own directory.
- Digest button gated on `news.auto` (same entitlement as the
  system auto-drafts) — a judgment call, not explicit in the prompt;
  reasoning: a digest is system-composed content, same PLG line V295
  already draws between manual (free) and generated (Pro).
- e2e/screenshot mechanics: the MCP Playwright browser was locked by a
  concurrent process this session, so verification screenshots used a
  standalone `playwright-core` script instead (launches its own
  Chromium); hit the `Secure`-cookie-on-`127.0.0.1` trap (browsers
  don't send `Secure` cookies to a bare IP over HTTP, only to the
  literal `localhost` hostname) — worth flagging for any other
  wave-1/2 session doing its own local screenshot verification.
- Deferred per this session's brief: full e2e run (authored, unrun —
  `apps/web/e2e/news.spec.ts`) and the full `scripts/smoke.ts` run
  (extended, syntax-checked, unrun) — both need a live prod-built
  server; orchestrator runs them at the wave boundary.

### Wave 1 outcome (2026-08-13) — PRs #544 (P1) / #545 (P3)

Both lanes green. Nine defects were found that no scout and no spec
predicted; six of them were **invisible to a passing test suite**, which
is the reusable lesson for waves 2–4.

Real defects found, by how they hid:

1. **Inert feature, compiler-proof.** P1's competition guard called
   `toSlotConfig` (never sets `tz`) where `toVerifyConfig` was meant.
   `SlotConfig` is structurally assignable to `VerifyConfig`, so tsc
   could not see it and the guard silently no-opped on every division
   since it was written. The review had filed this as "route lacks test
   coverage"; the missing test was hiding a dead feature, not merely an
   unproven one. See [[reference_verifyconfig_slotconfig_silent_widening]].
2. **Unique index swallows the feature.** `org_posts_auto_once` (V295)
   keys on five fields a weekly digest does not have, so every digest
   after an org's first would have silently no-opped.
3. **Aborted-transaction masking.** A rejected SQL statement aborts the
   whole `withTenant` transaction server-side; a JS `catch` does not
   undo that, so a later unrelated try/catch fails on its own first
   query with "current transaction is aborted", masking its real error
   and risking the draft's own INSERT. Fail-open that has never actually
   caught anything is an untested branch. Fixed with `tx.savepoint()`.
4. **Wrong-at-scale, not wrong-in-the-small.** The digest cron scanned
   every org: fine at 3 orgs, exceeded a 30s timeout at 7,305. Passed in
   isolation, failed only in a full run — and CI runs full. 30005ms →
   2051ms after an indexed pre-filter. The test's failure was a
   **timeout**, which `rtk` had redacted to `STACK_TRACE_ERROR`.
5. **Contract bloat.** `capacity_report` landed on the shared
   `ERROR_ENVELOPE`: 776 occurrences, both OpenAPI artifacts roughly
   doubled (`v1.json` 74,098 → 166,486 lines).
6. **Three-way name disagreement.** Guard threw `report`; OpenAPI and
   smoke read `capacity_report`. The smoke assertion could never have
   passed, unnoticed only because smoke was authored-not-run.
7. `computeLeaderboardMoves` rolled back one contributor's credit, so
   any 2+ scorer fixture fabricated rank-move claims in published drafts.
8. A new test called `run()` bare and never reached its own assertion.
9. `streak` sat behind the scorers guard, unreachable for forfeits.

Process notes worth carrying forward:

- **Mutation, not argument.** The reviewer hand-derived the arithmetic
  and concluded P1's cited regression test could not catch the
  `declaredConfig` bug. Reverting the line reds that exact test. Derive
  nothing about solver behaviour by hand — mutate and run.
- **Both-ways placement runs earned their keep.** The one persistent red
  (`schedule-solver-telemetry`, `expected 'solver_unavailable' to be
  'infeasible'`) passes with CP-SAT live and also appears on P3, which
  touches no scheduling code — two independent proofs it is
  environmental. The engine coverage gate also went red purely under
  concurrent agent load and was exit 0 on a quiet machine; run gates
  serially before believing a timing red.
- **Agents died to the 600s watchdog five times**, twice losing their
  transcript so they could not be resumed. Long commands must be
  detached-and-polled, and work committed before any long run. Two lanes
  were finished by the orchestrator directly for this reason.
- The `_INDEX.md` conflict recurs every wave: sessions edit it, main
  edits it. Wave 2 onward, sessions should NOT touch this file — the
  orchestrator writes the outcome at the wave boundary.

### Wave 1 CLOSED — merged 2026-08-13

`78c8618f` (P1 / #544, 12 CI checks green) and `51601495` (P3 / #545,
8 green). P3 rebased onto post-P1 main cleanly; all four dictionaries
carry both key families (14 `schedule.capacity.*`, 65 `news.*`/`digest.*`)
at identical counts, and all three drift gates regenerate to zero drift.

**The four e2e defects CI caught after both sessions reported done** are
the most transferable lesson of the wave. Every one was in a spec that
had been authored and typechecked but never executed, and two were
assertions that could not have failed:

- P1's spec navigated to the bare division path, which renders
  **Entrants** — `stage-auto-schedule` is not on it at all. The symptom
  was `toBeEnabled` timing out; the real error was `element(s) not
  found`. It survived review only because an earlier line failed first,
  so those lines had never run once.
- P3's `.first()` wait was **vacuous**: a prior row already satisfied
  it, so it never waited for the new insert and the API read raced the
  server. Passing would have meant nothing. Both digest specs now wait
  on the row count rising by exactly one, which is also retry-proof —
  digests are deliberately not deduped, so a Playwright retry leaves an
  extra draft and trips strict mode.

Ruling for waves 2–4: **a session may not report done on an unrun e2e
spec.** Authoring plus tsc is not evidence. If the session cannot run it,
it says so as a blocker rather than as a deviation, and the orchestrator
runs it before the PR — not after.

Ground truth for a CI-only e2e failure is the run's `playwright-report-*`
artifact: its per-failure ARIA snapshot shows what was actually on the
page, which is how the Entrants-tab diagnosis was settled rather than
guessed.

### Wave 2 CLOSED (2026-08-13) — both merged

**P2 (D3 schedule health) — merged `651c56c3` (PR #547).** Engine
`scheduling/health.ts` (five normative metrics, no composite grade;
`homeAwayAlternation` absent rather than zero for bracket stages),
shared `computeStageHealth`, stage + joint routes, `board/health-panel.tsx`.
e2e 5/5 run by the orchestrator against a real standalone prod server.

**P4 (D1a format templates) — merged `e35efff1` (PR #548).** Five-template
catalog as validated static data (no rows, no migration owns it),
one-transaction `createFromTemplate`, `POST /competitions/from-template`,
wizard step 0, migration **V359** (`competitions.template_key` /
`template_version`, both nullable).

**Eleven findings closed on P4, and the shape of them is the lesson.**
Every one was the template path re-implementing something the manual
create path already owned: format entitlement gates hand-typed twice
(now shared `usecases/format-gates.ts`), quotas unenforced, points rules
unvalidated, and three funnel emitters never fired. All are now *shared
calls*, not second copies. Two of the emitters had no "fires exactly
once" test on the ORIGINAL manual paths either, so
`competitions-activation-events.test.ts` and
`divisions-activation-events.test.ts` cover `createCompetition`,
`patchCompetition` and `createDivision` — they mock the `captureServer`
transport and drive the real usecases, so they are not assertions about
a mock of the thing under test.

**A wave-2 ruling that generalises: a new UI surface is not covered until
it is IN `mobile.spec.ts`.** Three of the four lanes' panels (P1 capacity
card, P2 health panel, P4 template gallery) shipped with no width
enforcement at all — the seven-width sweep visits a division's Entrants,
fixtures, standings and registrations tabs but never `/schedule`, and
never `/c/new`. A new spec file cannot fix it: every width project in
`playwright.config.ts` is `testMatch: /mobile\.spec\.ts/`, so a fresh
`portfolio-ui.spec.ts` runs at desktop only and reports green. Both
additions therefore landed inside `mobile.spec.ts` — four routes on the
sweep plus one test that seeds until each panel actually renders before
measuring, because the sweep's own division has no stage and a page with
no panel cannot overflow because of one.

That test found a real defect on its first run: the template sheet's
submit and cancel buttons measured **38px** against the 44px touch floor
(bare `.btn` is `py-2 text-sm`), under the floor at every width, not just
phones. Fixed with `min-h-11`, matching `components/v2/confirm-dialog.tsx`.

**CI then caught a second real regression the local gate could not.**
Putting the gallery in front of the wizard removed the name field from
`/c/new` until a format is chosen, and three specs still filled it
directly (`competition.spec.ts`, `seo-meta.spec.ts`,
`journey-community.spec.ts`). It read as a wizard bug because the
assertion immediately above the fill kept PASSING — the gallery renders
under the same "New competition" heading — so the 60-second
`locator.fill` timeout pointed at the form rather than at the unmade
choice one step earlier. Shared `startBlankCompetition(page)` now makes
that choice, and is deliberately NOT tolerant of a missing gallery.
**Standing lesson: a change to a page's entry point owes a sweep of every
e2e that drives it**, and text-identical headings are exactly what hides
such a change from a first read.

**One unexplained red, recorded rather than waved off.** `Smoke — DB +
Redis` failed once on `scripts/__tests__/sync-sports.test.ts`, which
skipped every later step in that job. Not reproducible: 3/3 locally,
including with CI's exact step order (`sync:sports` first). P4's diff
touches no sport, engine, registry or sync file, the job was green on
#547, and it went green again on the very next push — a commit touching
only e2e helpers. The job writes its result to a JSON the log never
echoes, so the failure detail was never recoverable. If it recurs, get
that JSON out before calling it flake again.

### Wave 3 — P5 (D4a stage progression) — PR #554, all findings CLOSED

Branch `feat/p5-stage-progression`, migration **V360**. Green on a fresh
database; see "Two reds that are NOT yours" below for the one that is not.

**Both of the prompt's premises were false**, verified against the live
schema rather than the docs:

1. `fixtures.home/away_entrant_id` were ALREADY nullable (V214, comment
   `-- null = TBD/bye`). That migration did not exist as work.
2. A second cross-stage fill path already existed — `seedNextStage` +
   `generateStageFixtures` baked entrants into the INSERT and never
   called `fillSlot`. "One pathway, not two" was a UNIFICATION of
   existing code. Done: the INSERT bakes only when `bakeDirect(g)` =
   `!viaFillSlot || g.award !== undefined`.

**The critical defect, fixed (`8217677d`).** A bye seed owns TWO slots —
`awardLabel` inherits the bye fixture's own `seed` and is then written
onto the winner-feed target — but `destinationSlotsBySeed` read them with
NO `ORDER BY` into a plain `Map.set`. Last write won, arbitrarily;
confirm filled one and stranded the other at TBD **permanently, silently,
reporting success**. Reachable on any non-power-of-two qualifier count —
the design doc's own headline `bestNth` case. Now `Map<number, string[]>`
with `order by id`; confirm fills every sibling. Mutation-verified
31/31 → 29/31.

**All four remaining reviewer findings CLOSED** (`2a751dc1`, `b78ebf91`,
`684747e3`, `3a9c9a51`, `43c3a68f`), each mutation-verified:

1. `bestNth` on unequal pools now throws 422
   `SEEDING_BESTNTH_UNEQUAL_POOLS` instead of ranking raw stats and
   shipping a silently wrong order. 21/21 → 20/21 under mutation.
2. `SEEDING_SLOT_DOUBLE_ASSIGNED` split into three codes —
   `SEEDING_EDIT_UNKNOWN_SLOT`, `SEEDING_SLOT_FOREIGN_FIXTURE`, and the
   real double-assign. 14/14 → 12/14.
3. Stale-marking now fires from `scoring.ts` `onDecided` too, not just
   `overrideStandings`. 15/15 → 14/15.
4. The bye-award bulk UPDATE gained a pre-write guard against stranding a
   `slot_label`. 16/16 → 15/16. Deliberately NOT rerouted through
   `fillSlot`: that is untouched code outside P5's scope.

Disclosed gaps, accepted: the away-side mirror of finding 4 is not
independently mutation-tested, and the new error codes have no i18n
entries — all four `errors.json` are `{}` and the cited
`CAPACITY_IMPOSSIBLE` precedent is not wired either, so this is
consistent rather than skipped.

### Two reds that are NOT yours — check before attributing

Both were settled by BASELINING against `origin/main`, never by argument.

- **`schedule-solver-telemetry.test.ts` "reflow leaves an already-legal
  board untouched"** — `EngineError: schedule change hits a blocking
  conflict` from `assertNoNewBlocking`. Measured **1 red in 3 on plain
  `origin/main`** with a real solver and a fresh DB, and reproduced on a
  PR whose entire diff was `.github/workflows/e2e.yml`. It is main's, it
  is intermittent, and neither a single green nor a single red settles
  it. Its own open item is in the release-2 index.
- **`schedule-reflow-dropped-card-conflict.test.ts`** — reds inside a
  full 7,231-test run, passes **3/3 in isolation on BOTH P5 and main**.
  Load/ordering-sensitive, same family as `repair-scale`.
- The old signature `expected 'solver_unavailable' to be 'infeasible'`
  identifies NOTHING now — C1 rewrote that file, and C2 added the
  `skipIf(!HAS_SOLVER)` the locked-anchor test always needed.

### Two process rules this wave paid for

**1. Fresh database per full DB-backed run.** Not a memory note — it is
in `_RULES.md` §2 now, because it was already recorded and two sessions
reused a database anyway on the same afternoon. A note you have to
remember to recall is not a control. Costs: a lane DB reached **25,427
organisations** and killed `sweepWeeklyDigests` on volume alone; the
other session's failure set moved 5 → a different 5 → 7, which made a
design problem look like a tuning problem and bought three wrong fixes.

**2. Baseline before attributing.** Same command, same DB, same services,
on `origin/main`, before calling any red yours. Every attribution
question this wave was settled that way and none by argument.

### The lesson of the day, and it is not about any one PR

**Five defects shipped or nearly shipped on paths that no test drove, so
CI could only ever have been green:**

- the joint health report kept rendering raw uuids — smoke and e2e both
  type `combined.metrics` as `{key, score}` and never read `offenders`;
- three lanes' UI panels had no width coverage — every width project is
  `testMatch:/mobile\.spec\.ts/`, so a new spec file runs at desktop only;
- a bye seed stranded forever — every test used power-of-two counts;
- C2's acceptance gate ranked on the old tier ladder — found by review
  after 12/12 green;
- a comment claiming a bye "stays scheduled until confirm fills it" when
  confirm might never fill it. A comment that describes behaviour the
  code does not have fails the same way a test that drives nothing does.

Green is evidence about the paths that ARE driven, nothing more. When a
change adds a SHAPE — a new metric kind, a new count parity, a new ladder
rung — ask what test drives that shape before trusting the suite.

### Sequencing for the next session

- **P6 (D4b)** — progression UI, depends on P5 merging.
- **P7 (D1b)** — multi-stage templates. **Owner chose `league-playoff`
  (league → top-4 knockout, seeded from the standings)** over a
  standalone playoff template. It needs `TemplateStage.seeding`, which
  reads `stages.seeding` — P5's V360 — so P7 unblocks the moment P5
  lands. `euro24` and `t20-super8` are P7's too.
- **P8–P10 (D5 venues)** — still gated on the release-2 C-chain.
- **P11 (D6)** — still gated on ScoringPad S13.

### Known-slow e2e, handed to its own session

`board-v3.spec.ts` and `ai-architect.spec.ts` time out in CI (60s and
240s). `Request context disposed` is the SYMPTOM — the test times out and
teardown kills an in-flight fetch. `buildRig` (`board-v3.spec.ts:37`)
builds 5 divisions x 12 entrants through ~25 sequential API round trips
before a single assertion. Both live in shard 1. NOT caused by P5 and NOT
by sharding — they failed the same way before both.

The parallel project is now sharded 3 ways (#559), which bought a
diagnostic property worth knowing: **a red shard whose siblings are green
is a dropped socket or a dead runner, not a broken project.** Two of
three shard-1 failures on #554 were `The runner has received a shutdown
signal`; under the old single job that would have taken all 246 tests red
and told you nothing.

## Wave 4 — P6 merged; P6 follow-ups closed; P7 started then HELD

**P6 (D4b) MERGED `cdcc3bef` (#568), V362.** Stage progression UI:
proposal panel, confirm flow, TBD labels everywhere fixtures render.

**The two follow-ups P6 shipped knowingly were then closed in a separate
session (2026-08-14), on the owner's instruction.** Both turned out
differently from how P6 recorded them, and the difference is the point:

**Follow-up 1 (the two `slot.*` keys with no production reader) was real
and WIDER than recorded.** P6 named `stages.ts`'s `homeFrom`/`awayFrom`
as the missed third path, which was correct. What it did not know is
that `apps/web/src/lib/schedule-board.ts:82-95` **already shipped the
same label as a hand-built English string** — so this was never "an
unused key", it was two parallel paths for one piece of vocabulary, the
live one violating the no-hardcoded-English rule. Worse, the ref it
printed (`R1 #2`) did not match the board card the user has to match it
against (`R1·2`). Fixed by giving both one key and one composition
point, with the params persisted as `{round, seq}` data rather than
rendered text.

**Follow-up 2 (orphaned fixtures) rested on a FALSE PREMISE.** The
recorded hazard — "a fixture orphaned by a rules change stays live" — is
**unreachable**, and this was verified against the code rather than
inferred:

- `replaceStages` (`stages.ts:260-285`) is the ONLY writer that mutates
  a stage's `kind`, `seeding` or structural `config`, and it refuses
  while any fixture exists in the division, under
  `pg_advisory_xact_lock` in the same transaction — so it cannot be
  raced.
- `fixtures.stage_id` is `on delete cascade` (`V214__fixtures.sql:6`),
  so every other rules-edit route is delete-and-recreate and takes the
  fixtures with it.
- `undoDivision`/`redoDivision` have no case that touches `stages` at
  all.

**No detector was built.** Building one would have been building for a
state that cannot occur — the same class of mistake as P6's overturned
blast-radius ruling, inverted. The deliverable is a regression test
pinning the two properties above so whatever makes it unreachable cannot
be deleted silently.

**Two REAL defects were found in its place:**

1. `generateSeededStageFixtures` has no analogue of the plain path's
   `group_too_few_entrants` guard (`stages.ts:985-995`). A `.seeding`
   group stage whose qualifiers cannot fill its pools commits PARTIAL
   fixtures, strands seeds with no slot label, and then every
   `POST /stages/{id}/seed-proposal` 422s `SEEDING_RULES_MISSING`
   telling the user to "regenerate them first" — **advice that cannot
   work**, because generation is idempotent by `ext_key`. Permanent dead
   end; only deleting and recreating the stage escapes. Fixed.
   Note the plain path shares the blind spot (its guard requires
   `gen.length === 0`, so a partial fill passes there too) but does NOT
   dead-end, having no seed→slot map. Left alone deliberately.
2. **`FORMAT_LOCKED` is division-wide with no per-stage predicate**, and
   `patchDivision` (`divisions.ts:556-563`) runs the identical check. So
   generating stage 1's fixtures freezes the rules of every later,
   unplayed stage. `deleteStage` removes only the tail stage. NOT fixed
   — narrowing it touches a shared release-2 surface, past the task's
   blast radius. Pinned by a test and surfaced.

### P7 handover — started 2026-08-14, HELD by the owner mid-session

No P7 code shipped. What the session did produce, and what a resuming
session should NOT re-derive:

- **`page_playoff` IS DB-checked** (`V298__page_playoff_stage_kind.sql`;
  the api-v1 `StageKind` enum's 9 values match the CHECK). The
  format-templates design doc's fallback to `knockout(4)` for
  `league-playoff` is **stale — do not take it**.
- **`StageSeeding` lives at `api-v1/schemas.ts:543-555`**
  (`StageSeedingSchema` / `StageSeedingInput`). Import it. A template's
  `source` cannot be `{stageId: Uuid}` — catalog JSON has no UUIDs.
- **`templates.ts:253-263` does not persist `seeding` at all.** Its
  stage INSERT writes only `(division_id, seq, kind, name, config)`,
  unlike `createStages` (`stages.ts:227-233`). So the gap is at the
  persistence layer too, not only in the zod schema.
- **RULING: instantiation must NOT generate fixtures.** The P07 prompt
  says it should. A `.seeding` stage bypasses the entrant query and
  mints synthetic entrants (`stages.ts:1348-1354`), so unlike a plain
  stage it CAN generate with zero real entrants — and one row would
  format-lock the competition at birth via BOTH `replaceStages` and
  `patchDivision`, leaving the organiser unable to change even the sport
  variant before adding an entrant. Today's code already refuses this
  deliberately, with a comment defending it (`templates.ts:258-262`).
  Keep that invariant; TBD fixtures come from the existing Generate
  action.
- **euro24's real best-thirds rule is a combination lookup table** (15
  permutations of which groups' thirds qualify). `StageSeeding.map` is a
  static `{slot, source}[]` and cannot express it. Map by rank among
  thirds instead, and say so in the catalog entry — do not silently
  approximate, and do not fork the schema.
- **The P07 prompt's verify block runs vitest from the repo root**,
  which yields `Cannot find package '@/...'` and a fake red across
  hundreds of suites. Run it from `apps/web`. Same bug as P06's block.

Full T1–T5 briefs, with the re-pinned citations, are committed at
`docs/superpowers/plans/2026-08-14-p7-handover-briefs.md`, beside the
session plan `2026-08-14-p7-multi-stage-templates-plan.md`. They are in
`docs/` deliberately: `.superpowers/` is gitignored (`.gitignore:52`), so
a handover left in the SDD workspace dies with the worktree.

**Also note, for the T5 e2e brief:** `.github/workflows/e2e.yml` went LIVE
on pull requests on 2026-08-14. Every brief written before that date —
including T5 — says it is disabled and must never be enabled. That is now
false; six Playwright jobs run per PR, including the seven-width matrix.
