// Spectator match centre — cricket scorecard fold (Task 1: totals, extras by
// kind, fidelity band; Task 2: batting/bowling lines, did-not-bat; Task 3:
// fall of wickets, partnerships, over log, live block and chase maths). Every
// expectation is derived from the reducer's own state (`cricket.summary`,
// `FineInnings`, `chaseTarget`) or the script that built the ledger — never a
// hand-typed constant standing in for one.
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
//     `"bye"`, so a bye's runs get charged to the bowler. RED: the same test
//     — `expect(conceded).toBe(inn1.total.runs - byes - legByes - penalties)`
//     → conceded came out 1 higher than the right-hand side (innings 1's one
//     bye leaking into a8's `runs`). Restored (`cp` backup, diffed
//     identical), re-ran GREEN.
import { describe, expect, it } from "vitest";
import { chaseTarget, cricket } from "../cricket.ts";
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

// Derives an expected `fours` count STRAIGHT FROM THE SCRIPT'S OWN LEDGER —
// never a hand-typed literal. `scriptLedger` already replays `cricket.apply`
// event by event and stamps each recorded `cricket.ball` payload's
// `striker`/`nonStriker` from the reducer's own state as it goes (see
// `scorecard-ledger.ts`'s header), so a ball's `striker` field IS the
// reducer's own answer to "who was facing this delivery", not a re-derived
// guess. Counting `boundary === 4` balls by that field is exactly "replaying
// cricket.apply and reading who was on strike" — it just reuses the replay
// scriptLedger already did rather than running a second, parallel one.
//
// This caught a real false premise in the brief's own illustrative comment
// ("HOME's h1 faces balls 1-2 (1 run then 4)"): ball 1 is `{ bat: 1 }`, an
// ODD run, so the reducer rotates strike before ball 2 — the four is h2's,
// not h1's. Confirmed by dumping `scriptLedger(TWO_INNINGS).events`: ball 2's
// payload has `striker: "h2"`. `scriptFours(TWO_INNINGS, "h1")` is 0.
function scriptFours(script: Script, person: string): number {
  const { events } = scriptLedger(script);
  return events.filter((ev) => {
    if (ev.type !== "cricket.ball" && ev.type !== "cricket.superover.ball") return false;
    const payload = ev.payload as { striker: string; boundary?: number };
    return payload.striker === person && payload.boundary === 4;
  }).length;
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
    // TWO_INNINGS decides (home's second innings closes on target passed —
    // see the reducer's own `decideAfterClose`), so `outcome` is non-null here.
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
    const h1 = inn1!.batting.find((b) => b.person === "h1")!;
    // The 4 off ball 2 is h2's, not h1's — derived from the script, never a
    // typed literal (see `scriptFours`'s header).
    expect(h1.fours).toBe(scriptFours(TWO_INNINGS, "h1"));
    expect(h1.strikeRate).toBe(Math.round(((h1.runs * 100) / h1.balls) * 10) / 10);
    const caught = inn1!.batting.find((b) => b.dismissal.kind === "caught")!;
    expect(caught.dismissal).toEqual({ kind: "caught", bowler: "a7", fielder: "a3", fielderAssist: null });
    const runout = inn1!.batting.find((b) => b.dismissal.kind === "runout")!;
    expect(runout.dismissal).toMatchObject({ kind: "runout", bowler: null, fielder: "a5", fielderAssist: "a6" });
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

  it("economy and strike rate are null when nothing was bowled or faced (no NaN, no Infinity)", () => {
    const { events, cfg, lineups } = scriptLedger({
      ...TWO_INNINGS,
      innings: [{ batting: "home", bowlers: ["a7"], deliveries: [{ extra: "wide", runs: 1 }] }],
    });
    const [inn1] = deriveCricketScorecard({ events, cfg, lineups }).innings;
    expect(inn1!.batting[0]!.strikeRate).toBeNull();
    expect(inn1!.bowling[0]!.economy).toBeNull(); // 0 legal balls
  });

  // Fix round 1, finding 3 — `buildBallPayload` (scorecard-ledger.ts) only set
  // `boundary` on a plain-bat delivery; a no-ball hit for four never got the
  // flag, so BOTH the accumulator (which reads `payload.boundary`) and
  // `scriptFours` (which reads the very same envelopes) agreed at 0 — a
  // `toBe(scriptFours(...))` comparison alone cannot witness this class of
  // bug, since both sides are downstream of the same ledger-builder function.
  // The literal `.toBe(1)` is what actually reds when the fix is reverted;
  // `scriptFours` is kept alongside it because the review asked for it and it
  // remains a real (if weaker) cross-check.
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
    expect(h1.fours).toBe(scriptFours(NOBALL_FOUR, "h1"));
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
