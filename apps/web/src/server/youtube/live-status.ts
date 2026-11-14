// server/youtube/live-status.ts - the word the stream panel shows for a YouTube Connect session: ONE of three (lib/youtube.ts
// YOUTUBE_LIVE_WORDS), from what YouTube says of the BROADCAST's life and of its STREAM (streamStatus + healthStatus.status).
//
//   not_live        the broadcast is not live (created, ready, testing - and, since the word set is closed at three, complete, revoked
//                   and absent too: YouTube is not showing this broadcast live, whatever the session thinks)
//   live_receiving  the broadcast is live AND the stream is `active` with health `good` / `ok`
//   live_no_video   the broadcast is live and the stream is not `active`, or is active with health `noData` / `bad` (`revoked` too:
//                   YouTube says the stream's ingestion is revoked, so nothing is arriving)
//   null            NO EVIDENCE. A live broadcast whose stream was not read, or whose stream is `active` but carries no health, tells us
//                   nothing about whether video is arriving. The caller carries the previous word and records nothing - the same
//                   rule as an API error: only an affirmative answer from YouTube moves the word, never a gap in one.
//
// Pure. The reads, the 60 s gate and the events are the use case's (usecases/stream-sessions/youtube-status.ts).
import type { YoutubeLiveWord } from "@/lib/youtube";
import type { BroadcastLife, StreamHealth, StreamStatusInfo } from "./port";

/** Health values that say video is NOT arriving on an active stream. `revoked` is not in the owner's two words (`noData`, `bad`): it is
 *  YouTube's own "this stream's ingestion is revoked", so it reads as no video - flagged in the build report for the owner's ruling. */
const NOT_RECEIVING: ReadonlySet<StreamHealth> = new Set<StreamHealth>(["bad", "noData", "revoked"]);
const RECEIVING: ReadonlySet<StreamHealth> = new Set<StreamHealth>(["good", "ok"]);

/** `stream` is `null` when it was not read (a broadcast that is not live needs no stream read). */
export function youtubeLiveWordOf(life: BroadcastLife, stream: StreamStatusInfo | null): YoutubeLiveWord | null {
  if (life !== "live") return "not_live";
  if (stream === null) return null;
  if (stream.status !== "active") return "live_no_video";
  if (stream.health === null) return null;
  if (RECEIVING.has(stream.health)) return "live_receiving";
  if (NOT_RECEIVING.has(stream.health)) return "live_no_video";
  // A health value that is in neither set is one the port admitted without a ruling here: no word, never a guessed one.
  return null;
}
