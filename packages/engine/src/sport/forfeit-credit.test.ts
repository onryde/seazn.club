// W2b Task 4 (spec §5.2; Appendix A X-WO-1, X-RT-1, *-WO-*, *-RT-*; plan PF-6, PF-7). What a forfeit credits the table,
// per sport. EVERY expectation below is the Appendix A rule written out here and fed the cfg (best-of, set target,
// game target, `awardScore`, overs) and the played numbers of the stream — never read back from `forfeitCredit` or
// from `standingsDelta`. A rule that cannot be stated without the module's code is a finding, not a test.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, summaryOf, type EventEnvelope } from "../core/events.ts";
import type { StandingsDelta } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { buildStream, buildWalk, defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

const ev = (seq: number, type: string, payload: unknown = {}): EventEnvelope => makeEnvelope(seq, { type, payload });
const mod = (k: string) => {
  const m = builtinModules.find((x) => x.key === k);
  if (!m) throw new Error(`no module ${k}`);
  return m;
};
type Metrics = Record<string, number>;
type Spec = Array<[string, unknown?]>;
const H = "H";
const A = "A";

/** Fold `spec` (+ seq numbers) and rank it in `stage`. */
function deltasOf(key: string, cfg: unknown, spec: Spec, stage = "league"): [StandingsDelta, StandingsDelta] {
  const m = mod(key);
  const l = defaultLineupPair(m.positions);
  const f = foldMatchWithStoppage(m as never, cfg as never, l, spec.map(([t, p], i) => ev(i + 1, t, p ?? {})));
  const o = outcomeOf(m as never, f as never);
  if (o === null) throw new Error(`${key}: the stream decided nothing`);
  return m.standingsDelta(o, cfg, { kind: stage } as never, f.state);
}
/** Walk A over before start, fold, and return the [home, away] deltas for cfg. */
function walkoverDeltas(key: string, cfg: unknown, stage = "league") {
  return deltasOf(key, cfg, [["core.forfeit", { by: A, reason: "walkover" }]], stage);
}
/** The schema default, or (generic: no default cfg) its first declared variant, with `raw` on top. */
const parsed = (key: string, raw: Record<string, unknown> = {}) => {
  const m = mod(key);
  const base = m.configSchema.safeParse({}).success ? {} : (Object.values(m.variants)[0] as Record<string, unknown>);
  return m.configSchema.parse({ ...base, ...raw }) as Record<string, unknown>;
};

/** Appendix A walkover credit per sport, from the cfg alone (never from forfeitCredit). A walks over, so H wins. */
const EXPECTED_WALKOVER: Record<string, (cfg: Record<string, unknown>) => { winner: Metrics; loser: Metrics }> = {
  football: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0, gd: g }, loser: { gf: 0, ga: g, gd: -g } }; }, // FB-WO-1
  hockey: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0, gd: g }, loser: { gf: 0, ga: g, gd: -g } }; }, // HK-WO-1
  icehockey: (c) => { const g = (c.awardScore as { goals: number }).goals; return { winner: { gf: g, ga: 0, gd: g }, loser: { gf: 0, ga: g, gd: -g } }; }, // IH-WO-1
  volleyball: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // VB-WO-1 (FIVB 6.4.1: 0-25 every set ⇒ setTo, not finalSetTo)
  tabletennis: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // TT-WO-1
  badminton: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.setTo as number), points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.setTo as number) } }; }, // BD-WO-1
  // TN-WO-1 (games excluded). Re-pinned: nested's configSchema names the best-of `bestOf` (nested/kernel.ts makeNestedConfigSchema).
  tennis: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 }, loser: { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 } }; },
  cricket: (c) => { const q = (c.ballsPerInnings as number) * (c.inningsPerSide as number); return { winner: { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 }, loser: { runs_for: 0, balls_faced_eff: q, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 } }; }, // CK-WO-1
  boardgame: () => ({ winner: { wins: 1, white: 0, black: 0 }, loser: { wins: 0, white: 0, black: 0 } }), // BG-WO-1: colour history excluded
  carrom: (c) => { const n = Math.ceil((c.bestOf as number) / 2); return { winner: { sets_won: n, sets_lost: 0, points_won: n * (c.gameTo as number), points_lost: 0, boards_won: 0, boards_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * (c.gameTo as number), boards_won: 0, boards_lost: 0 } }; }, // CA-WO-1
  generic: () => ({ winner: { for: 0, against: 0, diff: 0 }, loser: { for: 0, against: 0, diff: 0 } }), // GN-WO-1
};
/** PF-6 (CK-WO-2): unlimited-overs cricket has no quota, so NRR is undefined — filtered from the CK-WO-1 rule. */
const unlimitedOvers = (key: string, cfg: Record<string, unknown>) => key === "cricket" && cfg.ballsPerInnings === null;

function expectWalkover(key: string, cfg: Record<string, unknown>, stage = "league") {
  const [home, away] = walkoverDeltas(key, cfg, stage);
  const want = EXPECTED_WALKOVER[key]!(cfg);
  expect(home.metrics, `${key} winner`).toMatchObject(want.winner);
  expect(away.metrics, `${key} loser`).toMatchObject(want.loser);
  expect([home.won, home.lost, away.won, away.lost], key).toEqual([1, 0, 0, 1]);
}

describe("X-WO-1: walkover credit per sport, from the stage's own cfg (spec §5.2)", () => {
  it("X-WO-1: every declared cfg of every sport credits the Appendix A walkover, the winner gets the sport's win points", () => {
    let checked = 0;
    let unlimited = 0;
    forEachSport(({ module: m }) => {
      expect(EXPECTED_WALKOVER[m.key], `${m.key}: no Appendix A walkover rule`).toBeDefined();
      for (const { name, cfg } of declaredCfgs(m as never)) {
        // PF-6: unlimited-overs cricket has no quota to charge — its own test (CK-WO-2) below.
        if (unlimitedOvers(m.key, cfg as Record<string, unknown>)) { unlimited++; continue; }
        const [home, away] = walkoverDeltas(m.key, cfg);
        const want = EXPECTED_WALKOVER[m.key]!(cfg as Record<string, unknown>);
        expect(home.metrics, `${m.key}/${name} winner`).toMatchObject(want.winner);
        expect(away.metrics, `${m.key}/${name} loser`).toMatchObject(want.loser);
        expect([home.won, home.lost, away.won, away.lost], `${m.key}/${name}`).toEqual([1, 0, 0, 1]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(11);
    expect(unlimited, "the Test variant is the one unlimited cfg").toBeGreaterThanOrEqual(1);
  });
  it("FB-WO-1: football walkover = 3-0 (awardScore), not the played 0-0", () => expectWalkover("football", parsed("football")));
  it("HK-WO-1: hockey's default walkover is 5-0, not the old 3-0", () => {
    expect(walkoverDeltas("hockey", parsed("hockey"))[0].metrics).toMatchObject({ gf: 5, ga: 0 });
    expectWalkover("hockey", parsed("hockey"));
  });
  it("Review Focus 3: a hockey cfg frozen before W2b (awardScore 3) keeps its 3-0", () => {
    expect(walkoverDeltas("hockey", parsed("hockey", { awardScore: { goals: 3 } }))[0].metrics).toMatchObject({ gf: 3, ga: 0 });
  });
  it("IH-WO-1: ice hockey walkover = 5-0", () => expectWalkover("icehockey", parsed("icehockey")));
  it("VB-WO-1: 3-set volleyball credits 2-0 sets, not the played 0-0", () => {
    expect(walkoverDeltas("volleyball", parsed("volleyball", { bestOf: 3 }))[0].metrics).toMatchObject({ sets_won: 2, sets_lost: 0 });
    expectWalkover("volleyball", parsed("volleyball"));
  });
  it("TT-WO-1: table tennis walkover = the games needed to win, each 11-0", () => expectWalkover("tabletennis", parsed("tabletennis")));
  it("TN-WO-1: tennis walkover = straight sets, the match's games out of game %", () => expectWalkover("tennis", parsed("tennis")));
  it("BD-WO-1: badminton walkover = 2-0 games, each 21-0", () => expectWalkover("badminton", parsed("badminton")));
  it("BD-WO-2: a badminton GROUP stage walkover credits 2-0 × 21-0 (deviation from GCR 16.2.5 until W5)", () =>
    expectWalkover("badminton", parsed("badminton"), "group"));
  it("CK-WO-1: cricket walkover = full points; the defaulter charged its full quota at 0 runs; the winner's NRR untouched", () => {
    expectWalkover("cricket", parsed("cricket"));
    const [home] = walkoverDeltas("cricket", parsed("cricket"));
    expect(home.points).toBe((parsed("cricket").points as { win: number }).win);
  });
  it("CK-WO-1: a two-innings limited-overs match charges the defaulter BOTH innings' balls", () => {
    // Every declared limited-overs cfg is one innings a side, where × and ÷ by inningsPerSide agree; this one is not.
    const cfg = parsed("cricket", { inningsPerSide: 2, ballsPerInnings: 60, superOver: false });
    expect([cfg.inningsPerSide, cfg.ballsPerInnings]).toEqual([2, 60]);
    expectWalkover("cricket", cfg);
    const [, away] = walkoverDeltas("cricket", cfg);
    expect(away.metrics.balls_faced_eff).toBe(120);
  });
  it("BG-WO-1: chess walkover = 1-0, out of colour history", () => {
    expectWalkover("boardgame", parsed("boardgame"));
    // With the arbiter's pairing card recorded (H has White), the colours still do not move: nobody sat at the board.
    const [home, away] = deltasOf("boardgame", parsed("boardgame"), [["boardgame.pairing", { white: H }], ["core.forfeit", { by: A, reason: "walkover" }]]);
    expect([home.metrics, away.metrics]).toEqual([{ wins: 1, white: 0, black: 0 }, { wins: 0, white: 0, black: 0 }]);
  });
  it("CA-WO-1: carrom walkover = the games needed to win, each 25-0", () => expectWalkover("carrom", parsed("carrom")));
  it("GN-WO-1: generic walkover = win points, 0-0", () => {
    expectWalkover("generic", parsed("generic"));
    const cfg = parsed("generic") as { points: { w: number; l: number } };
    const [home, away] = walkoverDeltas("generic", cfg);
    expect([home.points, away.points]).toEqual([cfg.points.w, cfg.points.l]);
    // generic's tally has no start gate, so a press can precede core.start and the phase stays "pre" (a walkover is
    // still recordable). The walkover is still 0-0: a tally is not a played score until the match starts.
    const [h2, a2] = deltasOf("generic", cfg, [["generic.score", { by: A, points: 2 }], ["core.forfeit", { by: A, reason: "walkover" }]]);
    expect([h2.metrics, a2.metrics]).toEqual([{ for: 0, against: 0, diff: 0 }, { for: 0, against: 0, diff: 0 }]);
  });
  it("CK-WO-2 (PF-6): unlimited-overs cricket — the result and its points only; no runs, no overs, out of NRR", () => {
    let checked = 0;
    for (const { name, cfg } of declaredCfgs(mod("cricket") as never)) {
      const c = cfg as Record<string, unknown>;
      if (!unlimitedOvers("cricket", c)) continue;
      const [home, away] = walkoverDeltas("cricket", c);
      const zero = { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 };
      expect(home.metrics, name).toMatchObject(zero);
      expect(away.metrics, name).toMatchObject(zero);
      expect([home.won, away.lost, home.points], name).toEqual([1, 1, (c.points as { win: number }).win]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Retirement (X-RT-1). H retires (or is disqualified) after play started; A is credited. Each row's expectation is
// the Appendix A rule applied to the played numbers of its own prefix, both written out.
// ---------------------------------------------------------------------------

/** FB-RT-1 / HK-RT-1 / IH-RT-1: the awarded score, or the real one when its margin is worse for the offender. */
const goalRule = (awarded: number, real: { winner: number; offender: number }) =>
  real.winner - real.offender > awarded ? real : { winner: awarded, offender: 0 };
const goals = (gf: number, ga: number) => ({ gf, ga, gd: gf - ga });
const times = (n: number, item: [string, unknown]): Spec => Array.from({ length: n }, () => item);
/** Alternate H/A rallies `pairs` times, then `extra` in a row to one side — a set at a score written in the call. */
const rallies = (type: string, pairs: number, extraBy: string, extra: number): Spec => [
  ...Array.from({ length: pairs }, (): Spec => [[type, { wonBy: H }], [type, { wonBy: A }]]).flat(),
  ...times(extra, [type, { wonBy: extraBy }]),
];
const board = (winner: string, coins: number): [string, unknown] => ["carrom.board.summary", { winner, opponentCoinsLeft: coins, queenTo: null }];

interface RetirementRow {
  id: string;
  key: string;
  cfg: Record<string, unknown>;
  /** The played prefix, after core.start. */
  played: Spec;
  /** [retiree H, winner A] metrics, from the rule. */
  want: (c: Record<string, unknown>) => [Metrics, Metrics];
}
const ROWS: RetirementRow[] = [
  {
    id: "FB-RT-1 (0-5: the real score is worse for the offender, it stands)", key: "football", cfg: parsed("football"),
    played: times(5, ["football.goal", { by: A }]),
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 5, offender: 0 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    // The boundary, written out literally: 1-4 is a margin of 3, the awarded margin — not WORSE for the offender, so
    // the awarded 0-3 stands (not the real 1-4).
    id: "FB-RT-1 (1-4: an equal margin takes the awarded 0-3)", key: "football", cfg: parsed("football"),
    played: [["football.goal", { by: H }], ...times(4, ["football.goal", { by: A }])],
    want: () => [goals(0, 3), goals(3, 0)],
  },
  {
    id: "FB-RT-1 (1-0 to the offender: the awarded 0-3)", key: "football", cfg: parsed("football"),
    played: [["football.goal", { by: H }]],
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 0, offender: 1 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    id: "HK-RT-1 (0-7: the real score)", key: "hockey", cfg: parsed("hockey"),
    played: times(7, ["hockey.goal", { by: A }]),
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 7, offender: 0 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    id: "HK-RT-1 (1-0 to the offender: the awarded 0-5)", key: "hockey", cfg: parsed("hockey"),
    played: [["hockey.goal", { by: H }]],
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 0, offender: 1 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    id: "IH-RT-1 (0-7: the real score)", key: "icehockey", cfg: parsed("icehockey"),
    played: times(7, ["icehockey.goal", { by: A }]),
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 7, offender: 0 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    id: "IH-RT-1 (1-0 to the offender: the awarded 0-5)", key: "icehockey", cfg: parsed("icehockey"),
    played: [["icehockey.goal", { by: H }]],
    want: (c) => { const r = goalRule((c.awardScore as { goals: number }).goals, { winner: 0, offender: 1 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
  },
  {
    // Set 1 to the retiree 25-20, set 2 at 10-12 (A leading). A completes set 2 to max(setTo, 10 + winBy) and takes
    // every further set it needs at setTo-0; the retiree keeps set 1 and its 25 + 10 points.
    id: "VB-RT-1", key: "volleyball", cfg: parsed("volleyball"),
    played: [...rallies("volleyball.rally", 20, H, 5), ...rallies("volleyball.rally", 10, A, 2)],
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      const further = need - 1; // A owns set 2 once completed
      const aPts = 20 + Math.max(c.setTo as number, 10 + (c.winBy as number)) + further * (c.setTo as number);
      const hPts = 25 + 10;
      return [
        { sets_won: 1, sets_lost: need, points_won: hPts, points_lost: aPts },
        { sets_won: need, sets_lost: 1, points_won: aPts, points_lost: hPts },
      ];
    },
  },
  {
    // M-7 (FIVB 6.4.3, VB-RT-1): the retiree leads 2-1 (25-20, 20-25, 25-20) and retires early in set 4 at 2-1. A
    // completes set 4 to max(setTo, 2 + winBy) and is given the deciding set at ITS target, finalSetTo-0 — not setTo.
    id: "VB-RT-1 (2-1 to the retiree: the deciding set at finalSetTo)", key: "volleyball", cfg: parsed("volleyball"),
    played: [
      ...rallies("volleyball.rally", 20, H, 5),
      ...rallies("volleyball.rally", 20, A, 5),
      ...rallies("volleyball.rally", 20, H, 5),
      ...rallies("volleyball.rally", 1, H, 1),
    ],
    want: (c) => {
      expect([c.bestOf, c.finalSetTo === c.setTo], "a best-of-5 whose deciding set has its own target").toEqual([5, false]);
      const aPts = 20 + 25 + 20 + Math.max(c.setTo as number, 2 + (c.winBy as number)) + (c.finalSetTo as number);
      const hPts = 25 + 20 + 25 + 2;
      return [
        { sets_won: 2, sets_lost: 3, points_won: hPts, points_lost: aPts },
        { sets_won: 3, sets_lost: 2, points_won: aPts, points_lost: hPts },
      ];
    },
  },
  {
    // One game each (H 11-7, A 11-6), the third at 5-3 to the retiree: A completes it at max(setTo, 5 + winBy), the rest
    // at setTo-0; every point played stands.
    id: "TT-RT-1 (third game 5-3 to the retiree)", key: "tabletennis", cfg: parsed("tabletennis"),
    played: [...rallies("tabletennis.rally", 7, H, 4), ...rallies("tabletennis.rally", 6, A, 5), ...rallies("tabletennis.rally", 3, H, 2)],
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      const won = 2; // game 2, then game 3 completed
      const aPts = 7 + 11 + Math.max(c.setTo as number, 5 + (c.winBy as number)) + (need - won) * (c.setTo as number);
      const hPts = 11 + 6 + 5;
      return [
        { sets_won: 1, sets_lost: need, points_won: hPts, points_lost: aPts },
        { sets_won: need, sets_lost: 1, points_won: aPts, points_lost: hPts },
      ];
    },
  },
  {
    // Deuce: the first game at 10-10 — completing it needs 10 + winBy, more than setTo.
    id: "TT-RT-1 (deuce: the current game completes at the retiree + 2, not at setTo)", key: "tabletennis", cfg: parsed("tabletennis"),
    played: rallies("tabletennis.rally", 10, A, 0),
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      const aPts = Math.max(c.setTo as number, 10 + (c.winBy as number)) + (need - 1) * (c.setTo as number);
      return [
        { sets_won: 0, sets_lost: need, points_won: 10, points_lost: aPts },
        { sets_won: need, sets_lost: 0, points_won: aPts, points_lost: 10 },
      ];
    },
  },
  {
    // One game each (H 21-15, A 21-18), the third at 5-3 to the retiree: A completes it at max(setTo, 5 + winBy).
    id: "BD-RT-1", key: "badminton", cfg: parsed("badminton"),
    played: [...rallies("badminton.rally", 15, H, 6), ...rallies("badminton.rally", 18, A, 3), ...rallies("badminton.rally", 3, H, 2)],
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      const aPts = 15 + 21 + Math.max(c.setTo as number, 5 + (c.winBy as number)) + (need - 2) * (c.setTo as number);
      const hPts = 21 + 18 + 5;
      return [
        { sets_won: 1, sets_lost: need, points_won: hPts, points_lost: aPts },
        { sets_won: need, sets_lost: 1, points_won: aPts, points_lost: hPts },
      ];
    },
  },
  {
    // Any partial: H holds the first game. TN-RT-1 = TN-WO-1 — straight sets, no games credited.
    id: "TN-RT-1", key: "tennis", cfg: parsed("tennis"),
    played: times(4, ["tennis.point", { by: H }]),
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      return [
        { sets_won: 0, sets_lost: need, games_won: 0, games_lost: 0 },
        { sets_won: need, sets_lost: 0, games_won: 0, games_lost: 0 },
      ];
    },
  },
  {
    // Game 1 to the retiree 25-10 (A 9 + 1, then H 9 + 9 + 7); game 2 at A 12 (9 + 3), H 8. A completes game 2 at
    // gameTo against H's 8, then every further game it needs at gameTo-0; completed games stand.
    id: "CA-RT-1", key: "carrom", cfg: parsed("carrom"),
    played: [board(A, 9), board(A, 1), board(H, 9), board(H, 9), board(H, 7), board(A, 9), board(A, 3), board(H, 8)],
    want: (c) => {
      const need = Math.ceil((c.bestOf as number) / 2);
      const aPts = 10 + (c.gameTo as number) + (need - 1) * (c.gameTo as number);
      const hPts = 25 + 8;
      return [
        { sets_won: 1, sets_lost: need, points_won: hPts, points_lost: aPts },
        { sets_won: need, sets_lost: 1, points_won: aPts, points_lost: hPts },
      ];
    },
  },
  {
    // A recorded 3-1 to the retiree: the winner gets the win points; the recorded score is kept.
    id: "GN-RT-1", key: "generic", cfg: parsed("generic"),
    played: [["generic.score", { by: H, points: 3 }], ["generic.score", { by: A, points: 1 }]],
    want: () => [{ for: 3, against: 1, diff: 2 }, { for: 1, against: 3, diff: -2 }],
  },
  {
    // CK-WO-1 "incl. refusal to continue": a retirement is the walkover credit, whatever was played.
    id: "CK-WO-1 (refusal to continue)", key: "cricket", cfg: parsed("cricket"),
    played: [["cricket.innings.summary", { runs: 40, wickets: 1, legalBalls: 30, partial: true }]],
    want: (c) => {
      const q = (c.ballsPerInnings as number) * (c.inningsPerSide as number);
      return [
        { runs_for: 0, balls_faced_eff: q, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 },
        { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 },
      ];
    },
  },
  {
    // BG-WO-1 "walkover or post-start forfeit = 1-0", out of colour history.
    id: "BG-WO-1 (post-start)", key: "boardgame", cfg: parsed("boardgame"),
    // the pairing card gives H White, so a colour credit would show here
    played: [["boardgame.pairing", { white: H }]],
    want: () => [{ wins: 0, white: 0, black: 0 }, { wins: 1, white: 0, black: 0 }],
  },
];
const row = (id: string) => {
  const r = ROWS.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
function retirementDeltas(r: RetirementRow, reason: string) {
  return deltasOf(r.key, r.cfg, [["core.start"], ...r.played, ["core.forfeit", { by: H, reason }]]);
}
function expectRetirement(r: RetirementRow, reason = "retired") {
  const [home, away] = retirementDeltas(r, reason);
  const [wantH, wantA] = r.want(r.cfg);
  expect(home.metrics, `${r.id} ${reason} retiree`).toMatchObject(wantH);
  expect(away.metrics, `${r.id} ${reason} winner`).toMatchObject(wantA);
  expect([home.won, home.lost, away.won, away.lost], `${r.id} ${reason}`).toEqual([0, 1, 1, 0]);
}

describe("X-RT-1: retirement credit per sport (spec §5.2)", () => {
  it("empty case first: every row's played prefix folds undecided — the forfeit is what decides it", () => {
    let checked = 0;
    for (const r of ROWS) {
      const m = mod(r.key);
      const f = foldMatchWithStoppage(m as never, r.cfg as never, defaultLineupPair(m.positions), [["core.start"], ...r.played].map(([t, p], i) => ev(i + 1, t, p ?? {})));
      expect(outcomeOf(m as never, f as never), r.id).toBeNull();
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    expect(new Set(ROWS.map((r) => r.key)).size, "every sport has a retirement row").toBe(11);
  });
  it("FB-RT-1: football retirement = 3-0, or the real score when it is worse for the offender", () => {
    expectRetirement(row("FB-RT-1 (0-5: the real score is worse for the offender, it stands)"));
    expectRetirement(row("FB-RT-1 (1-0 to the offender: the awarded 0-3)"));
    expectRetirement(row("FB-RT-1 (1-4: an equal margin takes the awarded 0-3)"));
  });
  it("HK-RT-1: hockey retirement = 5-0, or the real score when it is worse for the offender", () => {
    expectRetirement(row("HK-RT-1 (0-7: the real score)"));
    expectRetirement(row("HK-RT-1 (1-0 to the offender: the awarded 0-5)"));
  });
  it("IH-RT-1: ice hockey retirement = 5-0, or the real score when it is worse for the offender", () => {
    expectRetirement(row("IH-RT-1 (0-7: the real score)"));
    expectRetirement(row("IH-RT-1 (1-0 to the offender: the awarded 0-5)"));
  });
  it("VB-RT-1: volleyball retirement — the winner gets the sets and points it needed, the retiree keeps its own", () => expectRetirement(row("VB-RT-1")));
  it("VB-RT-1 (M-7): a deciding set the retiree never reached is credited at its own target, FIVB 6.4.3", () =>
    expectRetirement(row("VB-RT-1 (2-1 to the retiree: the deciding set at finalSetTo)")));
  it("TT-RT-1: table tennis retirement — points stand, the current game completes for the winner, the rest 11-0", () => {
    expectRetirement(row("TT-RT-1 (third game 5-3 to the retiree)"));
    expectRetirement(row("TT-RT-1 (deuce: the current game completes at the retiree + 2, not at setTo)"));
  });
  it("BD-RT-1: badminton retirement — points stand, the current game completes to 21, the rest 21-0", () => expectRetirement(row("BD-RT-1")));
  it("TN-RT-1: tennis retirement — the same credit as TN-WO-1", () => expectRetirement(row("TN-RT-1")));
  it("CA-RT-1: carrom retirement — completed games stand, the unfinished one 25-(opponent), the rest 25-0", () => expectRetirement(row("CA-RT-1")));
  it("GN-RT-1: generic retirement — walkover credit, keeping the recorded score", () => {
    expectRetirement(row("GN-RT-1"));
    const cfg = row("GN-RT-1").cfg as { points: { w: number; l: number } };
    const [home, away] = retirementDeltas(row("GN-RT-1"), "retired");
    expect([home.points, away.points]).toEqual([cfg.points.l, cfg.points.w]);
  });
  it("CK-WO-1: a cricket retirement (refusal to continue) is the walkover credit — the played runs are not credited", () =>
    expectRetirement(row("CK-WO-1 (refusal to continue)")));
  it("BG-WO-1: a chess forfeit after the game starts = 1-0, out of colour history", () => expectRetirement(row("BG-WO-1 (post-start)")));
  it("X-RT-1: in-match disqualification takes the sport's retirement credit — every row, every sport", () => {
    let checked = 0;
    for (const r of ROWS) {
      expectRetirement(r, "disqualified");
      expect(retirementDeltas(r, "disqualified"), r.id).toEqual(retirementDeltas(r, "retired"));
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
  it("X-WD-6 (PF-7): withdrew before start credits the walkover, after start the retirement — every sport", () => {
    let before = 0;
    let after = 0;
    forEachSport(({ module: m }) => {
      const cfg = parsed(m.key);
      const [home, away] = deltasOf(m.key, cfg, [["core.forfeit", { by: A, reason: "withdrew" }]]);
      const want = EXPECTED_WALKOVER[m.key]!(cfg);
      expect(home.metrics, `${m.key} withdrew pre-start winner`).toMatchObject(want.winner);
      expect(away.metrics, `${m.key} withdrew pre-start loser`).toMatchObject(want.loser);
      before++;
    });
    for (const r of ROWS) {
      expectRetirement(r, "withdrew");
      after++;
    }
    expect(before).toBe(11);
    expect(after).toBe(ROWS.length);
  });
});

describe("X-WO-1: one credited score — the goal sports' headline shows it (spec §5.2)", () => {
  it("X-WO-1: football, hockey and ice hockey headlines read the credited score for a walkover and a retirement", () => {
    let checked = 0;
    for (const [key, goalType] of [["football", "football.goal"], ["hockey", "hockey.goal"], ["icehockey", "icehockey.goal"]] as const) {
      const m = mod(key);
      const cfg = parsed(key);
      const g = (cfg.awardScore as { goals: number }).goals;
      const l = defaultLineupPair(m.positions);
      const wo = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: A, reason: "walkover" })]);
      expect(m.summary(wo.state as never).headline.startsWith(`${g} — 0`), `${key} walkover`).toBe(true);
      // the other side: the away winner's credited goals, where the real away tally is 0
      const woHome = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: H, reason: "walkover" })]);
      expect(m.summary(woHome.state as never).headline.startsWith(`0 — ${g}`), `${key} walkover by home`).toBe(true);
      const rt =foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), ...Array.from({ length: g + 2 }, (_, i) => ev(i + 2, goalType, { by: A })), ev(g + 4, "core.forfeit", { by: H, reason: "retired" })]);
      expect(m.summary(rt.state as never).headline.startsWith(`0 — ${g + 2}`), `${key} retirement keeps the worse real score`).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("BG-WO-1: a chess forfeit's headline reads the credited 1-0, before and after the start (FIDE Laws 6.7.1)", () => {
    // Before W2b a chess forfeit folded to `win{method:"forfeit"}` and the headline showed the 1-0; W2b unified it on
    // `award`, which must read the same.
    const m = mod("boardgame");
    const cfg = parsed("boardgame");
    const l = defaultLineupPair(m.positions);
    const wo = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: H, reason: "walkover" })]);
    expect(m.summary(wo.state as never).headline, "walkover by H").toBe("0 — 1");
    const rt = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), ev(2, "core.forfeit", { by: A, reason: "retired" })]);
    expect(m.summary(rt.state as never).headline, "retirement by A").toBe("1 — 0");
    const dw = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: "both", reason: "walkover" })]);
    expect(m.summary(dw.state as never).headline, "double walkover: nobody scores").toBe("0 — 0");
  });
});

describe("M-4: an award arm seats its offender from the award's typed `loser`, never as \"whoever is not the winner\"", () => {
  it("every sport: the typed loser is the offender; a loser who is no seat of the fixture, or the winner's own, is refused", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = parsed(m.key);
      const l = defaultLineupPair(m.positions);
      const state = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: A, reason: "walkover" })]).state;
      const delta = (outcome: unknown) => m.standingsDelta(outcome as never, cfg, { kind: "league" } as never, state);
      // positive pair: the typed loser A is the seat that lost
      const [home, away] = delta({ kind: "award", winner: H, loser: A, reason: "walkover" });
      expect([home.entrantId, home.won, away.entrantId, away.lost], m.key).toEqual([H, 1, A, 1]);
      // a bye has no loser: the seat that is not the winner's (C-5)
      const bye = delta({ kind: "award", winner: H, loser: null, reason: "bye" });
      expect(bye.map((d) => d.entrantId), `${m.key} bye seats`).toEqual([H, A]);
      expect(bye.map((d) => d.won), `${m.key} bye`).toEqual([1, 0]);
      expect(() => delta({ kind: "award", winner: H, loser: "Z", reason: "walkover" }), `${m.key} stranger`).toThrow();
      expect(() => delta({ kind: "award", winner: H, loser: H, reason: "walkover" }), `${m.key} winner as loser`).toThrow(/loser/);
      checked++;
    });
    expect(checked).toBe(11);
  });
});

/** PF-1 rows: a level result per level-capable sport, then H withdraws (so A wins, reason withdrew). The credit is the
 *  sport's RETIREMENT credit (orchestrator ruling on review I-1, under X-WO-1's one-score rule), written from Appendix
 *  A — never read back from forfeitCredit — and the headline must read that same credit. */
interface Pf1Row {
  id: string;
  key: string;
  cfg: Record<string, unknown>;
  level: Spec;
  /** [withdrawer H, winner A] table metrics, from the rule. */
  table: (c: Record<string, unknown>) => [Metrics, Metrics];
  /** The headline's credited-score prefix, from the rule; `null` ⇒ the sport's headline is its scorecard (cricket). */
  headline: (c: Record<string, unknown>) => string | null;
}
const awarded = (c: Record<string, unknown>) => (c.awardScore as { goals: number }).goals;
const PF1: Pf1Row[] = [
  {
    // 1-1 at full time. FB-RT-1: a margin of 0 is not worse for the withdrawer than the awarded 3-0, so 0-3.
    id: "FB-RT-1", key: "football", cfg: parsed("football"),
    level: [["core.start"], ["football.goal", { by: H }], ["football.goal", { by: A }], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }]],
    table: (c) => { const r = goalRule(awarded(c), { winner: 1, offender: 1 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
    headline: (c) => { const r = goalRule(awarded(c), { winner: 1, offender: 1 }); return `${r.offender} — ${r.winner}`; },
  },
  {
    // 1-1 after four quarters. HK-RT-1: the awarded 0-5.
    id: "HK-RT-1", key: "hockey", cfg: parsed("hockey"),
    level: [["core.start"], ["hockey.goal", { by: H }], ["hockey.goal", { by: A }], ...["Q2", "Q3", "Q4", "FT"].map((to): [string, unknown] => ["hockey.period.advance", { to }])],
    table: (c) => { const r = goalRule(awarded(c), { winner: 1, offender: 1 }); return [goals(r.offender, r.winner), goals(r.winner, r.offender)]; },
    headline: (c) => { const r = goalRule(awarded(c), { winner: 1, offender: 1 }); return `${r.offender} — ${r.winner}`; },
  },
  {
    // A drawn game. BG-WO-1: a post-start forfeit is 1-0 to the opponent, out of colour history.
    id: "BG-WO-1", key: "boardgame", cfg: parsed("boardgame"),
    level: [["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]],
    table: () => [{ wins: 0, white: 0, black: 0 }, { wins: 1, white: 0, black: 0 }],
    headline: () => "0 — 1",
  },
  {
    // A 2-2 result card. GN-RT-1: the winner's points, the recorded score kept — so the headline still reads 2 — 2.
    id: "GN-RT-1", key: "generic", cfg: parsed("generic", { resultMode: "score", allowDraws: true }),
    level: [["core.start"], ["generic.result", { p1Score: 2, p2Score: 2 }]],
    table: () => [{ for: 2, against: 2, diff: 0 }, { for: 2, against: 2, diff: 0 }],
    headline: () => "2 — 2",
  },
  {
    // A tie: 150/4 off 120 balls, then 150 all out. CK-WO-1 (the cricket retirement row): none of what was played is
    // credited, the withdrawer is charged its full quota at 0 runs. A cricket headline is the scorecard — there is no
    // credited score to show — so it reads exactly what a retirement over the same innings reads.
    id: "CK-WO-1", key: "cricket", cfg: parsed("cricket", { superOver: false }),
    level: [["core.start"], ["cricket.innings.summary", { runs: 150, wickets: 4, legalBalls: 120 }], ["cricket.innings.summary", { runs: 150, wickets: 10, legalBalls: 100 }]],
    table: (c) => [
      { runs_for: 0, balls_faced_eff: (c.ballsPerInnings as number) * (c.inningsPerSide as number), runs_against: 0, balls_bowled_eff: 0, run_diff: 0 },
      { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0, run_diff: 0 },
    ],
    headline: () => null,
  },
];

describe("PF-1 / X-WO-1: a withdrawal over a held level result — the headline reads the table's credit (review I-1)", () => {
  const foldOf = (r: Pf1Row, spec: Spec) => {
    const m = mod(r.key);
    return { m, f: foldMatchWithStoppage(m as never, r.cfg as never, defaultLineupPair(m.positions), spec.map(([t, p], i) => ev(i + 1, t, p ?? {}))) };
  };

  it("empty case first: every row's level prefix is held level, and its headline is the played one", () => {
    let checked = 0;
    for (const r of PF1) {
      const { m, f } = foldOf(r, r.level);
      expect(["draw", "tie"], r.id).toContain(outcomeOf(m as never, f as never)?.kind);
      expect(summaryOf(m as never, f as never), r.id).toEqual(m.summary(f.state as never));
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("each level-capable sport: the table credits the retirement, and the headline reads the same credit", () => {
    let checked = 0;
    let moved = 0;
    for (const r of PF1) {
      const { m, f: plain } = foldOf(r, r.level);
      const { f } = foldOf(r, [...r.level, ["core.forfeit", { by: H, reason: "withdrew" }]]);
      const o = outcomeOf(m as never, f as never);
      expect(o, r.id).toEqual({ kind: "award", winner: A, loser: H, reason: "withdrew" });
      const [home, away] = m.standingsDelta(o!, r.cfg, { kind: "league" } as never, f.state);
      const [wantH, wantA] = r.table(r.cfg);
      expect([home.metrics, away.metrics], `${r.id} table`).toMatchObject([wantH, wantA]);
      expect([home.won, home.lost, away.won, away.lost], `${r.id} W/L`).toEqual([0, 1, 1, 0]);
      const want = r.headline(r.cfg) ?? m.summary(plain.state).headline;
      const got = summaryOf(m as never, f as never).headline;
      expect(got.startsWith(want), `${r.id} headline ${JSON.stringify(got)} reads ${want}`).toBe(true);
      if (got !== m.summary(plain.state).headline) moved++;
      checked++;
    }
    expect(checked).toBe(5);
    // the goal sports and chess show a credited score the played level result did not
    expect(moved).toBe(3);
  });

  it("no withdrawal, no overlay: a plain retirement's summary is the module's own", () => {
    const r = PF1[0]!;
    const { m, f } = foldOf(r, [["core.start"], ["football.goal", { by: H }], ["core.forfeit", { by: H, reason: "retired" }]]);
    expect(summaryOf(m as never, f as never)).toEqual(m.summary(f.state as never));
  });

  it("the overlay's premise: every sport keeps its decision in `state.outcome`, before and after it is decided", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const cfg = parsed(m.key);
      const l = defaultLineupPair(m.positions);
      const init = m.init(cfg, l) as Record<string, unknown>;
      expect(Object.hasOwn(init, "outcome") && m.outcome(init as never) === init.outcome, `${m.key} init`).toBe(true);
      const done = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.forfeit", { by: A, reason: "walkover" })]).state as Record<string, unknown>;
      expect(m.outcome(done as never), m.key).toEqual(done.outcome);
      expect(done.outcome, m.key).toMatchObject({ kind: "award", loser: A });
      checked++;
    });
    expect(checked).toBe(11);
  });

  it("guard: an overlay asked of a state with no `outcome` field is a named refusal, not a silent pass-through", () => {
    const fake = { summary: () => ({ headline: "x", perSide: [] }), outcome: () => ({ kind: "draw" as const }) };
    expect(() => summaryOf(fake as never, { state: { phase: "done" }, settlement: null, levelWithdrawal: { winner: A, loser: H, eventId: "e-9" } })).toThrow(
      /summaryOf: the module's state has no `outcome` field/,
    );
  });
});

describe("X-RS-1: every arbitraryEvent forfeit is one the phase guard admits (spec §5.1 D3)", () => {
  it("X-RS-1: 200 seeds per sport fold strictly with zero refusals, and the generators do emit forfeits", () => {
    let streams = 0;
    let forfeits = 0;
    const perSport: Record<string, number> = {};
    forEachSport(({ module: m }) => {
      const cfg = parsed(m.key);
      const l = defaultLineupPair(m.positions);
      perSport[m.key] = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const events = buildStream(m as never, cfg as never, l, seed, 300);
        foldMatchWithStoppage(m as never, cfg as never, l, events); // strict: throws on any refusal
        const n = events.filter((e) => e.type === "core.forfeit").length;
        forfeits += n;
        perSport[m.key]! += n;
        streams++;
      }
    });
    expect(streams).toBe(11 * 200);
    for (const [key, n] of Object.entries(perSport)) expect(n, `${key} emitted no forfeit in 200 seeds`).toBeGreaterThan(0);
    expect(forfeits).toBeGreaterThan(0);
  });

  it("X-RS-1 breadth: in play the generators draw every in-match reason, against either side — every sport", () => {
    // From the rule, not the generator: once play starts a match can end in a retirement or a disqualification
    // (X-RT-1, X-DQ-1), and in a walkover only where the module declares that phase (`walkoverPhases`; chess, FIDE
    // Laws 6.7.1). A withdrawal is the competition layer's cascade (X-WD-1), never one fixture's random draw.
    let forfeits = 0;
    let sports = 0;
    forEachSport(({ module: m }) => {
      const cfg = parsed(m.key);
      const l = defaultLineupPair(m.positions);
      const reasons = new Set<string>();
      const offenders = new Set<string>();
      for (let seed = 1; seed <= 200; seed++) {
        const { events, states } = buildWalk(m as never, cfg as never, l, seed, 300);
        events.forEach((e, i) => {
          if (e.type !== "core.forfeit") return;
          const before = i === 0 ? m.init(cfg, l) : states[i - 1];
          const { by, reason } = e.payload as { by: string; reason: string };
          if (m.forfeitPhase(before as never) === "play") reasons.add(reason);
          offenders.add(by);
          forfeits++;
        });
      }
      const walkoverInPlay = (m.walkoverPhases ?? ["pre"]).includes("play");
      expect([...reasons].sort(), `${m.key}: the reasons drawn in play`).toEqual(["disqualified", "retired", ...(walkoverInPlay ? ["walkover"] : [])]);
      expect([...offenders].sort(), `${m.key}: the offenders drawn`).toEqual([A, H]);
      sports++;
    });
    expect(sports).toBe(11);
    expect(forfeits).toBeGreaterThan(11 * 3);
  });
});

// ---------------------------------------------------------------------------
// X-WO-1 — the table pays the points of the CREDITED score (W2b Task 15, the reference ↔ engine cross-check). "The
// same credited score is used in the table, tie-breaks, the public page and the qualification view": a sport whose
// table is a pointsMap by set score pays the pair its cfg declares for the CREDITED sets, never a clean sweep. FIVB
// 6.4.3 — an incomplete team keeps its sets — so an indoor retirement credited 3-2 pays the stage's 3-2 pair, and a
// walkover's 3-0 its 3-0 pair. Every expected pair is read from the cfg's own pointsMap — the exact "W-L" key, else
// "*" (the map's declared reading, spec 04 §3.3) — never from the kernel's lookup.
// ---------------------------------------------------------------------------
type Pair = readonly [number, number];
type PointsMap = Record<string, Pair>;
const pointsMapOf = (cfg: Record<string, unknown>): PointsMap | undefined => cfg.pointsMap as PointsMap | undefined;
/** The cfg's declared pair for a decided set score: exact "W-L", else "*"; undefined when it declares neither. */
const declaredPair = (map: PointsMap, w: number, l: number): Pair | undefined => map[`${w}-${l}`] ?? map["*"];
/** The module's own coarse set event (`coarseEventType`), so the sweep never types a sport's event name. */
const setSummaryType = (key: string) => `${key}.${(mod(key) as { coarseEventType?: string }).coarseEventType}`;
const otherSeat = (side: string) => (side === H ? A : H);
/** The [winner, loser] deltas of a [home, away] pair. */
const byResult = (winner: string, [home, away]: [StandingsDelta, StandingsDelta]): [StandingsDelta, StandingsDelta] => (winner === H ? [home, away] : [away, home]);
/** Swap the seats of a played prefix: rallies change hands, set summaries swap columns. */
const mirrored = (spec: Spec): Spec =>
  spec.map(([t, p]) => {
    const q = (p ?? {}) as Record<string, unknown>;
    if (typeof q.wonBy === "string") return [t, { ...q, wonBy: otherSeat(q.wonBy) }];
    if ("home" in q && "away" in q) return [t, { ...q, home: q.away, away: q.home }];
    return [t, p];
  });

describe("X-WO-1: an award pays the table points of its credited set score (VB-RT-1, FIVB 6.4.3)", () => {
  const indoor = parsed("volleyball"); // the schema default IS indoor (volleyball.ts `defaults`, variant `indoor: {}`)
  const fivb = pointsMapOf(indoor)!;
  const vbSet = (home: number, away: number): [string, unknown] => [setSummaryType("volleyball"), { home, away }];
  /** A at fault throughout; H takes the match. `credited` is the rule's set score: H gets the 3 sets it needs, A keeps
   *  every set it won (FIVB 6.4.3). */
  const INDOOR: Array<{ name: string; played: Spec; credited: [number, number] }> = [
    // the cross-check's own rows (W2b Task 15): 25-15, then 25-0 and 15-0 to H
    { name: "two sets up, the side at fault retires leading 15-10 in set 3", played: [vbSet(0, 25), vbSet(0, 25), ...rallies("volleyball.rally", 10, A, 5)], credited: [3, 2] },
    { name: "two sets all, the side at fault retires leading 15-14 in the deciding set", played: [vbSet(25, 0), vbSet(0, 25), vbSet(25, 0), vbSet(0, 25), ...rallies("volleyball.rally", 14, A, 1)], credited: [3, 2] },
    // a credited 3-1: no exact pair in the FIVB table, so its "*"
    { name: "one set up, the side at fault retires between sets", played: [vbSet(0, 25)], credited: [3, 1] },
  ];

  it("premise: indoor is best-of-5, and its declared 3-2 pair is not its 3-0 pair — so a clean sweep is witnessable", () => {
    expect([indoor.bestOf, indoor.setTo, indoor.finalSetTo]).toEqual([5, 25, 15]);
    // FIVB / CEV competition points: 3-0 and 3-1 pay 3/0, 3-2 pays 2/1 (volleyball.ts header)
    expect(declaredPair(fivb, 3, 2), "a 3-2 win").toEqual([2, 1]);
    expect(declaredPair(fivb, 3, 1), "a 3-1 win").toEqual([3, 0]);
    expect(declaredPair(fivb, 3, 0), "a 3-0 win").toEqual([3, 0]);
  });

  it("empty case first: a walkover (and a withdrawal before the start) credits 3-0 and pays the 3-0 pair — both seats", () => {
    let checked = 0;
    for (const atFault of [A, H]) {
      for (const reason of ["walkover", "withdrew"]) {
        const winner = otherSeat(atFault);
        const [w, l] = byResult(winner, deltasOf("volleyball", indoor, [["core.forfeit", { by: atFault, reason }]]));
        expect([w.metrics.sets_won, l.metrics.sets_won], `${reason} by ${atFault}: the credit`).toEqual([3, 0]);
        expect([w.points, l.points], `${reason} by ${atFault}`).toEqual([...declaredPair(fivb, 3, 0)!]);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("VB-RT-1: a retirement, disqualification or post-start withdrawal pays the credited score's pair (3-2 ⇒ 2/1, not 3/0) — both seats", () => {
    let checked = 0;
    let witnessed = 0;
    for (const c of INDOOR) {
      for (const [atFault, played] of [[A, c.played], [H, mirrored(c.played)]] as const) {
        const winner = otherSeat(atFault);
        for (const reason of ["retired", "disqualified", "withdrew"]) {
          const tag = `${c.name} · ${reason} by ${atFault}`;
          const [w, l] = byResult(winner, deltasOf("volleyball", indoor, [["core.start"], ...played, ["core.forfeit", { by: atFault, reason }]]));
          expect([w.metrics.sets_won, l.metrics.sets_won], `${tag}: the credit`).toEqual(c.credited);
          const want = declaredPair(fivb, ...c.credited)!;
          expect([w.points, l.points], tag).toEqual([...want]);
          expect([w.won, l.lost], tag).toEqual([1, 1]);
          if (JSON.stringify(want) !== JSON.stringify(declaredPair(fivb, 3, 0))) witnessed++;
          checked++;
        }
      }
    }
    expect(checked).toBe(INDOOR.length * 2 * 3);
    expect(witnessed, "the 3-2 cases, where the right pair is not the clean sweep").toBe(2 * 2 * 3);
  });

  it("a voided retirement, then a disqualification: the forfeit recorded after the void is the one paid", () => {
    const m = mod("volleyball");
    const c = INDOOR[0]!;
    const before = [["core.start"], ...c.played] as Spec;
    const evs = before.map(([t, p], i) => ev(i + 1, t, p ?? {}));
    const n = evs.length + 1;
    evs.push(ev(n, "core.forfeit", { by: A, reason: "retired" }));
    evs.push(makeEnvelope(n + 1, { type: "core.void", payload: {} }, `e-${n}`));
    // premise: the void reopens the match
    const reopened = foldMatchWithStoppage(m as never, indoor as never, defaultLineupPair(m.positions), evs);
    expect(outcomeOf(m as never, reopened as never)).toBeNull();
    evs.push(ev(n + 2, "core.forfeit", { by: A, reason: "disqualified" }));
    const f = foldMatchWithStoppage(m as never, indoor as never, defaultLineupPair(m.positions), evs);
    const o = outcomeOf(m as never, f as never);
    expect(o).toEqual({ kind: "award", winner: H, loser: A, reason: "disqualified" });
    const [home, away] = m.standingsDelta(o!, indoor, { kind: "league" } as never, f.state);
    expect([home.metrics.sets_won, away.metrics.sets_won]).toEqual(c.credited);
    expect([home.points, away.points]).toEqual([...declaredPair(fivb, ...c.credited)!]);
  });

  it("a bye credits no score, so it keeps today's delta (C-5): the clean-sweep pair, here the 3-0 pair", () => {
    const m = mod("volleyball");
    const state = m.init(indoor, { home: { entrantId: H, slots: [] }, away: { entrantId: "__bye__", slots: [] } });
    const [home, away] = m.standingsDelta({ kind: "award", winner: H, loser: null, reason: "bye" } as never, indoor, { kind: "swiss" } as never, state);
    expect([home.points, away.points]).toEqual([...declaredPair(fivb, 3, 0)!]);
    expect([home.metrics.sets_won, away.metrics.sets_won], "a bye credits no sets").toEqual([0, 0]);
  });

  it("a pointsMap that prices neither the credited score nor \"*\" refuses the award exactly as it refuses that score played — never a silent clean sweep", () => {
    const partial = parsed("volleyball", { pointsMap: { "3-0": [3, 0] } });
    const refusal = expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringContaining("3-2") });
    // positive pair: the same table refuses a PLAYED 3-2
    expect(() => deltasOf("volleyball", partial, [["core.start"], vbSet(25, 0), vbSet(0, 25), vbSet(25, 0), vbSet(0, 25), vbSet(15, 0)])).toThrowError(refusal);
    expect(() => deltasOf("volleyball", partial, [["core.start"], ...INDOOR[0]!.played, ["core.forfeit", { by: A, reason: "retired" }]])).toThrowError(refusal);
    // and prices the walkover's 3-0, which it declares
    expect(deltasOf("volleyball", partial, [["core.forfeit", { by: A, reason: "walkover" }]]).map((d) => d.points)).toEqual([3, 0]);
    // A bye has no credited score to price (its sets are the init 0-0), so the same table never refuses it: it keeps
    // today's delta (C-5), the table's one pair. On every declared cfg a bye's 0-0 would fall to "*" anyway — only a
    // table with no "*" tells the two readings apart.
    const m = mod("volleyball");
    const state = m.init(partial, { home: { entrantId: H, slots: [] }, away: { entrantId: "__bye__", slots: [] } });
    const bye = m.standingsDelta({ kind: "award", winner: H, loser: null, reason: "bye" } as never, partial, { kind: "swiss" } as never, state);
    expect(bye.map((d) => d.points)).toEqual([...pointsMapOf(partial)!["3-0"]!]);
  });

  it("every pointsMap sport × every declared cfg and a configured sets-dependent table × every credited score × both seats × every reason: the cfg's own pair, inside declaredPointsSets", () => {
    let checked = 0;
    const witnessed = new Map<string, number>();
    forEachSport(({ module: m }) => {
      const declared = declaredCfgs(m as never).map(({ name, cfg }) => ({ name, cfg: cfg as Record<string, unknown> }));
      // a flat W/D/L table (tennis, generic, the goal sports, …) is not this rule
      if (declared.every((d) => pointsMapOf(d.cfg) === undefined)) return;
      const base = declared[0]!.cfg;
      const top = Math.ceil((base.bestOf as number) / 2);
      // The pointsMap is a stage cfg field: an organiser's sets-dependent table on this sport, where the score one set
      // short of a sweep pays less than the sweep — the case a clean-sweep pair would get wrong.
      const configured = { name: "configured sets-dependent table", cfg: m.configSchema.parse({ ...base, pointsMap: { [`${top}-${top - 1}`]: [2, 1], "*": [3, 0] } }) as Record<string, unknown> };
      witnessed.set(m.key, 0);
      for (const { name, cfg } of [...declared, configured]) {
        const map = pointsMapOf(cfg);
        expect(map, `${m.key}/${name}: every declared cfg of a pointsMap sport declares one`).toBeDefined();
        const need = Math.ceil((cfg.bestOf as number) / 2);
        const sums = new Set(m.declaredPointsSets(cfg));
        const sweep = JSON.stringify(declaredPair(map!, need, 0));
        for (const atFault of [H, A]) {
          const winner = otherSeat(atFault);
          const cases: Array<{ k: number; reason: string; spec: Spec }> = [
            { k: 0, reason: "walkover", spec: [["core.forfeit", { by: atFault, reason: "walkover" }]] },
            { k: 0, reason: "withdrew (before the start)", spec: [["core.forfeit", { by: atFault, reason: "withdrew" }]] },
          ];
          for (let k = 0; k < need; k++) {
            // the side at fault wins k sets setTo-0 (never the deciding set: k < need), then forfeits between sets
            const won: Spec = Array.from({ length: k }, (): [string, unknown] => [setSummaryType(m.key), atFault === H ? { home: cfg.setTo, away: 0 } : { home: 0, away: cfg.setTo }]);
            for (const reason of ["retired", "disqualified", "withdrew"]) cases.push({ k, reason, spec: [["core.start"], ...won, ["core.forfeit", { by: atFault, reason }]] });
          }
          for (const c of cases) {
            const tag = `${m.key}/${name} · ${c.reason} by ${atFault} · credited ${need}-${c.k}`;
            const [w, l] = byResult(winner, deltasOf(m.key, cfg, c.spec));
            expect([w.metrics.sets_won, l.metrics.sets_won], `${tag}: the credit`).toEqual([need, c.k]);
            const want = declaredPair(map!, need, c.k);
            expect(want, `${tag}: the cfg prices the credited score`).toBeDefined();
            expect([w.points, l.points], tag).toEqual([...want!]);
            expect(sums.has(w.points + l.points), `${tag}: inside declaredPointsSets`).toBe(true);
            if (JSON.stringify(want) !== sweep) witnessed.set(m.key, witnessed.get(m.key)! + 1);
            checked++;
          }
        }
      }
    });
    // volleyball, badminton and table tennis declare a pointsMap today; a sport that adopts one joins the sweep
    expect(witnessed.size, `pointsMap sports swept: ${[...witnessed.keys()].join(", ")}`).toBeGreaterThanOrEqual(3);
    for (const [key, n] of witnessed) expect(n, `${key}: cases whose credited pair is not the clean sweep`).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(0);
  });
});
