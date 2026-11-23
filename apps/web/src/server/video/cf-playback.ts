import "server-only";
// server/video/cf-playback.ts — signed Cloudflare playback URLs for Seazn-hosted video (Task 13; spec G5, probes C1, C2, C5).
//
// Every Seazn programme input and every recording it makes needs a token to play (Task 12 signs the input, the stream tick's
// Seazn pass signs each recording). The token comes from Cloudflare's own endpoint through the ingest port (C1: no signing key of
// ours), and it is the ONLY protection of live playback (C2: `allowedOrigins` blocks nothing), so it lives 1 h.
//
// One token per uid is shared by every viewer, so it holds no viewer data, and it is cached here: a cached token is reused while
// more than SEAZN_TOKEN_REFRESH_BEFORE_SECONDS of its life is left, else a new one is minted. The cache bounds the provider calls
// by live inputs and recordings, never by viewers — and the entry is the mint IN FLIGHT, so viewers arriving together share it.
// The cache is passed in (`deps.tokenCache`): production wires `processPlaybackTokenCache()`, and each test makes its own.
//
// A FAILED mint is cached too (Phase 1 review I1), under the same key, for SEAZN_TOKEN_FAILURE_CACHE_SECONDS from the moment it
// was asked: inside that window every caller is refused with `PlaybackTokenRecentlyFailed` and Cloudflare is not asked again. Without
// it, a Cloudflare 5xx or 429 turned every open page's poll into a mint on the account prod shares, and the 429s fed themselves.
// The mint itself gives up after SEAZN_TOKEN_MINT_TIMEOUT_MS (the adapter's `AbortSignal.timeout`), so a hung one is a failure too.
//
// The URL shapes are Cloudflare's: `https://<customer host>/<token>/manifest/video.m3u8` (C1) and
// `https://<customer host>/<token>/downloads/default.mp4` (C5). The token is a path segment, never a query string.
import { SEAZN_LIVE_TOKEN_TTL_SECONDS, SEAZN_TOKEN_FAILURE_CACHE_SECONDS, SEAZN_TOKEN_REFRESH_BEFORE_SECONDS, streamPlaybackHost } from "@/server/relay/config";
import type { CallTimeout, IngestProvider } from "@/server/relay/ports";

/** A mint, in flight or done, and when its token expires. */
interface MintedToken { kind: "token"; token: Promise<string>; expiresAtMs: number }
/** A mint that failed, remembered until `expiresAtMs` (the end of its window). It holds no error: the refusal is by name. */
interface FailedMint { kind: "failed"; expiresAtMs: number }
type CachedToken = MintedToken | FailedMint;
/** uid + whether it opens the download → the token minted for it, or its failure. A download token is never served to a viewer. */
export type PlaybackTokenCache = Map<string, CachedToken>;

/** The answer inside a failed mint's window: no provider call was made. Callers that log a failed mint skip this one, so a failure
 *  is logged once per mint, never once per viewer. Its message names no uid and no token. */
export class PlaybackTokenRecentlyFailed extends Error {
  override readonly name = "PlaybackTokenRecentlyFailed";
  constructor() {
    super(`a playback token for this uid failed to mint less than ${SEAZN_TOKEN_FAILURE_CACHE_SECONDS} s ago; it is not asked for again until then`);
  }
}
export const createPlaybackTokenCache = (): PlaybackTokenCache => new Map();

const PROCESS_CACHE: PlaybackTokenCache = createPlaybackTokenCache();
/** The one cache a server process signs through. */
export const processPlaybackTokenCache = (): PlaybackTokenCache => PROCESS_CACHE;

export interface PlaybackDeps { ingest: Pick<IngestProvider, "playbackToken">; tokenCache: PlaybackTokenCache }
export interface SignedPlayback { src: string; expiresAt: string }

/** The customer host the URL is built on. A real-relay deployment without STREAM_PLAYBACK_HOST refuses rather than guess one
 *  (config.ts `streamPlaybackHost`), and it refuses before a token is minted for nothing. */
function hostOrThrow(): string {
  const host = streamPlaybackHost();
  if (!host) throw new Error("signed playback needs STREAM_PLAYBACK_HOST (the Stream customer host), and this deployment has none");
  return host;
}

/** Drops entries whose token has expired, so a long-lived process does not keep every uid it ever signed. */
function prune(cache: PlaybackTokenCache, nowMs: number): void {
  for (const [key, entry] of cache) if (entry.expiresAtMs <= nowMs) cache.delete(key);
}

async function tokenFor(deps: PlaybackDeps, uid: string, downloadable: boolean, now: Date, ttlSeconds: number, o: CallTimeout = {}): Promise<{ token: string; expiresAtMs: number }> {
  const key = `${downloadable ? "download" : "play"}:${uid}`;
  const nowMs = now.getTime();
  const hit = deps.tokenCache.get(key);
  // A failed mint inside its window: refused by name, and Cloudflare is not asked (review I1).
  if (hit?.kind === "failed" && hit.expiresAtMs > nowMs) throw new PlaybackTokenRecentlyFailed();
  // A viewer's token is reused while more than the refresh window is left (the player re-asks before it runs out). A download
  // token is reused only when it lives at least as long as THIS caller asked (review m5): the replay host's fetch can queue for
  // hours, and a token that expires sooner than asked would fail inside it.
  if (hit?.kind === "token") {
    const left = hit.expiresAtMs - nowMs;
    const reusable = downloadable ? left >= ttlSeconds * 1000 : left > SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
    if (reusable) return { token: await hit.token, expiresAtMs: hit.expiresAtMs };
  }
  prune(deps.tokenCache, nowMs);
  // Whole seconds: the `exp` Cloudflare is sent, so the expiry handed out is the one the token carries.
  const expiresAtMs = (Math.floor(nowMs / 1000) + ttlSeconds) * 1000;
  const entry: MintedToken = {
    kind: "token",
    token: deps.ingest.playbackToken(uid, { expiresAt: new Date(expiresAtMs), ...(downloadable ? { downloadable: true } : {}), ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) }),
    expiresAtMs,
  };
  deps.tokenCache.set(key, entry);
  // A failed mint is kept AS a failure, under the same key, for the window counted from when it was asked: every caller awaiting it
  // sees its error, and every caller inside the window is refused without a provider call. A later mint replaces it.
  entry.token.catch(() => {
    if (deps.tokenCache.get(key) === entry) deps.tokenCache.set(key, { kind: "failed", expiresAtMs: nowMs + SEAZN_TOKEN_FAILURE_CACHE_SECONDS * 1000 });
  });
  return { token: await entry.token, expiresAtMs };
}

async function signedManifest(deps: PlaybackDeps, uid: string, now: Date): Promise<SignedPlayback> {
  const host = hostOrThrow();
  const { token, expiresAtMs } = await tokenFor(deps, uid, false, now, SEAZN_LIVE_TOKEN_TTL_SECONDS);
  return { src: `https://${host}/${token}/manifest/video.m3u8`, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** A live Seazn programme input's signed HLS, for the public match page and the organiser's panel (Task 14). */
export function signLivePlayback(deps: PlaybackDeps, inputUid: string, now: Date): Promise<SignedPlayback> {
  return signedManifest(deps, inputUid, now);
}

/** Recommendation 2026-11-21 (G-B, interim replay): a finished recording's signed HLS, from session end until a verified Bunny
 *  copy exists. The SAME code and cache as live, keyed by the uid, so a recording and an input are two entries. Its caller passes
 *  a video uid read from `seazn_locked_videos` — a recording the Seazn pass has already signed — never one from a listing (C6). */
export function signRecordingPlayback(deps: PlaybackDeps, videoUid: string, now: Date): Promise<SignedPlayback> {
  return signedManifest(deps, videoUid, now);
}

/** Cloudflare's own ceiling on a token's `exp`: 24 hours from issuing (OpenAPI, "Create signed URL tokens for videos"). */
const MAX_TOKEN_TTL_SECONDS = 24 * 3600;

/** Phase 2's mover (C5): a recording's MP4 download URL for the replay host to fetch, on a `downloadable` token that lives at
 *  least `ttlSeconds` (a whole number, 1 s to Cloudflare's 24 h). Server-to-host only: never handed to a viewer. `timeoutMs` is the
 *  mint's own (Task 24 review I3: the move's, inside the tick's slice); absent, the mint keeps its 10 s. */
export async function signDownload(deps: PlaybackDeps, videoUid: string, now: Date, ttlSeconds: number, o: CallTimeout = {}): Promise<string> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
    throw new Error(`signDownload: ttlSeconds must be a whole number of seconds from 1 to ${MAX_TOKEN_TTL_SECONDS}, got ${ttlSeconds}`);
  }
  const host = hostOrThrow();
  const { token } = await tokenFor(deps, videoUid, true, now, ttlSeconds, o);
  return `https://${host}/${token}/downloads/default.mp4`;
}
