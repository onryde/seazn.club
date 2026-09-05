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
// Mutants killed (Task 3)
// -----------------------
// (c) Swapped the pair when a partnership re-opens after a wicket —
//     `batters: [striker, nonStriker]` → `[nonStriker, striker]` in
//     `InningsAccumulator.onBall` (scorecard.ts). RED: "a new partnership
//     opens with the pair the reducer put at the crease after the wicket" at
//     scorecard.test.ts:327 — `expected [ 'h1', 'h4' ] to deeply equal
//     [ 'h4', 'h1' ]` (the pair after innings 1's run-out). Restored (`cp`
//     backup, `cmp` identical), re-ran GREEN.
// (d) Dropped the maiden credit — `if (overBowler !== null &&
//     this.overRunsByIndex[index] === 0)` → `if (false && …)`, so a maiden
//     over is never credited. RED: Task 2's "a wide and a no-ball count
//     against the bowler…" at scorecard.test.ts:212 — `expected +0 to be 1`
//     (h7's six dots). Restored (`cp` backup, `cmp` identical), re-ran GREEN.
// (e) Computed the required rate over one ball too many — `(needRuns * bpo) /
//     ballsLeft` → `/ (ballsLeft + 1)` in `live()`. RED: "chase maths:
//     target, need, balls left, RRR…" at scorecard.test.ts:353 — `expected 20
//     to be close to 24`. Restored (`cp` backup, `cmp` identical), re-ran
//     GREEN.
// (f) Not required by the brief — it kills the brief's OWN chase gate.
//     Reverted `isChase` in `live()` from `index === inningsPerSide * 2 - 1`
//     (the reducer's `isChaseIndex`) to the brief's `state.innings.length >=
//     2`. RED: "no target, need or RRR in a third innings…" at
//     scorecard.test.ts:393 — `expected 2 to be null`, i.e. a Test's third
//     innings shown the FOURTH innings' target. Restored (`cp` backup, `cmp`
//     identical), re-ran GREEN.
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
import type { EventEnvelope } from "../../../core/events.ts";
import type { LineupPair } from "../../../core/types.ts";
import { makeEnvelope } from "../../../testkit/helpers.ts";
import { chaseTarget, cricket, type CricketCfg } from "../cricket.ts";
import { deriveCricketScorecard } from "../scorecard.ts";
import { scriptLedger, type Script } from "./scorecard-ledger.ts";

const HOME = ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8"];
const AWAY = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];

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

// Fix round 1, finding 3: a summary-fidelity innings has NO ball-by-ball
// crease information at all — `didNotBat` must be `[]`, not "every lineup
// person who never appeared in a ball payload" (which, at this fidelity, is
// literally everyone). `Script`/`scriptLedger` only express ball-fidelity
// innings (Task 4 owns the summary-fidelity ledger surface); this builds
// the smallest legal summary-only ledger directly, the same way
// `scriptLedger` itself does (`makeEnvelope` + a strict replay), for this
// one test.
function summaryOnlyLedger(): { events: EventEnvelope[]; cfg: CricketCfg; lineups: LineupPair } {
  const cfg = cricket.configSchema.parse({ ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 });
  const lineups: LineupPair = {
    home: { entrantId: "home", slots: HOME.map((personId, i) => ({ personId, slot: "starting" as const, orderNo: i + 1 })) },
    away: { entrantId: "away", slots: AWAY.map((personId, i) => ({ personId, slot: "starting" as const, orderNo: i + 1 })) },
  };
  const events: EventEnvelope[] = [];
  let seq = 0;
  function record(type: string, payload: unknown): void {
    events.push(makeEnvelope(seq, { type, payload }));
    seq += 1;
  }
  record("cricket.toss", { wonBy: "home", elected: "bat" });
  record("core.start", {});
  record("cricket.innings.summary", { runs: 42, wickets: 3, legalBalls: 12 });
  return { events, cfg, lineups };
}

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

  it("a super-over ball never touches a main innings' batting/bowling/extras, and no isSuperOver card is emitted (fix round 1, finding 6)", () => {
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
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 4 }, { bat: 2 }], superOver: true },
      ],
    };
    const { events, state, cfg, lineups } = scriptLedger(TIE_THEN_SUPER_OVER);
    expect(state.phase).toBe("super_over"); // confirms the tie actually fired
    expect(state.superOver?.innings[0]?.runs).toBe(6); // the super-over ball's own runs

    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.innings).toHaveLength(2); // only the two main innings
    expect(card.innings.every((i) => i.isSuperOver === false)).toBe(true);
    expect(card.innings[0]!.total.runs).toBe(2);
    expect(card.innings[1]!.total.runs).toBe(2); // untouched by the super over's 6
    // h7's MAIN innings-2 line is exactly what innings 2 alone produced —
    // the super over's 6 runs never leaked into it via a shared bowler name.
    const h7Main = card.innings[1]!.bowling.find((b) => b.person === "h7")!;
    expect(h7Main.runs).toBe(2);
    expect(h7Main.legalBalls).toBe(2);
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
): ReturnType<typeof scriptLedger> & { card: ReturnType<typeof deriveCricketScorecard>["innings"][number] } {
  const spec = script.innings[inningsIndex]!;
  const ledger = scriptLedger({
    ...script,
    innings: [
      ...script.innings.slice(0, inningsIndex),
      { ...spec, deliveries: spec.deliveries.slice(0, deliveryCount), leaveOpen: true },
    ],
  });
  const card = deriveCricketScorecard({ events: ledger.events, cfg: ledger.cfg, lineups: ledger.lineups }).innings[
    inningsIndex
  ]!;
  return { ...ledger, card };
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
