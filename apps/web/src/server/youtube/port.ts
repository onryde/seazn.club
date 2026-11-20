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
 *  Such a refusal is a live-blocked channel: the connection stays `connected` (no reconnect prompt, no 7-day purge clock), the
 *  refusal code is `youtube_live_blocked`. */
export const isLiveBlockedRefusal = (err: unknown): boolean =>
  err instanceof YouTubeError && err.code === "youtube_reconnect_needed" && err.reason === LIVE_PERMISSIONS_REASON;

/** A DEAD GRANT: a reconnect refusal that is not the live-permission one. Only this moves a connection to `reconnect_needed`.
 *  Both predicates answer a plain boolean, NOT a type guard: one that is `err is YouTubeError` narrows its caller's false branch to
 *  `never` when the caller already knows `err` is a YouTubeError (disconnect.ts had to read `err.code` first to get round that). */
export const isDeadGrantRefusal = (err: unknown): boolean =>
  err instanceof YouTubeError && err.code === "youtube_reconnect_needed" && !isLiveBlockedRefusal(err);

/** A broadcast's place in YouTube's life cycle (liveBroadcasts `status.lifeCycleStatus`), plus `absent` for an id YouTube
 *  does not know (deleted, or never there). A runtime list as well as a type, so a sweep (live-status.test.ts) enumerates the very
 *  values the port can answer. */
export const BROADCAST_LIVES = ["created", "ready", "testing", "live", "complete", "revoked", "absent"] as const;
export type BroadcastLife = (typeof BROADCAST_LIVES)[number];

/** What YouTube itself says a broadcast's life cycle is - liveBroadcasts `status.lifeCycleStatus` - for every value the adapter admits.
 *  YouTube documents nine (its discovery document, youtube.googleapis.com/$discovery/rest?version=v3, schema LiveBroadcastStatus):
 *  the eight below and `lifeCycleStatusUnspecified`, the enum's zero value, which the adapter refuses as undocumented-in-practice.
 *  `testStarting` and `liveStarting` are the TRANSITIONAL ones (the discovery document: "Transition into TESTING / LIVE has been requested").
 *
 *  `BroadcastLife` above COLLAPSES the two transitional values to where they are going (`lifeOfCycle`): right for the end step, which
 *  asks "is it running, so complete it". It is WRONG for a status line: a broadcast in `liveStarting` is not live yet (YouTube shows
 *  "Preparing stream"), so the live status word is derived from this raw value, never from the collapsed one. */
export const LIFE_CYCLES = ["created", "ready", "testStarting", "testing", "liveStarting", "live", "complete", "revoked"] as const;
export type LifeCycle = (typeof LIFE_CYCLES)[number];

/** The collapse: a transitional value reads as where it is going. The ONE place it is written (the adapter and the fake both call it). */
export const lifeOfCycle = (c: LifeCycle): Exclude<BroadcastLife, "absent"> =>
  c === "testStarting" ? "testing" : c === "liveStarting" ? "live" : c;

/** A liveStream's `status.streamStatus` (YouTube's discovery document, schema LiveStreamStatus: active, created, error, inactive,
 *  ready), plus `absent` for an id YouTube does not know. `active` is the one that says YouTube is receiving video on the stream. */
export const STREAM_STATUSES = ["created", "ready", "active", "inactive", "error", "absent"] as const;
export type StreamStatus = (typeof STREAM_STATUSES)[number];

/** A liveStream's `status.healthStatus.status` (discovery document, schema LiveStreamHealthStatus: good, ok, bad, noData, revoked - the
 *  reference page developers.google.com/youtube/v3/live/docs/liveStreams lists only the first four; `revoked` is in the discovery enum). */
export const STREAM_HEALTHS = ["good", "ok", "bad", "noData", "revoked"] as const;
export type StreamHealth = (typeof STREAM_HEALTHS)[number];

/** What YouTube says of a stream, read with liveStreams.list(part=status): its status, and the health YouTube reports on it. `health`
 *  is `null` when YouTube gave none (the field is absent for a stream that has never carried video) and for `absent`. */
export interface StreamStatusInfo {
  status: StreamStatus;
  health: StreamHealth | null;
}

/** What YouTube says about a broadcast: its place in the life cycle, and the instants it ACTUALLY started and ended (liveBroadcasts
 *  `snippet.actualStartTime` — "only available once the broadcast's state is live" — and `snippet.actualEndTime` — "only
 *  available once ... complete"; developers.google.com/youtube/v3/live/docs/liveBroadcasts). `null` while YouTube has not said, and
 *  for `absent`. The end step stores them as `actual_start_at` / `actual_end_at` (spec §0 D15).
 *
 *  `madeForKids` is liveBroadcasts `status.madeForKids` - YouTube's CURRENT made-for-kids status of the broadcast, which may differ from
 *  what Seazn declared when it made it (`selfDeclaredMadeForKids`): YouTube can designate a video itself. It rides the same
 *  liveBroadcasts.list(part=status,snippet) read, so reading it costs no call. `null` when YouTube did not say (the field absent or not
 *  a boolean) and for `absent`. The end step ORs a `true` into the broadcast's own stamp (V482): the stamp only ever goes false -> true. */
export interface BroadcastLifeInfo {
  life: BroadcastLife;
  /** What YouTube said, before the collapse (`LIFE_CYCLES`), or `absent`. `life` is always `lifeOfCycle(lifeCycle)`. Only the live status
   *  word reads it (a broadcast in `liveStarting` is not live yet); everything else works from `life`. */
  lifeCycle: LifeCycle | "absent";
  actualStartAt: Date | null;
  actualEndAt: Date | null;
  madeForKids: boolean | null;
}

/** What videos.list(part=id,status) says of a video that still exists. `madeForKids` is its `status.madeForKids` - YouTube's CURRENT
 *  made-for-kids status, which may differ from what Seazn declared (YouTube can designate a video after the end step read it). Only a real
 *  boolean is an answer: the field absent, or anything else, is `null` ("did not say"). The daily re-confirm ORs a `true` into the
 *  broadcast's stamp (V482) and never writes a `false`. */
export interface VideoFacts {
  madeForKids: boolean | null;
}

/** One of the channel's own liveStreams as liveStreams.list(part=snippet, mine=true) describes it: its id, its title and the channel it
 *  belongs to (`snippet.channelId`; `null` when YouTube did not say). Never its key: the key lives in the `cdn` part, which the list
 *  never asks for. The disconnect reads it to find the Seazn-named keys no row of ours records (an orphan) and delete them. */
export interface StreamListing {
  id: string;
  title: string;
  channelId: string | null;
}

/** The longest ONE request to Google may take: a driver bounds every request by it (google.ts's request timeout). A port call is one
 *  request, except `listStreams`, which is one per page and asks its caller's `room` before each, so it too runs past a budget by at
 *  most one request in flight. The end step budgets with it: a call is started only while its slice has time left, so a pass overruns
 *  its slice by at most one call in flight. */
export const YOUTUBE_CALL_BOUND_MS = 10_000;

/** `listStreams`' refusal when its caller's budget ran out between pages (`youtube_unavailable` with this reason): what was read so far
 *  is NOT the channel's list, so it is never answered as one. */
export const LIST_BUDGET_SPENT = "budgetSpent";

export interface YouTubePort {
  readonly mode: "fake" | "live";
  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }>;
  /** `invalid_grant` → YouTubeError `youtube_reconnect_needed`. */
  accessToken(refreshToken: string): Promise<string>;
  listMyChannels(at: string): Promise<{ id: string; title: string }[]>;
  /** READ-ONLY (channels.list part=snippet, mine=true; 1 quota unit): when the channel `channelId` was created - `snippet.publishedAt` of
   *  the grant's channel with that id. Null when the grant lists no such channel, or YouTube gave no readable date. */
  channelCreatedAt(at: string, channelId: string): Promise<Date | null>;
  /** READ-ONLY (liveBroadcasts.list part=snippet,status, mine=true, broadcastType=all; 1 quota unit a page): the token's channel's
   *  broadcasts that actually STARTED at or after `since` (`snippet.actualStartTime`), newest first, with their actual end (null while
   *  live). A broadcast that never started is not listed. Pages until one is older than `since`, at most 3 pages: a warning's input,
   *  so a partial list is an answer, not a refusal. */
  recentBroadcasts(at: string, since: Date): Promise<{ startedAt: Date; endedAt: Date | null }[]>;
  liveEnabled(at: string): Promise<"enabled" | "not_enabled" | "blocked">;
  insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }>;
  /** A stream that is already absent resolves. */
  deleteStream(at: string, streamId: string): Promise<void>;
  /** Every liveStream of the token's channel (all pages): ids, titles, channel ids - never a key. One request per page, each bounded by
   *  YOUTUBE_CALL_BOUND_MS; `room`, when given, is asked before EVERY page, and once it answers no the call is refused
   *  (`youtube_unavailable` / LIST_BUDGET_SPENT) - never a partial list answered as the whole. */
  listStreams(at: string, o?: { room?: () => boolean }): Promise<StreamListing[]>;
  insertBroadcast(
    at: string,
    a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean },
  ): Promise<{ broadcastId: string }>;
  bind(at: string, broadcastId: string, streamId: string): Promise<void>;
  broadcastLife(at: string, broadcastId: string): Promise<BroadcastLifeInfo>;
  /** READ-ONLY (liveStreams.list part=status, 1 quota unit): what YouTube says of the stream a broadcast is bound to - is video arriving
   *  on it (`status` active) and how healthy (`health`). A stream YouTube does not know is `{ status: "absent", health: null }`. A value
   *  Google never documented is refused (`youtube_unavailable`), never guessed at. Nothing is changed at YouTube. */
  streamStatus(at: string, streamId: string): Promise<StreamStatusInfo>;
  /** A broadcast that is already complete resolves. */
  complete(at: string, broadcastId: string): Promise<void>;
  /** A broadcast that is already absent resolves. */
  deleteBroadcast(at: string, broadcastId: string): Promise<void>;
  /** At most 50 ids per call (videos.list's page), otherwise it throws without calling. The keys are the ids YouTube still has (an id it
   *  does not return is absent); each is answered with what the SAME call says of it (`VideoFacts`). */
  existingVideos(at: string, ids: readonly string[]): Promise<Map<string, VideoFacts>>;
  revoke(refreshToken: string): Promise<void>;
}
