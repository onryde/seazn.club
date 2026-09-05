// Spectator match centre — cricket scorecard fold (Task 1: totals, extras by
// kind, fidelity band; Task 2: batting/bowling lines, did-not-bat). Every
// expectation is derived from the reducer's own state (`cricket.summary`,
// `FineInnings`) or the script that built the ledger — never a hand-typed
// constant standing in for one.
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
import { cricket } from "../cricket.ts";
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
