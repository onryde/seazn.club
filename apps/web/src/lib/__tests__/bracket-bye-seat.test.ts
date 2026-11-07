// N-1 (W4 app A Task 22; rulings 116/117) — the one predicate every bracket tile asks before it prints "to be decided"
// on an empty seat. Every surface names ruling 116's withdrawn winner (the one reader, `unseatedForfeitLoser`) BEFORE it
// reaches this fallback, so no tile can witness the predicate's own ruling-116 clause: it is pinned here, directly.
// The shapes are the ones the server writes (`byeAward`, `awardSeededByes`' walkover, the legacy double-elimination
// bye the pre-flight census found) — the expected answers come from the rulings, not from the code.
import { describe, expect, it } from "vitest";
import { bracketSeatFallbackKey, isSettledBye } from "../bracket-bye-seat";
import { byeAward } from "../fixture-bye";

const row = (home: string | null, away: string | null, outcome: unknown) => ({ home_entrant_id: home, away_entrant_id: away, outcome });

/** [case, row, settled bye?, the empty seat (if any)] — the answer per ruling. */
const CASES: [string, ReturnType<typeof row>, boolean, "home" | "away" | null][] = [
  // A bye: the seated side won an award nobody forfeited (ruling 117's "finished bye tile").
  ["today's bye, away empty", row("a", null, byeAward("a")), true, "away"],
  ["today's bye, home empty", row(null, "a", byeAward("a")), true, "home"],
  ["a legacy bye: award, no reason, no loser", row("a", null, { kind: "award", winner: "a" }), true, "away"],
  // Ruling 116: a withdrawn winner's dead seat names HER — a walkover, never a bye.
  ["ruling 116's walkover (she withdrew)", row("a", null, { kind: "award", winner: "a", loser: "w", reason: "withdrew" }), false, "away"],
  ["ruling 116's walkover, mirrored", row(null, "a", { kind: "award", winner: "a", loser: "w", reason: "withdrew" }), false, "home"],
  // Not one-seat byes at all.
  ["a two-seat walkover", row("a", "b", { kind: "award", winner: "a", loser: "b", reason: "walkover" }), false, null],
  ["a played win", row("a", "b", { kind: "win", winner: "a", loser: "b" }), false, null],
  ["a seat still waiting (no outcome)", row("a", null, null), false, "away"],
  ["an empty shell (no seats, no outcome)", row(null, null, null), false, "home"],
  ["an award the EMPTY side won (not a bye shape)", row("a", null, { kind: "award", winner: "z" }), false, "away"],
];

describe("isSettledBye / bracketSeatFallbackKey — the truth table, per ruling", () => {
  it("each shape answers as its ruling says", () => {
    let checked = 0;
    for (const [name, r, bye, empty] of CASES) {
      expect(isSettledBye(r), `${name}: settled bye?`).toBe(bye);
      for (const seat of ["home", "away"] as const) {
        const want = bye && seat === empty ? "bracket.slot.bye" : "bracket.tbd";
        expect(bracketSeatFallbackKey(r, seat), `${name}: ${seat} seat`).toBe(want);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two seats per case").toBe(CASES.length * 2);
    // Both answers are reached, and from both seats.
    expect(CASES.filter((c) => c[2]).map((c) => c[3]).sort()).toEqual(["away", "away", "home"]);
  });

  it("a settled bye's SEATED side never reads the bye word (it is named, but its fallback stays to-be-decided)", () => {
    expect(bracketSeatFallbackKey(row("a", null, byeAward("a")), "home")).toBe("bracket.tbd");
    expect(bracketSeatFallbackKey(row(null, "a", byeAward("a")), "away")).toBe("bracket.tbd");
  });
});
