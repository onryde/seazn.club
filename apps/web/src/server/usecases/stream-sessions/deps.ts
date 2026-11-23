import "server-only";
// The ports the application layer works through: SessionDeps and the process defaults (see ./index.ts).
import { relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import { youtubeDriver } from "@/server/youtube/driver";
import type { YouTubePort } from "@/server/youtube/port";
import { replayDriver } from "@/server/video/replay-driver";
import type { ReplayHost } from "@/server/video/replay-ports";
import type { LiveMinutesReader } from "@/server/video/cf-analytics";

/** `youtube` (YouTube Connect T11): the port a Go live on an API-backed destination prepares its broadcast through. Optional
 *  so a rig that streams only to pasted keys need not name one; absent, it is the process's driver (`youtubeOf`).
 *  `replay` (Seazn-hosted video, Task 21) is the same for the host a finished recording is moved to and played from (`replayOf`),
 *  but it is NOT a getter on the process defaults (see `defaultDeps`). `liveMinutes` (Task 31) is Cloudflare's minutes-viewed
 *  reader the daily sweep measures Seazn delivery with; absent, it is the real one (relay-sweep.ts step 7e). */
export interface SessionDeps {
  drivers: RelayDrivers; now: () => Date; appUrl: string; youtube?: YouTubePort; replay?: ReplayHost; liveMinutes?: LiveMinutesReader;
}
export function defaultDeps(appUrl: string): SessionDeps {
  // `youtube` is resolved when READ, not here: `youtubeDriver()` throws on a misspelt YOUTUBE_DRIVER, and every stream route
  // builds these deps — a Stop or a heartbeat on a pasted-key match must not fail on a YouTube setting it never uses.
  // `replay` is deliberately NOT here. A getter is enumerable, so `{ ...defaultDeps(url), now }` (tests do it; a usecase may) would
  // read it, and `replayDriver()` throws on an unset REPLAY_DRIVER under a live relay (stg and prod until Phase 2 is set up).
  // `replayOf` resolves the process driver at the call that needs it.
  return { drivers: relayDrivers(), now: () => new Date(), appUrl, get youtube() { return youtubeDriver(); } };
}
export const youtubeOf = (deps: SessionDeps): YouTubePort => deps.youtube ?? youtubeDriver();
export const replayOf = (deps: SessionDeps): ReplayHost => deps.replay ?? replayDriver();
