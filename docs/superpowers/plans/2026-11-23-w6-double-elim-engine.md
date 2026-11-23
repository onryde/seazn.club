# W6 Double Elimination — Engine PR Implementation Plan (release 11.0.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Written 2026-11-23** against engine `seazn-club/seazn.club.engine` 10.0.3 (d1f07f8) and seazn.club `276fff25d7`.
> **Re-based the same day on engine 10.0.4** (origin/main b7462f6, release commit 5840aa4, no pending changeset), after
> plan review 1 (`.superpowers/sdd/2026-11-23-w6-double-elim/plan-review-engine.md`, main checkout) and owner ruling 306.
> 10.0.3 → 10.0.4 changed five files: `src/competition/tiebreakers.ts` (the Swiss tiebreak index, built once per
> refold), a new `tiebreak-index-differential.test.ts`, `stryker-equivalent.json` (re-keyed), `CHANGELOG.md` and
> `package.json`. `bracket.ts`, `stage.ts`, `rules/cross-sport.md`, `test/rules-reference*.ts` and `test/w2b-rows.ts`
> are byte-identical, so **no pin below moved**; "(engine d1f07f8)" pins hold at b7462f6. Every engine pin was opened
> while planning; every app pin reads `(app 276fff25d7)`. The design's
> own pins are reads; where one differed from the file, this plan follows the file and lists it under "Premises found
> false while planning" at the end.

**Goal:** Ship the engine half of W6 as `@seazn-club/seazn-engine` **11.0.0**: losers'-bracket drops that cross by the
four-step cycle, a named refusal below 2 entrants, the `resetOwed` predicate with the `reset_owed` completion refusal,
double-elimination places shared by losers'-bracket exit round with a completed-places guard that checks relations, and
the W6 rule rows.

**Architecture:** Two files change. `src/scheduling/bracket.ts`: `generateDoubleElim` reads the away feed of each drop
round through one pure index function and refuses a field under 2; fixture ids and every other feed are unchanged.
`src/competition/stage.ts`: `BracketFixture` gains `conditional`; `resetOwed` reads the grand final's feeds, never seat
order; `bracketCompletionRefusal` gains `reset_owed`; `bracketRanks` and `assertCompletedBracketPlaces` gain a
`double_elim` branch keyed on the round of the losers'-bracket fixture an entrant went out in. Competition never
value-imports scheduling (`pnpm boundary`); `stage.ts` keeps its type-only import of `BracketSlotRef` (stage.ts:9).
No generator option, no bracket version, no fold change.

**Tech Stack:** TypeScript (typescript-native), vitest, fast-check, pnpm, changesets. Engine repo
`seazn-club/seazn.club.engine`, base origin/main **10.0.4**; every "today" and every red-first claim is against 10.0.4.

**Spec:** `docs/superpowers/specs/2026-11-23-format-matrix-w6-double-elim-design.md` (§6.1 scope; §4.2, §4.3, §4.4,
§5.1, §5.5 behaviours; §6.6 test debt; §10 calls; §11; §12 rows), read with
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W6-double-elim.md` (the source of every expected
value), `_INDEX.md` rulings 293–306 beside it (grep, never read whole), `_RULES.md`, and
`docs/superpowers/TEST-STRATEGY.md`. Engine rules: `AGENTS.md` (Tests, Releasing, the `Matrix rows:` line).

> **Agents.** Each task is one `implementer` dispatch and one `reviewer` pass (repo agent types). Models and effort are
> those of `docs/superpowers/RULES.md` and the agent frontmatter; no dispatch overrides `model:`. Batch reviews run at
> the end of B1 and of B3; one whole-PR review runs before Task 8 Step 4.
>
> **R8.** The reference model (`packages/reference`, seazn.club) is NOT in this plan. The engine implementer must not
> write it, read a draft of it, or copy from the reviewer's scripts (`de_crossover.py`, `de_dead2.py`); a test here may
> not import either. Tests take their expected values from the rulebook's rows and worked tables, cited by row.

## Read first (every implementer and reviewer)

1. This plan's Global Constraints and Interfaces blocks.
2. Rulebook §2 (RB6-E), §3 (RB6-D), §4 (RB6-X, the three worked tables), §6 (RB6-G), §9 (RB6-C), §10 (RB6-R, the place
   tables). The task names the rows it needs.
3. Design §4.2 "What changes" (first three bullets only: the predicate, the flag, the refusal), §4.3, §5.1, §6.1.
4. Engine `AGENTS.md` "Tests" and "Releasing".
5. The engine file the task names, at the lines it names. Nothing else.

## Status by batch

| Batch | Tasks | Rule ids proved (engine `AWAITING_PROOF` entries deleted) | Status |
|---|---|---|---|
| B0 Rows | T1 | none (records 26 rows and 4 amendments) | ⏳ |
| B1 Generation | T2, T3, T4 | X-DE-2, X-DE-3, X-DE-4, X-DE-5, X-DE-6, X-DE-16 (6) | ⏳ |
| B2 Grand final | T5 | X-DE-10, X-DE-11, X-DE-12, X-CH-9 (4) | ⏳ |
| B3 Places | T6, T7 | X-FR-6, X-FR-7, X-FR-8, X-FR-9 (4); X-DE-1, X-FR-1, X-FR-2, X-FR-3 re-proved under their amended text | ⏳ |
| B4 PR and release | T8, T9 | none (asserts zero `"W6 engine PR"` entries; 12 `"W6 app PR B"` remain) | ⏳ |
| B5 Close-out (GATED on app PR B merged) | T10 | the 12 `"W6 app PR B"` rows | ⏳ |

Engine-PR total **14** ids = 6 + 4 + 4. Rows recorded by T1: 14 engine + 12 app = **26**; entries = **26**.

**Same-shape tasks that may be batched into one dispatch:** T2 + T4 (both edit `generateDoubleElim` and assert its
structure). T9 + T10 are release and docs steps with no code. T3 is test-only and may ride T2's dispatch if the
implementer has budget. **Never batch** T5, T6 or T7 with anything: each is subtle `stage.ts` logic with its own review.

## Global Constraints

- **Gates.** Gate 1 (before T1): engine origin/main holds no W6 code and no W6 row:
  `git -C ~/github/seazn.club.engine grep -n "resetOwed\|lbDropGameRB6X2\|reset_owed" origin/main -- src` is empty and
  `git -C ~/github/seazn.club.engine show origin/main:rules/cross-sport.md | grep -c "^| X-DE-2 "` is 0. Gate 2 (before
  T1): ruling 306 is in the ledger (`grep -a -c "^306\. " docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`
  is 1): 306(a) signs every REC row "build as written", so all 26 rows are written and nothing is held back.
  Gate 3 (T10 only): app PR B merged. A failed gate stops the task and hands back.
- **Tree.** `git -C ~/github/seazn.club.engine fetch && git -C ~/github/seazn.club.engine worktree add ~/github/seazn.club.engine-worktrees/w6-double-elim-engine -b feat/w6-double-elim-engine origin/main`,
  then `pnpm install --frozen-lockfile` there. `WT=~/github/seazn.club.engine-worktrees/w6-double-elim-engine`. Prefix
  every command `cd "$WT" &&` in the same call. Never edit the engine's main checkout (it sits on a release branch),
  never edit `~/github/seazn.club`, never `git stash`.
- **Scratch.** `OUT=<session scratchpad>/<agent-name>/`.
- **Scoped tests only** (AGENTS.md Tests; owner rule): never `pnpm test`, `test:coverage`, `pnpm sim`. The verify command:
  ```
  cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/<task>.json" <paths>; echo "EXIT=$?"
  node -e 'const r=require(process.argv[1]);console.log(`${r.numPassedTests}/${r.numTotalTests} failedSuites=${r.numFailedTestSuites}`);for(const t of r.testResults)console.log(t.name)' "$OUT/<task>.json"
  ```
  Green = `EXIT=0`, passed = total > 0, `failedSuites=0`, every name under `$WT`. Read `rtk` output through `rtk proxy`.
- **Type, lint, boundary, every code task:** `cd "$WT" && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo "EXIT=$?"`,
  `cd "$WT" && rtk proxy pnpm exec eslint --max-warnings 0 <changed files>; echo "EXIT=$?"`,
  `cd "$WT" && pnpm boundary; echo "EXIT=$?"`.
- **Expected values** come from the rulebook (a row, a worked table, a place table) or from the test's own result
  script, never from `generateDoubleElim` or `bracketRanks` output. Each pinned value carries a one-line derivation
  comment naming the row (`// RB6-X2 worked table n=8: LB 2.2 = W LB 1.2 v L WB 2.1`). Each task has one
  `// differential: today …` case; "today" is named in the task and was confirmed at d1f07f8 (unchanged in 10.0.4).
- **Numbering.** Rulebook rounds and games count from 1; engine ids count from 0. `WB r.i` is `wb-r{r−1}-i{i−1}`;
  `LB t.p` is `lb-r{t−1}-i{p−1}`. Every test states the mapping once, at the top of the file.
- **Anti-vacuity (R25).** Every sweep and property counts what it checked and asserts the exact count; zero is a
  failure. The empty case is each rule set's first test.
- **Mutate every new guard once,** by hand, one at a time; the named test must red; restore. Commit body line:
  `mutation: <guard> → <test name> red`.
- **Sport sweep (R26).** `generateDoubleElim`, `resetOwed`, `bracketRanks` and the places guard read no `SportModule`.
  The reason line `// single-sport: double-elimination structure and ranks are sport-agnostic (reads no SportModule)`
  is the first line of **each `describe` body** in every new test file (a file-top line covers only the next
  statement, `scripts/single-sport.ts` header), and no test names a sport key; `cd "$WT" && pnpm single-sport --check --against origin/main` stays green. The sport sweep is
  the app's (`forEachSport`, design §6.6 T6-c), not this PR's.
- **The four reviewer questions (R27),** answered in writing in every review: a second call; an empty input; after a
  withdrawal or void; another sport. Each task lists its four tests.
- **Stryker.** No new non-test `src/` file. Edited legs `draws-3` (`src/scheduling/bracket.ts`, stryker.groups.mjs:127)
  and `competition-5` (`src/competition/stage.ts`, :94) may drift more than 10%: a warning on PR CI, so T8's PR body
  names both for a re-measure in the 01:00–06:00 window.
- **Rule rows.** A proving commit, in ONE commit: deletes the id from `test/rules-reference.ts` `AWAITING_PROOF`
  (:55-72), fills `proved by` with every test file whose `it(`/`describe(` title holds the id as a whole token, fills
  `enforced at`, and drops the citation's `; not yet implemented (W6 engine PR)`. Paths are written
  `packages/engine/...` (`ENGINE_ROW_PREFIX`, :77). The checker refuses an awaiting row that claims proof
  (`test/rules-reference.test.ts:118-119`) and a stale entry (:304-306). Never allocate an id after T1.
- **Stryker equivalents are keyed by line and column.** `stryker-equivalent.json` holds 9 `src/competition/stage.ts`
  keys (lines 173, 174, 175, 176, 543, 544, 545, 555 and 975:33, the `outAt` `fixture.round < prev`), and
  `test/stryker-floor.test.ts` ("every recorded equivalent is keyed … where its file still reads the original text")
  reds on any line shift. **Every commit that shifts `stage.ts` lines (T5, T6, T7) re-keys the moved entries in the
  same commit**, starting from 10.0.4's copy of the file, and adds `test/stryker-floor.test.ts` to its verify run. An
  entry whose original text the task deleted or rewrote is removed and named in the commit body, never re-pointed at
  different code. It holds no `bracket.ts` key today; T2 and T4 run the same test once to confirm.
- **User-facing words (306(b)).** Shared places keep the product's words (`table.sharedRank`, "5 (shared)"). "5=" in
  this plan is shorthand: it appears in no rule row, no error message and no test title.
- **Rulings** 293–306 only. A call this plan makes is marked "(plan's call)" and listed in the PR body.
- **Fold epoch.** `cd "$WT" && pnpm fold-epoch:check --against origin/main; echo "EXIT=$?"` reports no epoch move (no
  task touches a fold).
- **Commits:** conventional, ending with the session's attribution trailer. Commit only where a step says so.

## Interfaces — exact signatures (app PR A and app PR B copy this block verbatim)

EXISTING shapes at d1f07f8 (the same in 10.0.4), then the exact additions and changes in 11.0.0. **App PR A consumes nothing here** (it
runs on 10.0.x). A task that changes a signature updates this block in the same commit.

```ts
// ── @seazn/engine/scheduling — bracket.ts
interface BracketSlotRef { fixtureId: string; side: "winner" | "loser" }                       // bracket.ts:13-16 (EXISTING)
interface BracketFixtureGen { id; bracket?: "WB"|"LB"|"GF"; round; isFinal?; thirdPlace?; conditional?; home?; away?;
  homeFrom?: BracketSlotRef; awayFrom?: BracketSlotRef; award? }                                 // :18-30 (EXISTING)
interface DoubleElimOptions { entrants: readonly EntrantId[]; seeds?: ReadonlyMap<EntrantId, number>;
  bracketReset?: boolean }                                                                       // :430-434 (UNCHANGED: no `drops` option)
function generateDoubleElim(opts: DoubleElimOptions): GeneratedBracket;                          // :440-537
//   ids (UNCHANGED): `wb-r{r}-i{i}`, `lb-r{L}-i{j}`, `gf`, `gf-reset`. rounds (UNCHANGED): WB r; LB k + L; gf k + lbRounds;
//   gf-reset k + lbRounds + 1 (k = WB depth). gf: homeFrom winner of the WB final, awayFrom winner of the LB final
//   (n = 2: loser of the WB final). gf-reset: conditional, homeFrom winner of gf, awayFrom loser of gf.
// CHANGED (T2): in a drop round L (odd), `lb-r{L}-i{j}`.awayFrom = loser of `wb-r{m+1}-i{i}` with m = (L − 1) / 2 and
//   j = lbDropGameRB6X2(m, prev.length, i). homeFrom (winner of `lb-r{L−1}-i{j}`) is unchanged. Was: i = j.
// CHANGED (T4): entrants.length < 2 → EngineError("CONFIG_INVALID", …, { reason: "double_elim_needs_two", entrants: n }).
//   Was: returned the winners'-bracket fixtures with no grand final (:447).

// NEW (T2), exported from bracket.ts and so from @seazn/engine/scheduling (`export *`, scheduling/index.ts:33).
export function lbDropGameRB6X2(m: number, games: number, i: number): number;
//   The 0-based losers'-bracket game that takes the loser of 0-based winners'-bracket game i, in the m-th drop after
//   round 1 (m = 0 is WB round 2). c = m mod 4, G = games, h = G / 2:
//     G = 1 → 0;  c = 0 reversed → G − 1 − i;  c = 1 reversed then switched → i < h ? h − 1 − i : 3h − 1 − i;
//     c = 2 switched → i < h ? i + h : i − h;  c = 3 regular → i.
//   Each map is its own inverse, which is why the generator may read i from j with the same call.
//   CONFIG_INVALID { reason: "drop_game_invalid", m, games, i } when m is not an integer ≥ 0, games is not a power of
//   two ≥ 1, or i is not an integer in 0..games − 1.
//   The app must NOT call it to interpret stored rows (design §6.5: a stored bracket is its stored edges), and an app
//   test must not take an expected value from it (R9): the reference family has its own table.

// ── @seazn/engine/competition — stage.ts
interface BracketFixture { id; bracket?: "WB"|"LB"|"GF"; round; isFinal?; thirdPlace?; status: FixtureStatus; home?; away?;
  winner?; loser?; walkedOver?: "loser"|"both"; jointWinners?; homeFrom?: BracketSlotRef; awayFrom?: BracketSlotRef } // stage.ts:65-92 (EXISTING)
// CHANGED (T5):
interface BracketFixture { conditional?: boolean }   // NEW: true on the reset row only. App PR B sets it in toBracketFixture
                                                     // from ext_key === "gf-reset" (app bracket-stage.ts:116-147).
// CHANGED doc only (T6): `walkedOver: "loser"` means "the loser is OUT OF THE STAGE here". In a double elimination the
//   app sets it only for a withdrawn or disqualified entrant; a one-loss forfeit or retirement is passed as a plain
//   loss (winner, loser, no walkedOver) and the entrant is ranked by their second loss.

// NEW (T5). Consumer: app PR B `settleReset` (its one caller).
export function resetOwed(fixtures: readonly BracketFixture[]): boolean;
//   false when no fixture is `conditional`. Otherwise, with RESET = the conditional fixture and GF1 = the fixture both
//   of RESET's feeds name:
//     true iff GF1 carries no walkedOver, names a winner AND a loser, its winner is the entrant GF1's LB feed
//     delivered and its loser the entrant GF1's WB feed delivered. (A joint final and an unsettled GF1 name no
//     winner, so they need no term of their own: a term no test can kill is not written.)
//   It reads the rows AS GIVEN, never through resolveDeadSeats: a GF1 walkover awarded over a dead seat names no
//   loser on the raw row, so it owes nothing (resolved, it would carry walkedOver "loser": the same answer).
//   GF1's WB feed is the one feed with side "winner" whose source fixture has bracket "WB"; the other is the LB feed
//   (winner of the LB final; at n = 2 the loser of the WB final). "Delivered" = the source fixture's winner (side
//   "winner") or loser (side "loser"). Seat order (home / away) is never read.
//   Wiring bugs (CONFIG_INVALID, checked whenever a conditional fixture exists): "reset_not_unique" (two conditional
//   fixtures); "reset_feed_invalid" { fixtureId } (RESET lacks a feed, its feeds name two fixtures or one that is not
//   in the list, or are not one winner and one loser); "grand_final_feed_invalid" { fixtureId } (GF1 lacks a feed, or
//   not exactly one of its feeds is a WB winner feed).
//   REQUIRES of the caller: `conditional` on the reset row, `homeFrom` / `awayFrom` on the reset row and on GF1, and
//   `bracket` on the two fixtures that feed GF1. The app attaches feeds to every row today (app bracket-rounds.ts:39-56).

// CHANGED (T5):
function isBracketStageComplete(stage, fixtures): boolean;     // false while the reset is owed and its row is void
function completeBracketStage(stage, fixtures): CompletedBracketStage;
//   throws EngineError("STAGE_NOT_READY", …, { stageId, reason: "reset_owed", reset: string, grandFinal: string })
//   when resetOwed(fixtures) and RESET.status === "void". Checked after "no_final" and "fixtures_undecided".
//   All three (and bracketTitle) can now also throw resetOwed's CONFIG_INVALID wiring reasons on rows that carry a
//   conditional fixture. Rows with no `conditional` never see `reset_owed` or those throws.
function bracketTitle(fixtures): BracketTitle | undefined;     // undefined in that same state. Was: GF1's winner.
//   `undecidedBracketFixtures` is UNCHANGED (a void row is settled).

// CHANGED (T6): bracketRanks(stage, rows) for stage.kind === "double_elim". FinalPlace[] keeps its type.
//   Title first, as today (champion 1 and the deciding match's loser 2; joint winners 1, 1; vacant title 2, 2).
//   Mid-bracket, entrants still in play next, as today. Then every other entrant by EXIT ROUND, later first; all
//   entrants with one exit round take the same rank = 1 + (entrants placed above them). Inside a group the list
//   order is seed, then id; the rank is the same.
//   Exit round of an entrant = the `round` of a fixture with bracket "LB", compared only with other LB rounds (so it
//   is right for the generator's rounds, LB = k + L, and for the app's per-lane rounds, LB = L):
//     - put out by a walkover (walkedOver "loser" names them, or "both" seats them): the exit fixture of the earliest
//       such fixture; else the fixture of their latest loss;
//     - that fixture is LB → its round; it is WB → the round of the LB fixture whose homeFrom / awayFrom is
//       { fixtureId: it, side: "loser" }; that target is the grand final (n = 2), or the fixture is GF → later than
//       every LB round;
//     - no loss and no walkover, a WB fixture whose loser feed no row names, or a fixture with NO `bracket` lane →
//       below every LB round (they share last). The read path never refuses.
//   REQUIRES of the caller: `bracket` on every row of a double elimination, and the feeds the app already attaches.
// CHANGED (T7): assertCompletedBracketPlaces(stage, fixtures, places) for "double_elim" checks coverage, the title
//   shape and the exit-round relations; it never applies "at most two" or BRACKET_SHARED_RANKS, which keep their
//   value and meaning for knockout, stepladder and page_playoff. double_elim only, CONFIG_INVALID, CHECKED IN THIS
//   ORDER, first failure thrown: the structural check (existing reasons); "lane_missing" { fixtureId } (a row with
//   no `bracket`); "exit_round_unreadable" { entrantId, fixtureId }; "title_shape"; then down the places below the
//   title in list order: "exit_round_order" (an entrant with a later exit round does not rank strictly better: this
//   also covers a rank shared across two exit rounds), "exit_round_split" (two entrants of one exit round hold
//   different ranks), "not_competition_ranking" (existing name: rank ≠ 1 + entrants ranked better).
```

**What the app plans must know, in one place:**
- Exported names added: `lbDropGameRB6X2` (`@seazn/engine/scheduling`), `resetOwed` (`@seazn/engine/competition`).
  Field added: `BracketFixture.conditional`. Refusal reason added: `reset_owed` (data `reset`, `grandFinal`).
  Generator refusal added: `CONFIG_INVALID` `double_elim_needs_two`.
- `linesOfShape` (app `lib/format-max-entrants.ts:89-100`) must answer 0 below 2 before it calls the generator, in the
  bump commit, or it throws (design §5.5).
- X-DE-1 is a W2b row; its text changes and its status moves to `signed 294 2026-11-23` (T1). **Hand-over for app
  PR B's bump commit, two pins:** an X-DE-1 entry in the W2b text pin (`AMENDED_TEXT`, app
  `scripts/__tests__/rules-reference.test.ts`), and the status pin `"X-DE-1": signed(93)` at app
  `scripts/lib/w2b-rows.ts:53` → `signed(294, "2026-11-23")`. X-FR-1, X-FR-2 and X-FR-3
  are W4 rows and have no pin.
- After the bump the installed table awaits the 12 `"W6 app PR B"` ids below plus whatever W4 entries the engine still
  holds (37 at 10.0.4, test/rules-reference.ts:56-67). Count from the installed table; do not copy a number from here.
- The engine reads LB rounds only against LB rounds. The app keeps passing per-lane rounds (app bracket-rounds.ts:21-24).

## Review Focus

1. **Rows numbered the app's way.** The app hands the engine rounds 0-based per lane (LB round 0 is the first LB
   round, the grand final is round 0 of its lane), while the generator numbers LB after WB. A person expects the same
   places from both. Pinned in T6 (`the app's per-lane rounds rank the same`).
2. **A double walkover in the LB final.** Nobody is the LB champion, GF1 is settled with no loser, and the two LB
   finalists went out last. A person expects them to share the place right behind the champion. Design §5.1 says "two
   at 3="; ruling 306(c) settles it: two at 2nd, shared. Pinned in T7.
3. **A reset row that arrives without `conditional`** (every row the app builds before PR B). A person expects
   today's behaviour, not a refusal. Pinned in T5 (`no conditional row owes nothing`).
4. **GF1 with its seats swapped.** RB6-D6 leaves seat order unruled, so a caller that seats the LB champion at home
   must get the same answer. Pinned in T5.
5. **A field of 2 with the reset on.** Both of GF1's feeds come from the WB final, the LB champion is its loser, and
   there is no LB row at all. A person expects "beat them twice" to work and both entrants to be ranked. Pinned in T4
   (structure), T5 (owed at n = 2) and T6 (ranks at n = 2).

---

### Task 1: The W6 rule rows and the four amendments (B0)

Docs-only, first commit of the engine PR (design §12 step 1: the engine PR records every signed W6 row). Authority:
design §12 and its id table; OWNER 293–306 (306(a) signs every REC row); rulebook rows as cited per id below.

**Files:**
- Modify: `rules/cross-sport.md` (amend X-DE-1 :30, X-FR-1 :149, X-FR-2 :150, X-FR-3 :151; append the new rows after
  the last row of each area: X-DE after :30, X-FR after X-FR-5 :153, X-CH after X-CH-8 :148, X-LE after X-LE-14 :115,
  X-RB after X-RB-1 :90, X-TP after X-TP-7 :140)
- Modify: `test/rules-reference.ts` (`AWAITING_PROOF` :55-72, a W6 block with its doc comment)
- Modify: `test/w2b-rows.ts:54` — `"X-DE-1": signed(93)` → `signed(294, "2026-11-23")`, with a line in the doc
  comment at :15-22 beside X-WO-1's (plan's call, by the house precedent: an amended W2b row carries the amending
  ruling — X-WO-1 → 182, X-BR-1 → 84, X-RT-1 → 118). The app's twin pin is a hand-over line (Interfaces block).
- Test: `test/rules-reference.test.ts` (existing checker; it is also the one reader of `test/w2b-rows.ts`)

**Interfaces:** Produces the id table below. **It is binding on app PRs A and B**: a test that proves a row carries the
id as a whole token in its `it(`/`describe(` title. Row text is the rule column of design §12's table, verbatim.
Grammar: `| id | rule | citation | status | enforced at | proved by |`; status `signed <N> 2026-11-23` with N the
highest ruling in the "signed by" column (306 where 306(a) signed a clause); no row text says "5=" (306(b)); citation "product rule; seazn.club `_INDEX` ruling(s) N (W6 rulebook RB6-…)"
ending `; not yet implemented (W6 engine PR)` or `(W6 app PR B)`; `enforced at —`, `proved by —`.

| id | rulebook rows | signed by | tag | proved by |
|---|---|---|---|---|
| X-DE-2 | D1, D3, D4 | 294, 306(a) | engine PR | T2 |
| X-DE-3 | X1 | 300 | engine PR | T2 |
| X-DE-4 | X2 | 300 | engine PR | T2 |
| X-DE-5 | X3, X4, D5 | 306(a) | engine PR | T2 |
| X-DE-6 | X5 to X8 | 300, 306(a) | engine PR | T3 |
| X-DE-16 | E1 to E5 | 304, 306(a) | engine PR | T4 |
| X-DE-10 | G4, G5 | 293 | engine PR | T5 |
| X-DE-11 | G6, G8, G11 | 298, 306(a) | engine PR | T5 (app PR B appends its paths at T10) |
| X-DE-12 | G7, G9, G10 | 298 | engine PR | T5 (app PR B appends) |
| X-CH-9 | C2 to C4, C6, C7 | 298 | engine PR | T5 (app PR B appends) |
| X-FR-6 | R2, R4 | 305(d) | engine PR | T6 |
| X-FR-7 | R3, R5 | 297 | engine PR | T6 |
| X-FR-8 | R7 | 303 | engine PR | T6 |
| X-FR-9 | R10 | 305(d), 306(c) | engine PR | T7 |
| X-DE-7 | B1 to B3, B5, E6 | 305(c), 306(a) | app PR B | T10 |
| X-DE-8 | B4 | 299 | app PR B | T10 |
| X-DE-9 | G1 to G3 | 305(a) | app PR B | T10 |
| X-DE-13 | F1 to F3, R6 | 294 | app PR B | T10 |
| X-DE-14 | F11 | 302 | app PR B | T10 |
| X-DE-15 | F9, F10 | 298 | app PR B | T10 |
| X-CH-10 | C5 | 305(b) | app PR B | T10 |
| X-LE-15 | L1 to L3, L5 to L8 | 296 | app PR B | T10 |
| X-LE-16 | L4 | 304 | app PR B | T10 |
| X-LE-17 | B6 | 306(a) | app PR B | T10 |
| X-RB-2 | P1 to P3 | 299 | app PR B | T10 |
| X-TP-8 | M4 | 306(a) | app PR B | T10 |

Counts: **26 rows = 14 engine PR + 12 app PR B; 26 entries.** Every row design §12 marks "PR A" is tagged
`"W6 app PR B"` here, because its test gains the id in its title only at the bump (design §12 step 1, call 37).
Amendments, no new id: X-DE-1, X-FR-1, X-FR-2, X-FR-3 (text from design §12). X-DW-2 and X-DW-3 keep their text.

- [ ] **Step 1: Gate 2.** Ruling 306 is in the ledger; all 26 rows are written in full. No row is held back.
- [ ] **Step 2: Re-check free ids:** `cd "$WT" && grep -a -c "X-DE-2 \|X-FR-6 \|X-CH-9 \|X-LE-15 \|X-RB-2 \|X-TP-8 " rules/cross-sport.md`
  prints 0 (it did at d1f07f8).
- [ ] **Step 3: Write the rows** per the table.
- [ ] **Step 4: Amend the four rows** with design §12's text. X-DE-1: the words "walkover" and "retired" leave the
  row; citation gains "amended by ruling 294 (2026-11-23, W6 rulebook RB6-F4): a forfeit or retirement is one loss,
  X-DE-13, X-DE-14". X-FR-1: the shared-places list gains "a double elimination's places by exit round (X-FR-7,
  X-FR-9)"; rulings 297, 305(d), 306(c). X-FR-2: names knockout, stepladder and page playoff; rulings 273, 297. X-FR-3: "an entrant a
  walkover put **out of the stage** is eliminated at that fixture for ranking, so ranks and seats agree", plus the
  double-elimination clause; rulings 274, 294, 302. `proved by` and `enforced at` columns unchanged. X-DE-1's status
  becomes `signed 294 2026-11-23`, with `test/w2b-rows.ts:54` in the same commit; the other three keep their status.
- [ ] **Step 5: Add the `AWAITING_PROOF` entries** (`"W6 engine PR"` / `"W6 app PR B"`) under a doc comment in the
  W4 and W5 form, naming the design, the rulebook and rulings 293–306.
- [ ] **Step 6: Verify:** the verify command on `test/rules-reference.test.ts`. Expected:
  `EXIT=0`, `failedSuites=0`. `grep -a -c '"W6 engine PR"' test/rules-reference.ts` is 14 and `'"W6 app PR B"'` is 12;
  `grep -a -c "^| X-\(DE-\(2\|3\|4\|5\|6\|7\|8\|9\|1[0-6]\)\|FR-[6-9]\|CH-\(9\|10\)\|LE-1[5-7]\|RB-2\|TP-8\) " rules/cross-sport.md` is 26.
- [ ] **Step 7: Mutate once:** give the X-DE-2 row a `proved by` path while its entry stays → the checker reds
  (`test/rules-reference.test.ts:118-119`); restore.
- [ ] **Step 8: Commit** `docs(rules): W6 double-elimination rows (rulings 293-306), awaiting proof`.

**Reviewer's four questions:** second call: a second run of the checker is green and writes nothing. Empty: no row has
an empty rule cell. After a withdrawal or void: X-DE-1's amended text still names withdraw and disqualify. Another
sport: the rows name no sport; `rules/<sport>.md` files are untouched.

### Task 2: Crossed drops (B1; X-DE-2, X-DE-3, X-DE-4, X-DE-5)

Authority: design §4.3 "What changes (engine)", §6.1 row 1; OWNER 295, 300; RB6-D1, D3, X1 to X5 and the worked tables
for 4, 8 and 16 (rulebook §4).

**Files:**
- Modify: `src/scheduling/bracket.ts` — add `lbDropGameRB6X2` above `generateDoubleElim` (:440); the drop round's
  loop :475-489 (the comment :476 and `awayFrom: loserOf(wbLosers[i] as string)` :486); the header comment :436-439
  ("at the canonical slot")
- Test: `src/scheduling/double-elim-drops-w6.test.ts` (new)

**Interfaces:** Produces `lbDropGameRB6X2` and the changed `awayFrom` (block above). Consumed by T3.

- [ ] **Step 1: Write the failing tests** (titles carry the ids):
  - Empty first: `X-DE-2 a field of 2 has no losers' bracket row` — `generateDoubleElim({ entrants: 2 ids })` has no
    fixture with `bracket: "LB"` (RB6-E3).
  - `X-DE-2 the frame, the round counts and the game counts` for n = 2 … 32: WB rounds = k, LB rounds = 2(k − 1), LB
    rounds 2r − 3 and 2r − 2 hold 2^(k − r) games each for r = 2 … k (`// RB6-D1, D3`). Asserts 31 sizes checked.
  - `X-DE-3 LB round 1 pairs adjacent WB round-1 losers in order`: for frames 4 … 32, `lb-r0-i{j}` has
    `homeFrom` loser of `wb-r0-i{2j}` and `awayFrom` loser of `wb-r0-i{2j+1}` (`// RB6-X1`). Counts games checked:
    1 + 2 + 4 + 8 = 15.
  - `X-DE-4 the worked tables for 4, 8 and 16`: the away feed of every drop-round game, typed from the rulebook's
    tables, as engine ids:
    - n = 4: `lb-r1-i0` ← `wb-r1-i0`.
    - n = 8: `lb-r1-i0` ← `wb-r1-i1`; `lb-r1-i1` ← `wb-r1-i0`; `lb-r3-i0` ← `wb-r2-i0`.
      **`// differential: today lb-r1-i0 ← wb-r1-i0 and lb-r1-i1 ← wb-r1-i1 (bracket.ts:486)`**.
    - n = 16: `lb-r1-i0` ← `wb-r1-i3`; `lb-r1-i1` ← `wb-r1-i2`; `lb-r1-i2` ← `wb-r1-i1`; `lb-r1-i3` ← `wb-r1-i0`;
      `lb-r3-i0` ← `wb-r2-i0`; `lb-r3-i1` ← `wb-r2-i1`; `lb-r5-i0` ← `wb-r3-i0`.
    Asserts 1 + 3 + 7 = 11 feeds checked. The home feed of each is the winner of `lb-r{L−1}-i{j}`.
  - `X-DE-4 the four steps of the cycle, by the rule's own formula`: for c = 0 … 3 (m = c and m = c + 4) and
    G ∈ {2, 4, 8, 16}, `lbDropGameRB6X2(m, G, i)` equals the RB6-X2 formula written out in the test in 1-based form
    (`p = G + 1 − i`, …) and converted. One literal row per step at G = 8, i = 0 … 7 (`// RB6-X2`):
    c = 0 → `[7,6,5,4,3,2,1,0]`; c = 1 → `[3,2,1,0,7,6,5,4]`; c = 2 → `[4,5,6,7,0,1,2,3]`; c = 3 → `[0,1,2,3,4,5,6,7]`.
    G = 1 → 0 for every m.
  - `X-DE-4 every step is its own inverse and a bijection`: for m = 0 … 7 and G ∈ {1, 2, 4, …, 128},
    `map(map(i)) === i` for every i and the image is 0 … G − 1 exactly. Asserts the count of (m, G, i) triples:
    8 × (1 + 2 + 4 + 8 + 16 + 32 + 64 + 128) = 2040.
  - `X-DE-4 every losers' bracket seat is fed exactly once` for frames 4 … 64: each WB fixture's loser feeds exactly
    one seat, each LB fixture but the last feeds its winner to exactly one seat, no LB loser is fed anywhere. Counts
    the LB seats checked: 2 × (frame − 2) per frame.
  - `X-DE-5 survivor rounds pair neighbours and the LB final feeds the grand final`: `lb-r{L}-i{j}` for even L ≥ 2
    takes the winners of `lb-r{L−1}-i{2j}` and `i{2j+1}`; `gf.awayFrom` is the winner of the last LB game
    (`// RB6-X3, X4`). Counts games.
  - `X-DE-4 byes do not move a drop` (RB6-X5): for n = 5, 6, 7 every `awayFrom` / `homeFrom` equals n = 8's.
  - `X-DE-4 the index refuses a bad call`: `games: 3`, `i: -1`, `i: games`, `m: -1`, `m: 0.5` each throw
    `CONFIG_INVALID` with `reason: "drop_game_invalid"`.
  - Sequence: a second `generateDoubleElim` call on the same input is deep-equal; fixture ids at n = 8 are exactly the
    ids of origin/main (typed list of 14: 7 `wb-`, 6 `lb-`, `gf`), so no stored `ext_key` moves.
- [ ] **Step 2: Run** the verify command on `src/scheduling/double-elim-drops-w6.test.ts`. Expected: FAIL (the worked
  tables for 8 and 16, the cycle, and `lbDropGameRB6X2` is not exported).
- [ ] **Step 3: Implement** `lbDropGameRB6X2` and read the drop round's away feed through it:
  `awayFrom: loserOf(wbLosers[lbDropGameRB6X2(m, prev.length, j)] as string)` for LB game j. Its comment states the
  rulebook row, the 1-based to 0-based mapping, and that the loop reads i from j only because each map is its own
  inverse. Rewrite the :436-439 header comment to name RB6-X1 to X3.
- [ ] **Step 4: Run** the verify command on the new file plus `src/scheduling/bracket.test.ts
  src/scheduling/bracket-layout.test.ts src/scheduling/greedy-fed-line-rest.test.ts`; tsc; eslint; boundary.
  Expected: PASS (`bracket-layout.ts` draws in-lane connectors only, :73, so no layout moves).
- [ ] **Step 5: Mutate once:** make every round regular (`return i` first) → `X-DE-4 the worked tables for 4, 8 and 16`
  reds; restore. Then drop the argument guard → `X-DE-4 the index refuses a bad call` reds; restore.
- [ ] **Step 6: Rows** X-DE-2, X-DE-3, X-DE-4, X-DE-5 proved by `packages/engine/src/scheduling/double-elim-drops-w6.test.ts`;
  `enforced at` `packages/engine/src/scheduling/bracket.ts`.
- [ ] **Step 7: Commit** `feat(bracket)!: losers'-bracket drops cross by the four-step cycle (X-DE-2..5)`.

**Reviewer's four questions:** second call: the determinism test. Empty: n = 2 has no LB row; G = 1. After a
withdrawal or void: not applicable to generation, and RB6-X5 (byes) is its nearest case. Another sport: the header
reason line.

### Task 3: The rematch field sweep (B1; X-DE-6)

Test-only. Authority: design §4.3 "Smallest test that fails today", §6.1 row 2, §6.6 (R25); OWNER 300; RB6-X6, X7, X8,
E7; E(4) = 2, E(8) = 3, E(16) = 4, E(32) = 5 (rulebook RB6-X6).

**Files:**
- Test: `src/scheduling/double-elim-rematch-w6.test.ts` (new)

**Interfaces:** Consumes `generateDoubleElim` (T2). Produces nothing.

**The play harness (in the test file, not a reference model).** It walks the generator's own fixtures in order, as
`resolveBracket` does (`bracket.test.ts:33-83`): an `award` advances its entrant with no loser; a fixture with one
empty seat advances the seated side with no loser (RB6-B2); one with two empty seats **is marked resolved with no winner and no loser** (RB6-B3), so the fixtures it feeds
go on (`resolveBracket` `continue`s there, :59, and would stall at n = 5: do not copy that line);
`gf-reset` is skipped (RB6-X8). A real match asks a `pick(fixture, home, away)` for the winner. It records, per LB
fixture that was a real match, its 1-based LB round (`L + 1`) and whether the pair had met before in any earlier
fixture, WB or LB. It returns the LB matches played, the rematches and the count of distinct pairs that met.

**Axes.** n = 2 … 32 (31 sizes, odd fields included). Two draws: *fully seeded* (`seeds` = strength order 1 … n) and
*partly seeded* (strength 1 … 4 keep seeds 1 … 4; strengths 5 … n take seeds 5 … n in
`shuffle(1000 + n, …)` order, `core/rng.ts:21`; at n ≤ 4 the two draws are equal and still both run). Ten result
scripts: `favourite` (the stronger entrant wins), `underdog`, and eight seeded coins (`mulberry32(n * 100 + s)`,
s = 1 … 8). 31 × 2 × 10 = **620 runs**.

- [ ] **Step 1: Write the tests:**
  - Empty first: `X-DE-6 a field of 2 plays no losers' bracket match and is excluded by name` — n = 2, every run: 0 LB
    matches (`// RB6-E3, E7`). Asserts 20 runs.
  - `X-DE-6 no pair meets again in the losers' bracket before round E(frame), on every draw and every script`:
    for n = 3 … 32 every rematch's LB round is ≥ E(nextPowerOfTwo(n)), E typed as `{ 4: 2, 8: 3, 16: 4, 32: 5 }`
    (`// RB6-X6`). Per run the LB matches played equal **n − 2** (`// RB6-D4: every entrant but the two finalists
    takes two losses, so n − 1 WB matches and n − 2 LB matches`). Totals asserted: 600 runs, **9300** LB matches
    (20 × Σ(n − 2), n = 3 … 32 = 20 × 465), pairs met > 0.
  - `X-DE-6 on a fully seeded field with the favourite winning there is exactly one rematch, the LB final, seed 3 v seed 2`:
    n = 3 … 32, fully seeded, `favourite`: exactly one rematch, in LB round 2k − 2, between strengths 2 and 3
    (`// RB6-X7`). Asserts 30 fields. **`// differential: today 3 rematches at n = 8 and 7 at n = 16 (straight drops,
    rulebook §4 "Product today")`**. A comment says n = 4 cannot tell right from wrong (1 either way).
  - `X-DE-6 exactly one is not claimed for a partly seeded draw`: on the partly seeded draw with `favourite` the test
    asserts the X-DE-6 bound and nothing about the count (`// RB6-X7: 2 or 3 rematches in about 28% of such draws at
    16`). It states the fields checked: 30. A comment forbids adding a count here.
  - `X-DE-6 the n = 8 case where crossed and straight drops differ`: draw 1 v 8, 4 v 5, 3 v 6, 2 v 7
    (`seedPositions(8)`, bracket.ts:53). Let X = home of `wb-r0-i0`, Y = its away. Script: X beats Y; X loses
    `wb-r1-i0`; X and Y win every other match they play; elsewhere home wins. Expected (`// RB6-X2 worked table n=8:
    LB 2.2 = W LB 1.2 v L WB 2.1`): X plays `lb-r1-i1`, Y plays `lb-r1-i0`, LB round 2 holds **no** rematch, and the
    first rematch is X v Y in `lb-r2-i0`, LB round 3 = E(8). Under straight drops X meets Y in `lb-r1-i0`, round 2.
  - `X-DE-6 a rematch in round E(frame) is reachable at 4, 8, 16 and 32`: the same X and Y; X loses at WB round index
    1 for frames 4 and 8 and index 2 for frames 16 and 32 (the loser of `WB 2.1`, `WB 2.1`, `WB 3.1`, `WB 3.1`; rulebook
    "Earliest possible rematch" under each worked table, and RB6-X2 for 32). Expected: the earliest rematch is X v Y in
    LB round 2, 3, 4, 5. Asserts 4 frames. So the bound is tight, not "never".
  - Sequence: the 620-run total is asserted in the file's last `it` (a `-t` slice goes red); a second pass over one
    run gives the same counts.
- [ ] **Step 2: See it red against today's rule:** temporarily make `lbDropGameRB6X2` return `i` (straight drops,
  which is origin/main's behaviour), run the verify command on this file. Expected: FAIL in at least the bound test, the
  exactly-one test (n = 8, n = 16), the n = 8 differential, and the reachability rows for frames 8 and 32 (straight
  drops give rounds 2 and 4 there; frames 4 and 16 give the same round under both rules, so those two rows are not
  differentials). Paste the failures; restore.
- [ ] **Step 3: Run** the verify command on this file with T2's code. Expected: PASS, with the counts above.
- [ ] **Step 4: Mutate once:** the harness's "met before" set — clear it per round → the reachability test reds
  (a sweep that cannot see a rematch is decoration); restore.
- [ ] **Step 5: Rows** X-DE-6 proved by `packages/engine/src/scheduling/double-elim-rematch-w6.test.ts`; `enforced at`
  `packages/engine/src/scheduling/bracket.ts`.
- [ ] **Step 6: Commit** `test(bracket): losers'-bracket rematch sweep over 2..32, both draws (X-DE-6)`.

**Reviewer's four questions:** second call: the repeated run. Empty: n = 2 by name. After a withdrawal or void: a
one-dead-seat line and a two-dead-seat line are in the harness (n = 5 has both) and count as no match. Another sport:
the `describe`-body reason line.

### Task 4: Fewer than 2 entrants is refused; 2 and 3 by name (B1; X-DE-16)

Authority: design §5.5, §6.1 rows 7 and 8, call 19; OWNER 304; RB6-E1 to E5.

**Files:**
- Modify: `src/scheduling/bracket.ts:447` (`if (wb.finalId === undefined) return …`)
- Test: `src/scheduling/double-elim-small-w6.test.ts` (new)

**Interfaces:** Produces the `double_elim_needs_two` refusal (block above). App PR B: `linesOfShape` answers 0 below 2.

- [ ] **Step 1: Write the failing tests:**
  - Empty first: `X-DE-16 0 entrants is refused by name` and `X-DE-16 1 entrant is refused by name`:
    `generateDoubleElim` throws `EngineError` code `CONFIG_INVALID`, `data.reason === "double_elim_needs_two"`,
    `data.entrants` 0 and 1; with `bracketReset: true` too (`// RB6-E1, E2`).
    **`// differential: today both return { fixtures: [], rounds: 0 } (bracket.ts:447)`**.
  - `X-DE-16 a field of 2: one WB match, no LB match, the grand final is the same pair` (`// RB6-E3`): fixtures are
    exactly `wb-r0-i0`, `gf` (and `gf-reset` with the reset on); `gf.homeFrom` winner of `wb-r0-i0`, `gf.awayFrom`
    loser of `wb-r0-i0`; `gf-reset` conditional.
  - `X-DE-16 a field of 3: seed 1 has the bye and LB 1.1 has one dead seat` (`// RB6-E4`): `wb-r0-i0` is an award to
    seed 1; `wb-r0-i1` is seed 3 v seed 2 (in either seat order, RB6-D6); `lb-r0-i0` is fed by the losers of both;
    `lb-r1-i0` by the winner of `lb-r0-i0` and the loser of `wb-r1-i0`. Four matches (2 v 3, WB final, LB final, GF1),
    one bye line and one LB line with a dead seat: 6 fixtures, 7 with the reset. At n = 2: 2, and 3 with the reset.
  - `X-DE-16 a field of 2 or 3 crowns one champion` (`// RB6-E5`): play both with T3's harness shape (copy the few
    lines; do not import a test file) and assert a grand-final winner exists.
  - Sequence: a second call throws the same; `generateSingleElim` below 2 is unchanged (returns the empty bracket,
    bracket.ts:222 — the knockout's refusal stays the app's, X-SD-1, X-SD-2).
- [ ] **Step 2: Run** the verify command on the new file. Expected: the two refusal tests FAIL.
- [ ] **Step 3: Implement:** replace the early return at :447 with the throw, keyed on `opts.entrants.length < 2`,
  before `buildSingleElim` is called. TypeScript still needs `wb.finalId` narrowed after it: keep that as an internal
  invariant that throws, with a comment that it cannot be reached past the refusal. Check the engine's own callers: `src/testkit/simulation.ts:1107` draws 2 to 64
  entrants (`drawEntrantCount`, :228-231), so it never reaches the throw.
- [ ] **Step 4: Run** the verify command on the new file plus `src/scheduling/bracket.test.ts
  test/stryker-floor.test.ts`; tsc; eslint.
- [ ] **Step 5: Mutate once:** remove the throw → both refusal tests red; restore.
- [ ] **Step 6: Rows** X-DE-16 proved by `packages/engine/src/scheduling/double-elim-small-w6.test.ts`; `enforced at`
  `packages/engine/src/scheduling/bracket.ts`.
- [ ] **Step 7: Commit** `feat(bracket)!: a double elimination under 2 entrants is refused by name (X-DE-16)`.

**Reviewer's four questions:** second call: the repeated throw. Empty: 0 entrants. After a withdrawal or void: a field
that shrank to 1 is this refusal. Another sport: the `describe`-body reason line.

**B1 batch review** after T4: one reviewer pass over T2–T4 together.

### Task 5: `resetOwed`, the `conditional` flag and the `reset_owed` refusal (B2; X-DE-10, X-DE-11, X-DE-12, X-CH-9)

Authority: design §4.2 "What changes" (the predicate, the flag, the engine's refusal) and "Smallest test that fails
today (engine)", §6.1 row 5, call 5; OWNER 293, 298, 305(b); RB6-G4, G5, G6, G7, G10, G11, C2, C3, C4, D6, F7.

**Files:**
- Modify: `src/competition/stage.ts` — `BracketFixture` :65-92 (add `conditional`); `BracketCompletionRefusal` :276
  and `bracketCompletionRefusal` :283-287 (its comment :278-282 says "A voided reset … [is] settled": reword);
  `bracketTitle` :662-666 and its doc :657-661; `completeBracketStage`'s message :677-681; add `resetOwed` after
  `isBracketStageComplete` (:289-294)
- Test: `src/competition/double-elim-reset-w6.test.ts` (new)

**Interfaces:** Produces `BracketFixture.conditional`, `resetOwed`, the `reset_owed` refusal and the changed
`bracketTitle` (block above). Consumer: app PR B's `settleReset` and `toBracketFixture`.

**The rig.** Rows are hand-written, n = 4, in the generator's shape with the reset on: `wb-r0-i0`, `wb-r0-i1`,
`wb-r1-i0`, `lb-r0-i0`, `lb-r1-i0`, `gf` (`isFinal`, `homeFrom` winner of `wb-r1-i0`, `awayFrom` winner of
`lb-r1-i0`), `gf-reset` (`isFinal`, `conditional`, `homeFrom` winner of `gf`, `awayFrom` loser of `gf`), each with its
`bracket`. W = the WB champion, L = the LB champion. One builder takes GF1's row and the reset's row.

- [ ] **Step 1: Write the failing tests:**
  - Empty first: `X-DE-11 no fixtures, and a bracket with no conditional row, owe nothing` — `resetOwed([])` is false;
    the rig without `gf-reset` is false; the rig with a `gf-reset` row that lacks `conditional` is false and
    completes as today (Review Focus 3; the app's shape before PR B).
  - `X-DE-12 an earned reset that is void refuses completion`: L won GF1, reset `void` →
    `completeBracketStage` throws `STAGE_NOT_READY`, `data.reason === "reset_owed"`, `data.reset === "gf-reset"`,
    `data.grandFinal === "gf"`; `isBracketStageComplete` is false; `bracketTitle` is undefined
    (`// RB6-G7, G10`). **`// differential: today it completes and ranks GF1's winner 1st (stage.ts:283-287, :825-834)`**.
  - `X-DE-11 the pair: the WB champion won GF1, the reset is void, the stage completes` with W 1st, L 2nd
    (`// RB6-G6`).
  - `X-DE-11 the shapes of GF1` — one table, `resetOwed` per row, the count asserted (**9**):

    | GF1 | owed | row |
    |---|---|---|
    | scheduled | false | G8 |
    | decided, W won | false | G6 |
    | decided, L won | **true** | G11 |
    | decided, L won, seats swapped (L home, W away) | **true** | D6 |
    | decided, W won, seats swapped | false | D6 |
    | `jointWinners` | false | G11, C5 |
    | walkover, `walkedOver: "both"` | false | C4 |
    | walkover, L won, `walkedOver: "loser"` (W out of the stage) | false | C2 |
    | walkover, L won, no loser (the WB seat dead after a WB-final double walkover: `wb-r1-i0` is `walkedOver: "both"`, GF1's home seat empty) | false | F7, G11 |

    Each not-owed row with the reset `void` completes (or, for `scheduled`, refuses `fixtures_undecided`).
  - `X-DE-11 a forfeit in GF1 by the WB champion earns the reset` (`// RB6-F9`): GF1 `status: "walkover"`, winner L,
    loser W, **no** `walkedOver` (a one-loss forfeit is a plain loss) → owed. By the LB champion (winner W) → not owed.
  - `X-DE-11 n = 2: the LB champion is the WB final's loser`: rows `wb-r0-i0`, `gf` (`homeFrom` winner and `awayFrom`
    loser of `wb-r0-i0`), `gf-reset`; the WB final's loser wins GF1 → owed; its winner wins GF1 → not owed
    (Review Focus 5).
  - `X-DE-10 reset played: the LB champion must win twice` (`// RB6-G4`): L wins GF1 and the reset → `bracketTitle`
    champion L and L ranks 1st; L wins GF1, W wins the reset → champion W. `X-DE-10 single match: GF1 decides`
    (`// RB6-G5`): no reset row, L wins GF1 → champion L, W 2nd.
  - `X-CH-9 a finalist out between GF1 and an earned reset: the reset is a walkover and settles it`
    (`// RB6-C3`): owed, reset `walkover` with a winner and `walkedOver: "loser"` → completes, that winner champion.
    `X-CH-9 both out on the reset: vacant title` (`// RB6-C4`): reset `walkedOver: "both"` → completes, title vacant.
  - `X-DE-11 the reading refuses a broken wiring`: two conditional rows → `reset_not_unique`; a reset with no
    `awayFrom`, or whose feeds name two fixtures → `reset_feed_invalid`; GF1 with no `homeFrom`, or with both feeds
    from LB rows → `grand_final_feed_invalid`. Each is `CONFIG_INVALID`.
  - Sequence: `resetOwed` called twice on the same rows answers the same and mutates nothing (deep-equal before and
    after); GF1 corrected from W to L and back flips the answer each time; the owed-and-void rows with the reset
    then set `decided` complete.
- [ ] **Step 2: Run** the verify command on the new file. Expected: FAIL (`resetOwed` is not exported; the void
  reset completes).
- [ ] **Step 3: Implement** per the Interfaces block. `bracketCompletionRefusal` returns
  `{ reason: "reset_owed", reset, grandFinal }` after its two existing checks when `resetOwed(fixtures)` and the
  conditional row's status is `void`. `bracketTitle` returns undefined in that state. `completeBracketStage` words the
  third message: `bracket stage "<id>" owes a grand-final reset ("<reset>") that is void`. `decidingFinal` (:825-834)
  is not changed: completion refuses before ranks are read, and a mid-bracket read stays provisional. Re-key the
  moved `stage.ts` entries of `stryker-equivalent.json` (Global Constraints).
- [ ] **Step 4: Run** the verify command on the new file plus `src/competition/bracket-complete-w4.test.ts
  src/competition/bracket-ranks-w4.test.ts test/stryker-floor.test.ts`; tsc; eslint; boundary. Expected: PASS (`bracket-complete-w4.test.ts:109`
  holds a `gf-reset` row with no `conditional`, so it still completes).
- [ ] **Step 5: Mutate, one at a time:** `resetOwed` returns false → `X-DE-12 an earned reset that is void refuses
  completion` reds; returns true → the WB-champion pair reds; drop the loser requirement → the F7 row of the shapes
  table reds; read the LB side from "GF1's away seat" instead of the feeds → the two seats-swapped rows red; drop the
  `walkedOver` check → the C2 row reds; read the rows through `resolveDeadSeats` and drop the `walkedOver` check
  together → still the C2 row (so the raw-rows choice is not what holds F7: note it in the commit body). Restore after each.
- [ ] **Step 6: Rows** X-DE-10, X-DE-11, X-DE-12, X-CH-9 proved by
  `packages/engine/src/competition/double-elim-reset-w6.test.ts`; `enforced at`
  `packages/engine/src/competition/stage.ts`. X-DE-11, X-DE-12 and X-CH-9 keep "app refusals: W6 app PR B" in their
  citation until T10 appends the app's paths.
- [ ] **Step 7: Commit** `feat(stage)!: resetOwed and the reset_owed completion refusal (X-DE-10..12, X-CH-9)`.

**Reviewer's four questions:** second call: the purity test. Empty: `resetOwed([])` and the no-conditional rig. After
a withdrawal or void: rows C2, C4, F7 and the void-reset refusal itself. Another sport: the `describe`-body reason line.

### Task 6: Places by exit round (B3; X-FR-6, X-FR-7, X-FR-8; X-DE-1 and X-FR-3 re-proved)

Authority: design §5.1 "What changes (engine)" and "Smallest test that fails today (engine)", §4.4 "Ranks agree with
seats", §6.1 rows 3 and 6, calls 10 and 12; OWNER 297, 303, 294, 302; RB6-R1 to R8 and both place tables.

**Files:**
- Modify: `src/competition/stage.ts` — `bracketRanks` :942-1085 (a `double_elim` branch replacing `rankRest` /
  `placeNext` :1010-1017, :1030, :1082 for that kind only; the `outAt` block :966-977 is not read by the branch);
  the `walkedOver` doc :77-81; the header comment :934-941
- Modify: `src/competition/w2b-tables.test.ts:273-324` (the three X-DE-1 tests assert the old rule; rewritten below)
- Modify: `src/competition/bracket-ranks-w4.test.ts`, test by test:
  - :405-420, :713-717, :1442-1455, :1459-1465 — the generated double-elimination rows of the "stay strict 1..n"
    tables: n = 8 takes the shared places `1, 2, 3, 4, 5, 5, 7, 7` (`// RB6 place table n=8`), with the title's
    exceptions as each test has them;
  - :422-429 — the DRAW4 loop reads **knockout-shaped rows with no `bracket` lane** as `double_elim` and expects
    strict places plus `undeclared_shared_place`. No rulebook row describes a double elimination without lanes, so
    `double_elim` leaves this loop (kinds `stepladder`, `page_playoff`; `checked` 6 → 5), and the lane-less reading
    gets its own test in T7 (`lane_missing`);
  - :1248-1258 — X-SP-5 reads page-playoff rows as `double_elim` and expects E1 3rd, E4 4th by seed. Same reason:
    `double_elim` leaves the loop (`checked` 3 → 2);
  - :855-897 — the ranks-and-seats sweep plays brackets without feeds (`playOutBracket`), so after this task a WB
    forfeiter in its double-elimination row lands in the "shares last" fallback. Wrap that row's fixtures in the
    file's own `withFeeds` (:1269-1300) so it proves RB6-R7, not the fallback
- Modify: doc comments only, on `playOutBracket` (`src/testkit/bracket-play.ts:38`) and `playBracketStage`
  (`src/testkit/simulation.ts`, re-pin by `grep -a -n "playBracketStage"`): they
  copy neither feeds nor `conditional`, so a double elimination played through them ranks WB forfeiters by the
  fallback
- Modify: `stryker-equivalent.json` (re-key; the :975:33 entry sits in the `outAt` block the new branch does not read,
  so it stays valid for the other kinds)
- Test: `src/competition/double-elim-ranks-w6.test.ts` (new)

**Interfaces:** Produces the `double_elim` branch of `bracketRanks` (block above), including one internal helper
`doubleElimExitRounds(fixtures): Map<EntrantId, number>` (not exported; T7's guard calls it). Consumer: app PR B's
rank readers.

**The rig.** A helper in the test file plays a `generateDoubleElim` bracket into `BracketFixture[]` under a result
script and optional per-fixture overrides (a walkover, a double walkover, an empty seat), copying `bracket`, `round`,
`isFinal`, `conditional`, `homeFrom`, `awayFrom` from the generator. It also returns the script's own record: who
lost which LB fixture. **Expected ranks are computed from that record by RB6-R3**
(`rank = 1 + entrants placed above`: the champion, the deciding match's loser, then every entrant whose LB exit round
is later), never from `bracketRanks`. **The formula is the source of every expected rank** (design §5.1, R9); the
rulebook's place tables appear once, as a named cross-check that the test's formula reproduces them.

- [ ] **Step 1: Write the failing tests:**
  - Empty first: `X-FR-7 a field of 2: 1st and 2nd, nobody shares` (`// RB6-E3, R2`) and `X-FR-6 a field of 3: 1st,
    2nd, 3rd, nobody 4th` (`// RB6-E4`).
  - `X-FR-7 n = 8, every match played: the two LB round-2 losers are 5= and the two LB round-1 losers 7=`
    (`// RB6 place table n=8`). Favourite wins: ranks `1, 2, 3, 4, 5, 5, 7, 7` for seeds 1 … 8.
    **`// differential: today 1 … 8, strict by seed (stage.ts:1010-1017, :1030)`**.
  - `X-FR-7 n = 16`: `1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13` (`// place table n=16`).
  - `X-FR-7 odd fields`: n = 7 → one 7th (`1, 2, 3, 4, 5, 5, 7`); n = 6 → nobody 7th (`1, 2, 3, 4, 5, 5`); n = 5 → one
    5th (`1, 2, 3, 4, 5`) (`// odd-fields table, RB6-R5`). A comment: n = 4 cannot tell right from wrong.
  - `X-FR-7 seed does not order a shared place`: n = 8, draw 1 v 8, 5 v 4, 3 v 6, 7 v 2. Seed 1 loses `wb-r0-i0` to 8
    and then `lb-r0-i0`; seed 7 loses `wb-r0-i3` to 2 and then `lb-r0-i1` → seeds 1 and 7 both rank 7
    (`// RB6-X1: LB 1.1 takes the losers of WB 1.1 and 1.2, LB 1.2 those of WB 1.3 and 1.4; RB6-R3`). Seeds 1 and 8
    cannot both be there: they meet in WB 1.1. The two LB round-2 losers are not seed-adjacent → both rank 5.
    **`// differential: today seed 1 ranks 7th and seed 7 8th`**.
  - `X-FR-6 the top four are single and the reset changes only 1st and 2nd` (`// RB6-R2, R4`): n = 8; 3rd is the loser
    of `lb-r3-i0`, 4th the loser of `lb-r2-i0`; the same script with the reset off, on and not earned, and on and
    played (L wins both) gives the same places 3 … 8, and 1st / 2nd as RB6-R4 says. Asserts 3 variants.
  - `X-FR-7 the sweep`: n = 2 … 32 × {favourite, underdog, 4 seeded coins} × reset {off, on}: every entrant ranked
    once, exactly one rank 1, and each rank equal to the RB6-R3 value from the script's record. Asserts 31 × 6 × 2 =
    **372** runs and Σ n × 12 = **6324** entrants ranked.
  - `X-FR-7 the app's per-lane rounds rank the same` (Review Focus 1). A fully played bracket cannot see this (every
    exit is an LB loss), so the cases are the ones where a WB-side exit competes with an LB exit, n = 8, each built
    twice: generator rounds, and the app's (LB `round` = L, `gf` 0, `gf-reset` 1; app bracket-rounds.ts:21-24):
    a withdrawal in the WB final (`walkedOver: "loser"` on `wb-r2-i0`) → that entrant **3rd**, alone
    (`// RB6-R7: the LB final's seat; 1 + champion + runner-up`); a double walkover in the WB final → the two at
    **2nd, shared** (`// RB6-R10`); X-FR-8 (c) → 5th shared; X-FR-8 (d) → 2nd. Both numberings must give the
    rulebook's place. Asserts 4 cases × 2 numberings = 8. X-FR-8 (b) alone ties under both numberings and is not
    one of them.
  - `X-FR-3 a one-loss forfeit is a plain loss: ranked by the second loss` (`// RB6-R6`): n = 8, `wb-r0-i0` settled
    `walkover` with winner and loser and no `walkedOver`; the loser then wins `lb-r0-i0` and loses `lb-r1-i0` → ranks
    5=. With `walkedOver: "loser"` on the same row (a withdrawal) they are out there and rank 7= (the pair).
  - `X-FR-8 a withdrawn entrant takes the place of the LB round of the seat they vacate` (`// RB6-R7`), n = 8:
    (a) `walkedOver: "loser"` in `lb-r0-i0` → 7= with that round's other loser;
    (b) `walkedOver: "loser"` in `wb-r1-i1` (its loser feeds `lb-r1-i0`, T2's table) → LB round 2, 5= with the loser of
    `lb-r1-i1`; `lb-r1-i0` is then a walkover nobody loses;
    (c) the same through a dead seat: the entrant's `wb-r1-i1` seat is empty, the row is an awarded walkover, and
    `homeFrom` names them (`resolveDeadSeats`, stage.ts:915-932) → the same 5=;
    (d) a finalist out at GF1 (`walkedOver: "loser"` on `gf`) → 2nd.
  - `X-DE-1 a withdrawn entrant is out and is never read as dropped` — the rewritten `w2b-tables.test.ts` block
    (:273-324). Its hand-built rows are a straight-drop bracket (E3, the loser of `wb-r1-1`, sits in `lb-r1-1`), so
    the feeds added to the LB rows follow **the rows' own ids** (`lb-r1-1.awayFrom` = loser of `wb-r1-1`), never T2's
    table: a stored pre-11 bracket ranks by its stored edges. Three cases:
    - withdrawn (`walkedOver: "loser"` on `wb-r1-1`): E3 takes LB round 2's place with E5 → **5th, shared**
      (`// RB6-R7`). `// differential: today E3 is last, 8th (OUT_IN_WB_R1, :294)`;
    - the stale rows reach a **later** round (`around` gains a third parameter for `lb-r2-0`): `lb-r1-1` is E6 v E3
      won by E3, and `lb-r2-0` is E4 v E3 won by E4 (played, and as a second walkover), in both row orders (count 4
      kept). The earliest walkover wins — earliest by the **resolved LB round of the seat vacated**, never by raw
      `round` (raw rounds do not compare across lanes) — so E3 still takes LB round 2's place, now with E5 and E6.
      Assert the **full place list `1, 2, 3, 4, 4, 4, 7, 7`** (E1, E2, E4, then E3, E5, E6 at 4th, E7, E8;
      `// RB6-R7, RB6-R3: three ranked better; 306(c)`). E3 alone is 4th under the "latest loss" reading too, so E5
      and E6 at 4th (not 5th) are what make this case fail;
    - the positive pair: the same `wb-r1-1` as a played loss; E3 drops, wins `lb-r1-1` and loses `lb-r2-0` →
      **4th** (`// RB6-R2: the loser of LB 3.1`), against 5th shared for the withdrawal.
  - `X-FR-8 an entrant in no fixture, or whose line was voided, shares the last place` (plan's call).
  - Sequence: `bracketRanks` twice gives equal places; a mid-bracket read (WB final and LB final unsettled) still puts
    entrants in play above entrants out and refuses nothing (`bracket-ranks-w4.test.ts:267-284` stays green); the
    knockout, stepladder and page-playoff rows of the W4 "strict 1..n" tables are unchanged.
- [ ] **Step 2: Run** the verify command on the new file. Expected: FAIL (n = 8 ranks 5, 6, 7, 8).
- [ ] **Step 3: Implement** the branch and `doubleElimExitRounds` per the Interfaces block; rewrite the `walkedOver`
  doc and the two W2b / W4 comments that say a forfeit loser "never drops". **In this task
  `assertCompletedBracketPlaces` (:767) runs only the structural check for `double_elim`** and returns before its
  loop: the loop's "at most two" and `BRACKET_SHARED_RANKS` checks would refuse every finished field of 8 the moment
  the ranks share 5th. T7 puts the relations in that gap; the commit body says the guard is structural until then. Update the listed W4 and W2b tests to the
  rulebook's places (expected values from the place tables, never from a re-run).
- [ ] **Step 4: Run** the verify command on the new file plus `src/competition/w2b-tables.test.ts
  src/competition/bracket-ranks-w4.test.ts src/competition/bracket-complete-w4.test.ts
  src/competition/progression-w4.test.ts src/competition/first-loss.test.ts test/stryker-floor.test.ts`; tsc; eslint;
  boundary. Expected: PASS.
- [ ] **Step 5: Mutate, one at a time:** fall back to seed order inside a group (strict ranks) → `X-FR-7 n = 8` reds;
  compare LB rounds with WB rounds (use `fixture.round` across lanes) → the per-lane-rounds test reds on its
  WB-final withdrawal row; rank the walked-out entrant by their latest loss → the stale-row X-DE-1 case reds; read a
  walked-out WB entrant at the WB fixture's own round → `X-FR-8` (b) reds; treat a plain walkover loss as out →
  `X-FR-3` reds. Restore after each.
- [ ] **Step 6: Rows** X-FR-6, X-FR-7, X-FR-8 proved by `packages/engine/src/competition/double-elim-ranks-w6.test.ts`;
  append that path to X-FR-3; X-DE-1 keeps `w2b-tables.test.ts`. `enforced at` `packages/engine/src/competition/stage.ts`.
- [ ] **Step 7: Commit** `feat(stage)!: double-elimination places shared by losers'-bracket exit round (X-FR-6..8)`.

**Reviewer's four questions:** second call: the repeated read. Empty: n = 2, and the entrant in no fixture. After a
withdrawal or void: X-FR-8 (a)–(d) and the voided line. Another sport: the `describe`-body reason line.

### Task 7: The completed-places guard, and double walkovers near the top (B3; X-FR-9; X-FR-1, X-FR-2 re-proved)

Authority: design §5.1 "The guards" and "Named double-walkover cases", §6.1 row 4, calls 11, 12, 26; OWNER 305(d),
306(c), 301; RB6-R1, R8, R10, F5, F7.

**Files:**
- Modify: `src/competition/stage.ts` — `assertCompletedBracketPlaces` :767-798 (a `double_elim` branch before the
  loop); `BRACKET_SHARED_RANKS`' doc :204-208 and `FinalPlace`'s :197-198 (they no longer bound a double elimination);
  `declaredPlaces` :747-761 is not changed
- Modify: `stryker-equivalent.json` (re-key the moved `stage.ts` entries)
- Test: `src/competition/double-elim-places-guard-w6.test.ts` (new)

**Interfaces:** Consumes `doubleElimExitRounds` (T6). Produces the guard's `double_elim` branch and its reasons
(block above). The other three kinds take the existing path, byte for byte.

**The four relations, below the title** (design §5.1): a later exit round always ranks better; entrants with one exit
round hold one rank; no rank is shared across exit rounds; every rank is `1 + entrants ranked better`. Three checks
carry them, in the Interfaces block's order: `exit_round_order` is strict and compares **every pair** of entrants below the title (or sorts by
exit round first), never only list neighbours, so it also refuses a rank shared across
two exit rounds. **The title:**
a champion alone at 1 and, when the deciding match names a loser, that loser alone at 2; joint winners exactly the two
at 1; a vacant title nobody at 1 and the decider's two sides at 2. Nothing checks "four distinct top places".

- [ ] **Step 1: Write the failing tests** (rows built with T6's rig shape; copy the helper, do not import a test file):
  - Empty first: `X-FR-9 a completed field of 2 passes the guard`.
  - `X-FR-9 n = 4, a double walkover in LB 1.1: two at 3=, nobody 4th, and the stage completes` (`// RB6-R10`):
    `lb-r0-i0` `walkedOver: "both"`; `lb-r1-i0` a walkover nobody loses → ranks `1, 2, 3, 3`.
    **`// differential: on origin/main the two are split 3rd and 4th by seed (stage.ts:1010-1017)`**.
  - `X-FR-9 n = 8, a double walkover in LB 2.1: three at 4=` → `1, 2, 3, 4, 4, 4, 7, 7` (`// RB6-R10`). A second
    assertion feeds those places to the knockout path (`stage.kind: "knockout"`, same rows) and sees `more_than_two`
    (stage.ts:777-779): the refusal the design feared is real for the other kinds and gone for this one.
  - `X-FR-9 n = 8, a double walkover in WB 2.1` (both out, OWNER 301): `wb-r1-i0` `walkedOver: "both"`; `wb-r2-i0` and
    then `lb-r3-i0` walkovers nobody loses → the loser of `lb-r2-i0` 3rd, the two and the loser of `lb-r1-i0` at 4=,
    the LB round-1 losers 7=: `1, 2, 3, 4, 4, 4, 7, 7`.
  - `X-FR-9 n = 8, a double walkover in the WB final`: `wb-r2-i0` `walkedOver: "both"`; `lb-r3-i0` and `gf` settled
    with nobody losing → the LB champion 1st, the two WB finalists 2=, nobody 3rd, the loser of `lb-r2-i0` 4th, then
    5=, 5=, 7=, 7=: `1, 2, 2, 4, 5, 5, 7, 7`. With the reset on, `resetOwed` is false and the stage completes
    (`// RB6-R10, G11`).
  - `X-FR-9 n = 8, a double walkover in the LB final` (Review Focus 2): `lb-r3-i0` `walkedOver: "both"`; `gf` a
    walkover to the WB champion, no loser → `1, 2, 2, 4, 5, 5, 7, 7` (`// RB6-R3 and design call 12: whoever went out
    last ranks next; OWNER 306(c): two at 2nd, shared`).
  - `X-FR-9 a double walkover in the LB puts both out and nobody drops` (`// RB6-F5`): n = 8, `lb-r1-i1`.
  - `X-FR-1 the title shapes in a double elimination` (`// RB6-R8`): joint winners on GF1 → `1, 1, 3, 4, …`; a vacant
    title → `2, 2, 3, 4, …` and nobody 1st. Both complete.
  - `X-FR-9 the guard refuses a wrong order` — hand-written places over the n = 8 full bracket, each fed straight to
    `assertCompletedBracketPlaces`, each `CONFIG_INVALID` with its reason: two exit rounds swapped →
    `exit_round_order`; the two 5= written 5 and 6 → `exit_round_split`; a 5= and a 7= both written 5 →
    `exit_round_order` (the strict form: equal is refused); the LB round-3 loser written 5 with the two LB round-2
    losers, **listed with the LB-final loser (3) between them** so no two list neighbours break the rule →
    `exit_round_order` (a neighbour-only check passes it on to `not_competition_ranking`);
    `1, 2, 3, 4, 6, 6, 7, 7` → `not_competition_ranking`; two
    entrants at 1 with no joint final → `title_shape`; a row with no `bracket` → `lane_missing`; a walked-out WB
    entrant whose loser feed no row carries → `exit_round_unreadable`. Asserts 8 refusals.
  - `X-FR-9 a double elimination with no lanes is refused, never ranked strict`: the W4 file's lane-less 4-draw rows
    (`DRAW4`'s shape, rebuilt here) read as `double_elim` → `completeBracketStage` throws `CONFIG_INVALID`
    `lane_missing`, while `bracketRanks` on the same rows returns without throwing (the read path never refuses).
    This replaces the `double_elim` leg T6 took out of `bracket-ranks-w4.test.ts:422-429`.
  - `X-FR-2 the other three kinds still refuse a shared 5th`: a knockout, a stepladder and a page playoff fed
    `…, 5, 5, …` → `not_a_shared_rank`; `BRACKET_SHARED_RANKS` is still `{1, 2, 3, 4}`. Asserts 3 kinds.
  - `X-FR-9 no double walkover refuses the stage`: n = 8 and n = 16, a double walkover placed in turn on **every** WB
    and LB fixture that is a real match under the favourite script (the rest of the bracket then played out by the
    rig, vacated seats walked over), each completes with every entrant ranked once. The grand final is excluded by
    name (`// RB6-F8: refused upstream`). Asserts the fixtures tried: 13 at n = 8, 29 at n = 16 (2n − 3).
  - Sequence: the guard run twice on the same rows passes twice; completing the n = 4 case, then adding a corrected
    `lb-r0-i0` (played), gives `1, 2, 3, 4` again.
- [ ] **Step 2: Run** the verify command on the new file. Expected on T6's code: `the guard refuses a wrong order`
  FAILS on all 8 rows and the no-lanes case fails (the guard is structural only) and `X-FR-2 the other three kinds` passes; the double-walkover
  cases pass already, because T6 ranks them. They are in this task as the cases the new guard must not refuse: Step 4
  must keep them green.
- [ ] **Step 3: Implement** the branch in T6's gap, in the Interfaces block's order: structural check, `lane_missing`,
  `exit_round_unreadable`, the title shape, then the three checks from
  `doubleElimExitRounds(resolveDeadSeats(fixtures))`; return before the existing loop. Reword the two doc comments.
  Re-key `stryker-equivalent.json`.
- [ ] **Step 4: Run** the verify command on the new file plus `src/competition/double-elim-ranks-w6.test.ts
  src/competition/double-elim-reset-w6.test.ts src/competition/bracket-ranks-w4.test.ts
  src/competition/bracket-complete-w4.test.ts src/competition/w2b-tables.test.ts test/stryker-floor.test.ts`; tsc;
  eslint; boundary.
- [ ] **Step 5: Mutate, one at a time** (guards that could cover for each other, separately): delete each of the three
  checks in turn → its own row of `the guard refuses a wrong order` reds; compare list neighbours only in `exit_round_order` → the non-neighbour row reds; weaken `exit_round_order` from strict to
  "not worse" → the shared-across-rounds row reds; delete the `lane_missing` check → the no-lanes case reds; delete the title check → `title_shape`
  reds; send `double_elim` down the old path → `three at 4=` reds; apply the new path to a knockout → `X-FR-2 the
  other three kinds` reds. Restore after each.
- [ ] **Step 6: Rows** X-FR-9 proved by `packages/engine/src/competition/double-elim-places-guard-w6.test.ts`; append
  that path to X-FR-1 and X-FR-2.
- [ ] **Step 7: Commit** `feat(stage)!: a double elimination's completed places are checked by exit round (X-FR-9)`.

**Reviewer's four questions:** second call: the repeated guard. Empty: n = 2. After a withdrawal or void: every case
here is one. Another sport: the `describe`-body reason line.

**B3 batch review** after T7: one reviewer pass over T6–T7 together, reading `bracketRanks` and the guard side by side.

### Task 8: Changeset, branch gate, the engine PR (B4)

**Files:**
- Create: `.changeset/w6-double-elim-engine.md` (**major**)

- [ ] **Step 1: Changeset** `"@seazn-club/seazn-engine": major`, in the 10.0.0 entry's form (CHANGELOG.md, "## 10.0.0"):
  one summary line, then:
  - BREAKING: `generateDoubleElim` crosses the losers'-bracket drops (rulings 295, 300): the `awayFrom` of every drop
    round from WB round 2 on names a different winners'-bracket game for a frame of 8 or more. Fixture ids, rounds and
    every other feed are unchanged. A bracket already stored keeps the edges it was drawn with.
  - BREAKING: `generateDoubleElim` throws `CONFIG_INVALID` `double_elim_needs_two` below 2 entrants; it returned an
    empty bracket.
  - BREAKING: a double elimination's `finalRanks` share places by losers'-bracket exit round (rulings 297, 303,
    305(d), 306(c)): a rank below 2nd may repeat, and more than two entrants may hold one. `FinalPlace` is unchanged.
    `BRACKET_SHARED_RANKS` now bounds knockout, stepladder and page playoff only.
  - BREAKING: `completeBracketStage` throws `STAGE_NOT_READY` `reset_owed`, `isBracketStageComplete` is false and
    `bracketTitle` is undefined while a grand-final reset is owed and its row is void (ruling 298). It applies only to
    rows that carry the new `BracketFixture.conditional`: a consumer still sending rows without it never sees
    `reset_owed`. On rows that do carry it, `completeBracketStage`, `isBracketStageComplete` and `bracketTitle` can
    also throw `CONFIG_INVALID` `reset_not_unique`, `reset_feed_invalid` or `grand_final_feed_invalid`.
  - BREAKING: `assertCompletedBracketPlaces` / `completeBracketStage` refuse a double elimination whose rows carry
    no `bracket` lane (`CONFIG_INVALID` `lane_missing`).
  - BREAKING (meaning): in a double elimination `walkedOver: "loser"` now means "out of the stage"; such an entrant
    is ranked at the losers'-bracket round of the seat they vacate, not at the fixture's own round.
  - Added: `lbDropGameRB6X2`, `resetOwed`, `BracketFixture.conditional`.
  - Rules: 26 W6 rows (rulings 293–306); X-DE-1, X-FR-1, X-FR-2, X-FR-3 amended; X-DE-1's status is now 294.
  `cd "$WT" && pnpm fold-epoch:check --against origin/main; echo "EXIT=$?"` → `EXIT=0`, no epoch move.
- [ ] **Step 2: Branch gate:** one scoped verify run over exactly the files T1–T7 touched:
  `src/scheduling/double-elim-drops-w6.test.ts src/scheduling/double-elim-rematch-w6.test.ts src/scheduling/double-elim-small-w6.test.ts src/scheduling/bracket.test.ts src/scheduling/bracket-layout.test.ts src/competition/double-elim-reset-w6.test.ts src/competition/double-elim-ranks-w6.test.ts src/competition/double-elim-places-guard-w6.test.ts src/competition/w2b-tables.test.ts src/competition/bracket-ranks-w4.test.ts src/competition/bracket-complete-w4.test.ts src/competition/progression-w4.test.ts src/competition/first-loss.test.ts test/rules-reference.test.ts test/stryker-groups.test.ts test/stryker-floor.test.ts`;
  tsc; eslint on changed files; `pnpm boundary`; `pnpm single-sport --check --against origin/main`. Run it three times
  (AGENTS.md class 8). Expected: every `EXIT=0`, `failedSuites=0`; `grep -a -c '"W6 engine PR"' test/rules-reference.ts`
  is 0; the `"W6 app PR B"` entries are all present.
- [ ] **Step 3: PR body:**
  - `Matrix rows: double_elim|football, double_elim|cricket, double_elim|boardgame, double_elim|carrom, double_elim|generic, double_elim|volleyball, double_elim|badminton, double_elim|tabletennis, double_elim|tennis, double_elim|icehockey, double_elim|hockey`
    (derive the 11 keys from `builtinModules` at the time, never from this line);
  - the Interfaces block's "What the app plans must know";
  - the plan's calls: `lbDropGameRB6X2` is exported; `resetOwed` refuses a broken wiring; `decidingFinal` unchanged;
    an entrant in no fixture shares last place; list order inside a shared place is seed then id; the guard is
    structural between T6 and T7; X-DE-1's status moves to 294; a lane-less double elimination is refused at
    completion and ranked by the fallback on the read path;
  - the two hand-over pins for app PR B (X-DE-1 `AMENDED_TEXT`, and `signed(93)` → `signed(294, "2026-11-23")` at
    app `scripts/lib/w2b-rows.ts:53`); the `stryker-equivalent.json` entries re-keyed or removed; the stryker legs to re-measure (`draws-3`, `competition-5`); every
    `mutation:` line; the "Premises found false" list below.
- [ ] **Step 4: Whole-PR review, then push and open** `feat/w6-double-elim-engine` against engine main. Hand back.
  The owner merges. Do not wait on CI in the dispatch.

### Task 9: Release 11.0.0 (B4)

Follow the `engine-release` skill (`~/.claude/skills/engine-release/SKILL.md`) step for step; it defers to the engine
`AGENTS.md` "Releasing". Merges need the session's standing merge authority; this plan grants none.

- [ ] **Step 1: Preflight.** T8's PR merged. In the engine clone: `git status --short` clean apart from `.claude/`;
  `git fetch origin && git checkout main && git reset --hard origin/main`; `ls .changeset/*.md | grep -v README`
  lists `w6-double-elim-engine.md`; no open `release/` PR. Re-read `package.json`: the base is 10.0.4 or later
  (10.0.4 shipped the day this plan was written; another patch may have landed since).
- [ ] **Step 2: Cut.** `pnpm changeset status --output=/tmp/cs.json` must say **11.0.0** and `major`. If another
  major landed first, the version is the next one: use it everywhere below and hand the number back.
  `git checkout -b release/11.0.0 && pnpm changeset version`. The diff is only `package.json`'s version,
  `CHANGELOG.md` and the deleted changeset(s); otherwise stop. Commit `chore(release): 11.0.0`, push, open the PR
  with the new CHANGELOG section as its body.
- [ ] **Step 3: CI** green on the release PR (`gh pr checks <N> -R seazn-club/seazn.club.engine --watch`); the only
  allowed red is one listed under "Known red" in `AGENTS.md` (none at 10.0.4), matched by test name.
- [ ] **Step 4: Merge** with a merge commit (`gh pr merge <N> -R seazn-club/seazn.club.engine --merge`).
- [ ] **Step 5: Publish proof.** Watch the `Release` run; then all three:
  `gh api /orgs/seazn-club/packages/npm/seazn-engine/versions --jq '.[].name' | grep -x 11.0.0`;
  `gh release view v11.0.0 -R seazn-club/seazn.club.engine`; `git ls-remote --tags origin v11.0.0`. Any missing: stop.
- [ ] **Step 6: Epoch line.** The Release's epoch report must show no `FOLD_EPOCH` raised (design §6.1 expects none).
  If one is raised, stop and report: the app owes the epoch steps before its bump.
- [ ] **Step 7: Hand back** the version, the release URL and the epoch line. **This plan does not bump seazn.club**:
  the bump is app PR B's first commit (design §6.3), with `linesOfShape`, the X-DE-1 `AMENDED_TEXT` entry, the X-DE-1 status pin
  (app `scripts/lib/w2b-rows.ts:53`) and the awaiting-proof pins. Tell the W8 lane (design §6.5): the rule is RB6-G6, the predicate is `resetOwed`, the field is
  `BracketFixture.conditional`, and no sheet file was edited.

### Task 10: App PR B proof close-out (B5; GATED, Gate 3)

Docs-only engine PR after app PR B merges (design §12 step 3).

**Files:**
- Modify: `rules/cross-sport.md`, `test/rules-reference.ts` (the `"W6 app PR B"` entries)
- Create: `.changeset/w6-app-rows-proved.md` (patch)

- [ ] **Step 1: Gate:** app PR B is merged (`gh pr list --repo seazn-club/seazn.club --state merged --search "W6"`
  names it); else stop.
- [ ] **Step 2: For each `"W6 app PR B"` row,** fill `proved by` with the app test files whose titles hold the id as a
  whole token (app PR A's tests included: they gained the id at the bump), `enforced at` with its usecase, drop the
  citation note, delete the entry. Append app PR B's paths to X-DE-11, X-DE-12, X-CH-9, X-DW-2 and X-DW-3 **only**
  where a merged test title holds that id.
- [ ] **Step 3: Verify** the verify command on `test/rules-reference.test.ts`: `EXIT=0`, `failedSuites=0`;
  `grep -a -c '"W6 ' test/rules-reference.ts` is 0.
- [ ] **Step 4: Mutate once:** restore one deleted entry (X-DE-13) while its row carries `proved by` → red
  (`test/rules-reference.test.ts:118-119`); delete it again.
- [ ] **Step 5: Commit** `docs(rules): W6 app PR B rows proved` (body: the id → file list), patch changeset, PR. It
  ships with the next engine release; it needs no app bump of its own (design §12 step 3).

---

## Premises found false while planning

Each was checked against engine d1f07f8 (the files read are byte-identical at 10.0.4) or app 276fff25d7. They go to `_INDEX.md` "False premises found (W6)".

1. **"`BracketFixture.round` is monotonic across lanes"** (engine doc, stage.ts:63-64; the design's exit-round wording
   assumes one round axis). The generator numbers LB rounds after WB (`round: k + L`, bracket.ts:465, :484), but the
   app hands the engine rounds 0-based **per lane** (app `engine-db/bracket-rounds.ts:21-24`, used at
   `bracket-stage.ts:134`): LB round 0 is the first LB round and the grand final is round 0. So today's
   `bracketRanks` compares an LB round against a WB round for an app-built double elimination, and an exit-round rule
   written on `fixture.round` alone would be wrong in production while green on generator-shaped tests. Planned to
   the code: T6 compares LB rounds only with LB rounds and pins both numberings.
2. **Design §5.1: "n = 8 the LB final itself (two at 3=)".** RB6-R3's formula, RB6-R10's WB-final case (two at 2=,
   nobody 3rd) and the design's own call 12 ("the formula ranks whoever went out last 2nd") give **2=**: GF1 is a
   walkover with no loser, so nobody is placed between the champion and the two. Ruling 306(c) confirms it: two at 2nd, shared
   (T7).
3. **Design §5.1 and rulebook §10, "today the guard would refuse three holders of one rank".** True of the guard
   (stage.ts:777-779), but unreachable today: `bracketRanks` places strictly (`placeNext`, :1030), so a double
   walkover near the top completes on main with the sides split by seed. The defect on main is the split, not a
   refusal. The refusal becomes reachable the moment T6 shares a place, which is why T6 makes the guard structural
   for this kind and T7 follows at once.
4. **Design §4.2 pins the engine predicate at `bracketCompletionRefusal` `:271-296`.** It is :283-287; :271-273 is
   `undecidedBracketFixtures` and :289-294 `isBracketStageComplete`. `BracketCompletionRefusal` (:276) is a private
   type, so "gains a third reason" is visible to the app only as `EngineError.data.reason`.
5. **Design §4.3 / rulebook §4 pin the straight drop at `bracket.ts:475-489` / `:476-486`.** The loop is :475-489,
   the line that carries the rule is :486. No correction of substance.
6. **Design §5.5: "the generator returns the WB's fixtures and no grand final" below 2.** It returns no fixture at
   all (`buildSingleElim` answers the empty result under 2, bracket.ts:125, so :447 spreads an empty list). The
   knockout generator documents that as deliberate (:220-222, the refusal is the app's, X-SD-1 / X-SD-2), so the
   double-elimination throw is a new asymmetry between the two generators: intended by design call 19, and named in
   the changeset.
7. **The engine's `AWAITING_PROOF` map (`test/rules-reference.ts:55`) is not empty before W6**, though its own
   comment says every W4 entry "is to be gone by the W4 close-out" (:53-54). It still holds 37 `"W4 app PR A"`
   entries (:56-67), the same 37 the design's §12 cites from the app side. The app's pin after the bump is 37 plus the W6 app rows actually
   written, counted from the installed table.
8. **`resetOwed` cannot be evaluated on the rows the app builds today.** No app row carries `conditional` (the field
   does not exist), and the app voids an unneeded reset by GF1's home seat (app `bracket-stage.ts:258-268`). So on
   10.0.x-shaped rows the new refusal never fires; it is inert until app PR B sets `conditional` in
   `toBracketFixture`. That is by design (§4.2), and it is the seam app PR B must drive through its real producer.
9. **Design §12 records REC rows in the engine PR's table** (X-DE-5, X-LE-17, X-TP-8 are REC-only; five more mix a
   signed ruling with REC rows) **and also says "a row is recorded only for a signed rule".** Closed by ruling 306(a), which signs every REC row
   "build as written": all 26 rows are written.

## Self-review (done at writing)

- **Coverage (design §6.1, row by row):** crossed drops → T2; rematch sweep over 2 … 32 with odd fields, both draws,
  X6 everywhere and X7 on fully seeded only, the n = 8 differential and reachability → T3; `bracketRanks` branch → T6;
  the guard → T7; `resetOwed`, `conditional`, `reset_owed`, `bracketTitle` → T5; `walkedOver` documented, one-loss
  forfeit a plain loss → T6; the under-2 refusal → T4; n = 2 and n = 3 by name → T4 (structure), T5 (reset), T6
  (ranks); rule rows and `AWAITING_PROOF` → T1, T10; changeset and `Matrix rows:` → T8; release → T9.
- **Not in this plan, on purpose:** the reference model (R8), every app change, the seazn.club bump, sheets (W8).
- **Type consistency:** `lbDropGameRB6X2(m, games, i)` is the one name in T2, T3, T8 and the Interfaces block;
  `resetOwed(fixtures)` in T5, T7, T8; `doubleElimExitRounds` is internal to `stage.ts` and named in T6 and T7 only;
  refusal reasons are spelled once in the Interfaces block and reused.
- **Counts:** 26 rows = 14 + 12; T2 triples 2040, feeds 11; T3 620 runs, 9300 LB matches, 30 fields, 4 frames; T5
  9 shapes; T6 372 runs, 6324 entrants; T7 8 refusals + 1 no-lanes, 13 and 29 fixtures; T6 per-lane 4 cases × 2 numberings. Each derivation is beside its number.
- **Checked while planning, outside the repos:** a throwaway model of RB6-X1 to X3 (session scratchpad, not a
  deliverable and not a test source) agreed with the rulebook on the three worked tables, on one rematch (seed 3 v
  seed 2, the LB final) for every n = 3 … 32 with the favourite winning, on 1, 3, 7 under straight drops, on n − 2 LB
  matches per field, on the place tables for 4 … 8 and 16, and on T3's reachability script reaching rounds 2, 3, 4, 5.
  The implementer still derives every expected value from the rulebook rows the tests cite.

## Review notes for the builder

Plan review 1 (`.superpowers/sdd/2026-11-23-w6-double-elim/plan-review-engine.md`, main checkout): 7 Important and 14
Minor. No expected value changed; the reviewer's rulebook model matched every number here. Fixed in the text above:
all seven Important (1 ruling 306; 2 X-DE-1 status pin; 3 stryker re-key; 4 lane-less rows; 5 per-lane rounds; 6
X-DE-1 rewrite; 7 seeds 1 and 7) and Minors 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21. Left for the builder:

- **Finding 6, one new value.** The stale-row case's "E3, E5 and E6 share 4th" was written in the fix round from
  RB6-R7 and RB6-R3's formula; it is not in the reviewer's model. Re-derive it from the rulebook before asserting
  the number (re-review 2 re-derived `1, 2, 3, 4, 4, 4, 7, 7` and agreed).
- **Finding 13.** `resetOwed` no longer carries a `jointWinners` or a status term. The shapes table keeps both rows
  as inputs (expected false). If an implementer finds a shape where either term is needed, it goes in as an R28
  guard with a test that reaches it, never as a silent extra condition.
- **Finding 15.** `shared_across_exit_rounds` is not a reason any more: the strict `exit_round_order` covers it.
- **Finding 20 (not this plan's).** App plan A lists the n = 3 ext keys without `lb-r1-i0`; the generator emits
  `wb-r0-i0`, `wb-r0-i1`, `wb-r1-i0`, `lb-r0-i0`, `lb-r1-i0`, `gf`. For the app A planner.
- **Gap hunt, testkit.** `playOutBracket` (`src/testkit/bracket-play.ts:38`) and `playBracketStage` (`src/testkit/simulation.ts`) copy neither
  feeds nor `conditional`, so a sim invariant that reads RB6-R7 places or `reset_owed` sees the fallback. T6 adds one
  line to their doc comment saying so; carrying the feeds is not in this plan.
- **Gap hunt, layout.** The engine's bracket layout draws in-lane connectors only (`bracket-layout.ts:72-74`), so
  crossed drops need no layout change; the reviewer did not verify further. `bracket-layout.test.ts` is in the T8
  gate for that reason.
- **Finding 4, what the read path does without lanes.** It is the fallback ("shares last"), by this plan's call; no
  rulebook row covers a double elimination without lanes, which is why the two W4 loops drop the kind instead of
  pinning a number.
