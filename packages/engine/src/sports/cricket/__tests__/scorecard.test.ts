// Spectator match centre — cricket scorecard fold (Task 1: totals, extras by
// kind, fidelity band; Task 2: batting/bowling lines, did-not-bat; Task 3:
// fall of wickets, partnerships, over log, live block and chase maths). Every
// expectation is derived from the reducer's own state (`cricket.summary`,
// `FineInnings`, `chaseTarget`) or the script that built the ledger — never a
// hand-typed constant standing in for one.
//
// Fix round 1 — review findings on Task 2 (verbatim numbering from the
// reviewer; code lives in `scorecard.ts` unless noted)
// -----------------------------------------------------------------------
// 1. `BowlingLine.runs` read a second, hand-rolled `chargedRuns` tally keyed
//    by `payload.bowler` instead of `fine.bowlerRuns[person]` — on the
//    non-strict read path the engine credits whichever bowler STATE says is
//    CURRENT, which can disagree with a replayed `payload.bowler`, so a
//    row's `runs` could disagree with its own state-sourced
//    `balls`/`wickets`. Fixed: `runs = fine.bowlerRuns[person] ?? 0`; the
//    per-ball charged-runs tally now exists ONLY to decide maidens. Mutant
//    (b) below is RE-RECORDED at its new site (the maiden path).
// 2. The derived `fours` assertion pointed at h1, whose count (0) equalled
//    `scriptFours(TWO_INNINGS, "h1")` (also 0) — a derived-vs-derived
//    comparison that proves nothing when both sides are trivially zero (the
//    four is h2's). Fixed: points at h2 (with a pinned literal alongside
//    the derived value, for the same reason the "no-ball hit for four" test
//    already pins one); added a `sixes` assertion for h3's six (ball 7).
//    `scriptFours` is generalised to `scriptBoundaries(script, person, 4 |
//    6)`.
// 3. `didNotBat` was computed OUTSIDE the `fine === null` guard batting/
//    bowling already used, so a summary-fidelity innings (no ball ever
//    named a crease occupant) reported its WHOLE lineup as did-not-bat.
//    Fixed: `fine === null ? [] : …`. Tested against a minimal hand-built
//    summary-only ledger (`summaryOnlyLedger` below — Task 4 may build a
//    fuller one later).
// 4. Dismissal detail came only from ball payloads, so a batter retired OUT
//    (`cricket.retire`, no ball at all) read as `not_out`. Added
//    `InningsAccumulator.onRetire`, wired into the main replay loop; it also
//    moves the open partnership's pair to the post-retire crease occupant
//    (from Task 3's own report: a retirement changes who's in exactly like
//    a wicket does, but carries no ball for `onBall` to see).
// 5. A batter seated by the LAST ball's wicket, with no FOLLOWING ball to
//    name them, was reported did-not-bat — nothing had ever added them to
//    `order`. Fixed in `cards()`: `fine.striker`/`fine.nonStriker` are
//    appended to a COPY of `order` (never the stored array) when state
//    still shows them at the crease.
// 6. Regression test (no code defect found): a super-over ball can never
//    touch a main innings' batting/bowling/extras, and `cards()` never
//    emits an `isSuperOver` card — both already true of `onBall`'s existing
//    match-wide-index offset and `cards()`'s `state.innings`-only map (see
//    the class doc). `scriptLedger` gained a minimal `superOver: true`
//    innings-spec flag purely to express one `cricket.superover.ball` for
//    this test (Task 4 owns a fuller super-over ledger surface).
// 7. Ruling: fours/sixes stay keyed on `boundary === 4 | 6` ALONE — matches
//    the engine's own player-stats fold (cricket.ts:2448) — never gated on
//    `runs.bat`. Added the negative pair instead: an ALL-RUN four
//    (`{ bat: 4, allRun: true }`, no `boundary` flag) must not count as one.
// 8. (Task 1 re-review, same files) `boundaryOf` is now applied in the
//    ledger builder's WICKET branch too (a wicket ball can still clear the
//    boundary); the "result" test's comment below mischaracterized
//    TWO_INNINGS's decider (it is AWAY's chase that decides it — home only
//    bats once here — running out of overs short of the target, i.e. HOME
//    DEFENDS; away's innings never gets close enough to "target passed");
//    `index.ts` now names its 12 scorecard types plus `ScorecardInput`
//    instead of `export type *`.
// 9. Cheap minors: `order` numbering (1-based, appearance order) and
//    bowling order (first over first) are now asserted directly in the
//    batting/bowling test; a dot-plus-wide over proves a wide DENIES a
//    maiden, paired with a dot-plus-bye over proving a bye does NOT (the
//    re-recorded mutant (b) site — finding 1).
//
// Mutants killed (Task 3, and its fix round 1)
// -----------------------------------------------------------------------
// Every one was applied to `scorecard.ts`, run scoped, then restored from a
// `cp -p` backup verified byte-identical with `cmp -s` and re-run GREEN.
// Line numbers are this file's, re-recorded after the last edit to it.
//
// (c) Swapped the pair when a partnership re-opens after a wicket —
//     `batters: [striker, nonStriker]` -> `[nonStriker, striker]` in
//     `InningsAccumulator.onBall`. RED: "a new partnership opens with the
//     pair the reducer put at the crease after the wicket" at
//     scorecard.test.ts:689 — `expected [ 'h1', 'h4' ] to deeply equal
//     [ 'h4', 'h1' ]` (the pair after innings 1's run-out).
// (d) Dropped the maiden credit — `if (overBowler !== null &&
//     this.overRunsByIndex[index] === 0)` -> `if (false && …)`. RED: Task 2's
//     "a wide denies a maiden; a bye does not" at scorecard.test.ts:469 —
//     `expected +0 to be 1`. NB the mutation has to remove the CREDIT, not
//     the zero-runs predicate: the credited bowler bowls exactly one over and
//     it is the maiden, so "every over is a maiden" and "this over is a
//     maiden" agree and that mutant survives for a reason unrelated to the
//     code.
// (e) Required rate over one ball too many — `(needRuns * bpo) / ballsLeft`
//     -> `/ (ballsLeft + 1)` in `live()`. RED: "chase maths: target, need,
//     balls left, RRR…" at scorecard.test.ts:715 — `expected 20 to be close
//     to 24`.
// (f) The brief's OWN chase gate: `isChase` from `index === inningsPerSide *
//     2 - 1` back to `state.innings.length >= 2`. RED: "no target, need or
//     RRR in a third innings…" at scorecard.test.ts:755 — `expected 2 to be
//     null`, i.e. a Test's third innings shown the FOURTH innings' target.
// (g) Removed the match-wide innings offset in `onBall` —
//     `(inSuperOver ? after.innings.length : 0) + local` -> `local`, i.e.
//     Task 1's `after.innings.length - 1`. RED: "a super over leaves every
//     main innings card byte-for-byte as it was…" at scorecard.test.ts:907.
// (h) Deleted the previous-wickets refresh at the end of `onRetire`'s
//     retired-out branch (`this.prevWicketsByIndex[index] = …`). RED: "a
//     retired-out files its own fall-of-wickets row…" at
//     scorecard.test.ts:838 — the over holding the NEXT delivery absorbs the
//     ball-less wicket as its own.
// (i) Deleted the decided-match gate in `live()` (`if (!inSuperOver &&
//     state.outcome !== null) return null;`). RED: "live is null after a
//     time-expiry draw…" at scorecard.test.ts:884.
// (j) `thisOver` from the OPEN over back to the last entry in the log —
//     `overs[Math.floor(innings.legalBalls / bpo)]` -> `overs[overs.length -
//     1]`. RED: "between overs 'this over' is empty…" at
//     scorecard.test.ts:1014.
//
// NOT killable, recorded so the next reader does not hunt for it: narrowing
// (i) to a bare `state.outcome !== null` — the reviewer's stated reason for
// the `!inSuperOver` half ("a tie sets outcome before the super over") is a
// FALSE PREMISE. `decideTie` (cricket.ts) sets `phase: "super_over"` and
// leaves `outcome` NULL whenever `cfg.superOver` is on; every path that does
// set an outcome around a super over has already closed the innings the
// `closed` check catches. The half is kept as ruled — it is correct, and it
// is the difference between a robust gate and one that depends on that — but
// no test can witness it today.
//
// Mutants killed (Task 4)
// -----------------------------------------------------------------------
// Same protocol as Task 3's: applied to `scorecard.ts`, run scoped, restored
// from a `cp -p` backup verified byte-identical with `cmp -s`, re-run GREEN,
// and re-measured against the FINAL file so the line numbers below are this
// file's.
//
// (f) BRIEF-REQUIRED — `band` as the MIN band present instead of the MAX:
//     `let band: FidelityBand = 0` -> `= 3`, and `eventBand > band` ->
//     `eventBand < band` in `deriveCricketScorecard`. RED on FOUR band
//     tests: "empty ledger…" at :338 (`expected 3 to be +0`), "band is the
//     max band present: balls → 3" at :360 (`expected 1 to be 3`), "band 2:
//     player lines…" at :1240 (`expected +0 to be 2`) and "band 1: a toss
//     beside the same summaries…" at :1348 (`expected +0 to be 1`).
//     NOTE the band-0 test does NOT red on this one, and cannot: its ledger
//     carries `cricket.innings.summary` alone, so its min and its max are
//     both 0. That is exactly why the ladder is asserted at THREE rungs —
//     any single rung leaves a direction of this mutation unwitnessed.
// (k) Band-2 dismissal always "not out" — `dismissal: line.out ? … : …` ->
//     `false && line.out ? …` in `lineBatting`. RED: "band 2: player lines…"
//     at :1254 — the `toMatchObject` reports `{ kind: 'not_out' }` where the
//     line said out.
// (l) Band-2 bowling nulls as ZEROES — `maidens: null`/`wides: null`/
//     `noBalls: null` -> `0` in `lineBowling`. RED: the same test at :1265.
//     The claim this kills is the one in the test's own title: `null` is
//     "this ledger cannot say", and `0` is a different, false statement.
// (m) `cards()` drops the super over — `(state.superOver?.innings ?? [])` ->
//     `([] as InningsState[])`. RED on FOUR: Task 2's own super-over test
//     at :602, Task 3's at :945, "a super over appears as innings flagged
//     isSuperOver…" at :1409 and the abandoned-super-over test at :1485.
// (n) The super-over card at its CONTAINER-LOCAL slot — `this.card(state,
//     innings, state.innings.length + i, true)` -> `…, i, true)`. RED at
//     :1422 — `expect(superOvers[0]!.extras!.wides).toBe(1)` reads `0`,
//     because the card is now looking at main innings 1's accumulator slot
//     (and at :613 in Task 2's own test). That assertion was MOVED ahead of
//     the cheap `number` check for exactly this reason: behind it, the only
//     field a wrong slot can move was unreachable, killed by a sibling.
// (o) `result` only for a win — `outcome === null` -> `outcome === null ||
//     outcome.kind !== "win"`. RED on FOUR, all `expected null not to be
//     null`: the tie at :1368, the draw at :1390, the abandoned super over
//     at :1480, and Task 3's own time-expiry draw at :921.
// (p) A coarse innings denied a target — `isChase` gains `fine !== null` in
//     `live()`. RED: "band 0: innings summaries alone…" at :1327 —
//     `expected null to be 43`, the chase target a summary-only ledger CAN
//     answer.
// (q) THE ADDENDUM'S OWN — the `!inSuperOver` half put back on the live
//     gate. RED: "an ABANDONED super over is over…" at :1479, and ONLY that
//     one; Task 3's "a super over leaves every main innings card…" (which
//     asserts `live` is NON-null during a live super over) stayed green
//     throughout, which is the positive pair proving the removal does not
//     blank a super over in progress.
//
// Mutants killed (Task 2)
// -----------------------
// (a) Deleted the `extras.kind === "wide"` branch that credits
//     `widesByIndex[bowler]` in `InningsAccumulator.onBall` (scorecard.ts).
//     RED: "a wide and a no-ball count against the bowler…" —
//     `expect(a7.wides).toBe(1)` → received 0. Restored (`cp` backup, diffed
//     identical), re-ran GREEN.
// (b) Widened the bowler-charged-runs condition in the same method from
//     `extras?.kind === "wide" || extras?.kind === "noball"` to also match
//     `"bye"`, so a bye's runs get charged to the bowler. RED (at the time):
//     the same test — `expect(conceded).toBe(inn1.total.runs - byes -
//     legByes - penalties)` → conceded came out 1 higher (innings 1's one
//     bye leaking into a8's `runs`). Restored (`cp` backup, diffed
//     identical), re-ran GREEN.
//     RE-RECORDED, fix round 1 finding 1: `BowlingLine.runs` no longer reads
//     this tally at all (it reads `fine.bowlerRuns` directly), so this
//     mutation no longer touches `conceded` — it now lives ONLY in the
//     per-over maiden check. Re-applied the identical widened condition
//     post-fix and re-ran "a wide denies a maiden; a bye does not"
//     (scorecard.test.ts): RED — `expect(bInn1.bowling.find(b =>
//     b.person === "a7")!.maidens).toBe(1)` → received `0` (the bye's 1 run
//     now wrongly counted against the over, so it no longer reads as a
//     maiden). Restored (`cp` backup, `cmp` identical), re-ran GREEN.
import { describe, expect, it } from "vitest";
import { chaseTarget, cricket, padSpec } from "../cricket.ts";
import { deriveCricketScorecard } from "../scorecard.ts";
import type { BallGlyph } from "../scorecard-types.ts";
import {
  AWAY,
  HOME,
  SUPER_OVER_SCRIPT,
  TIE_NO_SUPER_OVER,
  lineLedger,
  scriptLedger,
  summaryOnlyLedger,
  type Delivery,
  type Script,
} from "./scorecard-ledger.ts";

export const TWO_INNINGS: Script = {
  // 2 overs a side keeps the fixture readable. `minOversForResult` must be
  // overridden too: the schema's default (5) fails
  // `minOversForResult * ballsPerOver <= ballsPerInnings` (5*6=30 > 12) — a
  // false premise in the brief's illustrative cfg, found by running it.
  cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    {
      batting: "home",
      bowlers: ["a7", "a8"],
      deliveries: [
        { bat: 1 },
        { bat: 4 },
        { extra: "wide", runs: 1 },
        { bat: 0 },
        { out: "caught", fielder: "a3" },
        { bat: 2 },
        { bat: 6 },
        { extra: "noball", runs: 1, bat: 2 },
        { bat: 0 },
        { extra: "bye", runs: 1 },
        { out: "runout", fielder: "a5", assist: "a6", bat: 1 },
        { extra: "legbye", runs: 1 },
        { bat: 3 },
      ],
    },
    {
      batting: "away",
      bowlers: ["h7", "h8"],
      deliveries: [
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 },
        { bat: 0 }, // a maiden
        { bat: 4 },
        { out: "bowled" },
        { out: "lbw" },
        { out: "stumped", fielder: "h1" },
        { extra: "penalty", runs: 5 },
        { bat: 1 },
      ],
    },
  ],
};

// A match tied in regulation, then a super over in progress. Hoisted to
// module scope (Task 3 fix round 1, findings 3 and 6) so the super-over
// tests can also fold the SAME script WITHOUT its super-over entry and
// deep-equal the two — the strongest form of "the super over touched no
// main innings", since it compares every field of every card rather than
// the handful anyone thought to name.
const TIE_THEN_SUPER_OVER: Script = {
  cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2, superOver: true },
  home: HOME,
  away: AWAY,
  tossWonBy: "home",
  elected: "bat",
  innings: [
    { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
    // Away ties at 2-2 (target = home's 2 + 1 = 3; away's runs === target - 1).
    { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
    // ICC alternation: away batted second in the match, so away bats
    // FIRST in the super over — `soBattingSideAt`, not assumed. h7
    // (home) bowls the same name that bowled innings 2, on purpose: a
    // container mix-up would leak these 6 runs into h7's MAIN innings-2
    // line.
    // The wide is deliberate (Task 3 fix round 1, finding 3): NO main
    // innings here scripts one, so `extras.wides` on a main card is a
    // field only a super-over ball could ever move.
    {
      batting: "away",
      bowlers: ["h7"],
      deliveries: [{ bat: 4 }, { extra: "wide", runs: 1 }, { bat: 2 }],
      superOver: true,
    },
  ],
};

// Derives an expected boundary count STRAIGHT FROM THE SCRIPT'S OWN LEDGER —
// never a hand-typed literal. `scriptLedger` already replays `cricket.apply`
// event by event and stamps each recorded `cricket.ball` payload's
// `striker`/`nonStriker` from the reducer's own state as it goes (see
// `scorecard-ledger.ts`'s header), so a ball's `striker` field IS the
// reducer's own answer to "who was facing this delivery", not a re-derived
// guess. Counting `boundary === runs` balls by that field is exactly
// "replaying cricket.apply and reading who was on strike" — it just reuses
// the replay scriptLedger already did rather than running a second,
// parallel one. Generalised from `scriptFours` (fix round 1, finding 2) so
// one helper covers both 4s and 6s.
//
// This caught a real false premise in the brief's own illustrative comment
// ("HOME's h1 faces balls 1-2 (1 run then 4)"): ball 1 is `{ bat: 1 }`, an
// ODD run, so the reducer rotates strike before ball 2 — the four is h2's,
// not h1's. Confirmed by dumping `scriptLedger(TWO_INNINGS).events`: ball 2's
// payload has `striker: "h2"`. `scriptBoundaries(TWO_INNINGS, "h1", 4)` is 0.
function scriptBoundaries(script: Script, person: string, runs: 4 | 6): number {
  const { events } = scriptLedger(script);
  return events.filter((ev) => {
    if (ev.type !== "cricket.ball" && ev.type !== "cricket.superover.ball") return false;
    const payload = ev.payload as { striker: string; boundary?: number };
    return payload.striker === person && payload.boundary === runs;
  }).length;
}

// `summaryOnlyLedger` (fix round 1, finding 3) and its Task 4 siblings
// `lineLedger`/`SUPER_OVER_SCRIPT` now live in `scorecard-ledger.ts` beside
// `scriptLedger` — see the imports above. They belong there for the same
// reason `scriptLedger` does: they REPLAY every event they record through
// `cricket.apply` on the write path, so an illegal sequence fails in the
// builder rather than reaching a test as a silently wrong expectation.
describe("deriveCricketScorecard — totals", () => {
  it("empty ledger → no innings, no live, band 0, result null (EMPTY CASE FIRST)", () => {
    const { cfg, lineups } = scriptLedger({ ...TWO_INNINGS, innings: [] });
    const card = deriveCricketScorecard({ events: [], cfg, lineups });
    expect(card.innings).toEqual([]);
    expect(card.live).toBeNull();
    expect(card.result).toBeNull();
    expect(card.band).toBe(0);
  });

  it("innings totals equal the reducer's own summary on the same ledger (parity)", () => {
    const { events, state, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    const summary = cricket.summary(state) as {
      detail: { innings: Array<{ runs: number; wickets: number; legalBalls: number }> };
    };
    expect(card.innings.map((i) => [i.total.runs, i.total.wickets, i.total.legalBalls])).toEqual(
      summary.detail.innings.map((i) => [i.runs, i.wickets, i.legalBalls]),
    );
  });

  it("extras are counted by kind and sum to the innings' extras", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1?.extras).toEqual({ wides: 1, noBalls: 1, byes: 1, legByes: 1, penalties: 0, total: 4 });
  });

  it("band is the max band present: balls → 3", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    expect(deriveCricketScorecard({ events, cfg, lineups }).band).toBe(3);
  });
});

describe("deriveCricketScorecard — result", () => {
  it("result carries the reducer's own headline, winner and margin on a decided match", () => {
    const { events, state, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    const summary = cricket.summary(state) as { headline: string; detail: { margin?: unknown } };
    const outcome = cricket.outcome(state);
    // Fix round 1, finding 8: this comment previously said "home's second
    // innings closes on target passed", which is wrong twice over — home
    // bats only ONCE here (it's AWAY's chase, innings 2, that decides the
    // match), and it never reaches the target (10 runs, chasing 24): its
    // 12 legal balls run out first, so HOME DEFENDS the total (an
    // auto-close on balls exhausted — `autoClose`/`decideAfterClose`), not
    // "target passed". `outcome` is non-null either way.
    expect(outcome).not.toBeNull();
    const expectedWinner = outcome !== null && "winner" in outcome ? outcome.winner : null;
    expect(card.result).not.toBeNull();
    expect(card.result?.headline).toBe(summary.headline);
    expect(card.result?.winner).toBe(expectedWinner);
    expect(card.result?.margin).toBe(summary.detail.margin ?? null);
  });

  it("result is null while a match is still in play (one innings only)", () => {
    const { events, cfg, lineups } = scriptLedger({ ...TWO_INNINGS, innings: [TWO_INNINGS.innings[0]!] });
    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.result).toBeNull();
  });
});

describe("deriveCricketScorecard — batting and bowling", () => {
  it("batting lines carry runs, balls, 4s, 6s, SR and the dismissal with credit", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    // Fix round 1, finding 2: the four off ball 2 is h2's, not h1's — a
    // derived-vs-derived comparison on h1 (0 === 0) proves nothing. Point it
    // at the batter who actually carries the value, with a pinned literal
    // alongside the derived one (the same belt-and-suspenders the "no-ball
    // hit for four" test above already uses, for the same reason: a
    // `toBe(scriptBoundaries(...))` comparison alone can't see a bug shared
    // by both sides of the equality).
    const h2 = inn1!.batting.find((b) => b.person === "h2")!;
    expect(h2.fours).toBe(1);
    expect(h2.fours).toBe(scriptBoundaries(TWO_INNINGS, "h2", 4));
    // The six off ball 7 is h3's — previously untested at all.
    const h3 = inn1!.batting.find((b) => b.person === "h3")!;
    expect(h3.sixes).toBe(1);
    expect(h3.sixes).toBe(scriptBoundaries(TWO_INNINGS, "h3", 6));
    const h1 = inn1!.batting.find((b) => b.person === "h1")!;
    expect(h1.strikeRate).toBe(Math.round(((h1.runs * 100) / h1.balls) * 10) / 10);
    const caught = inn1!.batting.find((b) => b.dismissal.kind === "caught")!;
    expect(caught.dismissal).toEqual({ kind: "caught", bowler: "a7", fielder: "a3", fielderAssist: null });
    const runout = inn1!.batting.find((b) => b.dismissal.kind === "runout")!;
    expect(runout.dismissal).toMatchObject({ kind: "runout", bowler: null, fielder: "a5", fielderAssist: "a6" });
    // Finding 9 (cheap minor): batting ORDER numbering is 1-based in
    // appearance order, and bowling order is first-over-first — both
    // derived from the script, never re-typed.
    expect(inn1!.batting.map((b) => b.order)).toEqual(inn1!.batting.map((_, i) => i + 1));
    expect(inn1!.bowling.map((b) => b.person)).toEqual(TWO_INNINGS.innings[0]!.bowlers);
  });

  it("a wicket ball that also clears the boundary still sets the boundary flag (fix round 1, finding 8)", () => {
    const WICKET_FOUR: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ out: "hitwicket", bat: 4 }], close: "other" }],
    };
    const { events, cfg, lineups } = scriptLedger(WICKET_FOUR);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const h1 = inn1!.batting.find((b) => b.person === "h1")!;
    expect(h1.fours).toBe(1);
    expect(h1.dismissal.kind).toBe("hitwicket");
  });

  it("an all-run four (no ball reaching the boundary) does not count as a four (fix round 1, finding 7)", () => {
    const ALL_RUN_FOUR: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ bat: 4, allRun: true }], close: "other" }],
    };
    const { events, cfg, lineups } = scriptLedger(ALL_RUN_FOUR);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const h1 = inn1!.batting.find((b) => b.person === "h1")!;
    expect(h1.runs).toBe(4); // the runs still count…
    expect(h1.fours).toBe(0); // …but not as a FOUR: no `boundary` flag was set
  });

  it("a wide denies a maiden; a bye does not (fix round 1, findings 1 and 9)", () => {
    // Mutant (b), re-recorded (finding 1): folding a bye into the bowler's
    // per-over charged-runs total would make THIS over's tally nonzero,
    // denying the maiden it should credit — see the comment block at the
    // top of this file.
    const WIDE_OVER: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        {
          batting: "home",
          bowlers: ["a7"],
          deliveries: [{ bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { extra: "wide", runs: 1 }, { bat: 0 }],
          close: "other",
        },
      ],
    };
    const { events: wEvents, cfg: wCfg, lineups: wLineups } = scriptLedger(WIDE_OVER);
    const [wInn1] = deriveCricketScorecard({ events: wEvents, cfg: wCfg, lineups: wLineups }).innings;
    expect(wInn1!.bowling.find((b) => b.person === "a7")!.maidens).toBe(0);

    const BYE_OVER: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        {
          batting: "home",
          bowlers: ["a7"],
          deliveries: [{ bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { bat: 0 }, { extra: "bye", runs: 1 }],
          close: "other",
        },
      ],
    };
    const { events: bEvents, cfg: bCfg, lineups: bLineups } = scriptLedger(BYE_OVER);
    const [bInn1] = deriveCricketScorecard({ events: bEvents, cfg: bCfg, lineups: bLineups }).innings;
    expect(bInn1!.bowling.find((b) => b.person === "a7")!.maidens).toBe(1);
  });

  it("a wide and a no-ball count against the bowler; byes, leg-byes and penalties do not", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1, inn2] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const a7 = inn1!.bowling.find((b) => b.person === "a7")!;
    expect(a7.wides).toBe(1);
    // runs conceded by a7 = bat runs off a7 + wides + no-ball runs, minus nothing else — assert against the
    // reducer: inn1.total.runs - byes - legByes - penalties === sum(bowling.runs)
    const conceded = inn1!.bowling.reduce((s, b) => s + b.runs, 0);
    expect(conceded).toBe(inn1!.total.runs - inn1!.extras!.byes - inn1!.extras!.legByes - inn1!.extras!.penalties);
    expect(inn2!.bowling.find((b) => b.person === "h7")!.maidens).toBe(1); // the six dots
  });

  it("did-not-bat lists the lineup persons who never reached the crease, in lineup order", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const atCrease = new Set(inn1!.batting.map((b) => b.person));
    expect(inn1!.didNotBat).toEqual(HOME.filter((p) => !atCrease.has(p)));
  });

  it("did-not-bat is empty at summary fidelity — no ball ever named who was at the crease (fix round 1, finding 3)", () => {
    const { events, cfg, lineups } = summaryOnlyLedger();
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1!.batting).toEqual([]);
    expect(inn1!.bowling).toEqual([]);
    expect(inn1!.didNotBat).toEqual([]);
  });

  it("a batter seated by the last ball's wicket, with no following ball to name them, still shows as batting (fix round 1, finding 5)", () => {
    // TWO_INNINGS's first innings, cut off right on its FIRST wicket (the
    // 5th delivery, 4th legal — see the fall-of-wickets test below): the
    // reducer resolves a replacement into the crease synchronously with
    // that wicket ball, but with no ball AFTER it, that replacement never
    // appears in any payload's striker/nonStriker field.
    const atFall1 = scriptPrefix(TWO_INNINGS, 0, 5);
    const replacement = atFall1.state.innings[0]!.fine!.striker!;
    expect(atFall1.card.batting.some((b) => b.person === replacement)).toBe(true);
    expect(atFall1.card.didNotBat).not.toContain(replacement);
    const line = atFall1.card.batting.find((b) => b.person === replacement)!;
    expect(line.runs).toBe(0);
    expect(line.balls).toBe(0);
    expect(line.dismissal).toEqual({ kind: "not_out" });
  });

  it("a retired-out batter is dismissed, credited to no bowler; retired-not-out stays not_out; the open partnership's pair moves (fix round 1, finding 4)", () => {
    const RETIRE_OUT: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        {
          batting: "home",
          bowlers: ["a7"],
          // A ball first — `cricket.retire` needs "an innings in progress"
          // (`requireOpenInnings`), which only a scoring event creates.
          deliveries: [{ bat: 1 }, { retire: true, reason: "out" }, { bat: 0 }],
          leaveOpen: true,
        },
      ],
    };
    const { events, cfg, lineups } = scriptLedger(RETIRE_OUT);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    const [inn1] = card.innings;
    // WHICH opener retires is the reducer's own answer, never assumed: ball
    // 1 (`{ bat: 1 }`) is an ODD run, so `scriptLedger` reads the retiring
    // striker off state AFTER that rotation — the same false-premise trap
    // the `fours` fix (finding 2) already caught once in this file. Read it
    // back off the `cricket.retire` event's own payload.
    const retiredPerson = (events.find((ev) => ev.type === "cricket.retire")!.payload as { person: string }).person;
    const notRetired = ["h1", "h2"].find((p) => p !== retiredPerson)!;
    const retiredLine = inn1!.batting.find((b) => b.person === retiredPerson)!;
    expect(retiredLine.dismissal).toEqual({ kind: "retired", bowler: null, fielder: null, fielderAssist: null });
    // The other opener never retired — stays not out.
    const notRetiredLine = inn1!.batting.find((b) => b.person === notRetired)!;
    expect(notRetiredLine.dismissal).toEqual({ kind: "not_out" });
    // The open partnership's pair moved on to whoever replaced the retiree
    // at the crease — not stale on a name no longer batting. Read the
    // replacement off state (the reducer's own answer), never typed.
    const replacement = events
      .filter((ev) => ev.type === "cricket.ball")
      .map((ev) => (ev.payload as { striker: string }).striker)
      .find((striker) => striker !== "h1" && striker !== "h2");
    expect(replacement).toBeDefined();
    const open = inn1!.partnerships.at(-1)!;
    expect(open.wicket).toBe("unbroken");
    expect(open.batters).toContain(replacement);
    expect(open.batters).not.toContain(retiredPerson);
  });

  it("a super-over ball never touches a main innings' batting/bowling/extras, and only the super over's card is flagged (fix round 1, finding 6)", () => {
    const { events, state, cfg, lineups } = scriptLedger(TIE_THEN_SUPER_OVER);
    expect(state.phase).toBe("super_over"); // confirms the tie actually fired
    expect(state.superOver?.innings[0]?.runs).toBe(7); // 4 + a 1-run wide + 2, the super over's own

    const card = deriveCricketScorecard({ events, cfg, lineups });
    // Task 4 renders the super over as a card of its own, so this test now
    // separates the two containers rather than asserting the super over is
    // absent (which is what it asserted while the gap was open). The
    // separation is the property it always existed to protect.
    const main = card.innings.filter((i) => !i.isSuperOver);
    const superOvers = card.innings.filter((i) => i.isSuperOver);
    expect(main).toHaveLength(2);
    expect(superOvers).toHaveLength(1);
    expect(main[0]!.total.runs).toBe(2);
    expect(main[1]!.total.runs).toBe(2); // untouched by the super over's 6
    expect(superOvers[0]!.total.runs).toBe(state.superOver!.innings[0]!.runs);
    // h7's MAIN innings-2 line is exactly what innings 2 alone produced —
    // the super over's 6 runs never leaked into it via a shared bowler name.
    const h7Main = main[1]!.bowling.find((b) => b.person === "h7")!;
    expect(h7Main.runs).toBe(2);
    expect(h7Main.legalBalls).toBe(2);
    // …and h7 bowls the super over too, on its OWN card, with its own figures.
    const h7Super = superOvers[0]!.bowling.find((b) => b.person === "h7")!;
    expect(h7Super.runs).toBe(state.superOver!.innings[0]!.fine!.bowlerRuns["h7"]);
    expect(h7Super.runs).not.toBe(h7Main.runs);
  });

  it("economy and strike rate are null when nothing was bowled or faced (no NaN, no Infinity)", () => {
    const { events, cfg, lineups } = scriptLedger({
      ...TWO_INNINGS,
      innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ extra: "wide", runs: 1 }] }],
    });
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1!.batting[0]!.strikeRate).toBeNull();
    expect(inn1!.bowling[0]!.economy).toBeNull(); // 0 legal balls
  });

  // Fix round 1, finding 3 (Task 1's fix round, distinct from this file's
  // TASK 2 "Fix round 1" header above — a pre-existing naming collision
  // between the two tasks' first review passes, not touched here) —
  // `buildBallPayload` (scorecard-ledger.ts) only set `boundary` on a
  // plain-bat delivery; a no-ball hit for four never got the flag, so BOTH
  // the accumulator (which reads `payload.boundary`) and `scriptBoundaries`
  // (which reads the very same envelopes) agreed at 0 — a
  // `toBe(scriptBoundaries(...))` comparison alone cannot witness this
  // class of bug, since both sides are downstream of the same
  // ledger-builder function. The literal `.toBe(1)` is what actually reds
  // when the fix is reverted; `scriptBoundaries` (renamed from `scriptFours`
  // in Task 2's fix round, finding 2) is kept alongside it because the
  // review asked for it and it remains a real (if weaker) cross-check.
  it("a no-ball hit for four still counts as a boundary", () => {
    const NOBALL_FOUR: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ extra: "noball", runs: 1, bat: 4 }], close: "other" }],
    };
    const { events, cfg, lineups } = scriptLedger(NOBALL_FOUR);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    const h1 = inn1!.batting.find((b) => b.person === "h1")!;
    expect(h1.fours).toBe(1);
    expect(h1.fours).toBe(scriptBoundaries(NOBALL_FOUR, "h1", 4));
  });
});

// Replays a PREFIX of a script — the same innings, cut off after
// `deliveryCount` deliveries, left OPEN — through the very same builder and
// fold. Every "the score was X at the fall of the Nth wicket" expectation
// below is read back off THIS, so the expected value is the reducer's own
// answer at that point in the innings rather than a constant typed into the
// test: change a delivery in `TWO_INNINGS` and both sides move together.
// (The brief's own arithmetic — `over: "0.4"`, `runs: 1 + 4 + 1 + 0` — is
// kept only as a comment, showing intent.)
function scriptPrefix(
  script: Script,
  inningsIndex: number,
  deliveryCount: number,
): ReturnType<typeof scriptLedger> & {
  scorecard: ReturnType<typeof deriveCricketScorecard>;
  card: ReturnType<typeof deriveCricketScorecard>["innings"][number];
} {
  const spec = script.innings[inningsIndex]!;
  const ledger = scriptLedger({
    ...script,
    innings: [
      ...script.innings.slice(0, inningsIndex),
      { ...spec, deliveries: spec.deliveries.slice(0, deliveryCount), leaveOpen: true },
    ],
  });
  const scorecard = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups });
  return { ...ledger, scorecard, card: scorecard.innings[inningsIndex]! };
}

/** `TWO_INNINGS`'s first innings, left in play — the only way to observe a
 *  live block, an unbroken partnership or an open over, since `scriptLedger`
 *  otherwise closes every innings it opens. */
function firstInningsInPlay(): ReturnType<typeof scriptLedger> {
  return scriptLedger({ ...TWO_INNINGS, innings: [{ ...TWO_INNINGS.innings[0]!, leaveOpen: true }] });
}

describe("deriveCricketScorecard — fall of wickets, partnerships, overs, live", () => {
  it("fall of wickets records the team score and over at each wicket, in order", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1!.fallOfWickets.map((f) => f.wicket)).toEqual([1, 2]);
    expect(inn1!.fallOfWickets.length).toBe(inn1!.total.wickets);
    // The first wicket is the 5th delivery, the 4th LEGAL one (the wide
    // before it does not count) — so "0.4", at 1 + 4 + 1 + 0 = 6 runs. Both
    // are derived from the script prefix ending on that very ball, never
    // typed: `card.total` there is the reducer's score at the fall.
    const atFall1 = scriptPrefix(TWO_INNINGS, 0, 5);
    expect(inn1!.fallOfWickets[0]!.over).toBe(atFall1.card.total.overs);
    expect(inn1!.fallOfWickets[0]!.runs).toBe(atFall1.card.total.runs);
    expect(inn1!.fallOfWickets[0]!.batter).toBe(atFall1.state.innings[0]!.fine!.dismissed[0]);
  });

  it("partnerships sum to the innings total and the last one is unbroken while the innings is open", () => {
    const live = firstInningsInPlay();
    const [inn1] = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups }).innings;
    expect(inn1!.partnerships.reduce((s, p) => s + p.runs, 0)).toBe(inn1!.total.runs);
    expect(inn1!.partnerships.reduce((s, p) => s + p.balls, 0)).toBe(inn1!.total.legalBalls);
    expect(inn1!.partnerships.at(-1)!.wicket).toBe("unbroken");
  });

  it("a new partnership opens with the pair the reducer put at the crease after the wicket", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    // Innings 1's SECOND wicket is the run-out, the 11th delivery. Who walks
    // out after it — and which of the two is on strike — is `cricket.apply`'s
    // own answer, read off a prefix replay ending on that ball. Never typed
    // here: a fold that swapped the pair would still match a literal written
    // to agree with it.
    const afterRunOut = scriptPrefix(TWO_INNINGS, 0, 11).state.innings[0]!.fine!;
    expect(afterRunOut.striker).not.toBe(afterRunOut.nonStriker); // else a swap is unobservable
    expect(inn1!.partnerships[1]!.wicket).toBe(2);
    expect(inn1!.partnerships[2]!.batters).toEqual([afterRunOut.striker, afterRunOut.nonStriker]);
  });

  it("over log: runs per over sum to the total, and 'this over' in live is the open over's glyphs", () => {
    const live = firstInningsInPlay();
    const card = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups });
    const [inn1] = card.innings;
    expect(inn1!.overs.reduce((s, o) => s + o.runs, 0)).toBe(inn1!.total.runs);
    expect(inn1!.overs.reduce((s, o) => s + o.wickets, 0)).toBe(inn1!.total.wickets);
    expect(inn1!.overs.at(-1)!.scoreAfter).toEqual({ runs: inn1!.total.runs, wickets: inn1!.total.wickets });
    expect(card.live!.thisOver.length).toBe(inn1!.overs.at(-1)!.balls.length);
    expect(card.live!.striker).toBe((live.state.innings.at(-1) as { fine: { striker: string } }).fine.striker);
  });

  it("chase maths: target, need, balls left, RRR; null in the first innings", () => {
    const chase = TWO_INNINGS.innings[1]!;
    const s = scriptLedger({
      ...TWO_INNINGS,
      innings: [TWO_INNINGS.innings[0]!, { ...chase, deliveries: chase.deliveries.slice(0, 7), leaveOpen: true }],
    });
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    const inn1 = card.innings[0]!;
    const inn2 = card.innings[1]!;
    expect(card.live!.target).toBe(chaseTarget(s.state)); // ONE authority
    expect(card.live!.needRuns).toBe(inn1.total.runs + 1 - inn2.total.runs);
    expect(card.live!.ballsLeft).toBe(s.cfg.ballsPerInnings! - inn2.total.legalBalls);
    expect(card.live!.rrr).toBeCloseTo((card.live!.needRuns! * s.cfg.ballsPerOver) / card.live!.ballsLeft!, 2);
    const first = firstInningsInPlay();
    const firstCard = deriveCricketScorecard({ events: first.events, cfg: first.cfg, lineups: first.lineups });
    expect(firstCard.live!.target).toBeNull();
    expect(firstCard.live!.rrr).toBeNull();
    expect(firstCard.live!.needRuns).toBeNull();
  });

  it("live is null once the match is decided", () => {
    const { events, cfg, lineups } = scriptLedger(TWO_INNINGS);
    expect(deriveCricketScorecard({ events, cfg, lineups }).live).toBeNull();
  });
});

describe("deriveCricketScorecard — the chase is the LAST innings, not the second", () => {
  // Two innings a side. `chaseTarget` answers for the innings that chases,
  // and in this format that is the FOURTH — so a third innings in progress
  // has no target of its own, and printing `chaseTarget`'s answer there would
  // be a wrong number rather than a missing one. The fold mirrors the
  // reducer's own `isChaseIndex` (`inningsPerSide * 2 - 1`), which the
  // brief's "two innings have been played" gate matches only when a side
  // bats once.
  const TEST_MATCH: Script = {
    cfg: { inningsPerSide: 2, ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
    home: HOME,
    away: AWAY,
    tossWonBy: "home",
    elected: "bat",
    innings: [
      { batting: "home", bowlers: ["a7", "a8"], deliveries: [{ bat: 1 }] },
      { batting: "away", bowlers: ["h7", "h8"], deliveries: [{ bat: 1 }] },
      { batting: "home", bowlers: ["a7", "a8"], deliveries: [{ bat: 1 }], leaveOpen: true },
    ],
  };

  it("no target, need or RRR in a third innings; the reducer still has one for the fourth", () => {
    const s = scriptLedger(TEST_MATCH);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    expect(card.innings).toHaveLength(3);
    expect(card.live).not.toBeNull();
    expect(card.live!.target).toBeNull();
    expect(card.live!.needRuns).toBeNull();
    expect(card.live!.rrr).toBeNull();
    // …and it is genuinely a number being withheld, not an absent one: the
    // reducer answers for the fourth innings on this very state.
    expect(chaseTarget(s.state)).toEqual(expect.any(Number));
  });
});

// The glyph a scripted delivery should produce, written from the SCRIPT's own
// shape rather than from the ball payload `glyphOf` reads (Task 3 fix round 1,
// finding 4). Two independent expressions of the same mapping: a `glyphOf`
// that answered `{ kind: "runs", runs: 0 }` for everything, or that lost a
// no-ball's bat runs, disagrees with this immediately.
function expectedGlyph(delivery: Delivery): BallGlyph {
  if ("out" in delivery) return { kind: "wicket", dismissal: delivery.out };
  if ("extra" in delivery) {
    const runs = delivery.runs + (delivery.bat ?? 0);
    switch (delivery.extra) {
      case "wide":
        return { kind: "wide", runs };
      case "noball":
        return { kind: "noball", runs };
      default:
        return { kind: delivery.extra, runs };
    }
  }
  if ("bat" in delivery) return { kind: "runs", runs: delivery.bat };
  throw new Error("expectedGlyph: not a delivery");
}

describe("deriveCricketScorecard — fix round 1", () => {
  // ---- finding 1: the one wicket that falls with no ball attached ---------

  const RETIRED_OUT_MID_INNINGS: Script = {
    cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
    home: HOME,
    away: AWAY,
    tossWonBy: "home",
    elected: "bat",
    innings: [
      {
        batting: "home",
        bowlers: ["a7"],
        // A ball first: `cricket.retire` needs an innings in progress, and
        // only a scoring event opens one.
        deliveries: [{ bat: 1 }, { retire: true, reason: "out" }, { bat: 2 }, { out: "bowled" }, { bat: 1 }],
        leaveOpen: true,
      },
    ],
  };

  it("a retired-out files its own fall-of-wickets row, and the wicket after it is still numbered 2", () => {
    const s = scriptLedger(RETIRED_OUT_MID_INNINGS);
    const [inn1] = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups }).innings;
    const retiree = (s.events.find((ev) => ev.type === "cricket.retire")!.payload as { person: string }).person;

    // Numbering runs unbroken across a wicket that had no ball: without a row
    // for the retirement the bowled would be filed as wicket 1 and this
    // length/total pair would part company.
    expect(inn1!.fallOfWickets.map((f) => f.wicket)).toEqual([1, 2]);
    expect(inn1!.fallOfWickets.length).toBe(inn1!.total.wickets);
    expect(inn1!.fallOfWickets[0]!.batter).toBe(retiree);

    // The score and over at the fall are the reducer's own, read off a prefix
    // replay ending on the retirement itself.
    const atRetirement = scriptPrefix(RETIRED_OUT_MID_INNINGS, 0, 2);
    expect(inn1!.fallOfWickets[0]!.runs).toBe(atRetirement.card.total.runs);
    expect(inn1!.fallOfWickets[0]!.over).toBe(atRetirement.card.total.overs);

    // The stand it broke is CLOSED, with that wicket's number.
    expect(inn1!.partnerships[0]!.wicket).toBe(1);
    expect(inn1!.partnerships[0]!.batters).not.toContain(undefined);
    expect(inn1!.partnerships.at(-1)!.wicket).toBe("unbroken");
    expect(inn1!.partnerships.reduce((sum, p) => sum + p.runs, 0)).toBe(inn1!.total.runs);

    // No OVER absorbs it — a wicket that fell to no ball belongs to no over,
    // and the marker the next delivery is diffed against has to move with it
    // or that delivery's over reports this wicket as its own.
    const retiredOut = s.events.filter(
      (ev) => ev.type === "cricket.retire" && (ev.payload as { reason: string }).reason === "out",
    ).length;
    expect(retiredOut).toBe(1);
    expect(inn1!.overs.reduce((sum, o) => sum + o.wickets, 0)).toBe(inn1!.total.wickets - retiredOut);
  });

  it("an innings all out ON a retired-out closes its last stand with that wicket, not 'unbroken'", () => {
    // Two a side ⇒ `allOutWickets` is 1 (max(1, players - 1)), so the single
    // retired-out IS the innings.
    const ALL_OUT_ON_RETIREMENT: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 2, minOversForResult: 2 },
      home: ["h1", "h2"],
      away: ["a1", "a2"],
      tossWonBy: "home",
      elected: "bat",
      innings: [{ batting: "home", bowlers: ["a1"], deliveries: [{ bat: 1 }, { retire: true, reason: "out" }] }],
    };
    const s = scriptLedger(ALL_OUT_ON_RETIREMENT);
    const [inn1] = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups }).innings;
    expect(inn1!.closed).toBe(true); // the reducer's own autoClose, not the builder's
    expect(inn1!.total.wickets).toBe(1);
    expect(inn1!.partnerships).toHaveLength(1);
    expect(inn1!.partnerships[0]!.wicket).toBe(1); // ended ON a wicket ⇒ not unbroken
    expect(inn1!.fallOfWickets.length).toBe(inn1!.total.wickets);
  });

  // ---- finding 2: a decided match whose innings never closed ---------------

  it("live is null after a time-expiry draw, even though the innings it interrupted is still open", () => {
    const DRAWN_ON_TIME: Script = {
      cfg: { inningsPerSide: 2, ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }] },
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }] },
        { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { matchClose: true }], leaveOpen: true },
      ],
    };
    const s = scriptLedger(DRAWN_ON_TIME);
    // The premise this test exists for: the match is decided and the innings
    // is STILL OPEN, so a `closed`-only gate cannot see it.
    expect(s.state.outcome).not.toBeNull();
    expect(s.state.innings.at(-1)!.closed).toBe(false);

    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    expect(card.result).not.toBeNull();
    expect(card.live).toBeNull();
  });

  // ---- findings 3 and 6: the super over ------------------------------------

  it("a super over leaves every main innings card byte-for-byte as it was, and live reads the super-over slot", () => {
    const beforeSuperOver = scriptLedger({
      ...TIE_THEN_SUPER_OVER,
      innings: TIE_THEN_SUPER_OVER.innings.slice(0, 2),
    });
    const before = deriveCricketScorecard({
      events: beforeSuperOver.events,
      cfg: beforeSuperOver.cfg,
      lineups: beforeSuperOver.lineups,
    });
    const s = scriptLedger(TIE_THEN_SUPER_OVER);
    const after = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });

    // Task 4: the super over now has a card of its own, so "every MAIN card
    // as it was" is the property, and the comparison filters on the flag.
    // `before` has no super over at all, so its own list is entirely main.
    const afterMain = after.innings.filter((i) => !i.isSuperOver);
    expect(before.innings.every((i) => !i.isSuperOver)).toBe(true);
    expect(after.innings.filter((i) => i.isSuperOver)).toHaveLength(1);

    // The three fields below are the ones the ACCUMULATOR owns. Everything
    // else on a card is read back off `state.innings`, which a super-over ball
    // cannot reach whatever index it is filed under — so an assertion built
    // only from those cannot witness a misfiled super-over ball at all, and
    // named ones come FIRST here so a failure says which field moved.
    expect(afterMain.map((i) => i.overs.flatMap((o) => o.balls).length)).toEqual(
      before.innings.map((i) => i.overs.flatMap((o) => o.balls).length),
    );
    // No main innings scripts a wide; the super over does. A main card
    // reporting one has been fed a ball from the other container.
    expect(afterMain.map((i) => i.extras!.wides)).toEqual([0, 0]);
    expect(afterMain.map((i) => i.batting.map((b) => b.person))).toEqual(
      before.innings.map((i) => i.batting.map((b) => b.person)),
    );
    // …and then every remaining field of every main card, as the catch-all:
    // fall of wickets, partnerships, bowling and the totals too.
    expect(afterMain).toEqual(before.innings);

    // …and the super over is genuinely in progress, read from the reducer.
    const so = s.state.superOver!.innings.at(-1)!;
    expect(so.closed).toBe(false);
    expect(after.live).not.toBeNull();
    expect(after.live!.striker).toBe(so.fine!.striker);
    expect(after.live!.battingSide).toBe(s.state.entrants[so.battingSide]);
    expect(after.live!.thisOver).toHaveLength(TIE_THEN_SUPER_OVER.innings[2]!.deliveries.length);
    expect(after.live!.crr).toBe((so.runs * s.cfg.ballsPerOver) / so.legalBalls);
    // The super over has its own target, which this fold does not model; the
    // MATCH chase target would be a wrong number here, so it is withheld.
    expect(after.live!.target).toBeNull();
    // The main innings' own live block is gone — `before` ends on a tie with
    // both innings closed.
    expect(before.live).toBeNull();
  });

  // ---- findings 4 and 5: the live block's unasserted fields, and glyphs -----

  const GLYPH_OVER: Script = {
    cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
    home: HOME,
    away: AWAY,
    tossWonBy: "home",
    elected: "bat",
    innings: [
      {
        batting: "home",
        bowlers: ["a7", "a8"],
        // One of every glyph the type has, then one ball of the next over so
        // the innings is left MID-over. The no-ball's free hit is consumed by
        // the (legal) bye before the bowled, which the reducer would
        // otherwise refuse.
        deliveries: [
          { bat: 0 },
          { bat: 1 },
          { bat: 4 },
          { extra: "wide", runs: 1 },
          { extra: "noball", runs: 1, bat: 2 },
          { extra: "bye", runs: 1 },
          { out: "bowled" },
          { bat: 6 },
          { bat: 1 },
        ],
        leaveOpen: true,
      },
    ],
  };

  it("every glyph in an over is the delivery the script wrote, in order", () => {
    const s = scriptLedger(GLYPH_OVER);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    const [inn1] = card.innings;
    const scripted = GLYPH_OVER.innings[0]!.deliveries;
    const expected = scripted.map(expectedGlyph);

    // The first over holds every delivery up to and including the sixth LEGAL
    // one; the extras inside it are in the over they were bowled in, not the
    // next. Split the expectation where the reducer put the boundary.
    const firstOverBalls = inn1!.overs[0]!.balls.length;
    expect(inn1!.overs[0]!.balls).toEqual(expected.slice(0, firstOverBalls));
    expect(inn1!.overs[1]!.balls).toEqual(expected.slice(firstOverBalls));
    expect(inn1!.overs.flatMap((o) => o.balls)).toEqual(expected);
    // Every kind actually appears — otherwise this is a test of dots.
    expect(new Set(expected.map((g) => g.kind)).size).toBe(5);

    // Mid-over: `thisOver` is the OPEN over's glyphs, which is the second one.
    expect(card.live!.thisOver).toEqual(expected.slice(firstOverBalls));
    expect(card.live!.thisOver.length).toBeGreaterThan(0);
  });

  it("between overs 'this over' is empty — the completed over is in the log, not on the strip", () => {
    const ENDS_ON_AN_OVER: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        {
          batting: "home",
          bowlers: ["a7", "a8"],
          deliveries: [{ bat: 1 }, { bat: 0 }, { bat: 1 }, { bat: 0 }, { bat: 1 }, { bat: 0 }],
          leaveOpen: true,
        },
      ],
    };
    const s = scriptLedger(ENDS_ON_AN_OVER);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    const [inn1] = card.innings;
    // The premise: the innings sits exactly on an over boundary, still open.
    expect(inn1!.total.legalBalls % s.cfg.ballsPerOver).toBe(0);
    expect(inn1!.closed).toBe(false);
    expect(inn1!.overs).toHaveLength(1);
    expect(inn1!.overs.at(-1)!.balls).toHaveLength(s.cfg.ballsPerOver);
    expect(card.live!.thisOver).toEqual([]);
    // …and the bowler for the over to come is not yet named, which is the
    // reducer's own answer at an over boundary.
    expect(card.live!.bowler).toBeNull();
  });

  it("the live block's people, stand, last wicket and projection are all the reducer's own numbers", () => {
    const live = firstInningsInPlay();
    const card = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups });
    const inn = card.innings.at(-1)!;
    const st = live.state.innings.at(-1)!;
    const l = card.live!;

    expect(l.battingSide).toBe(live.state.entrants[st.battingSide]);
    expect(l.nonStriker).toBe(st.fine!.nonStriker);
    expect(l.nonStriker).not.toBe(l.striker);
    expect(l.bowler).toBe(st.fine!.currentBowler);
    expect(l.bowler).not.toBeNull(); // mid-over ⇒ a real name, not a vacuous null-null match

    // The stand still in, exactly as the card reports it.
    const open = inn.partnerships.at(-1)!;
    expect(open.wicket).toBe("unbroken");
    expect(l.partnership).toEqual({ runs: open.runs, balls: open.balls });

    // The last wicket, joined to its own fall-of-wickets row and batting line.
    const fall = inn.fallOfWickets.at(-1)!;
    const line = inn.batting.find((b) => b.person === fall.batter)!;
    expect(l.lastWicket).toEqual({
      batter: fall.batter,
      runs: line.runs,
      balls: line.balls,
      scoreAt: `${fall.runs}/${fall.wicket}`,
    });

    // Projected: this run rate carried out to the innings' full quota.
    expect(l.projected).toBe(Math.round((inn.total.runs * live.cfg.ballsPerInnings!) / inn.total.legalBalls));
    expect(l.projected).not.toBe(inn.total.runs); // else "echo the score" would pass
  });

  it("a stand's balls count LEGAL deliveries — a wide inside it is not one", () => {
    // The first four deliveries of `TWO_INNINGS`'s opening innings include a
    // wide, and no wicket, so the whole innings is still the opening stand.
    const scripted = TWO_INNINGS.innings[0]!.deliveries.slice(0, 4);
    const notBalls = scripted.filter((d) => "extra" in d && (d.extra === "wide" || d.extra === "noball")).length;
    expect(notBalls).toBeGreaterThan(0); // the case is genuinely exercised

    const prefix = scriptPrefix(TWO_INNINGS, 0, scripted.length);
    expect(prefix.scorecard.live!.partnership).toEqual({
      runs: prefix.card.total.runs,
      balls: scripted.length - notBalls,
    });
  });

  // ---- finding 6 minors ----------------------------------------------------

  it("the opening stand's pair is the crease pair of the innings' first ball, in that order", () => {
    const live = firstInningsInPlay();
    const card = deriveCricketScorecard({ events: live.events, cfg: live.cfg, lineups: live.lineups });
    const firstBall = live.events.find((ev) => ev.type === "cricket.ball")!.payload as {
      striker: string;
      nonStriker: string;
    };
    expect(firstBall.striker).not.toBe(firstBall.nonStriker); // else the order is unobservable
    expect(card.innings[0]!.partnerships[0]!.batters).toEqual([firstBall.striker, firstBall.nonStriker]);
  });

  it("at summary fidelity the live block is the totals alone — no people, no stand, no strip", () => {
    const legalBalls = 6;
    const { events, cfg, lineups } = summaryOnlyLedger([{ runs: 42, wickets: 3, legalBalls, partial: true }]);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    // Below ball fidelity, and read from the pad spec itself rather than a
    // typed band: the fold reports the MAX band any event in the ledger
    // carries, so that is what the expectation computes.
    const fidelity = padSpec(cfg).fidelity;
    expect(card.band).toBe(Math.max(0, ...events.map((ev) => fidelity[ev.type] ?? 0)));
    expect(card.band).toBeLessThan(3);

    const inn = card.innings[0]!;
    const l = card.live!;
    expect(l.striker).toBeNull();
    expect(l.nonStriker).toBeNull();
    expect(l.bowler).toBeNull();
    expect(l.thisOver).toEqual([]);
    expect(l.partnership).toBeNull();
    expect(l.lastWicket).toBeNull();
    // …but the numbers a coarse ledger CAN answer are still answered.
    expect(l.crr).toBe((inn.total.runs * cfg.ballsPerOver) / inn.total.legalBalls);
    expect(l.ballsLeft).toBe(cfg.ballsPerInnings! - legalBalls);
    expect(l.projected).toBe(Math.round((inn.total.runs * cfg.ballsPerInnings!) / legalBalls));
  });

  it("a rain revision moves both the balls left and the target", () => {
    const REVISED_OVERS = 1;
    const REVISED_TARGET = 5;
    const RAIN: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 1 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        { batting: "home", bowlers: ["a7", "a8"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
        {
          batting: "away",
          bowlers: ["h7", "h8"],
          deliveries: [
            { bat: 1 },
            { revise: { oversPerSide: REVISED_OVERS, target: REVISED_TARGET } },
            { bat: 1 },
          ],
          leaveOpen: true,
        },
      ],
    };
    const s = scriptLedger(RAIN);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    const inn1 = card.innings[0]!;
    const inn2 = card.innings[1]!;

    // Both numbers genuinely MOVED — otherwise reading the config instead of
    // the revision would pass this test unchanged.
    expect(REVISED_TARGET).not.toBe(inn1.total.runs + 1);
    expect(REVISED_OVERS * s.cfg.ballsPerOver).not.toBe(s.cfg.ballsPerInnings);

    expect(card.live!.target).toBe(chaseTarget(s.state)); // still the one authority
    expect(card.live!.target).toBe(REVISED_TARGET);
    expect(card.live!.ballsLeft).toBe(REVISED_OVERS * s.cfg.ballsPerOver - inn2.total.legalBalls);
    expect(card.live!.needRuns).toBe(REVISED_TARGET - inn2.total.runs);
  });

  it("a bowler named on a ball he does not own is NOT the bowler the card credits", () => {
    // The reducer keeps the over's own bowler and charges the runs to him
    // (`applyDelivery`: the mid-over swap is a strict-only refusal, so on a
    // READ the ledger's own name loses to the over in progress). A card that
    // tallied `payload.bowler` itself would credit the name on the ball —
    // this is the case that makes reading `fine.bowlerRuns` observable.
    const MID_OVER_SWAP: Script = {
      cfg: { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        {
          batting: "home",
          bowlers: ["a7"],
          deliveries: [{ bat: 1 }, { bat: 2, bowler: "a8" }],
          leaveOpen: true,
        },
      ],
    };
    const s = scriptLedger(MID_OVER_SWAP);
    const [inn1] = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups }).innings;
    const fine = s.state.innings[0]!.fine!;
    const scriptedRuns = MID_OVER_SWAP.innings[0]!.deliveries.reduce(
      (sum, d) => sum + ("bat" in d ? (d.bat ?? 0) : 0),
      0,
    );

    // The premise: the ledger really does name a8, and the reducer really
    // does ignore him.
    expect(s.events.some((ev) => (ev.payload as { bowler?: string }).bowler === "a8")).toBe(true);
    expect(fine.currentBowler).toBe("a7");
    expect(fine.bowlerRuns["a8"]).toBeUndefined();

    const a7 = inn1!.bowling.find((b) => b.person === "a7")!;
    expect(a7.runs).toBe(fine.bowlerRuns["a7"]);
    expect(a7.runs).toBe(scriptedRuns);
    expect(inn1!.bowling.find((b) => b.person === "a8")?.runs ?? 0).toBe(0);
  });
});

// ===========================================================================
// Task 4 — the two COARSER bands the fold had never been fed, the result
// variants that are not a win, and the super over as a pair of cards.
// ===========================================================================

describe("deriveCricketScorecard — coarser bands, result, super over", () => {
  it("band 2: player lines fill batting/bowling with nulls where the ledger cannot say", () => {
    const { events, state, cfg, lineups } = lineLedger();
    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.band).toBe(2);

    // The premise this test exists for: the innings carries NO ball-by-ball
    // record at all (`fine === null` is what sends the fold down the
    // player-line path), so a green assertion below cannot be Task 2's
    // ball-derived lines wearing a different hat.
    expect(state.innings[0]!.fine).toBeNull();
    const inn1 = card.innings[0]!;

    // Every expected number is read back off the LEDGER's own line records —
    // `state.playerLines` is what `applyPlayerLine` stored from the very
    // payloads the fold reads — never re-typed here.
    const h1Line = state.playerLines.find((line) => line.person === "h1")!.batting!;
    const h1 = inn1.batting.find((b) => b.person === "h1")!;
    expect(h1).toMatchObject({
      runs: h1Line.runs,
      balls: h1Line.balls,
      fours: null,
      sixes: null,
      dismissal: { kind: "out_unknown" },
    });
    expect(h1.strikeRate).toBe(150);
    expect(h1.strikeRate).toBe(Math.round(((h1Line.runs * 100) / h1Line.balls) * 10) / 10);

    const a7Line = state.playerLines.find((line) => line.person === "a7")!.bowling!;
    expect(inn1.bowling[0]).toMatchObject({
      person: "a7",
      legalBalls: a7Line.legalBalls,
      runs: a7Line.runs,
      wickets: a7Line.wickets,
      maidens: null,
      wides: null,
      noBalls: null,
    });
    expect(inn1.bowling[0]!.economy).toBe(10);
    expect(inn1.bowling[0]!.economy).toBe((a7Line.runs * cfg.ballsPerOver) / a7Line.legalBalls);
    // `overs` is the same notation the totals print, off the line's own balls.
    expect(inn1.bowling[0]!.overs).toBe(
      `${Math.floor(a7Line.legalBalls / cfg.ballsPerOver)}.${a7Line.legalBalls % cfg.ballsPerOver}`,
    );

    // The POSITIVE PAIR for those nulls: at ball fidelity the identical
    // fields are numbers, so `null` here is a value being WITHHELD by this
    // band rather than one the shape never carries.
    const fineLedger = scriptLedger(TWO_INNINGS);
    const fineCard = deriveCricketScorecard({
      events: fineLedger.events,
      cfg: fineLedger.cfg,
      lineups: fineLedger.lineups,
    }).innings[0]!;
    expect(typeof fineCard.batting[0]!.fours).toBe("number");
    expect(typeof fineCard.bowling[0]!.maidens).toBe("number");

    // Everything a line ledger cannot say stays empty/null.
    expect(inn1.overs).toEqual([]);
    expect(inn1.fallOfWickets).toEqual([]);
    expect(inn1.partnerships).toEqual([]);
    expect(inn1.extras).toBeNull();
    // …did-not-bat included: a line exists for whoever someone chose to file
    // one for, so a MISSING line is not evidence that a person did not bat.
    // Paired with the positive right below it, or an empty card would
    // satisfy the empty array for the wrong reason.
    expect(inn1.batting.length).toBeGreaterThan(0);
    expect(inn1.didNotBat).toEqual([]);
  });

  it("band 0: innings summaries alone give totals and (with a second innings) a target — no players", () => {
    const { events, state, cfg, lineups } = summaryOnlyLedger();
    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.band).toBe(0);

    // Premises from the reducer: two innings exist and the second is still
    // open (that is what `partial: true` buys), so `live` is not null for a
    // reason this test can see.
    expect(state.innings).toHaveLength(2);
    expect(state.innings[1]!.closed).toBe(false);

    expect(card.innings.map((i) => i.total.runs)).toEqual(state.innings.map((i) => i.runs));
    expect(card.innings[0]!.batting).toEqual([]);
    expect(card.innings[0]!.bowling).toEqual([]);
    expect(card.innings[0]!.didNotBat).toEqual([]);
    expect(card.innings[0]!.extras).toBeNull();

    expect(card.live).not.toBeNull();
    expect(card.live!.striker).toBeNull();
    expect(card.live!.nonStriker).toBeNull();
    expect(card.live!.bowler).toBeNull();
    expect(card.live!.target).toBe(card.innings[0]!.total.runs + 1);
    // …and that number is the REDUCER's own, not a rule this fold keeps a
    // second copy of.
    expect(card.live!.target).toBe(chaseTarget(state));
  });

  it("band 1: a toss beside the same summaries lifts the band to 1, and nothing else moves", () => {
    const bareLedger = summaryOnlyLedger();
    const tossedLedger = summaryOnlyLedger(undefined, { toss: true });
    const bare = deriveCricketScorecard({
      events: bareLedger.events,
      cfg: bareLedger.cfg,
      lineups: bareLedger.lineups,
    });
    const tossed = deriveCricketScorecard({
      events: tossedLedger.events,
      cfg: tossedLedger.cfg,
      lineups: tossedLedger.lineups,
    });

    expect(bare.band).toBe(0);
    expect(tossed.band).toBe(1);
    // Derived from the pad spec itself as well as pinned: `band` is the MAX
    // band any event in the ledger carries, and a toss is band 1 there.
    const fidelity = padSpec(tossedLedger.cfg).fidelity;
    expect(fidelity["cricket.toss"]).toBe(1);
    expect(tossed.band).toBe(Math.max(0, ...tossedLedger.events.map((ev) => fidelity[ev.type] ?? 0)));
    // A card event adds the toss and NOTHING else — the innings are still
    // the summaries' own.
    expect(tossed.toss).toEqual({ wonBy: "home", elected: "bat" });
    expect(bare.toss).toBeNull();
    expect(tossed.innings).toEqual(bare.innings);
  });

  it("a tie with no super over configured reads as a tie: a result, and no winner", () => {
    const s = scriptLedger(TIE_NO_SUPER_OVER);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    // The premise: the reducer settled this as a TIE. `decideTie` only opens
    // a super over when `cfg.superOver` is on; here it is not, so the tie
    // stands.
    expect(cricket.outcome(s.state)).toEqual({ kind: "tie" });
    expect(card.result).not.toBeNull();
    expect(card.result!.headline).toBe(cricket.summary(s.state).headline);
    expect(card.result!.winner).toBeNull();
    expect(card.live).toBeNull();
  });

  it("a two-innings time-expiry draw reads as a draw: a result, and no winner", () => {
    const DRAWN: Script = {
      cfg: { inningsPerSide: 2, ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 },
      home: HOME,
      away: AWAY,
      tossWonBy: "home",
      elected: "bat",
      innings: [
        { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }] },
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }] },
        { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { matchClose: true }], leaveOpen: true },
      ],
    };
    const s = scriptLedger(DRAWN);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    expect(cricket.outcome(s.state)).toEqual({ kind: "draw" });
    expect(card.result).not.toBeNull();
    expect(card.result!.headline).toBe(cricket.summary(s.state).headline);
    expect(card.result!.winner).toBeNull();
    // The POSITIVE PAIR for both null winners above: on a decided match the
    // very same field carries the reducer's own winner, so `null` is an
    // answer rather than a field this fold never fills.
    const won = scriptLedger(TWO_INNINGS);
    const wonCard = deriveCricketScorecard({ events: won.events, cfg: won.cfg, lineups: won.lineups });
    expect(wonCard.result!.winner).not.toBeNull();
  });

  it("a super over appears as innings flagged isSuperOver, numbered after the main innings", () => {
    const s = scriptLedger(SUPER_OVER_SCRIPT);
    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });

    // Premise from the reducer: two super-over innings genuinely exist.
    const soState = s.state.superOver!.innings;
    expect(soState).toHaveLength(2);

    expect(card.innings.filter((i) => i.isSuperOver).length).toBe(2);
    const superOvers = card.innings.filter((i) => i.isSuperOver);
    const main = card.innings.filter((i) => !i.isSuperOver);
    expect(main.length).toBe(s.state.innings.length);

    // ACCUMULATOR-OWNED FIELDS FIRST (the same ordering rule Task 3's own
    // super-over test states): extras and the over log are the only things
    // on a card that come from the accumulator's per-slot store rather than
    // being read back off the innings object itself, so they are the only
    // ones a card addressed at the WRONG slot can move — and putting them
    // ahead of the cheap `number` check keeps that assertion reachable
    // instead of hidden behind a sibling. The wide is the witness: no main
    // innings in this script bowls one.
    expect(superOvers[0]!.extras!.wides).toBe(1);
    expect(main.map((i) => i.extras!.wides)).toEqual([0, 0]);
    expect(superOvers[0]!.overs.flatMap((o) => o.balls)).toHaveLength(
      SUPER_OVER_SCRIPT.innings[2]!.deliveries.length,
    );

    // THE SUPER OVER CONTINUES THE INNINGS COUNT (cricket.ts's own rule, the
    // one `activeInnings` states) — cards are numbered 1..N across both
    // containers, the super over's last.
    expect(card.innings.map((i) => i.number)).toEqual(card.innings.map((_, i) => i + 1));
    expect(superOvers.map((i) => i.number)).toEqual([s.state.innings.length + 1, s.state.innings.length + 2]);

    // Totals and sides are the reducer's own, and the sides alternate (ICC:
    // the side batting second in the match bats first in the super over).
    expect(superOvers.map((i) => [i.total.runs, i.total.wickets, i.total.legalBalls])).toEqual(
      soState.map((i) => [i.runs, i.wickets, i.legalBalls]),
    );
    expect(superOvers.map((i) => i.side)).toEqual(soState.map((i) => s.state.entrants[i.battingSide]));
    expect(superOvers[0]!.side).not.toBe(superOvers[1]!.side);
    expect(superOvers.map((i) => i.closed)).toEqual(soState.map((i) => i.closed));

    // Batting and bowling come from the super over's own `FineInnings`.
    expect(superOvers[0]!.bowling.map((b) => b.person)).toEqual(["h7"]);
    expect(superOvers[0]!.batting.length).toBeGreaterThan(0);
    expect(superOvers[0]!.batting[0]!.person).toBe(AWAY[0]);
    // A super over nominates three batters and the ledger records no
    // nomination, so the LINEUP is not a did-not-bat list here (the same
    // "do not claim what this ledger cannot say" rule as fix round 1's
    // finding 3). Paired with the non-empty batting above.
    expect(superOvers[0]!.didNotBat).toEqual([]);

    // …and the match itself is decided on the super over, so there is no
    // live block left and the result is the reducer's.
    expect(card.live).toBeNull();
    expect(card.result!.headline).toBe(cricket.summary(s.state).headline);
  });

  it("an ABANDONED super over is over: live is null even though its innings never closed", () => {
    const ABANDONED: Script = {
      ...SUPER_OVER_SCRIPT,
      innings: [
        ...SUPER_OVER_SCRIPT.innings.slice(0, 2),
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 4 }, { abandon: true }], superOver: true },
      ],
    };
    const s = scriptLedger(ABANDONED);

    // The premise this test exists for, and the whole reason the live gate is
    // not qualified by "unless we are in a super over": `applyAbandon` in
    // phase `super_over` settles the match as a TIE and leaves the innings it
    // interrupted OPEN, so a `closed`-only gate cannot see it either.
    expect(s.state.phase).toBe("done");
    expect(cricket.outcome(s.state)).toEqual({ kind: "tie" });
    expect(s.state.superOver!.innings.at(-1)!.closed).toBe(false);
    expect(s.state.superOver!.innings.at(-1)!.legalBalls).toBeGreaterThan(0);

    const card = deriveCricketScorecard({ events: s.events, cfg: s.cfg, lineups: s.lineups });
    expect(card.live).toBeNull();
    expect(card.result).not.toBeNull();
    expect(card.result!.winner).toBeNull();
    // The super over that was abandoned is still ON the scorecard, with the
    // ball it did get — a match that stops is not a match that never was.
    const abandonedCard = card.innings.filter((i) => i.isSuperOver).at(-1)!;
    expect(abandonedCard.total.runs).toBe(s.state.superOver!.innings.at(-1)!.runs);
    expect(abandonedCard.closed).toBe(false);
  });
});
