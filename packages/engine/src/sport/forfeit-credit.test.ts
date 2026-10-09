// W2b Task 4 (spec §5.2; Appendix A X-WO-1, X-RT-1, *-WO-*, *-RT-*; plan PF-6, PF-7). What a forfeit credits the table,
// per sport. EVERY expectation below is the Appendix A rule written out here and fed the cfg (best-of, set target,
// game target, `awardScore`, overs) and the played numbers of the stream — never read back from `forfeitCredit` or
// from `standingsDelta`. A rule that cannot be stated without the module's code is a finding, not a test.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../core/events.ts";
import type { StandingsDelta } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

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
      const rt = foldMatchWithStoppage(m as never, cfg as never, l, [ev(1, "core.start"), ...Array.from({ length: g + 2 }, (_, i) => ev(i + 2, goalType, { by: A })), ev(g + 4, "core.forfeit", { by: H, reason: "retired" })]);
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
});
