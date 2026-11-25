// Seazn-hosted video, Task 42: the start rung is hls.js's own cap (seazn-player-config.ts). The cap rule is hls.js's, so the oracle is
// hls.js's: the REAL `CapLevelController.getMaxLevelByMediaSize` (exported by the library, no DOM needed) is run on a rung table for each
// box the match page really has x each pixel ratio, and the start rung taken from that cap must be the rung it names. The sweep reports
// how many cells it checked: zero is a failure.
import { describe, expect, it } from "vitest";
import Hls, { CapLevelController, M3U8Parser, PlaylistLevelType } from "hls.js";
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

// Task 52 (owner "yes", 2026-11-25), the brief's numbers, measured live on stg: Cloudflare's live playlist has TARGETDURATION 4, segments
// 3.0-3.33 s, 8 in the window; the native player sat ~6.5 s behind newest data. The player is to sit about ONE segment behind live.
describe("SEAZN_HLS_PLAYER_CONFIG: the live edge (Task 52)", () => {
  /** The brief's values, typed from the brief (not read from the module under test). */
  const BRIEF = { liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 4, maxLiveSyncPlaybackRate: 1.1, lowLatencyMode: true };
  const TARGET_DURATION_S = 4;

  it("carries each live-edge key at the brief's value", () => {
    for (const [key, want] of Object.entries(BRIEF)) {
      expect((SEAZN_HLS_PLAYER_CONFIG as Record<string, unknown>)[key], key).toBe(want);
    }
    expect(Object.keys(BRIEF), "keys checked").toHaveLength(4);
  });

  it("the INSTALLED hls.js takes every key (a key this version ignored would be a dead setting) and differs from its defaults", () => {
    const defaults = new Hls({}).config as unknown as Record<string, unknown>;
    const merged = new Hls({ ...SEAZN_HLS_PLAYER_CONFIG }).config as unknown as Record<string, unknown>;
    let checked = 0;
    for (const [key, want] of Object.entries(BRIEF)) {
      expect(key in defaults, `${key} is a key hls.js ${Hls.version} knows`).toBe(true);
      // lowLatencyMode is pinned, not changed: hls.js's default is already true and the 1.1 catch-up only runs under it.
      if (key === "lowLatencyMode") expect(defaults[key], "PREMISE: the pin states hls.js's own default, the catch-up depends on it").toBe(want);
      else expect(defaults[key], `PREMISE: ${key} default differs, so the setting is observable`).not.toBe(want);
      expect(merged[key], `${key} reaches the instance's own config`).toBe(want);
      checked++;
    }
    expect(checked, "keys checked").toBe(4);
  });

  it("means one target duration behind the edge, and a jump back past four (stg: 4 s -> 4 s behind, 16 s ceiling)", () => {
    const c = SEAZN_HLS_PLAYER_CONFIG;
    expect(c.liveSyncDurationCount * TARGET_DURATION_S, "target latency, s").toBe(4);
    expect(c.liveMaxLatencyDurationCount * TARGET_DURATION_S, "ceiling before a jump back, s").toBe(16);
    expect(c.liveMaxLatencyDurationCount, "hls.js refuses a ceiling at or below the sync count").toBeGreaterThan(c.liveSyncDurationCount);
    expect(c.maxLiveSyncPlaybackRate, "a gentle catch-up, never above 1.1x").toBeLessThanOrEqual(1.1);
    expect(c.maxLiveSyncPlaybackRate).toBeGreaterThan(1);
  });
});

// The EFFECT, not the setting (Task 52 review I1): hls.js's own LatencyController, handed a real parsed CF-shaped live playlist, decides where
// playback joins. The playlist is the stg measurement (TARGETDURATION 4, 3 s segments, 8 in the window, no PROGRAM-DATE-TIME) and the
// expected positions are worked out from ITS numbers (hls.js docs: sync point = live edge minus liveSyncDurationCount x target duration).
describe("the live edge the real hls.js 1.7.4 LatencyController gives that config", () => {
  const TARGET_DURATION_S = 4;
  const SEGMENT_S = 3;
  const SEGMENTS = 8;
  const PLAYLIST = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${TARGET_DURATION_S}`,
    "#EXT-X-MEDIA-SEQUENCE:100",
    ...Array.from({ length: SEGMENTS }, (_, i) => `#EXTINF:${SEGMENT_S}.000,\nseg${100 + i}.ts`),
  ].join("\n");
  const EDGE_S = SEGMENTS * SEGMENT_S;

  /** A real Hls with `config`, a real LevelDetails parsed from the playlist, and nothing else of hls.js stubbed but where the stream controller
   *  reports that level (it has loaded nothing). */
  function liveHls(config: Record<string, unknown>) {
    const h = new Hls(config);
    const details = M3U8Parser.parseLevelPlaylist(PLAYLIST, "https://playback.fake.invalid/t/rung.m3u8", 0, PlaylistLevelType.MAIN, 0, null);
    (h as unknown as { streamController: { getLevelDetails: () => unknown } }).streamController.getLevelDetails = () => details;
    return { h, details };
  }

  it("PREMISE: the parsed playlist is the one the brief measured (live, 4 s target, eight 3 s segments, edge at 24 s)", () => {
    const { details } = liveHls({});
    expect(details.live, "no EXT-X-ENDLIST").toBe(true);
    expect(details.targetduration).toBe(TARGET_DURATION_S);
    expect(details.fragments).toHaveLength(SEGMENTS);
    expect(details.edge).toBe(EDGE_S);
  });

  it("joins one target duration behind the edge with the player's config, against three with hls.js's own defaults", () => {
    const ours = liveHls({ ...SEAZN_HLS_PLAYER_CONFIG }).h;
    const stock = liveHls({}).h;
    expect(stock.liveSyncPosition, "PREMISE: stock hls.js joins 3 target durations behind").toBe(EDGE_S - 3 * TARGET_DURATION_S);
    expect(ours.liveSyncPosition, "the player's config joins 1 target duration behind").toBe(EDGE_S - 1 * TARGET_DURATION_S);
    expect(ours.targetLatency).toBe(TARGET_DURATION_S);
    expect(stock.targetLatency).toBe(3 * TARGET_DURATION_S);
    expect(ours.liveSyncPosition! - stock.liveSyncPosition!, "two target durations closer to the edge").toBe(2 * TARGET_DURATION_S);
  });

  it("jumps back past four target durations (16 s here), where stock hls.js never would", () => {
    expect(liveHls({ ...SEAZN_HLS_PLAYER_CONFIG }).h.maxLatency).toBe(4 * TARGET_DURATION_S);
    expect(liveHls({}).h.maxLatency, "PREMISE: stock has no ceiling").toBe(Infinity);
  });

  it("cannot sit closer to the edge than one target duration, whatever the sync count: 1 is the floor of this knob", () => {
    // liveSyncDurationCount 0 is falsy to hls.js (the default 3 applies), so the floor is shown with the smallest value it honours.
    const { h } = liveHls({ ...SEAZN_HLS_PLAYER_CONFIG, liveSyncDurationCount: 0.1, liveMaxLatencyDurationCount: 4 });
    expect(h.liveSyncPosition).toBe(EDGE_S - TARGET_DURATION_S);
  });
});
