import "server-only";
// The ports the application layer works through: SessionDeps and the process defaults (see ./index.ts).
import { dbRecorder, relayDrivers, type RelayDrivers } from "@/server/relay/drivers";
import { youtubeDriver } from "@/server/youtube/driver";
import type { YouTubePort } from "@/server/youtube/port";
import { replayDriver } from "@/server/video/replay-driver";
import type { ReplayHost } from "@/server/video/replay-ports";
import { type LiveMinutesReader, liveMinutesViewed } from "@/server/video/cf-analytics";
import { broadcast, mintCaptureToken, type RealtimeMessage } from "@/lib/realtime";

/** Push nudges (spec 2026-11-24 §2.1, plan T1.3): what a current pairing's beat answer gets its `realtime` through — the
 *  subscriber JWT for the pairing's private topic, and the Supabase project the phone joins. `config` is null when this
 *  deployment configures no Supabase (CI's smoke server, a bare dev box): the answer then carries no channel. */
export interface CaptureRealtimePort {
  mint(pairingId: string, expiresAt: Date): Promise<string>;
  config(): { url: string; apikey: string } | null;
}

/** `youtube` (YouTube Connect T11): the port a Go live on an API-backed destination prepares its broadcast through. Optional
 *  so a rig that streams only to pasted keys need not name one; absent, it is the process's driver (`youtubeOf`).
 *  `replay` (Seazn-hosted video, Task 21) is the same for the host a finished recording is moved to and played from (`replayOf`),
 *  but it is NOT a getter on the process defaults (see `defaultDeps`). `liveMinutes` (Task 31) is Cloudflare's minutes-viewed
 *  reader the daily sweep measures Seazn delivery with; absent, it is the real one (`liveMinutesOf`; the daily sweep's step 7e).
 *  `realtime` (push nudges, plan T1.3) is the capture beat's realtime port; absent, it is the process's own (`realtimeOf`), and
 *  like `replay` it is NOT on the process defaults. `publish` (push nudges, plan T1.4) is the transport the capture nudges go out
 *  on (`./nudge.ts`); absent, it is the process's `broadcast`, which sends nothing when publishing is off or unconfigured. */
export interface SessionDeps {
  drivers: RelayDrivers; now: () => Date; appUrl: string; youtube?: YouTubePort; replay?: ReplayHost; liveMinutes?: LiveMinutesReader;
  realtime?: CaptureRealtimePort;
  publish?: (messages: readonly RealtimeMessage[], label: string) => Promise<void>;
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
/** Cloudflare's minutes-viewed reader: the deps' own, else the real one, its calls recorded as every Cloudflare call is (Task 31). */
export const liveMinutesOf = (deps: SessionDeps): LiveMinutesReader =>
  deps.liveMinutes ?? ((uids, from, to) => liveMinutesViewed(uids, from, to, { recorder: dbRecorder }));
/** The process's realtime port: the real mint, and the project NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY name,
 *  read at the call and passed on RAW (the guard in usecases/capture-realtime.ts refuses a padded or query-bearing url; this
 *  trims nothing). Either one unset or empty is no Supabase at all. */
const processRealtime: CaptureRealtimePort = {
  mint: mintCaptureToken,
  config() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const apikey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    return url && apikey ? { url, apikey } : null;
  },
};
/** The capture beat's realtime port: the deps' own, else the process's. */
export const realtimeOf = (deps: SessionDeps): CaptureRealtimePort => deps.realtime ?? processRealtime;
/** The capture nudges' transport: the deps' own, else the process's `broadcast` (never throws; a kill switch and a missing project send nothing). */
export const publishOf = (deps: Pick<SessionDeps, "publish"> | undefined): NonNullable<SessionDeps["publish"]> => deps?.publish ?? broadcast;
