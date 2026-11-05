# W4 Knockout — Engine PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@onryde/seazn-engine` express the W4 knockout rules that live in the engine (design §6.1): no third-place match without two real semi-finals, a bracket stage that completes only when every fixture is settled, final ranks that can tie (shared 3rd, joint winners, vacant title, a vacant 3rd), a first-loss plate feed with its exclusions and a "field complete" predicate, counted draw properties across n, and the proof of the 14 engine-PR rule rows already recorded by engine PR #26. Released as **4.0.0**.

**Architecture:** Four seams. (1) `scheduling/bracket.ts`: `generateSingleElim` refuses a third-place match it cannot feed. (2) `competition/stage.ts`: `isBracketStageComplete` requires every fixture settled; `completeBracketStage` refuses otherwise; `bracketRanks` returns `FinalPlace[]` (`{ entrantId, rank }`) over the stage's declared `entrants`, with shared places only at 1–4; a new `bracketTitle` names champion / joint / vacant. (3) New `competition/first-loss.ts`: `firstLossField` over the source bracket's rows. (4) `competition/progression.ts`: a `firstLosses` take rule and `first_loss` slot, `placementTable` that keeps ties, and `rank_range` resolved by position so a cut through a shared place is flagged, never thrown.

**Tech Stack:** TypeScript (typescript-native / TS7), vitest 4, fast-check 3, zod 4, pnpm 10, changesets. Engine repo `onryde/seazn.club.engine`, base `main` (pins taken at 972a7c7 = release 3.0.2; `docs/w4-rule-rows` baf1273 changes no `src/` file).

**Spec:** `docs/superpowers/specs/2026-11-04-format-matrix-w4-knockout-design.md` (seazn.club, `docs/format-matrix-w4` tree; APPROVED, ruling 274). Scope: §6.1, plus §5.1–§5.3 and §5.5 for the rules and §12 for the rows. Read with `docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md` (§2, §3, §6, §8–§11) and `_INDEX.md` rulings 263–275 beside it. Engine rows: engine PR #26 (`docs/w4-rule-rows`), `rules/cross-sport.md` X-SD / X-PL / X-TP / X-CH / X-FR / X-SP, `test/rules-reference.ts` `AWAITING_PROOF`. Recon (machine-local; read-only): `/Users/ashokhein/seazn-artifacts/w4-recon/D-engine.md`.

## Status by batch

| Batch | Tasks | Rule ids proved (AWAITING_PROOF entries deleted) | Status |
|---|---|---|---|
| B1 Generation | T1, T2, T3 | X-SD-3, X-TP-5, X-SD-4, X-SD-5, X-SP-1, X-SP-2 (6) | ⏳ |
| B2 Completion | T4 | X-CH-7, X-TP-4 (2) | ⏳ |
| B3 Ranks that can tie | T5, T6, T7, T8 | X-FR-1, X-FR-2, X-CH-1, X-FR-3 (4) | ⏳ |
| B4 First-loss plate feed | T9, T10 | X-PL-3, X-PL-4 (2) | ⏳ |
| B5 Withdrawn seeds in stepladder / page playoff (conditional on a truth run) | T11 | none deleted: engine-half titles for X-SP-4, X-SP-5 (their entries stay "W4 app PR A") | ⏳ |
| B6 App PR A proof close-out (GATED on app PR A merged) | T12 | the 39 "W4 app PR A" rows | ⏳ |
| B7 Open the engine PR | T13 | — (checks all 14 + 39 gone, 17 "W4 app PR B" remain) | ⏳ |

Engine-PR total: **14** ids, exactly the 14 `"W4 engine PR"` entries in `AWAITING_PROOF` (`test/rules-reference.ts:56-72`).

## Global Constraints

- **Repo and tree.** Gate: engine PR #26 (`docs/w4-rule-rows`) is merged to engine main, so the rows and `AWAITING_PROOF` entries exist on the base (`gh pr view 26 --repo onryde/seazn.club.engine --json state` reads `MERGED`). If it is not, stop and hand back. Then: `git -C ~/github/seazn.club.engine fetch && git -C ~/github/seazn.club.engine worktree add ~/github/seazn.club.engine-worktrees/w4-knockout-engine -b feat/w4-knockout-engine origin/main`, and `pnpm install --frozen-lockfile` there. `WT=~/github/seazn.club.engine-worktrees/w4-knockout-engine`. Never edit `~/github/seazn.club`, the engine's main checkout (it is on another branch) or the `w4-rule-rows` worktree. Prefix every command with `cd "$WT" &&` in the same call.
- **Scratch.** Each agent writes to `OUT=<session scratchpad>/<agent-name>/`. Never `rm` a shared directory.
- **Scoped tests only.** Never `pnpm test`, `test:coverage`, `pnpm sim` or `sim:matrix`. Judge green only like this:
  ```
  cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/<task>.json" <paths>; echo "EXIT=$?"
  node -e 'const r=require(process.argv[1]);console.log(`${r.numPassedTests}/${r.numTotalTests} failedSuites=${r.numFailedTestSuites}`);for(const t of r.testResults)console.log(t.name)' "$OUT/<task>.json"
  ```
  Green = `EXIT=0`, passed equals total and total > 0, `failedSuites=0`, every name under `$WT`. Never add `--testTimeout`. Never trust an `rtk` summary; use `rtk proxy`.
- **Type and lint gates, every task:** `cd "$WT" && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo "EXIT=$?"` and `cd "$WT" && pnpm exec eslint --max-warnings 0 <changed files>; echo "EXIT=$?"`. `pnpm boundary` whenever an import is added (T5, T9, T10).
- **Expected values come from the rulebook or the engine's declarations, never from the code under test** (TEST-STRATEGY; `_RULES.md` R9). Every pinned number carries a one-line derivation comment (`// RB4-T2: both SF losers 3rd`). At least one case per guard has a right answer that differs from today's; mark it `// differential: today X`.
- **Anti-vacuity.** Every property, sweep and invariant counts what it checked and asserts the exact count; zero checked is a failure. The empty case is each rule set's first test (R13, R25).
- **Mutate every new guard once,** by hand, one at a time (delete it or revert to today's line); a named test must red; restore. Record `mutation: <guard> → <test name> red` in the commit body. Guards that cover for each other are mutated separately.
- **Sequence tests, every task:** a second call, an empty input, after a withdrawal or void, and another sport. Bracket generation and ranking read no sport module; such a test carries `// single-sport: bracket code is sport-agnostic (reads no SportModule)`, and `pnpm single-sport --check --against origin/main` must stay green.
- **Rank places (the table every ranking test derives from; RB4-T2, T3, T6, C1–C4, R1, R2, S7):**

  | Case | Ranks, in order |
  |---|---|
  | n = 2 | 1, 2 |
  | n = 3 (one real semi-final) | 1, 2, 3 |
  | n ≥ 4, Shared (no third-place fixture) | 1, 2, 3, 3, then 5 … strict |
  | n ≥ 4, Play-off decided | 1, 2, 3, 4, then 5 … |
  | Play-off, both sides out (double walkover) | 1, 2, 4, 4, then 5 … (3rd vacant) |
  | Play-off voided (plan's call: never a seed split, X-CH-5 by analogy) | 1, 2, 3, 3, then 5 … |
  | Joint winners | 1, 1, then the 3rd-place block as above, then 5 … |
  | Vacant title (final double walkover) | 2, 2, then the 3rd-place block, then 5 … |
  | double_elim, stepladder, page_playoff | strict 1 … n, except joint (1, 1, 3 …) and vacant (2, 2, 3 …) |

  Below the top block every rank is strict: order by elimination round (later first), then seed, then entrant id (X-FR-2), and each rank is `max(previous rank + 1, entrants already placed + 1)`. Two entrants may share a rank only at 1, 2, 3 or 4, and never more than two (X-FR-1).
- **Rule rows** (`rules/README.md` grammar). The 14 rows exist (PR #26) with `proved by` `—`. A proving commit, in ONE commit: deletes the id's `AWAITING_PROOF` entry (`test/rules-reference.ts:55-73`), fills `proved by` with every test file whose `it(`/`describe(` title holds the id as a whole token, fills `enforced at` where it reads `—`, and drops the citation's trailing note (`; not yet implemented (W4 engine PR)` or `; proof owed (W4 engine PR)`). Every path is written `packages/engine/...` (`ENGINE_ROW_PREFIX`, `test/rules-reference.ts:78`). Status and rule text stay exactly as signed. Never add `-KO-` to an id; never allocate a new id (a rule with no row is a finding for the orchestrator). Verify with `test/rules-reference.test.ts` in the same JSON-reported run. That test refuses a row that claims proof while its entry remains (`rules-reference.test.ts:118-119`) and a stale entry (`:303-305`).
- **Rows NOT touched here:** X-WD-4 is amended in the PR that proves X-CH-3 (app PR B's close-out patch), not here. X-DW-3 and CK-KO-1 were amended by #26. X-CH-5 was narrowed by ruling 275. The 17 `"W4 app PR B"` entries stay.
- **Line pins** were taken at 972a7c7. At worktree creation run `git diff --stat 972a7c7 HEAD -- src test/rules-reference.ts`. Any cited file in that list is re-pinned before its task starts.
- **Rulings:** 263–275 only (next free in `_INDEX.md` is 276; never claim one). Calls this plan makes are marked "(plan's call)" and listed in the PR body for the orchestrator.
- **Changeset: `major`** (4.0.0). Every public type break since 1.0.0 shipped as a major (CHANGELOG 2.0.0 `pairRound`, 3.0.0 `TIER_NAMES`); here `finalRanks`, `BracketStage.entrants`, `DivisionEvent`, `TakeRule` / `SlotDescriptor` and the stricter `isBracketStageComplete` break callers. No `FOLD_EPOCH` / `FOLD_MINOR` moves: `competition/` and `scheduling/` are rank-time, not folded (T13 Step 1 proves it with `pnpm fold-epoch:check`). One changeset file: `.changeset/w4-knockout-engine.md`.
- **Commits:** one or more per task, conventional (`feat(bracket): …`, `test(bracket): …`), ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Commit or push only when a step says so.

## Interfaces the app plan consumes (exact; app PR B is written against these)

```ts
// src/competition/stage.ts  (@seazn/engine/competition)
export interface FinalPlace { readonly entrantId: EntrantId; readonly rank: number }
/** Ranks two entrants may share (X-FR-1): joint winners 1, vacant title 2, shared 3rd 3, vacant 3rd 4. */
export const BRACKET_SHARED_RANKS: ReadonlySet<number>;            // {1, 2, 3, 4}
export type BracketTitle =
  | { readonly kind: "champion"; readonly entrantId: EntrantId }
  | { readonly kind: "joint"; readonly entrantIds: readonly [EntrantId, EntrantId] }
  | { readonly kind: "vacant"; readonly finalists: readonly [EntrantId, EntrantId] };
export interface BracketStage {
  id: string;
  kind: Extract<StageKind, "knockout" | "double_elim" | "stepladder" | "page_playoff">;
  seeds?: ReadonlyMap<EntrantId, number>;
  /** NEW, REQUIRED: every entrant of the stage, withdrawn and disqualified included. Ranks cover exactly these. */
  entrants: readonly EntrantId[];
}
export interface BracketFixture {
  // …existing fields…
  /** NEW (X-CH-4): the organiser declared joint winners on this unplayed final. Only on the deciding final, with both
   *  seats, no winner / loser / walkedOver, status "decided". */
  jointWinners?: true;
}
export type DivisionEvent = /* … */ | { type: "stage_completed"; stageId: string; finalRanks: FinalPlace[] } /* … */;
//   BREAKING for every stage kind: a table stage's finalRanks is its cross-pool order with rank = position (i + 1).
export interface CompletedBracketStage { events: DivisionEvent[]; finalRanks: FinalPlace[]; title: BracketTitle }
export function isBracketStageComplete(stage: BracketStage, fixtures: readonly BracketFixture[]): boolean;
//   now: ≥ 1 fixture, ≥ 1 isFinal, and EVERY fixture settled (decided | void | walkover).
export function undecidedBracketFixtures(fixtures: readonly BracketFixture[]): string[];   // ids, input order
export function completeBracketStage(stage: BracketStage, fixtures: readonly BracketFixture[]): CompletedBracketStage;
//   throws EngineError("STAGE_NOT_READY", …, { stageId, reason: "fixtures_undecided", undecided: string[] })
//       or EngineError("STAGE_NOT_READY", …, { stageId, reason: "no_final" }).
export function bracketRanks(stage: BracketStage, fixtures: readonly BracketFixture[]): FinalPlace[];
//   provisional on an unfinished bracket (never throws for being unfinished); sorted by rank, then seed, then id.
export function bracketTitle(fixtures: readonly BracketFixture[]): BracketTitle | undefined;
export function assertBracketPlaces(places: readonly FinalPlace[], entrants: readonly EntrantId[]): void; // throws Error

// src/scheduling/bracket.ts
// generateSingleElim({ thirdPlace: true }) where fewer than two semi-finals are real (n = 2, n = 3):
//   throws EngineError("CONFIG_INVALID", …, { reason: "third_place_needs_two_semis", entrants: n, realSemis: number })

// src/competition/first-loss.ts  (NEW; re-exported from @seazn/engine/competition)
export interface FirstLoss { readonly entrantId: EntrantId; readonly fixtureId: string; readonly round: number }
export interface FirstLossField {
  readonly complete: boolean;                 // every round-0 line settled, and every first match in round 1 settled
  readonly losers: readonly FirstLoss[];      // eligible (X-PL-3), round 0 first, then round 1, each in input order
  readonly excluded: readonly FirstLoss[];    // first loss by walkover / withdrawal / retirement / DQ (X-PL-4)
  readonly pending: readonly string[];        // fixture ids still owed; empty iff complete
}
export function firstLossField(rows: readonly BracketFixtureRow[]): FirstLossField;

// src/competition/progression.ts
export type TakeRule = /* … */ | { kind: "firstLosses" };                     // NEW
export type SlotDescriptor = /* … */ | { kind: "first_loss"; position: number }; // NEW
// descriptorKey → `first:${position}`; descriptorLabel → { key: "slot.first_loss", params: { n: position } }
export interface SourceShape { poolKeys: string[]; /** NEW: firstLossField(rows).losers.length, once complete */ firstLosses?: number }
export interface BracketFixtureRow {               // WIDENED; every new field optional, names and types as BracketFixture's
  round: number; loser?: EntrantId;
  id?: string; status?: FixtureStatus; home?: EntrantId; away?: EntrantId; winner?: EntrantId;
  walkedOver?: "loser" | "both"; bracket?: "WB" | "LB" | "GF"; thirdPlace?: boolean;
}
export function placementTable(finalRanks: readonly EntrantId[] | readonly FinalPlace[]): PoolTable;
//   EntrantId[] → rank i + 1 (unchanged); FinalPlace[] → rank kept, so a shared 3rd is two rows of rank 3.
// rank_range descriptors resolve by POSITION in the rank-sorted table; a cut through a shared rank sets tieUnbroken
//   on the qualifying row(s) with tieBreak = { key: "shared_place", with: <the tied ids> }.
```

Consumer-visible behaviour with no type change: a knockout with no third-place fixture ranks both semi-final losers 3rd (ruling 270 re-ranks history; app PR B owns the LOUD snapshot migration, X-FR-5); a stage with an unplayed third-place match is not complete.

## Review Focus

1. **A knockout_third_place stage that shrinks below 4 before Start** (a withdrawal, then Generate or Rebuild) now throws at generation. A person expects a named reason, never a 500 and never a silent bracket with no play-off. The engine half is the error's `reason`, `entrants` and `realSemis`. Pinned in T1; the app's copy is app PR B's.
2. **qualifying_main q = 3 taken from a Shared knockout source** (ranks 1, 2, 3, 3). A person expects a flagged tie for the organiser to pick, not an STAGE_NOT_READY at "rank 4" and not a silent seed split. Pinned in T8.
3. **A plate whose first-loss field holds two bye holders who meet in round 2** (n = 5 in an 8-draw: seeds 2 v 3), and a bye holder who wins round 2 by walkover and loses round 3. The first is in the plate; the second is not. Pinned in T9.
4. **A third-place match the organiser voided.** A person expects a shared 3rd, never 3rd/4th by seed. Pinned in T6.
5. **Ranks read mid-bracket** (provisional, an app read path calling `bracketRanks` before completion) must not trip the permutation guard or refuse. Only `completeBracketStage` refuses. Pinned in T5.

---

## B1 — Generation

### Task 1: No third-place match without two real semi-finals; a 2-entrant knockout is one final (3P-2; RB4-T4, RB4-E3; X-TP-5, X-SD-3)

**Files:**
- Modify: `src/scheduling/bracket.ts:215-231` (`generateSingleElim`)
- Create: `src/scheduling/bracket-w4.test.ts`
- Modify: `rules/cross-sport.md` (X-TP-5, X-SD-3), `test/rules-reference.ts` (delete both entries)

**Interfaces:**
- Produces: the `third_place_needs_two_semis` refusal above. A semi-final is real when its fixture carries no `award` (only round 0 can hold one, so only n = 3 has a bye semi); `semifinalIds` is `[]` at n = 2.

- [ ] **Step 1: Write the failing tests** (`describe("X-TP-5 …")`, `describe("X-SD-3 …")`).

```ts
const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const seeds = (n: number) => new Map(ids(n).map((id, i) => [id, i + 1]));
describe("X-TP-5 a third-place match needs two real semi-finals (RB4-T4)", () => {
  it("X-TP-5 n=3 with thirdPlace: refused CONFIG_INVALID third_place_needs_two_semis, realSemis 1", () => {
    expect(() => generateSingleElim({ entrants: ids(3), seeds: seeds(3), thirdPlace: true }))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID", data: expect.objectContaining({ reason: "third_place_needs_two_semis", entrants: 3, realSemis: 1 }) })); // differential: today a -3p fed by a bye award
  });
  it("X-TP-5 n=2 with thirdPlace: refused, realSemis 0", () => { /* same shape, entrants 2, realSemis 0 */ }); // differential: today silently omitted
  it("X-TP-5 n=4..64 with thirdPlace: exactly one -3p, fed by the losers of the two round rounds-2 fixtures, neither an award (counted)", () => {
    // checked === 61
  });
  it("X-TP-5 n=3 without thirdPlace still generates: 1 award, 1 real semi, 1 final", () => { /* … */ });
});
describe("X-SD-3 a knockout of 2 entrants is one final (RB4-E3)", () => {
  it("X-SD-3 n=2: one fixture, round 0, isFinal, both seats, no award, no thirdPlace; a second call is byte-identical", () => { /* … */ });
});
```
`EngineError` carries `code` and `data` (`src/core/errors.ts:134-143`); every refusal's named fields in this plan live in `data`.

- [ ] **Step 2: Run, expect FAIL** (`src/scheduling/bracket-w4.test.ts`).
- [ ] **Step 3: Implement.** In `generateSingleElim`, when `opts.thirdPlace === true`, count `realSemis` = semifinal fixtures without `award`. If `realSemis < 2` throw the refusal (message: `a third-place match needs two real semi-finals; ${n} entrants give ${realSemis}`). n < 2 still returns the empty bracket first (X-SD-1/2 are the app's refusals).
- [ ] **Step 4: Run, expect PASS:** `src/scheduling/bracket-w4.test.ts src/scheduling/bracket.test.ts src/scheduling/bracket-layout.test.ts src/testkit/simulation.test.ts`, plus tsc and eslint.
- [ ] **Step 5: Mutate.** (a) Check `semifinalIds.length === 2` again instead of `realSemis` → the n=3 test reds. (b) Return early instead of throwing → both refusal tests red.
- [ ] **Step 6: Rows.** X-TP-5 and X-SD-3: enforced at `packages/engine/src/scheduling/bracket.ts`; proved by `packages/engine/src/scheduling/bracket-w4.test.ts`. Delete both entries. Run `test/rules-reference.test.ts`.
- [ ] **Step 7: Commit** `feat(bracket): refuse a third-place match without two real semi-finals (3P-2, X-TP-5, X-SD-3)`.

**App seam (proved later):** app PR B hides the setting below 4 (X-TP-1) and maps the refusal to copy on Generate and Rebuild; the matrix Q3 script and the third-place e2e in `apps/web/e2e/knockout.spec.ts` drive it.

---

### Task 2: Fold and byes, counted across every n (SEED-R test half, K21; RB4-D1, RB4-D2; X-SD-4, X-SD-5)

**Files:**
- Test: `src/scheduling/bracket-w4.test.ts` (new `describe` blocks)
- Modify: `rules/cross-sport.md` (X-SD-4, X-SD-5), `test/rules-reference.ts`

**Interfaces:**
- Consumes: `generateSingleElim`, `GeneratedBracket` (unchanged). No production change: both rows are "proof owed" on existing code (`bracket.ts:52-64`, `:167-189`).

- [ ] **Step 1: Write the tests.** Enumerate n = 2 … 128 (not sampled), seeds 1..n by `seeds(n)`; `checked` counts sizes and the last `it` asserts `checked === 127`.
  - `X-SD-4 the fold, written from RB4-D1 not from seedPositions`: for size S, the two round-0 seats of line i hold seed numbers summing to S + 1 (a bye stands for seed > n); seed 1 is on line 0 home, seed 2 on line S/2 − 1 away; for every k with 2^k ≤ S, seeds 1..2^k fall in 2^k distinct sections of S / 2^k slots.
  - `X-SD-5 byes go to the top seeds: the award holders are exactly seeds 1..S−n`; each award fixture has `home === award`, no `away`, no `homeFrom`/`awayFrom` (an award, never a match); count S − n per size.
  - `X-SD-5 every entrant is placed exactly once in round 0` (home ∪ away ∪ award is a permutation of the n ids).
  - Sequence: a second call is byte-identical; a seeds map that reverses the input order still places seed 1 at the top; n = 0 and 1 give no fixtures; n − 1 after a withdrawal is covered by the enumeration.
- [ ] **Step 2: Run, expect PASS** (existing code). A red here is a finding: stop and report it with the size that failed.
- [ ] **Step 3: Mutate (proves the tests bite, not the code).** (a) Flip `i % 2 === 0` in `seedPositions` → the fold test reds. (b) `k <= n` → `k < n` in `entrantOfSeed` → the "exactly once" and bye tests red. Restore both.
- [ ] **Step 4: Rows.** X-SD-4 (stays `deviation 268`) and X-SD-5: proved by `packages/engine/src/scheduling/bracket-w4.test.ts`; enforced at unchanged. Delete both entries. Run `test/rules-reference.test.ts`.
- [ ] **Step 5: Commit** `test(bracket): fold and byes counted across n=2..128 (K21, X-SD-4, X-SD-5)`.

**App seam:** app PR A's random draw (X-SD-6/7) hands `generateSingleElim` the unseeded in drawn order; its counted usecase sweep (`apps/web/src/server/usecases/__tests__/bracket-placement-sweep.test.ts`, T8-b) proves byes still land on seeds through the real Generate.

---

### Task 3: Stepladder and page-playoff shapes: who plays whom (RB4-S1, RB4-S2; X-SP-1, X-SP-2)

**Files:**
- Test: `src/scheduling/bracket-w4.test.ts`
- Modify: `rules/cross-sport.md` (X-SP-1, X-SP-2), `test/rules-reference.ts`

**Interfaces:**
- Consumes: `generateStepladder` (`bracket.ts:406-432`), `generatePagePlayoff` (`:383-396`). No production change.

- [ ] **Step 1: Write the tests** (assert the seats and feeds, never "the stage completed"; brief trap 3).
  - `X-SP-1 stepladder k=2..16 (counted, 15)`: game 0 is seed k−1 (home) v seed k (away); game j (1..k−2) is seed k−1−j (home) v `{ fixtureId: "sl-g<j-1>", side: "winner" }`; only the last game is `isFinal`; k − 1 games; k < 2 gives none.
  - `X-SP-2 page playoff`: exactly `pp-q1` s1 v s2 (round 0), `pp-elim` s3 v s4 (round 0), `pp-q2` loser(pp-q1) v winner(pp-elim) (round 1), `pp-final` winner(pp-q1) v winner(pp-q2) (round 2, the only `isFinal`). n ∈ {0,1,2,3,5,6,7,8} refused CONFIG_INVALID (counted, 8).
  - Second call byte-identical for both.
- [ ] **Step 2: Run, expect PASS** (existing code); a red is a finding.
- [ ] **Step 3: Mutate.** Swap `loserOf`/`winnerOf` in `pp-q2` → X-SP-2 reds. Change `ordered[k - 2 - j]` to `ordered[k - 1 - j]` → X-SP-1 reds.
- [ ] **Step 4: Rows.** X-SP-1, X-SP-2: proved by `packages/engine/src/scheduling/bracket-w4.test.ts`. Delete both entries. Run the checker.
- [ ] **Step 5: Commit** `test(bracket): stepladder and page-playoff seats and feeds (X-SP-1, X-SP-2)`.

**App seam:** app PR A's stepladder / page-playoff withdrawal fixes (FX-G7, SL-1) and their L3 R4 ×11 re-baselines.

---

## B2 — Completion

### Task 4: A bracket stage completes only when every fixture is settled; a play-off holds completion (CH-1, AN-2 engine half, 3P-3; RB4-C7, RB4-T3; X-CH-7, X-TP-4)

**Files:**
- Modify: `src/competition/stage.ts:211-220` (`isBracketStageComplete`), `:422-431` (`completeBracketStage`)
- Modify: `src/competition/stage.test.ts:116-126` and `:237-241` (see Step 4)
- Create: `src/competition/bracket-complete-w4.test.ts`
- Modify: `rules/cross-sport.md` (X-CH-7, X-TP-4), `test/rules-reference.ts`

**Interfaces:**
- Produces: `isBracketStageComplete` (stricter), `undecidedBracketFixtures`, and `completeBracketStage`'s two refusals, exactly as in "Interfaces the app plan consumes". `completeBracketStage` keeps its EntrantId[] return until T5.

- [ ] **Step 1: Write the failing tests.**

```ts
const ko: BracketStage = { id: "ko", kind: "knockout" }; // T5 adds entrants
const sf = (id: string, h: string, a: string, w: string): BracketFixture =>
  ({ id, round: 0, status: "decided", home: h, away: a, winner: w, loser: w === h ? a : h });
describe("X-CH-7 a bracket stage completes only when every fixture is settled (RB4-C7)", () => {
  it("X-CH-7 the empty case first: no fixtures is not complete, and completeBracketStage refuses no_final", () => {
    expect(isBracketStageComplete(ko, [])).toBe(false);
    expect(() => completeBracketStage(ko, [])).toThrow(expect.objectContaining({ code: "STAGE_NOT_READY", data: expect.objectContaining({ reason: "no_final" }) }));
  });
  it("X-CH-7 AN-2: final in_play with no outcome → not complete; refused fixtures_undecided naming the final", () => {
    const f = [sf("sf1", "A", "D", "A"), sf("sf2", "B", "C", "B"), { id: "fin", round: 1, isFinal: true, status: "in_play" as const, home: "A", away: "B" }];
    expect(isBracketStageComplete(ko, f)).toBe(false);
    expect(() => completeBracketStage(ko, f)).toThrow(expect.objectContaining({ data: expect.objectContaining({ reason: "fixtures_undecided", undecided: ["fin"] }) })); // differential: today ranks A 1st
  });
  it("X-CH-7 CH-1: final decided but a semi still scheduled → not complete", () => { /* differential: today true */ });
  it("X-CH-7 void and walkover lines count as settled (a DE reset voided, a withdrawal walked over)", () => { /* … */ });
  it("X-CH-7 a second call on the same rows gives the same answer; undecidedBracketFixtures keeps input order", () => { /* … */ });
});
describe("X-TP-4 a stage with a third-place play-off is not complete until it is decided (RB4-T3)", () => {
  it("X-TP-4 final decided, -3p scheduled → not complete; undecided ['se-3p']", () => { /* differential: today complete */ });
  it("X-TP-4 -3p walked over (one side withdrew) → complete", () => { /* … */ });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `undecidedBracketFixtures` = ids of fixtures not in `SETTLED`. `isBracketStageComplete` = fixtures non-empty, some `isFinal`, and `undecidedBracketFixtures(fixtures).length === 0`. `completeBracketStage` checks `no_final` first, then `fixtures_undecided`, before ranking. Update the comment at `:211-212`.
- [ ] **Step 4: Repair the tests the rule changes, never weaken them.**
  - `stage.test.ts:116` "a bracket completes when its final is decided": keep it, and add the CH-1 case where a semi is still scheduled.
  - `stage.test.ts:237` "completes once the Final alone is decided, regardless of the other three" only toggles the final, so its title claims what it never tests (AGENTS class 4), and X-CH-7 makes the claim false. Retitle it "page playoff completes when all four fixtures are settled". Add the case where `pp-q2` is still scheduled → false.
- [ ] **Step 5: Run, expect PASS:** `src/competition/bracket-complete-w4.test.ts src/competition/stage.test.ts src/competition/w2b-tables.test.ts src/competition/division.test.ts src/testkit/simulation.test.ts`, tsc, eslint.
- [ ] **Step 6: Mutate.** (a) Restore the finals-only predicate → CH-1, AN-2 and X-TP-4 tests red. (b) Drop the refusal in `completeBracketStage` (predicate kept) → the AN-2 refusal test reds. Mutate them separately.
- [ ] **Step 7: Rows.** X-CH-7 and X-TP-4: enforced at `packages/engine/src/competition/stage.ts`; proved by `packages/engine/src/competition/bracket-complete-w4.test.ts`. Delete both entries. Run the checker.
- [ ] **Step 8: Commit** `feat(stage): a bracket completes only when every fixture is settled (CH-1, AN-2, 3P-3, X-CH-7, X-TP-4)`.

**App seam:** app PR A already refuses on its own completion path before the bump (design §6.2 AN-2). App PR B must re-read `apps/web/src/lib/division-phase.ts:716`, which assumes "a third-place playoff completes on its FINAL alone". The desk attention "Final decided — complete the stage" is X-CH-8 (app PR A). The played third place is proved by app PR B's e2e (`apps/web/e2e/bracket-finish.spec.ts`) and `scripts/smoke/suites/bracketFinish.ts`.

---

## B3 — Ranks that can tie

### Task 5: `FinalPlace`, declared entrants, the permutation guard, and the event shape (SH-3 shape half; RB4-R1; X-FR-1 part 1). BREAKING

**Files:**
- Modify: `src/competition/stage.ts`: `BracketStage` (`:145-155`), `DivisionEvent` (`:159-173`), `completeTableStage`'s event (`:351-352`), `CompletedBracketStage` / `completeBracketStage` (`:417-431`), `bracketRanks` (`:456-535`, return type and `entrants`)
- Modify: `src/competition/progression.ts:785-799` (`placementTable`, union input)
- Modify: `src/testkit/simulation.ts:829-851`, `:1123` (`entrants`, `finalRanks` shape, champion from `rank === 1`)
- Modify: the existing tests that build `BracketStage` or compare `finalRanks` arrays (`stage.test.ts`, `w2b-tables.test.ts`, `division.test.ts`, `lots-stored.test.ts`, `tiebreak-keys-w2d.test.ts`, `bracket-complete-w4.test.ts`). Do it mechanically: `entrants` added, and `["S1", …]` becomes `places("S1", …)`, a local helper giving rank i + 1. No expected order changes in this task.
- Create: `src/competition/bracket-ranks-w4.test.ts`

**Interfaces:**
- Produces: `FinalPlace`, `BRACKET_SHARED_RANKS`, `BracketStage.entrants` (required), `assertBracketPlaces`, `bracketRanks(...): FinalPlace[]`, `CompletedBracketStage.finalRanks: FinalPlace[]` (`title` arrives in T7), `stage_completed.finalRanks: FinalPlace[]`, and `placementTable(EntrantId[] | FinalPlace[])`.
- Ranks in this task stay strict (rank = position). T6 and T7 introduce the shared places.

- [ ] **Step 1: Write the failing tests** (`describe("X-FR-1 …")`).
  - `X-FR-1 the empty case first`: `entrants: []` with no fixtures → `[]`, and `assertBracketPlaces([], [])` passes.
  - `X-FR-1 an entrant in a fixture but not in stage.entrants → CONFIG_INVALID` (assumption → guard); a duplicated entrant in `entrants` → CONFIG_INVALID.
  - `X-FR-1 a declared entrant in no fixture (a departed qualifier whose line was voided) is ranked, last` (`// differential: today absent`).
  - `X-FR-1 assertBracketPlaces refuses`: a missing entrant, a duplicate, ranks out of order, three entrants at rank 3, and two at rank 5. Five cases, five throws.
  - `X-FR-1 mid-bracket ranks are provisional and valid`: `bracketRanks` on a half-played 8-draw returns all 8 entrants and `assertBracketPlaces` passes (Review Focus 5).
  - `X-FR-1 a table stage's stage_completed carries rank = position`: `completeTableStage` event equals `crossPoolOrder.map((entrantId, i) => ({ entrantId, rank: i + 1 }))`.
  - `X-FR-1 placementTable keeps a FinalPlace rank and numbers an EntrantId list i + 1`: a mixed or unsorted FinalPlace input → CONFIG_INVALID.
- [ ] **Step 2: Run, expect FAIL** (collect errors on the new exports are an acceptable red).
- [ ] **Step 3: Implement.** `bracketRanks` builds the entrant set from `stage.entrants`, guarded against the fixtures. It keeps today's strict order, maps it to `{ entrantId, rank }`, and calls `assertBracketPlaces` before returning. `assertBracketPlaces` checks: every entrant exactly once; ranks are positive integers, non-decreasing; any rank held by more than one entrant is in `BRACKET_SHARED_RANKS` and is held by exactly two. It throws plain `Error` (a wiring bug, as `walkedOverSides` does at `:435-450`). The `BracketStage` comment at `:147-152` ("never reads stage.kind") goes; T6 reads it.
- [ ] **Step 4: Fix the callers** (simulation, the tests listed). `pnpm boundary`.
- [ ] **Step 5: Run, expect PASS:** `src/competition/bracket-ranks-w4.test.ts src/competition/bracket-complete-w4.test.ts src/competition/stage.test.ts src/competition/w2b-tables.test.ts src/competition/division.test.ts src/competition/lots-stored.test.ts src/competition/tiebreak-keys-w2d.test.ts src/competition/progression.test.ts src/competition/qualification.test.ts src/testkit/simulation.test.ts`, tsc, eslint.
- [ ] **Step 6: Mutate.** (a) Skip the `assertBracketPlaces` call → the five-refusal test still passes (it calls the guard directly), so add, and expect red on, `X-FR-1 bracketRanks never returns a place set the guard refuses`. It feeds a fixture row naming an undeclared entrant and expects CONFIG_INVALID from `bracketRanks` itself. (b) Drop the undeclared-entrant check → that test reds. (c) Allow three at rank 3 in the guard → its case reds.
- [ ] **Step 7: Commit** (no row yet; X-FR-1 is proved after T7) `feat(stage)!: bracket ranks are FinalPlace[] over the stage's declared entrants (SH-3 shape, X-FR-1 part 1)`.

**App seam:** app PR B. `competition.ts:990` builds `BracketStage` and passes `entrants: inputs.entrants`. `writeSnapshot(placementTable(completed.finalRanks))` at `:1069` keeps ties. The ladder's own `stage_completed` at `:980` maps `ladder_order` to places. Every `finalRanks` reader is enumerated by behaviour (grep `finalRanks`, `placementTable` and the placement snapshot readers), per design §6.3.

---

### Task 6: Shared 3rd, the play-off's places, strict below the semi-finals (SH-3, Q4; RB4-T2, T3, T6, R2; X-FR-1 part 2, X-FR-2)

**Files:**
- Modify: `src/competition/stage.ts` `bracketRanks` (the top block before `rankRest`, `:519-533`)
- Create: `src/testkit/bracket-play.ts` (a test driver in the testkit convention; NOT added to `src/testkit/index.ts`; it imports only types from `src/competition` and the generator from `src/scheduling`)
- Test: `src/competition/bracket-ranks-w4.test.ts`
- Modify: the existing expectations the rule changes, each marked `// ruling 270: was 3/4 by seed` (`stage.test.ts:177-179`, `:189-193`; any other the run shows)

**Interfaces:**
- Consumes: T5's `FinalPlace`, `BracketStage.entrants`; T1's generator.
- Produces: `playOutBracket(gen: GeneratedBracket, opts: { winner?: (home: EntrantId, away: EntrantId) => EntrantId; forfeit?: ReadonlyMap<string, EntrantId>; doubleWalkover?: ReadonlySet<string>; voided?: ReadonlySet<string>; jointFinal?: boolean }): BracketFixture[]` in `src/testkit/bracket-play.ts`. It resolves `homeFrom`/`awayFrom` feeds round by round. A bye award becomes `status: "walkover"` with `winner` and no `loser`, as the app's `bracketWinnerLoser` writes it (`apps/web/src/server/engine-db/competition.ts:207-210`). A forfeit becomes `walkedOver: "loser"`, a double walkover `walkedOver: "both"` with dead onward seats. The default winner is the better seed.
- Ranking rule (the Global Constraints table). Only `kind === "knockout"` with a final round ≥ 1 gets the third-place block. The semi-finals are the non-`thirdPlace` fixtures at the final's round − 1.
  - No `thirdPlace` fixture: every semi-final `loser` ranks 3.
  - A settled `-3p` with a winner: the winner ranks 3 and the loser 4.
  - `-3p` with `walkedOver: "both"`: both seated sides rank 4.
  - A `void` `-3p`: the semi-final losers rank 3.
  - An unsettled `-3p`: today's strict order (provisional only; T4 refuses completion).
  - A semi-final double walkover's two sides go to the strict block (plan's call, rare; ranks per the `max(...)` rule).

- [ ] **Step 1: Write the failing tests** (`describe("X-FR-1 …")`, `describe("X-FR-2 …")`).
  - `X-FR-1 shared 3rd: the 4-draw from stage.test.ts ranks S3 and S4 both 3rd, nobody 4th` (`// differential: today S3 3, S4 4`).
  - `X-FR-1 counted sweep: Shared n=2..64, Play-off n=4..64 (T1 refuses it below 4)` via `generateSingleElim` + `playOutBracket`. The rank multiset equals the Global Constraints row for n (n = 2: [1,2]; n = 3: [1,2,3]; n ≥ 4 Shared: [1,2,3,3,5..n]; Play-off: [1..n]). `assertBracketPlaces` passes. The last `it` asserts `checked === 124`.
  - `X-FR-1 play-off with both sides out: 1, 2, 4, 4, 5 …` (`// differential: today 3/4 by seed`).
  - `X-FR-1 a voided play-off: both semi-final losers 3rd` (Review Focus 4).
  - `X-FR-1 a semi lost by walkover (the loser withdrew) still shares 3rd` (RB4-T2 has no exception; X-FR-3 puts them out at the semi).
  - `X-FR-1 n=3: the one real semi-final loser ranks 3rd alone` (RB4-E5).
  - `X-FR-1 double_elim, stepladder and page_playoff stay strict 1..n` (one played-out case each).
  - `X-FR-2 below the semi-finals: quarter-final losers rank 5–8 by seed, then id; equal 5th is not used (S7)`. Use an 8-draw with upsets, so seed order differs from bracket position, and include one QF loser with no seed (ranks after the seeded ones).
  - Sequence: a second call on the same rows gives the same places; after a withdrawal mid-bracket (`forfeit` at a QF) the multiset rule still holds.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the top block and the `max(previous rank + 1, placed + 1)` numbering. Within a shared rank, order by seed, then id.
- [ ] **Step 4: Update the expectations** listed above (only those the rulebook changes; each carries the ruling 270 comment). Any other changed expectation is a finding: report it, never edit it to green.
- [ ] **Step 5: Run, expect PASS** (T5's list plus `src/competition/bracket-ranks-w4.test.ts`).
- [ ] **Step 6: Mutate.** (a) Drop the no-`-3p` shared branch → the 4-draw and the sweep red. (b) Rank the `walkedOver: "both"` play-off as 3/4 → its test reds. (c) Number the strict block `previous + 1` instead of the `max(...)` → the sweep reds at n = 5 (expects 5, gets 4). (d) Apply the block to `double_elim` → its strict case reds.
- [ ] **Step 7: Rows.** X-FR-2: proved by `packages/engine/src/competition/bracket-ranks-w4.test.ts`. Delete its entry. (X-FR-1 waits for T7.) Run the checker.
- [ ] **Step 8: Commit** `feat(stage): semi-final losers share 3rd; ranks below the semis stay strict (SH-3, X-FR-2)`.

**App seam:** app PR B. Every surface shows the shared 3rd (bracket, public page, hub, embed, `/present`, OG, standings API); proved by `apps/web/e2e/hub-knockout.spec.ts` and `apps/web/e2e/bracket-finish.spec.ts`. The Q8 LOUD migration of stored snapshots (X-FR-5) and `packages/reference/src/families/bracket-finish.ts` (the oracle, written by a different agent) must agree.

---

### Task 7: The title: champion, joint winners, vacant (Q4; RB4-C1, C3, C4; X-CH-1, X-FR-1 part 3)

**Files:**
- Modify: `src/competition/stage.ts`: `BracketFixture` (`:55-71`, `jointWinners`), `bracketTitle` (new), `bracketRanks` (the title block, `:467-477`, `:519-522`), `completeBracketStage` (`title`)
- Test: `src/competition/bracket-ranks-w4.test.ts`
- Modify: `rules/cross-sport.md` (X-CH-1, X-FR-1), `test/rules-reference.ts`

**Interfaces:**
- Produces: `BracketTitle`, `bracketTitle`, `BracketFixture.jointWinners`, `CompletedBracketStage.title`.
  - The deciding final is the latest-round `isFinal` fixture that is settled and decided something: a `winner`, `jointWinners`, or `walkedOver: "both"`. A `void` final decides nothing (today's DE-reset rule, `:467-470`).
  - Champion → winner rank 1, loser rank 2. Joint → both rank 1. Vacant → both rank 2.
  - `completeBracketStage` throws CONFIG_INVALID when no title is determinable (assumption → guard: X-CH-1 says there is exactly one champion otherwise).
- `jointWinners` guards (plain `Error`, wiring bugs): only on `isFinal`; both seats; no `winner` / `loser` / `walkedOver`; status `"decided"`.

- [ ] **Step 1: Write the failing tests.**
  - `X-CH-1 the empty case: bracketTitle([]) is undefined`.
  - `X-CH-1 the champion is the decided final's winner; one champion`. Include a DE with a played reset, where the latest `gf-reset` winner is champion.
  - `X-CH-1 joint winners: both finalists rank 1st, nobody 2nd, semi-final losers 3rd` (X-FR-1 places [1,1,3,3,5…]; `// differential: today the finalists rank 1/2 by seed`).
  - `X-CH-1 vacant title: a final double walkover → title vacant, both finalists 2nd, nobody 1st` (`// differential: today 1/2 by seed`).
  - `X-CH-1 a vacant title reverses itself`: the same rows with the final re-decided, as an Undo / Reinstate would leave them, give a champion. A second call is stable.
  - `X-CH-1 jointWinners on a semi, with a winner, or on a scheduled final throws` (three cases).
  - `X-FR-1 counted: n=4..32 × {champion, joint, vacant} × {Shared, Play-off}` → multisets per the Global Constraints table; `checked === 174`.
  - `X-CH-1 page playoff and stepladder joint winners → 1, 1, 3, 4` (strict below).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `bracketTitle`, the title block in `bracketRanks`, and `title` on `completeBracketStage`.
- [ ] **Step 4: Run, expect PASS** (T6's list), tsc, eslint.
- [ ] **Step 5: Mutate.** (a) Treat `walkedOver: "both"` as no decision (today's filter) → the vacant tests red. (b) Drop each `jointWinners` guard in turn → its case reds. (c) Drop the no-title CONFIG_INVALID → add and red `X-CH-1 a settled final that decided nobody (void, no reset) refuses completion`.
- [ ] **Step 6: Rows.** X-CH-1 and X-FR-1: enforced at `packages/engine/src/competition/stage.ts`; proved by `packages/engine/src/competition/bracket-ranks-w4.test.ts`. Delete both entries. Run the checker.
- [ ] **Step 7: Commit** `feat(stage): joint winners and a vacant title in bracket ranks (Q4, X-CH-1, X-FR-1)`.

**App seam:** app PR B owns three pieces. (1) "Declare joint winners" writes the fixture state that maps to `jointWinners` (X-CH-4, X-CH-6). (2) A final double walkover is no longer refused (X-CH-3, superseding X-DW-3/X-WD-4 for a final). (3) The completion guard at `apps/web/src/server/engine-db/competition.ts:1008-1058` refuses unbeaten finalists, so it must admit a joint final, or joint winners never complete. `apps/web/src/server/public-site/champion.ts` reads `title`. The joint-winners and vacant-title e2e are in design §6.3.

---

### Task 8: A walkover loser is out at that fixture; tied places through progression (RB4-R3, RB4-Q2; X-FR-3)

**Files:**
- Modify: `src/competition/progression.ts:560-572` (`rowAtRank`'s `rank_range` path) and `:694-695` (its call)
- Test: `src/competition/bracket-ranks-w4.test.ts` (X-FR-3), `src/competition/progression-w4.test.ts` (new)
- Modify: `rules/cross-sport.md` (X-FR-3), `test/rules-reference.ts`

**Interfaces:**
- Consumes: T5's `placementTable(FinalPlace[])`.
- Produces: `rank_range` by position. Sort the single table's rows by `rank` (stable) and take position `rank` (the descriptor's number) as an index. When the row at that position shares its rank with a row outside the take's `from..to`, set `tieUnbroken: true` and `tieBreak: { key: "shared_place", with: <the other tied ids> }` on a clone. Strict tables give exactly today's rows. `group_rank` is unchanged (find by rank).

- [ ] **Step 1: Write the tests.**
  - `X-FR-3 a forfeit loser at a quarter-final is ranked out there even if a stale later row names them` (`stage.ts:485-497`; existing code).
  - `X-FR-3 both sides of a QF double walkover are out at the QF, and nobody seated later is ranked there`. Ranks and seats agree: for every entrant out at round r, no fixture with round > r seats them.
  - `X-FR-3 page playoff: a pp-q1 forfeit loser is out at round 0, never ranked by a pp-q2 row` (the rank order against the Eliminator loser is T11's).
  - `rank_range over a Shared knockout source: rankRange 1..4 takes the four semi-finalists, none flagged` (RB4-Q2, q at a whole round).
  - `rank_range 1..3 over ranks 1,2,3,3: both 3rds flagged tieUnbroken shared_place, never STAGE_NOT_READY` (Review Focus 2; `// differential: today the first rank-3 row, no flag`).
  - `rank_range 1..4 over 1,2,3,3: no row of rank 4 is needed` (`// differential: today STAGE_NOT_READY "takes rank 4"`).
  - The empty case: rankRange 1..2 over an empty table → today's STAGE_NOT_READY message, unchanged.
  - A strict 8-row table: rankRange 3..6 resolves the same rows as before (the regression pair).
- [ ] **Step 2: Run, expect FAIL** on the three `rank_range` tie cases. The X-FR-3 cases pass on existing code; a red there is a finding.
- [ ] **Step 3: Implement** the positional `rank_range` resolver.
- [ ] **Step 4: Run, expect PASS:** `src/competition/progression-w4.test.ts src/competition/progression.test.ts src/competition/qualification.test.ts src/competition/bracket-ranks-w4.test.ts src/testkit/simulation.test.ts`, tsc, eslint.
- [ ] **Step 5: Mutate.** (a) Find by rank value again → the 1..4 test reds. (b) Drop the straddle flag → the 1..3 test reds. (c) Pin `outAt` to the LAST walkover instead of the earliest (`:494`) → the stale-row X-FR-3 test reds.
- [ ] **Step 6: Rows.** X-FR-3: proved by `packages/engine/src/competition/bracket-ranks-w4.test.ts`. Delete its entry. Run the checker.
- [ ] **Step 7: Commit** `feat(progression): rank_range resolves tied places by position and flags a split (X-FR-3)`.

**App seam:** app PR A offers q only at whole rounds on a knockout source (X-QM-*, S2). App PR B's qualifying_main e2e reads a Shared source.

---

## B4 — First-loss plate feed

### Task 9: `firstLossField`: everyone's first loss, minus forfeits, with a field-complete predicate (PL-2, PL-1 feed half, PL-3 predicate; RB4-P1, P2, P3; X-PL-3, X-PL-4)

**Files:**
- Create: `src/competition/first-loss.ts`, `src/competition/first-loss.test.ts`
- Modify: `src/competition/progression.ts:449-452` (`BracketFixtureRow` widened, type-only import of `FixtureStatus` from `./stage.ts`), `src/competition/index.ts` (export)
- Modify: `rules/cross-sport.md` (X-PL-3, X-PL-4; append to X-SD-3's proved by), `test/rules-reference.ts`

**Interfaces:**
- Consumes: `SETTLED` from `./stage.ts`. `walkedOver` already marks every forfeit loser: the app's `bracketWinnerLoser` sets `walkedOver: "loser"` for any award with a seated loser, so walkover, retired, disqualified and withdrew alike (`apps/web/src/server/engine-db/competition.ts:207-210`). That is exactly X-PL-4's set. Thread it; do not invent a marker.
- Produces: `FirstLoss`, `FirstLossField`, `firstLossField`, as in "Interfaces the app plan consumes".
  - A *played* fixture is settled, has both seats, a `winner` and a `loser`, and no `walkedOver`.
  - Each entrant's **first match** is their round-0 line if it was played. Otherwise (they hold a bye award, a walkover win, or a voided line) it is their round-1 fixture.
  - If that match is played and lost → `losers`. Lost by forfeit (`walkedOver` "loser", or "both" on a seated side) → `excluded`. Won → neither.
  - Unsettled, or a round-0 non-player not yet seated in round 1 → its fixture id goes to `pending`.
  - A first match after round 1 does not exist for the plate (RB4-P3: the field is known after round 2).
- Refusals (CONFIG_INVALID): a row without `id` or `status`; a row with `bracket` "LB" or "GF" (the plate is a single-elimination feed). The engine's round 0 is the product's "round 1".

- [ ] **Step 1: Write the failing tests** (`describe("X-PL-3 …")`, `describe("X-PL-4 …")`). Build rows with `playOutBracket` (T6), then strip them to `BracketFixtureRow`.
  - `X-PL-3 the empty case first: no rows → complete, no losers, nothing pending`.
  - `X-PL-3 an 8-draw, no byes: the four round-1 losers, complete after round 1`.
  - `X-PL-3 n=5 (8-draw, fold lines (1,8b) (5,4) (3,6b) (7b,2), better seed wins): losers = [e5 (R1, 4 v 5), e3 (R2, bye holders 2 v 3 meet)]`. e4 won its first match, so it is not in the plate. e1 beats e4 in R2 (Review Focus 3). Expected membership derives from RB4-P1 and the fold of RB4-D1, not from the function.
  - `X-PL-3 a bye holder who wins round 2 is not in the plate, and a bye holder who wins R2 by walkover and loses R3 is not either`.
  - `X-PL-3 incomplete: a bye holder's round-2 line still scheduled → complete false, pending [that id]`.
  - `X-PL-4 excluded: R1 lost by walkover, by retirement, by disqualification and by withdrawal (all walkedOver "loser"), and both sides of an R1 double walkover`. Five losers, none in `losers`, all in `excluded`.
  - `X-PL-4 a late entrant's case-(1) line (newcomer v bye holder in round 0) feeds the plate like any other` (RB4-L14).
  - `X-PL-3 counted sweep`: n = 4 … 131 played out, every first loss eligible. `losers.length` equals the rulebook count, computed independently: (2n − S) / 2 round-0 losers, plus one for every round-2 line whose two seats are both bye holders. Under the driver's better-seed-wins rule, a bye holder loses its first match only to another bye holder. Count those lines from the RB4-D1 fold (seed pairs summing to S + 1, then line pairs), not from the generator. Named cases with `it.each`: n = 5, 6, 7, 9, 17, 33, 34, 35, 65, 66, 67, 129, 130, 131. Assert `checked === 128`.
  - `X-SD-3 n=2: one first loss, below the plate's minimum of 2 (X-PL-2 is the app's named outcome)`.
  - LB/GF rows and a row without status → CONFIG_INVALID.
  - Second call identical.
- [ ] **Step 2: Run, expect FAIL** (collect error on the new module).
- [ ] **Step 3: Implement** `src/competition/first-loss.ts`. Widen `BracketFixtureRow` (all new fields optional, so `roundLosers`/`loserAt` callers compile unchanged). If `pnpm boundary` refuses the `stage.ts` ↔ `progression.ts` type cycle, move `FixtureStatus` and `SETTLED` into a leaf `src/competition/fixture-status.ts` that both import, and re-export from `stage.ts` so the public names do not move.
- [ ] **Step 4: Run, expect PASS:** `src/competition/first-loss.test.ts src/competition/progression.test.ts src/competition/qualification.test.ts`, tsc, eslint, `pnpm boundary`.
- [ ] **Step 5: Mutate.** (a) Treat every round-0 non-player as eliminated (no round-1 look) → the n = 5 and bye-holder tests red. (b) Drop the `walkedOver` exclusion → X-PL-4 reds. (c) Mark complete without the round-1 check → the incomplete test reds. (d) Admit a round-2 (engine round 2) first match → the R3 bye-holder test reds.
- [ ] **Step 6: Rows.** X-PL-3, X-PL-4: enforced at `packages/engine/src/competition/first-loss.ts`; proved by `packages/engine/src/competition/first-loss.test.ts`. Append the same test path to X-SD-3's proved by. Delete both entries. Run the checker.
- [ ] **Step 7: Commit** `feat(plate): firstLossField — everyone's first loss, forfeits excluded, field-complete predicate (PL-2, X-PL-3, X-PL-4)`.

**App seam:** app PR B builds `BracketFixtureRow`s from the same `toBracketFixture` rows it already makes (`apps/web/src/server/usecases/stages.ts:5600-5642`). It proposes the plate when `complete` turns true (X-PL-5, X-PL-7) and completes a field under 2 with the named outcome (X-PL-2). The counted plate sweep in `bracket-placement-sweep.test.ts` (T8-b: allowlist removed, every offered n, 5/6/7/9/17 named) and the L3 ko_plate F1 ×11 re-baseline prove the seam.

---

### Task 10: The `firstLosses` take rule through progression (PL-1 feed, PL-2; RB4-P4; X-PL-3 resolver half)

**Files:**
- Modify: `src/competition/progression.ts`: `TakeRule` (`:42-47`), `SlotDescriptor` (`:74-78`), `SourceShape` (`:85-87`), `descriptorKey` / `descriptorLabel` (`:98-124`), `expandOne` (`:126-168`), `progressionSize` (`:176-184`), `validateProgressionAgainstShapes` (`:423-434`), `resolveProgression`'s descriptor branch (`:690-700`)
- Test: `src/competition/progression-w4.test.ts`

**Interfaces:**
- Consumes: T9's `firstLossField`.
- Produces: the `firstLosses` take and the `first_loss` slot.
  - `expandOne` yields one pot of `shape.firstLosses` descriptors, positions 1..count. An absent count yields an empty pot.
  - `progressionSize` adds 0 for `firstLosses` (callers size from `firstLossField`).
  - `validateProgressionAgainstShapes` skips its `< 2` refusal when a source takes `firstLosses` and its shape has no count: the field is known only after round 2, and X-PL-2 is the app's named outcome.
  - `resolveProgression` resolves `first_loss` position p to `firstLossField(src.bracket).losers[p − 1]`. It refuses STAGE_NOT_READY with `reason: "first_loss_field_incomplete"` while the field is incomplete, and with `reason: "first_loss_field_changed"` when the shape's count differs from the field.
  - There is no fixed q: every eligible first loss is a slot (RB4-P4).

- [ ] **Step 1: Write the failing tests.**
  - `X-PL-3 firstLosses at save time (no count) validates without the <2 refusal and expands to no slot`.
  - `X-PL-3 firstLosses resolves every eligible first loss of a 13-entrant bracket. 16-draw, byes to seeds 1–3. The driver's `winner` makes e3 (a bye holder) lose its R2 line, so there are 6 slots: the 5 round-1 losers ((2·13 − 16) / 2) plus e3, derived from RB4-P1` (`// differential: roundLosers{round:1,count:4} took 4`, PL-1).
  - `X-PL-3 incomplete field → STAGE_NOT_READY first_loss_field_incomplete`; `count 5 against that field of 6 → first_loss_field_changed`.
  - `descriptorKey first:3; descriptorLabel slot.first_loss {n: 3}`.
  - `roundLosers still resolves as before` (regression pair).
  - Second call identical; a forfeit loser never appears in a slot.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep `roundLosers` as is: deleting it would break stored progressions, and app PR B migrates them.
- [ ] **Step 4: Run, expect PASS:** `src/competition/progression-w4.test.ts src/competition/progression.test.ts src/competition/qualification.test.ts src/competition/first-loss.test.ts`, tsc, eslint, `pnpm boundary`.
- [ ] **Step 5: Mutate.** (a) Keep the `< 2` refusal → the save-time test reds. (b) Drop the incomplete refusal → its test reds. (c) Drop the count check → `first_loss_field_changed` reds.
- [ ] **Step 6: Rows.** Append `packages/engine/src/competition/progression-w4.test.ts` to X-PL-3's proved by (its entry was deleted in T9). Run the checker.
- [ ] **Step 7: Commit** `feat(progression): firstLosses take rule — the plate takes every eligible first loss (PL-1, X-PL-3)`.

**App seam:** app PR B adds `firstLosses` to the wire `ProgressionSchema` (OpenAPI drift check), adds `slot.first_loss` in 4 locales plus `pnpm i18n:gen-keys`, migrates stored `roundLosers{round:1,count:q}` plate progressions, and removes the builder's hidden Top N / q = 4.

---

## B5 — Withdrawn seeds in stepladder and page playoff (conditional)

### Task 11: Truth run, then the engine halves of SL-1 and FX-G7 (RB4-S4, RB4-S5; X-SP-4, X-SP-5 engine titles)

Design §6.1 puts SL-1 in the engine only "if the truth run puts its cause in `bracketRanks`". Reading the code, FX-G7's rank half has the same shape (finding, see the PR body). `bracketRanks` breaks an equal elimination round by seed (`stage.ts:500-509`). So a page-playoff seed 1 who forfeits Q1 (out at round 0) ranks above the Eliminator loser (seed 4, also out at round 0). X-SP-5 says the withdrawn entrant ranks below everyone still in the stage.

**Files:**
- Modify (only if Step 1 says so): `src/competition/stage.ts` `bracketRanks` (`eliminatedIn` for a declared entrant in no fixture; the page-playoff forfeit order)
- Test: `src/competition/bracket-ranks-w4.test.ts`

**Interfaces:**
- Consumes: T5's `BracketStage.entrants`, `seeds`.
- Produces, if Step 1 reds:
  - (a) stepladder: a declared, seeded entrant in no fixture is eliminated at their due rung. Seeds k − 1 and k are due at round 0; seed s ≤ k − 2 is due at round k − 1 − s. A stepladder entrant with no seed → CONFIG_INVALID.
  - (b) page_playoff: among entrants out in the same round, one out by forfeit (`walkedOver`) ranks after one out by play.
  - Both are kind-scoped. Knockout keeps X-FR-2's order (elimination round, seed, id).

- [ ] **Step 1: Truth run.** Write the two cases as tests first, with the rows the app writes after the withdrawal.
  - Stepladder: the withdrawn waiting seed's seat stamped dead and not seated (ruling 116, `competition.ts:181-190`). The climber walks over.
  - Page playoff: Q1 walked over (s1 forfeits), Q2 walked over to E's winner (X-SP-5).
  - Expected: `X-SP-4 a withdrawn stepladder seed ranks as the loser of the rung they were due to enter` (k = 5, seed 2 withdrawn → ranks 4th, below the round-3 loser and above the round-1 and round-0 losers). `X-SP-5 a page-playoff Q1 withdrawal ranks 4th, below the Eliminator loser`. Take the rows' shape from the app's merged code or the CI artifact of run 41861339582, read-only.
  - Record what each test does on the T10 tree. Green = the cause is app-side: keep the test as a regression, record "SL-1 / FX-G7 rank half: false premise, engine ranks correctly" in the PR body, skip Step 2. Red = continue.
- [ ] **Step 2: Implement (a) and/or (b)**, only for the case that reds.
- [ ] **Step 3: Run, expect PASS** (T6's list); confirm T6's sweep and T7's counted test are unchanged.
- [ ] **Step 4: Mutate** each change once (revert it → its test reds).
- [ ] **Step 5: Rows.** None deleted: X-SP-4 and X-SP-5 also need the app's seating proof (`"W4 app PR A"`). Their engine test paths are added to proved by in T12, next to the app's.
- [ ] **Step 6: Commit** `fix(stage): a withdrawn stepladder seed ranks at its rung; a page-playoff forfeit ranks last (SL-1, FX-G7 rank halves)` (or `test(stage): …` if Step 1 was green).

**App seam:** app PR A's withdrawal-seating fix, `apps/web/src/server/usecases/__tests__/withdrawal-w2b.test.ts`, and the stale triage rules `stepladder-withdraw-wrong-phase` and `page-playoff-withdraw-voids`, re-keyed with the L3 R4 ×11 re-baselines.

---

## B6 — App PR A proof close-out (GATED)

### Task 12: Fill the 39 "W4 app PR A" rows' proofs (design §12: app-side rows ship in the engine PR after app PR A merges)

**Gate:** app PR A is merged to seazn.club main (the orchestrator names the PR). If it is not, stop and hand back. The orchestrator then decides: hold this PR, or ship B6 later as a patch release (`"@onryde/seazn-engine": patch`) before app PR B's bump.

**Why it is safe here:** the engine checker reads only `packages/engine/` paths (`proofProblems(r, read, inEngine)`, `test/rules-reference.ts`), so `apps/web/...` proofs pass in this repo. Their first real check is app PR B's `scripts/__tests__/rules-reference.test.ts`, which reads `node_modules/@seazn/engine/rules`. Re-confirm by reading those two spots at the task's start.

**Files:**
- Modify: `rules/cross-sport.md` (39 rows), `test/rules-reference.ts` (delete 39 entries)

**Interfaces:**
- Consumes: the merged app tree, read-only (`git -C ~/github/seazn.club fetch && git -C ~/github/seazn.club show origin/main:<path>`). Re-pin every path and title there, never from a plan. Every proof file must already hold the id as a whole token in an `it(`/`test(`/`describe(` title. A row whose title is missing waits: hand back, and the orchestrator lands a one-line app PR first.

- [ ] **Step 1:** For each of X-SD-1, 2, 6–10; X-LE-1–13; X-LL-1–5; X-PL-1; X-QM-1–5; X-CH-2, 5, 8; X-SP-3–7: in one commit, fill `enforced at` and `proved by` from the merged app tree, add T11's engine path to X-SP-4/X-SP-5, drop the citation's "not yet implemented (W4 app PR A)" / "proof owed (W4 app PR A)" note, and delete the entry.
- [ ] **Step 2: Verify** `test/rules-reference.test.ts` (JSON reporter). In the commit body, count the app proof paths named and state that the count is above 0 (the engine run is blind to them).
- [ ] **Step 3: Commit** `docs(rules): W4 app PR A proofs (39 rows)`.

---

## B7 — Open the engine PR

### Task 13: Changeset, branch gates, downstream expectation, body

**Files:**
- Create: `.changeset/w4-knockout-engine.md` (`"@onryde/seazn-engine": major`). One line per break: `finalRanks` → `FinalPlace[]` (bracket and table events), `BracketStage.entrants` required, `isBracketStageComplete` stricter and `completeBracketStage` refusing, `generateSingleElim` refusing an unfeedable third place, `TakeRule.firstLosses` / `SlotDescriptor.first_loss`, `placementTable` and `rank_range` keeping ties. Then the behaviours: shared 3rd by default, vacant 3rd, joint winners, vacant title, `firstLossField`. Then "Rules: X-SD-3, X-SD-4, X-SD-5, X-TP-4, X-TP-5, X-CH-1, X-CH-7, X-FR-1, X-FR-2, X-FR-3, X-PL-3, X-PL-4, X-SP-1, X-SP-2 proved; 39 app PR A rows proved (if T12 ran)".

- [ ] **Step 0: Release-order gates** (stop and hand back if one fails):
  - (a) #26 merged (Global Constraints).
  - (b) T12 ran, or the orchestrator has recorded the patch route.
  - (c) `pnpm changeset status --verbose` on origin/main. #26's patch changeset, if still unreleased, folds into 4.0.0, which is fine. Any other pending minor or major is reported to the orchestrator before merge.
  - (d) `git rebase origin/main` (never `git stash`), then Step 1 again.
- [ ] **Step 1: Branch gates, once, scoped:** `pnpm boundary`; `pnpm single-sport --check --against origin/main`; tsc; `pnpm fold-epoch:check --against origin/main` (expected: no sport); `pnpm schema:snapshot && git status --porcelain -- ':(glob)src/sports/**/*.schema.json'` (empty); `pnpm mutation:floor --check-file-against origin/main`; `pnpm exec eslint --max-warnings 0 $(git diff --name-only origin/main -- '*.ts')`. Then every test file touched in T1–T11 in ONE JSON-reported run, plus `test/rules-reference.test.ts`. Also count the remaining `AWAITING_PROOF` entries: 17 with value `"W4 app PR B"` and no `"W4 engine PR"` value left (39 `"W4 app PR A"` too if T12 did not run). Paste the raw counts in the body. Record any Stryker sizing drift warning and the legs it names; do not run Stryker. Any red is a stop.
- [ ] **Step 2: Downstream expectation.** The `downstream` job (app@main against this PR's snapshot) is expected to RED on app tsc:
  - `apps/web/src/server/engine-db/competition.ts:990` (`BracketStage` without `entrants`);
  - `:980` (the ladder's `stage_completed.finalRanks` as `string[]`);
  - every reader of `completeBracketStage().finalRanks` as strings;
  - any exhaustive switch over `TakeRule["kind"]` / `SlotDescriptor["kind"]`.

  List the job's actual errors in the body. Do not merge over it. Recommend to the orchestrator, for the owner: merge when app PR B, pinned to `0.0.0-pr<N>.<sha>`, is green.
- [ ] **Step 3: Push and open** (`gh pr create --repo onryde/seazn.club.engine`). The body carries:
  - the gap list (3P-2, 3P-3, CH-1, AN-2 engine half, SH-3, Q4, PL-1 feed half, PL-2, PL-3 predicate, SEED-R test half, SL-1 and FX-G7 rank halves per T11);
  - the 14 proved rows (+ 39);
  - the epoch verdict (none);
  - the raw gate counts;
  - Step 0's results;
  - Step 2's list;
  - the plan's calls: void play-off → shared 3rd; semi double walkover → strict block; first match capped at round 1; `rank_range` `shared_place` flag; the page-playoff forfeit order;
  - the findings (below);
  - a link to app PR B once open;
  - exactly this line: `Matrix rows: knockout, knockout_third_place, ko_plate, qualifying_main, stepladder_only, page_playoff_only × football, cricket, boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis, icehockey, hockey (66 cells) — third-place refusal and completion, tied final ranks (shared 3rd, joint winners, vacant title), first-loss plate feed, counted draw properties; rule rows X-SD-3, X-SD-4, X-SD-5, X-TP-4, X-TP-5, X-CH-1, X-CH-7, X-FR-1, X-FR-2, X-FR-3, X-PL-3, X-PL-4, X-SP-1, X-SP-2`;
  - `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

  Hand back after the push. The orchestrator watches CI, then cuts `release/4.0.0` with the `engine-release` skill. App PR B bumps `apps/web/package.json:25` to `npm:@onryde/seazn-engine@^4.0.0`.

---

## Findings (for `_INDEX.md` "False premises found (W4)" and the PR body)

1. **The walkover marker exists.** Recon D says `BracketFixtureRow` lacks `walkedOver` (true, `progression.ts:449-452`). `BracketFixture` already carries it (`stage.ts:66-70`), and the app sets it for every forfeit reason, retirement included (`competition.ts:207-210`). So X-PL-4 threads an existing marker (T9).
2. **FX-G7's rank half reads as an engine defect** (`stage.ts:500-509`, seed breaks an equal elimination round). Design §6.1 places only SL-1 conditionally. Both are conditional in T11.
3. **`rowAtRank` finds by rank value** (`progression.ts:560-572`). Without T8, a Shared knockout source would throw at "rank 4" for any `rankRange` to 4 (qualifying_main q = 4, S2). §6.1 does not list it.
4. **`stage.test.ts:237`'s title claims "regardless of the other three"** but its fixture has all three decided (AGENTS class 4). X-CH-7 makes the claim false; T4 rewrites it.
5. **Joint winners cannot complete through the app's guard** (`competition.ts:1008-1058`, unbeaten finalists refused). App PR B must amend it (T7 seam).
6. **Semver:** major (4.0.0), no FOLD_EPOCH or FOLD_MINOR move. So the epoch report owes no app migration step; the Q8 re-rank is app data (X-FR-5).

## Self-review

- **Spec coverage (§6.1):**
  - first-loss feed + exclusions + predicate → T9, T10;
  - tied `finalRanks` (shared 3rd, joint, vacant; S7 strict below) → T5–T7;
  - no 3p below two real semis + CONFIG_INVALID → T1;
  - play-off holds completion → T4;
  - `completeBracketStage` refuses (AN-2) → T4;
  - stepladder withdrawn seed (conditional) → T11;
  - counted properties across n → T2 (byes, exactly once), T6/T7 (ranks), T9 (plate);
  - rule rows → every task; the 14 entries map 6 + 2 + 4 + 2.
  - The random draw is app-side (§5.4 reuses `lib/swiss-draw.ts`; X-SD-6/7 are app PR A): left. Club separation is out (ruling 272).
- **Types:**
  - `FinalPlace` / `BracketTitle` / `BracketStage.entrants` are defined in T5/T7 and used in T6, T8, T11.
  - `undecidedBracketFixtures` is defined in T4.
  - `BracketFixtureRow` is widened in T9 and read by T10.
  - `playOutBracket` is defined in T6 and used in T7, T9, T11.
  - `SourceShape.firstLosses` is defined in T10.
- **Seams.** `entrants`, `jointWinners`, `firstLosses` and `SourceShape.firstLosses` have no production producer until app PR B. Until then joint winners, the plate feed and the declared-entrant ranking are inert in the product (class 1). Each task's "App seam" line names the app test that must drive the real producer.
