// The walkover-credit family's tests (format-matrix W2b, lane P2, Task 15). Every expected value is written out by hand
// from an Appendix A row (spec 2026-10-08-format-matrix-w2b-design.md), the W2 rulebooks or the orchestrator's
// pre-flight rulings PF-6 / PF-7 — never from engine source and never from the family (R8; TEST-STRATEGY rule 3). The
// engine is touched only for its DECLARED domain at test time: the registry's keys, each sport's declared cfg NAMES,
// its configSchema (does a key written here exist?) and its declared metric KEYS — never a value to expect. One test
// reads the engine's declared cfg VALUES, in the other direction: it checks the rulebook's claim (the data) AGAINST the
// engine's declaration, with every known difference named — it never takes an expected credit from the engine.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import {
  CREDIT_REASONS,
  CREDIT_REFUSALS,
  CREDIT_SPORTS,
  CreditRefused,
  enumerateCreditCases,
  walkoverCredit,
  walkoverCreditFamily,
  type CreditAnswer,
  type CreditCase,
  type CreditRefusal,
} from "./walkover-credit.ts";
import { WALKOVER_CREDIT_DATA } from "./walkover-credit-cfgs.ts";
import { readAppendixA, readRowsWithAppendixA } from "../../test/appendix-a.ts";

type M = Record<string, number>;
const goals = (gf: number, ga: number): M => ({ gf, ga, gd: gf - ga });
const sets = (sets_won: number, sets_lost: number, points_won: number, points_lost: number): M => ({ sets_won, sets_lost, points_won, points_lost });
const mirrorSets = (w: M): M => sets(w.sets_lost ?? NaN, w.sets_won ?? NaN, w.points_lost ?? NaN, w.points_won ?? NaN);
/** A single forfeit's full answer: the winner gets the sport's win points. */
const single = (winner: M, loser: M, statsMatch: boolean, excluded: string[] = []): CreditAnswer => ({ winner, loser, excluded, points: "win", statsMatch });

/** Each sport's cfg as the data module writes it, by declared name — the case under test reads the same entry. */
function cfgOf(sport: string, name: string): Record<string, unknown> {
  const e = WALKOVER_CREDIT_DATA[sport]?.cfgs.find((c) => c.name === name);
  if (e === undefined) throw new Error(`test: ${sport} has no credit cfg named ${name}`);
  return { ...e.cfg };
}
const DEFAULT = "(schema default)";
const wo = (sport: string, name: string = DEFAULT): CreditAnswer => walkoverCredit({ sport, cfg: cfgOf(sport, name), reason: "walkover" });
const ret = (sport: string, name: string, home: number[], away: number[], by: "home" | "away" = "away", reason: CreditCase["reason"] = "retired"): CreditAnswer =>
  walkoverCredit({ sport, cfg: cfgOf(sport, name), reason, played: { home, away }, by });
function refusalOf(c: CreditCase): CreditRefusal | "answered" {
  try { walkoverCredit(c); return "answered"; } catch (e) { if (e instanceof CreditRefused) return e.reason; throw e; }
}

describe("walkover-credit: the empty case first", () => {
  it("X-WO-1 + X-RS-1: an EMPTY scoresheet (play started, nothing scored) credits exactly the walkover — every cfg of every sport — and only players' stats differ (X-PS-2)", () => {
    // An empty input answers every question: with nothing played the retirement credit has nothing to keep, so it is
    // the walkover credit in every sport; only statsMatch moves (a retirement is a match played, X-PS-2).
    let checked = 0;
    for (const sport of CREDIT_SPORTS) {
      for (const { name } of WALKOVER_CREDIT_DATA[sport]?.cfgs ?? []) {
        const walk = wo(sport, name);
        const empty = ret(sport, name, [], []);
        expect({ ...empty, statsMatch: false }, `${sport} ${name}`).toEqual(walk);
        expect(empty.statsMatch, `${sport} ${name}`).toBe(true);
        expect(walk.statsMatch, `${sport} ${name}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(44); // 5+5+4+3+2+4+4+4+5+3+5 cfg entries in walkover-credit-cfgs.ts
  });

  it("X-RS-1: an empty scoresheet is still a scoresheet — a walkover with one is refused outside chess (play started)", () => {
    // single-sport: football stands for the rule; the registry sweep below refuses it in every non-chess sport
    expect(refusalOf({ sport: "football", cfg: cfgOf("football", DEFAULT), reason: "walkover", played: { home: [], away: [] } })).toBe("played-before-start");
  });

  it("the enumeration is never empty: 11 × 5 = 55 base cases first, then every other cfg and played scenario — 210 in all", () => {
    const all = enumerateCreditCases();
    expect(all.length).toBe(210); // 55 base + 155 variants, counted by hand from walkover-credit-cfgs.ts (see the report)
    const base = all.slice(0, 55);
    expect(base.length).toBe(55);
    // the base holds each sport × each reason exactly once
    const pairs = new Set(base.map((c) => `${c.sport} ${c.reason}`));
    expect(pairs.size).toBe(55);
    for (const sport of CREDIT_SPORTS) for (const reason of CREDIT_REASONS) expect(pairs.has(`${sport} ${reason}`), `${sport} ${reason}`).toBe(true);
  });
});

describe("walkover-credit: the Appendix A examples (brief Step 1)", () => {
  it("FB-WO-1: a football walkover is 3-0, win points to the winner, not a match in players' stats", () => {
    expect(wo("football")).toEqual(single(goals(3, 0), goals(0, 3), false));
  });
  it("HK-WO-1: a hockey walkover is 5-0 (the default changes from 3)", () => {
    expect(wo("hockey")).toEqual(single(goals(5, 0), goals(0, 5), false));
    for (const name of ["fih-outdoor", "fih-shootout", "youth"]) expect(wo("hockey", name), name).toEqual(single(goals(5, 0), goals(0, 5), false));
  });
  it("VB-WO-1 + X-WO-1: a 3-set volleyball stage credits 2-0, each set 25-0 (the stage's own best-of, not a 3-0 constant)", () => {
    const w = sets(2, 0, 50, 0);
    expect(wo("volleyball", "indoor best of 3 (stage match rules)")).toEqual(single(w, mirrorSets(w), false));
  });
  it("CK-WO-1: cricket's defaulter is charged its full quota at 0 runs, and the winner's NRR is unaffected", () => {
    const nrr = (balls_faced_eff: number): M => ({ runs_for: 0, balls_faced_eff, runs_against: 0, balls_bowled_eff: 0 });
    expect(wo("cricket", "t20")).toEqual(single(nrr(0), nrr(120), false)); // 20 overs × 6
    expect(wo("cricket", "odi")).toEqual(single(nrr(0), nrr(300), false)); // 50 overs × 6
    expect(wo("cricket", "hundred")).toEqual(single(nrr(0), nrr(100), false)); // 100 balls
  });
  it("X-DW-1 / X-DW-4: a double walkover is all zero for both, every ratio key excluded, 0 points, not a match in players' stats — every sport", () => {
    // The ratio operands, typed from each rulebook's cascade (X-DW-4: "set/game %, NRR, goal ratios"); the goal sports,
    // generic and chess rank on differences and counts, never a ratio, so none is excluded there.
    const RATIOS: Record<string, string[]> = {
      football: [], hockey: [], icehockey: [], boardgame: [], generic: [], // goals-boards §1-§4, §6: GD/GF, diff/for, direct/wins/SB
      carrom: ["sets_won", "sets_lost", "boards_won", "boards_lost", "points_won", "points_lost"], // §5: game, board, point ratio
      volleyball: ["sets_won", "sets_lost", "points_won", "points_lost"], // sets-cricket §5: set ratio, point ratio
      badminton: ["sets_won", "sets_lost", "points_won", "points_lost"], // BD-7: set_ratio, point_ratio
      tabletennis: ["sets_won", "sets_lost", "points_won", "points_lost"], // TT-7: games ratio, points ratio
      tennis: ["sets_won", "sets_lost", "games_won", "games_lost"], // TN-14: % sets, % games
      cricket: ["runs_for", "balls_faced_eff", "runs_against", "balls_bowled_eff"], // NRR
    };
    const SCORES: Record<string, string[]> = { football: ["gf", "ga", "gd"], hockey: ["gf", "ga", "gd"], icehockey: ["gf", "ga", "gd"], boardgame: ["wins", "white", "black"], generic: ["for", "against", "diff"] };
    let checked = 0;
    const sports = forEachSport(({ key }) => {
      const want = RATIOS[key];
      expect(want, `${key}: no X-DW-4 ratio list`).toBeDefined();
      const keys = SCORES[key] ?? want ?? [];
      expect(keys.length, key).toBeGreaterThan(0);
      const z = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const { name } of WALKOVER_CREDIT_DATA[key]?.cfgs ?? []) {
        expect(walkoverCredit({ sport: key, cfg: cfgOf(key, name), reason: "double_walkover" }), `${key} ${name}`).toEqual({ winner: z, loser: z, excluded: want, points: "zero", statsMatch: false });
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(44);
  });
  it("X-PS-2: retired and disqualified credit statsMatch true; X-PS-1: a walkover and a withdrawal never count as a match played", () => {
    let checked = 0;
    for (const c of enumerateCreditCases()) {
      const want = c.reason === "retired" || c.reason === "disqualified";
      expect(walkoverCredit(c).statsMatch, c.label).toBe(want);
      checked++;
    }
    expect(checked).toBe(210);
  });
});

describe("walkover-credit: the goal sports (FB, HK, IH)", () => {
  it("FB-RT-1: 3-0, or the real score where it is worse for the side at fault (FDC 28.1 — strictly less favourable)", () => {
    expect(ret("football", DEFAULT, [5], [0])).toEqual(single(goals(5, 0), goals(0, 5), true)); // losing 0-5: upheld
    expect(ret("football", DEFAULT, [1], [2])).toEqual(single(goals(3, 0), goals(0, 3), true)); // leading 2-1: 3-0
    expect(ret("football", DEFAULT, [4], [1])).toEqual(single(goals(3, 0), goals(0, 3), true)); // 4-1 is GD 3 = 3-0's: 3-0
    // the home side at fault, 1-6 over two halves: the away side's 6-1 stands
    expect(ret("football", DEFAULT, [0, 1], [2, 4], "home")).toEqual(single(goals(6, 1), goals(1, 6), true));
  });
  it("HK-RT-1: 5-0, or the real score where it is worse for the side at fault; X-WO-1: a cfg frozen before W2b keeps 3", () => {
    expect(ret("hockey", DEFAULT, [2, 1, 3, 1], [0, 0, 0, 0])).toEqual(single(goals(7, 0), goals(0, 7), true));
    expect(ret("hockey", DEFAULT, [1], [3])).toEqual(single(goals(5, 0), goals(0, 5), true));
    const frozen = "frozen before W2b (awardScore 3)";
    expect(wo("hockey", frozen)).toEqual(single(goals(3, 0), goals(0, 3), false));
    expect(ret("hockey", frozen, [4], [0])).toEqual(single(goals(4, 0), goals(0, 4), true)); // GD 4 > 3: upheld
    expect(ret("hockey", DEFAULT, [4], [0])).toEqual(single(goals(5, 0), goals(0, 5), true)); // the positive pair: GD 4 ≤ 5
  });
  it("IH-WO-1: an ice hockey walkover is 5-0; IH-RT-1: 5-0, or the real score where worse for the side at fault", () => {
    for (const name of [DEFAULT, "iihf", "recreational"]) expect(wo("icehockey", name), name).toEqual(single(goals(5, 0), goals(0, 5), false));
    expect(ret("icehockey", DEFAULT, [7], [1])).toEqual(single(goals(7, 1), goals(1, 7), true));
    expect(ret("icehockey", DEFAULT, [1, 1, 0], [0, 2, 0])).toEqual(single(goals(5, 0), goals(0, 5), true));
  });
  it("FB-WO-1: every football cfg the product declares credits 3-0", () => {
    let n = 0;
    for (const { name } of WALKOVER_CREDIT_DATA.football?.cfgs ?? []) { expect(wo("football", name), name).toEqual(single(goals(3, 0), goals(0, 3), false)); n++; }
    expect(n).toBe(5);
  });
});

describe("walkover-credit: the rally-point set sports (VB, TT, BD)", () => {
  it("VB-WO-1: the sets needed to win, each 25-0 — best of 5 is 3-0 (75-0); beach is best of 3 to 21 (X-WO-1: 2-0, 42-0)", () => {
    for (const name of [DEFAULT, "indoor"]) { const w = sets(3, 0, 75, 0); expect(wo("volleyball", name), name).toEqual(single(w, mirrorSets(w), false)); }
    const b = sets(2, 0, 42, 0);
    expect(wo("volleyball", "beach")).toEqual(single(b, mirrorSets(b), false));
  });
  it("VB-RT-1 (FIVB 6.4.3): the winner is given the sets and points it needed; the retiring side keeps what it won", () => {
    // two sets up, the side at fault retires leading 15-10 in set 3: 25-15, then 25-0 and the deciding set 15-0
    let w = sets(3, 2, 108, 65);
    expect(ret("volleyball", "indoor", [20, 23, 10], [25, 25, 15])).toEqual(single(w, mirrorSets(w), true));
    // two sets all, retiring leading 15-14 in the deciding set to 15: the winner needs 17-15
    w = sets(3, 2, 105, 107);
    expect(ret("volleyball", "indoor", [25, 20, 25, 18, 14], [20, 25, 22, 25, 15])).toEqual(single(w, mirrorSets(w), true));
    // beach, retiring leading 20-18 in set 1: 22-20, then 21-0
    w = sets(2, 0, 43, 20);
    expect(ret("volleyball", "beach", [18], [20])).toEqual(single(w, mirrorSets(w), true));
  });
  it("TT-WO-1 (Handbook 2.3.7): the games needed to win, each 11-0 — 3-0 in best of 5, 4-0 in best of 7; hardbat-21's games are 21-0 (X-WO-1)", () => {
    for (const [name, w] of [[DEFAULT, sets(3, 0, 33, 0)], ["bo5", sets(3, 0, 33, 0)], ["bo7", sets(4, 0, 44, 0)], ["hardbat-21", sets(3, 0, 63, 0)]] as const) {
      expect(wo("tabletennis", name), name).toEqual(single(w, mirrorSets(w), false));
    }
  });
  it("TT-RT-1: the Handbook's own example — retiring at 5-3 in the fifth is recorded 11-7, 8-11, 11-6, 10-12, 11-5", () => {
    const w = sets(3, 2, 51, 41); // 11+8+11+10+11 against 7+11+6+12+5
    expect(ret("tabletennis", "bo5", [11, 8, 11, 10, 3], [7, 11, 6, 12, 5])).toEqual(single(w, mirrorSets(w), true));
  });
  it("TT-RT-1: points played stand, and the remaining games go 11-0 — two games to one up, the side at fault retires between games", () => {
    const w = sets(4, 2, 58, 31);
    expect(ret("tabletennis", "bo7", [11, 9, 5], [9, 11, 11])).toEqual(single(w, mirrorSets(w), true));
  });
  it("BD-WO-1: 2-0 games, each 21-0 — and the stage's own target (X-WO-1): short 11, BWF 3x15 15", () => {
    for (const [name, w] of [[DEFAULT, sets(2, 0, 42, 0)], ["bwf", sets(2, 0, 42, 0)], ["short", sets(2, 0, 22, 0)], ["bwf 3x15 (from 2027-01-04, stage match rules)", sets(2, 0, 30, 0)]] as const) {
      expect(wo("badminton", name), name).toEqual(single(w, mirrorSets(w), false));
    }
  });
  it("BD-RT-1: points played stand, the current game completed for the winner (a legal end: 22-20, and 30-29 at the cap), remaining games 21-0", () => {
    let w = sets(2, 0, 43, 35);
    expect(ret("badminton", "bwf", [21, 19], [15, 20])).toEqual(single(w, mirrorSets(w), true));
    w = sets(2, 0, 51, 39);
    expect(ret("badminton", "bwf", [21, 28], [10, 29])).toEqual(single(w, mirrorSets(w), true));
    w = sets(2, 1, 31, 16);
    expect(ret("badminton", "short", [11, 9, 0], [5, 11, 0])).toEqual(single(w, mirrorSets(w), true));
  });
});

describe("walkover-credit: tennis, cricket, chess, carrom, generic", () => {
  it("TN-WO-1: straight sets for set %, the match's games credited 0 and excluded from game %", () => {
    const tn = (n: number): CreditAnswer => single({ sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 }, { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 }, false, ["games_won", "games_lost"]);
    for (const name of [DEFAULT, "tour", "fast4", "doubles-noad-mtb10"]) expect(wo("tennis", name), name).toEqual(tn(2));
    expect(wo("tennis", "grand-slam")).toEqual(tn(3));
  });
  it("TN-RT-1: a retirement is the same credit as TN-WO-1 — even for the side at fault leading", () => {
    const want = (n: number): CreditAnswer => single({ sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 }, { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 }, true, ["games_won", "games_lost"]);
    expect(ret("tennis", "tour", [3, 2], [6, 4])).toEqual(want(2));
    expect(ret("tennis", "grand-slam", [4, 6, 3], [6, 3, 6])).toEqual(want(3));
  });
  it("CK-WO-1: a refusal to continue is a forfeit — the defaulter charged its full quota at 0 runs, whatever it had scored", () => {
    const nrr = (balls_faced_eff: number): M => ({ runs_for: 0, balls_faced_eff, runs_against: 0, balls_bowled_eff: 0 });
    expect(ret("cricket", "t20", [0], [150])).toEqual(single(nrr(0), nrr(120), true));
    // the full quota is every innings the defaulter was owed: two limited innings of 50 overs are 600 balls
    expect(walkoverCredit({ sport: "cricket", cfg: { inningsPerSide: 2, ballsPerInnings: 300 }, reason: "walkover" })).toEqual(single(nrr(0), nrr(600), false));
  });
  it("PF-6 (CK-WO-2, T14): unlimited-overs (Test) cricket credits nothing — no quota, so the match is out of NRR", () => {
    const z = { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 };
    const nrrKeys = ["runs_for", "balls_faced_eff", "runs_against", "balls_bowled_eff"];
    expect(wo("cricket", "test")).toEqual(single(z, z, false, nrrKeys));
    expect(ret("cricket", "test", [212], [180])).toEqual(single(z, z, true, nrrKeys));
  });
  it("BG-WO-1: a chess forfeit is 1-0 and credits no colour; BG-WO-2: recordable before the game starts — and after the session starts (FIDE 6.7.1)", () => {
    const w = single({ wins: 1, white: 0, black: 0 }, { wins: 0, white: 0, black: 0 }, false);
    for (const name of [DEFAULT, "classical", "rapid", "blitz"]) expect(wo("boardgame", name), name).toEqual(w);
    expect(walkoverCredit({ sport: "boardgame", cfg: {}, reason: "walkover", played: { home: [], away: [] }, by: "away" })).toEqual(w);
  });
  it("CA-WO-1: the games needed to win, each 25-0 — and a 29-point club game's own target (X-WO-1)", () => {
    for (const [name, w] of [[DEFAULT, sets(2, 0, 50, 0)], ["icf", sets(2, 0, 50, 0)], ["club-29", sets(2, 0, 58, 0)]] as const) {
      expect(wo("carrom", name), name).toEqual(single(w, mirrorSets(w), false));
    }
  });
  it("CA-RT-1: completed games stand, the unfinished game 25–(the retiring side's score), remaining games 25-0", () => {
    let w = sets(2, 0, 50, 32);
    expect(ret("carrom", "icf", [25, 10], [12, 20])).toEqual(single(w, mirrorSets(w), true));
    w = sets(2, 1, 72, 49);
    expect(ret("carrom", "club-29", [29, 14, 0], [20, 29, 0])).toEqual(single(w, mirrorSets(w), true));
  });
  it("GN-WO-1: win points, 0-0; GN-RT-1: the walkover credit, keeping any recorded score", () => {
    const z = { for: 0, against: 0, diff: 0 };
    for (const name of ["win_loss", "score"]) expect(wo("generic", name), name).toEqual(single(z, z, false));
    expect(ret("generic", "score", [3], [7])).toEqual(single({ for: 3, against: 7, diff: -4 }, { for: 7, against: 3, diff: 4 }, true));
    expect(ret("generic", "win_loss", [], [])).toEqual(single(z, z, true));
  });
});

describe("walkover-credit: the cross-sport rows (X-RT-1, X-WD-1 / PF-7, X-RS-1)", () => {
  const played = enumerateCreditCases().filter((c) => c.reason === "retired");

  it("X-RT-1: an in-match disqualification takes the sport's retirement credit — every played scenario of every sport", () => {
    let checked = 0;
    for (const c of played) {
      expect(walkoverCredit({ ...c, reason: "disqualified" }), c.label).toEqual(walkoverCredit(c));
      checked++;
    }
    expect(checked).toBe(26); // one retirement per played scenario: 4+2+1+2+2+3+3+2+2+2+3
    expect(new Set(played.map((c) => c.sport)).size).toBe(11);
  });

  it("X-WD-1 + PF-7: a withdrawal after play started takes the sport's retirement credit; before start, the walkover credit — never a match in players' stats", () => {
    let after = 0;
    for (const c of played) {
      expect(walkoverCredit({ ...c, reason: "withdrew" }), c.label).toEqual({ ...walkoverCredit(c), statsMatch: false });
      after++;
    }
    expect(after).toBe(26);
    let before = 0;
    for (const sport of CREDIT_SPORTS) {
      for (const { name } of WALKOVER_CREDIT_DATA[sport]?.cfgs ?? []) {
        expect(walkoverCredit({ sport, cfg: cfgOf(sport, name), reason: "withdrew" }), `${sport} ${name}`).toEqual(wo(sport, name));
        before++;
      }
    }
    expect(before).toBe(44);
    // the witness that the two credits differ: a football withdrawal at 0-5 down keeps 5-0, not 3-0
    expect(ret("football", DEFAULT, [5], [0], "away", "withdrew").winner).toEqual(goals(5, 0));
    expect(walkoverCredit({ sport: "football", cfg: cfgOf("football", DEFAULT), reason: "withdrew" }).winner).toEqual(goals(3, 0));
  });

  it("X-RS-1: a walkover or a double walkover with a scoresheet is refused in every sport but chess; retired or disqualified with none is refused in every sport", () => {
    let refused = 0;
    const sports = forEachSport(({ key }) => {
      const cfg = cfgOf(key, WALKOVER_CREDIT_DATA[key]?.cfgs[0]?.name ?? "");
      for (const reason of ["walkover", "double_walkover"] as const) {
        const r = refusalOf({ sport: key, cfg, reason, played: { home: [], away: [] }, by: "away" });
        expect(r, `${key} ${reason}`).toBe(key === "boardgame" ? "answered" : "played-before-start");
        if (r !== "answered") refused++;
      }
      for (const reason of ["retired", "disqualified"] as const) {
        expect(refusalOf({ sport: key, cfg, reason }), `${key} ${reason}`).toBe("not-started");
        refused++;
      }
    });
    expect(sports).toBe(11);
    expect(refused).toBe(10 * 2 + 11 * 2);
  });

  it("X-WO-1: the credit follows the stage's own cfg — the same sport under two cfgs credits two scores (no constant)", () => {
    expect(wo("volleyball", "indoor").winner).not.toEqual(wo("volleyball", "beach").winner);
    expect(wo("hockey").winner).not.toEqual(wo("hockey", "frozen before W2b (awardScore 3)").winner);
    expect(wo("carrom", "icf").winner).not.toEqual(wo("carrom", "club-29").winner);
    expect(wo("cricket", "t20").loser).not.toEqual(wo("cricket", "odi").loser);
  });
});

describe("walkover-credit transitions (TEST-STRATEGY rule 1: a second call, the other side, the input untouched)", () => {
  it("a second call answers the same, and the case is not mutated", () => {
    let checked = 0;
    for (const c of enumerateCreditCases()) {
      const before = JSON.stringify(c);
      expect(walkoverCredit(c), c.label).toEqual(walkoverCredit(c));
      expect(JSON.stringify(c), c.label).toBe(before);
      checked++;
    }
    expect(checked).toBe(210);
  });

  it("the side at fault decides who is credited: home at fault mirrors away at fault (every played scenario, scoresheet mirrored)", () => {
    let checked = 0;
    for (const c of enumerateCreditCases().filter((x) => x.played !== undefined)) {
      const p = c.played;
      if (p === undefined) continue;
      const mirrored: CreditCase = { ...c, played: { home: [...p.away], away: [...p.home] }, by: c.by === "home" ? "away" : "home" };
      expect(walkoverCredit(mirrored), c.label).toEqual(walkoverCredit(c));
      checked++;
    }
    expect(checked).toBe(26 * 3); // retired, disqualified and withdrew per played scenario
  });

  it("the enumeration is deterministic (a second call, the same list) and every case is answered", () => {
    expect(enumerateCreditCases()).toEqual(enumerateCreditCases());
    let answered = 0;
    for (const c of enumerateCreditCases()) { expect(refusalOf(c), c.label).toBe("answered"); answered++; }
    expect(answered).toBe(210);
  });
});

describe("walkover-credit never guesses: every refusal is named and reached", () => {
  const fb = cfgOf("football", DEFAULT);
  const vb = cfgOf("volleyball", "indoor");
  const CASES: Readonly<Record<CreditRefusal, CreditCase>> = {
    "unknown-sport": { sport: "curling", cfg: {}, reason: "walkover" },
    "unknown-reason": { sport: "football", cfg: fb, reason: "no-show" as unknown as CreditCase["reason"] },
    "cfg-invalid": { sport: "football", cfg: {}, reason: "walkover" },
    "played-before-start": { sport: "football", cfg: fb, reason: "walkover", played: { home: [1], away: [0] } },
    "not-started": { sport: "volleyball", cfg: vb, reason: "retired" },
    "played-malformed": { sport: "football", cfg: fb, reason: "retired", played: { home: [1, 0], away: [0] }, by: "away" },
    "unit-unfinished": { sport: "volleyball", cfg: vb, reason: "retired", played: { home: [20, 25], away: [15, 10] }, by: "away" },
    "already-decided": { sport: "volleyball", cfg: vb, reason: "retired", played: { home: [25, 25, 25], away: [10, 10, 10] }, by: "away" },
    "offender-unknown": { sport: "football", cfg: fb, reason: "retired", played: { home: [0], away: [5] } },
  };

  it("one case per refusal reaches it and names itself", () => {
    const reasons = Object.keys(CREDIT_REFUSALS) as CreditRefusal[];
    expect(reasons.length).toBe(9);
    expect(Object.keys(CASES).sort()).toEqual([...reasons].sort());
    let reached = 0;
    for (const r of reasons) {
      let thrown: unknown;
      try { walkoverCredit(CASES[r]); } catch (e) { thrown = e; }
      expect(thrown, r).toBeInstanceOf(CreditRefused);
      expect((thrown as CreditRefused).reason, r).toBe(r);
      expect((thrown as Error).message, r).toContain(CREDIT_REFUSALS[r]);
      reached++;
    }
    expect(reached).toBe(9);
  });

  it("offender-unknown: a scoresheet with no side at fault is refused, never read as the away side's — every reason that reads one, and the side changes the answer", () => {
    const sheet = { home: [0], away: [5] };
    let n = 0;
    for (const reason of ["retired", "disqualified", "withdrew"] as const) {
      expect(refusalOf({ sport: "football", cfg: fb, reason, played: sheet }), reason).toBe("offender-unknown");
      n++;
    }
    expect(refusalOf({ sport: "boardgame", cfg: {}, reason: "walkover", played: { home: [], away: [] } }), "chess walkover after the start").toBe("offender-unknown");
    n++;
    expect(n).toBe(4);
    // the witness that the side matters: home at fault 0-5 down is upheld 5-0; away at fault, it leads, so 3-0
    expect(walkoverCredit({ sport: "football", cfg: fb, reason: "retired", played: sheet, by: "home" }).winner).toEqual(goals(5, 0));
    expect(walkoverCredit({ sport: "football", cfg: fb, reason: "retired", played: sheet, by: "away" }).winner).toEqual(goals(3, 0));
    // no scoresheet, or a double walkover, needs no side
    expect(refusalOf({ sport: "football", cfg: fb, reason: "withdrew" })).toBe("answered");
    expect(refusalOf({ sport: "football", cfg: fb, reason: "double_walkover" })).toBe("answered");
    expect(refusalOf({ sport: "boardgame", cfg: {}, reason: "double_walkover", played: { home: [], away: [] } }), "chess double forfeit after the start").toBe("answered");
  });

  it("cfg-invalid: each value a credit row reads is checked — goals, best-of (odd), targets, cap, quota, game target, result mode", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["football", { awardScore: { goals: 0 } }],
      ["hockey", { awardScore: 5 }],
      ["volleyball", { ...vb, bestOf: 4 }],
      ["volleyball", { ...vb, setTo: undefined }],
      ["badminton", { ...cfgOf("badminton", "bwf"), cap: "30" }],
      ["tabletennis", { ...cfgOf("tabletennis", "bo5"), winBy: 0 }],
      ["tennis", { bestOf: 2 }],
      ["cricket", { inningsPerSide: 1, ballsPerInnings: 0 }],
      ["cricket", { ballsPerInnings: 120 }],
      ["carrom", { gameTo: 25 }],
      ["generic", { resultMode: "points" }],
      ["icehockey", {}],
    ];
    let n = 0;
    for (const [sport, cfg] of bad) { expect(refusalOf({ sport, cfg, reason: "walkover" }), `${sport} ${JSON.stringify(cfg)}`).toBe("cfg-invalid"); n++; }
    expect(n).toBe(12);
    expect(new Set(bad.map(([s]) => s)).size).toBe(10); // every sport but chess reads a cfg value
  });

  it("played-malformed: unequal lengths, a negative or fractional score, a set past its end, more sets than the best-of, a score in a win/loss generic match", () => {
    const tt = cfgOf("tabletennis", "bo5");
    const bad: CreditCase[] = [
      { sport: "football", cfg: fb, reason: "retired", played: { home: [-1], away: [0] }, by: "away" },
      { sport: "football", cfg: fb, reason: "retired", played: { home: [1.5], away: [0] }, by: "away" },
      { sport: "tabletennis", cfg: tt, reason: "retired", played: { home: [14], away: [5] }, by: "away" }, // 11-5 ends it; 14-5 ran past
      { sport: "tabletennis", cfg: tt, reason: "retired", played: { home: [11, 11, 11, 11, 11, 1], away: [0, 0, 0, 0, 0, 0] }, by: "away" },
      { sport: "badminton", cfg: cfgOf("badminton", "bwf"), reason: "retired", played: { home: [31], away: [29] }, by: "away" }, // past the cap
      { sport: "carrom", cfg: cfgOf("carrom", "icf"), reason: "retired", played: { home: [25], away: [25] }, by: "away" },
      { sport: "generic", cfg: cfgOf("generic", "win_loss"), reason: "retired", played: { home: [1], away: [0] }, by: "away" },
    ];
    let n = 0;
    for (const c of bad) { expect(refusalOf(c), JSON.stringify(c.played)).toBe("played-malformed"); n++; }
    expect(n).toBe(7);
  });

  it("unit-unfinished and already-decided: only the last unit may be unfinished; a scoresheet that already decides the match is refused (sets and carrom), its positive pair answered", () => {
    const ic = cfgOf("carrom", "icf");
    expect(refusalOf({ sport: "carrom", cfg: ic, reason: "retired", played: { home: [10, 25], away: [5, 0] }, by: "away" })).toBe("unit-unfinished");
    expect(refusalOf({ sport: "carrom", cfg: ic, reason: "retired", played: { home: [25, 25], away: [0, 0] }, by: "away" })).toBe("already-decided");
    expect(refusalOf({ sport: "carrom", cfg: ic, reason: "retired", played: { home: [25, 0, 5], away: [0, 25, 25] }, by: "away" })).toBe("already-decided"); // the side at fault won it
    expect(refusalOf({ sport: "carrom", cfg: ic, reason: "retired", played: { home: [0, 0, 5], away: [25, 25, 0] }, by: "away" })).toBe("already-decided"); // a game after the match was won
    expect(refusalOf({ sport: "volleyball", cfg: vb, reason: "retired", played: { home: [10, 10, 10, 5], away: [25, 25, 25, 0] }, by: "away" })).toBe("already-decided");
    // the positive pairs: one set (game) short of the majority, retiring between units, is answered
    expect(refusalOf({ sport: "carrom", cfg: ic, reason: "retired", played: { home: [25], away: [0] }, by: "away" })).toBe("answered");
    expect(refusalOf({ sport: "volleyball", cfg: vb, reason: "retired", played: { home: [25, 25], away: [10, 10] }, by: "away" })).toBe("answered");
  });
});

// ── The engine's declared domain: names and keys only, never a value to expect ──────────────────────────────────────

/** Where the rulebook's value (the data) and the engine's declared value differ today, each with its reason. A
 *  difference not listed here fails; a listed one that is no longer a difference fails too. */
const EXPECTED_DIFFERENCES: Readonly<Record<string, string>> = {
  "hockey · (schema default) · awardScore": "HK-WO-1: engine default moves 3→5 in loop D; remove at cross-check",
  "hockey · fih-outdoor · awardScore": "HK-WO-1: engine default moves 3→5 in loop D; remove at cross-check",
  "hockey · fih-shootout · awardScore": "HK-WO-1: engine default moves 3→5 in loop D; remove at cross-check",
  "hockey · youth · awardScore": "HK-WO-1: engine default moves 3→5 in loop D; remove at cross-check",
};

/** The data writes only the keys a credit row reads, so an object value is compared on the keys it names. */
function sameDeclared(engine: unknown, data: unknown): boolean {
  if (data !== null && typeof data === "object") {
    if (engine === null || typeof engine !== "object") return false;
    return Object.entries(data).every(([k, v]) => sameDeclared((engine as Record<string, unknown>)[k], v));
  }
  return Object.is(engine, data);
}

describe("walkover-credit's vocabulary is the product's (the registry, each sport's declared cfg names, configSchema keys, metric keys)", () => {
  it("the family's sports are exactly the registry's, in the registry's (wave) order", () => {
    const keys: string[] = [];
    const n = forEachSport(({ key }) => { keys.push(key); });
    expect(n).toBe(11);
    expect([...CREDIT_SPORTS]).toEqual(keys);
    expect(Object.keys(WALKOVER_CREDIT_DATA)).toEqual(keys);
  });

  it("X-WO-1: the data holds an entry for every cfg each sport DECLARES (by name)", () => {
    let checked = 0;
    const sports = forEachSport(({ key, module }) => {
      const names = new Set((WALKOVER_CREDIT_DATA[key]?.cfgs ?? []).map((e) => e.name));
      for (const { name } of declaredCfgs(module as never)) {
        expect(names.has(name), `${key}: the declared cfg "${name}" has no credit entry`).toBe(true);
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBe(41); // 44 entries less 3 named extras (hockey frozen at 3, volleyball best of 3, badminton 3x15)
  });

  it("each cfg key the data writes exists in the sport's configSchema (and the schema accepts the value written)", () => {
    let keys = 0;
    let entries = 0;
    const sports = forEachSport(({ key, module }) => {
      const declared = declaredCfgs(module as never);
      const variants = module.variants as Record<string, Record<string, unknown>>;
      for (const e of WALKOVER_CREDIT_DATA[key]?.cfgs ?? []) {
        // A declared name parses over its own variant; a named extra over the sport's first declared cfg.
        const over = variants[e.name] ?? (declared.find((d) => d.name === e.name) ? {} : (variants[declared[0]?.name ?? ""] ?? {}));
        const parsed = module.configSchema.parse({ ...over, ...e.cfg }) as Record<string, unknown>;
        for (const [k, v] of Object.entries(e.cfg)) {
          expect(k in parsed, `${key} ${e.name}: cfg key "${k}" is not in the sport's configSchema`).toBe(true);
          if (v !== null && typeof v === "object") expect(parsed[k], `${key} ${e.name}.${k}`).toMatchObject(v);
          else expect(parsed[k], `${key} ${e.name}.${k}`).toEqual(v);
          keys++;
        }
        entries++;
      }
    });
    expect(sports).toBe(11);
    expect(entries).toBe(44);
    expect(keys).toBeGreaterThan(entries); // chess entries write no key; the rest write at least one
  });

  it("X-WO-1: each value the data writes for a DECLARED cfg is the engine's declared value — every declared name, every key, the known differences named", () => {
    let names = 0;
    let keys = 0;
    const diffs: string[] = [];
    const sports = forEachSport(({ key, module }) => {
      const data = new Map((WALKOVER_CREDIT_DATA[key]?.cfgs ?? []).map((e) => [e.name, e.cfg]));
      for (const { name, cfg } of declaredCfgs(module as never)) {
        const want = data.get(name);
        if (want === undefined) throw new Error(`test: ${key} declares "${name}", which the data has no entry for`); // the test above owns this
        const parsed = cfg as Record<string, unknown>;
        for (const [k, v] of Object.entries(want)) {
          if (!sameDeclared(parsed[k], v)) diffs.push(`${key} · ${name} · ${k}`);
          keys++;
        }
        names++;
      }
    });
    expect(sports).toBe(11);
    expect(names).toBe(41); // zero compared would be a vacuous green
    expect(keys).toBeGreaterThan(names - 2); // every declared entry but chess's two writes a key
    // A listed difference that is no longer a difference fails too: the list is cleared, never left stale.
    expect([...diffs].sort(), `the data and the engine's declaration differ at: ${diffs.join("; ")}`).toEqual(Object.keys(EXPECTED_DIFFERENCES).sort());
  });

  it("the consumer recipe: walkoverCredit on the engine's declared cfg, parsed and unmodified, answers as the data's cfg does — every declared name; a named difference answers differently", () => {
    let same = 0;
    let differ = 0;
    forEachSport(({ key, module }) => {
      for (const { name, cfg } of declaredCfgs(module as never)) {
        const fromEngine = walkoverCredit({ sport: key, cfg: { ...(cfg as Record<string, unknown>) }, reason: "walkover" });
        const fromData = wo(key, name);
        const listed = Object.keys(EXPECTED_DIFFERENCES).some((d) => d.startsWith(`${key} · ${name} · `));
        if (listed) { expect(fromEngine, `${key} ${name}`).not.toEqual(fromData); differ++; }
        else { expect(fromEngine, `${key} ${name}`).toEqual(fromData); same++; }
      }
    });
    expect(same + differ).toBe(41);
    expect(differ).toBe(Object.keys(EXPECTED_DIFFERENCES).length);
  });

  it("every metric key an answer names is one the sport declares (winner, loser and excluded) — every enumerated case", () => {
    const declared = new Map<string, Set<string>>();
    forEachSport(({ key, module }) => { declared.set(key, new Set((module.metrics as readonly { key: string }[]).map((m) => m.key))); });
    let keys = 0;
    for (const c of enumerateCreditCases()) {
      const a = walkoverCredit(c);
      const ok = declared.get(c.sport);
      expect(ok, c.sport).toBeDefined();
      for (const k of [...Object.keys(a.winner), ...Object.keys(a.loser), ...a.excluded]) { expect(ok?.has(k), `${c.label}: "${k}" is not a declared metric`).toBe(true); keys++; }
    }
    expect(keys).toBeGreaterThan(210);
  });

  it("the data module is plain JSON data (no function, no undefined): it round-trips", () => {
    expect(JSON.parse(JSON.stringify(WALKOVER_CREDIT_DATA))).toEqual(WALKOVER_CREDIT_DATA);
  });
});

// ── The rows the family covers: each an Appendix A row, signed, and cited in a test title here ─────────────────────

const OWN_TITLES = (() => {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  return [...text.matchAll(/\b(?:it|describe)\(\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2] ?? "");
})();

describe("walkover-credit's rows (Appendix A)", () => {
  it("Appendix A reads whole: its stated total is its rows plus its one amendment", () => {
    const a = readAppendixA();
    expect(a.rows.length).toBe(53);
    expect(a.amendments).toEqual(["X-BR-1 (amend)"]);
    expect(a.statedTotal).toBe(54);
  });

  it("every row the family cites is an Appendix A row (or a rules-directory row once Task 14 writes it), signed or a recorded deviation, and named in a test title of this file", () => {
    const rows = readRowsWithAppendixA();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(new Set(walkoverCreditFamily.rows).size).toBe(walkoverCreditFamily.rows.length);
    let cited = 0;
    for (const id of walkoverCreditFamily.rows) {
      expect(byId.get(id)?.status, `${id} is no signed or deviation row`).toMatch(/^(signed|deviation) \d+ \d{4}-\d{2}-\d{2}$/); // BD-RT-1 is a recorded deviation (BWF GCR 16.2.5)
      expect(OWN_TITLES.some((t) => new RegExp(`(^|[^A-Z0-9-])${id}([^0-9]|$)`).test(t)), `${id} is cited by the family but no test title names it`).toBe(true);
      cited++;
    }
    expect(cited).toBe(29);
    // and the family claims every credit row (a sport's WO/RT row) Appendix A holds — none unanswered
    const creditRows = readAppendixA().rows.map((r) => r.id).filter((id) => /^[A-Z]{2}-(WO|RT)-\d+$/.test(id) && id !== "BD-WO-2" && id !== "BG-WO-3"); // BD-WO-2: a stage-kind rule (the credit takes no stage); BG-WO-3: a bracket tie-break rule (bracket-finish)
    expect(creditRows.length).toBe(21);
    for (const id of creditRows) expect(walkoverCreditFamily.rows, id).toContain(id);
  });

  it("the orchestrator rulings the family encodes are named in a test title (PF-6, PF-7)", () => {
    for (const r of walkoverCreditFamily.rulings) expect(OWN_TITLES.some((t) => t.includes(r)), r).toBe(true);
    expect(walkoverCreditFamily.rulings.length).toBe(2);
  });
});
