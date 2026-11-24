// Seazn-hosted video, Task 42: the hls.js start level the player picks from the size of its own box (seazn-player-config.ts).
// `startLevelFor` is pure (a rung table, a box height, a device pixel ratio -> a rung index), so the whole table is swept: the three
// player boxes the match page really has (the 16:9 frame at 320, 768 and 1280 viewports, its 200 px floor included) x the three
// pixel ratios phones and laptops report. The expected rung is read off the TABLE (the tallest rung that still fits the box in device
// pixels, else the shortest), never off the helper, and the sweep reports how many cells it checked: zero is a failure.
import { describe, expect, it } from "vitest";
import { SEAZN_HLS_PLAYER_CONFIG, startLevelFor, type Rung } from "../seazn-player-config";

/** A Cloudflare live ladder in hls.js's order (ascending BANDWIDTH), as the probes measured it (seazn-hosted-probes.md C4: 240-720
 *  from a 720p input; a 1080p source adds the top rung). Heights only matter; the bitrates keep the ascending order hls.js gives. */
const LADDER: Rung[] = [
  { height: 240, bitrate: 400_000 },
  { height: 360, bitrate: 800_000 },
  { height: 480, bitrate: 1_400_000 },
  { height: 720, bitrate: 2_800_000 },
  { height: 1080, bitrate: 5_000_000 },
];
/** The match page's player frame is `aspect-video min-h-[200px] w-full` (SEAZN_PLAYER_FRAME): its CSS height at a viewport width is
 *  16:9 of the card's inner width, never under 200. The inner widths here are representative (viewport less gutters, the card capped at
 *  1280); the e2e (public-fixture.spec.ts) measures the real box and checks the rung the browser actually asked for. */
const BOXES = [
  { viewport: 320, width: 288 },
  { viewport: 768, width: 704 },
  { viewport: 1280, width: 800 },
].map((b) => ({ ...b, height: Math.max(200, Math.round((b.width * 9) / 16)) }));
const RATIOS = [1, 2, 3];

/** The answer read off the table: the tallest rung whose height fits the box in device pixels, else the shortest rung. */
function expectedIndex(levels: readonly Rung[], deviceHeight: number): number {
  const fits = levels.map((l, i) => ({ l, i })).filter(({ l }) => l.height <= deviceHeight);
  if (fits.length === 0) return levels.reduce((best, l, i) => (l.height < levels[best]!.height ? i : best), 0);
  return fits.reduce((best, c) => (c.l.height > best.l.height ? c : best)).i;
}

describe("startLevelFor", () => {
  it("EMPTY CASE FIRST: no rungs, no usable box, or rungs with no height -> -1 (hls.js's own choice), never rung 0", () => {
    expect(startLevelFor([], 360, 1)).toBe(-1);
    expect(startLevelFor(LADDER, 0, 1)).toBe(-1);
    expect(startLevelFor(LADDER, Number.NaN, 1)).toBe(-1);
    expect(startLevelFor(LADDER, 360, 0)).toBe(-1);
    expect(startLevelFor([{ height: 0, bitrate: 1 }, { height: 0, bitrate: 2 }], 360, 1)).toBe(-1);
  });

  it("every box x pixel ratio picks the tallest rung that fits it; a box under every rung gets the shortest; the sweep is not vacuous", () => {
    let checked = 0;
    const picked = new Set<number>();
    for (const box of BOXES) {
      for (const dpr of RATIOS) {
        const got = startLevelFor(LADDER, box.height, dpr);
        expect(got, `${box.viewport}px viewport (box ${box.height}px) at dpr ${dpr}`).toBe(expectedIndex(LADDER, box.height * dpr));
        picked.add(got);
        checked++;
      }
    }
    expect(checked, "cells checked").toBe(BOXES.length * RATIOS.length);
    // The answer must MOVE with the box: a start level stuck on one rung (the mutant: always 0) cannot pass this.
    expect(picked.size, "distinct rungs picked across the sweep").toBeGreaterThan(2);
    expect(Math.max(...picked), "a big, dense box reaches the top rung").toBe(LADDER.length - 1);
    expect(Math.min(...picked), "the smallest box starts at the bottom").toBe(0);
  });

  it("is a rung of the table whatever order hls.js hands the rungs in (an index into the array it was given)", () => {
    const shuffled = [LADDER[3]!, LADDER[0]!, LADDER[4]!, LADDER[2]!, LADDER[1]!];
    for (const h of [100, 200, 300, 500, 800, 1200]) {
      const i = startLevelFor(shuffled, h, 1);
      expect(shuffled[i]!.height, `box ${h}px`).toBe(LADDER[expectedIndex(LADDER, h)]!.height);
    }
  });

  it("two rungs of one height: the cheaper one (a start must not be the dearest of a tie)", () => {
    const tied: Rung[] = [{ height: 720, bitrate: 3_000_000 }, { height: 720, bitrate: 2_000_000 }, { height: 360, bitrate: 800_000 }];
    expect(tied[startLevelFor(tied, 720, 1)]!.bitrate).toBe(2_000_000);
  });

  it("a rung with no RESOLUTION (height 0) is never the start while a rung with a size exists", () => {
    const mixed: Rung[] = [{ height: 0, bitrate: 100_000 }, { height: 360, bitrate: 800_000 }];
    expect(startLevelFor(mixed, 50, 1), "even when nothing fits, a sized rung beats an unsized one").toBe(1);
  });
});

describe("SEAZN_HLS_PLAYER_CONFIG", () => {
  it("caps the rung to the player box (a phone never pulls 1080p into a 360 px box)", () => {
    expect(SEAZN_HLS_PLAYER_CONFIG.capLevelToPlayerSize).toBe(true);
  });
});
