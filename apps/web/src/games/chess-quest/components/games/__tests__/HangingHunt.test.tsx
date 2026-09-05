// HangingHunt (Piece Detective) used to have no per-lesson scoping at all:
// all four quest lessons using game:"hangingHunt" rendered the SAME component
// pulling from the SAME global pool via progress.isHuntSolved/setHuntSolved/
// huntCount, so solving the cases in lesson 17 opened lessons 21/33/46
// already complete. The fix adds an optional `range` prop that slices HUNTS
// and backs progress with the generic tactic-pack store
// (progress.isTacticSolved/setTacticSolved/tacticCount), keyed
// `hunt_${start}_${end}` — the same shape MateInOne/MateInTwo already use
// (components/games/MateInOne.tsx).
//
// Rendered via renderToStaticMarkup — this workspace has no jsdom (see
// Board.test.tsx). Progress is pre-seeded directly through the SAME API the
// component itself calls, then a fresh <ProgressProvider> instance reads it
// back; the two instances only share state because they're pointed at the
// same window.localStorage object (lib/progress.tsx reads it at construction).
//
// The ranges under test are [0,4)/[4,8) rather than the quest's own
// [0,8)/[8,16): HUNTS is being grown to 32 in parallel, and these two slices
// are non-empty, disjoint and meaningful at BOTH the current size and 32.
// Expected board contents are derived from HUNTS itself (never a position
// typed into the test), so re-ordering the pack moves the expectation with it.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createProgressState, ProgressProvider } from "../../../lib/progress";
import { HUNTS } from "../../../content/puzzles";
import { parseFEN, sqName } from "../../../engine";
import { HangingHunt } from "../HangingHunt";

const A: [number, number] = [0, 4];
const B: [number, number] = [4, 8];

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
  const marker = `aria-label="Case ${n}"`;
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`${marker} not found in markup`);
  const tagStart = html.lastIndexOf("<button", at);
  const tagEnd = html.indexOf(">", at);
  if (tagStart === -1 || tagEnd === -1) throw new Error(`malformed <button> around ${marker}`);
  return html.slice(tagStart, tagEnd + 1);
}

/** The whole `<button …>…</button>` element for one board square, children included. */
function squareCell(html: string, square: string): string {
  const at = html.indexOf(`data-square="${square}"`);
  if (at === -1) throw new Error(`square ${square} not found in markup`);
  const start = html.lastIndexOf("<button", at);
  const end = html.indexOf("</button>", at);
  if (start === -1 || end === -1) throw new Error(`malformed <button> for square ${square}`);
  return html.slice(start, end + "</button>".length);
}

/**
 * The 64-square position actually PAINTED, read back off the rendered piece
 * sprites (`/pieces/nd.svg` → "n", `/pieces/nl.svg` → "N") in the same
 * a8…h1 index order parseFEN produces — so it can be compared to a puzzle's
 * own parsed board directly.
 */
function occupancy(html: string): string[] {
  const board: string[] = [];
  for (let i = 0; i < 64; i++) {
    const cell = squareCell(html, sqName(i));
    const m = /\/pieces\/([a-z])([ld])\.svg/.exec(cell);
    board.push(m ? (m[2] === "l" ? m[1].toUpperCase() : m[1]) : "");
  }
  return board;
}

function renderHangingHunt(range?: [number, number]): string {
  return renderToStaticMarkup(
    <ProgressProvider>
      <HangingHunt range={range} />
    </ProgressProvider>,
  );
}

describe("HangingHunt — a range scopes progress independently of sibling ranges", () => {
  it("solving in one range leaves a sibling range's progress untouched, in both directions", () => {
    const storage = fakeStorage();
    shareStorage(storage);

    // Mark case 0 of the [0,4) pack solved through the same progress API the
    // component calls internally when a player closes a case.
    const seed = createProgressState(storage);
    seed.setTacticSolved("hunt_0_4", 0);

    const htmlA = renderHangingHunt(A);
    expect(htmlA).toContain("1 / 4 cases");
    expect(dotTag(htmlA, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlA, 3)).not.toContain("border-emerald-500");
    expect(dotTag(htmlA, 4)).not.toContain("border-emerald-500");

    // A sibling range sharing the SAME progress store must show its own
    // untouched pool — not [0,4)'s progress, and not the full pool's size.
    const htmlB = renderHangingHunt(B);
    expect(htmlB).toContain("0 / 4 cases");
    expect(dotTag(htmlB, 1)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 3)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 4)).not.toContain("border-emerald-500");

    // Nor may a ranged solve leak into the arcade/free-play legacy pool.
    expect(renderHangingHunt(undefined)).toContain(`0 / ${HUNTS.length} cases`);

    // Vice versa: solving inside [4,8) must not retroactively change [0,4)'s
    // already-recorded progress.
    seed.setTacticSolved("hunt_4_8", 1);
    const htmlB2 = renderHangingHunt(B);
    expect(htmlB2).toContain("1 / 4 cases");
    expect(dotTag(htmlB2, 1)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB2, 2)).toContain("border-emerald-500");

    const htmlA2 = renderHangingHunt(A);
    expect(htmlA2).toContain("1 / 4 cases");
    expect(dotTag(htmlA2, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA2, 2)).not.toContain("border-emerald-500");
  });

  it("range omitted keeps the full HUNTS pool and the legacy hunt keys (arcade/free-play unaffected)", () => {
    const storage = fakeStorage();
    shareStorage(storage);
    const seed = createProgressState(storage);
    seed.setHuntSolved(0);

    const html = renderHangingHunt(undefined);
    expect(html).toContain(`1 / ${HUNTS.length} cases`);
    expect(dotTag(html, 1)).toContain("border-emerald-500");

    // …and the legacy pool's progress must not leak into a ranged lesson.
    expect(renderHangingHunt(A)).toContain("0 / 4 cases");
  });

  it("a ranged pack opens on HUNTS[start], not HUNTS[0]", () => {
    const storage = fakeStorage();
    shareStorage(storage);

    // Guard: the two slices must genuinely start on different positions, or
    // the assertions below could not witness a range that is ignored.
    expect(HUNTS[B[0]].fen).not.toBe(HUNTS[A[0]].fen);

    expect(occupancy(renderHangingHunt(A))).toEqual(parseFEN(HUNTS[A[0]].fen).board);
    expect(occupancy(renderHangingHunt(B))).toEqual(parseFEN(HUNTS[B[0]].fen).board);
  });

  // The quest's OWN key, not just the test's: lesson 17 launches
  // game:"hangingHunt" with gameOpts.range [0,8] (content/lessons.ts), so its
  // progress must land under `hunt_0_8`. Lessons 21/33/46 carry [8,16]/
  // [16,24]/[24,32] and cannot be rendered until HUNTS reaches 32 (an empty
  // slice has no PACK[0]); their sibling-isolation is the property pinned by
  // A/B above, which holds for any two disjoint slices.
  it("a lesson-sized range keys progress on the quest's own hunt_<start>_<end>", () => {
    expect(HUNTS.length).toBeGreaterThanOrEqual(8);
    const storage = fakeStorage();
    shareStorage(storage);
    const seed = createProgressState(storage);
    seed.setTacticSolved("hunt_0_8", 0);

    const html = renderHangingHunt([0, 8]);
    expect(html).toContain("1 / 8 cases");
    expect(dotTag(html, 1)).toContain("border-emerald-500");
    expect(dotTag(html, 2)).not.toContain("border-emerald-500");

    // …and it is that exact key: neither the legacy arcade store nor a
    // different slice whose key merely shares a prefix may see the solve.
    expect(renderHangingHunt(undefined)).toContain(`0 / ${HUNTS.length} cases`);
    expect(renderHangingHunt(A)).toContain("0 / 4 cases");
  });
});
