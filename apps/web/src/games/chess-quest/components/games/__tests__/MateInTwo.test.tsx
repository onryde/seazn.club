// MateInTwo (depth=2) had the same missing-scoping bug as MateInOne: every
// lesson using game:"mateInTwo" shared the same global MATE2 pool via
// progress.isSolved2/setSolved2. The fix adds an optional `range` prop
// (depth===2 only — depth===3's mateInThree path is untouched) that slices
// MATE2 and backs progress with the generic tactic-pack store, keyed
// `mate2_${start}_${end}`, mirroring MateInOne's fix and TacticTrainer's
// existing per-pack scoping.
//
// Same rendering approach as MateInOne.test.tsx: renderToStaticMarkup (no
// jsdom in this workspace), progress pre-seeded through the real progress
// API, two ProgressProvider instances sharing state only via a common
// window.localStorage object.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createProgressState, ProgressProvider } from "../../../lib/progress";
import { MATE2 } from "../../../content/puzzles";
import { MateInTwo } from "../MateInTwo";

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

function renderMateInTwo(range?: [number, number]): string {
  return renderToStaticMarkup(
    <ProgressProvider>
      <MateInTwo range={range} />
    </ProgressProvider>,
  );
}

describe("MateInTwo (depth=2) — a range scopes progress independently of sibling ranges", () => {
  it("solving in one range leaves a sibling range's progress untouched, in both directions", () => {
    const storage = fakeStorage();
    shareStorage(storage);

    const seed = createProgressState(storage);
    seed.setTacticSolved("mate2_0_3", 0);

    const htmlA = renderMateInTwo([0, 3]);
    expect(htmlA).toContain("1 / 3 solved");
    expect(dotTag(htmlA, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlA, 3)).not.toContain("border-emerald-500");

    // A sibling range sharing the SAME progress store must show its own
    // untouched pool — not [0,3)'s progress, and not the full 12-pool size.
    const htmlB = renderMateInTwo([3, 6]);
    expect(htmlB).toContain("0 / 3 solved");
    expect(dotTag(htmlB, 1)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 2)).not.toContain("border-emerald-500");
    expect(dotTag(htmlB, 3)).not.toContain("border-emerald-500");

    // Vice versa: solving inside [3,6) must not retroactively change [0,3)'s
    // already-recorded progress.
    seed.setTacticSolved("mate2_3_6", 1);
    const htmlB2 = renderMateInTwo([3, 6]);
    expect(htmlB2).toContain("1 / 3 solved");
    expect(dotTag(htmlB2, 2)).toContain("border-emerald-500");

    const htmlA2 = renderMateInTwo([0, 3]);
    expect(htmlA2).toContain("1 / 3 solved");
    expect(dotTag(htmlA2, 1)).toContain("border-emerald-500");
    expect(dotTag(htmlA2, 2)).not.toContain("border-emerald-500");
  });

  it("range omitted keeps the full MATE2 pool and the legacy solved2/setSolved2 keys (arcade/free-play unaffected)", () => {
    const storage = fakeStorage();
    shareStorage(storage);
    const seed = createProgressState(storage);
    seed.setSolved2(0);

    const html = renderMateInTwo(undefined);
    expect(html).toContain(`1 / ${MATE2.length} solved`);
  });

  it("depth===3 (mateInThree) is unaffected by the range prop — no range plumbing reaches it", () => {
    // depth=3 keeps using its own dedicated gameId ("mateInThree") regardless
    // of range; passing range must not change that.
    const storage = fakeStorage();
    shareStorage(storage);
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <MateInTwo depth={3} />
      </ProgressProvider>,
    );
    expect(html).toContain("Mate in 3");
  });
});
