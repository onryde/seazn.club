# P9 (D5b) — venues & courts: scheduler integration + stored-config migration

Branch `p9-venues-scheduler` (worktree). Started 2026-08-17 on `c2cb1f3fb`
(P8 merged). Env label `p9sched`: Postgres :54842, placement :50368.

**Owner ruling at session start:** scope item 4 ("every `court_label`
reader switched") is a **full spec-literal cutover** — all 177 source
files, writers stop touching `court_label`, display labels derived. The
narrower config-only option was offered and declined. Sequenced as five
passes, each with its own gate, rather than one big-bang diff.

## Baseline before any edit

- apps/web `src/server`: 3168 total / 3127 passed / **4 failed** —
  `schedule-build-honours-locks`, pre-existing, matches P8's close.
- The prompt's "verbatim" verify command runs vitest from the REPO ROOT
  and collected **295 failed suites** on `server-only` / `@/lib/db`
  resolution. Gates in this session run per workspace instead.

## False premises found (as discovered)

1. **`build.ts` does not map court strings → solver indices.** The prompt
   and spec both say it does. It is `placement-client.ts:596-599` —
   `courtNames: [...input.courts]`, array POSITION is the wire index,
   duplicates collapse to first (`:459-468`). `build.ts` only passes
   `config.courts` verbatim (`:1903`) and calls the private
   `restrictToConfiguredCourts` (`:2393`, two call sites).
2. **`usableWindows` does not exist.** `_RULES.md` §3 and `_INDEX.md`
   describe it as the function that already makes the placer/verifier
   fork impossible. Repo-wide it has zero hits outside docs. Three
   separate window computations exist instead: `build-grid.ts:109
   admits()` (placer), the verifier's checks inside engine `calendar.ts`,
   and `apps/web/src/lib/capacity-input.ts:141 usableWindowsFor()`.

   **Correction, from the P9.5 inventory** — "three implementations that
   drift" was itself about to become a false premise, written by this
   session. They do NOT disagree: all three import the same
   `intervalsOverlap` (`calendar.ts:379-382`), use the same half-open
   boundaries, treat an unset blackout `court` as global, and read empty
   `sessionWindows` as unrestricted (`capacity-input.ts:139` says so in
   its own comment). Verified divergence-by-divergence, not assumed.

   The real fork is narrower and worse: **`admits()` omits two
   constraints the verifier enforces** — the competition pack window
   (`config.window`, `calendar.ts:1467-1474`) and per-target start
   windows (`startWindowFor`, `:1399-1414`, applied `:1476-1483`). The
   lattice therefore offers slots as legal that `validateAssignments`
   rejects as `outside_competition_window` or start-window violations.
   This is independent of P9 and predates it.
3. **`capacity.no_matching_court` is the wrong shape.** Typed codes in
   this repo are ALL_CAPS_SNAKE — settled at `schemas.ts:3134-3138`,
   precedent `CAPACITY_IMPOSSIBLE_CODE` (`capacity-guard.ts:32`). Same
   class of error as P8's `court.in_use`. P9 ships `NO_MATCHING_COURT`.
4. **There is no `tournaments` table.** Amendment A5 owed P9 "the
   competition free-text `venue` switch" and the spec cites V109
   `tournaments.venue`. The v1→v2 cutover dropped the table; `competitions`
   has no venue or location column. The surviving free-text venue is
   `fixtures.venue` (V214, sibling of `court_label`), so that is what P9
   switches, via a new `fixtures.venue_id`.
5. **`validateAssignments` never receives a court list** (`calendar.ts:1417`).
   Court double-booking is pairwise over `Assignment.court` values only, so
   candidate awareness on the verify side is new plumbing, not a refactor —
   precisely where a fork would be born.

## Rulings made this session (do not re-derive)

- Candidate order = position in the stored `config.courts` array after
  filtering, dedupe first-wins. Ids are opaque; ordering is never derived
  by sorting ids.
- Required tags = `divisions.required_court_tags` ∪
  `stages.required_court_tags`; a court qualifies iff `tags ⊇ required`.
- Archived venues/courts leave the candidate set, but an existing
  assignment on an archived court still validates clean — archiving must
  not retroactively red a board.
- One pure engine candidate function, called by both the build-input
  assembly and the validate path.
- Pass 1 dropped `.min(1)` and the `["Court 1"]` default from
  `ScheduleConfig.courts`. An empty court set therefore hits the same
  typed 422 as a tag filter that matches nothing — never a silent
  zero-slot lattice.

## The fork this session actually found (pass-2 review, blocker)

`validateAssignments` (`calendar.ts:1417`) never reads `config.courts` —
its only reader in that file is `slotFixtures` (`:833`), which the validate
path never calls. So pass 2's validate-side `resolveCandidateCourts` fetched,
filtered and logged with **zero** effect on validate's output, and the test
that was supposed to prove the wiring passes identically with the production
change reverted. Same "computed, never consulted" shape as the
`candidateCourtIds` field removed one round earlier — twice in two rounds.

Deleting the plumbing would have been the wrong fix. The placer restricts
placement to tag-matching courts; a fixture dragged by hand onto an untagged
court then validates clean. **That is the placer/verifier fork, live, in the
very constraint P9 introduced.** So the verify side gets a real consumer — a
`court_tag_mismatch` conflict keyed on court_id, resolved through the same
`candidate-courts` function the placer uses.

Archived courts stay CLEAN on validate (ruling 3 stands): "the court is gone"
is a stranded-fixture case, which P10 owes and which needs `usableWindows`.
"The court violates a declared constraint" is a P9 conflict. The two are
different situations and get different mechanisms — the same shape as
amendment A3's delete-vs-archive-vs-exception split.

**A THIRD placer path exists**: `schedule-ai.ts:1082` builds `courts` from
raw `guardedSettings.config.courts`, bypassing the shared filter entirely, so
an AI draft can place on an archived or tag-mismatched court. Pass 3b owns it
as required scope.

## Cutover debt ledger (pass-3a review, FIX-FIRST)

Pass 3a's own files reviewed clean. What follows is the front half of the
cutover having landed while live callers still speak the old shape. This
ships as ONE PR, so every row must close before merge. Assigned, not
optional:

| Site | Breaks how | Owner |
|---|---|---|
| `board/ai-competition-console.tsx:335-337,887` | builds apply-assignments with `court_label`; `ApplyScheduleRequest` item is now `.strict()` + requires `court_id` → joint AI-apply POSTs 400 | 3b |
| `board/ai-console.tsx:107,128,275,645,694,802,1519`, `ai-diff.ts:15,65`, `ai-diff-panel.tsx:71-73` | AI console family typed/keyed on `court_label`; `scope.courts.includes(f.court_label)` can never match | 3b |
| `app/score/[token]/page.tsx:64,77,152` | live scoring page SELECTs abandoned `venue`/`court_label` → blank court/venue for any fixture touched after this pass | 3c |
| `usecases/stages.ts:98,122,126-143` (`FixtureRow`/`FIXTURE_COLS`) → `fixtures.ts:9,21-93` (`PatchedFixtureOut`) | GET/PATCH `/fixtures/{id}` has NO `court_id` field at all — blind, not stale | 3c |
| `calendar.ics/route.ts:51`, `fixtures/[fixtureId]/page.tsx:126`, `app/me/page.tsx:160`, `app/my-matches/page.tsx:122`, `components/me/officiating-lane.tsx:142,277` | six user-facing renders of the abandoned columns | 3c |
| `usecases/stages.ts:2705-2765` (`addFixture`) | still ACCEPTS and INSERTs free-text `venue` — a writer "writers stop writing venue" never reached | 3c |

## Passes

| # | Scope | State |
|---|---|---|
| 1 | V368 data migration + `courts: z.array(CourtId)` + `fixtures.venue_id` | DONE — `b9b9444ac`, `700a07845`, review fixes `c2a3fdda2`; 10/10 re-verified on a fresh DB |
| 2 | Shared candidate filter, id→index, `NO_MATCHING_COURT`, byte-equivalence golden | code DONE — `54887f7d6`, `9a27cb282`, `366c3643e`, `9b01e070e` (engine 16/16, web 6/6, tsc 0/0); review verdict FIX-FIRST, see below |
| 2c | Validate-side consumer + review fixes | queued behind 3a (shares `schedule.ts`) |
| 3 | Server reader/writer cutover + OpenAPI regen | pending |
| 4 | UI cutover (court multi-picker, venue picker, stage tags) + i18n ×4 | pending |
| 5 | e2e / smoke / demo fixtures / snapshots, both-ways gate | pending |

## The cutover's sharpest trap: a field whose MEANING changed, not its name

`fixtures.court_label` → `court_id` was mechanical. What was not mechanical:
code that had been written against the *properties* of the old value and
silently inherited the new one.

- **`schedule-ai.ts` `byAssignment` (~:574)** tie-breaks a sort with
  `cmp(a.court_label, b.court_label)`. Pre-cutover that field held a stable
  organiser string ("Court 1"); post-cutover it holds a per-seed UUID. Two
  draft entries at the same `scheduled_at` on different courts therefore
  sorted in **coin-flip order** — the isolated test, rerun 4× with zero code
  changes, gave 2 passes / 2 failures. It feeds the model payload and the
  byte-identity snapshots. A 50%-flaky test proves nothing on one green run;
  the fix's acceptance criterion was ≥5 consecutive runs, not one.
- Same root cause, different shape: the **court-removal guard** compared a
  uuid against `court_label` and so never matched; **`scopeLocked`** matched
  a column writers had abandoned; **`unplaced()`** in
  `competition-schedule-restore.test.ts` became vacuously true.

Four defects, one mechanism, none visible to a passing suite. Any future
column-meaning change in this repo should budget for a deliberate sweep of
*comparators and sort keys* touching the field, not just its readers.

## Environment faults that produced false signals this session

Both cost real time and both looked exactly like code defects:

1. **V371 did not apply AT ALL** on a fresh DB (42P01: comma-`FROM` mixed
   with an explicit `LEFT JOIN` referencing the target alias). Hidden because
   agents are barred from `db:apply` (600s watchdog) while the orchestrator's
   gate runs reused a database still holding the pre-`locked_scopes` V371 —
   a stale-schema green on both sides. Re-apply from scratch after ANY
   migration edit.
2. **A hardcoded placement secret reads as `solver_unavailable`.** The
   secret is PER LABEL (`local-p9v2-secret`, not `dev-secret`). With the
   wrong one, 4 lock tests + 6 solver tests fail in ways indistinguishable
   from a solver regression. Always take both vars from
   `seazn-env env --label <l>`; never hand-set them.

## Two more measurement traps (P9, orchestrator-side)

3. **A parallel vitest run over the DB-backed suites returns a MOVING
   failure set.** Gate 7 reported 2 failures (both real); gate 8, on a diff
   that touched only export/read paths, reported 6 — in billing,
   stage-progression, start-gate, reflow and quote-mismatch, none of which
   the diff touches, with `suitesFailed: 12` against 6 failed tests and the
   total dropping by 9 (i.e. suites that never collected). Re-run in
   isolation: **27/27 green, unredacted**. These suites share one schema and
   vitest runs files in parallel. Any number quoted from a parallel run is
   provisional; the wave-boundary gate runs with file parallelism disabled.
4. **`rtk` redacts real assertions as `STACK_TRACE_ERROR` inside the JSON
   report**, and the hook rewrites a plain `npx vitest` invocation, so the
   redaction applies even when you did not type `rtk`. Diagnosing a failure
   needs `rtk proxy npx vitest … --reporter=verbose`.
5. **The Bash tool caps at 10 minutes.** A full `src/server` gate exceeds
   that and is KILLED mid-run — which looks like a hang, not a cap. Run it
   with `run_in_background: true` and have the command write its own
   `EXIT=$?` to a file, because a killed background command reports 0.
