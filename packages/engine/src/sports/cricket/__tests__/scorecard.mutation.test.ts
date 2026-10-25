// Mutation-debt kills for `scorecard.ts` — the gaps `scorecard.test.ts` left
// behind its derived-vs-derived assertions. Every expected value below is
// hand arithmetic from the Laws (DOMAIN.md: Law 17 the over, Law 21.7 a
// maiden, Law 25.4.3 retired out, Law 8.1 ends after a wicket; economy and run
// rate are runs * balls-per-over / legal balls), written down in a comment
// beside the assertion. Exact lists (`toEqual` on a whole `.map(person)`), not
// `find`, because a duplicated or null row is the defect several of these
// guards exist to refuse.
import { describe, expect, it } from "vitest";
import { makeEnvelope } from "../../../testkit/helpers.ts";
import { deriveCricketScorecard } from "../scorecard.ts";
import { AWAY, HOME, SUPER_OVER_SCRIPT, lineLedger, scriptLedger, summaryOnlyLedger, type Script } from "./scorecard-ledger.ts";

const CFG = { ballsPerInnings: 12, playersPerSide: 8, minOversForResult: 2 };
const LONG_CFG = { ballsPerInnings: 30, playersPerSide: 8, minOversForResult: 2 };

function cardOf(script: Script) {
  const { events, cfg, lineups } = scriptLedger(script);
  return deriveCricketScorecard({ events, cfg, lineups });
}

function homeInnings(
  deliveries: Script["innings"][number]["deliveries"],
  extra: Partial<Script> = {},
  open = true,
): Script {
  return {
    cfg: CFG,
    home: HOME,
    away: AWAY,
    tossWonBy: "home",
    elected: "bat",
    innings: [{ batting: "home", bowlers: ["a7", "a8"], deliveries, ...(open ? { leaveOpen: true } : {}) }],
    ...extra,
  };
}

const DOT = { bat: 0 } as const;
const dots = (n: number) => Array.from({ length: n }, () => DOT);

describe("scorecard mutation kills — bowling lines, maidens and the over log", () => {
  // Four six-ball overs, a7 on 1 and 3, a8 on 2 and 4. Law 21.7: a maiden is an
  // over with no run charged to the bowler; a no-ball's run (and any bat runs
  // off it) IS charged, byes are not.
  const FOUR_OVERS: Script = homeInnings([
    ...dots(6), //                                   over 1, a7: six dots -> maiden
    { extra: "noball", runs: 1, bat: 1 }, ...dots(6), // over 2, a8: 1 + 1 charged -> not a maiden
    { extra: "noball", runs: 1 }, ...dots(6), //     over 3, a7: 1 charged -> not a maiden
    { extra: "noball", runs: 2 }, ...dots(6), //     over 4, a8: 2 charged -> not a maiden
  ], { cfg: LONG_CFG });

  it("bowling rows are exactly the bowlers, once each, with hand-counted maidens, runs, no-balls and economy", () => {
    const [inn] = cardOf(FOUR_OVERS).innings;
    // Once each, in the order they first bowled — a row per BALL would repeat.
    expect(inn!.bowling.map((b) => b.person)).toEqual(["a7", "a8"]);
    // a7: overs 1 and 3 = 12 legal balls; the only run is over 3's no-ball.
    // Economy 1 * 6 / 12 = 0.5. One no-ball, no wides, one maiden (over 1).
    expect(inn!.bowling[0]).toEqual({
      person: "a7", legalBalls: 12, overs: "2.0", maidens: 1, runs: 1, wickets: 0, economy: 0.5, wides: 0, noBalls: 1,
    });
    // a8: overs 2 and 4 = 12 legal balls; runs 1 bat + 1 no-ball, then a 2-run
    // no-ball = 4. Economy 4 * 6 / 12 = 2. No-balls tally 1 + 2 = 3. No maiden.
    expect(inn!.bowling[1]).toEqual({
      person: "a8", legalBalls: 12, overs: "2.0", maidens: 0, runs: 4, wickets: 0, economy: 2, wides: 0, noBalls: 3,
    });
  });

  it("the over log numbers overs from 1 and names the bowler of each", () => {
    const [inn] = cardOf(FOUR_OVERS).innings;
    expect(inn!.overs.map((o) => o.number)).toEqual([1, 2, 3, 4]);
    expect(inn!.overs.map((o) => o.bowler)).toEqual(["a7", "a8", "a7", "a8"]);
  });

  it("batting rows are exactly the batters at the crease, once each", () => {
    const [inn] = cardOf(FOUR_OVERS).innings;
    expect(inn!.batting.map((b) => b.person)).toEqual(["h1", "h2"]);
    expect(inn!.didNotBat).toEqual(["h3", "h4", "h5", "h6", "h7", "h8"]);
  });
});

describe("scorecard mutation kills — rates, economy rounding and the live block", () => {
  // Over 1 (a7): 1,0,0,2,0,0 = 3 runs. Over 2 (a8): six dots = a maiden.
  // Over 3 (a7): one ball, 2 runs. Thirteen legal balls, 5 runs, innings open.
  const THIRTEEN: Script = homeInnings([
    { bat: 1 }, DOT, DOT, { bat: 2 }, DOT, DOT,
    ...dots(6),
    { bat: 2 },
  ], { cfg: LONG_CFG });

  it("economy rounds to one place: a7 conceded 5 off 7 balls = 30/7 = 4.3; a maiden is credited to the bowler of that over only", () => {
    const [inn] = cardOf(THIRTEEN).innings;
    const a7 = inn!.bowling.find((b) => b.person === "a7")!;
    const a8 = inn!.bowling.find((b) => b.person === "a8")!;
    expect(a7).toMatchObject({ legalBalls: 7, overs: "1.1", runs: 5, economy: 4.3, maidens: 0 });
    expect(a8).toMatchObject({ legalBalls: 6, overs: "1.0", runs: 0, economy: 0, maidens: 1 });
  });

  it("total run rate and the live crr/projection are hand arithmetic: 5 * 6 / 13, and round(5 * 30 / 13) = 12", () => {
    const card = cardOf(THIRTEEN);
    expect(card.innings[0]!.total.runRate).toBeCloseTo(30 / 13, 6);
    expect(card.live!.crr).toBeCloseTo(30 / 13, 6);
    expect(card.live!.projected).toBe(12);
    expect(card.live!.ballsLeft).toBe(17);
  });

  it("with no legal ball yet there is no rate to speak of: run rate, crr and projection are null, not Infinity", () => {
    // Law 21.4: a wide is not a legal ball; the innings has 1 run off 0 balls.
    const card = cardOf(homeInnings([{ extra: "wide", runs: 1 }]));
    expect(card.innings[0]!.total).toMatchObject({ runs: 1, legalBalls: 0, runRate: null });
    expect(card.live!.crr).toBeNull();
    expect(card.live!.projected).toBeNull();
    expect(card.live!.ballsLeft).toBe(12);
  });

  it("an unlimited-overs innings has no balls left and nothing to project onto", () => {
    const card = cardOf(
      homeInnings([{ bat: 1 }, DOT, { bat: 2 }], { cfg: { ballsPerInnings: null, playersPerSide: 8, minOversForResult: 2 } }),
    );
    expect(card.live).not.toBeNull();
    expect(card.live!.ballsLeft).toBeNull();
    expect(card.live!.projected).toBeNull();
    expect(card.live!.rrr).toBeNull();
  });

  it("a chase has a required rate but no projection (the projection is the FIRST innings')", () => {
    // Home 2 off 2 balls; away 1 off 1 ball, open. Target 3, need 2 off 11:
    // rrr = 2 * 6 / 11.
    const card = cardOf({
      cfg: CFG, home: HOME, away: AWAY, tossWonBy: "home", elected: "bat",
      innings: [
        { batting: "home", bowlers: ["a7"], deliveries: [{ bat: 1 }, { bat: 1 }], close: "other" },
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }], leaveOpen: true },
      ],
    });
    expect(card.live!.target).toBe(3);
    expect(card.live!.needRuns).toBe(2);
    expect(card.live!.rrr).toBeCloseTo(12 / 11, 6);
    expect(card.live!.projected).toBeNull();
  });

  it("a super over in progress has no projection even with a ball bowled in it", () => {
    const script: Script = {
      ...SUPER_OVER_SCRIPT,
      innings: [
        ...SUPER_OVER_SCRIPT.innings.slice(0, 2),
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 4 }], superOver: true },
      ],
    };
    const card = cardOf(script);
    expect(card.live).not.toBeNull();
    expect(card.live!.battingSide).toBe("away");
    expect(card.live!.projected).toBeNull();
  });
});

describe("scorecard mutation kills — the stand that follows a wicket", () => {
  it("a wicket as the very last ball leaves the new pair at the crease as an unbroken 0-off-0 stand", () => {
    // h1 faces ball 1 (1 run -> cross), h2 faces ball 2 (dot) and ball 3 (bowled).
    // Law 8.1 / the reducer: h3 takes the dismissed striker's end, h1 stays at
    // the other, so the pair is [h3, h1].
    const card = cardOf(homeInnings([{ bat: 1 }, DOT, { out: "bowled" }]));
    expect(card.innings[0]!.partnerships).toEqual([
      { batters: ["h1", "h2"], runs: 1, balls: 3, wicket: 1 },
      { batters: ["h3", "h1"], runs: 0, balls: 0, wicket: "unbroken" },
    ]);
    expect(card.live!.partnership).toEqual({ runs: 0, balls: 0 });
  });

  it("the wicket that ends the innings (all out) opens no further stand", () => {
    // playersPerSide 2 -> one wicket is all out (the reducer's allOutWickets).
    const card = cardOf(
      homeInnings([{ bat: 2 }, { out: "bowled" }], { cfg: { ...CFG, playersPerSide: 2 } }, false),
    );
    expect(card.innings[0]!.closed).toBe(true);
    expect(card.innings[0]!.partnerships).toEqual([{ batters: ["h1", "h2"], runs: 2, balls: 2, wicket: 1 }]);
  });

  it("a wicket on the last legal ball of an innings closed on overs also opens no further stand", () => {
    // 12-ball innings: eleven dots then a wicket on ball 12. The innings closes
    // on overs with both ends still occupied (h3 has walked in), so only the
    // closed flag stops a phantom unbroken stand.
    const card = cardOf(homeInnings([...dots(11), { out: "bowled" }], {}, false));
    const inn = card.innings[0]!;
    expect(inn.closed).toBe(true);
    expect(inn.partnerships).toEqual([{ batters: ["h1", "h2"], runs: 0, balls: 12, wicket: 1 }]);
  });

  it("a super-over wicket with nobody to walk in opens no stand and lists no phantom batter", () => {
    // The super over does not seat a replacement (strictOrder is false there):
    // after a2 is bowled the striker end is empty, so there is no pair.
    const script: Script = {
      ...SUPER_OVER_SCRIPT,
      innings: [
        ...SUPER_OVER_SCRIPT.innings.slice(0, 2),
        { batting: "away", bowlers: ["h7"], deliveries: [{ bat: 1 }, { out: "bowled" }], superOver: true },
      ],
    };
    const card = cardOf(script);
    const so = card.innings[2]!;
    expect(so.isSuperOver).toBe(true);
    expect(so.partnerships).toEqual([{ batters: ["a1", "a2"], runs: 1, balls: 2, wicket: 1 }]);
    expect(so.batting.map((b) => b.person)).toEqual(["a1", "a2"]);
    expect(card.live!.partnership).toBeNull();
  });

  it("a super-over run-out of the NON-striker leaves the other end empty: no stand opens either", () => {
    // Hand-appended ball: a1 on strike, a2 (non-striker) run out, no runs.
    const script: Script = {
      ...SUPER_OVER_SCRIPT,
      innings: [
        ...SUPER_OVER_SCRIPT.innings.slice(0, 2),
        { batting: "away", bowlers: ["h7"], deliveries: [DOT], superOver: true },
      ],
    };
    const { events, cfg, lineups } = scriptLedger(script);
    const runOut = makeEnvelope(events.length, {
      type: "cricket.superover.ball",
      payload: {
        over: 0, ballInOver: 2, striker: "a1", nonStriker: "a2", bowler: "h7",
        runs: { bat: 0 }, wicket: { kind: "runout", out: "a2", bowlerCredited: false },
      },
    });
    const so = deriveCricketScorecard({ events: [...events, runOut], cfg, lineups }).innings[2]!;
    expect(so.partnerships).toEqual([{ batters: ["a1", "a2"], runs: 0, balls: 2, wicket: 1 }]);
  });
});

describe("scorecard mutation kills — retirements", () => {
  it("a retired-out batter closes his stand on the DIFFERENCE of the totals and opens the next with the new pair", () => {
    // h1,h2 open. b1: h1 bat 1 (cross). b2: h2 bat 2. b3: h2 bowled (3 runs, 3
    // balls) -> h3 in at h2's end: [h3, h1]. b4: h3 bat 1 (cross) -> h1 on
    // strike, 4 runs, 4 balls. Then h1 retires out (Law 25.4.3): wicket 2, h4
    // in at his end: [h4, h3].
    const card = cardOf(
      homeInnings([{ bat: 1 }, { bat: 2 }, { out: "bowled" }, { bat: 1 }, { retire: true, reason: "out" }]),
    );
    const inn = card.innings[0]!;
    expect(inn.partnerships).toEqual([
      { batters: ["h1", "h2"], runs: 3, balls: 3, wicket: 1 },
      { batters: ["h3", "h1"], runs: 1, balls: 1, wicket: 2 }, // 4-3 runs, 4-3 balls
      { batters: ["h4", "h3"], runs: 0, balls: 0, wicket: "unbroken" },
    ]);
    expect(inn.fallOfWickets.map((f) => [f.wicket, f.runs, f.over, f.batter])).toEqual([
      [1, 3, "0.3", "h2"],
      [2, 4, "0.4", "h1"],
    ]);
  });

  it("a retired-NOT-out batter costs no wicket and no row, and the same stand carries on with his replacement", () => {
    // h1 faces one dot, retires hurt; h3 takes his end: [h3, h2], same stand
    // (it opened at 0 runs / 0 balls), now 1 ball old.
    const card = cardOf(homeInnings([DOT, { retire: true, reason: "hurt" }]));
    const inn = card.innings[0]!;
    expect(inn.total.wickets).toBe(0);
    expect(inn.fallOfWickets).toEqual([]);
    expect(inn.batting.find((b) => b.person === "h1")!.dismissal).toEqual({ kind: "not_out" });
    expect(inn.partnerships).toEqual([{ batters: ["h3", "h2"], runs: 0, balls: 1, wicket: "unbroken" }]);
  });
});

describe("scorecard mutation kills — band 2 player lines", () => {
  const card = () =>
    deriveCricketScorecard(
      (() => {
        const { events, cfg, lineups } = lineLedger(undefined, [
          { innings: 1, person: "h1", batting: { runs: 30, balls: 20, out: true } },
          { innings: 1, person: "h2", batting: { runs: 0, balls: 0, out: false } },
          { innings: 1, person: "h3", batting: { runs: 4, balls: 7 } },
          { innings: 1, person: "a7", bowling: { legalBalls: 12, runs: 20, wickets: 2 } },
          { innings: 1, person: "a8", bowling: { legalBalls: 0, runs: 0, wickets: 0 } },
        ]);
        return { events, cfg, lineups };
      })(),
    ).innings[0]!;

  it("batting lines are numbered from 1 in filed order, with strike rate and the right dismissal", () => {
    const inn = card();
    expect(inn.batting).toEqual([
      // 30 off 20 = 150.0; said out, nothing more.
      { order: 1, person: "h1", runs: 30, balls: 20, fours: null, sixes: null, strikeRate: 150, dismissal: { kind: "out_unknown" } },
      // no ball faced: no strike rate (not NaN); said not out.
      { order: 2, person: "h2", runs: 0, balls: 0, fours: null, sixes: null, strikeRate: null, dismissal: { kind: "not_out" } },
      // 4 off 7 = 57.14 -> 57.1; `out` absent means not out.
      { order: 3, person: "h3", runs: 4, balls: 7, fours: null, sixes: null, strikeRate: 57.1, dismissal: { kind: "not_out" } },
    ]);
  });

  it("bowling lines: economy 20 * 6 / 12 = 10, and null (not NaN) for a bowler who bowled no ball", () => {
    const inn = card();
    expect(inn.bowling.map((b) => [b.person, b.economy])).toEqual([["a7", 10], ["a8", null]]);
  });
});

describe("scorecard mutation kills — innings recorded as totals", () => {
  it("run rate is runs * 6 / balls, null with no balls; a totals-only innings has no extras block", () => {
    const { events, cfg, lineups } = summaryOnlyLedger([
      { runs: 42, wickets: 3, legalBalls: 12 },
      { runs: 0, wickets: 0, legalBalls: 0, partial: true },
    ]);
    const card = deriveCricketScorecard({ events, cfg, lineups });
    expect(card.innings.map((i) => i.total.runRate)).toEqual([21, null]); // 42 * 6 / 12
    expect(card.innings.map((i) => i.extras)).toEqual([null, null]);
    expect(card.live!.crr).toBeNull();
    expect(card.live!.projected).toBeNull();
  });
});

describe("scorecard mutation kills — a lineup event the kernel refuses", () => {
  it("a substitution naming a side that is not in the fixture, as the very first event, is ignored without a crash", () => {
    // The fold treats its first onFolded call as a squad change, so
    // `noteDeparture` is reached for an event the kernel REFUSED (replay ignores
    // a structurally invalid lineup event: unknown entrant). It must record
    // nothing and leave the card readable.
    const { cfg, lineups } = scriptLedger({ cfg: CFG, home: HOME, away: AWAY, tossWonBy: "home", elected: "bat", innings: [] });
    const refused = makeEnvelope(0, {
      type: "core.lineup.substitution",
      payload: { side: "nobody", off: "h1", on: { personId: "zz", slot: "starting", orderNo: 99 } },
    });
    const card = deriveCricketScorecard({ events: [refused], cfg, lineups });
    expect(card.innings).toEqual([]);
    expect(card.band).toBe(0);
  });
});
