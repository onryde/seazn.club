# W3 Swiss — Engine PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@onryde/seazn-engine`'s Swiss pairing, bye scoring and Swiss tie-breaks match the signed W3 rulebook (rulings 250–252): a named refusal instead of an empty pairing, legal and complete pairing, FIDE C.07 2026 art. 16 for every unplayed round, a bye that pays win points, no `byeScore`, and a Swiss default chain for all 11 sports. Every rule lands as a row in `rules/` in the same PR. The last task, the rules close-out, is a second engine PR gated on the app PRs.

**Architecture:** Three seams. (1) `scheduling/swiss.ts`: `pairRound` returns a discriminated union `SwissRound | SwissRefusal`. Bye selection retries. A score-group pass with a whole-group floater window runs first, with a complete whole-field search as the existence fallback. Non-chess home/away alternates softly. (2) `competition/points.ts` `payout`: a bye stops being a "forfeit row" outcome. (3) `competition/tiebreakers.ts` + `stage.ts`: the Swiss ledger is built per round from the stage's fixtures plus two new app-supplied facts (`TableFixture.unplayed`, `TableStage.swissAbsentRounds`). Every unplayed card carries its FIDE 16.2 category and its 16.4 dummy cap, and opponents read an adjusted score. Defaults and the new `opp_diff` key ride on that ledger.

**Tech Stack:** TypeScript (typescript-native / TS7), vitest 4, fast-check 3, zod 4, pnpm 10, changesets. Engine repo `onryde/seazn.club.engine`, base `main` c612f51.

**Spec:** `docs/superpowers/specs/2026-10-31-format-matrix-w3-swiss-design.md` (seazn.club, w3-spec tree, commit 9d190f7ce0). Scope: §5, §6.1, the engine side of §4 (missed rounds), and §12's "Engine PR" lines; the close-out task covers §12's "Close-out" lines. Read with `rulebook-W3-swiss.md` (§2, §4, §5, §10) and `_INDEX.md` rulings 250–252 (same directory as the rulebook, `docs/superpowers/specs/2026-09-27-format-matrix-prompts/`). Evidence with file:line: `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-31-w3/gaps.md`, `recs.md`.

## Global Constraints

- **Repo and tree.** Every edit is in a new engine worktree. Create it with `git -C ~/github/seazn.club.engine fetch && git -C ~/github/seazn.club.engine worktree add ~/github/seazn.club.engine-wt/w3-swiss -b feat/w3-swiss-engine origin/main`, then run `pnpm install --frozen-lockfile` there. `WT=~/github/seazn.club.engine-wt/w3-swiss`. Never edit `~/github/seazn.club` or the engine's main checkout. Prefix every command with `cd "$WT" &&` in the same call.
- **Scratch.** Each agent writes its outputs to its own subdirectory `OUT=<session scratchpad>/<agent-name>/`. Never `rm` a shared directory.
- **Scoped tests only.** Never the full suite, `pnpm test`, `test:coverage` or `sim:matrix`. Each task names its paths. Judge green ONLY like this:
  ```
  cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/<task>.json" <paths>; echo "EXIT=$?"
  node -e 'const r=require(process.argv[1]);console.log(`${r.numPassedTests}/${r.numTotalTests} failedSuites=${r.numFailedTestSuites}`);for(const t of r.testResults)console.log(t.name)' "$OUT/<task>.json"
  ```
  Green means all four hold: `EXIT=0`, passed equals total and total is above 0, `failedSuites=0`, and every name is under `$WT`. Never add `--testTimeout`. Never trust an `rtk` summary; use `rtk proxy` where a wrapper is involved.
- **Type and lint gates, every task:** `cd "$WT" && node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json; echo "EXIT=$?"` and `cd "$WT" && pnpm exec eslint --max-warnings 0 <changed files>; echo "EXIT=$?"`. Run `pnpm boundary` when an import is added to a `src/scheduling` or `src/core` file.
- **Expected values come from the rulebook or the engine's declarations, never from the code under test** (TEST-STRATEGY 3; `_RULES.md` R9). Each test that pins a number states its derivation in a one-line comment: the rulebook section, or "declared: `module.tablePointsRule(cfg, "swiss")`". At least one case per guard must have a right answer that differs from today's wrong one. Each such case is marked `// differential: today X`.
- **Anti-vacuity.** Every property, sweep and invariant counts what it checked and asserts the count is above 0. Zero is a failure. A rule set's empty case is its first test (R13, R25).
- **Mutate every new guard once.** Do it by hand, one guard at a time: delete it, or revert it to today's line. Confirm a named test reds, then restore. Record each as `mutation: <guard> → <test name> red` in the task's commit body. Two guards that cover for each other are mutated separately.
- **Sequence tests, every task:** a **second call**, an **empty input**, **after a withdrawal or void**, and **another sport** (use `forEachSport` from `src/testkit/for-each-sport.ts`). A single-sport test carries a one-line `// single-sport: <reason>`, or `pnpm single-sport --check --against origin/main` reds.
- **Rule rows** (`rules/README.md` grammar). Header `| id | rule | citation | status | enforced at | proved by |`. Every path is written `packages/engine/...` (`ENGINE_ROW_PREFIX`, `test/rules-reference.ts:55`), even in this repo. Status is `signed <ruling> 2026-10-31` or `deviation <ruling> 2026-10-31`. The id is a whole token in an `it(`/`describe(` title of every listed proof file. A row lands in the SAME commit as the code that makes it true, never ahead of it. Cross-sport Swiss ids are `X-SW-<n>`. **Never put `-KO-` in an id.** Re-check that an id is unused (`grep -a "<id> " rules/*.md`) before writing it. Verify with the engine checker: `npx vitest run ... test/rules-reference.test.ts`.
- **Allocated ids (Engine PR):** X-SW-1 … X-SW-11 in `rules/cross-sport.md`. Sport chain rows: BD-TB-2, TT-TB-2, VB-TB-3, TN-TB-3, FB-TB-5, HK-TB-3, IH-TB-3, CK-TB-2, CA-TB-2, GN-TB-2, BG-TB-4 (verified unused at c612f51).
- **Ruling numbers:** 250 (late entry), 251 (byes and missed rounds, `byeScore`), 252 (rulebook signed per rec: RB3-1, -4, -6, -8, -11). Do not invent a ruling. A rule with no ruling is a finding for the orchestrator, not a row.
- **Live divisions:** stage pins (`X-TB-2`, `pinStageTableRules`) keep the nine live badminton Swiss divisions on their pinned chain and rule. Rounds already paired keep their pairings. Nothing in this PR re-pairs a past round.
- **Changeset: `major`.** The `pairRound` return type and `SwissGame`/`buildSwissTable` change the API, and boardgame's FOLD_EPOCH rises (Task 6). One changeset file per PR: `.changeset/w3-swiss-engine.md`.
- **Commits:** one or more per task, conventional (`feat(swiss): …`, `test(swiss): …`). End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Commit or push only when the task step says so.

## Interfaces the app plan consumes (exact; the app plan is written against these)

```ts
// src/scheduling/swiss.ts  (subpath @seazn/engine/scheduling/swiss)
export const SWISS_NO_LEGAL_PAIRING = "SWISS_NO_LEGAL_PAIRING" as const;
export type SwissRefusalReason =
  | "field_too_small"   // fewer than 2 entrants
  | "no_bye_candidate"  // odd field and every entrant is bye-ineligible (P-A4)
  | "rematch"           // no rematch-free perfect matching exists (P-A1/A6)
  | "colour"            // a rematch-free matching exists, but none meets the chess colour limits (P-A5)
  | "search_limit";     // the search budget ran out before it proved either
export interface SwissRefusal {
  readonly ok: false;
  readonly code: typeof SWISS_NO_LEGAL_PAIRING;
  readonly reason: SwissRefusalReason;
  readonly field: number;          // standings.length, for the message ("Round N can't be paired")
}
export interface SwissRound {      // gains `ok: true`; otherwise unchanged
  readonly ok: true;
  pairings: SwissPairing[];        // always ⌊n/2⌋ ≥ 1 boards
  bye?: EntrantId;                 // present iff n is odd
  floated: EntrantId[];
}
export type SwissPairResult = SwissRound | SwissRefusal;
export const SWISS_SEARCH_BUDGET: number;   // 1_000_000 nodes per call
export function pairRound(
  standings: readonly SwissStanding[], history: SwissHistory,
  constraints?: SwissConstraints, budget?: number,   // budget defaults to SWISS_SEARCH_BUDGET
): SwissPairResult;
export interface SwissConstraints {
  chess?: boolean;
  pairing?: "fold" | "rank_adjacent";
  /** Task 4b (RB3-4, X-SW-10): pairRound PREFERS a legal pairing after which the next round is still pairable. The app
   *  sets it when the stage's rounds exceed the safe maximum ⌊n/2⌋ and this is not the last round. */
  lookAhead?: boolean;
  /** Task 4c (RB3-10, X-SW-11): only when pairing the stage's LAST round, the most points an entrant could hold before
   *  it ((rounds − 1) × win, in the standings' score units). An entrant whose score is over half of it is a topscorer
   *  (FIDE C.04.3 A.6). */
  finalRoundMaxScore?: number;
}
// SwissRound gains `nextRound?: "pairable" | "unpairable" | "unknown"`, present iff `lookAhead` was set. The app warns
// on anything but "pairable". It is never a refusal.
// SwissConstraints loses `byeScore` (Task 6). `history.colours` is now read for NON-chess too, as home = "W" /
// away = "B" (soft alternation, Task 4). The app's swissGen already sends it for every sport.
// A refusal writes nothing: no bye, no pairing. Never seat anything from a refusal.

// src/competition/stage.ts
export interface TableFixture {
  // …existing fields…
  /** W3 (X-SW-7): the side(s) that lost this fixture WITHOUT playing (FIDE C.07 16.2.2/16.2.4): "home"/"away" for a
   *  forfeit with nothing played, "both" for a double walkover. Absent = played (a retirement after play included). */
  unplayed?: "home" | "away" | "both";
}
export interface TableStage {
  // …existing fields… (`rounds` is now REQUIRED in practice on a Swiss stage with any unplayed round: CONFIG_INVALID otherwise)
  /** W3 (X-SW-7, X-SW-8): per entrant, the rounds (1-based) it was in the stage but not paired, either before its late
   *  entry or after its withdrawal. Each round is a zero-point unplayed round. Keys must be table entrants; a round must
   *  not be one the entrant holds a card in. Read only on a Swiss stage. */
  swissAbsentRounds?: ReadonlyMap<EntrantId, readonly number[]>;
}

// src/competition/points.ts  (the one authority the app calls to fill TableFixture.unplayed)
export function unplayedSidesOf(outcome: MatchOutcome, played: boolean, pair: FixtureResult): "home" | "away" | "both" | undefined;
export function swissDrawPoints(rule: PointsRule): number;   // rule.draw ?? rule.win.regulation / 2

// src/sport/module.ts
export type TiebreakerKey = /* … */ | "opp_diff";   // NEW: opponents' collective goal difference (Swiss only)
```

Other consumer-visible changes, none of which needs a call-site change:
- `payout` pays a bye win points.
- `BoardgameCfg` drops `byeScore`. A stored key is stripped on parse. `boardgame.ruleKeys.byeScore` is gone.
- Every sport's `defaultTiebreakers("swiss", cfg)` changes.
- The `buchholz`/`buchholz_cut1`/`sberger`/`opp_diff` metrics on a ranked row are in the table's own points (÷2 only when `rules.points.unit === "half"`).
- `buildSwissTable` is replaced by `buildSwissLedger` (no app caller).

## Epoch and version verdict (from `src/sport/fold-epoch.ts` and `src/testkit/GOLDEN-POLICY.md`)

| Task | Moves a golden corpus? | FOLD_EPOCH | FOLD_MINOR | Why |
|---|---|---|---|---|
| 1–4c pairing | no: scheduling is not folded | — | — | `pairRound` is not in any corpus |
| 5 bye payout | no: `payout` is the competition layer. No golden stream records a bye or calls `payout` (`grep -an "payout\|\"bye\"" src/testkit/golden*.ts` is empty) | — | — | module `standingsDelta` is unchanged |
| 6 `byeScore` removed | **yes**: 181 recorded boardgame states embed `\"byeScore\":2` | **boardgame 4 → 5** | boardgame stays 0 | precedent: W2e T12 deleted generic's inert `progressScore` the same way and took a MAJOR (`fold-epoch.ts:48`). A config change re-records the stream (GOLDEN-POLICY "Owes": major) |
| 7–10 tie-breaks, defaults | no: rank-time only | — | — | |

The changeset is **major** on two counts (API break + FOLD_EPOCH). `pnpm fold-epoch:check --against origin/main` must report boardgame only.

## Review Focus

1. **Ranking mid-round.** Some boards of the current round are undecided. A pending board must not read as an absence, so no dummy is added for it. The Buchholz equals the sum over decided rounds plus declared absences only. Pinned in Task 7.
2. **An entrant with two cards in one round** (an ad-hoc match on a live Swiss stage, #846) must still rank, not throw. Ruling 252 refuses new ad-hoc matches in the app, but rows may already exist. Pinned in Task 7.
3. **An odd field where every entrant is bye-ineligible** (odd n, n rounds played) must get `no_bye_candidate`, never a second bye. Today it falls back to "the absolute lowest" (`swiss.ts:168`). Pinned in Task 2.
4. **A no-draw sport with an odd win value** (custom rule win 3, no draw) gives a fractional dummy cap: 1.5 × rounds. It must be exact (multiples of ½ are exact in IEEE-754) and displayed unhalved. Pinned in Task 7.
5. **A live stage pinned to the old Swiss chain** (`h2h_points`, no Buchholz) must keep ranking by its pin after the new defaults land (X-TB-2). Pinned in Task 10.

---

### Task 1: `pairRound` returns a named refusal, never an empty success (SW-H1 engine half; RB3-4; X-SW-3)

**Files:**
- Modify: `src/scheduling/swiss.ts:41-50` (types), `:152-294` (`pairRound`: field guards, the `matched === null` return at `:279-283`)
- Modify: `src/testkit/simulation.ts:653-654` (`if (!paired.ok) break;` replaces the `pairings.length === 0` sniff)
- Modify: `src/scheduling/formats-ext.test.ts:137` and `src/scheduling/swiss.test.ts` call sites (narrow on `ok`)
- Create: `src/scheduling/swiss-w3.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-3)

**Interfaces:**
- Produces: `SWISS_NO_LEGAL_PAIRING`, `SwissRefusalReason`, `SwissRefusal`, `SwissRound` (`ok: true`), `SwissPairResult`, `SWISS_SEARCH_BUDGET`, and `pairRound(standings, history, constraints?, budget?)`, exactly as in "Interfaces the app plan consumes". `no_bye_candidate` is declared here and produced in Task 2.

- [ ] **Step 1: Write the failing tests** in `src/scheduling/swiss-w3.test.ts` (`describe("X-SW-3 …")`). Helper: `const st = (ids: string[]) => ids.map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }))`.

```ts
describe("X-SW-3 no legal pairing is a named refusal, never an empty success (rulebook §3.3, P-A6)", () => {
  it("X-SW-3 the empty case first: 0 and 1 entrants are refused field_too_small", () => {
    expect(pairRound([], { played: new Set() })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "field_too_small", field: 0 });
    expect(pairRound(st(["a"]), { played: new Set() })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "field_too_small", field: 1 });
  });
  it("X-SW-3 4 entrants who have all met: round 4 is past the even hard maximum n−1 (rulebook §3.1) → rematch", () => {
    const ids = ["a", "b", "c", "d"];
    const played = new Set(ids.flatMap((x, i) => ids.slice(i + 1).map((y) => pairKey(x, y))));
    expect(pairRound(st(ids), { played })).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 4 }); // differential: today {pairings: []}
  });
  it("X-SW-3 an odd field that cannot pair writes no bye (rulebook §3.3: 'writes nothing, not even the bye')", () => {
    // a, b, c have all met: no bye choice leaves a rematch-free pair
    const played = new Set([pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")]);
    const r = pairRound(st(["a", "b", "c"]), { played });
    expect(r).toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "rematch", field: 3 });
    expect("bye" in r).toBe(false);
  });
  it("X-SW-3 chess: two who never met, each White twice running → colour (P-A5: never three in a row)", () => {
    const colours = new Map([["a", ["W", "W"] as Colour[]], ["b", ["W", "W"] as Colour[]]]);
    expect(pairRound(st(["a", "b"]), { played: new Set(), colours }, { chess: true }))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "colour", field: 2 });
  });
  it("X-SW-3 a budget the search exhausts is search_limit, not a claim that no pairing exists", () => {
    expect(pairRound(st(["a", "b", "c", "d"]), { played: new Set() }, {}, 0)).toMatchObject({ ok: false, reason: "search_limit" });
  });
  it("X-SW-3 success is ok:true with ⌊n/2⌋ boards; a second call returns the same (determinism)", () => {
    const a = pairRound(st(["a", "b", "c", "d", "e"]), { played: new Set() });
    expect(a.ok && a.pairings.length).toBe(2);
    expect(pairRound(st(["a", "b", "c", "d", "e"]), { played: new Set() })).toEqual(a);
  });
  it("X-SW-3 a duplicated entrant is refused CONFIG_INVALID (assumption → guard)", () => {
    expect(() => pairRound(st(["a", "a"]), { played: new Set() })).toThrow(/CONFIG_INVALID|twice/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.** `cd "$WT" && npx vitest run --reporter=json --outputFile="$OUT/t1.json" src/scheduling/swiss-w3.test.ts; echo "EXIT=$?"`. Expect failures on `ok`/`reason`. A collect error from the missing exports is also an acceptable red.
- [ ] **Step 3: Implement** in `src/scheduling/swiss.ts`:
  - Add the types and constants above.
  - Guards, in order: a duplicate `entrantId` throws `EngineError("CONFIG_INVALID", …)` (import from `../core/errors.ts`), then `n < 2` returns `field_too_small`.
  - Replace the `:280-283` return with a refusal. Pick the reason by re-running the match with `colourLegal` forced true when `chess` is on: if that succeeds the reason is `"colour"`, otherwise `"rematch"`.
  - The node counter is checked against `budget`. When the budget is exhausted before a proof either way, return `"search_limit"`. Track it with a flag set where `nodes > budget` returns `null`.
  - Success returns `{ ok: true, … }`.
  - Update the file header comment ("an empty pairing" → the refusal).
- [ ] **Step 4: Fix the callers.** `simulation.ts:653-654` becomes `if (!paired.ok) break;`. Narrow `formats-ext.test.ts:137` and the existing `swiss.test.ts` call sites on `ok` (`simulate` stops at a refusal and records it; Task 3 rewrites its properties).
- [ ] **Step 5: Run, expect PASS:** `src/scheduling/swiss-w3.test.ts src/scheduling/swiss.test.ts src/scheduling/formats-ext.test.ts src/testkit/simulation.test.ts`, plus tsc, eslint and `pnpm boundary`.
- [ ] **Step 6: Mutate.**
  - (a) Restore `return { pairings: [], floated: [] … }` → the "rematch" test reds.
  - (b) Delete the `n < 2` guard → the empty-case test reds.
  - (c) Delete the colour re-run → the colour test reds (it reports `rematch`).
  - (d) Delete the duplicate guard → the duplicate test reds.
- [ ] **Step 7: Write row X-SW-3** in `rules/cross-sport.md`:
  - rule: "A Swiss round that has no legal pairing is refused with the named reason SWISS_NO_LEGAL_PAIRING (field too small, no bye candidate, every pairing a rematch, the colour limits, or the search limit) and writes nothing; an empty or partial round is never reported as success."
  - citation: "FIDE C.04.3 [C4]; rulebook RB3-4"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/scheduling/swiss-w3.test.ts`

  Run `test/rules-reference.test.ts` and confirm it is green.
- [ ] **Step 8: Commit** `feat(swiss): pairRound returns SWISS_NO_LEGAL_PAIRING instead of an empty round (SW-H1, X-SW-3)`.

---

### Task 2: Bye retry, no second bye, whole-group floater window, complete fallback (SW-L3, SW-L4, P-A4; RB3-1; X-SW-2)

**Files:**
- Modify: `src/scheduling/swiss.ts:132-150` (`floaterChoices`: lazy, whole group), `:162-178` (bye pick), `:279` (fallback)
- Test: `src/scheduling/swiss-w3.test.ts` (new `describe("X-SW-2 …")`)
- Modify: `rules/cross-sport.md` (append X-SW-2)

**Interfaces:**
- Consumes: Task 1's `SwissPairResult`, budget plumbing.
- Produces: the `no_bye_candidate` refusal. Bye choice per rulebook P-Q2: the candidates are the eligible entrants (not in `history.byes`), tried from the bottom of `pairingOrder` (lowest score, then lowest rank), and the first whose removal leaves a pairable remainder wins.

- [ ] **Step 1: Write the failing tests.**

```ts
describe("X-SW-2 score groups first, bounded floats, a whole-field search only when the groups cannot (RB3-1, P-Q1/P-Q2)", () => {
  it("X-SW-2 bye retried: the lowest eligible's removal leaves a rematch, so the next one up takes the bye (P-Q2; SW-L3)", () => {
    const r = pairRound(st(["p0", "p1", "p2"]), { played: new Set([pairKey("p0", "p1")]) });
    expect(r).toEqual({ ok: true, pairings: [{ home: "p0", away: "p2" }], bye: "p1", floated: [] }); // differential: today bye p2, pairings []
  });
  it("X-SW-2 every entrant already bye-ineligible on an odd field → no_bye_candidate, never a second bye (P-A4; NEW-2)", () => {
    expect(pairRound(st(["p0", "p1", "p2"]), { played: new Set(), byes: new Set(["p0", "p1", "p2"]) }))
      .toEqual({ ok: false, code: "SWISS_NO_LEGAL_PAIRING", reason: "no_bye_candidate", field: 3 }); // differential: today bye p2
  });
  it("X-SW-2 a blocked top-of-group entrant floats with the group's lowest-ranked: 2 floaters, not a dead end (SW-L4)", () => {
    // score 1: p0..p9 (ranks 1–10), p0 has met p1..p9; score 0: q0, q1 (ranks 11, 12)
    const top = Array.from({ length: 10 }, (_, i) => ({ entrantId: `p${i}`, score: 1, rank: i + 1 }));
    const low = [{ entrantId: "q0", score: 0, rank: 11 }, { entrantId: "q1", score: 0, rank: 12 }];
    const played = new Set(top.slice(1).map((t) => pairKey("p0", t.entrantId)));
    const r = pairRound([...top, ...low], { played });
    expect(r.ok && r.pairings).toHaveLength(6); // differential: today pairings []
    expect(r.ok && new Set(r.floated)).toEqual(new Set(["p0", "p9"])); // fewest floats (2), the second the group's lowest-ranked
  });
  it("X-SW-2 a group that must send down more floaters than the cap: the whole-field search still pairs it (P-A6)", () => {
    // score 1: p0..p7 have all met each other; score 0: q0..q7 have met nobody
    const ps = Array.from({ length: 8 }, (_, i) => `p${i}`), qs = Array.from({ length: 8 }, (_, i) => `q${i}`);
    const played = new Set(ps.flatMap((x, i) => ps.slice(i + 1).map((y) => pairKey(x, y))));
    const field = [...ps.map((id, i) => ({ entrantId: id, score: 1, rank: i + 1 })), ...qs.map((id, i) => ({ entrantId: id, score: 0, rank: 9 + i }))];
    const r = pairRound(field, { played });
    expect(r.ok && r.pairings.every((p) => ps.includes(p.home) !== ps.includes(p.away))).toBe(true); // each board p v q
    expect(r.ok && r.pairings).toHaveLength(8); // differential: today pairings []
  });
  it("X-SW-2 after a withdrawal (one entrant leaves the standings) the next round still seats everyone once", () => {
    const r = pairRound(st(["a", "b", "c", "d", "e"]).filter((s) => s.entrantId !== "c"), { played: new Set([pairKey("a", "b")]) });
    expect(r.ok && r.pairings.flatMap((p) => [p.home, p.away]).sort()).toEqual(["a", "b", "d", "e"]);
    expect(r.ok && r.pairings.some((p) => pairKey(p.home, p.away) === pairKey("a", "b"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`src/scheduling/swiss-w3.test.ts`).
- [ ] **Step 3: Implement.**
  - Bye: the candidate list is `ordered` reversed and filtered by eligibility. It is empty on an odd field → `no_bye_candidate`. For each candidate, run the group pass and then the fallback on the remainder; the first success wins. The node budget is shared across the whole call.
  - `floaterChoices` yields lazily (no `[...combinations]`) over the WHOLE group, ordered least-floated then bottom-first. Each yielded choice costs one node.
  - Fallback: when `pairFrom(0, [])` fails and the budget remains, run `matchWithin(pool)` over the whole pool (complete, fold-preferred). Floats are recorded as today (`a.score !== b.score`).
- [ ] **Step 4: Run, expect PASS:** `src/scheduling/swiss-w3.test.ts src/scheduling/swiss.test.ts src/scheduling/formats-ext.test.ts src/testkit/simulation.test.ts`, plus tsc and eslint.
- [ ] **Step 5: Mutate, one at a time.**
  - (a) Pick only the first eligible candidate → the SW-L3 test reds.
  - (b) Restore `else the absolute lowest` → the no_bye_candidate test reds.
  - (c) Restore the bottom window `Math.min(current.length, Math.max(fc + 3, 4))` → the SW-L4 floats test reds. The fallback then pairs p0-q0 … p5-q1, so `floated` is {p0, p5}.
  - (d) Delete the fallback → the 8×8 test reds.
- [ ] **Step 6: Write row X-SW-2:**
  - rule: "Swiss pairing quality is the product's simplified Dutch: pair within score groups by fold (or rank-adjacent where the stage says), float the fewest and lowest-ranked down, give the bye to the lowest eligible entrant whose removal leaves a pairable remainder, and search the whole field only when the score groups cannot pair it; FIDE's quality criteria C5–C21 are not implemented."
  - citation: "FIDE C.04.3 (Dutch) [C5]–[C21] not implemented; rulebook RB3-1"
  - status: `deviation 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/scheduling/swiss-w3.test.ts`
- [ ] **Step 7: Commit** `feat(swiss): bye retry, no second bye, whole-group floats, complete fallback (SW-L3, SW-L4, X-SW-2)`.

---

### Task 3: Every pairing property counts; a fully-paired invariant; existence and bye-minimality oracle (SW-L9; RB3-1, RB3-24; X-SW-1)

**Files:**
- Modify: `src/scheduling/swiss.test.ts` (rewrite `simulate`, `:150-242` properties; keep the 9×5 golden at `:83-109`)
- Modify: `rules/cross-sport.md` (append X-SW-1)

**Interfaces:**
- Consumes: Tasks 1–2. The test's own oracle is written in the test file from rulebook §2.3. It never calls engine internals.

- [ ] **Step 1: Write the tests.**
  - `simulate()` returns `{ rounds, refusals, colours, played, byes }` and stops at the first refusal.
  - Each property keeps module-level counters and asserts them after `fc.assert`.

```ts
it("X-SW-1 every paired round seats each active entrant exactly once: ⌊n/2⌋ boards, one bye iff n odd, no rematch, no second bye (n 2–64, counted)", () => {
  let rounds = 0, boards = 0, byes = 0;
  fc.assert(fc.property(fc.integer({ min: 2, max: 64 }), fc.integer({ min: 1, max: 6 }), fc.integer(), (n, r, seed) => {
    const sim = simulate(n, r, { seed });
    const seen = new Set<string>(), byed = new Set<string>();
    for (const round of sim.rounds) {
      rounds++; boards += round.pairings.length; if (round.bye) byes++;
      const seated = [...round.pairings.flatMap((p) => [p.home, p.away]), ...(round.bye ? [round.bye] : [])];
      expect(new Set(seated).size).toBe(n); expect(seated).toHaveLength(n);           // P-A3
      expect(round.pairings).toHaveLength(Math.floor(n / 2));
      expect(round.bye !== undefined).toBe(n % 2 === 1);
      for (const p of round.pairings) { const k = pairKey(p.home, p.away); expect(seen.has(k)).toBe(false); seen.add(k); } // P-A1
      if (round.bye) { expect(byed.has(round.bye)).toBe(false); byed.add(round.bye); }  // P-A4
    }
  }));
  expect(rounds).toBeGreaterThan(0); expect(boards).toBeGreaterThan(0); expect(byes).toBeGreaterThan(0);
});
```
  - `"X-SW-1 (P-A6) pairs whenever a legal pairing exists and refuses only when none does — odd and even, several score groups, chess on and off (brute force n ≤ 12, counted)"`:
    - Random n ∈ 2..12, random scores in {0,1,2}, a random `played` set, random `byes`. For chess, random colour sequences.
    - Oracle: edges are pairs not in `played` and, for chess, colour-compatible (one of the two assignments passes `|W−B| ≤ 2` and no three in a row).
    - For odd n, existence holds iff some eligible entrant's removal leaves a perfect matching.
    - Assert `r.ok === exists`. On `ok`, assert legality. On refusal, assert the reason is `no_bye_candidate` iff no eligible entrant, else `rematch` or `colour`.
    - Count `pairedCases > 0` and `refusedCases > 0`. Both outcomes must be exercised; tune the `played` density until each count is above 0.
  - `"X-SW-1 bye minimality: no eligible entrant with a strictly lower score leaves a pairable remainder (rulebook §2.3 item 4, n ≤ 12, counted)"` uses the same oracle and counts `byeCases > 0`.
  - Keep the chess colour-bounds property, counting checked sequences (`> 0`). Keep determinism (a second call is equal) and count its cases too.
  - Add `"X-SW-1 another sport's shape: rank_adjacent pairing keeps the same invariant (counted)"`, driving `{ pairing: "rank_adjacent" }` through the invariant for n 2–20.
- [ ] **Step 2: Run.** `src/scheduling/swiss.test.ts`. If a property reds, fast-check prints a shrunk counterexample. Commit it as a named regression case with its seed in `swiss-w3.test.ts` BEFORE fixing anything (R29). A red here is a Task 2 defect: report it, do not weaken the property.
- [ ] **Step 3: Mutate** against the properties:
  - (a) Return `{ ok: true, pairings: [] }` instead of the refusal → the existence property reds.
  - (b) Comment out the `byes` filter → the P-A4 assertion reds.
  - (c) Make `hardLegal` ignore `played` → P-A1 reds.
- [ ] **Step 4: Write row X-SW-1:**
  - rule: "In a Swiss stage two entrants meet at most once, an entrant takes the pairing-allocated bye at most once and never after winning by walkover, and every round seats each active entrant exactly once: ⌊n/2⌋ boards and a bye exactly when the field is odd."
  - citation: "FIDE C.04.1 r.2–4; C.04.3 [C1], [C2]; rulebook RB3-1, P-A1/P-A3/P-A4"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/scheduling/swiss.test.ts`<br>`packages/engine/src/scheduling/swiss-w3.test.ts` (add an `X-SW-1` title to the withdrawal case in Task 2's file)
- [ ] **Step 5: Run** `src/scheduling/swiss.test.ts src/scheduling/swiss-w3.test.ts test/rules-reference.test.ts`, then commit `test(swiss): counted pairing properties, fully-paired invariant, existence oracle (SW-L9, X-SW-1)`.

---

### Task 4: Non-chess soft home/away alternation (SW-L5; RB3-11; X-SW-4)

**Files:**
- Modify: `src/scheduling/swiss.ts:296-331` (`assignColours`; the non-chess branch at `:305`)
- Test: `src/scheduling/swiss-w3.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-4)

**Interfaces:**
- Consumes: `history.colours` for every sport (home = "W"). It is never hard: no pair is ever refused for home/away.

- [ ] **Step 1: Write the failing tests.** In each, both sides have score 0; p0 is rank 1 and p1 is rank 2.

```ts
it("X-SW-4 non-chess: home last round meets away last round → the sides swap (P-Q6)", () => {
  const r = pairRound(st(["p0", "p1"]), { played: new Set(), colours: new Map([["p0", ["W"]], ["p1", ["B"]]]) });
  expect(r.ok && r.pairings).toEqual([{ home: "p1", away: "p0" }]); // differential: today p0 home
});
it("X-SW-4 round 1 (no history): the upper board is home", () => {
  expect(pairRound(st(["p0", "p1"]), { played: new Set() })).toMatchObject({ ok: true, pairings: [{ home: "p0", away: "p1" }] });
});
it("X-SW-4 soft: three homes running is still paired outside chess (no hard limit)", () => {
  const r = pairRound(st(["p0", "p1"]), { played: new Set(), colours: new Map([["p0", ["W", "W", "W"]], ["p1", ["W", "W", "W"]]]) });
  expect(r.ok).toBe(true);
});
```
  - Add a `forEachSport`-independent note: pairing is sport-blind; the "another sport" axis here is `chess: true`, where the existing chess tests must stay green unchanged.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** For non-chess, use the same preference logic as chess: `preferredColour`, ties to the stronger imbalance, then the upper board. Skip every `canTake` check.
- [ ] **Step 4: Run, expect PASS** (`src/scheduling/swiss-w3.test.ts src/scheduling/swiss.test.ts`). **Mutate:** restore `if (!chess) return { home: a, away: b }` → the swap test reds.
- [ ] **Step 5: Write row X-SW-4:**
  - rule: "Outside chess, a Swiss board's home side alternates where it can: the side that was home more often (or last) plays away; the upper board is home when neither has a history; never a reason to refuse a pairing."
  - citation: "product rule, rulebook RB3-11 (no federation governs non-chess Swiss)"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/scheduling/swiss-w3.test.ts`

  Commit `feat(swiss): soft home/away alternation outside chess (SW-L5, X-SW-4)`.

---

### Task 4b: One-round look-ahead above the safe maximum (RB3-4 prevention; X-SW-10)

**Choice: `pairRound` prefers; there is no separate predicate.** The look-ahead runs inside the same search and costs one existence check per candidate pairing (rulebook §3.3). It reports its verdict on the result so the app can warn.

**Files:**
- Modify: `src/scheduling/swiss.ts` (`SwissConstraints.lookAhead`, `SwissRound.nextRound`, a leaf check in the pairing search)
- Test: `src/scheduling/swiss-w3.test.ts` (`describe("X-SW-10 …")`)
- Modify: `rules/cross-sport.md` (append X-SW-10)

**Interfaces:**
- Consumes: Tasks 1–2 (search, budget, bye retry).
- Produces:
  - `SwissConstraints.lookAhead?: boolean`;
  - `SwissRound.nextRound?: "pairable" | "unpairable" | "unknown"`, present iff `lookAhead` is set.
- Rule:
  - "Next round pairable" means the same field, with `played` plus this round's boards, and `byes` plus this round's bye. For chess, the colours include this round's assignment.
  - The test is existence only: for an odd field, some eligible entrant whose removal leaves a perfect matching under P-A1/P-A5.
  - With `lookAhead`, every complete candidate the search reaches (score-group pass, then fallback, in today's preference order) is accepted only if the next round is pairable.
  - If none is, return the FIRST legal candidate with `nextRound: "unpairable"`. It is a soft preference and never a refusal.
  - If the budget runs out first, return the first legal candidate with `"unknown"`.
  - Without `lookAhead`, nothing changes and `nextRound` is absent.

- [ ] **Step 1: Write the failing tests.** Example S6 was found by brute force over 6 entrants. Rounds 1–2 played a 6-cycle: R1 {p0-p1, p2-p3, p4-p5}, R2 {p0-p5, p1-p2, p3-p4}. All scores are 0.
  - For round 3, today's fold picks the three "diameters" p0-p3, p1-p4, p2-p5.
  - The unplayed remainder is then two triangles {p0,p2,p4} and {p1,p3,p5}, so round 4 has no perfect matching. That is the rulebook §3.1 audit case: 6 entrants and 5 rounds dead-end.
  - {p0-p2, p1-p4, p3-p5} keeps round 4 pairable.

```ts
const S6 = { played: new Set([["p0","p1"],["p2","p3"],["p4","p5"],["p0","p5"],["p1","p2"],["p3","p4"]].map(([a, b]) => pairKey(a, b))) };
it("X-SW-10 empty case first: without lookAhead the result carries no nextRound", () => {
  expect("nextRound" in (pairRound(st(["p0","p1","p2","p3","p4","p5"]), S6) as object)).toBe(false);
});
it("X-SW-10 above the safe maximum, round 3 of 6 entrants is paired so that round 4 still pairs (rulebook §3.3 prevention)", () => {
  const r = pairRound(st(["p0","p1","p2","p3","p4","p5"]), S6, { lookAhead: true });
  expect(r.ok && r.nextRound).toBe("pairable");
  const after = new Set([...S6.played, ...(r.ok ? r.pairings.map((p) => pairKey(p.home, p.away)) : [])]);
  expect(perfectMatchingExists(["p0","p1","p2","p3","p4","p5"], after)).toBe(true); // the test's own oracle; differential: today's choice leaves none
});
it("X-SW-10 when no pairing keeps the next round alive it still pairs, and says so: 4 entrants, round 3 → nextRound 'unpairable'", () => {
  // R1 {a-b, c-d}, R2 {a-c, b-d}: round 3 is forced {a-d, b-c}; a round 4 cannot exist (even hard maximum n−1 = 3)
  const r = pairRound(st(["a","b","c","d"]), { played: new Set([pairKey("a","b"), pairKey("c","d"), pairKey("a","c"), pairKey("b","d")]) }, { lookAhead: true });
  expect(r).toMatchObject({ ok: true, nextRound: "unpairable" });
});
it("X-SW-10 odd field: the next round's bye eligibility counts this round's bye (5 entrants, counted over seeds)", …);
it("X-SW-10 second call is identical; chess on reads this round's colours into the next-round check", …);
it("X-SW-10 an exhausted budget during the look-ahead returns the first legal pairing with nextRound 'unknown'", …);
```
  - Move `perfectMatchingExists` from `swiss.test.ts` into a small test helper both files import: `src/scheduling/swiss-oracle.test-helper.ts`.
  - Also extend Task 3's simulate-based invariant with `lookAhead: true` for n 6–12 over 5 rounds. Count `rounds > 0`, and count `nextRound === "pairable"` cases > 0.
- [ ] **Step 2: Run, expect FAIL** (`src/scheduling/swiss-w3.test.ts`). **Step 3: Implement** as specified.
- [ ] **Step 4: Run, expect PASS:** `src/scheduling/swiss-w3.test.ts src/scheduling/swiss.test.ts src/testkit/simulation.test.ts`, plus tsc and eslint.
- [ ] **Step 5: Mutate** one at a time:
  - (a) Delete the leaf check → the S6 test reds (the diameters come back).
  - (b) Hard-code `nextRound: "pairable"` → the 4-entrant test reds.
  - (c) Drop this round's bye from the next-round eligibility → the odd-field test reds.
- [ ] **Step 6: Write row X-SW-10:**
  - rule: "When a Swiss stage plays more rounds than the safe maximum ⌊n/2⌋, each round but the last is paired, where a choice exists, so that the next round can still be paired legally; when no choice can, the round is still paired and the organiser is told the next one may not pair."
  - citation: "product rule, rulebook §3.3 and RB3-4 (not a FIDE criterion)"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts` (the app's warning is added at close-out)
  - proved by: `packages/engine/src/scheduling/swiss-w3.test.ts`
- [ ] **Step 7: Commit** `feat(swiss): one-round look-ahead above the safe maximum (RB3-4, X-SW-10)`.

---

### Task 4c: Topscorer colour exception in the final round (RB3-10; FIDE C.04.3 A.6 and [C3]; X-SW-11)

**Files:**
- Modify: `src/scheduling/swiss.ts:82-88` (`canTake`), `:181-186` (`colourLegal`), `:299-331` (`assignColours`)
- Test: `src/scheduling/swiss-w3.test.ts` (`describe("X-SW-11 …")`)
- Modify: `rules/cross-sport.md` (append X-SW-11)

**Interfaces:**
- Consumes: `SwissConstraints.finalRoundMaxScore?: number`. The app sets it only when pairing the stage's last round, as (rounds − 1) × the win in its pairing score units.
- Rule (A3):
  - A topscorer is an entrant whose score is **over** 50% of `finalRoundMaxScore` (A.6).
  - The hard colour limits (|W−B| ≤ 2, never three in a row; [C3] "non-topscorers with the same absolute colour preference shall not meet") bind only a board where BOTH sides are non-topscorers. A board with a topscorer is colour-legal whatever the history.
  - Assignment on an exempt board: if exactly one assignment keeps the non-topscorer within its limits, use it. Otherwise use today's preference order (`preferredColour`, the larger imbalance, the upper board).
  - When `finalRoundMaxScore` is absent, nothing changes. A value that is not finite or is ≤ 0 throws `CONFIG_INVALID`.

- [ ] **Step 1: Write the failing tests** (chess on; a and b each played White twice running, so both have an absolute preference for Black):

```ts
const ww = new Map([["a", ["W","W"] as Colour[]], ["b", ["W","W"] as Colour[]]]);
const at = (sa: number, sb: number) => [{ entrantId: "a", score: sa, rank: 1 }, { entrantId: "b", score: sb, rank: 2 }];
it("X-SW-11 empty case first: no finalRoundMaxScore → the colour limits bind as before (refused 'colour')", () => {
  expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true })).toMatchObject({ ok: false, reason: "colour" });
});
it("X-SW-11 two topscorers (3 > ½·4) may meet in the final round despite the same absolute preference (C.04.3 [C3])", () => {
  expect(pairRound(at(3, 3), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 })).toMatchObject({ ok: true }); // differential: today refused
});
it("X-SW-11 two non-topscorers (1, 1) stay refused in the final round", () => {
  expect(pairRound(at(1, 1), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 })).toMatchObject({ ok: false, reason: "colour" });
});
it("X-SW-11 exactly half is not a topscorer (A.6 'over 50%'): 2 and 2 of 4 are refused", …);
it("X-SW-11 a topscorer v a non-topscorer: the non-topscorer keeps its limit (b, score 1, gets Black; a takes a third White)", () => {
  const r = pairRound(at(3, 1), { played: new Set(), colours: ww }, { chess: true, finalRoundMaxScore: 4 });
  expect(r.ok && r.pairings).toEqual([{ home: "a", away: "b" }]);
});
it("X-SW-11 non-chess is unaffected (no hard colour limit to relax); a second call is identical", …);
it("X-SW-11 a non-finite or non-positive finalRoundMaxScore is CONFIG_INVALID", …);
```
  - Extend Task 3's chess existence oracle with a final-round variant: random `finalRoundMaxScore`, and colour-compatibility exempting any pair that has a topscorer. Count its cases > 0.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS:** `src/scheduling/swiss-w3.test.ts src/scheduling/swiss.test.ts`, plus tsc and eslint.
- [ ] **Step 5: Mutate** one at a time:
  - (a) Remove the exemption → the two-topscorers test reds.
  - (b) Exempt every final-round board → the non-topscorers test reds.
  - (c) `>` → `>=` → the exactly-half test reds.
  - (d) Drop the "keep the non-topscorer's limit" assignment → the mixed test reds.
- [ ] **Step 6: Write row X-SW-11:**
  - rule: "With chess colours on, in the final round of a Swiss stage a board with a topscorer (over half the maximum possible score before that round) is exempt from the colour limits; two non-topscorers with the same absolute colour preference still never meet, and on an exempt board the non-topscorer keeps its limit where it can."
  - citation: "FIDE C.04.3 (1 Feb 2026) A.6, [C3]; rulebook RB3-10"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/scheduling/swiss-w3.test.ts`
- [ ] **Step 7: Commit** `feat(swiss): topscorer colour exception in the final round (RB3-10, X-SW-11)`.

---

### Task 5: A bye pays win points: the clean sweep under a set-score rule, never the forfeit row, no bonus (SW-M6 remainder; ruling 251; X-SW-5)

**Files:**
- Modify: `src/competition/points.ts:374-376` (`forfeitRow = forfeit || bye` → `forfeit`), `:206-213` (`bonusesFor`: a bye earns no bonus), the doc comments at `:163-172` and `:333-336`
- Modify: `src/competition/points-w2c.test.ts:131-140` ("a bye keeps the forfeit row's points"; it asserts the behaviour ruling 251 reverses: re-point it to the new rule, keeping the "never the awarded score" half)
- Create: `src/competition/points-w3-bye.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-5)

**Interfaces:**
- Consumes: `payout(outcome, decidedIn, pair, played, rule, scoreKeys, setsToWin)` (`points.ts:358`) and `setsToWinOf`.
- Produces: no signature change.

- [ ] **Step 1: Write the failing tests.**
  - Helper `byePair(module, cfg)` builds the bye pair exactly as the app's producer does (`apps/web/src/server/engine-db/competition.ts:103-134` `awardByeDelta`): `module.init(cfg, {home: winner, away: phantom})`, then `module.standingsDelta({kind:"award", winner, loser:null, reason:"bye"}, cfg, ctx, state)`.
  - Expected for a bye: `rule.bySetScore ? (rule.bySetScore[`${setsToWin}-0`] ?? rule.bySetScore["*"])[0] : rule.win.regulation`, read from the sport's DECLARED `module.tablePointsRule(cfg, "swiss")`.

```ts
it("X-SW-5 empty case first: a rule with no forfeit row and no bonus pays the bye exactly the win (generic, declared)", …);
it("X-SW-5 every sport: a bye pays the declared win points (clean sweep under a set-score map) and credits no for/against (counted)", () => {
  const n = forEachSport(({ module }) => { /* expect(paid.points).toBe(expected); expect(metrics.for/against/diff absent or 0) */ });
  expect(n).toBeGreaterThan(0);
});
it("X-SW-5 a custom rule's forfeit row {winnerPoints: 5} does not pay a bye: the win (3) does", () => {
  // rule: win 3 / loss 0 / forfeit {winnerPoints: 5, loserPoints: 0} — ruling 251
  expect(paidBye.points).toBe(3); // differential: today 5
});
it("X-SW-5 a bye earns no bonus: forfeit_win +1 and win_margin_gte(0) +1 leave it at the win", () => {
  expect(paidBye.points).toBe(3); // differential: today 6 (5 + forfeit_win 1)
});
it("X-SW-5 a set-score map {2-0: [3,0], 2-1: [2,1]} pays a best-of-3 bye the 2-0 pair's 3, forfeit row or not", …);
it("X-SW-5 a walkover still pays the forfeit row (X-PT-1 unchanged)", …);   // guards the other side of the split
it("X-SW-5 second call: paying the same bye twice gives the same delta", …);
```
- [ ] **Step 2: Run, expect FAIL:** `src/competition/points-w3-bye.test.ts src/competition/points-w2c.test.ts`.
- [ ] **Step 3: Implement.**
  - `forfeitRow` stops including `bye`. The bye takes the `award` branch: `won === 1` → `rule.win.regulation`, or `setPair()[0]` under `bySetScore` (`setScoreOf` already yields `${setsToWin}-0` for a bye, whose sets_lost is 0).
  - `bonusesFor` returns 0 for a bye, as it does for a double walkover. Pass `isBye(outcome)` in.
  - Update `isUnplayedForfeit`'s doc comment ("it keeps the forfeit row's points" → "it pays the win, X-SW-5").
- [ ] **Step 4: Run, expect PASS:** the two files plus `src/competition/points.test.ts src/competition/points-w2d.test.ts src/competition/points-w2d.property.test.ts src/competition/table-points-parity.test.ts src/competition/w2b-tables.test.ts`. Find other bye assertions with `grep -an "bye" src/competition/*.test.ts` and add those files to the run.
- [ ] **Step 5: Mutate** one at a time:
  - (a) Restore `|| bye` → the forfeit-row test reds.
  - (b) Remove the bye bonus exit → the bonus test reds.
- [ ] **Step 6: Write row X-SW-5:**
  - rule: "A pairing-allocated bye pays the stage's win points, in every sport: under a points rule keyed by set score, the clean-sweep score's points; never the rule's forfeit row and never a bonus; and it records no set, game, point, goal or run for or against."
  - citation: "FIDE C.04.1 r.3; ruling 251 (amends the bye half of X-PT-1's payout; X-WO-1's 'a bye keeps the clean-sweep pair')"
  - status: `signed 251 2026-10-31`
  - enforced at: `packages/engine/src/competition/points.ts`
  - proved by: `packages/engine/src/competition/points-w3-bye.test.ts`
- [ ] **Step 7: Commit** `fix(points): a bye pays win points, never the forfeit row or a bonus (SW-M6, X-SW-5)`.

---

### Task 6: `byeScore` removed; a stored key is ignored; boardgame FOLD_EPOCH 4 → 5 (SW-M8 / SC-O7; ruling 251; X-SW-6)

**Files:**
- Modify: `src/sports/boardgame/boardgame.ts:71-74` (delete the field and its comment), `:917` (delete `byeScore: { scope: "points" }`), `:1066-1069` (comment), `:7` (header comment)
- Modify: `src/scheduling/swiss.ts:35` (delete `byeScore` from `SwissConstraints`), `:48` (comment); `src/scheduling/swiss.test.ts:60` (drop `byeScore: 1`)
- Modify: `src/competition/tiebreakers.ts:40` (comment)
- Modify: `src/sport/rule-keys.test.ts:156` (`boardgame: { points: ["scoring"] }`), `src/sports/boardgame/boardgame.test.ts:617-622`
- Modify: `src/sports/boardgame/DOMAIN.md:56` (the row says removed: a bye is win points, X-SW-5)
- Modify: `src/sport/fold-epoch.ts` (`boardgame: 5`, plus a comment line in the house style naming W3, X-SW-6, 181 states and the precedent)
- Regenerate: `src/sports/boardgame/boardgame.schema.json` (`pnpm schema:snapshot`)
- Convert and re-baseline: `src/sports/boardgame/boardgame.golden.json` (its own commit)
- Create: `src/sports/boardgame/w3-bye-score.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-6)

**Interfaces:**
- Produces: `BoardgameCfg` without `byeScore` and `SwissConstraints` without `byeScore`. App consumers (`apps/web/src/server/usecases/rule-locks.ts:39`, `api-v1/schemas.ts`) are the app plan's work.

- [ ] **Step 1: Write the failing tests** in `w3-bye-score.test.ts`:

```ts
it("X-SW-6 a stored byeScore is ignored, not rejected: parse strips it and the rest of the cfg stands", () => {
  const parsed = boardgame.configSchema.parse({ byeScore: 1, variant: "rapid" });
  expect("byeScore" in parsed).toBe(false); expect(parsed.variant).toBe("rapid");
});
it("X-SW-6 the bye is not a setting: no ruleKeys entry, no config path", () => {
  expect(Object.keys(boardgame.ruleKeys ?? {})).not.toContain("byeScore");
});
it("X-SW-6 a boardgame bye still pays the win (2 half-points) under the declared Swiss rule", …); // ties to X-SW-5 via payout
it("X-SW-6 empty cfg parses with no byeScore (the default is gone, not just the input)", …);
```
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement the source edits** listed above, including `fold-epoch.ts` boardgame → 5. Run `pnpm schema:snapshot` and confirm that `git diff src/sports/boardgame/boardgame.schema.json` removes only the `byeScore` block. Commit code, tests, schema and epoch: `feat(boardgame): remove the inert byeScore; a bye is win points (SW-M8, X-SW-6)`. The golden test is expected red here; the next step fixes it.
- [ ] **Step 4: Convert the corpus in its own commit** (GOLDEN-POLICY "Isolated in its own commit"):
  - Run `cd "$WT" && grep -o '\\"byeScore\\":2,' src/sports/boardgame/boardgame.golden.json | wc -l` and expect **181**.
  - Delete exactly that text: `perl -0pi -e 's/\\"byeScore\\":2,//g' src/sports/boardgame/boardgame.golden.json`. Re-count: expect 0, and `grep -c byeScore` is 0.
  - With ONLY that file dirty, run `cd "$WT" && REBASELINE_GOLDEN=1 rtk proxy npx vitest run src/testkit/golden.test.ts; echo "EXIT=$?"`.
  - Then `git status --porcelain` must list only `boardgame.golden.json`.
  - Review the bytes, not the printout (GOLDEN-POLICY: `rtk` swallows the state diff). Diff against `git show HEAD:src/sports/boardgame/boardgame.golden.json`. Confirm that events, lineups and fold options are byte-identical, and that only the `byeScore` text moved in states and configs.
  - Commit `test(golden): boardgame states lose byeScore (re-baseline, X-SW-6)`.
- [ ] **Step 5: Verify:**
  - `src/sports/boardgame/w3-bye-score.test.ts src/sports/boardgame/boardgame.test.ts src/sport/rule-keys.test.ts src/sport/fold-epoch.test.ts src/testkit/golden.test.ts src/testkit/schema-snapshot.test.ts src/testkit/golden-policy.test.ts`
  - `cd "$WT" && pnpm fold-epoch:check --against origin/main; echo "EXIT=$?"` must name boardgame only and pass with 5.
  - `git status --porcelain -- '*.golden.json'` must be empty after the run.
- [ ] **Step 6: Mutate.** Re-add `byeScore: z.number().int().nonnegative().default(2)` → the empty-cfg test reds (and so do the golden replay and the fold guard). Restore.
- [ ] **Step 7: Write row X-SW-6** in the first commit of Step 3 (amend before the corpus commit, or as a follow-up commit in this task):
  - rule: "The bye's value is not a setting: a pairing-allocated bye is always the win (X-SW-5), boardgame has no byeScore, and a stored byeScore is ignored on read, not rejected."
  - citation: "ruling 251; W3 design §5 (supersedes RB3-7(b))"
  - status: `signed 251 2026-10-31`
  - enforced at: `packages/engine/src/sports/boardgame/boardgame.ts`<br>`packages/engine/src/scheduling/swiss.ts`
  - proved by: `packages/engine/src/sports/boardgame/w3-bye-score.test.ts`

---

### Task 7: The Swiss ledger by round; own unplayed rounds against a capped dummy; absences; display in table points (SW-M1, SW-L2, late entry; RB3-6 part 1; X-SW-8)

**Files:**
- Modify: `src/competition/tiebreakers.ts:33-81` (`SwissGame`, `SwissRow`, `virtualOpponentScore` deleted, `opponentScore`), `:89-128` (`buchholz`, `sonnebornBerger`), `:1033-1050` (display: ÷2/÷4 only for `unit: "half"`), `:1061-1113` (`buildSwissTable` → `buildSwissLedger`)
- Modify: `src/competition/stage.ts:66-108` (`TableStage.swissAbsentRounds`), `:274-298` (build the ledger from counted fixtures with `roundNo`; pass `pointsUnit`)
- Modify: `src/competition/points.ts` (`swissDrawPoints`)
- Modify the call sites and frozen expectations:
  - `src/competition/tiebreakers.test.ts:111-135`: the "FIDE virtual opponent" block freezes the superseded A6 formula; replace it with art. 16 values and retitle it.
  - `src/competition/tiebreakers-md1.test.ts` (its relational "the model DIFFERS from C.07, W3" block becomes absolute values), `tiebreakers.gaps.test.ts:64-90`, `tiebreak-keys-w2d.test.ts:873`, `cascade.test.ts:221`, `partial-schedule.test.ts:539`.
- Create: `src/competition/swiss-unplayed.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-8)

**Interfaces:**
- Consumes: `TableStage.rounds`, `TableFixture.roundNo`, `TableFixture.awardDelta`, `stage.rules.points`.
- Produces (Task 8 extends them):

```ts
export type UnplayedRound = "bye" | "forfeit_win" | "absent" | "forfeit_loss" | "absent_last"; // C.07 16.2.1 … 16.2.5
export interface SwissGame { round: number; opponent: EntrantId | null; result: GameResult; scored: number;
  color?: Color | null; unplayed?: UnplayedRound; cap?: number /* 16.4 cap, required when unplayed is set */ }
export interface SwissRow { entrant: EntrantId; score: number; adjusted?: number /* 16.3; absent = score */; games: SwissGame[] }
export interface SwissLedgerFixture { readonly round: number; readonly result?: FixtureResult; readonly award?: StandingsDelta;
  readonly unplayed?: "home" | "away" | "both" /* Task 8 */ }
export function buildSwissLedger(entrants: readonly EntrantId[], fixtures: readonly SwissLedgerFixture[],
  opts: { readonly rounds: number | undefined; readonly drawPoints: number; readonly absent?: ReadonlyMap<EntrantId, readonly number[]> }): SwissTable;
// RankContext gains `pointsUnit?: "whole" | "half"` — REQUIRED when `swiss` is set (CONFIG_INVALID otherwise)
```

**The rule this task implements, from rulebook §4 / A4 art. 16** (scaled to table points; D = `swissDrawPoints(rule)` = `rule.draw ?? rule.win.regulation / 2`; R = `stage.rounds`):
- Cards are in round order. An absent round is a zero-point card: `result: "loss"`, `scored: 0`, `opponent: null`.
- An absent round followed by at least one card that is neither absent nor a forfeit loss is `absent` (16.2.3). Otherwise it is `absent_last` (16.2.5).
- `adjusted = score + D × (number of absent_last cards)` (16.3.2).
- Own unplayed card (`bye`, `absent`, `absent_last`): dummy = `min(score, D × R)` (16.4.2).
- Played card: the opponent's `adjusted`.
- SB = Σ weight(result) × contribution, with weight win 2 / draw 1 / loss 0 (unchanged scale).
- A round with no card and no declared absence is not on the card at all. A pending board adds nothing.
- Guards (all `CONFIG_INVALID`):
  - a counted Swiss fixture without `roundNo`;
  - an unplayed card with `rounds` absent;
  - an absent round outside `1..R`;
  - an absent round the entrant holds a card in;
  - an absent-map key that is not a table entrant.
- Two cards in one round are allowed (Review Focus 2).

- [ ] **Step 1: Write the failing tests** in `swiss-unplayed.test.ts`. Drive everything through `completeTableStage` (the real consumer) with hand-built `TableFixture`s. Each expected number is hand-derived below from the rulebook. Do not compute it with the engine.

Scenario **S1** (boardgame half-points, win 2 / draw 1, R = 3, D = 1, cap 3):
  - R1: A beats B, C draws D, E bye.
  - R2: A beats E, B beats D, C bye.
  - R3: A draws D, C beats E, B bye.
  - Scores: A 5, B 4, C 5, D 2, E 2.

```ts
it("X-SW-8 empty case first: a Swiss stage with no counted fixture has empty cards and no dummy (X-TB-6)", …);
it("X-SW-7 own bye = dummy at own score capped at draw×rounds: E (bye in round 1) Buchholz 2+5+5 = 12 half-points (16.4.2)", () => {
  expect(bh("E")).toBe(12 / 2); // display points; differential: today 11/2 (A6 virtual opponent, award appended after results)
});
it("X-SW-7 the cap binds: C (score 5) gets min(5, 3) = 3 for its round-2 bye → 2+3+2 = 7", () => {
  expect(bh("C")).toBe(7 / 2); // differential: today 8/2
});
```
Scenario **S4** (late entry; boardgame, R = 3, cap 3):
  - R1: A beats B, C bye. L is declared `absent: [1]`.
  - R2: A beats C, L beats B.
  - R3: L beats A, B draws C.
  - Scores: A 4, B 1, C 3, L 4.

```ts
it("X-SW-8 a late entrant's missed round scores 0 and records no score: L has points 4, played 2, no round-1 row", …);
it("X-SW-8 a missed round followed by play is 16.2.3: L's own dummy min(4, 3) = 3 → Buchholz 3+1+4 = 8", …);
it("X-SW-8 …and opponents read L at its real 4, not as a draw: B's Buchholz 4+4+3 = 11 (16.3.1; 12 if misread as 16.2.5)", …);
```
Scenario **S5** (scaling, no draw; whole points, stage rule `{win: 3, loss: 0, no draw}` → D = 1.5, R = 3, cap 4.5):
  - Field X, Y, Z.
  - R1: X beats Y, Z bye. R2: X beats Z, Y bye. R3: Y beats Z, X bye.
  - Scores: X 9, Y 6, Z 3.

```ts
it("X-SW-7 non-chess scale: X's dummy is min(9, 1.5×3) = 4.5 → Buchholz 6+3+4.5 = 13.5, displayed unhalved (SW-L2)", () => {
  expect(bh("X")).toBe(13.5); // differential: today (6+3+7)/2 = 8
});
it("X-SW-7 every sport: a bye dummy is min(own, D×R) with D from the declared rule (draw, else ½ win) (counted)", …); // forEachSport
it("X-SW-8 mid-round: a pending round-3 board adds no card and no dummy (Review Focus 1)", …);
it("X-SW-8 two cards in one round (a stored ad-hoc match) rank without throwing (Review Focus 2)", …);
it("X-SW-8 guards: missing roundNo / rounds / absent round out of range / absent where a card exists / unknown entrant → CONFIG_INVALID", …);
it("X-SW-8 second call: ranking the same stage twice gives identical rows", …);
```
- [ ] **Step 2: Run, expect FAIL:** `src/competition/swiss-unplayed.test.ts`.
- [ ] **Step 3: Implement.**
  - `buildSwissLedger` works in two passes: cards and categories, then caps (Task 8 needs the opponents' adjusted scores).
  - `buchholz` and `sonnebornBerger` read `game.cap` for unplayed cards and `opp.adjusted ?? opp.score` for played ones.
  - Delete `virtualOpponentScore` and its A6 comment.
  - `stage.ts` maps counted fixtures (`COUNTS_FOR_STANDINGS`) to `SwissLedgerFixture` and passes `swissAbsentRounds`, `rounds`, `swissDrawPoints(stage.rules.points)` and `pointsUnit: stage.rules.points.unit`.
  - Update the header comment (lines 1–16) to cite C.07 2026 art. 16.
- [ ] **Step 4: Re-derive the frozen tests.** Rewrite `tiebreakers.test.ts:111-135` with art. 16 values, computed by hand in a comment from rulebook §4. Retitle its describe to `"C.07 2026 art. 16 …"`. Do the same for the md1 block. Never copy the new engine output into a test.
- [ ] **Step 5: Run, expect PASS:** `src/competition/swiss-unplayed.test.ts src/competition/tiebreakers.test.ts src/competition/tiebreakers-md1.test.ts src/competition/tiebreakers.gaps.test.ts src/competition/tiebreak-keys-w2d.test.ts src/competition/cascade.test.ts src/competition/partial-schedule.test.ts src/competition/stage.test.ts src/competition/tiebreak-properties.test.ts src/sports/boardgame/tiebreak.test.ts src/testkit/simulation.test.ts`, plus tsc and eslint.
- [ ] **Step 6: Mutate** one at a time:
  - (a) Cap → `score` (no min) → the C test reds.
  - (b) Dummy → 0 → the E test reds.
  - (c) Swap the 16.2.3/16.2.5 rule → the B=11 test reds.
  - (d) Display ÷2 for every unit → the S5 test reds.
  - (e) Drop each guard in turn → its guard case reds.
- [ ] **Step 7: Write row X-SW-8:**
  - rule: "A late entrant scores 0 for each Swiss round it missed and records no score for it; in tie-breaks each missed round is a zero-point unplayed round (FIDE C.07 16.2.3 when play follows it), scored against a dummy at the entrant's own score capped at draw points × rounds, and read by its opponents at its actual result."
  - citation: "FIDE C.04.2 2.4; C.07 (2026) art. 16.2.3, 16.3, 16.4.2; ruling 251"
  - status: `signed 251 2026-10-31`
  - enforced at: `packages/engine/src/competition/tiebreakers.ts`<br>`packages/engine/src/competition/stage.ts` (the app's `swissGen` path is added at close-out)
  - proved by: `packages/engine/src/competition/swiss-unplayed.test.ts`
- [ ] **Step 8: Commit** `feat(tiebreaks): Swiss ledger by round, art. 16 dummy and cap, absences, table-point display (SW-M1, SW-L2, X-SW-8)`.

---

### Task 8: Forfeits and double walkovers are unplayed; withdrawals adjust opponents' scores; Cut-1 cuts a VUR first (SW-L1; RB3-6 part 2; X-SW-7)

**Files:**
- Modify: `src/competition/stage.ts:36-43` (`TableFixture.unplayed`) and the ledger mapping
- Modify: `src/competition/tiebreakers.ts` (`forfeit_win`/`forfeit_loss` cards with the scheduled opponent; caps from 16.4.1; the Cut-1 rule from 16.5)
- Modify: `src/competition/points.ts` (`unplayedSidesOf`, next to `isUnplayedForfeit` at `:173`)
- Test: `src/competition/swiss-unplayed.test.ts`
- Modify: `rules/cross-sport.md` (append X-SW-7)

**Interfaces:**
- Produces: `TableFixture.unplayed` and `unplayedSidesOf(outcome, played, pair)`. The latter returns `"both"` for `double_walkover`, the losing side's seat when `isUnplayedForfeit(outcome, played)`, and `undefined` otherwise (a bye included).
- Rule (A4 16.3, 16.4.1, 16.5):
  - The forfeit's winner gets a `forfeit_win` card and the loser a `forfeit_loss` card. Each carries `opponent` = the scheduled opponent and `cap` = that opponent's `adjusted`.
  - Contribution = `min(own score, cap)`.
  - Unplayed cards are "not met" for `direct` (existing `game.unplayed` skip; rulebook P-A2).
  - VURs are `forfeit_loss`, `absent` and `absent_last`. Buchholz Cut-1 on an entrant with any VUR cuts its lowest VUR contribution; otherwise it cuts the lowest contribution. `cut: k` repeats that k times (16.5.2).
  - Opponents of a withdrawn entrant read `adjusted` (Task 7's `absent_last` × D).

- [ ] **Step 1: Write the failing tests.**

Scenario **S2** (forfeit; boardgame, R = 2, D = 1):
  - R1: A v B where B forfeited with nothing played (`unplayed: "away"`); C beats D.
  - R2: A beats C, B beats D.
  - Scores: A 4, B 2, C 2, D 0.

```ts
it("X-SW-7 empty case first: unplayedSidesOf is undefined for a played win and for a bye", …);
it("X-SW-7 a forfeit loss is scored against a dummy capped at the scheduled opponent's adjusted score: B = min(2, 4) + 0 = 2 (16.4.1)", () => {
  expect(bh("B")).toBe(2 / 2); // differential: today (4+0)/2 — the forfeit read as a played game v A (SW-L1)
});
it("X-SW-7 Cut-1 cuts the lowest VUR first: B's Buchholz Cut-1 = 0, not 2 (16.5.1)", () => {
  expect(cut1("B")).toBe(0); // differential: today 2/2 (lowest overall)
});
it("X-SW-7 a forfeit is not a meeting: direct encounter A v B is level (P-A2)", …); // differential: today A ahead
it("X-SW-7 a double walkover gives both sides a forfeit_loss card (rulebook §4 M2)", …);
```
Scenario **S3** (withdrawal; boardgame, R = 3, D = 1):
  - R1: A beats B, C beats D. B withdraws: `absent: [2, 3]`.
  - R2: A beats C, D bye.
  - R3: A draws D, C bye.
  - Scores: A 5, B 0, C 4, D 3. B is `absent_last` ×2, so its adjusted score is 0 + 2 = 2.

```ts
it("X-SW-7 a withdrawn entrant stays in its opponents' Buchholz at its adjusted score: A = 2+4+3 = 9 (16.3.2)", () => {
  expect(bh("A")).toBe(9 / 2); // differential: today 7/2
});
it("X-SW-7 after a withdrawal its post-withdrawal rounds are VURs on its own card: B's Cut-1 cuts a 0, Buchholz 5", …);
it("X-SW-7 after a void: a voided round-2 board is not on either card and adds no dummy", …);
it("X-SW-7 another sport: S2's shape on football's declared rule (D = draw points) gives the same categories (single-sport: football is the sweep's goals representative; the forEachSport sweep is Task 7's)", …);
```
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS**, with the same path list as Task 7 plus `src/competition/points-w2c.test.ts src/competition/w2b-tables.test.ts`.
- [ ] **Step 5: Mutate** one at a time:
  - (a) Ignore `unplayed` in the mapping → the B=2 test reds.
  - (b) Cut the lowest overall → the Cut-1 test reds.
  - (c) Read `opp.score` instead of `adjusted` → the A=9 test reds.
- [ ] **Step 6: Write row X-SW-7:**
  - rule: "Swiss tie-breaks treat unplayed rounds by FIDE C.07 (2026) art. 16, scaled to the stage's table points: a bye, a forfeit win or loss, a double walkover and a missed or post-withdrawal round are unplayed; the entrant's own unplayed round scores against a dummy at its own score, capped at its scheduled opponent's adjusted score for a forfeit and at draw points (half the win where the sport has no draw) × the stage's rounds otherwise; its opponents read it at its awarded result, except post-withdrawal rounds, which count as draws; a forfeit is not a meeting; Buchholz Cut-1 cuts the lowest voluntarily unplayed round first."
  - citation: "FIDE C.07 (1 March 2026) art. 16.1–16.5; rulebook §4, RB3-6"
  - status: `signed 252 2026-10-31`
  - enforced at: `packages/engine/src/competition/tiebreakers.ts`<br>`packages/engine/src/competition/stage.ts`<br>`packages/engine/src/competition/points.ts`
  - proved by: `packages/engine/src/competition/swiss-unplayed.test.ts`
- [ ] **Step 7: Commit** `feat(tiebreaks): forfeits unplayed, withdrawal-adjusted opponents, VUR-first Cut-1 (SW-L1, X-SW-7)`.

---

### Task 9: `opp_diff`, opponents' collective goal difference (rulebook §5 T10; needed by the goals chain)

**Files:**
- Modify: `src/sport/module.ts:50-80` (`TiebreakerKey` gains `"opp_diff"`, in union order after `"field_goals"`)
- Modify: `src/competition/cascade-rules.ts:61-93` (`opp_diff: { swissOnly: true, ledger: [DIFF_KEYS] }`)
- Modify: `src/competition/tiebreakers.ts` (comparator; the display metric `opp_diff` beside buchholz at `:1038-1050`); any other exhaustive `Record<TiebreakerKey, …>` tsc names
- Create: `src/competition/opp-diff.test.ts`

**Interfaces:**
- Produces `"opp_diff"`.
  - Value: Σ over the entrant's PLAYED cards (not `unplayed`) of that opponent's final `diff`, read through `DIFF_KEYS` aliases.
  - Ranked higher first. Swiss only. Unplayed cards contribute nothing: UEFA has no unplayed concept, and art. 16 dummies have no goal difference.
  - The app owes a label in 4 locales; its exhaustive maps will fail tsc until then.

- [ ] **Step 1: Write the failing tests.**
  - `"opp_diff empty case first: an entrant with no played card has 0"`.
  - `"opp_diff = Σ played opponents' final GD, forfeits excluded"`, with a hand-built 4-team football stage. Hand-compute the GDs in a comment and include one forfeit card.
  - `"opp_diff outside swiss → stage_format refusal; on a sport with no diff ledger → sport refusal (validateCascade)"`.
  - `"opp_diff every goals sport accepts it on swiss (football, hockey, icehockey; counted)"`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS:** `src/competition/opp-diff.test.ts src/competition/cascade-rules.test.ts src/competition/tiebreak-keys-w2d.test.ts`, plus tsc. **Mutate:** sum unplayed cards too → the forfeit-excluded test reds.
- [ ] **Step 5: Commit** `feat(tiebreaks): opp_diff, opponents' collective goal difference (Swiss only)`. Its rule row is the goals chain's (Task 10). A key on its own is no rule.

---

### Task 10: Swiss default tie-break chains for all 11 sports (SW-H4; RB3-8; X-SW-9 + 11 sport rows)

**Files** (the chains are copied verbatim from rulebook §5; `direct` = direct encounter):

| Sport(s) | File:line | New `swiss` chain |
|---|---|---|
| badminton, tabletennis, volleyball | `src/sports/setbased/badminton.ts:73`, `tabletennis.ts:75`, `volleyball.ts:159` | `points, buchholz_cut1, buchholz, set_ratio, point_ratio, direct, lots` |
| tennis | `src/sports/tennis/tennis.ts:76` | `points, buchholz_cut1, buchholz, set_ratio, game_ratio, direct, lots` |
| football | `src/sports/football/football.ts:2997` (add a `kind === "swiss"` branch) | `points, diff, for, wins, buchholz, opp_diff, direct, lots` |
| hockey, icehockey | `src/sports/hockey/hockey.ts:239`, `src/sports/icehockey/icehockey.ts:267` | same as football |
| cricket | `src/sports/cricket/cricket.ts:4224-4225` | `points, wins, nrr, buchholz_cut1, buchholz, direct, lots` |
| carrom | `src/sports/carrom/carrom.ts:1133` (add a kind branch) | `points, buchholz_cut1, buchholz, set_ratio, board_ratio, point_ratio, direct, lots` |
| generic | `src/sports/generic/generic.ts:790` (add a kind branch) | `points, buchholz_cut1, buchholz, diff, for, direct, lots` |
| boardgame | `src/sports/boardgame/boardgame.ts:575-583`: **unchanged** (already §5's chess chain) | `points, buchholz_cut1, buchholz, sberger, direct, wins, lots` |

- Modify: `src/competition/defaults-sweep.test.ts:44-57`. The `SWISS` table's OC1 comment ("unchanged") is replaced by rulebook §5 and ruling 252, with the table above typed from the RULEBOOK, never read from `defaultTiebreakers`.
- Modify: `rules/cross-sport.md` (X-SW-9) and the 11 sport files (rows below).

**Interfaces:**
- Consumes: Task 9's `opp_diff`, and Tasks 7–8's ledger (every chain now reads Buchholz).

- [ ] **Step 1: Write the failing tests** in `defaults-sweep.test.ts`:

```ts
it("X-SW-9 every sport's Swiss default is rulebook §5's chain for its family (counted, a second call equal)", () => {
  const n = forEachSport(({ module }) => {
    for (const cfg of declaredCfgs(module)) {
      expect(module.defaultTiebreakers("swiss", cfg)).toEqual(SWISS[module.key]);
      expect(module.defaultTiebreakers("swiss", cfg)).toEqual(SWISS[module.key]); // second call
    }
  });
  expect(n).toBe(11);
});
it("X-SW-9 every Swiss default passes validateCascade on its own sport (the sport records every step)", …);
it("X-SW-9 no Swiss default puts a head-to-head step before Buchholz (rulebook §5 'h2h late')", …);
it("X-SW-9 a stage pinned to the pre-W3 badminton chain still ranks by its pin (X-TB-2; Review Focus 5)", …); // resolveTableRules({pinned})
```
  - Add one per-sport title per row id, e.g. `it("BD-TB-2 badminton's Swiss default: points, Buchholz Cut-1, Buchholz, set ratio, point ratio, direct encounter, lots", …)`. Do the same for TT-TB-2, VB-TB-3, TN-TB-3, FB-TB-5, HK-TB-3, IH-TB-3, CK-TB-2, CA-TB-2, GN-TB-2 and BG-TB-4.
  - Add an end-to-end case in `src/competition/swiss-unplayed.test.ts`: `"X-SW-9 badminton Swiss: two entrants level on points who never met split on Buchholz, not head-to-head"`. Build a hand-built stage under the declared default and hand-compute who wins.
- [ ] **Step 2: Run, expect FAIL:** `src/competition/defaults-sweep.test.ts`.
- [ ] **Step 3: Implement** the table. **Step 4: Run, expect PASS:** `src/competition/defaults-sweep.test.ts src/competition/cascade-rules.test.ts src/competition/table-rules.test.ts src/competition/tables-rulebook.test.ts src/competition/swiss-unplayed.test.ts src/testkit/simulation.test.ts src/sports/boardgame/boardgame.test.ts src/sports/period/period.test.ts src/sport/config-write-issues.test.ts src/competition/tie-what-if.test.ts`. Add any file `grep -arln "swissTiebreakers\|defaultTiebreakers(\"swiss\"" src` lists.
- [ ] **Step 5: Mutate.** Revert badminton's chain to `[points, wins, set_ratio, point_ratio, h2h_points]` → BD-TB-2 and the Buchholz end-to-end test red. Revert football's kind branch → FB-TB-5 reds.
- [ ] **Step 6: Write the rows** (status `signed 252 2026-10-31`; citation "rulebook §5, RB3-8 (UEFA CL 2025/26 art. 18 shape for goals; FIDE C.07 4.1 for chess)"; enforced at the sport file; proved by `packages/engine/src/competition/defaults-sweep.test.ts`):
  - X-SW-9 rule: "A Swiss stage's default tie-break order is its sport family's: own score first, opponents' strength (Buchholz) early, direct encounter late and a drawing of lots last — chess, set sports, tennis, goals, cricket, carrom and generic each by rulebook §5."
  - BD-TB-2, TT-TB-2, VB-TB-3, TN-TB-3, FB-TB-5, HK-TB-3, IH-TB-3, CK-TB-2, CA-TB-2, GN-TB-2, BG-TB-4: one per sport file, rule text = "the Swiss default order: <the chain in words>."
  - FB/HK/IH add "(deviation: UEFA's away, disciplinary and coefficient criteria are not modelled)" with status `deviation 252 2026-10-31`.
- [ ] **Step 7: Run** `test/rules-reference.test.ts`, then commit `feat(tiebreaks): Swiss default chains for all 11 sports, Buchholz early (SW-H4, X-SW-9)`.

---

### Task 11: Open the engine PR (changeset, gates, live-division check, body)

**Files:**
- Create: `.changeset/w3-swiss-engine.md` (`"@onryde/seazn-engine": major`; body: one line per change, the boardgame FOLD_EPOCH 4→5, and "pairRound returns SwissPairResult; buildSwissTable → buildSwissLedger").

- [ ] **Step 1: Branch gates, run once, scoped:**
  - `pnpm boundary`
  - `pnpm single-sport --check --against origin/main`
  - `node node_modules/typescript-native/bin/tsc -p tsconfig.tools-tests.json`
  - `pnpm fold-epoch:check --against origin/main` (boardgame only)
  - `pnpm schema:snapshot && git status --porcelain -- ':(glob)src/sports/**/*.schema.json'` (empty)
  - `pnpm mutation:floor --check-file-against origin/main`
  - `pnpm exec eslint --max-warnings 0 $(git diff --name-only origin/main -- '*.ts')`
  - Every test file touched in Tasks 1–10 (4b and 4c included), in ONE JSON-reported run, plus `test/rules-reference.test.ts`.

  Paste the raw counts into the PR body. A stryker sizing drift is the known red (`AGENTS.md` "Known red"). Record it, and name the follow-up re-measure PR (the #1054 / engine #5 pattern). Do not run Stryker.
- [ ] **Step 2: Live-division check** (design §7; the orchestrator runs it).
  - Run ONE read-only query against stg (standing OK; `REMOTE_DATABASE_URL` from the app's `.env.local`, schema `seazn_club`) and ONE against prod (approved 2026-10-31).
  - The question: for Swiss stages with a bye fixture, does the effective points rule (the stage pin in the table-rules pin column read by `apps/web/src/server/engine-db/table-rules.ts`, else the division rule) carry a `forfeit` row whose `winnerPoints` differs from `win.regulation`, or a `forfeit_win` bonus?
  - Never put a URL or secret in argv or in output.
  - If the count is 0: write "Live divisions: 0 byes paid a forfeit row or bonus (stg N stages, prod M) — no data change" in the body.
  - If it is above 0: STOP and report. The owner's rule is a LOUD note plus a pre-deploy app migration (app plan), never a shim.
- [ ] **Step 3: Downstream expectation.** The `downstream` job (app@main on this PR's snapshot) is expected to RED on app tsc. The expected errors are:
  - `pairRound` callers (`stages.ts` ~1442; others the job lists) narrowing on `ok`;
  - `byeScore` readers;
  - exhaustive `TiebreakerKey` maps missing `opp_diff`.

  List the job's actual errors in the body. Do not merge over it: `downstream` is not a required check, but `AGENTS.md` "Known red" says nothing else red may be merged over. Recommend to the orchestrator, for the owner: merge when the paired app bump PR, pinned to `0.0.0-pr<N>.<sha>`, is green.
- [ ] **Step 4: Push and open the PR** (`gh pr create --repo onryde/seazn.club.engine`). The body has:
  - the gap list (SW-H1 engine, SW-L3, SW-L4, SW-L5, SW-L9, SW-H4, SW-M1, SW-L1, SW-L2, SW-M6, SW-M8);
  - the rows added;
  - the epoch table;
  - the raw gate counts;
  - Step 2's line;
  - Step 3's list;
  - a link to the paired app PR once open;
  - exactly this line: `Matrix rows: swiss, swiss_playoff, swiss_knockout × football, cricket, boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis, icehockey, hockey (33 cells) — pairing refusal and legality, art. 16 tie-breaks, bye = win points, Swiss default chains; rule rows X-SW-1..11, BD-TB-2, TT-TB-2, VB-TB-3, TN-TB-3, FB-TB-5, HK-TB-3, IH-TB-3, CK-TB-2, CA-TB-2, GN-TB-2, BG-TB-4`
  - the attribution: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

  Hand back after the push. The orchestrator watches CI.

---

### Task 12: Rules close-out engine PR — GATED: start only after the §6.2 and §6.3 app PRs have merged to seazn.club main

**Files:**
- Modify: `rules/cross-sport.md`, `rules/boardgame.md`
- Create: `.changeset/w3-swiss-rules-closeout.md` via `pnpm changeset --empty`

**Interfaces:**
- Consumes the app's merged code and test paths. Re-pin every path from the merged app tree (`git -C ~/github/seazn.club show origin/main:<path>`); never take them from either plan. Every proof file must already carry the row id in an `it(`/`test(`/`describe(` title. If it does not, the row waits: open a one-line app PR that adds the id to the title first.

- [ ] **Step 1: Write one row per §12 "Close-out" line.** Allocate ids by re-checking the next free X-SW-n; the suggested ids are below. Keep `-KO-` out of every id.

| Suggested id | Rule (§12) | Status |
|---|---|---|
| X-SW-12 | Late entry after pairing: cases (a) re-pair if nothing in the round started, keeping every slot's time and court; (b) play the bye holder; (c) next round | `deviation 250 2026-10-31` (FIDE C.04.2 4.4) |
| X-SW-13 | Automatic arrivals after Start always take case (c) | signed 250 |
| X-SW-14 | No round left: "Add a round" while running; "This Swiss is over" after | signed 250 |
| X-SW-15 | Unplayed pairs (double walkover) may meet again; a walkover winner stays bye-ineligible | signed 252 (RB3-2, RB3-14) |
| X-SW-16 | Round count guidance; warn above ⌊n/2⌋; refuse above n−1 (even) / n (odd) | signed 252 (RB3-3) |
| X-SW-17 | Rounds per stage, editable until the first fixture starts; then only Finish / Add a round | signed 252 (RB3-5, #838) |
| X-SW-18 | Requested ½/0 byes deferred (⛔ with guidance) | signed 252 (RB3-7(c)) |
| X-SW-19 | Pairing score groups use the stage's table points | signed 252 (RB3-9) |
| BG-SW-1 (`rules/boardgame.md`) | Chess colours on by default for boardgame Swiss; round-1 colour by lot | signed 252 (RB3-10) |
| X-SW-20 | Rank-adjacent from round 2 in swiss_playoff / swiss_knockout | `deviation 252` (RB3-12) |
| X-SW-21 | "Add match" refused on a Swiss stage | signed 252 (RB3-15 A) |
| X-SW-22 | Seeded random draw for an unseeded round 1 | signed 252 (RB3-16) |
| X-SW-23 | Disqualification = withdrawal from that moment; annulment separate | signed 252 (RB3-17) |
| X-SW-24 | Cut-line ties: flag-and-pick / visible lots, no play-off game | signed 252 (RB3-18) |
| X-SW-25 | Correction after the bracket started: bracket stands, desk warns | signed 252 (RB3-19) |
| X-SW-26 | "Finish the Swiss now" | signed 252 (RB3-20) |
| X-SW-27 | Correction after the next round is paired: published pairing stands, standings recompute | signed 252 (RB3-21) |
| X-SW-28 | Undo of Pair next clears seats if no result, else a named refusal; Add late player has no Undo | signed 252 (RB3-22; design §10.8) |
| X-SW-29 | A bye shell is never on a court and never printed | signed 252 (RB3-23) |
| X-SW-30 | Manual board swap in rounds ≥ 2 blocked with guidance | signed 252 (RB3-25) |
| X-RB-1 (re-check unused) | Rebuild keeps every fixture's time and court and deletes and regenerates in one transaction (any format) | design G3 (#840): cite the ruling the app PR records; if none exists, raise it, do not write the row |

- [ ] **Step 2: Amend the engine rows** X-SW-3 (the desk refusal and its recovery), X-SW-10 (the desk warning on `nextRound`) and X-SW-8 (`swissGen`'s implicit-bye fix to 0) by appending the app's enforced-at and proved-by paths.
- [ ] **Step 3: Verify.**
  - Engine side: `npx vitest run ... test/rules-reference.test.ts` (engine paths; it skips app paths).
  - App side: the app's `scripts/__tests__/rules-reference.test.ts` checks the app paths. It runs only once the app is bumped to a release containing these rows, so note in the PR body that a follow-up app bump PR owes that run green.
- [ ] **Step 4: Changeset and PR.** `pnpm changeset --empty`. Commit `docs(rules): W3 close-out rows (X-SW-12..30, BG-SW-1, X-RB-1)`. The PR body has `Matrix rows: none — rule rows only; code landed in seazn.club #<app PRs>` and the attribution line. Hand back.

---

## Self-review

- **Spec coverage.** Each §6.1 row maps to a task:
  - SW-H1 engine → T1.
  - SW-L3/L4 → T2.
  - SW-L5 → T4.
  - SW-L9 → T3.
  - SW-H4 → T9 + T10.
  - SW-M1/L1/L2 → T7 + T8.
  - SW-M6 → T5.
  - SW-M8 → T6.
  - Rows → in each task.
  - §4's missed rounds → T7. §7 live check → T11. §12 Engine PR lines → X-SW-1..11 + sport rows. §12 Close-out lines → T12.
  - RB3-4's one-round look-ahead → T4b (X-SW-10). RB3-10's topscorer exception → T4c (X-SW-11). Spec §6/§12 assigned neither; the orchestrator placed both in the engine PR on 2026-10-31.
- **Types.** `SwissPairResult`, `SwissRefusal` and `UnplayedRound` are consistent T1→T3 and T7→T8. `swissDrawPoints` is defined in T7 and used in T7–T8. `unplayedSidesOf` is defined in T8. `opp_diff` is defined in T9 and used in T10.
- **Seams.** Two new inputs (`TableFixture.unplayed`, `TableStage.swissAbsentRounds`) have no producer until the app plan fills them. Until then art. 16 forfeits and absences are inert in production: the inert-seam class. The app plan must drive them through `loadStageInputs` → `completeTableStage`. This PR's tests drive the engine consumer only.
