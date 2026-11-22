// Seazn-hosted video, Phase 1 visual re-capture R2: WHEN the island holds its box through an answer with nothing to play. Pure: the
// island owns the state and the timer (seazn-video-island.tsx); this file is the rules.
//
// D1 reserved the player's box before the first read, and collapsed it on any answer with nothing to play. Two states answer exactly
// that, and the player arrives in both a poll later: a session still WARMING, and one just STOPPED whose recording is not locked yet
// (the stream tick's Seazn pass locks it; for `FINALISATION_GRACE_SECONDS` after the end a recording can still appear). Collapsing in
// either and re-expanding when the player came moved the page twice. So while a WAIT is on, the box stays, with one quiet line, and
// goes only when the wait runs out: once, and not again for the empty answers that follow.
//
// Where the wait comes from:
//   - the PAGE, as it was drawn (`holdUntil`, seazn-video-plan.ts): a session of the fixture warming or ended a moment ago;
//   - the island itself: an answer that HAD a player starts one (`holdAfterAnswer`), because the Stop that ends a live comes a poll
//     before the page sees it and its recording is locked up to the grace after the Stop. The empty answers that follow only run it down.
// What it never does: read the route more often, or less. The schedule (seazn-video-schedule.ts) is untouched.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { FINALISATION_GRACE_SECONDS } from "@/server/relay/config";
import { SEAZN_VIDEO_POLL_FLOOR_MS } from "./seazn-video-schedule";

/** How long an empty answer is a wait once a player was on screen: the recording's whole lock window after the Stop
 *  (`FINALISATION_GRACE_SECONDS`, the grace the tick's Seazn pass waits out before it calls a session's recordings settled), plus one
 *  read, because the page may learn of the Stop up to one poll after it happened. */
export const SEAZN_VIDEO_HOLD_MS = FINALISATION_GRACE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS;

/** Whether the stage draws a player for this answer: a live, or at least one `hls` part. (`embed` parts have no rendering until
 *  Task 25, so an answer of those alone is nothing to the stage; seazn-video-schedule's `isEmptyVideo` is the LOOP's word, which counts
 *  them as something.) */
export const showsPlayer = (video: PublicFixtureVideo): boolean => video.live !== null || video.replay.some((p) => p.player === "hls");

/** The wait after an answer (ms since the epoch, or null for none): an answer with a player starts it afresh from this read; one
 *  without leaves it exactly where it was, so a run of empty answers can only run it down. */
export function holdAfterAnswer(until: number | null, video: PublicFixtureVideo, nowMs: number): number | null {
  return showsPlayer(video) ? nowMs + SEAZN_VIDEO_HOLD_MS : until;
}

/** The page's `holdUntil` (an ISO instant) as ms; absent, or not a date, is no wait: a NaN must never hold a box for ever. */
export function parseHold(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds until the box lets go of a wait ending at `until`, or null when no release is to be armed. Before the first answer a
 *  wait that has ALREADY run out is not armed: it is the plan's word from a render that an old cached page can outlive, and the first
 *  answer decides (a live one lands in the box, an empty one lets it go). After an answer, an ended wait lets go at once. */
export function holdWait(until: number, nowMs: number, answered: boolean): number | null {
  const wait = until - nowMs;
  if (!answered && wait <= 0) return null;
  return Math.max(0, wait);
}
