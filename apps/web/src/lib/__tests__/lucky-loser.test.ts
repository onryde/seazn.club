// W4 app-A Task 13 (K9; rules X-LL-3, X-LL-4; rulebook RB4-V2, RB4-V4, RB4-V5; pre-flight C2) — the pure lucky-loser
// order, the empty case first. Expected values are typed from the rulebook per row: a later knock-out round is a better
// loser (C2), then seed (RB4-V2), then a lot with the destination's draw seed (RB4-V5) — the lot's expected order is the
// HOUSE draw (`swissRoundOneOrder`, W3 X-SW-22 / W4 T7 — the one definition of "drawn with a seed" this product has, its own
// tests in swiss-draw.test.ts), over the round's candidates in id order. The DB proof, through a real qualifying stage, is
// server/usecases/__tests__/lucky-loser.test.ts (pre-flight D10).
//
// Sport-free by nature: the order reads ids, rounds, seeds and how a line was lost.
import { describe, expect, it } from "vitest";
import { NOT_LUCKY, luckyLoserOrder, luckyLostBy, type LuckyCandidate, type LuckyLostBy } from "@/lib/lucky-loser";
import { swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";

const c = (id: string, eliminatedIn: number, seed: number | null = null, lostBy: LuckyLostBy = "played"): LuckyCandidate => ({
  id,
  eliminatedIn,
  seed,
  lostBy,
});
const SEED = swissDrawSeed("8f0c5f8e-3c1a-4b8e-9a51-6a2c0d7e4b19");
/** Deterministic destination ids for the sweeps (any string hashes). */
const DESTS = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("X-LL-3 the lucky-loser order (RB4-V2, RB4-V4; C2)", () => {
  it("X-LL-3 an empty pool orders nobody, for every draw seed", () => {
    let checked = 0;
    for (const dest of DESTS.slice(0, 20)) {
      expect(luckyLoserOrder([], swissDrawSeed(dest))).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(20);
  });

  it("X-LL-3 a later knock-out round is a better loser, whatever the seeds (C2: the round, never the snapshot's rank)", () => {
    // A quarter-final loser seeded 8 outranks a first-round loser seeded 3: the round decides first.
    const pool = [c("r1-s3", 1, 3), c("qf-s8", 2, 8), c("r1-s4", 1, 4), c("qf-s7", 2, 7)];
    expect(luckyLoserOrder(pool, SEED)).toEqual(["qf-s7", "qf-s8", "r1-s3", "r1-s4"]);
  });

  it("X-LL-3 inside a round the seeded come first, by seed, then the unseeded", () => {
    const pool = [c("u1", 2), c("s6", 2, 6), c("s5", 2, 5), c("u2", 2)];
    const order = luckyLoserOrder(pool, SEED);
    expect(order.slice(0, 2), "the seeded, by seed").toEqual(["s5", "s6"]);
    expect([...order.slice(2)].sort(), "then the unseeded, every one").toEqual(["u1", "u2"]);
  });

  it("X-LL-3 a third-place winner (half a round up) outranks the third-place loser", () => {
    expect(luckyLoserOrder([c("fourth", 2, 3), c("third", 2.5, 4)], SEED)).toEqual(["third", "fourth"]);
  });
});

describe("X-LL-4 a walkover loser is not eligible; the tiebreak uses the destination's draw seed (RB4-V5)", () => {
  it("X-LL-4 every lostBy, one row each: a walkover, a withdrawal and a disqualification never draw; play and retirement do", () => {
    // The rulebook's split (RB4-V5), typed here — never read off NOT_LUCKY, the set under test.
    const ruled: Record<LuckyLostBy, boolean> = { played: true, retired: true, walkover: false, withdrew: false, disqualified: false };
    let checked = 0;
    for (const [lostBy, eligible] of Object.entries(ruled) as [LuckyLostBy, boolean][]) {
      const order = luckyLoserOrder([c("x", 2, 5, lostBy), c("y", 1, 9)], SEED);
      expect(order, `${lostBy}: ${eligible ? "eligible, ahead of a first-round loser" : "never in the order"}`).toEqual(eligible ? ["x", "y"] : ["y"]);
      expect(NOT_LUCKY.has(lostBy), `${lostBy}: the exported set agrees`).toBe(!eligible);
      checked++;
    }
    expect(checked, "anti-vacuity: every lostBy").toBe(5);
  });

  it("X-LL-4 a pool of only walkover losers orders nobody (RB4-E7: the vacancy walks over)", () => {
    expect(luckyLoserOrder([c("a", 2, null, "walkover"), c("b", 2, 1, "withdrew"), c("d", 1, 2, "disqualified")], SEED)).toEqual([]);
  });

  it("X-LL-4 two unseeded at the same round: the destination's lot, replayable, and not the id order", () => {
    const pool = [c("q-a", 2), c("q-b", 2), c("q-c", 2), c("q-d", 2)];
    const ids = pool.map((p) => p.id);
    let differential = 0;
    let checked = 0;
    for (const dest of DESTS) {
      const seed = swissDrawSeed(dest);
      const expected = swissRoundOneOrder(seed, pool);
      const order = luckyLoserOrder(pool, seed);
      expect(order, `${dest}: the house draw with the destination's seed`).toEqual(expected);
      expect(luckyLoserOrder(pool, seed), `${dest}: replayed`).toEqual(order);
      expect(luckyLoserOrder([...pool].reverse(), seed), `${dest}: the caller's list order never moves it`).toEqual(order);
      if (order.join() !== ids.join()) differential++;
      checked++;
    }
    console.info(`X-LL-4: ${checked} destination seeds, ${differential} draws differ from the id order`);
    expect(checked, "anti-vacuity").toBe(DESTS.length);
    expect(differential, "the lot is not the id order (a differential case exists)").toBeGreaterThan(0);
    // Two destinations whose lots disagree: the seed, not a constant, decides.
    const heads = new Set(DESTS.map((d) => luckyLoserOrder(pool, swissDrawSeed(d))[0]));
    expect(heads.size, "every candidate heads some destination's lot").toBe(4);
  });
});

describe("X-LL-4 how a line was lost, off its stored outcome", () => {
  it("X-LL-4 every outcome shape names its loss, or nobody", () => {
    const rows: [unknown, LuckyLostBy | null, string][] = [
      [null, null, "no outcome: nobody knocked out"],
      [{ kind: "win", winner: "a", loser: "b" }, "played", "a result on court"],
      [{ kind: "win", winner: "a", loser: "b", method: "walkover" }, "walkover", "a pre-W2b forfeit stored as a win"],
      [{ kind: "win", winner: "a", loser: "b", method: "forfeit" }, "walkover", "the other legacy forfeit method"],
      [{ kind: "award", winner: "a", loser: "b", reason: "retired" }, "retired", "a retirement"],
      [{ kind: "award", winner: "a", loser: "b", reason: "walkover" }, "walkover", "a walkover"],
      [{ kind: "award", winner: "a", loser: "b", reason: "withdrew" }, "withdrew", "a withdrawal's walkover"],
      [{ kind: "award", winner: "a", loser: "b", reason: "disqualified" }, "disqualified", "a disqualification"],
      [{ kind: "award", winner: "a", loser: null, reason: "bye" }, null, "a bye knocks nobody out"],
      [{ kind: "award", winner: "a", method: "walkover" }, "walkover", "a pre-W2b award's legacy method"],
      [{ kind: "double_walkover" }, null, "a double walkover"],
      [{ kind: "draw" }, null, "a level result"],
    ];
    let checked = 0;
    for (const [outcome, expected, why] of rows) {
      expect(luckyLostBy(outcome), why).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(rows.length);
  });
});
