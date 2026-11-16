# W5 Round-Robin — Engine PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-11-16** against engine `onryde/seazn.club.engine` origin/main **9.0.0 (2cd842a)** and seazn.club
> origin/main 97b184e2d9. Binding inputs: the W5 revision decisions sheet (2026-11-16) and its two audits
> (engine-plan audit, leftovers audit). Where this plan and the design differ, the decisions sheet won. Every engine pin
> below reads `file:line (engine 2cd842a)` unless marked otherwise; every app pin reads `(pinned 2026-11-16 @97b184e2d9)`.

**Goal:** Ship the W5 round-robin seams that genuinely do not exist in `@onryde/seazn-engine` 9.0.0: an order-free
round-robin line identity, a catch-up fixture set for a late entrant, pool membership as seating with a floor of two,
up-front rank-lock validation, best-Nth across unequal pools with k = size − min (always on, ruling 286), a
pool-separating first-round draw, frozen qualification markers, and points adjustments with a reason. Prove the
behaviours that already exist (legs, byes, the 50 percent withdrawal decision) under W5's rule ids. Release the rule
rows alone as **9.1.0** first (Task 0b; a standalone seazn.club "W5 rows bump" PR brings them into the app before app
PR A starts), then the code as **the next engine major at release time (10.0.0 today; re-check `CHANGELOG.md` at T10)**.
"10.0.0" below always means that release; app PR B bumps to whatever T10 released.

**Architecture:** Additions only where the engine lacks a seam; existing shapes are extended, never rebuilt.
`src/scheduling/roundrobin.ts` gains `roundRobinLineKey` (legs and byes already ship); a new
`src/scheduling/catch-up.ts` holds `lateEntryFixtures`; `src/competition/stage.ts`'s `completeTableStage` reads a
caller-supplied seating map, validates the pool floor, rank locks and adjustments before folding; `progression.ts`'s
`normalisedRow` generalises from k = 1 to k = effective size − min and the unequal-pools refusal goes; `bracket.ts`
gains `crossPoolDraw` beside the unchanged `crossPoolSeedOrder`, taking the destination's stored draw seed for rank
ties (ruling 281, RB5-D3); `qualification.ts`'s `QualStatus` gains
`{ kind: "qualified" }` with an explicit order source. Competition never value-imports scheduling (boundary).

**Tech Stack:** TypeScript (typescript-native 7.0.2), vitest 4, fast-check 3, zod 4, pnpm 10, changesets. Engine repo
`onryde/seazn.club.engine`, base origin/main 9.0.0 (2cd842a).

**Spec:** `docs/superpowers/specs/2026-11-05-format-matrix-w5-round-robin-design.md` (§4.1–§4.3, §5.1–§5.3,
§6.1–§6.3, §12), read with `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W5-round-robin.md` and
`_INDEX-w5-additions.md` (rulings 276–285, plus rulings 286–290 of 2026-11-16: 286 "unequal-pool normalisation is
always on", 287–290 the REC answers). Engine rules: `AGENTS.md` (origin/main): Tests, Releasing, the `Matrix rows:` line.

> **Model policy (owner, 2026-11-16), quoted exactly:** "Sonnet High for Task/Reviewer, Opus for Engine work / Batch /
> Whole Review. Use Opus wisely". This plan is engine work, so:
> - **Implementer** of every engine-code task (T1–T8) and of T9/T10 (engine-repo edits) runs on **Opus**.
> - **Per-task reviewer** runs on **Sonnet, high effort**, except a task whose correctness is subtle engine logic, which
>   gets an **Opus** reviewer: T2 (catch-up placement and tie-break), T3 (seating and validators before the fold), T5
>   (k = size − min, refusal order), T6 (the separating search and the seeded tie order).
> - **Batch reviews** (end of B1, B2–B4, B5–B6) and the **whole-PR review** before T10 Step 4 run on **Opus**.
> - **Docs-only tasks** run on **Sonnet, high effort**, for both the implementer and the reviewer: T0 (the rows PR) and
>   T0b (the 9.1.0 rows-only release).
> Each task heading below carries its line. This replaces any earlier model wording; never override `model:` beyond
> what this policy names.

### Revision 2026-11-16 (what changed from the 11-06 version)

- Base was "after W4's 4.0.0"; W4 shipped as 5.0.0 and main is 9.0.0. Target was 4.1.0 (else 5.0.0); it is now
  **10.0.0**, major by the 5.0.0 precedent (a new union member and changed refusals are breaking).
- Task map, old → new: T0 → T0 (+ REC-7/REC-8 amendments, app-side half, X-BL → X-BD); T1 + T3 → **T1**
  (`roundRobinLineKey` only; legs, byes and the n < 2 empty schedule already ship and are proved, not rebuilt; no legs
  guard, no throw at n < 2); T2 + T3's late sweep → **T2** (a..f owes 6, odd-n late cases are 33); T4 + T5 → **T3**;
  T6 → **T4** (test-only proofs + additive counts); T7 + T8 → **T5** (generalise `normalisedRow`, no new module, no
  `SourceShape.poolSizes`); T9 + T10 → **T6** (`crossPoolDraw` in bracket.ts, no `pool-draw.ts`, no rngSeed (superseded by fix round 1 F3: the stored draw seed is an argument), byes as
  null slots); T11 → **T7** (`{ kind: "qualified" }` on the real object union, explicit order); T12 → **T8**
  (rescoped: no `applyPointsRule`, no points metric); T13 → **T9**; T14 → **T10** (major, changeset).
- Every pin re-taken at engine 2cd842a; the app-side `AWAITING_PROOF` map and the W2b text pin added to T0/T9.

### Fix round 1 (2026-11-16, review-consistency + review-verify; decisions sheet F1–F17)

- **F1 sequencing:** new **Task 0b** cuts a rows-only **9.1.0** right after T0 merges (the W4 precedent: the engine rows
  reached the app by a snapshot bump, #1146, before W4's app PR A). App PR A's Task 0 bumps to `^9.1.0` and lands the
  app half of T0 (**fix round 2, G6: moved to the standalone W5 rows bump PR, app plan A Task R**). No step deletes an app `AWAITING_PROOF` entry before the release that carries its proof: B's bump to
  10.0.0 deletes the engine-PR and app-PR-A entries, and B's close-out bump (10.0.x, T10 Step 5) deletes the last 3.
  T10 is 10.0.0.
- **F2 ids:** the canonical id table (T0) is final: 74 rows, 74 entries (34 engine + 37 app A + 3 app B), no ⬜. Added X-WDT-9 ← RB5-W10, X-PO-4 ← RB5-P7, X-RR-6 ← G6 (ruling 287) and X-WDT-10 ← W11
  (ruling 289); X-RR-4 is G1's legs clause only. Each row has a "proved by" column.
- **Owner rulings 2026-11-16 (after the reviews):** **287** `triple_rr` is deleted (owner: "in prod, no triple_rr, so
  blindly cleanup, delete it"); by the coordinator's reading of its scope (designer's call, fix round 2) the engine's
  `legs` input stays generic and the deletion is the app's (X-RR-6, app PR A). **288** confirms REC-2,
  REC-3, REC-4, REC-5, REC-6, REC-9, REC-10, REC-11 (RB5-T15's "no points metric" clause dropped), REC-12 (the A1/B1/B2
  refusal kept) and F1 (the rows-only 9.1.0 release). **289** confirms REC-7 with a condition: the Disqualify action
  shows its consequence first (X-WDT-10). **290** confirms REC-8 option A: badminton and tennis follow ruling 277;
  BD-WO-2 and BD-RT-1 drop "until W5" as a permanent recorded deviation from BWF GCR 16.2.5; no sport-specific
  withdrawal code; TN-WD-1 is dropped (tennis does not differ). No REC gate remains.
- **F3 draw seed:** ruling 281 governs. `crossPoolDraw` takes the stored draw seed and orders tied runs inside a tier
  with `shuffle(drawSeed, …)` (`core/rng.ts`) before the search. REC-2 (X-PD-8) is narrowed to where 281 does not
  decide: a best-Nth basis tie.
- **F4 results:** T5 names the five `progression.test.ts` tests that change and their new expected values;
  `rowAtRank` runs before the missing-results check; the "seats can move" app claim is dropped (the app passes no
  `results` today, so nothing moves; app PR A starts passing them — **moved to app PR B by fix round 2, G4**).
  `PoolTable.expunged`'s producer is named (app PR B, both `SourceTables` builders).
- **F5** catch-up ties on the earliest round break by the members' listed (seed) order, with a test where that differs
  from id order. **F9** an unseated entrant is refused only when a result names it. **F13** every REC is answered
  (rulings 287–290), so no row is ⬜ and no step is REC-gated. **F14** app PR A consumes nothing new from the engine; the consumers of `roundRobinLineKey` and the
  withdrawal counts are app PR B. **F16** Review Focus 1's refusal is kept (REC-12, signed 288). Review-verify E-7..E-14 applied (T1 Step 2's
  expectation, `fold-epoch:check --against`, CHANGELOG :104, the expunge wording, `competition-2`, the brute force's
  restriction, `pnpm boundary`).

### Fix round 2 (2026-11-16, review-2; decisions sheet G1–G8)

- **287 wording (correction):** the owner's words for ruling 287 are only "in prod, no triple_rr, so blindly cleanup,
  delete it". The earlier gloss "API create refuses legs:3" is withdrawn. "`legs` 1–8 stays" is RB5-G1 as signed under
  ruling 285, kept by the coordinator's reading of 287's scope (designer's call), never 287's own text (X-RR-6 row).
- **G1 X-PD-8:** no "21 harness cases" and no "count = 21". X-PD-8 is proved in app PR A by a constructed enumeration
  test over every template row that HAS a best-Nth take (row set derived from `STAGE_TEMPLATES` / the engine's `TakeRule`
  declarations, anti-vacuity count > 0). The `_INDEX.md:4594-4601` harness cases are re-judged by row in app PR A's
  matrix task; those on rows without best-Nth (`league_ko`, `group_playoffs`, `group_stepladder`) are confirm-time table
  ties under the existing tie-break ladder (design §9), no new rule.
- **G2 X-RT-1:** app PR A titles its DQ-cascade app test `X-RT-1 …` and hands X-RT-1 over; T9 Step 2 appends that path.
- **G3 `tied`:** `PooledSeed.tied` has a precise input contract (Interfaces): equal on the cross-pool comparison, never
  `ResolvedProgressionEntry.tieUnbroken`. For best_nth tiers the engine's own ranking supplies it as the new
  `ComparisonBasis.levelWith` (T5); for group_rank tiers app PR B ranks the tier with `crossGroupOrder`. A `tied` link
  on a tier's first seed is refused (`tie_link_invalid`). Designer's calls: unequal `played` is never level; only
  adjacent seeds link.
- **G4 no 9.x window:** pool `results` are passed by app PR B in the same commit as its bump, so results and the
  always-on engine land together; app PR A passes nothing new and 9.x behaviour is unchanged until then. The earlier
  "interim window / A pins it" text is removed.
- **G5:** `triple_rr` is a detected template, never stored (app `lib/format-templates.ts:404`); its deletion owes no
  migration and no data cleanup (X-RR-6 row).
- **G6:** the `^9.1.0` bump, the 74 app `AWAITING_PROOF` entries and the three `AMENDED_TEXT` edits ride a standalone
  seazn.club "W5 rows bump" PR (#1146's shape) merged before app PR A starts (Gate 2b). W5's code release is "the next
  engine major at release time".
- **G8 minors:** T0 Step 4 says 74 rows; rulings cited as 276–290; T9's gate searches by branch; T10 Step 5 appends a
  B path only to a row whose id a B test title holds.

## Status by batch

| Batch | Tasks | Rule ids proved (engine `AWAITING_PROOF` entries deleted) | Status |
|---|---|---|---|
| B0 Rows (engine docs PR; app half rides the standalone seazn.club W5 rows bump PR, G6) | T0 | — (records 74 W5 rows and 4 amendments; proves none) | ⏳ |
| B0r Rows-only release 9.1.0 | T0b | — (ships the rows so the W5 rows bump PR can bump the app to `^9.1.0` before app PR A) | ⏳ |
| B1 Generation and catch-up | T1, T2 | X-RR-1, X-RR-2, X-RR-3, X-RR-4, X-RR-5, X-CU-1, X-CU-2, X-CU-3, X-CU-4, X-CU-5 (10) | ⏳ |
| B2 Pools | T3 | X-PO-1, X-PO-2, X-PO-3 (3) | ⏳ |
| B3 Withdrawal proofs | T4 | X-WDT-1, X-WDT-2, X-WDT-3, X-WDT-4, X-WDT-6 (5) | ⏳ |
| B4 Unequal pools | T5 | X-UP-1, X-UP-2, X-UP-3, X-UP-4, X-UP-5 (5) | ⏳ |
| B5 Cross-pool draw | T6 | X-PD-1, X-PD-2, X-PD-3, X-PD-4, X-PD-5, X-PD-6, X-PD-7 (7) | ⏳ |
| B6 Table markers and adjustments | T7, T8 | X-QS-1, X-ADJ-1, X-ADJ-2, X-ADJ-3 (4) | ⏳ |
| B7 App PR A close-out (GATED on app PR A merged) | T9 | the 37 `"W5 app PR A"` rows | ⏳ |
| B8 Open the engine PR, release the next major (10.0.0 today) | T10 | — (asserts zero `"W5 engine PR"` and zero `"W5 app PR A"` entries; the 3 `"W5 app PR B"` remain) | ⏳ |

Engine-PR total **34** ids = 10 + 3 + 5 + 5 + 7 + 4, exactly the 34 `"W5 engine PR"` entries T0 writes. Rows recorded
by T0: 34 engine + 37 app A + 3 app B = **74**; `AWAITING_PROOF` entries = **74** (every row has one).

## Global Constraints

- **Gates.** Gate 1 (before T0): engine origin/main is 9.x with no W5 code:
  `git -C ~/github/seazn.club.engine show origin/main:CHANGELOG.md | sed -n 3p` prints `## 9.` and
  `git -C ~/github/seazn.club.engine grep -n "roundRobinLineKey\|lateEntryFixtures\|crossPoolDraw\|validateRankLocks" origin/main -- src`
  is empty. Gate 2 (before T1): the B0 rows PR is merged (`git show origin/main:rules/cross-sport.md | grep -c "^| X-RR-1 "`
  is 1). Gate 2b (before app PR A starts; orchestrator): 9.1.0 is published (`npm view @onryde/seazn-engine@9.1.0 version`
  prints `9.1.0`) AND the seazn.club W5 rows bump PR is merged to main (`git show origin/main:apps/web/package.json | grep -c
  "seazn-engine@^$ROWS_VER"` is 1, `$ROWS_VER` = the version this Step 2 hands back, 9.1.0 unless taken; G6). Gate 3 (T9 only): app PR A merged. Gate 4 (REC gating, F13): none remains — owner rulings
  287–290 (2026-11-16) answered every REC; a REC raised later is gated the same way ("build only after the owner
  confirms"). A failed gate stops the task and hands back.
- **Tree.** `git -C ~/github/seazn.club.engine fetch && git -C ~/github/seazn.club.engine worktree add ~/github/seazn.club.engine-worktrees/w5-round-robin-engine -b feat/w5-round-robin-engine origin/main`,
  then `pnpm install --frozen-lockfile` there. `WT=~/github/seazn.club.engine-worktrees/w5-round-robin-engine`. Prefix
  every command `cd "$WT" &&` in the same call. Never edit the engine's main checkout (it is on another branch) or
  `~/github/seazn.club` at all (the app half of T0 is the W5 rows bump PR's edit; T9 Step 6 only hands a list over). Never
  `git stash`.
- **Scratch.** `OUT=<session scratchpad>/<agent-name>/`; never `rm` a shared directory.
- **Scoped tests only** (AGENTS.md Tests; owner rule): never `pnpm test`, `test:coverage`, `pnpm sim`, `sim:matrix`. The verify command:
  ```
  cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/<task>.json" <paths>; echo "EXIT=$?"
  node -e 'const r=require(process.argv[1]);console.log(`${r.numPassedTests}/${r.numTotalTests} failedSuites=${r.numFailedTestSuites}`);for(const t of r.testResults)console.log(t.name)' "$OUT/<task>.json"
  ```
  Green = `EXIT=0`, passed = total > 0, `failedSuites=0`, every name under `$WT`. Never add `--testTimeout`. Read
  `rtk` output through `rtk proxy`.
- **Type and lint, every task:** `cd "$WT" && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo "EXIT=$?"`
  and `cd "$WT" && rtk proxy pnpm exec eslint --max-warnings 0 <changed files>; echo "EXIT=$?"`.
  `cd "$WT" && pnpm boundary; echo "EXIT=$?"` whenever a file gains an import: T2 (catch-up.ts imports roundrobin.ts),
  T5 (none expected; run anyway, it edits the progression import block), T6 (bracket.ts imports `shuffle` from
  `core/rng.ts`, an allowed scheduling → core edge, as `repair-synthetic-board.ts` does), T8 (stage.ts widens its
  existing `./points.ts` import, stage.ts:11).
- **Expected values** come from the rulebook or the engine's own declarations (the circle method's published table,
  `seedPositions`, `tablePointsRule`), never from the code under test; each pinned number carries a one-line derivation
  comment (`// RB5-U1: 5-pool runner-up compared on 3`). Each task has at least one `// differential: today X` case
  whose "today" was confirmed by reading the cited line at 2cd842a (the plan names it).
- **Anti-vacuity.** Every property and sweep counts what it checked and asserts the exact count; zero is a failure. The
  empty case is each rule set's first test.
- **Mutate every new guard once,** by hand, one at a time; a named test must red; restore. Commit body line:
  `mutation: <guard> → <test name> red`.
- **Sequence tests, every task:** a second call, an empty input, after a withdrawal or void, another sport. Scheduling
  and progression code reads no sport module; such a test carries
  `// single-sport: round-robin code is sport-agnostic (reads no SportModule)` and
  `cd "$WT" && pnpm single-sport --check --against origin/main` stays green. T8 sweeps `forEachSport`
  (`src/testkit/for-each-sport.ts:57`, returns the count).
- **Stryker homes.** Every new non-test `src/` file needs a leg in `stryker.groups.mjs` or `test/stryker-groups.test.ts`
  reds. The only new file is `src/scheduling/catch-up.ts` → leg `draws-1` (`stryker.groups.mjs:123`). Edited legs
  (`draws-1`, `draws-3` :127, `competition-2` :88 (the glob that homes `points.ts`, which T8 edits),
  `competition-3`/`-4` :90/:92 around the progression.ts cut at :34, `competition-5` :94)
  may drift > 10 % in `test/stryker-sizing.test.ts`: a warning on PR CI, a failure only on the weekly strict run, so
  T10's PR body names them for a re-measure in the 01:00–06:00 window (AGENTS.md Tests).
- **Rule rows.** A proving commit, in ONE commit: deletes the id from `test/rules-reference.ts` `AWAITING_PROOF`
  (:55-67), fills `proved by` with every test file whose `it(`/`describe(` title holds the id as a whole token, fills
  `enforced at`, and drops the citation's `; not yet implemented (W5 engine PR)`. Paths are written `packages/engine/...`
  (`ENGINE_ROW_PREFIX`, :73). The checker refuses an awaiting row that claims proof
  (`test/rules-reference.test.ts:118-121`) and a stale entry (:303-306). Never allocate an id after T0.
- **Rulings** 276–290 only; a call this plan makes is marked "(plan's call)" and listed in the PR body.
- **Changesets:** T0's `.changeset/w5-rule-rows.md` (**minor**, rows only, released as 9.1.0 by T0b) and T10's
  `.changeset/w5-round-robin-engine.md` (**major**: the next major at release time, 10.0.0 today). `cd "$WT" && pnpm fold-epoch:check --against origin/main`
  must report no epoch move (no task touches a fold; `scripts/fold-epoch-guard.ts:74` requires `--against`).
- **Commits:** conventional, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only where a
  step says so.

## Interfaces — exact signatures (app PR B copies this block verbatim)

Exact shapes at engine 2cd842a (EXISTING), then the exact additions in 10.0.0 (NEW / CHANGED). **App PR A consumes
nothing new from the engine:** it runs on `^9.1.0`, which is 9.0.0's code plus the W5 rule rows (Task 0b), and computes
its catch-up placement, its line key and its withdrawal counts app-side. Every NEW or CHANGED item below is consumed by
**app PR B** (after `^10.0.0`), which names the B task beside each consumer line. A task that changes a signature here
updates this block in the same commit.

```ts
// ── @seazn/engine/scheduling — roundrobin.ts (EXISTING, unchanged)
interface RoundRobinOptions { entrants: readonly EntrantId[]; seeds?: ReadonlyMap<EntrantId, number>;
  config?: { legs?: number }; rngSeed?: number }                                  // roundrobin.ts:24-37
interface RoundRobinFixture { id: string /* `rr-r{roundNo}-c{court}`, NOT an identity */; roundNo: number /* continuous
  across legs */; leg: number /* 1-based */; court: number; home: EntrantId; away: EntrantId }   // roundrobin.ts:39-46
interface RoundRobinRound { roundNo: number; leg: number; fixtures: RoundRobinFixture[]; bye?: EntrantId } // :48-53
interface RoundRobinSchedule { rounds: RoundRobinRound[]; fixtures: RoundRobinFixture[] }        // :55-58
function generateRoundRobin(opts: RoundRobinOptions): RoundRobinSchedule;                         // :85-157
//   n < 2 → { rounds: [], fixtures: [] } (:90, KEPT; the named refusal is the app's, X-BD-5); legs absent → 1 (:87);
//   even legs mirror (:136); odd field: rounds[].bye (:126-129, emitted :152). No legs bound in the engine (the app's
//   schema caps 8). A flat byes list is a derived view of rounds[].bye; none is added.

// NEW (T1). Consumer: app PR B Task 3 pins app PR A's app-side `rrKey` against it (same string for every pair and leg).
export function roundRobinLineKey(a: EntrantId, b: EntrantId, leg: number): string;
//   `rr:${lo}:${hi}:L${leg}`, lo/hi = a, b in code-unit order (`a < b ? a : b`): order-free, independent of roundNo and
//   court. a === b, or leg not an integer ≥ 1 → EngineError("CONFIG_INVALID", { reason: "line_key_invalid" }).

// ── @seazn/engine/scheduling — catch-up.ts (NEW, T2; re-exported from scheduling/index.ts beside roundrobin :29)
// Consumer: app PR B Task 3 swaps app PR A's app-side placement for it, with a parity test.
export interface ExistingLine { home: EntrantId; away: EntrantId; roundNo: number; leg: number }
export interface ByeSlot { entrantId: EntrantId; roundNo: number; leg: number; started: boolean } // started = the caller's K4 predicate
export type CatchUpPlacement = { kind: "bye_slot"; roundNo: number } | { kind: "catch_up_round"; roundNo: number };
export interface CatchUpFixture { home: EntrantId; away: EntrantId; leg: number; placement: CatchUpPlacement }
export interface CatchUpResult { fixtures: CatchUpFixture[]; consumedByes: ByeSlot[]; appendedRounds: number }
export function lateEntryFixtures(input: { members: readonly EntrantId[] /* in listed (seed) order */;
  newcomer: EntrantId; legs: number; lines: readonly ExistingLine[]; byes: readonly ByeSlot[];
  lastRoundNo: number }): CatchUpResult;
//   owed = {(newcomer, m, leg) : m ∈ members, leg ∈ 1..legs} minus lines already present for that key.
//   Owed key with an unstarted bye slot of m at that leg → bye_slot at its roundNo (slot consumed). Every other owed key
//   → catch_up_round at lastRoundNo + k, k = 1, 2, …, ordered by m's earliest roundNo among `lines`, ties by m's
//   position in `members` (listed/seed order, F5); a member with no line comes last, in `members` order; then leg.
//   Home side: per leg the newcomer alternates along that leg's owed list (first away); a pair's side flips between legs.
//   CONFIG_INVALID reasons: "nothing_to_add" (RB5-E9: members empty, or nothing owed — never an empty success),
//   "newcomer_is_member", "legs_invalid" (legs not an integer ≥ 1), "last_round_below_lines" (a line or bye has
//   roundNo > lastRoundNo).

// ── @seazn/engine/scheduling — bracket.ts (EXISTING, unchanged)
function seedPositions(size: number): number[];                       // bracket.ts:52-64 ([1,8,5,4,3,6,7,2] for 8)
interface SingleElimOptions { …; byeEntrants?: readonly EntrantId[] /* :83 */; slotOrder?: readonly (number | null)[] /* :90 */ }
//   slotOrder + byeEntrants → CONFIG_INVALID (:128-131); null in slotOrder is a bye (:154).
function generateSingleElim(opts: SingleElimOptions): GeneratedBracket;          // :215
function crossPoolSeedOrder(pools: readonly (readonly EntrantId[])[]): EntrantId[]; // :257-267, wave interleave, KEPT
function generateStepladder(opts): GeneratedBracket;   // :421-447, first rung = the two lowest seeds (:428-433)
function generatePagePlayoff(opts): GeneratedBracket;  // :398-411, exactly 4: s1 v s2, s3 v s4
// ── @seazn/engine/core — rng.ts (EXISTING, unchanged)
function shuffle<T>(seed: number, items: readonly T[]): T[];   // rng.ts: mulberry32 Fisher–Yates, never mutates

// NEW (T6), beside crossPoolSeedOrder. Consumer: app PR B Task 5 (the destination's stored draw seed, W4 RB4-D4).
export interface PooledSeed {
  entrantId: EntrantId;
  pool: string;        // ResolvedProgressionEntry.pool (T5)
  tier: number;        // group_rank → descriptor.rank; best_nth → descriptor.nth; non-decreasing along the input
  tied?: boolean;      // true: this seed and the PREVIOUS seed (same tier) are equal on the cross-pool comparison
                       // (ruling 281 "where ranks tie across pools"). Exact contract below (fix round 2, G3).
}
//   `tied` CONTRACT (G3). Seed i (i ≥ 2) carries `tied: true` iff seed i−1 has the same `tier` AND the two are EQUAL ON
//   THE CROSS-POOL COMPARISON: ranked together by the source's cross-group order (`SourceTables.crossGroup.order`, else
//   `PRE_W2D_CROSS_GROUP`, progression.ts:536), every key left them level, so they end in ONE residual class — rows
//   `rankStandings` marks `tieUnbroken: true` and names each other in `tieBreak.with` (tiebreakers.ts:1088-1120; lots,
//   or seed then id). It is computed where the cross-pool ranking is built:
//   - best_nth tier: the engine's best-Nth ranking builds it (resolveProgression) and reports it as
//     `ResolvedProgressionEntry.basis.levelWith` (T5). Seed i is tied iff seed i−1's entrantId ∈ seed i's
//     `basis.levelWith`. A best-Nth tier comes in cross-pool rank order, so a residual class is contiguous.
//   - group_rank tier: nothing ranks it across pools (it is placed in pool order, RB5-D2), so the caller ranks it:
//     `crossGroupOrder(rows, order, undefined, { seeds, winsCount })` (progression.ts:678, public) over the tier's rows —
//     each pool's row at that rank from the same `SourceTables` it resolved — with `tieUnbroken`, `tieBreak`, `rank` and
//     `rankLocked` stripped first (else a row keeps its own pool's trace); it ignores the returned order and
//     `newLotsDraws` and reads only the residual classes. Two rows whose `played` differ are never level (records over
//     different match counts; designer's call G3). The tier stays in pool order, so only ADJACENT level seeds link; a
//     level pair separated in pool order by a non-level seed keeps pool order (designer's call G3).
//   - NEVER `ResolvedProgressionEntry.tieUnbroken`: that is the WITHIN-pool flag (a shared place, rowAtPosition :645;
//     a pool row's own residual tie, copied at :873), not a cross-pool comparison.
//   A pair split by any key is not tied. A pair level on every key IS tied even when stored lots ordered it in the
//   source: lots decide WHO qualifies (X-PD-8), ruling 281's draw seed decides WHERE they sit (RB5-D3).
//   `tied: true` on the first seed, or on a seed whose predecessor is in another tier → CONFIG_INVALID "tie_link_invalid".
export type FirstRoundShape = "single_elim" | "stepladder" | "page_playoff";
export interface CrossPoolDraw { order: EntrantId[]; slotOrder: (number | null)[] | null /* single_elim only */ }
export function crossPoolDraw(seeded: readonly PooledSeed[], shape: FirstRoundShape, drawSeed: number): CrossPoolDraw;
//   Step 1 (RB5-D3, ruling 281): each maximal run of consecutive seeds in one tier linked by `tied` is reordered by
//   shuffle(drawSeed, run). No `tied` anywhere → step 1 is the identity and the seed is unused.
//   Step 2 (RB5-D10): tier 1 keeps its step-1 positions; each later tier is permuted (depth-first; candidate orders in
//   lexicographic order of step-1 positions; the first separating assignment wins) until no first-round real-vs-real
//   pair shares a pool. single_elim: pairs from seedPositions(nextPowerOfTwo(n)); seeds > n are byes and never
//   constrain; slotOrder = those positions with seeds > n as null, so
//   generateSingleElim({ entrants: order, seeds: positional, slotOrder }) builds the draw. stepladder: the first rung
//   (the two lowest seeds, :428-433). page_playoff: s1 v s2 and s3 v s4.
//   Deterministic in (seeded, shape, drawSeed): Rebuild with the stored seed reproduces the draw (RB5-D7).
//   CONFIG_INVALID reasons: "no_qualifiers" (n = 0), "tiers_out_of_order", "tie_link_invalid" { entrantId } (G3),
//   "draw_seed_invalid" (drawSeed not a finite integer), "pool_separation_impossible" { shape, entrants,
//   supplies: Record<pool, number> }.

// ── @seazn/engine/competition — stage.ts (EXISTING)
interface TableFixture { id; poolId?; roundNo?; status; result?: FixtureResult; awardDelta?; unplayed? } // stage.ts:39-52
interface TableStageFields { id; kind: "league"|"group"|"swiss"; entrants; rules: TableRules; winsCount?; gamePoints?;
  seeds?; rngSeed?; rounds?; openingDeltas? /* :122 */; rankLocks?: readonly RankLock[] /* :125 */; h2hScope?;
  lotsDraws? /* by pool key, :131 */; scheduledPairs?; partialScheduleOrder? }                       // :105-139
function completeTableStage(stage: TableStage, fixtures: readonly TableFixture[]): CompletedTableStage; // :322-404
//   today: pools = first appearance of fixture.poolId (:277-282); a pool's members = entrants with a result or award
//   on its fixtures (:286-307); openings folded per pool (:343-348); carried opening with points ≠ 0 counts (:354);
//   locks filtered per pool, then applyRankLocks (:376-379); PoolTable carries results (:391); finalRanks by wave (:395).
function withdrawTableEntrant(stage: Pick<TableStage,"id"|"kind">, entrantId: EntrantId,
  fixtures: { played: readonly TableFixture[]; pending: readonly { id: string; opponent: EntrantId }[] }): WithdrawalResult; // :943-980
//   played counted by involvesEntrant (:913-917, the entrant named in `result`); expunge iff kind ≠ swiss
//   (EXPUNGES_EARLY_WITHDRAWAL :930-934) and played/total < 0.5 (:951-954); expunge voids every played fixture passed
//   that names the entrant in its result (involvesEntrant, :958-959) plus every pending one (:960-961); else pending
//   walk over (:963-965). There is no `finalized` in the engine: the skip is the app's (usecases/withdrawal.ts:232-233).

// CHANGED (T3, T8). Consumer: app PR B Task 1 (`pools`), Task 7 (`adjustments`).
interface TableStageFields {
  pools?: ReadonlyMap<EntrantId, string>;        // NEW: entrant → pool key; absent or empty = today's membership
  adjustments?: readonly PointsAdjustment[];     // NEW (T8); openingDeltas is unchanged and stays carry-over's
}
//   With `pools`: every mapped entrant is a row of its pool from the first fold (zero played); pool order = first
//   appearance among fixtures (today's rule), then seated pools with no fixture in stage.entrants order.
//   An entrant of stage.entrants missing from `pools` is NOT a row and is NOT refused (F9: a waiting late arrival);
//   a fixture whose result or award names an entrant missing from `pools` → CONFIG_INVALID "entrant_unseated"
//   { entrantId, fixtureId }; a result naming an entrant seated in another pool than the fixture's poolId →
//   CONFIG_INVALID "fixture_pool_mismatch" { entrantId, fixtureId, pool }. validatePoolSizes, validateRankLocks and
//   validatePointsAdjustments run before any fold.
export function validatePoolSizes(pools: ReadonlyMap<EntrantId, string>, min?: number /* default 2 */): void;
//   CONFIG_INVALID { reason: "pool_too_small", pool, size, entrants, pools, suggestedPools: number | null }
//   suggestedPools = the largest c ≤ pools with floor(entrants / c) ≥ min; null when no c ≥ 1 qualifies.
//   (App PR A computes the same count app-side for C38; app PR B Task 1 pins the two equal.)
export function validateRankLocks(locks: readonly RankLock[] /* points.ts:670 */, entrants: readonly EntrantId[],
  pools?: ReadonlyMap<EntrantId, string>): void;
//   CONFIG_INVALID reasons "rank_lock_unknown_entrant" | "rank_lock_out_of_range" | "rank_lock_duplicate_in_pool",
//   context { entrantId, rank, pool }. applyRankLocks (points.ts:675-704) is unchanged and no longer reached invalid.

// CHANGED (T4, additive). Consumer: app PR B Task 2 (the withdrawal footnote note); app PR A counts app-side until then.
type DivisionEvent = … | { type: "entrant_withdrawn"; stageId; entrantId; policy: "void_remaining" | "bracket_walkover";
  mode?: "expunge" | "award"; played?: number; scheduled?: number };   // :194-200; the two counts NEW, void_remaining only
//   played/scheduled = the counts the decision used (:951-952). The app reads `mode` from this event today at
//   usecases/withdrawal.ts:371-382 (pinned 2026-11-16 @97b184e2d9).

// ── @seazn/engine/competition — progression.ts (EXISTING)
type TakeRule = … | { kind: "bestNth"; nth: number; count: number; normaliseUnequalPools?: boolean };  // :49-55
interface PoolTable { pool: string; rows: readonly StandingsRow[]; results?: readonly FixtureResult[] } // :475-482
interface SourceTables { pools; overall?; bracket?; crossGroup?: CrossGroupRules }                      // :503-521
interface ResolvedProgressionEntry { seed; sourceIndex; descriptor; entrantId; rank; tieUnbroken }      // :537-544
//   today: bestNth without the flag over unequal pools → SEEDING_BESTNTH_UNEQUAL_POOLS (:825-836); with the flag,
//   normalisedRow drops the bottom ONE row, equal pools included (:652-670); results absent → raw rows (:655).
//   The app passes NO `results` today (stage-seeding.ts:414 sourcesToTables, stages/carry-over.ts:251
//   tablesForCompletedStage), so every app comparison is raw; app PR B passes them in both builders in the SAME commit
//   as its bump to 10.0.0 (fix round 2, G4), so results and the always-on engine land together.

// CHANGED (T5, T8). Consumer: app PR B Task 4 (basis, pool, expunged), Task 5 (pool → PooledSeed), Task 7 (notes).
interface PoolTable {
  expunged?: readonly EntrantId[];   // NEW: rows whose results were removed under X-WDT-1; not counted in effective size.
                                     // PRODUCER: app PR B Task 4, in BOTH SourceTables builders (sourcesToTables,
                                     // tablesForCompletedStage), from the table's withdrawn entrants whose
                                     // entrant_withdrawn event carried mode "expunge"; driven through the real snapshot
                                     // path. (Not app PR A: 9.1.0's PoolTable has no such field.)
  notes?: readonly AdjustmentNote[]; // NEW (T8); written by completeTableStage
}
interface ResolvedProgressionEntry {
  pool?: string;             // NEW: the source pool (group_rank, best_nth entries); absent otherwise
  basis?: ComparisonBasis;   // NEW: best_nth entries only
}
export interface ComparisonBasis { nth: number; matchesCounted: number; dropped: { pool: string; against: EntrantId[] }[];
  levelWith: EntrantId[] }   // G3: the OTHER candidates (this source, this nth) the cross-pool comparison left level on
//   every key — this candidate's residual class, from ranking the compared rows (refolded under k) with their pool
//   trace (`tieUnbroken`, `tieBreak`, `rank`, `rankLocked`) stripped; [] when a key decided it. Independent of
//   `tieUnbroken`. It feeds `PooledSeed.tied` for best_nth tiers.
//   k(pool) = effective size(pool) − min effective size over the source's pools; effective size = rows − expunged.
//   The bottom k = the last k non-expunged rows by rank (lots included). Always on (ruling 286): normaliseUnequalPools
//   is accepted and ignored (deprecated JSDoc; the cache key :818 drops it); the unequal-pools refusal is removed (the
//   code stays in the errors union, core/errors.ts:62, unthrown). Order of checks per best_nth source: rowAtRank on every
//   pool first (:610-622, a pool with fewer than nth rows refuses as today), then, for the first pool in `pools` order
//   with k > 0 and `results` absent or empty → STAGE_NOT_READY { reason: "pool_results_missing", pool }.
//   matchesCounted = the largest `played` among the refolded candidate rows.

// ── @seazn/engine/competition — qualification.ts (EXISTING)
type QualStatus = { kind: "through" } | { kind: "out" } | { kind: "win_k"; k: number } | { kind: "needs_help" }; // :10-14
interface QualRow { entrantId; points; active }   // :16-27 — no rank; order is the caller's
interface QualificationInput { rows; remaining; perMatch; cut; anyPlayed; complete }   // :29-40
function qualificationStatus(input): ReadonlyMap<EntrantId, QualRowResult | null> | null;  // :92-118; null when !anyPlayed || complete (:95)
// CHANGED (T7). Consumer: app PR B Task 6.
type QualStatus = … | { kind: "qualified" };      // NEW member (breaking for an exhaustive switch)
interface QualificationInput { qualified?: ReadonlySet<EntrantId>; order?: readonly EntrantId[] }  // NEW, read only when complete
//   complete: `qualified` given → active rows in it {qualified}, other active rows {out}; else `order` given → the first
//   `cut` ACTIVE ids of `order` {qualified}, the rest {out}; else null (no order source: fail closed). ifYouLose null.
//   Inactive rows stay null (:100-103). !anyPlayed && !complete → null (unchanged).

// ── @seazn/engine/competition — points.ts (NEW, T8; beside RankLock :670). Consumer: app PR B Task 7.
export interface PointsAdjustment { entrantId: EntrantId; delta: number; reason: string; at: string /* ISO date */ }
export interface AdjustmentNote { kind: "adjustment"; entrantId: EntrantId; delta: number; reason: string; at: string }
export function validatePointsAdjustments(adjustments: readonly PointsAdjustment[], entrants: readonly EntrantId[]): void;
//   CONFIG_INVALID reasons "adjustment_zero" | "adjustment_reason_missing" (reason.trim() === "") |
//   "adjustment_not_finite" | "adjustment_unknown_entrant". delta is in the stage PointsRule's stored unit
//   (points.ts:45-97 `unit`: "half" stores half-points); it adds to StandingsRow.points (standings.ts:22) and nothing
//   else. There is no "no points metric" refusal: every table folds `points` (RB5-T15's second clause dropped, ruling 288).
```

Consumer-visible behaviour with no new type: a caller that passes `pools` sees every seated member from the first
fold; a complete stage with an order source no longer reads null; a caller that passes pool `results` and set
`normaliseUnequalPools: true` over equal pools stops dropping the bottom result. **For the app:** today it passes no
`results`, so its comparisons are raw (a flagged best-Nth over unequal pools reads raw rows, :655). **There is no 9.x
window (fix round 2, G4):** app PR A passes nothing new to the engine, so 9.x behaviour (today's refusal or raw-row path)
is unchanged while A is live; app PR B passes pool `results` in both `SourceTables` builders in the same commit as its
bump to 10.0.0, so results and the always-on k = size − min land together. At that commit equal pools move nothing
(k = 0) and unequal pools move from raw rows to ruling 286's basis, which is the intended change.

## Review Focus

1. **Two pools, winners plus the best runner-up, into a four-draw or a stepladder of three** (A1, B1, B2). With tier 1
   fixed (RB5-D10) the only first-round real pair is B1 v B2 (seedPositions(4) = [1,4,3,2]; stepladder rung = seeds 2
   and 3), so the draw is refused by name, refusing a plausible groups_ko / group_stepladder shape. Pinned in T6 as
   the refusal, as ruling 288 confirmed (REC-12: kept refused; pool winners do not swap).
2. **A late entrant into an even league with no byes** (a..f, rounds 1–3 played). A person expects six new fixtures,
   one per member, each its own catch-up round 6–11, and nothing in a played round. Every member's earliest round is
   1, so the order of rounds 6–11 is the members' listed (seed) order (F5, designer's call). Pinned in T2.
3. **A caller that passes `results` over equal pools with `normaliseUnequalPools: true`.** Today the flag drops a
   result even with equal pools; under ruling 286 equal pools drop nothing, so the comparison changes
   (`progression.test.ts:1095`'s pick moves from B3 to A3). Pinned in T5 and named BREAKING in the changeset. The app
   passes no `results` today, so no app equal-pool seat moves when app PR B starts passing them with its bump.
4. **Unequal pools whose tables arrive without `results`** (the app's two `SourceTables` builders today). A person
   expects either the dropped basis or a refusal, never raw points presented as compared fairly. Pinned in T5
   (`pool_results_missing`); app PR B passes `results` in both builders in its bump commit (G4), so no app path ever
   meets the refusal and no 9.x window opens.
5. **"Adjust points" on a table where nothing is played yet.** The adjustment counts like a carried opening with
   points (stage.ts:354), so the adjusted row is ranked by it and a tie among the rest goes to the cascade's lots as
   any counted table does (plan's call; a person sees the −3 team last). Pinned in T8.

---

### Task 0: The W5 rule rows and the amendments (B0)

**Model:** implementer Sonnet (high effort); reviewer Sonnet (high effort). Docs-only.

A docs-only PR on `onryde/seazn.club.engine` (`docs/w5-rule-rows`) with a **minor** changeset, released alone as 9.1.0
by Task 0b. The app half (the seazn.club `AWAITING_PROOF` entries and `AMENDED_TEXT` edits) rides a **standalone
seazn.club "W5 rows bump" PR** (fix round 2, G6; exactly #1146's shape, recorded at app
`scripts/lib/rules-reference.ts:33-40`): it bumps both `package.json` files to `^9.1.0`, adds the 74 entries and the
three `AMENDED_TEXT` edits in one commit, and merges to main right after 9.1.0, before app PR A's branch work starts
(Gate 2b). It cannot land earlier, because the app reads rows from the installed package
(`node_modules/@seazn/engine/rules`) and its W2b text pin fails on a stale amendment; it must not wait for PR A, because
any other wave's engine bump in that window would inherit 74 unlisted awaiting rows and red. Not part of B0: the
seazn.club docs push of rulings 276–290 (orchestrator, before B0; the sheet and app plan A once called that push "B0" —
in this plan B0 is the engine rows PR only).

**Files (engine):**
- Modify: `rules/cross-sport.md` (append areas X-RR, X-CU, X-PO, X-WDT, X-UP, X-PD, X-QS, X-ADJ, X-CUT, X-RP, X-BD, X-SF;
  amend X-RT-1 :18 (ruling 289) and X-LE-2 :103)
- Modify: `rules/badminton.md` (BD-WO-2 :6, BD-RT-1 :7; ruling 290); `rules/tennis.md` is not touched (ruling 290: tennis does not differ)
- Modify: `test/rules-reference.ts` (`AWAITING_PROOF` :55-67, a W5 block)
- Create: `.changeset/w5-rule-rows.md` (minor)
- Test: `test/rules-reference.test.ts` (existing checker)

**App half (the standalone W5 rows bump PR applies it, G6; listed here so both sides read one source):**
- `scripts/lib/rules-reference.ts:41` (`AWAITING_PROOF`): one entry per id the 9.1.0 package lists as awaiting — the 74
  tagged ids of the canonical table, value `"W5 <tag> (ruling N; engine 9.1.0)"`, the W4 pattern at :38-40. Every row has one.
- `scripts/__tests__/rules-reference.test.ts:41` (`AMENDED_TEXT`, the W2b text pin): only for an amendment 9.1.0
  carries — add X-RT-1 with its new text and `by: "ruling 289 under ruling 277 (2026-11-16)"`; replace BD-RT-1's entry
  (:66) and add BD-WO-2 with their new text and `by: "ruling 290 (2026-11-16): permanent deviation from BWF GCR 16.2.5"`. X-LE-2 is a W4 row, not in the W2b spec, so it has no
  `AMENDED_TEXT` entry. An amendment confirmed after 9.1.0 rides the next engine release and its `AMENDED_TEXT` edit
  rides the bump to that release (app PR B's).
- No app entry is deleted before the release that carries its proof: app PR B's bump to 10.0.0 deletes the 71
  engine-PR and app-PR-A entries; app PR B's close-out bump deletes the last 3 (T10 Step 5).

**Area codes (collision-checked against every `rules/*.md` at 2cd842a):** X-RR, X-CU, X-PO, X-WDT, X-UP, X-PD, X-QS,
X-ADJ, X-CUT, X-RP, X-BD and X-SF are unused. **X-BL is taken** (X-BL-1, W2b-R13, cross-sport.md:32), so the
builder area is **X-BD**; late-entry rows are **X-CU** (no `X-LE-15+`, no `X-LE-table-*`).

**Interfaces:**
- Produces the canonical id table below. **It is binding on app PRs A and B** (F2): every test that proves a row
  carries the id as a whole token in its `it(`/`describe(` title. Row text is the named rulebook row(s) verbatim
  (`rulebook-W5-round-robin.md`), joined in the listed order; status from the rulebook's status column with the
  ruling's date (276–284: 2026-11-05; 285 and S1–S7: 2026-11-06; 286: 2026-11-16); citation ends
  `; not yet implemented (W5 engine PR)` / `(W5 app PR A)` / `(W5 app PR B)`; `enforced at —`, `proved by —`. No ⬜ row remains
  (rulings 287–290 answered every REC); rows signed by 287–290 cite "seazn.club `_INDEX` ruling N".

**Canonical id table (final, 2026-11-16 fix round 1, with owner rulings 287–290):**

| id | rulebook row (← source; status) | proved by PR (task) | gated by REC? |
|---|---|---|---|
| X-RR-1 | G1, E3 (285) | engine PR T1 | — |
| X-RR-2 | G2 (285) | engine PR T1 | — |
| X-RR-3 | G3 engine half: the bye recorded on the round (285) | engine PR T1 | — |
| X-RR-4 | G1 legs clause only: legs numbered 1..L, L as given (285) | engine PR T1 | — |
| X-RR-5 | G7 identity half: (unordered pair, leg) (285) | engine PR T1 | — |
| X-CU-1 | L3 owed set, E9 (276) | engine PR T2 | — |
| X-CU-2 | L3 bye slot (276) | engine PR T2 | — |
| X-CU-3 | L3 appended rounds, L6 (276) | engine PR T2 | — |
| X-CU-4 | L4 (276) | engine PR T2 (+ app PR A's byte-equal / round-number tests, appended at T9) | — |
| X-CU-5 | L16 (285) | engine PR T2 | — |
| X-PO-1 | P1 (279) | engine PR T3 | — |
| X-PO-2 | E4, P2 (deviation 279) | engine PR T3 | — |
| X-PO-3 | P5 (285) | engine PR T3 (+ app PR A's write-time check, appended at T9) | — |
| X-WDT-1 | W2 decision half (277) | engine PR T4 | — |
| X-WDT-2 | W3 (277) | engine PR T4 | — |
| X-WDT-3 | W4 (285) | engine PR T4 | — |
| X-WDT-4 | W7 decision half: the decision names its rule and counts (285) | engine PR T4 | — |
| X-WDT-6 | W8 (deviation 277) | engine PR T4 | — |
| X-UP-1 | U1, U7, U8 (280, 286) | engine PR T5 | — |
| X-UP-2 | U2 (280) | engine PR T5 | — |
| X-UP-3 | U3 output half (280) | engine PR T5 | — |
| X-UP-4 | U4 (285) | engine PR T5 | — |
| X-UP-5 | U5, U6, E7 (285, 286) | engine PR T5 | — |
| X-PD-1 | D1 (281) | engine PR T6 | — |
| X-PD-2 | D2 (281) | engine PR T6 | — |
| X-PD-3 | D3, D7 (281): rank ties drawn with the stored draw seed; reproducible | engine PR T6 | — |
| X-PD-4 | D4, D10 (281, 285, 288: the A1/B1/B2 refusal kept) | engine PR T6 | — |
| X-PD-5 | D5 (281) | engine PR T6 | — |
| X-PD-6 | D6 (285) | engine PR T6 | — |
| X-PD-7 | D8 (285) | engine PR T6 | — |
| X-QS-1 | T1, T2, T14 engine half (283, 285) | engine PR T7 | — |
| X-ADJ-1 | T7 (284) | engine PR T8 | — |
| X-ADJ-2 | T15 (285; second clause dropped by 288) | engine PR T8 | — |
| X-ADJ-3 | E8 (285) | engine PR T8 | — |
| X-CU-6 | G7 app half, L17 (285) | app PR A (reconcile task; FX-G1 tests retitled) | — |
| X-CU-7 | L15, L7, L8, L11 (276, 285) | app PR A (late-entry cases; incl. the started bye slot under the lock) | — |
| X-CU-8 | L10 (276) | app PR A (automatic arrivals, desk flag) | — |
| X-CU-9 | L1, L2, L12 (276, 285) | app PR A (entry stage only; bracket fed from a table refuses) | — |
| X-CU-10 | L5 (276) | app PR A ("Joined round N", standings view) | — |
| X-CU-11 | L9 (276) | app PR A (pool picker) | — |
| X-CU-12 | L13 (285) | app PR A (catch-up fixtures unscheduled and flagged) | — |
| X-CU-13 | L14 (285) | app PR A (Undo refused, points to Withdraw) | — |
| X-WDT-5 | W2 writes half, W3 writes half, W7 shown half (277, 285) | app PR A (withdrawal writes; expunge-abandon path) | — |
| X-WDT-7 | W1, W5 (277, 285) | app PR A (row stays, marked, last; DQ same rule) | — |
| X-WDT-8 | W6 (285) | app PR A (Reinstate) | — |
| X-CUT-1 | K1, K4 (278, 285) | app PR A (verify-only driving tests, setup + on_complete) | — |
| X-CUT-2 | K2 (278) | app PR A | — |
| X-CUT-3 | K3 (278) | app PR A | — |
| X-CUT-4 | K6 (S5) | app PR A (table-source staling incl. confirmed) | — |
| X-RP-1 | R1 (285) | app PR A (duplicate entrant pin) | — |
| X-RP-2 | R2 (282) | app PR A | — |
| X-RP-3 | R3 (282) | app PR A | — |
| X-BD-1 | E4 server + builder half, S3 (279, 285) | app PR A (C38 extended + builder) | — |
| X-BD-2 | S1 (S1) | app PR A | — |
| X-BD-3 | S2 (S1) | app PR A | — |
| X-BD-4 | S4 (285) | app PR A (second Complete no-op) | — |
| X-BD-5 | E1, E2 (285) | app PR A (empty / under-two generate refused) | — |
| X-BD-6 | S5 (285) | app PR A (Add match round) | — |
| X-BD-7 | E5, P3 (285) | app PR A (single pool writes its id) | — |
| X-BD-8 | E6 (285) | app PR A (NEW task: a cut larger than the field, or a best-Nth cut no pool can supply, refused on setup and on_complete) | — |
| X-SF-1 | T10 (285) | app PR A | — |
| X-SF-2 | T12 (285) | app PR A | — |
| X-SF-3 | T11 (285) | app PR A (verify-only) | — |
| X-SF-4 | G3 shown half, P6 (285) | app PR A (who sits out) | — |
| X-SF-5 | P4 (285) | app PR A (board pool letter) | — |
| X-SF-6 | T13 (285) | app PR A (standings API) | — |
| X-RR-6 | G6 as re-signed by ruling 287 (owner: "in prod, no triple_rr, so blindly cleanup, delete it"): `triple_rr` is deleted. Scope (coordinator's reading of 287, designer's call): the template row and its detection branch (a lone league with `legs` ≥ 3 reads back as `league` with its leg count), picker and builder references, the matrix row and its RETIRED_ROW_ROUTES / noOrganiserPathCell entry, i18n keys, help copy and the tests pinning it; the key is detected, never stored, so no migration; any door that accepts the key refuses it by name. `legs` 1–8 stays (285, RB5-G1), so a `legs: 3` league is a league; the engine's `legs` input stays generic | app PR A (triple_rr deletion; a legs:3 league reads back as league legs 3; the key refused by name at the door that accepts it; no migration) | — |
| X-PD-8 | G9 as re-worded by 291: a tie between teams in different pools that survives the best-Nth basis comparison is broken by the sport's own declared cross-group cascade (a `seed` step → seed order; `lots` → the engine's stored lots draw; neither → seed then id; no engine change); inside the cross-pool draw ruling 281's stored seed decides (X-PD-3) (288, re-worded by 291) | app PR A (constructed enumeration test over every template row that HAS a best-Nth take, row set derived from `STAGE_TEMPLATES` / the `TakeRule` declarations, count asserted > 0, through the app resolver; the `_INDEX.md:4594-4601` harness cases are re-judged by row in A's matrix task, G1) | — |
| X-WDT-9 | W10: a player's own withdrawal after Start goes through the table withdrawal, phase check and cascade, one door (288) | app PR A (self-withdraw task) | — |
| X-WDT-10 | W11 as signed by ruling 289: an in-match DQ withdraws the entrant under §5, and the Disqualify action (pad and organiser) first shows plain copy naming the consequence — the remaining fixtures withdrawn, whether results stand or are expunged under the 50 percent rule with this entrant's actual count, and whether it can be undone — in 4 locales; the copy's numbers come from the same decision the cascade applies (289) | app PR A (DQ cascade + DQ consequence copy task) | — |
| X-PO-4 | P7: a rank override on a non-table stage is refused by name; public flag silent (288) | app PR A (rank-override task) | — |
| X-QS-2 | T3, T4 (283, S3) | app PR B (frozen markers on every surface) | — |
| X-ADJ-4 | T5, T6, T9 (284, 285) | app PR B (Adjust points action) | — |
| X-ADJ-5 | T8 (S2) | app PR B (Swiss pairs on the adjusted score; test retitled `X-ADJ-5 …`) | — |

Counts (after owner rulings 287–290, 2026-11-16): **74 rows = 34 engine PR + 37 app PR A + 3 app PR B; 74
`AWAITING_PROOF` entries; no ⬜ row and no REC gate remains.** TN-WD-1 is dropped (ruling 290: tennis follows ruling 277
like every sport and `rules/tennis.md` holds no withdrawal row that differs, so no tennis row is written; area TN-WD is
not used). Amendments (no new id, all ungated, all in the B0 rows PR and the 9.1.0 release): X-RT-1 ("the cascade is W5"
→ "under X-WDT-1, X-WDT-2 and X-WDT-10, rulings 277 and 289"); BD-WO-2 and BD-RT-1 (drop "until W5"; a permanent
recorded deviation from BWF GCR 16.2.5, ruling 290; badminton follows ruling 277; no sport-specific withdrawal code);
X-LE-2 ("league and groups: ruling 276, X-CU-1 to X-CU-13"). The app's `AMENDED_TEXT` entries for X-RT-1, BD-WO-2 and
BD-RT-1 (three; X-LE-2 is a W4 row the W2b pin does not cover, so it has none) land with the W5 rows bump PR's bump to
9.1.0 (G6). Not given (restated, deferred or method): G4, G5, G8, W9, K5, K7,
D9, D11, H1; W12 → the BD amendments.

- [ ] **Step 1: Write the 74 rows** per the table, appended to `cross-sport.md` area by area.
- [ ] **Step 2: Amend rows.** Unconditional: X-LE-2 — replace "league and groups: W5" with "league and groups: ruling
  276, X-CU-1 to X-CU-13". Ruling 289: X-RT-1 — replace "(the cascade to other fixtures is
  W5)" with "(and the entrant leaves the stage: a withdrawal under ruling 259; from a league or group table under
  X-WDT-1, X-WDT-2 and X-WDT-10, rulings 277 and 289)", append "Amended by ruling 289 (2026-11-16)." to the citation. Ruling 290: BD-WO-2 — replace "(until W5)" with "(a permanent recorded deviation from BWF GCR 16.2.5, ruling 290:
  badminton follows ruling 277's 50 percent rule, X-WDT-1 and X-WDT-2, like every sport; delete-all is not applied)",
  status `deviation 290 2026-11-16`; BD-RT-1 — replace "(until W5's 16.2.5)" with "(a permanent recorded deviation from
  BWF GCR 16.2.5, ruling 290)", status `deviation 290 2026-11-16`. No sport-specific withdrawal code.
  Proved-by columns unchanged.
- [ ] **Step 3: Add the 74 `AWAITING_PROOF` entries** (34 + 37 + 3) under a W5 doc comment naming
  the three tags.
- [ ] **Step 4: Verify**: `cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/t0.json" test/rules-reference.test.ts; echo "EXIT=$?"`,
  then the node summary line. Expected: `EXIT=0`, `failedSuites=0`; the engine-path proof count unchanged from
  origin/main; a count of 74 new rows and 74 new entries (`grep -c` on the new ids, written in the PR body).
- [ ] **Step 5: Mutate once:** give the X-RR-1 row a `proved by` path while its entry stays, re-run Step 4 → the
  checker reds (an awaiting row that claims proof, `test/rules-reference.test.ts:118-121`); restore.
- [ ] **Step 6: Changeset and commit:** `.changeset/w5-rule-rows.md`, `"@onryde/seazn-engine": minor`, body "W5
  round-robin rule rows (rulings 276-290) recorded, awaiting proof; no code change." Commit
  `docs(rules): W5 round-robin rows (rulings 276-290), awaiting proof` on `docs/w5-rule-rows`; push; open the PR;
  hand back for the owner's merge (Gate 2).

### Task 0b: Release 9.1.0, rows only (B0r)

**Model:** implementer Sonnet (high effort); reviewer Sonnet (high effort). Docs-only release.

- [ ] **Step 1: Gate:** T0's PR merged (Gate 2) and engine origin/main carries no W5 code (Gate 1's grep still empty).
- [ ] **Step 2: Release** with the `engine-release` skill (9.1.0 = the next 9.x minor; if another wave took 9.1.0 first,
  use the next free minor and hand that number back): `release/9.1.0`, `pnpm changeset version` (consumes
  `.changeset/w5-rule-rows.md` and the pending empty `.changeset/sweet-hoops-sleep.md`), CHANGELOG top `## 9.1.0`,
  publish. Verify: `npm view @onryde/seazn-engine@9.1.0 version` prints `9.1.0`, and
  `npm pack @onryde/seazn-engine@9.1.0 --dry-run 2>&1 | grep -c "rules/cross-sport.md"` is 1.
- [ ] **Step 3: Hand back** the version and its release sha. The orchestrator opens the standalone seazn.club **W5 rows
  bump** PR (G6): it bumps `apps/web/package.json:25` and `packages/reference/package.json:14` to
  `npm:@onryde/seazn-engine@^9.1.0`, applies the app half above in the same commit, runs
  `cd <its worktree> && ./node_modules/.bin/vitest run --reporter=json --outputFile="$OUT/rows-bump.json" scripts/__tests__/rules-reference.test.ts; echo "EXIT=$?"` (the app plan's `VERIFY-ROOT`; app plan A carries the step list as its Task R, "The W5 rows bump", branch `chore/w5-rows-bump`),
  and merges to main; app PR A starts only after that merge (Gate 2b).

### Task 1: The line identity, and W5's generation rows proved (B1; X-RR-1..5)

**Model:** implementer Opus; reviewer Sonnet (high effort).

**Files:**
- Modify: `src/scheduling/roundrobin.ts` (add `roundRobinLineKey` after `roundRobinFixtureCount` :161-164)
- Test: `src/scheduling/roundrobin.test.ts` (existing: completeness :87, uniqueness :105, balance :124, byes :153; add
  W5 blocks, keep the old ones)
- Modify: `rules/cross-sport.md`, `test/rules-reference.ts` (five proofs)

**Interfaces:**
- Consumes: `generateRoundRobin` (:85-157), unchanged.
- Produces: `roundRobinLineKey(a, b, leg): string` (block above). Consumer: app PR B Task 3 pins app PR A's app-side
  `rrKey` against it (F14; app PR A runs on 9.1.0 and consumes nothing new).

- [ ] **Step 1: Write the failing tests** (`describe("W5 round-robin generation (R25)")`):
  - `X-RR-1 a field under two is an empty schedule`: n = 0 and n = 1 → `{ rounds: [], fixtures: [] }` (kept, :90).
  - `X-RR-1 every pair meets exactly once per leg`: every n ∈ [2, 24] × legs ∈ {1, 2, 3}; the multiset of
    `roundRobinLineKey(home, away, leg)` has each key once and size `n(n−1)/2 × legs` (`// RB5-G1`); n = 2 gives one
    fixture per leg, no bye (`// RB5-E3`); asserts `checked === 69`.
  - `X-RR-2 home and away balance and alternate`: per (n, legs) above, per entrant per leg `|home − away| ≤ 1`, and each
    pair's home side differs between consecutive legs; count 69.
  - `X-RR-3 an odd field records one bye per round`: odd n, every round has `bye` set, each entrant holds it `legs`
    times; even n, no round has `bye`; count 69.
  - `X-RR-4 legs are numbered 1..L`: legs 3 → `new Set(fixtures.map(f => f.leg))` is {1, 2, 3} and
    `rounds.length === 3 × (n − 1 + n % 2)` (`// RB5-G1: legs is the engine's input; 3 is the largest swept`; no
    `triple_rr` clause here: ruling 287 deletes it app-side, the engine stays generic — X-RR-6 is app PR A's;
    legs 1–8 is RB5-G1, signed 285).
  - `X-RR-5 the line key is order-free and survives a roster change`: `roundRobinLineKey("b","a",1) === roundRobinLineKey("a","b",1)`;
    differs by leg; `("a","a",1)` and leg 0 throw `line_key_invalid`; **`// differential: today the only per-line key
    is id: rr-r1-c1 is a v d in the five-field [a..e] and a v f in [a..f]`** (asserted from two `generateRoundRobin`
    calls; true at :94-152: odd pivot null, u0 = [a..e], column 1 = u[0] v u[3]; even pivot a v u[4]).
  - Sequence: a second `generateRoundRobin` on the same input gives byte-equal keys.
- [ ] **Step 2: Run** the verify command on `src/scheduling/roundrobin.test.ts`. Expected: FAIL on X-RR-1's pair test,
  X-RR-2 and X-RR-5 (`roundRobinLineKey` is not exported: their multisets are built from it, TypeError); X-RR-1's empty
  case, X-RR-3 and X-RR-4 pass already (shipped behaviour: 69 cases, balance and alternation 0 violations, run
  2026-11-16 against 2cd842a).
- [ ] **Step 3: Implement `roundRobinLineKey(a: EntrantId, b: EntrantId, leg: number): string`** in `roundrobin.ts`.
- [ ] **Step 4: Run** the same command; tsc; eslint. Expected: PASS.
- [ ] **Step 5: Mutate** (swap lo/hi selection to argument order; drop the `a === b` guard; drop the leg guard): each
  reds a named X-RR-5 test; restore.
- [ ] **Step 6: Rows**: X-RR-1..5 proved by `packages/engine/src/scheduling/roundrobin.test.ts`, enforced at
  `packages/engine/src/scheduling/roundrobin.ts`; delete the five entries; run with `test/rules-reference.test.ts`.
- [ ] **Step 7: Commit** `feat(roundrobin): order-free line key; W5 generation rows proved (X-RR-1..5)`.

### Task 2: `lateEntryFixtures` (B1; X-CU-1..5)

**Model:** implementer Opus; reviewer Opus (subtle engine correctness). B1 batch review after this task: Opus.

**Files:**
- Create: `src/scheduling/catch-up.ts`; Test: `src/scheduling/catch-up.test.ts`
- Modify: `src/scheduling/index.ts` (`export * from "./catch-up.ts";` after :29), `stryker.groups.mjs:123` (add
  `"src/scheduling/catch-up.ts"` to `draws-1`), rows

**Interfaces:**
- Consumes: `roundRobinLineKey` (T1); `generateRoundRobin` in tests only.
- Produces: `lateEntryFixtures` and its types (block above).

**Placement rule (RB5-L3, L6, L16):** owed = {(N, m, leg) : m ∈ members, leg ∈ 1..legs} minus any line already present
for that key. For each owed key: the bye slot with `entrantId = m`, that `leg`, `started = false` → `bye_slot` at its
roundNo, slot consumed; otherwise appended `catch_up_round` at `lastRoundNo + k`, k = 1, 2, … ordered by m's earliest
roundNo among `lines`, **ties by m's position in `members`** (the caller lists members in seed order; F5, designer's
call), a member with no line last in `members` order, then leg. Home side: in each leg the newcomer alternates
home/away along that leg's owed list (first away), and each pair's home side flips between legs; a member's own
per-leg balance may move by one (plan's call: RB5-G2's bound is a whole-schedule property).

- [ ] **Step 1: Write the failing tests**:
  - Empty first: `members: []` → `nothing_to_add` (never an empty success; app PR A follows, F8); newcomer ∈ members → `newcomer_is_member`; legs 0 → `legs_invalid`;
    a line at roundNo 9 with `lastRoundNo: 5` → `last_round_below_lines`.
  - `X-CU-1 one fixture per member per leg`: members a..e, legs 2, no lines with N → 10 fixtures, 10 distinct line keys.
  - `X-CU-2 a future bye holder's fixture lands in that round`: the scene is `generateRoundRobin({ entrants: [a..e] })`
    (byes r1 e, r2 d, r3 c, r4 b, r5 a: the circle at :94-129 with rotate :78-83), rounds 1–2 started → (N, c) round
    3, (N, b) round 4, (N, a) round 5 as `bye_slot`; `consumedByes` exactly those three (`// RB5-L3`).
  - `X-CU-3 the rest are appended after the last drawn round`: same scene → (N, d) round 6, (N, e) round 7 (d's earliest
    round 1, e's earliest round 2: `// RB5-L6`); `appendedRounds === 2`.
  - `X-CU-3 an earliest-round tie follows the listed (seed) order, not the id`: the Review Focus 2 scene built from
    `generateRoundRobin({ entrants: ["f","e","d","c","b","a"] })` with `members` in that same listed order → rounds 6–11
    go to f, e, d, c, b, a (every member's earliest round is 1, so only the listed order decides; id order would give
    a..f: the scene where the two differ).
  - `X-CU-4 nothing lands in a started round`: no placement's roundNo ≤ 2 in that scene; a started bye is never consumed.
  - `X-CU-5 two newcomers owe each other`: after N1's fixtures join `lines`, N2 with members ∋ N1 owes (N2, N1) too.
  - Review Focus 2: even field a..f, legs 1, rounds 1–3 started, `byes: []`, `lastRoundNo: 5` → **six** `catch_up_round`
    placements at rounds 6–11 in `members` order, `consumedByes: []` (`// RB5-L3: 6 members × 1 leg`).
  - Counted late sweep: every odd n ∈ [3, 23] × legs {1, 2, 3}, newcomer into `generateRoundRobin`'s schedule with no
    started round → `consumedByes.length === n × legs`, `appendedRounds === 0`; asserts `checked === 33`
    (11 odd values × 3).
  - `// differential: today the only engine path to a sixth entrant's fixtures is generateRoundRobin over six, whose
    round 1 (a v f, b v e, c v d) shares no pair with the five-field's played round 1 (a v d, b v c)` (asserted).
  - Second call: the returned fixtures added to `lines` → `nothing_to_add`.
- [ ] **Step 2: Run** the verify command on `src/scheduling/catch-up.test.ts test/stryker-groups.test.ts`. Expected:
  FAIL (module not found; stryker-groups red until the leg entry lands).
- [ ] **Step 3: Implement `lateEntryFixtures`** per the placement rule; add the stryker home and the re-export.
- [ ] **Step 4: Run** the same command; tsc; eslint; `pnpm boundary`. Expected: PASS.
- [ ] **Step 5: Mutate** (ignore `started` → X-CU-4 reds; drop the bye-slot branch → X-CU-2 reds; append from
  `lastRoundNo` not `+1` → X-CU-3 reds; sort by id instead of earliest round, and separately break earliest-round ties
  by id instead of `members` order → each reds `X-CU-3 an earliest-round tie follows the listed (seed) order` (a..f
  against f..a; the d/e scene alone cannot kill the first, review-verify E-4): each reds the named test; restore.
- [ ] **Step 6: Rows** X-CU-1..5 proved by `packages/engine/src/scheduling/catch-up.test.ts`.
- [ ] **Step 7: Commit** `feat(scheduling): lateEntryFixtures, the round-robin catch-up set (X-CU-1..5)`.

### Task 3: Seating, the pool floor, and rank locks per pool (B2; X-PO-1..3)

**Model:** implementer Opus; reviewer Opus (subtle engine correctness).

**Files:**
- Modify: `src/competition/stage.ts` (`TableStageFields` :105-139, `poolNames` :277-282, `entrantsOfPool` :286-307,
  `completeTableStage` :322-404; add `validatePoolSizes`, `validateRankLocks`)
- Test: `src/competition/stage-pools-w5.test.ts` (new; lands in stryker `competition-2` by glob, :88)
- Rows

**Interfaces:**
- Consumes: `RankLock` (points.ts:670), `applyRankLocks` (points.ts:675-704) unchanged.
- Produces: `TableStage.pools`, `validatePoolSizes`, `validateRankLocks` (block above). Consumer: app PR B Task 1
  passes `pools` (seated entrants only; a waiting arrival is absent from the map and, with no result, is skipped, F9)
  and pins app PR A's app-side workable count equal to `suggestedPools`.

- [ ] **Step 1: Write the failing tests**:
  - Empty first: an empty `pools` map behaves as absent; `pools` absent → today's membership (pinned: one fixture with
    a result in each of two pools gives two rows per pool and nobody else).
  - `X-PO-1 a pool lists every seated member with zero played`: a..g seated A (4) / B (3), scheduled unplayed fixtures
    carrying poolId, one decided result in A → A has 4 rows, B has 3 rows all `played: 0`.
    **`// differential: today B has 0 rows`** (no result in B: `entrantsOfPool` keeps only result/award entrants, :296-306).
  - `X-PO-1 a seated entrant in another pool's result is refused`: `fixture_pool_mismatch`; a result naming an
    entrant missing from `pools` → `entrant_unseated` `{ entrantId, fixtureId }`.
  - `X-PO-1 a waiting arrival with no result is not a row and not refused` (F9): h in `stage.entrants`, absent from
    `pools`, on no fixture → the fold succeeds, A 4 rows and B 3 rows, h in neither.
  - `X-PO-2 a pool under two is refused, naming a count that works`: `validatePoolSizes` on 7 entrants into 4 (2, 2, 2, 1)
    → `{ reason: "pool_too_small", pool: "D", size: 1, entrants: 7, pools: 4, suggestedPools: 3 }` (`// RB5-E4: 7 into 3 is 3, 2, 2`);
    `completeTableStage` with that map throws the same before folding; 4 into 2 passes (`// RB5-P2: floor 2`);
    1 entrant in 1 pool → `suggestedPools: null`.
  - `X-PO-3 a rank may be pinned once per pool`: {a: 1} in A and {e: 1} in B pass (already true: :376-378, pinned);
    {a: 1}, {b: 1} in A → `rank_lock_duplicate_in_pool`; {a: 5} in a pool of 4 → `rank_lock_out_of_range`, `pool: "A"`;
    an unknown entrant → `rank_lock_unknown_entrant`. **`// differential: today {a: 5} with a result throws at
    recompute with context { entrantId } and no reason (points.ts:688-692)`.**
  - Sequence: the same validated input folded twice gives equal tables; after a withdrawal (the leaver's fixtures
    voided) the leaver stays a row of its pool.
- [ ] **Step 2: Run** the verify command on `src/competition/stage-pools-w5.test.ts src/competition/stage.test.ts`.
  Expected: the new file FAILS; `stage.test.ts` passes.
- [ ] **Step 3: Implement** the two validators and seating in `completeTableStage` (membership from `stage.pools` when
  present, today's path otherwise; validators first).
- [ ] **Step 4: Run** the same command; tsc; eslint. Expected: PASS.
- [ ] **Step 5: Mutate** (membership from results again; `min = 1`; validate locks against the whole body, not the
  pool; drop the mismatch guard; refuse every unseated entrant, not only one a result names → the waiting-arrival test
  reds): each reds a named test; restore.
- [ ] **Step 6: Rows** X-PO-1..3 proved by `packages/engine/src/competition/stage-pools-w5.test.ts`.
- [ ] **Step 7: Commit** `feat(stage): pool membership is seating; floor of two; rank locks validated per pool (X-PO-1..3)`.

### Task 4: The withdrawal decision proved, and its counts (B3; X-WDT-1..4, X-WDT-6)

**Model:** implementer Opus; reviewer Sonnet (high effort).

The engine already decides correctly (stage.ts:943-980): it voids every played fixture it is handed that names the
entrant in its result (`involvesEntrant`, :958-959); the finalized
skip is the app's (`usecases/withdrawal.ts:232-233`, pinned 2026-11-16 @97b184e2d9) and is app PR A's fix through the
expunge-abandon path (X-WDT-5). This task is test-only plus two additive event fields.

**Files:**
- Modify: `src/competition/stage.ts` (`DivisionEvent` :194-200, `withdrawTableEntrant` :968-978)
- Test: `src/competition/stage-withdrawal-w5.test.ts` (new); the existing block at `stage.test.ts:282` stays
- Rows

**Interfaces:** Produces `entrant_withdrawn.played` / `.scheduled` on `void_remaining` (block above). Consumer: app PR
B Task 2 (the footnote note); app PR A counts app-side until the bump (F14).

- [ ] **Step 1: Write the failing tests**:
  - Empty first: nothing played, nothing pending → `mode: "expunge"`, no updates, `played: 0, scheduled: 0`.
  - `X-WDT-1 under half: every played fixture and every pending one is voided`: 2 played of 5 → five `void` updates.
  - `X-WDT-2 half or more: results stand, the rest walk over`: 3 of 5 → two `walkover` updates naming the opponents.
  - `X-WDT-3 the half test is strict`: 4 of 8 → award; 3 of 8 → expunge (`// RB5-W4`); a played fixture without the
    entrant's result is not counted (involvesEntrant :913-917).
  - `X-WDT-4 the decision names its rule and counts`: the event is `{ policy: "void_remaining", mode, played, scheduled }`
    with 2 / 5 (`// RB5-W7: "left after 2 of 5"`); the bracket policy carries neither count.
  - `X-WDT-6 one rule for every sport at 50 percent`: 3 of 5 → award. **`// differential: today award (stage.ts:953-954);
    BWF/ITTF always-expunge and the FA's 75 percent would expunge`** (RB5-W8).
  - Swiss: 1 of 5 → award (EXPUNGES_EARLY_WITHDRAWAL :930-934, pinned).
  - Sequence: a second call on the same input returns equal results; after a void (the voided fixture in neither list)
    the counts drop it.
- [ ] **Step 2: Run** the verify command on `src/competition/stage-withdrawal-w5.test.ts src/competition/stage.test.ts`.
  Expected: FAIL only on the count assertions.
- [ ] **Step 3: Implement** the two fields on the `void_remaining` event from `playedCount` and `total` (:951-952).
- [ ] **Step 4: Run** the same command; tsc; eslint. Expected: PASS.
- [ ] **Step 5: Mutate** (`<=` for `<` at :954; count every played fixture without `involvesEntrant`; emit `scheduled`
  as `pending.length`): each reds a named test; restore.
- [ ] **Step 6: Rows** X-WDT-1..4, X-WDT-6 proved by `packages/engine/src/competition/stage-withdrawal-w5.test.ts`.
- [ ] **Step 7: Commit** `test(stage): W5 withdrawal rows proved; the decision reports its counts (X-WDT-1..4, X-WDT-6)`.

### Task 5: Best-Nth across unequal pools, always on (B4; X-UP-1..5)

**Model:** implementer Opus; reviewer Opus (subtle engine correctness). B2–B4 batch review after this task: Opus.

**Files:**
- Modify: `src/competition/progression.ts` (`TakeRule` JSDoc :49-55, `PoolTable` :475-482, `ResolvedProgressionEntry`
  :537-544, `normalisedRow` :652-670, the best_nth branch :805-856)
- Test: `src/competition/progression-unequal-w5.test.ts` (new); `src/competition/progression.test.ts` — five existing
  tests froze the old behaviour and are rewritten in place (never deleted), each with its new expected value derived
  from RB5-U1/U6/U7/U8 and the check order in the signatures block:
  - `:578` "bestNth refuses unequal pool sizes by default" (A 2 rows, B 3, nth 2, no flag, no results) → retitle
    `bestNth over unequal pools without results refuses pool_results_missing (ruling 286)`; expects
    `STAGE_NOT_READY` with context `{ reason: "pool_results_missing", pool: "B" }` (k(B) = 3 − 2 = 1, first pool with
    k > 0); the "message is not /isn't implemented/" assertion stays.
  - `:611` "two bestNth rules … do NOT share a cached ordering across different normaliseUnequalPools" (same tables)
    → retitle `the flag no longer splits the bestNth cache: both rules meet the same refusal`; expects the same
    `pool_results_missing` on pool "B" (the flag selects no path any more; with results present the pair collides on
    the entrant dedupe, which T5's sequence test pins).
  - `:642` "normaliseUnequalPools:true silences the refusal" (A 2, B 3, flag, no results; was 2 qualifiers) → retitle
    `normaliseUnequalPools is accepted and ignored`; expects `pool_results_missing` on pool "B", identically with the
    flag set and absent.
  - `:667` "groups_ko's real bestNth remainder resolves against unequal pools" (3/3/2/2, flag, no results; was 7
    qualifiers) → expects `pool_results_missing` on pool "A" (k(A) = 3 − 2 = 1, first in pools order). Its app twin,
    `lib/__tests__/format-templates.test.ts` "A1 fix" (~:345), is app PR B's to move, in its bump commit, where results
    are passed and the engine is 10.0.0 together (G4).
  - `:1095` "normaliseUnequalPools:true (drop the bottom side, refold) flips the pick" (equal 4/4 with results; was B3)
    → retitle `normaliseUnequalPools:true over equal pools drops nothing (RB5-U6, ruling 286)`; expects `["A3"]`, the
    raw pick of the test above it (:1086), because k = 4 − 4 = 0.
  - `:702` (nth 3 over 3/3/2/2) is unchanged: `rowAtRank` runs before the missing-results check, so it still throws
    "takes rank 3, but only 2 entrant". `src/core/errors.test.ts:63` still passes (the code stays in the union).
- Rows

**Interfaces:**
- Consumes: `crossGroupOrder` (:678-704), `resultsAmong` / `foldResults` (standings.ts) as today.
- Produces: `PoolTable.expunged`, `ResolvedProgressionEntry.pool` and `.basis`, `ComparisonBasis` (block above). T6
  consumes `.pool` through the app (no import). Consumer: app PR B Task 4, which is also `expunged`'s PRODUCER (both
  `SourceTables` builders, from the withdrawal ledger's expunge mode, driven through the real snapshot path); no
  engine code writes `expunged` (F4: the seam is wired by B or it is not shipped).

- [ ] **Step 1: Write the failing tests** (every expected k and match count derived from pool sizes per RB5-U1/U7):
  - Empty first: one pool (no comparison) → `basis.dropped: []`.
  - `X-UP-5 equal pools drop nothing`: two pools of 4, nth 2, `normaliseUnequalPools: true` → `dropped: []`,
    `matchesCounted: 3`. **`// differential: today the flag drops the bottom result even here (:652-664): the refolded
    row shows played 2`** (Review Focus 3).
  - `X-UP-1 the larger pool's candidate is compared without the bottom result`: A (5) / B (4), nth 2, count 1, flag
    absent, football 3/1/0, single leg, results passed. A: a1 beats all (12); a2 L a1, W a3, D a4, W a5 (7); a3 L a1,
    L a2, W a4, W a5 (6); a4 L a1, D a2, L a3, W a5 (4); a5 loses all (0). B: b1 beats all (9); b2 L b1, W b3, W b4
    (6); b3 L b1, L b2, W b4 (3); b4 loses all (0). k(A) = 1, k(B) = 0 → a2 refolded without v a5 = 4 points from 3,
    b2 = 6 from 3 → **b2 qualifies**; raw would take a2 (7 > 6), and today's flag (k = 1 everywhere: a2 4, b2 3) would
    take a2 too. `basis = { nth: 2, matchesCounted: 3, dropped: [{ pool: "A", against: ["a5"] }] }` (`// RB5-U1`).
    **`// differential: today SEEDING_BESTNTH_UNEQUAL_POOLS (:825-836)`**.
  - `X-UP-1 k is the size difference to the smallest pool`: 5 / 4 / 3 → A drops 2, B drops 1, C drops 0
    (`// differential: today k = 1 for every pool with the flag`).
  - `X-UP-4 the bottom is the pool's own last, lots included`: the two bottom rows level, split by a stored lots draw
    → the drawn-last one is dropped.
  - `X-UP-5 an expunged entrant is not dropped again`: A (5) with a5 in `expunged`, B (4) → effective 4 / 4, `dropped: []`.
  - `X-UP-2 then the cross-pool cascade`: the refolded rows ordered by `crossGroup.order` (`SourceTables.crossGroup`).
  - `X-UP-3 the basis rides on every best_nth entry`, and `.pool` names each candidate's source pool.
  - `X-UP-3 levelWith names the cross-pool residual class` (G3): three pools, nth 2, equal sizes, results passed; a2
    and c2 level on every key of `crossGroup.order` (`["points","diff","for","wins"]`) and split by a stored lots draw,
    b2 ahead on points → a2.levelWith = ["c2"], c2.levelWith = ["a2"], b2.levelWith = []. Differential case: b2's own
    pool row carries `tieUnbroken: true` (a within-pool lots tie for 2nd) → b2's entry has `tieUnbroken: true` yet
    `levelWith: []` (the two flags differ, which is why `PooledSeed.tied` never reads `tieUnbroken`).
  - Review Focus 4: k > 0 with `results` absent → `pool_results_missing` naming the pool.
  - Sweep: complete single-leg pools of sizes 2..6 × 2..4 pools, nth 1..2: every candidate's refolded `played` equals
    the smallest pool size − 1; asserts the count checked AND that at least one case was unequal (RB5-E7).
  - Sequence: the same spec resolved twice → equal entries; with results present, two bestNth rules at one nth with
    different flags now share one ordering and collide on the entrant dedupe (`QUALIFICATION_INVALID`) exactly as two
    equal rules do; after a withdrawal (a5 in `expunged`) the X-UP-1 scene compares on 4 / 4, k = 0.
- [ ] **Step 2: Run** the verify command on `src/competition/progression-unequal-w5.test.ts src/competition/progression.test.ts src/competition/cross-group-w2d.test.ts src/core/errors.test.ts`.
  Expected: the new file FAILS and the five rewritten `progression.test.ts` tests FAIL (they assert the new answers);
  everything else passes.
- [ ] **Step 3: Implement**: generalise `normalisedRow(table, candidateId, k)`; compute k per pool from effective
  sizes; remove the refusal; drop the flag from the cache key; carry `pool` and `basis` (with `levelWith` from a ranking
  of the compared rows with their pool trace stripped; the qualifier ORDER stays the existing `crossGroupOrder` call's).
- [ ] **Step 4: Run** the same command; tsc; eslint; `pnpm boundary`. Expected: PASS.
- [ ] **Step 5: Mutate** (k = 1 always → `X-UP-5 equal pools drop nothing` and `:1095` red; k = 0 always → X-UP-1
  reds; drop from the top → `X-UP-4` reds; count expunged in the size → `X-UP-5 an expunged entrant…` reds; drop the
  missing-results refusal → Review Focus 4 and `:578` red; run the results check before `rowAtRank` → `:702` reds;
  derive `levelWith` from the row's `tieUnbroken` instead of the stripped ranking → `X-UP-3 levelWith…` reds):
  each reds the named test; restore.
- [ ] **Step 6: Rows** X-UP-1..5 proved by `packages/engine/src/competition/progression-unequal-w5.test.ts`.
- [ ] **Step 7: Commit** `feat(progression): best-Nth compares unequal pools on k = size − min, always on (X-UP-1..5; ruling 286)`.

### Task 6: `crossPoolDraw` (B5; X-PD-1..7)

**Model:** implementer Opus; reviewer Opus (subtle engine correctness).

**Files:**
- Modify: `src/scheduling/bracket.ts` (add after `crossPoolSeedOrder` :257-267; uses `seedPositions` :52-64,
  `nextPowerOfTwo` :40-44; adds `import { shuffle } from "../core/rng.ts";` beside :6-8)
- Test: `src/scheduling/bracket-cross-pool-w5.test.ts` (new)
- Rows

**Interfaces:**
- Consumes: `shuffle(seed, items)` (`core/rng.ts`, mulberry32 Fisher–Yates). Produces `crossPoolDraw(seeded, shape,
  drawSeed)`, `PooledSeed`, `FirstRoundShape`, `CrossPoolDraw` (block above). Consumer: app PR B Task 5 builds
  `PooledSeed[]` from `ResolvedProgressionEntry.pool` (T5), tier = `descriptor.rank` (group_rank) or `descriptor.nth`
  (best_nth), `tied` per the field's CONTRACT (G3: best_nth from `basis.levelWith`; group_rank from its own
  `crossGroupOrder` over the tier's stripped rows; never `tieUnbroken`), and passes the destination stage's stored draw
  seed (W4 RB4-D4), which it shows; B's replay test ("the same seed reproduces the draw") holds against this API (F3),
  and B's tie test drives two pools whose same-rank rows are level across pools through the real tables (G3).

- [ ] **Step 1: Write the failing tests** (expected pairs derived from `seedPositions` and RB5-D2/D10's search rule):
  - Empty first: `[]` → `no_qualifiers`; tiers [1, 2, 1] → `tiers_out_of_order`; `drawSeed` NaN → `draw_seed_invalid`;
    `tied: true` on seed 1, and on the first seed of tier 2 → `tie_link_invalid` (G3).
  - `X-PD-2 rank then rotation`: A1, B1, A2, B2 into 4 → round one A1 v B2, A2 v B1, unchanged order (`// RB5-D2`;
    already separated by the fold, a pin).
  - `X-PD-1 no pool-mates in round one`: A1, B1, C1, A2, B2, C2 into 8 → order A1, B1, C1, A2, C2, B2; round one
    A1 bye, B1 bye, C2 v A2, C1 v B2. **`// differential: today the fold gives C1 v C2 (seedPositions(8) = [1,8,5,4,3,6,7,2], pair 3v6)`**.
  - `X-PD-1 property`: pool counts 2–6, top 1–2 per pool, all draw sizes that arise, no `tied`: for every case where
    a separating ordering exists among the orderings RB5-D10 allows (tier 1 fixed, each later tier permuted only
    within itself — the test's independent brute force enumerates exactly that set, never all permutations, or it
    would find separations `crossPoolDraw` may not produce), `crossPoolDraw` separates; where none exists it refuses;
    asserts the count checked and that both outcomes occurred.
  - `X-PD-3 rank ties are drawn with the stored draw seed`: A1, B1, C1 tier 1 with B1 and C1 `tied` (level records),
    A2, B2, C2 tier 2, into 8, `drawSeed` 7 → step 1 orders the tied run as `shuffle(7, ["B1","C1"])` (computed in the
    test from `core/rng.ts`, the engine's declared generator, not from `crossPoolDraw`), then the search separates;
    `// RB5-D3`. A sweep over drawSeed 1..50 on that input asserts every result is separating, counts 50, and asserts
    at least two distinct tier-1 orders occurred (the seed is live, not ignored).
  - `X-PD-3 deterministic`: the same (seeded, shape, drawSeed) twice → equal output (`// RB5-D7`: Rebuild with the
    stored seed reproduces the draw); with no `tied` anywhere, two different seeds → equal output (D2's rotation is
    not randomised).
  - `X-PD-4 impossible separation is refused`: Review Focus 1, A1, B1, B2 (tiers 1, 1, 2) single_elim →
    `pool_separation_impossible` `{ shape: "single_elim", entrants: 3, supplies: { A: 1, B: 2 } }` (kept refused,
    ruling 288); and A1, B1, A2, A3 (tiers 1, 1, 2, 3) into 4 → refused `{ entrants: 4, supplies: { A: 3,
    B: 1 } }` (seedPositions(4) = [1,4,3,2] pairs seeds 1 v 4 and 2 v 3; tiers 2 and 3 hold one entrant each, so no
    permutation exists and A1 v A3 is forced; by pigeonhole any 4-draw with three from A pairs two of them).
  - `X-PD-5 round two follows the fold`: `generateSingleElim({ entrants: order, seeds: positional, slotOrder })` wires
    round 2 as the standard fold does (pool-mates may meet).
  - `X-PD-6 byes stay on the top seeds and never force a pair`: in the 8-draw case the byes are seeds 1–2 (A1, B1).
  - `X-PD-7 a stepladder or page playoff takes the same rotation`: stepladder A1, B1, C1, A2, B2, C2 (rung = seeds 5, 6)
    and page playoff A1, B1, A2, B2 separate; stepladder A1, B1, B2 → refused (Review Focus 1).
  - Sequence: n = 2 (one pair, two pools) passes; n = 2 one pool → refused.
- [ ] **Step 2: Run** the verify command on `src/scheduling/bracket-cross-pool-w5.test.ts src/scheduling/bracket.test.ts`.
  Expected: the new file FAILS.
- [ ] **Step 3: Implement `crossPoolDraw`** (step 1: `shuffle(drawSeed, run)` per tied run; step 2: depth-first over
  tiers ≥ 2, prune a branch at the first same-pool pair it completes).
- [ ] **Step 4: Run** the same command; tsc; eslint; `pnpm boundary`. Expected: PASS.
- [ ] **Step 5: Mutate** (allow tier 1 to move → X-PD-4's first case stops refusing; constrain bye pairs → X-PD-6
  reds; refuse at the first conflict instead of searching → X-PD-1 reds; skip the tier-order guard → the empty-first
  test reds; ignore `drawSeed` (skip step 1) → `X-PD-3 rank ties are drawn…` reds; shuffle every tier, not only tied
  runs → `X-PD-3 deterministic`'s no-tied case reds; accept a `tied` link across tiers → the `tie_link_invalid` empty
  case reds): each reds the named test; restore.
- [ ] **Step 6: Rows** X-PD-1..7 proved by `packages/engine/src/scheduling/bracket-cross-pool-w5.test.ts`.
- [ ] **Step 7: Commit** `feat(bracket): crossPoolDraw, no pool-mates in the first round (X-PD-1..7)`.

### Task 7: Frozen qualification markers (B6; X-QS-1)

**Model:** implementer Opus; reviewer Sonnet (high effort).

**Files:**
- Modify: `src/competition/qualification.ts` (`QualStatus` :10-14, `QualificationInput` :29-40, `qualificationStatus` :92-118)
- Test: `src/competition/qualification.test.ts` (existing; add a W5 block)
- Rows

**Interfaces:** Produces `{ kind: "qualified" }`, `QualificationInput.qualified` / `.order` (block above). Consumer:
app PR B Task 6 passes `qualified` from the confirmed proposal or `config.qualified`, else `order` from the final table.

- [ ] **Step 1: Write the failing tests**:
  - Empty first: `!anyPlayed && !complete` → null (unchanged); complete with neither `qualified` nor `order` → null.
  - `X-QS-1 a complete stage reads qualified or out`: 4 rows, cut 2, `order` [a, b, c, d] → a, b `{qualified}`, c, d
    `{out}`. **`// differential: today null (qualification.ts:95)`**.
  - `X-QS-1 who actually went through wins over the cut`: `qualified` {a, c} → c `{qualified}`, b `{out}` (RB5-T14).
  - `X-QS-1 a departed row stays null`: an inactive b with `order` [a, b, c, d], cut 2 → a, c qualified, b null.
  - `X-QS-1 an incomplete stage is unchanged`: the file's existing open-stage assertions still pass (pinned).
  - Sequence: complete with `anyPlayed: false` → markers from `order`; a wins-based `perMatch` freezes the same way.
- [ ] **Step 2: Run** the verify command on `src/competition/qualification.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the complete branch before the open computation.
- [ ] **Step 4: Run** the same command; tsc; eslint. Expected: PASS.
- [ ] **Step 5: Mutate** (null when complete; ignore `qualified`; count inactive rows into the cut): each reds; restore.
- [ ] **Step 6: Rows** X-QS-1 proved by `packages/engine/src/competition/qualification.test.ts`.
- [ ] **Step 7: Commit** `feat(qualification): frozen Qualified / Out markers on a complete stage (X-QS-1)`.

### Task 8: Points adjustments with a reason (B6; X-ADJ-1..3)

**Model:** implementer Opus; reviewer Sonnet (high effort). B5–B6 batch review after this task: Opus.

The fold mechanism exists (`openingDeltas`, stage.ts:343-348). New: a reasoned adjustment list, its refusals, its
notes. No `applyPointsRule` (it does not exist), no points-metric lookup (every table folds `StandingsRow.points`).

**Files:**
- Modify: `src/competition/points.ts` (add the types and `validatePointsAdjustments` after `RankLock` :670),
  `src/competition/stage.ts` (`TableStageFields.adjustments`; fold beside openings :343-355),
  `src/competition/progression.ts` (`PoolTable.notes`)
- Test: `src/competition/points-adjustments-w5.test.ts` (new)
- Rows

**Interfaces:** Produces `PointsAdjustment`, `AdjustmentNote`, `validatePointsAdjustments`,
`TableStageFields.adjustments`, `PoolTable.notes` (block above). Consumer: app PR B Task 7 (`at` = the ledger row's
created date; `openingDeltas`/`carry_deltas` untouched). RB5-T15's "no points metric" clause has no engine case and no
test here (dropped by ruling 288). An adjustment folds as
`{ entrantId, played: 0, won: 0, drawn: 0, lost: 0, points: delta, metrics: {} }` with the pool's openings and counts
toward `countedFixtures` like a carried opening with points (stage.ts:354; plan's call).

- [ ] **Step 1: Write the failing tests**:
  - Empty first: `adjustments: []` and absent → tables equal to today's, `notes` absent.
  - `X-ADJ-3 a zero or reasonless adjustment is refused`: delta 0 → `adjustment_zero`; reason "  " →
    `adjustment_reason_missing`; NaN → `adjustment_not_finite`; an unknown entrant → `adjustment_unknown_entrant`.
    **`// differential: today a zero opening delta folds silently and carries no reason (stage.ts:344-348)`**.
  - `X-ADJ-1 an adjustment folds before the cascade and is noted`: football, the leader on 3 points takes −3 → 0 and
    the table re-ranks; the pool's `notes` is `[{ kind: "adjustment", entrantId, delta: -3, reason, at }]` (`// RB5-T7`).
  - `X-ADJ-2 N is a match's worth where points are matches won`: `forEachSport`, one adjustment of
    `module.tablePointsRule(cfg, "league").win.regulation` per sport (the resolver behind `resolveTableRules`,
    table-rules.ts:125) moves the row by exactly that; asserts the sport count returned by `forEachSport`.
  - Review Focus 5: nothing played, C −3 → C ranks last.
  - Sequence: two ledger rows apply twice; the same list folded twice gives equal tables; an adjustment for an entrant
    who later withdrew (results expunged) still applies and is still noted; a Swiss ledger stage folds it into points.
- [ ] **Step 2: Run** the verify command on `src/competition/points-adjustments-w5.test.ts src/competition/stage.test.ts`.
  Expected: the new file FAILS.
- [ ] **Step 3: Implement** the validator, the fold and the notes.
- [ ] **Step 4: Run** the same command; tsc; eslint; `pnpm boundary`. Expected: PASS.
- [ ] **Step 5: Mutate** (skip the zero check; skip the reason check; leave adjustments out of `countedFixtures`; drop
  the notes): each reds a named test; restore.
- [ ] **Step 6: Rows** X-ADJ-1..3 proved by `packages/engine/src/competition/points-adjustments-w5.test.ts`.
- [ ] **Step 7: Commit** `feat(points): reasoned points adjustments folded before the cascade (X-ADJ-1..3)`.

### Task 9: App PR A proof close-out (B7; GATED, Gate 3)

**Model:** implementer Opus (engine-repo edits); reviewer Sonnet (high effort).

E owns this commit (app PR A's last task only hands over the file-to-id list).

**Files:**
- Modify: `rules/cross-sport.md`, `test/rules-reference.ts` (the 37 `"W5 app PR A"` entries)

- [ ] **Step 1: Gate**: `gh pr list --repo onryde/seazn.club --head feat/w5-round-robin-app-a --state merged` names it;
  else stop.
- [ ] **Step 2: For each of the 37 rows**, fill `proved by` with the `apps/web/...` (and `e2e/...`) test files app PR A
  merged whose titles hold the id as a whole token, `enforced at` with its usecase, drop the citation note, delete the
  entry. Append app PR A's proving paths to the engine rows X-CU-4 (finished rounds byte-equal, round numbers kept),
  X-PO-3 (the write-time check) and X-RT-1 (the in-match DQ cascade, ruling 289; app PR A titles that test
  `X-RT-1 …` and lists X-RT-1 in its hand-over, G2 — append only a file whose title holds the id, or the app checker reds
  at B's bump). No path is appended to X-RR-4 or X-RR-5 (app PR A carries no app half of either).
- [ ] **Step 3: Verify**: `cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/t9.json" test/rules-reference.test.ts; echo "EXIT=$?"`
  and the node summary. Expected: `EXIT=0`, `failedSuites=0`; `grep -c '"W5 app PR A' test/rules-reference.ts` is 0.
  The app paths are checked by seazn.club's checker at B's bump; T10's PR body lists them.
- [ ] **Step 4: Mutate once:** restore one deleted entry (X-CU-6) while its row carries `proved by`; re-run Step 3 →
  red (an awaiting entry on a proved row, :303-306); delete it again.
- [ ] **Step 5: Commit** `docs(rules): W5 app PR A rows proved` (body: the id → file list).
- [ ] **Step 6: App-side map for the bump** (handed to app PR B Task 0): after the bump to the major T10 releases
  `scripts/lib/rules-reference.ts:41` holds exactly the W5 ids 10.0.0 still awaits — X-QS-2, X-ADJ-4, X-ADJ-5 — so B
  deletes the other 71 W5 entries in its bump commit; and the `AMENDED_TEXT` edits for any amendment 10.0.0 carries
  that 9.1.0 did not.

### Task 10: Open the engine PR and release the next major (10.0.0 today) (B8)

**Model:** implementer Opus; the whole-PR review before Step 4 runs on Opus.

- [ ] **Step 1: Changeset**: `.changeset/w5-round-robin-engine.md`, `major`. BREAKING lines (the W4 release's precedent,
  CHANGELOG.md:104, "BREAKING: `TakeRule` gains `{ kind: "firstLosses" }`", treats a new union member as breaking):
  `QualStatus` gains `{ kind: "qualified" }`; a complete stage with an order source no longer returns null; bestNth no
  longer refuses unequal pools and ignores `normaliseUnequalPools`; **bestNth over unequal pools now needs
  `PoolTable.results`** (STAGE_NOT_READY `pool_results_missing`; a caller that passed none and set the flag resolved
  on raw rows before); a caller passing results over equal pools with the flag stops dropping a result;
  `completeTableStage` with `pools` refuses a pool under two, invalid rank locks, invalid adjustments and a result
  naming an unseated entrant by name. Added: `roundRobinLineKey`, `lateEntryFixtures`, `crossPoolDraw` (takes the
  stored draw seed), `validatePoolSizes`, `validateRankLocks`, `validatePointsAdjustments`, the `entrant_withdrawn`
  counts, `ResolvedProgressionEntry.pool` / `.basis`, `PoolTable.expunged` / `.notes`.
  `cd "$WT" && pnpm fold-epoch:check --against origin/main; echo "EXIT=$?"` → `EXIT=0`, no epoch move.
- [ ] **Step 2: Branch gate**: one scoped verify run over exactly the test files T1–T8 touched
  (`src/scheduling/roundrobin.test.ts src/scheduling/catch-up.test.ts src/competition/stage-pools-w5.test.ts src/competition/stage.test.ts src/competition/stage-withdrawal-w5.test.ts src/competition/progression-unequal-w5.test.ts src/competition/progression.test.ts src/competition/cross-group-w2d.test.ts src/core/errors.test.ts src/scheduling/bracket-cross-pool-w5.test.ts src/scheduling/bracket.test.ts src/competition/qualification.test.ts src/competition/points-adjustments-w5.test.ts`)
  plus `test/rules-reference.test.ts` and `test/stryker-groups.test.ts`; tsc; eslint on changed files;
  `pnpm boundary`; `pnpm single-sport --check --against origin/main`. Expected: every `EXIT=0`, `failedSuites=0`;
  zero `"W5 engine PR"` and zero `"W5 app PR A"` entries; the three `"W5 app PR B"` entries present.
- [ ] **Step 3: PR body**: `Matrix rows: league, league_ko, groups_ko, group_stepladder, group_playoffs, group_only, group_group_ko`;
  the plan's calls (catch-up home side; earliest-round ties by listed order; adjustment counts as counted;
  matchesCounted = max played; `entrant_unseated` only when a result names the entrant); owner questions:
  none (rulings 287–290 answered every REC; cite them where they apply); the stryker
  legs to re-measure; every `mutation:` line.
- [ ] **Step 4: Push and open** `feat/w5-round-robin-engine` against engine main; run the Opus whole-PR review first;
  hand back. The owner merges; the release is cut with the `engine-release` skill (`pnpm changeset version`; the
  version is the next major at release time — read `CHANGELOG.md`'s top heading on engine main first: 10.0.0 if no other
  major landed, else the next one; hand the released number back). App PR B Task 0 bumps
  `apps/web/package.json:25` and `packages/reference/package.json:14` to `npm:@onryde/seazn-engine@^<that version>`,
  passes pool `results` in both `SourceTables` builders in the same commit (G4), and applies T9 Step 6.
- [ ] **Step 5: App PR B close-out (orchestrator, after app PR B merges):** an engine docs PR fills `proved by` for
  X-QS-2, X-ADJ-4, X-ADJ-5 from app PR B's titled tests, deletes their three entries, and appends app PR B's paths to an
  engine-PR row (every id on app PR B's proofs hand-over list (B Task 9 Step 4), e.g. X-CU-*, X-UP-*, X-PD-*, X-ADJ-1..3, X-PO-1/2, X-WDT-4, X-WDT-7, X-RR-5, X-QS-1) ONLY where a B test's `it`/`describe` title holds that row's id as a
  token (G8; B's hand-over lists only such ids) — an untitled path reds the app checker; then it releases the patch
  after T10's major (10.0.1 today; a patch changeset); then a seazn.club bump PR to that patch deletes the last three app
  entries, verified with
  `cd <that worktree> && npx vitest run --reporter=json --outputFile="$OUT/close.json" scripts/__tests__/rules-reference.test.ts; echo "EXIT=$?"`.

---

## Self-review (done at writing)

- **Coverage:** design §6.3's rows map to T1 (identity, byes recorded, counted properties), T2 (catch-up), T3 (seating,
  floor, rank locks), T4 (expunge decision; the finalized half is app PR A), T5 (unequal pools), T6 (cross-pool fold),
  T7 (frozen markers), T8 (adjustment), T0/T0b/T9/T10 (rows). Decisions sheet: every engine scope move is a task;
  rulings 287–290 are in T0's table (X-RR-6, X-PD-8, X-WDT-9, X-WDT-10, X-PO-4) and amendments; nothing is gated;
  R-UP is T5.
- **Type consistency:** `roundRobinLineKey(a, b, leg)` (T1) is T2's line key; `ResolvedProgressionEntry.pool` (T5) is
  what app PR B feeds `PooledSeed.pool` (T6); `PoolTable.notes` holds `AdjustmentNote` only (T8); the withdrawal
  footnote reads the event's counts (T4), not a note on the table.
- **Counts:** 34 engine ids = Status table rows B1–B6; 74 rows = 34 + 37 + 3; 74 entries; 69 generation cases;
  33 late cases; a..f owes 6.
- **Fix round 1 check:** no task deletes an app entry before the release carrying its proof (T0 → 9.1.0 → A; T9 →
  10.0.0 → B; T10 Step 5 → 10.0.1 → close-out). Every NEW/CHANGED signature names an app PR B consumer; app PR A
  consumes none. No row or amendment waits on the owner (rulings 287–290).
- **Fix round 2 check:** no 9.x window (results ride B's bump commit); the app half of T0 rides the standalone rows bump
  PR; `tied` is defined by contract and fed by `basis.levelWith` / B's own `crossGroupOrder`, never `tieUnbroken`;
  X-PD-8 has no "21"; X-RR-6 owes no migration; 287 is cited in the owner's words only.
