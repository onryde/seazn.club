// MateInOne used to have no per-lesson scoping at all: every quest lesson
// using game:"mateInOne" rendered the SAME component pulling from the SAME
// global pool via progress.isSolved/setSolved/solvedCount, so all 7 lessons
// showed the identical puzzle progression. The fix adds an optional `range`
// prop that slices MATE1 and backs progress with the generic tactic-pack
// store (progress.isTacticSolved/setTacticSolved/tacticCount), keyed
// `mate1_${start}_${end}` — mirroring how TacticTrainer already scopes
// progress per pack (components/games/TacticTrainer.tsx).
//
// Rendered via renderToStaticMarkup — this workspace has no jsdom (see
// Board.test.tsx). Progress is pre-seeded directly through the SAME API the
// component itself calls (progress.setTacticSolved), then a fresh
// <ProgressProvider> instance reads it back. Two ProgressProvider instances
// only share state because they're pointed at the same window.localStorage
// object — the exact wiring ProgressProvider uses in the browser (it reads
// `window.localStorage` at construction, see lib/progress.tsx).
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createProgressState, ProgressProvider } from "../../../lib/progress";
import { MATE1 } from "../../../content/puzzles";
import { MateInOne } from "../MateInOne";

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

function shareStorage(storage: Storage) {
  (globalThis as { window?: unknown }).window = { localStorage: storage };
}

/** The opening `<button …>` tag for the PuzzleDots dot labeled `n` (1-based). */
function dotTag(html: string, n: number): string {
  const marker = `aria-label="Puzzle ${n}"`;
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`${marker} not found in markup`);
  const tagStart = html.lastIndexOf("<button", at);
  const tagEnd = html.indexOf(">", at);
  if (tagStart === -1 || tagEnd === -1) throw new Error(`malformed <button> around ${marker}`);
  return html.slice(tagStart, tagEnd + 1);
}

function renderMateInOne(range?: [number, number]): string {
  return renderToStaticMarkup(
    <ProgressProvider>
      <MateInOne range={range} />
    </ProgressProvider>,
  );
}

describe("MateInOne — a range scopes progress independently of sibling ranges", () => {
  it("solving in one range leaves a sibling range's progress untouched, in both directions", () => {
    const storage = fakeStorage();
    shareStorage(storage);

    // Mark puzzle 0 of the [0,3) pack solved through the same progress API
    // the component calls internally when a player solves a puzzle.
    const seed = createProgressState(storage);
    seed.setTacticSolved("mate1_0_3", 0);

    const htmlA = renderMateInOne([0, 3]);
    expect(htmlA).toContain("1 / 3 solved");
    expect(dotTag(htmlA, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlA, 3)).not.toContain("border-emerald-500");

    // A sibling range sharing the SAME progress store must show its own
    // untouched pool — not [0,3)'s progress, and not the full 18-pool size.
    const htmlB = renderMateInOne([3, 6]);
    expect(htmlB).toContain("0 / 3 solved");
    expect(dotTag(htmlB, 1)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 3)).not.toContain("border-emerald-500");

    // Vice versa: solving inside [3,6) must not retroactively change [0,3)'s
    // already-recorded progress.
    seed.setTacticSolved("mate1_3_6", 1);
    const htmlB2 = renderMateInOne([3, 6]);
    expect(htmlB2).toContain("1 / 3 solved");
    expect(dotTag(htmlB2, 2)).toContain("border-emerald-500");

    const htmlA2 = renderMateInOne([0, 3]);
    expect(htmlA2).toContain("1 / 3 solved");
    expect(dotTag(htmlA2, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA2, 2)).not.toContain("border-emerald-500");
  });

  it("range omitted keeps the full MATE1 pool and the legacy solved/setSolved keys (arcade/free-play unaffected)", () => {
    const storage = fakeStorage();
    shareStorage(storage);
    const seed = createProgressState(storage);
    seed.setSolved(0);

    const html = renderMateInOne(undefined);
    expect(html).toContain(`1 / ${MATE1.length} solved`);
  });
});
