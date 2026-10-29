// DATA for the reference family `walkover-credit` (format-matrix W2b, lane P2) — no logic lives here.
//
// It is a JSON-shaped literal in a .ts module, not a .json file: the reference boundary gate refuses a relative
// import that does not name a .ts file, and src may not read node:fs (scripts/reference-boundary.ts, ruling 27). Its
// test proves the literal is plain JSON (no function, no undefined; it round-trips).
//
// Per sport, in the registry's order (wave order — never sorted):
//   * `cfgs` — every cfg the sport DECLARES, by the engine's declared name (`declaredCfgs`: each variant, plus
//     "(schema default)" where the schema has one), plus named extras a W2b rule needs. Each holds ONLY the keys the
//     sport's Appendix A credit row reads (X-WO-1: "derived from the stage's own cfg (best-of, target score, overs)"),
//     with the values the RULEBOOKS give (rulebook-W2-sets-cricket.md, rulebook-W2-goals-boards.md, Appendix A) —
//     never read from an engine module. A consumer folding a case through the engine passes the engine's DECLARED cfg
//     of that name, parsed and UNMODIFIED (`declaredCfgs(module)`), to `walkoverCredit` — the value written here is
//     the rulebook's claim about it, checked against the engine's declaration in walkover-credit.test.ts (every known
//     difference named there), never an override. A named extra is not declared: its `source` names the stage match
//     rules it stands for.
//   * `played` — named positions at which a side stops after the match started (a retirement, a disqualification, a
//     withdrawal after start). `home`/`away` are the scoresheet's per-unit scores (goals per period, points per set or
//     game, the last unit possibly unfinished); `by` is the side that stops, "away" when absent HERE — the
//     enumeration writes it on every case it builds, and the family refuses a scoresheet with no side
//     (`offender-unknown`). Every expected value these positions produce is written out by hand in
//     walkover-credit.test.ts from the rule rows.

export interface CreditCfgEntry {
  readonly name: string;
  readonly cfg: Readonly<Record<string, unknown>>;
  /** Where each value comes from: the rule row and the rulebook clause. */
  readonly source: string;
}

export interface PlayedScenario {
  readonly name: string;
  /** The `name` of the cfg entry it is played under. */
  readonly cfg: string;
  readonly home: readonly number[];
  readonly away: readonly number[];
  readonly by?: "home" | "away";
}

export interface SportCreditData {
  readonly cfgs: readonly CreditCfgEntry[];
  readonly played: readonly PlayedScenario[];
}

const SCHEMA_DEFAULT = "(schema default)";

export const WALKOVER_CREDIT_DATA: Readonly<Record<string, SportCreditData>> = {
  football: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { awardScore: { goals: 3 } }, source: "FB-WO-1: FDC 2025 Art. 28.1, a forfeit is 3-0" },
      { name: "11-a-side", cfg: { awardScore: { goals: 3 } }, source: "FB-WO-1: FDC 2025 Art. 28.1 (11-a-side)" },
      { name: "youth", cfg: { awardScore: { goals: 3 } }, source: "FB-WO-1: Appendix A names one football walkover, 3-0" },
      { name: "small-sided", cfg: { awardScore: { goals: 3 } }, source: "FB-WO-1: Appendix A names one football walkover, 3-0" },
      { name: "mini-soccer", cfg: { awardScore: { goals: 3 } }, source: "FB-WO-1: Appendix A names one football walkover, 3-0" },
    ],
    played: [
      { name: "the side at fault is losing 0-5 (FB-RT-1: the result on the pitch is upheld)", cfg: SCHEMA_DEFAULT, home: [5], away: [0] },
      { name: "the side at fault leads 2-1 (FB-RT-1: 3-0)", cfg: SCHEMA_DEFAULT, home: [1], away: [2] },
      { name: "4-1 is the same goal difference as 3-0, not a less favourable one (FDC 28.1: 3-0)", cfg: SCHEMA_DEFAULT, home: [4], away: [1] },
      { name: "the home side is at fault, 1-6 over two halves (FB-RT-1: 6-1 upheld)", cfg: SCHEMA_DEFAULT, home: [0, 1], away: [2, 4], by: "home" },
    ],
  },
  cricket: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { inningsPerSide: 1, ballsPerInnings: 120 }, source: "CK-WO-1: ICC T20 (C1/C2), 20 overs a side" },
      { name: "t20", cfg: { inningsPerSide: 1, ballsPerInnings: 120 }, source: "CK-WO-1: ICC T20WC PC 16.10.7, the defaulter is charged its 20 overs" },
      { name: "odi", cfg: { inningsPerSide: 1, ballsPerInnings: 300 }, source: "CK-WO-1: ICC ODI (C3), 50 overs a side" },
      { name: "hundred", cfg: { inningsPerSide: 1, ballsPerInnings: 100 }, source: "CK-WO-1: the Hundred, 100 balls a side (RB2A-26)" },
      { name: "test", cfg: { inningsPerSide: 2, ballsPerInnings: null }, source: "PF-6 (CK-WO-2): two innings, no quota — Appendix A has no unlimited-overs credit" },
    ],
    played: [
      { name: "a refusal to continue after batting 150 (CK-WO-1: the defaulter is charged its full quota at 0 runs)", cfg: "t20", home: [0], away: [150] },
      { name: "a Test refusal to continue (PF-6, CK-WO-2: nothing credited, excluded from NRR)", cfg: "test", home: [212], away: [180] },
    ],
  },
  boardgame: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: {}, source: "BG-WO-1: a chess forfeit is 1-0 whatever the time control" },
      { name: "classical", cfg: {}, source: "BG-WO-1: a chess forfeit is 1-0 whatever the time control" },
      { name: "rapid", cfg: {}, source: "BG-WO-1: a chess forfeit is 1-0 whatever the time control" },
      { name: "blitz", cfg: {}, source: "BG-WO-1: a chess forfeit is 1-0 whatever the time control" },
    ],
    played: [
      { name: "a forfeit after the session started (BG-WO-1: 1-0; FIDE Laws 6.7.1)", cfg: "classical", home: [], away: [] },
    ],
  },
  carrom: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { gameTo: 25, bestOf: 3 }, source: "CA-WO-1: ICF Laws 56-57, games to 25, best of three" },
      { name: "icf", cfg: { gameTo: 25, bestOf: 3 }, source: "CA-WO-1: ICF Laws 56-57, games to 25, best of three" },
      { name: "club-29", cfg: { gameTo: 29, bestOf: 3 }, source: "X-WO-1: the stage's own game target (a 29-point club game)" },
    ],
    played: [
      { name: "the side at fault retires at 20-10 in game 2, a game down (CA-RT-1: 25-20 for the unfinished game)", cfg: "icf", home: [25, 10], away: [12, 20] },
      { name: "one game all, nothing played in game 3 (CA-RT-1: the remaining game 29-0)", cfg: "club-29", home: [29, 14, 0], away: [20, 29, 0] },
    ],
  },
  generic: {
    cfgs: [
      { name: "win_loss", cfg: { resultMode: "win_loss", allowDraws: false }, source: "GN-WO-1: win points, 0-0" },
      { name: "score", cfg: { resultMode: "score", allowDraws: true }, source: "GN-WO-1: win points, 0-0" },
    ],
    played: [
      { name: "the side at fault leads 7-3 (GN-RT-1: the recorded score is kept)", cfg: "score", home: [3], away: [7] },
      { name: "the side at fault trails 1-2 on a win/loss match's tally (GN-RT-1: the recorded tally is kept, in either result mode)", cfg: "win_loss", home: [2], away: [1] },
      { name: "a win/loss match whose tally holds nothing (GN-RT-1: 0-0; ruling 113: nothing played)", cfg: "win_loss", home: [], away: [] },
    ],
  },
  volleyball: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { bestOf: 5, setTo: 25, finalSetTo: 15, winBy: 2, cap: null }, source: "VB-WO-1: FIVB 6.2, 6.3.1, 6.3.2, 6.4.1" },
      { name: "indoor", cfg: { bestOf: 5, setTo: 25, finalSetTo: 15, winBy: 2, cap: null }, source: "VB-WO-1: FIVB 6.2, 6.3.1, 6.3.2, 6.4.1" },
      { name: "beach", cfg: { bestOf: 3, setTo: 21, finalSetTo: 15, winBy: 2, cap: null }, source: "X-WO-1 with FIVB beach rule 6 (V2): sets to 21, a deciding set to 15" },
      { name: "indoor best of 3 (stage match rules)", cfg: { bestOf: 3, setTo: 25, finalSetTo: 15, winBy: 2, cap: null }, source: "VB-WO-1 + X-WO-1: a 3-set stage credits 2-0 x 25-0 (plan Global Constraints, the old-constant case)" },
    ],
    played: [
      { name: "two sets up, the side at fault retires leading 15-10 in set 3 (VB-RT-1, FIVB 6.4.3: 25-15, then 25-0 and 15-0)", cfg: "indoor", home: [20, 23, 10], away: [25, 25, 15] },
      { name: "two sets all, the side at fault retires at 15-14 in the deciding set (FIVB 6.4.3: 17-15)", cfg: "indoor", home: [25, 20, 25, 18, 14], away: [20, 25, 22, 25, 15] },
      { name: "beach, the side at fault retires leading 20-18 in set 1 (VB-RT-1: 22-20, then 21-0)", cfg: "beach", home: [18], away: [20] },
    ],
  },
  badminton: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { bestOf: 3, setTo: 21, finalSetTo: 21, winBy: 2, cap: 30 }, source: "BD-WO-1: BWF Laws 7.1-7.5, best of three to 21, cap 30" },
      { name: "bwf", cfg: { bestOf: 3, setTo: 21, finalSetTo: 21, winBy: 2, cap: 30 }, source: "BD-WO-1: BWF Laws 7.1-7.5, best of three to 21, cap 30" },
      { name: "short", cfg: { bestOf: 3, setTo: 11, finalSetTo: 11, winBy: 2, cap: 15 }, source: "X-WO-1: the product's short variant (11, cap 15; rulebook §3.2)" },
      // Declared since W2e Task 3 (BD-VR-1): it was a named extra standing for stage match rules until the engine shipped the variant.
      { name: "bwf-3x15", cfg: { bestOf: 3, setTo: 15, finalSetTo: 15, winBy: 2, cap: 21 }, source: "X-WO-1 with BWF 3x15 (B3, RB2A-1, BD-VR-1): best of three games to 15, cap 21" },
    ],
    played: [
      { name: "a game down, the side at fault retires leading 20-19 in game 2 (BD-RT-1 read with GCR 16.3.8: 22-20)", cfg: "bwf", home: [21, 19], away: [15, 20] },
      { name: "a game down, the side at fault retires leading 29-28 in game 2 (BD-RT-1 at the cap, Law 7.5: 30-29)", cfg: "bwf", home: [21, 28], away: [10, 29] },
      { name: "one game all, nothing played in game 3 (BD-RT-1: 11-0)", cfg: "short", home: [11, 9, 0], away: [5, 11, 0] },
    ],
  },
  tabletennis: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { bestOf: 5, setTo: 11, finalSetTo: 11, winBy: 2, cap: null }, source: "TT-WO-1: ITTF 2.11.1, 2.12.1; Referee Handbook 2.3.7 (3-0, 11-0 each)" },
      { name: "bo5", cfg: { bestOf: 5, setTo: 11, finalSetTo: 11, winBy: 2, cap: null }, source: "TT-WO-1: ITTF Referee Handbook 2.3.7 (3-0, 11-0 each)" },
      { name: "bo7", cfg: { bestOf: 7, setTo: 11, finalSetTo: 11, winBy: 2, cap: null }, source: "TT-WO-1: ITTF Referee Handbook 2.3.7 (4-0 in best of 7)" },
      { name: "hardbat-21", cfg: { bestOf: 5, setTo: 21, finalSetTo: 21, winBy: 2, cap: null }, source: "X-WO-1: the product's hardbat-21 games (rulebook §4.2)" },
    ],
    played: [
      { name: "ITTF Referee Handbook 2.3.7: retiring at 5-3 in the fifth game is recorded 11-7, 8-11, 11-6, 10-12, 11-5", cfg: "bo5", home: [11, 8, 11, 10, 3], away: [7, 11, 6, 12, 5] },
      { name: "two games to one up, the side at fault retires between games (TT-RT-1: the rest 11-0)", cfg: "bo7", home: [11, 9, 5], away: [9, 11, 11] },
    ],
  },
  tennis: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { bestOf: 3 }, source: "TN-WO-1: ATP 4.01 C.4, straight sets" },
      { name: "tour", cfg: { bestOf: 3 }, source: "TN-WO-1: ATP 4.01 C.4, straight sets" },
      { name: "grand-slam", cfg: { bestOf: 5 }, source: "TN-WO-1: ITF Rule 7 best of five; ATP 4.01 C.4" },
      { name: "fast4", cfg: { bestOf: 3 }, source: "TN-WO-1: ITF App VI short sets, best of three" },
      { name: "doubles-noad-mtb10", cfg: { bestOf: 3 }, source: "TN-WO-1: ATP 4.02, a match tie-break counts as one set" },
      { name: "short-sets", cfg: { bestOf: 3 }, source: "TN-WO-1: ITF App VI short sets (tie-break at four all), best of three" },
    ],
    played: [
      { name: "the side at fault leads 6-3 4-2 and retires (TN-RT-1: straight sets, games excluded)", cfg: "tour", home: [3, 2], away: [6, 4] },
      { name: "the side at fault is two sets to one up and retires (TN-RT-1)", cfg: "grand-slam", home: [4, 6, 3], away: [6, 3, 6] },
    ],
  },
  icehockey: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { awardScore: { goals: 5 } }, source: "IH-WO-1: 5-0 (product rule; IIHF Rule 66 names no score)" },
      { name: "iihf", cfg: { awardScore: { goals: 5 } }, source: "IH-WO-1: 5-0" },
      { name: "recreational", cfg: { awardScore: { goals: 5 } }, source: "IH-WO-1: 5-0" },
    ],
    played: [
      { name: "the side at fault is losing 1-7 (IH-RT-1: the real score stands)", cfg: SCHEMA_DEFAULT, home: [7], away: [1] },
      { name: "level 2-2 (IH-RT-1: 5-0)", cfg: SCHEMA_DEFAULT, home: [1, 1, 0], away: [0, 2, 0] },
    ],
  },
  hockey: {
    cfgs: [
      { name: SCHEMA_DEFAULT, cfg: { awardScore: { goals: 5 } }, source: "HK-WO-1: FIH GTR Reg 13.1, 5-0 (the default changes from 3)" },
      { name: "fih-outdoor", cfg: { awardScore: { goals: 5 } }, source: "HK-WO-1: FIH GTR Reg 13.1, 5-0" },
      { name: "fih-shootout", cfg: { awardScore: { goals: 5 } }, source: "HK-WO-1: FIH GTR Reg 13.1, 5-0" },
      { name: "youth", cfg: { awardScore: { goals: 5 } }, source: "HK-WO-1: FIH GTR Reg 13.1, 5-0" },
      { name: "frozen before W2b (awardScore 3)", cfg: { awardScore: { goals: 3 } }, source: "X-WO-1 + plan Review Focus 3: a cfg frozen before W2b keeps its 3-0" },
    ],
    played: [
      { name: "the side at fault is losing 0-7 (HK-RT-1: the real score stands)", cfg: SCHEMA_DEFAULT, home: [2, 1, 3, 1], away: [0, 0, 0, 0] },
      { name: "the side at fault leads 3-1 (HK-RT-1: 5-0)", cfg: SCHEMA_DEFAULT, home: [1], away: [3] },
      { name: "a frozen 3-goal cfg, the side at fault losing 0-4 (X-WO-1: 4-0 upheld)", cfg: "frozen before W2b (awardScore 3)", home: [4], away: [0] },
    ],
  },
};
