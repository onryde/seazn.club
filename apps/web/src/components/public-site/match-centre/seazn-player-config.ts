// Seazn-hosted video (Task 42): what the hls.js player is told about the size of its own box. Pure, and no module import, so it is as
// safe in a client chunk as the schedule. The numbers live HERE, each with its source; the controller (seazn-playback.ts) only wires them.
//
// Why: on stg (2026-11-24) viewers almost never got 1080p. hls.js's default is a conservative first estimate (`abrEwmaDefaultEstimate`
// 500 kbps, hls.js config.ts) and safety factors on every up-switch (`abrBandWidthUpFactor` 0.7), so a start on the lowest rung that then
// climbs one rung at a time; and with nothing capping it a 360 px phone box would pull 1080p the moment it could. Two settings fix both
// ends without touching ABR's own judgement of the network:
//   - `capLevelToPlayerSize`: ABR never picks a rung taller than the box (in device pixels; hls.js's cap-level-controller reads the
//     element's rect x devicePixelRatio, `ignoreDevicePixelRatio` false, `maxDevicePixelRatio` unbounded). A phone stops paying for pixels
//     it cannot show; a fullscreen player raises the cap and ABR climbs.
//   - a start rung chosen from the box (`startLevelFor`), applied as `hls.startLevel` once the manifest is parsed and before the first
//     play starts loading (stream-controller.ts startLoad reads `hls.startLevel`; -1 would bitrate-test from rung 0). After the first
//     fragment ABR takes over as before, so a slow link still steps DOWN from the start rung (the only cost is that first fragment).
// Safari and iOS play the master playlist themselves (seazn-playback.ts `native`): none of this applies there; the platform picks.

/** The slice of an hls.js level the start rung is chosen from (`Level.height`, `Level.bitrate`): height 0 = the playlist gave no RESOLUTION. */
export interface Rung {
  height: number;
  bitrate: number;
}

/** Config merged into the `new Hls({...})` options. Source: hls.js 1.7.4 `capLevelToPlayerSize` (default false). */
export const SEAZN_HLS_PLAYER_CONFIG = { capLevelToPlayerSize: true } as const;

/**
 * The index (into `levels`, the array hls.js holds, any order) of the rung to start on: the tallest whose height fits the box in
 * DEVICE pixels (`boxHeightCssPx` x `devicePixelRatio`, the unit hls.js's own cap uses); when none fits, the shortest sized rung; of
 * rungs with one height, the cheapest. -1 (let hls.js choose) when there is nothing to choose from or the box has no usable size: a
 * box not laid out yet reads 0 and must not pin rung 0.
 */
export function startLevelFor(levels: readonly Rung[], boxHeightCssPx: number, devicePixelRatio: number): number {
  const box = boxHeightCssPx * devicePixelRatio;
  if (!Number.isFinite(box) || box <= 0) return -1;
  let fit = -1;
  let shortest = -1;
  const cheaper = (i: number, than: number) => than === -1 || levels[i]!.bitrate < levels[than]!.bitrate;
  for (let i = 0; i < levels.length; i++) {
    const h = levels[i]!.height;
    if (!(h > 0)) continue;
    if (h <= box && (fit === -1 || h > levels[fit]!.height || (h === levels[fit]!.height && cheaper(i, fit)))) fit = i;
    if (shortest === -1 || h < levels[shortest]!.height || (h === levels[shortest]!.height && cheaper(i, shortest))) shortest = i;
  }
  return fit !== -1 ? fit : shortest;
}
