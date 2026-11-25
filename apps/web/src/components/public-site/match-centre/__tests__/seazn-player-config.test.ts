// Seazn-hosted video, Task 42: the start rung is hls.js's own cap (seazn-player-config.ts). The cap rule is hls.js's, so the oracle is
// hls.js's: the REAL `CapLevelController.getMaxLevelByMediaSize` (exported by the library, no DOM needed) is run on a rung table for each
// box the match page really has x each pixel ratio, and the start rung taken from that cap must be the rung it names. The sweep reports
// how many cells it checked: zero is a failure.
import { describe, expect, it } from "vitest";
import { CapLevelController } from "hls.js";
import { SEAZN_HLS_PLAYER_CONFIG, startLevelFromCap } from "../seazn-player-config";

/** A Cloudflare live ladder in hls.js's order (ascending bandwidth; seazn-hosted-probes.md C4), 16:9 rungs. */
const LADDER = [240, 360, 480, 720, 1080].map((height, i) => ({ height, width: Math.round((height * 16) / 9 / 2) * 2, bitrate: (i + 1) * 500_000 }));
/** The player frame is 16:9 with a 200 px floor (SEAZN_PLAYER_FRAME); representative card widths at 320, 768 and 1280 viewports. */
const BOXES = [288, 704, 800].map((width) => ({ width, height: Math.max(200, Math.round((width * 9) / 16)) }));
const RATIOS = [1, 2, 3];

describe("startLevelFromCap", () => {
  it("EMPTY CASE FIRST: no cap yet (-1), no rungs, a cap that is no rung -> -1, never rung 0", () => {
    expect(startLevelFromCap(-1, 5)).toBe(-1);
    expect(startLevelFromCap(0, 0)).toBe(-1);
    expect(startLevelFromCap(5, 5)).toBe(-1);
    expect(startLevelFromCap(Number.POSITIVE_INFINITY, 5)).toBe(-1);
    expect(startLevelFromCap(Number.NaN, 5)).toBe(-1);
    expect(startLevelFromCap(1.5, 5)).toBe(-1);
  });

  it("every box x pixel ratio starts on the rung hls.js's own cap names for it (the real library's rule); the sweep is not vacuous", () => {
    let checked = 0;
    const picked = new Set<number>();
    for (const box of BOXES) {
      for (const dpr of RATIOS) {
        const cap = CapLevelController.getMaxLevelByMediaSize(LADDER as never, box.width * dpr, box.height * dpr);
        const start = startLevelFromCap(cap, LADDER.length);
        expect(start, `${box.width}x${box.height} at dpr ${dpr}`).toBe(cap);
        expect(start).toBeGreaterThanOrEqual(0);
        picked.add(start);
        checked++;
      }
    }
    expect(checked, "cells checked").toBe(BOXES.length * RATIOS.length);
    expect(picked.size, "the cap (so the start) moves with the box").toBeGreaterThan(2);
    expect(Math.max(...picked), "a big, dense box reaches the top rung").toBe(LADDER.length - 1);
  });
});

describe("SEAZN_HLS_PLAYER_CONFIG", () => {
  it("caps the rung to the player box (a phone never pulls 1080p into a 360 px box)", () => {
    expect(SEAZN_HLS_PLAYER_CONFIG.capLevelToPlayerSize).toBe(true);
  });
});
