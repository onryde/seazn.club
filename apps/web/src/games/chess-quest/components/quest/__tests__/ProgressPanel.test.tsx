// The progress table's three POOLED rows — Mate in 1, Mate in 2, Piece
// Detective — are fed by TWO stores that index the SAME pool:
//
//   * the arcade writes the legacy per-pool arrays (solved / solved2 / hunts)
//     through setSolved / setSolved2 / setHuntSolved;
//   * a quest lesson is scoped to a slice of that pool (gameOpts.range) and
//     writes the generic tactic store under `mate1_${a}_${b}` /
//     `mate2_${a}_${b}` / `hunt_${a}_${b}` — see MateInOne.tsx:38,
//     MateInTwo.tsx:53 and HangingHunt.tsx:47.
//
// The panel used to read the legacy arrays alone, so a player who closed all
// 32 Piece Detective cases through the quest saw "0 / 32 cases", no stars on
// that row, and 32 missing from the puzzles-solved tile. The slices are a
// contiguous partition of the pool (pinned by content/__tests__/lessons.test.ts),
// so slice index `i` of `[a,b)` IS pool index `a + i`: the panel counts the
// UNION of pool indices, never the sum — a puzzle solved in both stores is one
// puzzle.
//
// Rendered through renderToStaticMarkup: this workspace has no jsdom (vitest
// `environment: "node"` — see Board.test.tsx). Progress is seeded through the
// SAME API the games call (setTacticSolved / setHuntSolved / setSolved), then
// a fresh <ProgressProvider> reads it back off the shared fake storage, which
// is exactly the wiring ProgressProvider uses in the browser (it reads
// window.localStorage at construction — lib/progress.tsx).
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HUNTS, MATE1, MATE2 } from "../../../content/puzzles";
import { LESSONS } from "../../../content/lessons";
import { createProgressState, Progress, ProgressProvider } from "../../../lib/progress";
import { STAR_RULES } from "../../../lib/stars";
import { ProgressPanel } from "../ProgressPanel";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** A seeded store plus the markup a fresh panel renders from it. */
function withProgress(seed: (p: Progress) => void): string {
  const storage = fakeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  seed(createProgressState(storage));
  return renderToStaticMarkup(
    <ProgressProvider>
      <ProgressPanel onClose={() => {}} onPrint={() => {}} />
    </ProgressProvider>,
  );
}

/** The whole `<tr>` of the games table whose first cell reads `label`. */
function row(html: string, label: string): string {
  const at = html.indexOf(`>${label}</td>`);
  expect(at, `no games-table row labelled "${label}"`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at) + 5);
}

/** The star count the row's `<Stars>` cell announces. */
function stars(html: string, label: string): number {
  const m = row(html, label).match(/aria-label="(\d+) of 3 stars"/);
  expect(m, `row "${label}" renders no star cell`).not.toBeNull();
  return Number(m![1]);
}

/** The number printed above a summary tile's `label`. */
function tile(html: string, label: string): string {
  const at = html.indexOf(`>${label}</span>`);
  expect(at, `no summary tile labelled "${label}"`).toBeGreaterThan(-1);
  const head = html.slice(0, at);
  const labelSpan = head.lastIndexOf("<span");
  const valueEnd = head.lastIndexOf("</span>", labelSpan);
  return head.slice(head.lastIndexOf(">", valueEnd) + 1, valueEnd);
}

/** Every distinct `[a,b)` a lesson of `game` scopes itself to. */
function rangesOf(game: string): [number, number][] {
  return LESSONS.filter((l) => l.game === game && l.gameOpts?.range).map(
    (l) => l.gameOpts!.range!,
  );
}

describe("ProgressPanel — lesson play reaches the pooled rows", () => {
  it("counts a Piece Detective LESSON solve on the Piece Detective row", () => {
    const html = withProgress((p) => p.setTacticSolved("hunt_0_8", 0));
    expect(HUNTS.length).toBe(32);
    expect(row(html, "Piece Detective")).toContain(`1 / ${HUNTS.length} cases`);
  });

  it("counts one pool index once when BOTH stores hold it (union, never the sum)", () => {
    // Legacy hunt 0 and slice index 0 of `hunt_0_8` are the SAME case.
    const html = withProgress((p) => {
      p.setHuntSolved(0);
      p.setTacticSolved("hunt_0_8", 0);
    });
    expect(row(html, "Piece Detective")).toContain(`1 / ${HUNTS.length} cases`);
    expect(row(html, "Piece Detective")).not.toContain(`2 / ${HUNTS.length}`);
  });

  // The offset is the whole mapping: slice index 0 of `mate1_5_10` is pool
  // index 5, not 0. Seeding the legacy array at 5 as well must therefore still
  // read 1 — an implementation that added `i` instead of `a + i` scores 2.
  it("maps a slice index to its pool index by the slice's own start", () => {
    const html = withProgress((p) => {
      p.setSolved(5);
      p.setTacticSolved("mate1_5_10", 0);
    });
    expect(row(html, "Mate in 1")).toContain(`1 / ${MATE1.length} puzzles`);
  });

  it("counts a Mate in 1 lesson solve on the Mate in 1 row", () => {
    const html = withProgress((p) => p.setTacticSolved("mate1_5_10", 0));
    expect(MATE1.length).toBe(35);
    expect(row(html, "Mate in 1")).toContain(`1 / ${MATE1.length} puzzles`);
    expect(stars(html, "Mate in 1")).toBe(STAR_RULES.packStars(1, MATE1.length));
  });

  // packStars(1, 35) is 0, which a row that never counted lesson play also
  // shows — so the star cell needs a case where the right answer is not the
  // wrong one's constant. Twelve solves is exactly one star on a 35-pack, and
  // every one of them was scored under a per-lesson gameId the table never
  // reads, so progress.gameStars("mateInOne") is still 0.
  it("derives the pooled rows' stars from the union, not the row's stored gameStars", () => {
    const ranges = rangesOf("mateInOne");
    expect(ranges.slice(0, 3)).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
    ]);
    const html = withProgress((p) => {
      for (const [a, b] of ranges.slice(0, 2))
        for (let i = 0; i < b - a; i++) p.setTacticSolved(`mate1_${a}_${b}`, i);
      p.setTacticSolved("mate1_10_15", 0);
      p.setTacticSolved("mate1_10_15", 1);
      expect(p.gameStars("mateInOne")).toBe(0);
    });
    const expected = STAR_RULES.packStars(12, MATE1.length);
    expect(expected).toBeGreaterThan(0);
    expect(row(html, "Mate in 1")).toContain(`12 / ${MATE1.length} puzzles`);
    expect(stars(html, "Mate in 1")).toBe(expected);
  });

  it("counts a Mate in 2 lesson solve on the Mate in 2 row", () => {
    const html = withProgress((p) => p.setTacticSolved("mate2_6_12", 2));
    expect(MATE2.length).toBe(24);
    expect(row(html, "Mate in 2")).toContain(`1 / ${MATE2.length} puzzles`);
  });

  it("adds every pooled solve to the puzzles-solved tile exactly once", () => {
    const html = withProgress((p) => {
      p.setHuntSolved(0); // pool hunt 0 …
      p.setTacticSolved("hunt_0_8", 0); // … and the same case through a lesson
      p.setTacticSolved("mate1_5_10", 0); // pool mate1 5
      p.setTacticSolved("mate2_0_6", 1); // pool mate2 1
    });
    // 1 hunt + 1 mate-in-1 + 1 mate-in-2, and nothing else seeded.
    expect(tile(html, "puzzles solved")).toBe("3");
  });

  it("leaves the arcade's own reading of the pooled rows unchanged", () => {
    const html = withProgress((p) => {
      p.setSolved(0);
      p.setSolved2(0);
      p.setHuntSolved(0);
    });
    expect(row(html, "Mate in 1")).toContain(`1 / ${MATE1.length} puzzles`);
    expect(row(html, "Mate in 2")).toContain(`1 / ${MATE2.length} puzzles`);
    expect(row(html, "Piece Detective")).toContain(`1 / ${HUNTS.length} cases`);
    expect(tile(html, "puzzles solved")).toBe("3");
  });
});
