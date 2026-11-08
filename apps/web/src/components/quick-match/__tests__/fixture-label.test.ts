// The knockout fixture's label and its feeder's label (quick match plan 2; controller ruling 2026-11-08): a round's fixtures
// are numbered among its NON-BYE fixtures, and a round with exactly one gets the unnumbered label; the final is never
// numbered; a "winner of" names its round the same way. One helper, so the setup preview (T4) and the home's draw (T5)
// cannot disagree.
//
// Expected labels are typed by hand from the generator's draws pinned in setup-form.test.tsx (3 sides: byes [1], SF 3v2,
// F 1 v W; 4: SF 1v4 3v2, F; 5: byes [1,3,2], QF 5v4, SF 1 v W(QF) and 3v2, F; 6: byes [1,2], QF 5v4 3v6, SF 1 v W(QF1)
// and W(QF2) v 2, F), never read back from the helper. Sport: not applicable (the draw is sport-blind, B4c).
import { describe, expect, it } from "vitest";
import enUi from "@/dictionaries/en/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import { interpolate } from "@/lib/i18n-runtime";
import { QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MIN_SIDES } from "@/lib/quick-match-constants";
import { quickMatchPreviewTable, type QuickMatchKnockoutCell } from "@/server/usecases/quick-match-preview";
import { fixtureLabel, winnerOfLabel, type FixtureLabel } from "../fixture-label";

const say = (l: FixtureLabel, dict: Record<string, string> = enUi) => {
  const s = dict[l.key];
  if (s === undefined) throw new Error(`no copy for ${l.key}`);
  return interpolate(s, l.params);
};

const TABLE = quickMatchPreviewTable();
const cellOf = (n: number): QuickMatchKnockoutCell => {
  const cell = TABLE[`knockout:${n}:1`];
  if (!cell) throw new Error(`no knockout of ${n} in the table`);
  return cell;
};

/** Every card label in play order, and every winner seat's label (sorted: the generator's seat order is not the point). */
function labelsOf(cell: QuickMatchKnockoutCell): { cards: string[]; feeders: string[] } {
  // The table resolved byes out of its rounds (T2), so a round's pairs ARE its non-bye fixtures.
  const matchNo = new Map<string, number>();
  let n = 0;
  cell.rounds.forEach((r, ri) => r.pairs.forEach((_, pi) => matchNo.set(`${ri + 1}:${pi + 1}`, ++n)));
  const cards: string[] = [];
  const feeders: string[] = [];
  cell.rounds.forEach((r, ri) =>
    r.pairs.forEach((pair, pi) => {
      cards.push(say(fixtureLabel(r.role, ri + 1, r.pairs.length, pi)));
      for (const seat of pair) {
        if (!("winnerOf" in seat)) continue;
        const { round, pair: p } = seat.winnerOf;
        const from = cell.rounds[round - 1]!;
        feeders.push(say(winnerOfLabel(from.role, from.pairs.length, p - 1, matchNo.get(`${round}:${p}`)!)));
      }
    }),
  );
  return { cards, feeders: feeders.sort() };
}

const EXPECTED: Record<number, { cards: string[]; feeders: string[] }> = {
  3: { cards: ["Semi-final", "Final"], feeders: ["Winner of the semi-final"] },
  4: { cards: ["Semi-final 1", "Semi-final 2", "Final"], feeders: ["Winner of semi-final 1", "Winner of semi-final 2"] },
  5: {
    cards: ["Quarter-final", "Semi-final 1", "Semi-final 2", "Final"],
    feeders: ["Winner of semi-final 1", "Winner of semi-final 2", "Winner of the quarter-final"],
  },
  6: {
    cards: ["Quarter-final 1", "Quarter-final 2", "Semi-final 1", "Semi-final 2", "Final"],
    feeders: ["Winner of quarter-final 1", "Winner of quarter-final 2", "Winner of semi-final 1", "Winner of semi-final 2"],
  },
};

describe("fixtureLabel / winnerOfLabel: numbered among the round's non-bye fixtures, unnumbered when it has one", () => {
  it("every knockout the setup offers, 3..6 sides: the labels in play order and the feeders; 14 cards and 10 feeders checked", () => {
    let cards = 0;
    let feeders = 0;
    for (let n = Math.max(3, QUICK_MATCH_MIN_SIDES); n <= QUICK_MATCH_MAX_SIDES; n++) {
      const got = labelsOf(cellOf(n));
      expect(got, `${n} sides`).toEqual(EXPECTED[n]);
      cards += got.cards.length;
      feeders += got.feeders.length;
    }
    expect(cards).toBe(2 + 3 + 4 + 5);
    expect(feeders).toBe(1 + 2 + 3 + 4);
  });

  it("the final is never numbered, even handed a place in a round of two", () => {
    expect(say(fixtureLabel({ kind: "final" }, 3, 1, 0))).toBe("Final");
    expect(say(fixtureLabel({ kind: "final" }, 3, 2, 1))).toBe("Final");
  });

  it("a round with no role reads its round number; any other role reads the shared bracket name", () => {
    expect(say(fixtureLabel(null, 2, 3, 1))).toBe("Round 2");
    expect(say(fixtureLabel({ kind: "round_of", entrants: 16 }, 1, 8, 4))).toBe("Round of 16");
    expect(say(winnerOfLabel(null, 3, 2, 7))).toBe("Winner of match 7");
    // A numbered quarter-final is named as its card is, never by its match number (m8).
    expect(say(winnerOfLabel({ kind: "quarter_final" }, 4, 2, 3))).toBe("Winner of quarter-final 3");
  });

  it("another locale reads its own unnumbered words (fr)", () => {
    expect(say(fixtureLabel({ kind: "semi_final" }, 1, 1, 0), frUi)).toBe("Demi-finale");
    expect(say(winnerOfLabel({ kind: "quarter_final" }, 1, 0, 1), frUi)).toBe("Vainqueur du quart de finale");
  });

  it("refuses a place that is not in its round, a round 0 and a match 0 (the guards, reached)", () => {
    expect(() => fixtureLabel({ kind: "semi_final" }, 2, 2, 2)).toThrow(/not a place in its round/);
    expect(() => fixtureLabel({ kind: "semi_final" }, 2, 0, 0)).toThrow(/not a place in its round/);
    expect(() => fixtureLabel({ kind: "semi_final" }, 2, 2, -1)).toThrow(/not a place in its round/);
    expect(() => fixtureLabel(null, 0, 1, 0)).toThrow(/round 0/);
    expect(() => winnerOfLabel({ kind: "semi_final" }, 1, 1, 3)).toThrow(/not a place in its round/);
    expect(() => winnerOfLabel({ kind: "quarter_final" }, 2, 0, 0)).toThrow(/match 0/);
  });
});
