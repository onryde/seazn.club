import "server-only";
// server/youtube/google.ts — the live YouTube driver (plan T6): `GoogleYouTube` implements the port against Google's OAuth and
// YouTube Data API v3 with plain `fetch`, no SDK. driver.ts hands it out when YOUTUBE_DRIVER resolves to `live`.
//
// The FAKE (fake.ts) is the contract this class matches: the same situation gives the caller the same `YouTubeError` (code,
// reason) from either. Every request shape below is Google's, from the pages named at each method (read 2026-10-27).
//
// SECRETS (spec §7; controller ruling for T5/T6). A refresh token, an access token, the client secret, an authorization code,
// a PKCE verifier and a Google response body never reach a log line, an Error message or a thrown object:
//   * tokens ride in the `Authorization` header (Data API) or a POST FORM BODY (token, tokeninfo, revoke) — never a URL;
//   * every failure is turned into a `YouTubeError` HERE, from a code (`mapGoogleError`) and, at most, Google's own reason token
//     (`liveStreamingNotEnabled`; letters only). The raw fetch/parse error is DROPPED, not wrapped: pino's err serializer copies
//     an error's `cause` chain and its redact list is one level deep, and `JSON.parse`'s message quotes its input, so nothing
//     that ever held a response or a request body is allowed to leave a catch block.
// No retry and no logging here: the callers own backoff and they log codes.
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, googleConfigured } from "@/lib/oauth";
import { YOUTUBE_SCOPE, type YoutubePrivacy } from "@/lib/youtube";
import {
  LIST_BUDGET_SPENT, YOUTUBE_CALL_BOUND_MS, YouTubeError, type BroadcastLife, type BroadcastLifeInfo, type StreamListing, type VideoFacts, type YoutubeErrorCode, type YouTubePort,
} from "./port";

const API = "https://www.googleapis.com/youtube/v3";
/** OAuth 2.0 token revocation (…/oauth2/web-server, "Token revocation"). Google's example puts `token` in the query string; we
 *  send it as a form body (RFC 7009 §2.1) so a secret never sits in a URL. */
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Token introspection (docs.cloud.google.com/docs/authentication/token-types shows a GET with `?access_token=`; the plan's F12
 *  prescribes a POST with the token in the body). Best effort: see `subjectOf`. */
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** One request, from `fetch` to the last byte of the body, has this long (the port's call bound: the end step budgets with it). */
const REQUEST_TIMEOUT_MS = YOUTUBE_CALL_BOUND_MS;
/** videos.list takes at most 50 ids per call. */
const MAX_VIDEO_IDS_PER_CALL = 50;
/** liveStreams.list's page: `maxResults` 0-50 (the liveStreams.list page). */
const STREAMS_PER_PAGE = 50;
/** At most this many pages of liveStreams (500 streams) are read; a channel with more is refused rather than half-read (the disconnect
 *  deletes from the answer and reports what it could not reach, so a list that stops early must not pass for the whole channel). Each page
 *  is one request under the call bound, so the cap also bounds how long the disconnect waits on the list. */
const MAX_STREAM_PAGES = 10;
/** A broadcast title: 1–100 characters (liveBroadcasts.insert "invalidTitle"), and neither `<` nor `>` (the videos resource's
 *  `snippet.title`: a broadcast is one video). Counted in code points. The same rule, and the same refusal, as the fake. */
const BROADCAST_TITLE_MAX_CHARS = 100;

// ─── error mapping ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Google's reason tokens, from the pages named. `reason` is `error.errors[0].reason` of a Data API error.
/** The token (or the grant) cannot be used any more: the club has to reconnect. */
const RECONNECT_REASONS = new Set([
  "authError",                    // 401 "Invalid Credentials": an expired or revoked access token
  "authorizationRequired",        // 401, errors page: the `mine` parameter without proper authorisation
  "insufficientPermissions",      // 403, errors page: the token's scopes do not cover the data
  "insufficientLivePermissions",  // liveBroadcasts / liveStreams pages: "the request is not authorized to …"
]);
/** The channel (or the project) is out of something. */
const LIMIT_REASONS = new Set([
  "limitExceeded", "userBroadcastsExceedLimit",                           // liveBroadcasts.insert
  "rateLimitExceeded", "userRequestsExceedRateLimit",                     // every live method
  "quotaExceeded", "dailyLimitExceeded",                                  // errors page: the project's quota
  "concurrentBroadcastsExceedLimit", "sharedIngestionBroadcastsExceedLimit",   // liveBroadcasts.transition: the channel's 10, the key's 3
]);
/** The resource is gone — only ever as a 404. */
const GONE_REASONS = new Set(["liveBroadcastNotFound", "liveStreamNotFound", "videoNotFound"]);

/** Google's answer to a closed code (spec §6.2). Pure; the table is pinned in google.test.ts.
 *
 *  ORDER MATTERS. `youtubeSignupRequired` is an HTTP **401** (errors page: "an unlinked Google Account" — no YouTube channel),
 *  so it is decided BEFORE the generic 401 -> reconnect rule: the token is good, reconnecting the same account cannot help, and
 *  the fake answers `youtube_unavailable` for the same account. A 404 is "gone" only for a reason that says so (a wrong URL
 *  must not read as "already deleted"). An OAuth error from the token endpoint is the club's to fix only when it is
 *  `invalid_grant`; `invalid_client` and the rest are Seazn's own configuration. Anything unrecognised is `youtube_unavailable`. */
export function mapGoogleError(a: { status: number; reason?: string; oauthError?: string }): YoutubeErrorCode {
  if (a.oauthError !== undefined) return a.oauthError === "invalid_grant" ? "youtube_reconnect_needed" : "youtube_unavailable";
  const reason = a.reason ?? "";
  if (reason === "youtubeSignupRequired") return "youtube_unavailable";
  if (reason === "liveStreamingNotEnabled") return "youtube_live_not_enabled";
  if (reason === "livePermissionBlocked") return "youtube_live_blocked";
  if (LIMIT_REASONS.has(reason)) return "youtube_limit_reached";
  if (RECONNECT_REASONS.has(reason)) return "youtube_reconnect_needed";
  if (a.status === 404 && GONE_REASONS.has(reason)) return "youtube_not_found";
  if (a.status === 401) return "youtube_reconnect_needed";
  if (a.status === 429) return "youtube_limit_reached";
  return "youtube_unavailable";
}

/** `invalid_grant` -> `invalidGrant`: the camelCase reason token the fake uses for the same refusal. */
const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const asRecord = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** An ISO 8601 timestamp string as a Date; anything else (absent, not a string, not a date) is null. */
const isoDate = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;   // "" and any unparseable string are Invalid Date: the NaN check below
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** What a failed response says, reduced to the two tokens we may keep: a Data API `reason` (letters only) or an OAuth `error`
 *  (`[a-z_]`). Anything else — a message, a description, a body — is read and DISCARDED here. A parse failure is not an error:
 *  an HTML page from a proxy is just "no reason". */
function describeError(text: string): { reason?: string; oauthError?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const err = asRecord(parsed)?.error;
  // The token, revoke and tokeninfo endpoints write `{"error":"invalid_grant","error_description":…}`.
  if (typeof err === "string") return { oauthError: /^[a-z_]{1,64}$/.test(err) ? err : "unrecognised" };
  // The Data API writes `{"error":{"code":403,"errors":[{"reason":"…"}]}}`.
  const first = asRecord(Array.isArray(asRecord(err)?.errors) ? (asRecord(err)!.errors as unknown[])[0] : null);
  const reason = first?.reason;
  return typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason) ? { reason } : {};
}

interface Raw { status: number; ok: boolean; text: string }

/** Throws the `YouTubeError` for a failed response. Never returns. */
function refuse(r: Raw): never {
  const { reason, oauthError } = describeError(r.text);
  throw new YouTubeError(mapGoogleError({ status: r.status, reason, oauthError }), reason ?? (oauthError ? camel(oauthError) : ""));
}

/** A 2xx body that must be a JSON object. `JSON.parse`'s own error is dropped (its message quotes the input). */
function parseBody(r: Raw): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    parsed = null;
  }
  const obj = asRecord(parsed);
  if (!obj) throw new YouTubeError("youtube_unavailable", "malformedResponse");
  return obj;
}
const malformed = (): never => {
  throw new YouTubeError("youtube_unavailable", "malformedResponse");
};

/** One HTTP exchange, bounded by REQUEST_TIMEOUT_MS from the request to the end of the body. A redirect is an error (an
 *  Authorization header must not follow one) and nothing is served from a cache (a broadcast's life is live state). Whatever
 *  `fetch` throws is replaced by a code: a timeout, or "network". */
async function send(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Raw> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: ctl.signal });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch {
    // Dropped on purpose: the error may quote the URL and the body, which hold the tokens.
    throw new YouTubeError("youtube_unavailable", timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

/** The OAuth client Seazn signs in with also connects YouTube (one client, one consent screen). */
function credentials(): { id: string; secret: string } {
  if (!googleConfigured()) throw new YouTubeError("youtube_unavailable", "notConfigured");
  return { id: process.env.GOOGLE_CLIENT_ID as string, secret: process.env.GOOGLE_CLIENT_SECRET as string };
}

/** POST an application/x-www-form-urlencoded body: where every OAuth secret travels. */
const form = (url: string, fields: Record<string, string>): Promise<Raw> =>
  send(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

/** A Data API call. The access token is in the Authorization header; `query` holds ids and part lists only. */
async function api(
  at: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  o: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Raw> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `Bearer ${at}` };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await send(url.toString(), { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  if (!r.ok) refuse(r);
  return r;
}

/** A DELETE of something already gone resolves (the port's contract for deleteBroadcast / deleteStream). */
async function deleteResource(at: string, path: "liveBroadcasts" | "liveStreams", id: string): Promise<void> {
  try {
    await api(at, "DELETE", path, { query: { id } });
  } catch (e) {
    if (e instanceof YouTubeError && e.code === "youtube_not_found") return;
    throw e;
  }
}

// liveBroadcasts `status.lifeCycleStatus` -> the port's BroadcastLife. The two transitional values read as where they are going.
const LIFE: Record<string, Exclude<BroadcastLife, "absent">> = {
  created: "created", ready: "ready", testStarting: "testing", testing: "testing", liveStarting: "live", live: "live",
  complete: "complete", revoked: "revoked",
};

const badTitle = (t: unknown): boolean => typeof t !== "string" || t.trim() === "" || Array.from(t).length > BROADCAST_TITLE_MAX_CHARS || /[<>]/.test(t);

export class GoogleYouTube implements YouTubePort {
  readonly mode = "live" as const;

  /** …/oauth2/web-server: `access_type=offline` (a refresh token), `prompt=consent` (one, every time), PKCE S256, and the one
   *  scope the feature asks for. No `include_granted_scopes`: the grant is exactly the YouTube scope. No request is made. */
  authorizeUrl(a: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", credentials().id);
    url.searchParams.set("redirect_uri", a.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", YOUTUBE_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", a.state);
    url.searchParams.set("code_challenge", a.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(a: { code: string; codeVerifier: string; redirectUri: string }): Promise<{ refreshToken: string; scope: string; googleSub: string | null }> {
    const c = credentials();
    const r = await form(GOOGLE_TOKEN_URL, {
      grant_type: "authorization_code", code: a.code, code_verifier: a.codeVerifier, redirect_uri: a.redirectUri, client_id: c.id, client_secret: c.secret,
    });
    if (!r.ok) refuse(r);
    const body = parseBody(r);
    const accessToken = nonEmpty(body.access_token) ?? malformed();
    // prompt=consent always yields a refresh token; a grant without one cannot run a match, and connecting again fixes it.
    const refreshToken = nonEmpty(body.refresh_token);
    if (!refreshToken) throw new YouTubeError("youtube_reconnect_needed", "noRefreshToken");
    return { refreshToken, scope: typeof body.scope === "string" ? body.scope : "", googleSub: await this.subjectOf(accessToken) };
  }

  /** The Google account's `sub` (F12). BEST EFFORT, and null is a normal answer: with the `youtube` scope alone (no `openid`)
   *  Google's docs do not promise a `sub`, and only an identity-scoped example shows one. Any failure — an HTTP error, a
   *  network error, a body without a string `sub` — is null; the connect never fails for it. The token is sent in the body. */
  private async subjectOf(accessToken: string): Promise<string | null> {
    try {
      const r = await form(GOOGLE_TOKENINFO_URL, { access_token: accessToken });
      if (!r.ok) return null;
      const sub = parseBody(r).sub;
      return typeof sub === "string" && sub.length > 0 && sub.length <= 255 ? sub : null;
    } catch {
      return null;
    }
  }

  async accessToken(refreshToken: string): Promise<string> {
    const c = credentials();
    const r = await form(GOOGLE_TOKEN_URL, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: c.id, client_secret: c.secret });
    if (!r.ok) refuse(r);
    return nonEmpty(parseBody(r).access_token) ?? malformed();
  }

  /** channels.list(mine=true), …/v3/docs/channels/list. Google leaves `items` out of an empty list. */
  async listMyChannels(at: string): Promise<{ id: string; title: string }[]> {
    const items = parseBody(await api(at, "GET", "channels", { query: { part: "snippet", mine: "true", maxResults: "50" } })).items;
    const out: { id: string; title: string }[] = [];
    for (const item of Array.isArray(items) ? items : []) {
      const row = asRecord(item);
      const id = nonEmpty(row?.id);
      if (id) out.push({ id, title: typeof asRecord(row?.snippet)?.title === "string" ? (asRecord(row?.snippet)!.title as string) : "" });
    }
    return out;
  }

  /** There is no "is live enabled" call: the cheapest probe is liveBroadcasts.list(mine) (1 quota unit), which refuses with
   *  `liveStreamingNotEnabled` for a channel that cannot stream. Only the two eligibility refusals are answers; a dead token or
   *  an outage is thrown. */
  async liveEnabled(at: string): Promise<"enabled" | "not_enabled" | "blocked"> {
    try {
      parseBody(await api(at, "GET", "liveBroadcasts", { query: { part: "id", mine: "true", maxResults: "1" } }));
      return "enabled";
    } catch (e) {
      if (e instanceof YouTubeError && e.code === "youtube_live_not_enabled") return "not_enabled";
      if (e instanceof YouTubeError && e.code === "youtube_live_blocked") return "blocked";
      throw e;
    }
  }

  /** liveStreams.insert: a REUSABLE rtmp stream. The docs require `cdn.frameRate` and `cdn.resolution` with `ingestionType`;
   *  "variable" for both lets YouTube detect them from the incoming video. */
  async insertStream(at: string, a: { title: string }): Promise<{ streamId: string; ingest: { url: string; streamKey: string } }> {
    const body = parseBody(
      await api(at, "POST", "liveStreams", {
        query: { part: "snippet,cdn,contentDetails" },
        body: {
          snippet: { title: a.title },
          cdn: { ingestionType: "rtmp", frameRate: "variable", resolution: "variable" },
          contentDetails: { isReusable: true },
        },
      }),
    );
    const info = asRecord(asRecord(body.cdn)?.ingestionInfo);
    const streamId = nonEmpty(body.id);
    const url = nonEmpty(info?.ingestionAddress);
    const streamKey = nonEmpty(info?.streamName);
    if (!streamId || !url || !streamKey) return malformed();
    return { streamId, ingest: { url, streamKey } };
  }

  async deleteStream(at: string, streamId: string): Promise<void> {
    await deleteResource(at, "liveStreams", streamId);
  }

  /** liveStreams.list(part=snippet, mine=true), …/live/docs/liveStreams/list: the channel's own streams, 50 a page, following
   *  `nextPageToken`. `part` is `snippet` ALONE and never `cdn`: the `cdn` part carries `ingestionInfo.streamName`, the stream key,
   *  which this call must never fetch - and only id, title and channel id are read from whatever comes back. A page token that
   *  repeats (a loop), a list longer than MAX_STREAM_PAGES and a caller's budget that runs out between pages (`room`, asked before
   *  every page) are refused, never answered with a partial list. */
  async listStreams(at: string, o: { room?: () => boolean } = {}): Promise<StreamListing[]> {
    const out: StreamListing[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_STREAM_PAGES; page++) {
      if (o.room && !o.room()) throw new YouTubeError("youtube_unavailable", LIST_BUDGET_SPENT);
      const query: Record<string, string> = { part: "snippet", mine: "true", maxResults: String(STREAMS_PER_PAGE) };
      if (pageToken !== null) query.pageToken = pageToken;
      const body = parseBody(await api(at, "GET", "liveStreams", { query }));
      for (const item of Array.isArray(body.items) ? body.items : []) {
        const row = asRecord(item);
        const id = nonEmpty(row?.id);
        if (!id) continue;
        const snippet = asRecord(row?.snippet);
        out.push({ id, title: typeof snippet?.title === "string" ? snippet.title : "", channelId: nonEmpty(snippet?.channelId) });
      }
      const next = nonEmpty(body.nextPageToken);
      if (next === null) return out;
      if (seen.has(next)) return malformed();
      seen.add(next);
      pageToken = next;
    }
    throw new YouTubeError("youtube_unavailable", "tooManyPages");
  }

  /** liveBroadcasts.insert. `enableAutoStart` starts it when video arrives; `enableAutoStop` is FALSE (a pause in the video
   *  must not end the match: Seazn ends it with `complete`); the monitor stream is off (no testing stage). The title is checked
   *  first, exactly as the fake does, so a title YouTube would refuse is never sent. */
  async insertBroadcast(
    at: string,
    a: { title: string; description: string; scheduledStart: Date; privacy: YoutubePrivacy; madeForKids: boolean },
  ): Promise<{ broadcastId: string }> {
    if (badTitle(a.title)) throw new YouTubeError("youtube_unavailable", "invalidTitle");
    const body = parseBody(
      await api(at, "POST", "liveBroadcasts", {
        query: { part: "snippet,status,contentDetails" },
        body: {
          snippet: { title: a.title, description: a.description, scheduledStartTime: a.scheduledStart.toISOString() },
          status: { privacyStatus: a.privacy, selfDeclaredMadeForKids: a.madeForKids },
          contentDetails: { enableAutoStart: true, enableAutoStop: false, monitorStream: { enableMonitorStream: false } },
        },
      }),
    );
    return { broadcastId: nonEmpty(body.id) ?? malformed() };
  }

  async bind(at: string, broadcastId: string, streamId: string): Promise<void> {
    await api(at, "POST", "liveBroadcasts/bind", { query: { id: broadcastId, streamId, part: "id" } });
  }

  /** liveBroadcasts.list(part=status,snippet, id): the life cycle from `status.lifeCycleStatus`, and the instants YouTube says it
   *  ACTUALLY started and ended from `snippet.actualStartTime` / `actualEndTime` (ISO 8601; the resource page says they are only
   *  there once the broadcast is live / complete). A time that is absent, or not a date, is `null`: it is informational, and a
   *  malformed one must never keep the end step from reading the life cycle. `status.madeForKids` (YouTube's own made-for-kids status,
   *  from the same `part=status`) is read the same way: a boolean, or `null` when YouTube did not say. */
  async broadcastLife(at: string, broadcastId: string): Promise<BroadcastLifeInfo> {
    const items = parseBody(await api(at, "GET", "liveBroadcasts", { query: { part: "status,snippet", id: broadcastId } })).items;
    const row = (Array.isArray(items) ? items : []).map(asRecord).find((i) => i?.id === broadcastId);
    if (!row) return { life: "absent", actualStartAt: null, actualEndAt: null, madeForKids: null };
    const status = asRecord(row.status);
    const life = status?.lifeCycleStatus;
    // A value Google never documented is refused, not guessed at: the caller would act on it (delete, complete).
    if (typeof life !== "string" || !Object.hasOwn(LIFE, life)) throw new YouTubeError("youtube_unavailable", "unknownLifeCycleStatus");
    const snippet = asRecord(row.snippet);
    // `status.madeForKids`: YouTube's own current designation. Only a real boolean is an answer; anything else is "did not say".
    const kids = status?.madeForKids;
    return {
      life: LIFE[life]!, actualStartAt: isoDate(snippet?.actualStartTime), actualEndAt: isoDate(snippet?.actualEndTime),
      madeForKids: typeof kids === "boolean" ? kids : null,
    };
  }

  /** liveBroadcasts.transition(complete). `redundantTransition` (403) is YouTube saying it is already there: that resolves. */
  async complete(at: string, broadcastId: string): Promise<void> {
    try {
      await api(at, "POST", "liveBroadcasts/transition", { query: { broadcastStatus: "complete", id: broadcastId, part: "status" } });
    } catch (e) {
      if (e instanceof YouTubeError && e.reason === "redundantTransition") return;
      throw e;
    }
  }

  async deleteBroadcast(at: string, broadcastId: string): Promise<void> {
    await deleteResource(at, "liveBroadcasts", broadcastId);
  }

  /** videos.list(part=id,status): Google leaves a deleted (or unreadable) video out of `items`, so presence is the answer, and the
   *  `status` part rides the SAME call (one call per batch, as before) to carry YouTube's own `status.madeForKids` for each present
   *  video: a boolean is an answer, anything else is `null`. Only ids that were asked about are returned. At most 50 per call; more
   *  is refused WITHOUT calling.
   *
   *  The page also lists a 404 `videoNotFound`, and does not say whether a batch can answer it when only SOME ids are missing.
   *  A 404 on ONE id is that id missing (an empty map). A 404 on a BATCH is never read as "all missing" (the caller deletes the
   *  links of videos it is told are gone, so a wrong "gone" purges links to live videos): the batch is re-asked one id per call,
   *  and only an id whose own call is a 404 is absent. Any other failure, in the batch or in a single call, is thrown. */
  async existingVideos(at: string, ids: readonly string[]): Promise<Map<string, VideoFacts>> {
    if (ids.length > MAX_VIDEO_IDS_PER_CALL) throw new RangeError(`existingVideos takes at most ${MAX_VIDEO_IDS_PER_CALL} ids per call`);
    if (ids.length === 0) return new Map();   // Google answers an empty `id` with a 400
    const asked = new Set(ids);
    let items: unknown;
    try {
      items = parseBody(await api(at, "GET", "videos", { query: { part: "id,status", id: [...asked].join(",") } })).items;
    } catch (e) {
      // ONLY Google's `videoNotFound` is "that video is missing": another not-found reason (liveBroadcastNotFound, …) is not about
      // these ids and is thrown, not read as an answer.
      if (!(e instanceof YouTubeError && e.reason === "videoNotFound")) throw e;
      if (asked.size === 1) return new Map();
      const found = new Map<string, VideoFacts>();
      for (const id of asked) for (const [present, facts] of await this.existingVideos(at, [id])) found.set(present, facts);
      return found;
    }
    const found = new Map<string, VideoFacts>();
    for (const item of Array.isArray(items) ? items : []) {
      const rec = asRecord(item);
      const id = nonEmpty(rec?.id);
      if (!id || !asked.has(id)) continue;
      const kids = asRecord(rec?.status)?.madeForKids;
      found.set(id, { madeForKids: typeof kids === "boolean" ? kids : null });
    }
    return found;
  }

  /** Revokes the grant at Google. An already-invalid token (400 `invalid_token`) resolves: the state asked for. */
  async revoke(refreshToken: string): Promise<void> {
    const r = await form(GOOGLE_REVOKE_URL, { token: refreshToken });
    if (r.ok) return;
    if (describeError(r.text).oauthError === "invalid_token") return;
    refuse(r);
  }
}
