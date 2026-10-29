// server/youtube/port.ts — the seam every YouTube Connect batch codes against (plan T5): the `YouTubePort` interface, the
// `YouTubeError` it throws, and the closed set of codes that error can carry. Two implementations stand behind it: the
// deterministic in-memory `FakeYouTube` (fake.ts) and the Google driver (google.ts, T6); driver.ts picks one per process.
//
// SECRETS (spec §7, controller ruling for T5). A refresh token, an access token, a stream key, an ingestion URL and a
// Google response body never reach a log line, an error message or a thrown Error. pino's `redact` list (logger.ts) matches
// ONE level deep, and `pino.stdSerializers.err` copies every enumerable field of an error AND its `cause` chain, so the
// only safe error is one that never held a raw provider error in the first place. A driver therefore maps whatever Google
// said to a CODE (closed set) and, at most, Google's own REASON token (`liveStreamingNotEnabled` — letters only, 64 at
// most) BEFORE it constructs a `YouTubeError`; this class then enforces both shapes itself, so a caller that passes a body,
// a form-encoded `refresh_token=…` string or a token as the reason gets an empty reason, never a part of it. It takes no
// `cause` for the same reason.
import type { YoutubePrivacy, YoutubeRefusalCode } from "@/lib/youtube";

/** What YouTube (or its fake) can refuse with. `youtube_channel_busy` is absent on purpose: it is Seazn's own answer from
 *  the key pool, never something YouTube says. `youtube_not_found` is a missing broadcast, stream or video. */
export type YoutubeErrorCode = Exclude<YoutubeRefusalCode, "youtube_channel_busy"> | "youtube_not_found";

// A Record, not an array: tsc then refuses a code added to the union above and forgotten here.
const ERROR_CODE_SET: Record<YoutubeErrorCode, true> = {
  youtube_reconnect_needed: true,
  youtube_live_not_enabled: true,
  youtube_live_blocked: true,
  youtube_limit_reached: true,
  youtube_unavailable: true,
  youtube_not_found: true,
};
export const YOUTUBE_ERROR_CODES = Object.keys(ERROR_CODE_SET) as YoutubeErrorCode[];

/** Google's `error.errors[].reason` is a camelCase token (`liveStreamingNotEnabled`, `rateLimitExceeded`). Anything that is
 *  not that shape — a body, a URL, a form string, a token — is not a reason and is dropped whole (never truncated: a cut
 *  token is still part of a token). */
const REASON_SHAPE = /^[A-Za-z]{0,64}$/;

export class YouTubeError extends Error {
  readonly code: YoutubeErrorCode;
  /** Google's reason token, `[A-Za-z]{0,64}`; `""` when there was none or it was not that shape. Never a body. */
  readonly reason: string;

  constructor(code: YoutubeErrorCode, reason: string = "") {
    // The type already restricts `code`; the check is for the value that arrives from JSON (the fake control route) or an
    // `as` cast. A code outside the closed set becomes `youtube_unavailable` rather than being echoed into a message.
    const safeCode: YoutubeErrorCode = Object.hasOwn(ERROR_CODE_SET, code) ? code : "youtube_unavailable";
    const safeReason = typeof reason === "string" && REASON_SHAPE.test(reason) ? reason : "";
    super(safeReason ? `${safeCode} (${safeReason})` : safeCode);
    this.name = "YouTubeError";
    this.code = safeCode;
    this.reason = safeReason;
  }
}

/** Google's reason for "the request is not authorized to <live>" (the liveBroadcasts / liveStreams pages, google.ts maps it to
 *  `youtube_reconnect_needed`). It is a fact about the CHANNEL's live permission, not about the grant: a reconnect of the same account
 *  does not cure it, so it is NOT a dead grant (controller ruling, T17 carry g). */
export const LIVE_PERMISSIONS_REASON = "insufficientLivePermissions";

/** The ONE predicate for that refusal - the daily health check, Go live's prepare and the end step all ask it, so they cannot disagree.
 *  Such a refusal is a live-blocked channel: the connection stays `connected` (no reconnect prompt, no 30-day purge clock), the
 *  refusal code is `youtube_live_blocked`. */
export const isLiveBlockedRefusal = (err: unknown): err is YouTubeError =>
  err instanceof YouTubeError && err.code === "youtube_reconnect_needed" && err.reason === LIVE_PERMISSIONS_REASON;

/** A DEAD GRANT: a reconnect refusal that is not the live-permission one. Only this moves a connection to `reconnect_needed`. */
export const isDeadGrantRefusal = (err: unknown): err is YouTubeError =>
  err instanceof YouTubeError && err.code === "youtube_reconnect_needed" && !isLiveBlockedRefusal(err);

/** A broadcast's place in YouTube's life cycle (liveBroadcasts `status.lifeCycleStatus`), plus `absent` for an id YouTube
 *  does not know (deleted, or never there). */
export type BroadcastLife = "created" | "ready" | "testing" | "live" | "complete" | "revoked" | "absent";

/** What YouTube says about a broadcast: its place in the life cycle, and the instants it ACTUALLY started and ended (liveBroadcasts
 *  `snippet.actualStartTime` — "only available once the broadcast's state is live" — and `snippet.actualEndTime` — "only
 *  available once ... complete"; developers.google.com/youtube/v3/live/docs/liveBroadcasts). `null` while YouTube has not said, and
 *  for `absent`. The end step stores them as `actual_start_at` / `actual_end_at` (spec §0 D15). */
export interface BroadcastLifeInfo {
  life: BroadcastLife;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
}

/** The longest ONE port call may take: a driver bounds every request by it (google.ts's request timeout). The end step budgets with it:
 *  a call is started only while its slice has time left, so a pass overruns its slice by at most one call in flight. */
export const YOUTUBE_CALL_BOUND_MS = 10_000;

export interface YouTubePort {
  readonly mode: "fake" | "live";
  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }>;
  /** `invalid_grant` → YouTubeError `youtube_reconnect_needed`. */
  accessToken(refreshToken: string): Promise<string>;
  listMyChannels(at: string): Promise<{ id: string; title: string }[]>;
  liveEnabled(at: string): Promise<"enabled" | "not_enabled" | "blocked">;
  insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }>;
  /** A stream that is already absent resolves. */
  deleteStream(at: string, streamId: string): Promise<void>;
  insertBroadcast(
    at: string,
    a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean },
  ): Promise<{ broadcastId: string }>;
  bind(at: string, broadcastId: string, streamId: string): Promise<void>;
  broadcastLife(at: string, broadcastId: string): Promise<BroadcastLifeInfo>;
  /** A broadcast that is already complete resolves. */
  complete(at: string, broadcastId: string): Promise<void>;
  /** A broadcast that is already absent resolves. */
  deleteBroadcast(at: string, broadcastId: string): Promise<void>;
  /** At most 50 ids per call (videos.list's page), otherwise it throws without calling. */
  existingVideos(at: string, ids: readonly string[]): Promise<Set<string>>;
  revoke(refreshToken: string): Promise<void>;
}
