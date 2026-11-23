// Seazn-hosted video, Phase 1 visual re-capture R2: WHEN the island holds its box through an answer with nothing to play. Pure: the
// island owns the state and the timer (seazn-video-island.tsx); this file is the rules.
//
// D1 reserved the player's box before the first read, and collapsed it on any answer with nothing to play. Two states answer exactly
// that, and the player arrives in both a poll later: a session still WARMING, and one just STOPPED whose recording is not locked yet.
// Collapsing in either and re-expanding when the player came moved the page twice. So while a WAIT is on, the box stays, with one quiet
// line, and goes only when the wait runs out: once, and not again for the empty answers that follow.
//
// How long a stopped session's recording takes to reach a viewer (review I1) is the REAL path, not the storage grace alone: Cloudflare
// finishes it a hold after the input goes (`FINALISATION_GRACE_SECONDS` is the generous bound), the stream tick's Seazn pass then locks it
// at its next firing (up to `STREAM_TICK_PERIOD_SECONDS` on the slowest deployment: stg ticks every 5 minutes), and the island's own
// next read carries it (at most the schedule's ceiling later). A wait shorter than that collapses the box and re-expands it.
//
// Where the wait comes from:
//   - the PAGE, as it was drawn (`holdUntil`, seazn-video-plan.ts): a session of the fixture warming or ended a moment ago, counted from
//     the SESSION's own times, not from the render;
//   - the island itself: an answer that HAD a player starts one (`holdAfterAnswer`), because the Stop that ends a live comes a poll
//     before the page sees it, then takes up to the ending backstop to end, and its recording follows the path above. The empty answers
//     that follow only run it down.
// What it never does: read the route more often, or less. The schedule (seazn-video-schedule.ts) is untouched.
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { ENDING_TIMEOUT_SECONDS, SEAZN_RECORDING_LOCK_BY_SECONDS } from "@/server/relay/config";
import { SEAZN_VIDEO_POLL_CEILING_MS, SEAZN_VIDEO_POLL_FLOOR_MS } from "./seazn-video-schedule";

/** How long after a Seazn session's END its recording can still reach a viewer (ms): the lock lands within
 *  `SEAZN_RECORDING_LOCK_BY_SECONDS` of the end, and the island's next read is at most one backoff ceiling after that. The page's plan
 *  counts a completed session's wait from its `ended_at` with this (seazn-video-plan.ts). */
export const SEAZN_RECORDING_SHOWN_BY_MS = SEAZN_RECORDING_LOCK_BY_SECONDS * 1000 + SEAZN_VIDEO_POLL_CEILING_MS;

/** How long an empty answer is a wait once a player was on screen, from that read: the Stop comes up to one live poll (the floor) after
 *  it, the session takes up to `ENDING_TIMEOUT_SECONDS` (the ending backstop's bound) to end, and the recording reaches a viewer
 *  `SEAZN_RECORDING_SHOWN_BY_MS` after that. Over-holding costs a longer quiet frame for a Stop that recorded nothing; under-holding
 *  is the collapse and re-expand this module exists to prevent. */
export const SEAZN_VIDEO_HOLD_MS = SEAZN_VIDEO_POLL_FLOOR_MS + ENDING_TIMEOUT_SECONDS * 1000 + SEAZN_RECORDING_SHOWN_BY_MS;

/** Whether the stage draws a player for this answer: a live, or any part — the interim `hls` recording or the replay host's `embed`
 *  frame (Task 25, CLS gap 3: an answer of embeds alone is a player, so it starts the wait and never shows the starting line). */
export const showsPlayer = (video: PublicFixtureVideo): boolean => video.live !== null || video.replay.length > 0;

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

/** Milliseconds until the box lets go of a wait ending at `until`: the time left, and 0 for one that has already run out. That includes
 *  the plan's wait on an old cached page whose render the wait outlived, before any answer: the release then drops only the LINE (the
 *  page reserves the box whenever it holds a wait), so the first answer still decides the box, and a route that never answers cannot
 *  keep "shortly" on screen for ever (review m3). */
export const holdWait = (until: number, nowMs: number): number => Math.max(0, until - nowMs);
