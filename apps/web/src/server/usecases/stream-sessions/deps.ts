import "server-only";
// The ports the application layer works through: SessionDeps and the process defaults (see ./index.ts).
import { relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import { youtubeDriver } from "@/server/youtube/driver";
import type { YouTubePort } from "@/server/youtube/port";

/** `youtube` (YouTube Connect T11): the port a Go live on an API-backed destination prepares its broadcast through. Optional
 *  so a rig that streams only to pasted keys need not name one; absent, it is the process's driver (`youtubeOf`). */
export interface SessionDeps { drivers: RelayDrivers; now: () => Date; appUrl: string; youtube?: YouTubePort }
export function defaultDeps(appUrl: string): SessionDeps {
  // `youtube` is resolved when READ, not here: `youtubeDriver()` throws on a misspelt YOUTUBE_DRIVER, and every stream route
  // builds these deps — a Stop or a heartbeat on a pasted-key match must not fail on a YouTube setting it never uses.
  return { drivers: relayDrivers(), now: () => new Date(), appUrl, get youtube() { return youtubeDriver(); } };
}
export const youtubeOf = (deps: SessionDeps): YouTubePort => deps.youtube ?? youtubeDriver();
