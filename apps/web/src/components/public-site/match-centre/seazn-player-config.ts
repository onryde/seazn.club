// Seazn-hosted video (Task 42): what the hls.js player is told about the size of its own box. Pure, and no module import, so it is as
// safe in a client chunk as the schedule. The numbers live HERE, each with its source; the controller (seazn-playback.ts) only wires them.
//
// Why: on stg (2026-11-24) viewers almost never got 1080p. With no start level set, hls.js 1.7.4 starts on `config.startLevel ??
// firstAutoLevel` (level-controller.ts `get startLevel`), and `firstAutoLevel` is picked from a bandwidth estimate that begins at
// `abrEwmaDefaultEstimate` 500 kbps (config.ts) with an up-factor of 0.7 on every climb: a start near the bottom that then climbs a rung
// at a time. With nothing capping it, a 360 px phone box would also pull 1080p the moment ABR could. Two settings, one rule:
//   - `capLevelToPlayerSize`: hls.js's cap-level-controller keeps `hls.autoLevelCapping` at the first rung whose width OR height reaches
//     max(box width, box height) x devicePixelRatio (the rung just AT or above the box, rounded up; the greatest bandwidth of a tie), or
//     the top rung when the box is bigger than every rung (`getMaxLevelByMediaSize`). ABR never picks above it. A phone stops paying for
//     pixels it cannot show; a bigger box (fullscreen) raises the cap and ABR may climb to it.
//   - the first load STARTS on that cap (`startLevelFromCap`), read at the first play, so start and cap are one rule hls.js owns and the
//     two cannot disagree. After the first fragment ABR takes over as before, so a slow link still steps DOWN from the start rung (the
//     cost is that one fragment). The cap needs the manifest to signal a video codec (CF's does: CODECS on each rung); without one it
//     is not computed until the first fragment, and `hls.autoLevelCapping` is -1: the start is left to hls.js.
// What this does NOT do: raise ABR's climb. Whether a fullscreen viewer then sits on 1080p still depends on ABR's bandwidth estimate
// against the 1080p rung's advertised BANDWIDTH (the stg peak was ~10.9 Mbps, with `abrBandWidthUpFactor` 0.7): a link under ~15 Mbps
// stays below it. The ABR factors are left as hls.js ships them until the peak is re-measured after compositor C1.
// Task 52 (owner "yes", 2026-11-25): Chrome 157 says `canPlayType(HLS)` is "maybe", so it took the NATIVE path, where none of this applied,
// and sat 3.8-8.5 s (avg ~6.5 s, about 2 segments) behind its newest buffered data. hls.js is now used wherever `Hls.isSupported()` is
// true (seazn-playback.ts), so this config reaches Chrome, Firefox, Edge, and Safari/iOS 17.1+ (ManagedMediaSource). Only a browser hls.js
// cannot run in, and that plays HLS itself, still has the platform choose.
// The live edge, from the same stg measurement (session 16939105): CF's live playlist has `#EXT-X-TARGETDURATION:4`, segments
// 3.0-3.33 s, 8 in the window, no PROGRAM-DATE-TIME. Each key is hls.js 1.7.4's (`dist/hls.d.ts` HlsConfig; defaults in `src/config.ts`):
//   - `liveSyncDurationCount` (default 3): start, and hold, this many TARGET durations behind the live edge. 1 = one target duration
//     (4 s here, down from 12 s on hls.js's own default); it cannot sit closer than `edge - targetduration` (latency-controller.ts
//     `liveSyncPosition` clamps there), so this is the floor, not the 3.0-3.33 s segment. Each stall raises the target by
//     `liveSyncOnStallIncrease` (default 1 s) up to one more target duration (8 s here) and it never comes back down: a ratchet that
//     moves the re-sync point out on a poor link, not a recovery.
//   - `liveMaxLatencyDurationCount` (default Infinity): more than this many target durations (16 s here) behind the edge, hls.js seeks
//     to the sync point. It is checked at EVERY live playlist update (stream-controller.ts `synchronizeToLiveEdge`), not only after a
//     stall, and also while paused: a viewer who pauses for ~12 s or more is taken back to the sync point at the next update. hls.js
//     refuses a value at or below `liveSyncDurationCount` (config.ts `mergeConfig`), and one set without the other.
//   - `maxLiveSyncPlaybackRate` (default 1 = off): the fastest the element is played to close a gap to the sync point, 1.1x here, a gentle
//     catch-up instead of a jump (latency-controller.ts `onTimeupdate`).
//   - `lowLatencyMode` (default true): pinned, because the catch-up above only runs under it (`onTimeupdate` returns at once without it).
//     Without EXT-X-PART / CAN-BLOCK-RELOAD in the playlist (CF's has none) it changes nothing else here.

/** Config merged into the `new Hls({...})` options. Sources: see above; `capLevelToPlayerSize` default false. */
export const SEAZN_HLS_PLAYER_CONFIG = {
  capLevelToPlayerSize: true,
  liveSyncDurationCount: 1,
  liveMaxLatencyDurationCount: 4,
  maxLiveSyncPlaybackRate: 1.1,
  lowLatencyMode: true,
} as const;

/**
 * The rung to start on from hls.js's own cap (`hls.autoLevelCapping`: -1 when no cap has been computed) for a manifest of `levelCount`
 * rungs: the cap when it names a rung, else -1 (leave the choice to hls.js: no cap yet, no rungs, or a value that is no rung).
 */
export function startLevelFromCap(autoLevelCapping: number, levelCount: number): number {
  return Number.isInteger(autoLevelCapping) && autoLevelCapping >= 0 && autoLevelCapping < levelCount ? autoLevelCapping : -1;
}
