// W3 Swiss app-B Task 10 (SW-L10): the e2e's own rulebook oracle (`e2e/support/swiss-oracle.ts`) checked against the RULEBOOK,
// never against the product. `vitest.config.ts` excludes `e2e/**`, so the oracle's test lives here and imports it.
//
// Every expected number is hand-derived in the engine plan (docs/superpowers/plans/2026-10-31-w3-swiss-engine.md, Task 7 and
// Task 8: scenarios S1, S3, S4, S5) from FIDE C.07 (2026) art. 16 and rulebook-W3-swiss.md §4, and typed here with its
// derivation. S2 is a forfeit, which the oracle does not model: the e2e that uses it plays no forfeit. The
// points rules are typed from rulebook §4 ("for chess that is 1 (2 half-points)"; a set sport pays its set-score table) and the
// plan's S5 stage rule - not read from the engine, so the oracle cannot inherit an engine mistake through its fixtures.
import { describe, expect, it } from "vitest";
import {
  OracleRefusal,
  buchholz,
  buchholzCut1,
  display,
  drawPointsOf,
  levelGroups,
  oppDiff,
  rankByChain,
  ratio,
  sonnebornBerger,
  tablePoints,
  type DeclaredPointsRule,
  type LedgerOpts,
  type OracleFixture,
} from "../../../e2e/support/swiss-oracle";

/** Chess (rulebook §4): win 2 half-points, draw 1, loss 0, shown in halves. */
const CHESS: DeclaredPointsRule = { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, unit: "half" };
/** The plan's S5 stage rule: whole points, win 3, loss 0, no draw. */
const S5_RULE: DeclaredPointsRule = { win: { regulation: 3 }, loss: { regulation: 0 }, unit: "whole" };
/** A set sport's table (badminton's shape): every set score pays the winner 2, the loser 0. */
const SETS: DeclaredPointsRule = { win: { regulation: 2 }, loss: { regulation: 0 }, bySetScore: { "*": [2, 0] }, unit: "whole" };
/** A set table that pays per score (volleyball's shape): a 2-0 pays 3-0, a 2-1 pays 2-1, and no "*" row. */
const SET_TABLE: DeclaredPointsRule = { win: { regulation: 3 }, loss: { regulation: 0 }, bySetScore: { "2-0": [3, 0], "2-1": [2, 1] }, unit: "whole" };

const win = (round: number, winner: string, loser: string): OracleFixture => ({ round, home: winner, away: loser, winner });
const draw = (round: number, a: string, b: string): OracleFixture => ({ round, home: a, away: b, winner: null });
const bye = (round: number, holder: string): OracleFixture => ({ round, home: holder, away: null, winner: holder });

// S1 (boardgame, R = 3, D = 1, cap 3): R1 A beats B, C draws D, E bye. R2 A beats E, B beats D, C bye. R3 A draws D, C beats E, B bye.
const S1 = [win(1, "A", "B"), draw(1, "C", "D"), bye(1, "E"), win(2, "A", "E"), win(2, "B", "D"), bye(2, "C"), draw(3, "A", "D"), win(3, "C", "E"), bye(3, "B")];
const S1_OPTS: LedgerOpts = { rule: CHESS, rounds: 3, drawPoints: 1 };
// S4 (boardgame, R = 3, cap 3): R1 A beats B, C bye, L absent. R2 A beats C, L beats B. R3 L beats A, B draws C.
const S4 = [win(1, "A", "B"), bye(1, "C"), win(2, "A", "C"), win(2, "L", "B"), win(3, "L", "A"), draw(3, "B", "C")];
const S4_OPTS: LedgerOpts = { rule: CHESS, rounds: 3, drawPoints: 1, absent: new Map([["L", [1]]]) };
// S5 (whole points 3/0, no draw: D = 1.5, R = 3, cap 4.5): R1 X beats Y, Z bye. R2 X beats Z, Y bye. R3 Y beats Z, X bye.
const S5 = [win(1, "X", "Y"), bye(1, "Z"), win(2, "X", "Z"), bye(2, "Y"), win(3, "Y", "Z"), bye(3, "X")];
const S5_OPTS: LedgerOpts = { rule: S5_RULE, rounds: 3, drawPoints: 1.5 };
// S3 (boardgame, R = 3, D = 1): R1 A beats B, C beats D; B withdraws (absent 2, 3). R2 A beats C, D bye. R3 A draws D, C bye.
const S3 = [win(1, "A", "B"), win(1, "C", "D"), win(2, "A", "C"), bye(2, "D"), draw(3, "A", "D"), bye(3, "C")];
const S3_OPTS: LedgerOpts = { rule: CHESS, rounds: 3, drawPoints: 1, absent: new Map([["B", [2, 3]]]) };

describe("swiss-oracle: table points (rulebook §4)", () => {
  it("empty case first: no boards, no table points - and a rank of nobody is empty, with no level group", () => {
    expect(tablePoints([], CHESS).size).toBe(0);
    const rank = rankByChain([], ["points", "buchholz_cut1", "lots"], []);
    expect(rank).toEqual({ order: [], cut: [] });
    expect(levelGroups(rank)).toEqual([[]]);
  });

  it("S1: a win 2, a draw 1, a bye the win (2): A 5, B 4, C 5, D 2, E 2 half-points", () => {
    const pts = tablePoints(S1, CHESS);
    expect(Object.fromEntries(pts)).toEqual({ A: 5, B: 4, C: 5, D: 2, E: 2 });
    expect(pts.size, "every S1 entrant scored").toBe(5);
  });

  it("a set-score rule pays its table; a bye pays the clean sweep's win; a draw under it is refused", () => {
    const fx: OracleFixture[] = [{ round: 1, home: "P", away: "Q", winner: "Q", sets: [1, 2] }, bye(1, "R")];
    expect(Object.fromEntries(tablePoints(fx, SETS))).toEqual({ P: 0, Q: 2, R: 2 });
    expect(() => tablePoints([draw(1, "P", "Q")], SETS)).toThrow(OracleRefusal);
    expect(() => tablePoints([win(1, "P", "Q")], SETS), "a set rule needs the board's sets").toThrow(OracleRefusal);
  });

  it("a set-score table pays per score: a 2-1 pays its own row, not the clean sweep's", () => {
    const fx: OracleFixture[] = [{ round: 1, home: "P", away: "Q", winner: "Q", sets: [1, 2] }];
    expect(Object.fromEntries(tablePoints(fx, SET_TABLE))).toEqual({ P: 1, Q: 2 });
  });

  it("guards: a score the set table does not name (no \"*\"), a bye under a set table without \"*\", a winner not on the board, and a draw under a rule that declares none or under a set table that does are refused", () => {
    const only20: DeclaredPointsRule = { ...SET_TABLE, bySetScore: { "2-0": [3, 0] } };
    expect(() => tablePoints([{ round: 1, home: "P", away: "Q", winner: "Q", sets: [1, 2] }], only20), "2-1 unnamed").toThrow(OracleRefusal);
    expect(() => tablePoints([bye(1, "R")], SET_TABLE), "a bye needs the clean sweep's row").toThrow(OracleRefusal);
    expect(() => tablePoints([{ round: 1, home: "P", away: "Q", winner: "Z" }], CHESS), "Z is not on the board").toThrow(OracleRefusal);
    expect(() => tablePoints([draw(1, "P", "Q")], S5_RULE), "S5's rule declares no draw").toThrow(OracleRefusal);
    expect(() => tablePoints([draw(1, "P", "Q")], { ...SETS, draw: 1 }), "a set result cannot be drawn").toThrow(OracleRefusal);
  });

  it("a draw's points: the declared draw where a draw can stand, else half the win (rulebook §4 'Non-chess scaling')", () => {
    expect(drawPointsOf(CHESS, true)).toBe(1);
    expect(drawPointsOf(SETS, false)).toBe(1);
    expect(drawPointsOf(S5_RULE, false)).toBe(1.5);
    expect(() => drawPointsOf(S5_RULE, true), "a reachable draw with no draw points is refused").toThrow(OracleRefusal);
  });
});

describe("swiss-oracle: Buchholz and Cut-1 (C.07 2026 art. 16)", () => {
  it("S1: E's own bye scores against a dummy at its own score - 2 + A 5 + C 5 = 12 half-points, shown 12/2 (16.4.2)", () => {
    expect(buchholz(S1, "E", S1_OPTS)).toBe(12);
    expect(display(buchholz(S1, "E", S1_OPTS), CHESS.unit)).toBe(12 / 2);
  });

  it("S1: the cap binds - C (score 5) gets min(5, 1 x 3) = 3 for its round-2 bye: D 2 + 3 + E 2 = 7, shown 7/2", () => {
    expect(buchholz(S1, "C", S1_OPTS)).toBe(7); // differential: uncapped, 2 + 5 + 2 = 9
    expect(display(buchholz(S1, "C", S1_OPTS), CHESS.unit)).toBe(7 / 2);
  });

  it("S4: a late entrant's missed round followed by play is 16.2.3 - L's own dummy min(4, 3) = 3: 3 + B 1 + A 4 = 8", () => {
    expect(tablePoints(S4, CHESS).get("L"), "L scores 4: nothing for the missed round").toBe(4);
    expect(buchholz(S4, "L", S4_OPTS)).toBe(8);
  });

  it("S4: opponents read L at its real 4, not as a draw: B = A 4 + L 4 + C 3 = 11 (16.3.1; 12 if misread as 16.2.5)", () => {
    expect(buchholz(S4, "B", S4_OPTS)).toBe(11);
  });

  it("S4: Cut-1 cuts the missed round (a VUR) before the lowest card: L = 8 - 3 = 5, not 8 - 1 = 7 (16.5.1)", () => {
    expect(buchholzCut1(S4, "L", S4_OPTS)).toBe(5); // differential: lowest-overall Cut-1 gives 7
    // B has no VUR: its lowest contribution (C 3) goes.
    expect(buchholzCut1(S4, "B", S4_OPTS)).toBe(8);
  });

  it("S5: the non-chess scale - X's dummy is min(9, 1.5 x 3) = 4.5: Y 6 + Z 3 + 4.5 = 13.5, shown unhalved", () => {
    expect(buchholz(S5, "X", S5_OPTS)).toBe(13.5);
    expect(display(buchholz(S5, "X", S5_OPTS), S5_RULE.unit)).toBe(13.5);
  });

  it("S3: a withdrawn entrant stays in its opponents' Buchholz at its adjusted score (0 + 2 draws): A = 2 + C 4 + D 3 = 9 (16.3.2)", () => {
    expect(buchholz(S3, "A", S3_OPTS)).toBe(9); // differential: B read at its frozen 0 gives 7
    // B's own card: A 5 and two 16.2.5 rounds at min(0, 3) = 0; Cut-1 cuts one of those VURs.
    expect(buchholz(S3, "B", S3_OPTS)).toBe(5);
    expect(buchholzCut1(S3, "B", S3_OPTS)).toBe(5);
  });

  it("second call: the same inputs give the same numbers", () => {
    const first = ["A", "B", "C", "D", "E"].map((id) => [buchholz(S1, id, S1_OPTS), buchholzCut1(S1, id, S1_OPTS)]);
    const second = ["A", "B", "C", "D", "E"].map((id) => [buchholz(S1, id, S1_OPTS), buchholzCut1(S1, id, S1_OPTS)]);
    expect(second).toEqual(first);
    expect(first.length, "anti-vacuity: every S1 entrant").toBe(5);
  });

  it("guards: an absent round outside 1..R, an absent round holding a card, and an entrant not on the table are refused", () => {
    expect(() => buchholz(S4, "L", { ...S4_OPTS, absent: new Map([["L", [4]]]) })).toThrow(OracleRefusal);
    expect(() => buchholz(S4, "L", { ...S4_OPTS, absent: new Map([["L", [2]]]) })).toThrow(OracleRefusal);
    expect(() => buchholz(S4, "Nobody", S4_OPTS)).toThrow(OracleRefusal);
  });
});

describe("swiss-oracle: Sonneborn-Berger (A4 9.1 with C.07 16's unplayed rounds)", () => {
  it("S1: each card's Buchholz contribution weighted by the share of a win scored on it - C = draw D 1/2 x 2 + bye 1 x 3 + E 1 x 2 = 6, shown 3", () => {
    expect(sonnebornBerger(S1, "C", S1_OPTS)).toBe(6); // differential: an uncapped bye dummy gives 8
    expect(display(sonnebornBerger(S1, "C", S1_OPTS), CHESS.unit)).toBe(3);
    expect(sonnebornBerger(S1, "A", S1_OPTS), "A: B 4 + E 2 + half of D 2").toBe(7);
    expect(sonnebornBerger(S1, "E", S1_OPTS), "E: its bye's dummy 2, two losses").toBe(2);
  });

  it("S4: a missed round scores nothing, so it weighs nothing - L = 0 x 3 + B 1 + A 4 = 5", () => {
    expect(sonnebornBerger(S4, "L", S4_OPTS)).toBe(5);
  });

  it("guards: a win worth nothing cannot weigh a result", () => {
    const zero: DeclaredPointsRule = { win: { regulation: 0 }, loss: { regulation: 0 }, unit: "whole" };
    expect(() => sonnebornBerger([win(1, "P", "Q")], "P", { rule: zero, rounds: 1, drawPoints: 0 })).toThrow(OracleRefusal);
  });
});

describe("swiss-oracle: the chain's order (rulebook §5, §6.2)", () => {
  const met: OracleFixture[] = [win(1, "P", "Q"), win(1, "R", "S")];
  const row = (entrant: string, values: Record<string, number>) => ({ entrant, values });

  it("points first; a points tie is split by the first ladder that differs; the key that split each pair is named", () => {
    const rank = rankByChain(
      [row("Q", { points: 2, buchholz_cut1: 3, buchholz: 4 }), row("P", { points: 4, buchholz_cut1: 1, buchholz: 1 }), row("S", { points: 2, buchholz_cut1: 3, buchholz: 6 })],
      ["points", "buchholz_cut1", "buchholz", "lots"],
      met,
    );
    expect(rank.order).toEqual(["P", "S", "Q"]);
    expect(rank.cut).toEqual(["points", "buchholz"]);
  });

  it("direct encounter splits a level pair only when they met; a pair that never met stays level for lots (§6.2: flagged, never ordered)", () => {
    const level = { points: 2, buchholz_cut1: 3, buchholz: 4 };
    const metPair = rankByChain([row("Q", level), row("P", level)], ["points", "buchholz_cut1", "buchholz", "direct", "lots"], met);
    expect(metPair).toEqual({ order: ["P", "Q"], cut: ["direct"] });
    const strangers = rankByChain([row("Q", level), row("S", level)], ["points", "buchholz_cut1", "buchholz", "direct", "lots"], met);
    expect(strangers.cut).toEqual([null]);
    expect(levelGroups(strangers)).toEqual([["Q", "S"]]);
  });

  it("ratios: more won per lost ranks higher, nothing lost ranks above any finite ratio", () => {
    expect(ratio(4, 2)).toBe(2);
    expect(ratio(4, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(ratio(0, 0)).toBe(0);
  });

  it("guards: a chain key the oracle does not model, and a tie reaching a key a row lacks, are refused", () => {
    expect(() => rankByChain([row("P", { points: 1 })], ["points", "sberger"], met)).toThrow(OracleRefusal);
    expect(() => rankByChain([row("P", { points: 1 }), row("Q", { points: 1 })], ["points", "buchholz"], met)).toThrow(OracleRefusal);
  });
});

describe("swiss-oracle: opponents' goal difference (rulebook §5, the goals family)", () => {
  // R1: P 2-0 Q, R 3-1 S. R2: P 1-1 R, Q 0-2 S. Goal differences: P +2, Q -4, R +2, S 0 (typed from the four results).
  const goals = (round: number, home: string, away: string, h: number, a: number): OracleFixture => ({
    round,
    home,
    away,
    winner: h === a ? null : h > a ? home : away,
    goals: [h, a],
  });
  const FX = [goals(1, "P", "Q", 2, 0), goals(1, "R", "S", 3, 1), goals(2, "P", "R", 1, 1), goals(2, "Q", "S", 0, 2)];

  it("each entrant sums its opponents' own goal difference: P = Q -4 + R +2 = -2, Q = P +2 + S 0 = 2, R = S 0 + P +2 = 2, S = R +2 + Q -4 = -2", () => {
    expect(["P", "Q", "R", "S"].map((id) => oppDiff(FX, id))).toEqual([-2, 2, 2, -2]);
  });

  it("guards: a bye (with or without goals), a board without goals, and an entrant not on the table are refused", () => {
    expect(() => oppDiff([...FX, bye(3, "P")], "Q")).toThrow(OracleRefusal);
    expect(() => oppDiff([...FX, { ...bye(3, "P"), goals: [0, 0] }], "Q"), "the bye guard alone").toThrow(OracleRefusal);
    expect(() => oppDiff([win(1, "P", "Q")], "P")).toThrow(OracleRefusal);
    expect(() => oppDiff(FX, "Nobody")).toThrow(OracleRefusal);
  });
});
