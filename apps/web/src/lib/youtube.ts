// lib/youtube.ts — YouTube Connect's CLIENT-SAFE vocabulary (plan T5). Constants and types only: no secret, no server import,
// nothing a browser bundle must not carry. The port, the fake and the Google driver live under server/youtube/.

/** The one OAuth scope the feature asks for (spec §3.1): insert / bind / transition accept `youtube` or `youtube.force-ssl`;
 *  `youtube` is not a restricted scope. Every grant is checked against it by the connect callback. */
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

/** The version of the consent text a user ticked (D7). Bump it when the wording changes; the Streaming page then shows
 *  "Review updated terms" without blocking Go live. */
export const YOUTUBE_CONSENT_VERSION = 1;

/** A broadcast's visibility, chosen at connect (D2, Unlisted preselected). */
export const YOUTUBE_PRIVACIES = ["unlisted", "public", "private"] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACIES)[number];

/** Why Go live was refused on a YouTube destination (spec §6.2) — the closed set the organiser's panel has copy for.
 *  `youtube_channel_busy` is Seazn's own answer (the 11th concurrent stream, counted in the pool); the others are YouTube's
 *  (server/youtube/port.ts maps them from Google's reasons and never carries a response body). */
export const YOUTUBE_REFUSAL_CODES = [
  "youtube_reconnect_needed",
  "youtube_live_not_enabled",
  "youtube_live_blocked",
  "youtube_limit_reached",
  "youtube_channel_busy",
  "youtube_unavailable",
] as const;
export type YoutubeRefusalCode = (typeof YOUTUBE_REFUSAL_CODES)[number];

/** "10 active streams allowed per channel" (support.google.com/youtube/answer/2474026, spec §3.1) — the ONE authority for the number.
 *  The server's pool (server/youtube/prepare.ts) refuses the 11th concurrent stream with `youtube_channel_busy`, and the panel's copy
 *  for that refusal names this number (`stream.error.youtube_channel_busy` carries `{max}`), so they cannot disagree. The database's
 *  floor under it is V479's `youtube_stream_keys_slot_range` (slot between 1 and 10), held equal by lib/__tests__/youtube-cap.test.ts. */
export const YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL = 10;

/** The two refusals that are a fact about the CHANNEL, not about one broadcast, and the live state the Streaming page reads each as
 *  (`liveState` on the connection view). ONE table for the writer (prepare.ts records the refusal on the connection) and the reader
 *  (connections.ts `liveStateOf` turns the recorded code back into the state), so what Go live learns and what the page says cannot
 *  disagree. A Record over a subset of the declaration, so a code outside it is not a live state. */
export const YOUTUBE_LIVE_STATE_OF_REFUSAL = {
  youtube_live_not_enabled: "not_enabled",
  youtube_live_blocked: "blocked",
} as const satisfies Partial<Record<YoutubeRefusalCode, string>>;
export type YoutubeLiveStateRefusal = keyof typeof YOUTUBE_LIVE_STATE_OF_REFUSAL;
export const isYoutubeLiveStateRefusal = (c: unknown): c is YoutubeLiveStateRefusal =>
  typeof c === "string" && Object.hasOwn(YOUTUBE_LIVE_STATE_OF_REFUSAL, c);

/** How long a recorded not-enabled / blocked reading of a channel is believed by an AUTOMATIC start (controller ruling, B4 fix round 1,
 *  I-2; narrowed to the automatic start in fix round 2, F2): inside it each of that start's retries is refused with the same code and NO
 *  call to YouTube; after it the next retry asks YouTube again. A person's tap — the organiser's Go live, the phone operator's Start —
 *  never consults the record and always asks YouTube. Judged on the time the refusal was recorded (`last_health_at`). */
export const YOUTUBE_LIVE_STATE_FRESH_MINUTES = 10;

/** Is this a link to YouTube itself? A replay URL is the club's own `stream_url` when it set one (nothing overwrites it), so the
 *  YouTube mark may sit on a link only if the link really goes to YouTube: https on youtube.com (any subdomain) or youtu.be. */
export function isYoutubeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}

/** A channel's own page on YouTube. The YouTube logo is only ever drawn as a link back to YouTube (owner, 2026-10-28, from YouTube's
 *  branding terms: "any logo used within an application must be clickable and link back to YouTube content"), and a connected channel
 *  row's link is this. `/channel/<id>` is the canonical form that needs only the channel id Google returned at connect (a `@handle` URL
 *  would need a lookup). The id is one path segment: encoded, so nothing in it can leave the path or change the host. */
export function youtubeChannelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`;
}

export const isYoutubeRefusalCode = (c: unknown): c is YoutubeRefusalCode => (YOUTUBE_REFUSAL_CODES as readonly unknown[]).includes(c);

/** Who can act on a refused Go live, for the surfaces whose vocabulary is smaller than the organiser's panel: the phone's own
 *  start (capture QR v2 §6.7.2) and the automatic start (§7.2). `fix_destination`: the club changes something about its YouTube
 *  destination (reconnect the channel, enable live streaming, a channel YouTube blocked), so the phone says `no_destination` and the
 *  column stores `no_destination`. `retry`: nothing the club changes in the destination (YouTube's quota, the channel's ten-stream
 *  cap, YouTube not answering), so both say `unavailable` and a retry may succeed. A Record over the declaration, so a new code does
 *  not compile until it is placed. */
export const YOUTUBE_REFUSAL_REMEDY: Record<YoutubeRefusalCode, "fix_destination" | "retry"> = {
  youtube_reconnect_needed: "fix_destination",
  youtube_live_not_enabled: "fix_destination",
  youtube_live_blocked: "fix_destination",
  youtube_limit_reached: "retry",
  youtube_channel_busy: "retry",
  youtube_unavailable: "retry",
};

/** The replay link for a broadcast: a YouTube broadcast id is also the id of its video. */
export const youtubeWatchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

/** One replay part of a fixture: its place in the order the broadcasts finished (1-based) and the video's watch address. Plain data,
 *  so the server reader (server/youtube/parts.ts), the match page and the browser-side player all speak the one shape. */
export interface ReplayPart {
  partNo: number;
  url: string;
}

/** The ORGANISER's part: the same plus whether the broadcast is PRIVATE on YouTube. The public never sees a private broadcast (owner
 *  ruling 2026-10-28), so the public shape has no such flag; the organiser's panel lists it and says so. Its `partNo` numbers every
 *  complete broadcast, so it may differ from the number the public page gives the same video when privacies are mixed. */
export interface OrganiserReplayPart extends ReplayPart {
  private: boolean;
}

// --- The public match page's replay player (T16) --------------------------------------------------------------------------------
// The player is a click-to-play facade: nothing is loaded from Google but the video's thumbnail until the person taps, and then the
// iframe comes from YouTube's privacy-enhanced host. The CSP (src/proxy.ts) allows exactly these two origins and no other.

/** The privacy-enhanced embed host (`youtube-nocookie.com`): it sets no cookie until the viewer plays. The CSP's `frame-src` names
 *  this origin, and the page checks a player message's origin against it. */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";
/** Where a video's public thumbnail image lives; the CSP's `img-src` names this origin. */
export const YOUTUBE_THUMBNAIL_ORIGIN = "https://i.ytimg.com";

/** A YouTube video id: 11 characters from [A-Za-z0-9_-]. The ONE shape an address is built from. */
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** The paths (under a youtube.com host) whose SECOND segment is the video id. */
const VIDEO_PATH_KINDS = new Set(["live", "embed", "shorts", "v"]);

/** The video id inside a YouTube video URL, or `null` for anything that is not provably one: the URL must pass `isYoutubeUrl` (https,
 *  youtube.com or a subdomain, or youtu.be) AND carry an id of the exact shape in one of YouTube's video forms (`/watch?v=`,
 *  `/live/`, `/embed/`, `/shorts/`, `/v/`, or `youtu.be/<id>`). A channel, a playlist, a handle, a bare host, or an id with an
 *  extra path segment is `null`. `null` means "show a link, never an iframe". */
export function youtubeVideoId(url: string): string | null {
  if (!isYoutubeUrl(url)) return null;
  const u = new URL(url);
  const segments = u.pathname.split("/").filter((s) => s !== "");
  let candidate: string | null = null;
  if (u.hostname.toLowerCase() === "youtu.be") {
    if (segments.length === 1) candidate = segments[0]!;
  } else if (segments.length === 1 && segments[0] === "watch") {
    candidate = u.searchParams.get("v");
  } else if (segments.length === 2 && VIDEO_PATH_KINDS.has(segments[0]!)) {
    candidate = segments[1]!;
  }
  return candidate !== null && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
}

/** Is `link` the video one of the parts already is? Compared by VIDEO, so `youtu.be/<id>`, `/live/<id>` and `watch?v=<id>` are one
 *  video; a link that is not a YouTube video address can only match by being the identical string. The ONE rule the public match
 *  page ("never the same replay twice") and the organiser's panel both apply to the fixture's own `stream_url`. */
export function linkIsOneOfParts(link: string, parts: readonly ReplayPart[]): boolean {
  const id = youtubeVideoId(link);
  return parts.some((p) => p.url === link || (id !== null && youtubeVideoId(p.url) === id));
}

/** The links the organiser's after-match area lists: every part in order, then the fixture's own `stream_url` when it is NOT one of
 *  the parts (a club's own different link still shows; the end step's Part 1 link is not shown twice). `partNo` is null for the
 *  club's own link. */
export function replayRows(streamUrl: string | null, parts: readonly OrganiserReplayPart[]): { key: string; url: string; partNo: number | null; private: boolean }[] {
  const own = streamUrl !== null && streamUrl !== "" && !linkIsOneOfParts(streamUrl, parts);
  return [
    ...parts.map((p) => ({ key: `part-${p.partNo}`, url: p.url, partNo: p.partNo, private: p.private })),
    ...(own ? [{ key: "own", url: streamUrl, partNo: null, private: false }] : []),
  ];
}

const assertVideoId = (id: string): string => {
  if (!YOUTUBE_VIDEO_ID.test(id)) throw new Error("not a YouTube video id");
  return id;
};

/** The player's address, built only after a tap: privacy-enhanced host, autoplay on (the person just asked to play), no end-of-video
 *  suggestions from other channels (`rel=0`), inline on iOS, and `enablejsapi` + `origin` so the page can hear the player say
 *  "embedding is disabled for this video" (error 101 / 150) without loading any script from YouTube. Throws on a malformed id. */
export function youtubeEmbedUrl(videoId: string, pageOrigin: string): string {
  const u = new URL(`${YOUTUBE_EMBED_ORIGIN}/embed/${assertVideoId(videoId)}`);
  u.searchParams.set("autoplay", "1");
  u.searchParams.set("rel", "0");
  u.searchParams.set("playsinline", "1");
  u.searchParams.set("enablejsapi", "1");
  u.searchParams.set("origin", pageOrigin);
  return u.toString();
}

/** A video's public thumbnail (480x360, the 16:9 picture letterboxed: the facade crops the bars with `object-cover`). Throws on a
 *  malformed id. */
export const youtubeThumbnailUrl = (videoId: string): string => `${YOUTUBE_THUMBNAIL_ORIGIN}/vi/${assertVideoId(videoId)}/hqdefault.jpg`;

/** Developer Policies III.A.1: a link to YouTube's Terms of Service, shown where the user agrees to be bound by them. */
export const YOUTUBE_TOS_URL = "https://www.youtube.com/t/terms";
/** YouTube's Community Guidelines, linked beside the consent text. */
export const YOUTUBE_GUIDELINES_URL = "https://www.youtube.com/t/community_guidelines";
/** Developer Policies III.A.2: the privacy policy must link Google's, exactly as Google spells it. */
export const GOOGLE_PRIVACY_URL = "http://www.google.com/policies/privacy";
/** Developer Policies III.A.2: where a user revokes access to Seazn. */
export const GOOGLE_PERMISSIONS_URL = "https://security.google.com/settings/security/permissions";

// --- The Streaming page and the connect round trip's landing --------------------------------------------------------------

/** The org's Streaming page (owner, 2026-10-27: Streaming is its own top-nav page, not a Directory tab, and nothing forwards from
 *  the old `/directory?tab=streaming`). The ONE href for the nav item, the fixture panel's "Manage destinations" links and the
 *  connect flow's landing. Constants only: no import, so the OpenAPI loader can read this file bare. */
export const STREAMING_PAGE_HREF = "/streaming";

// Every exit of the OAuth callback (and the start's own refusals that are not a bad request) is a 303 to the Streaming page
// carrying one outcome, as `?youtube=<code>`. The page maps a code to a sentence; a value that is not one of these shows
// nothing. `pick` also carries the pending grant's id, `&pending=<id>`. `already_connected` is a SUCCESS that did not apply the
// choices made before Google: a fresh connect of a channel the organisation already had (its saved visibility and made-for-kids
// settings stand, and the page says so). The callback lands it for a one-channel grant (never for a Reconnect, which is plain
// `connected`) and the channel PICKER lands it after a pick of such a channel.

/** The page the connect flow always lands on. */
export const YOUTUBE_LANDING_PATH = STREAMING_PAGE_HREF;
/** The query parameter carrying the outcome. */
export const YOUTUBE_LANDING_PARAM = "youtube";
/** The query parameter carrying the pending grant's id on a `pick`. */
export const YOUTUBE_LANDING_PENDING_PARAM = "pending";

export const YOUTUBE_LANDING_CODES = [
  "connected",
  "pick",
  "no_channel",
  "scope_missing",
  "other_org",
  "different_channel",
  "denied",
  "expired",
  "not_configured",
  "forbidden",
  "unavailable",
  "already_connected",
] as const;
export type YoutubeLandingCode = (typeof YOUTUBE_LANDING_CODES)[number];

/** Where the connect flow lands: `/streaming?youtube=<code>`, plus `&pending=<id>` for a `pick`. The ONE builder for the start
 *  route, the callback and the page that reads the parameters, so they cannot drift. */
export function youtubeLanding(code: YoutubeLandingCode, pendingId?: string): string {
  const base = `${YOUTUBE_LANDING_PATH}?${YOUTUBE_LANDING_PARAM}=${code}`;
  return pendingId === undefined ? base : `${base}&${YOUTUBE_LANDING_PENDING_PARAM}=${encodeURIComponent(pendingId)}`;
}

/** The code in a `?youtube=` value a page was handed - `null` for anything that is not one of ours. */
export function youtubeLandingCode(value: string | null | undefined): YoutubeLandingCode | null {
  return (YOUTUBE_LANDING_CODES as readonly string[]).includes(value ?? "") ? (value as YoutubeLandingCode) : null;
}

/** The pending grant id on a landing is a UUID (the pending row's primary key); anything else is not one of ours. */
const PENDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One landing as the page reads it: the outcome code and, for a `pick`, the pending grant to choose a channel from. */
export type YoutubeLanding = { code: YoutubeLandingCode; pendingId: string | null };

/** What the Streaming page was handed in its query: the outcome code (`?youtube=`) and, for a `pick`, the pending grant's id
 *  (`&pending=`). A value that is not one of ours shows nothing (`null`). A `pick` WITHOUT a well-formed pending id cannot open a
 *  picker (there is nothing to pick from), so it reads as `expired` — the honest sentence for a link that no longer works —
 *  rather than as an empty picker that asks the server about a junk id. Pure and client-safe: the page calls it once. */
export function youtubeLandingFrom(
  params: { youtube?: string | string[]; pending?: string | string[] },
): YoutubeLanding | null {
  const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const code = youtubeLandingCode(first(params.youtube));
  if (code === null) return null;
  if (code !== "pick") return { code, pendingId: null };
  const pending = first(params.pending);
  return pending !== undefined && PENDING_ID.test(pending) ? { code, pendingId: pending } : { code: "expired", pendingId: null };
}

/** What a destination row's label becomes when its connection is revoked (token-store.ts `revokeConnection` writes it, the channel's
 *  title being Authorized Data that must not outlive a revoke, DP III.E.4). It is a DATABASE literal, English: any surface that
 *  shows an archived row's label reads it through `youtubeTargetLabel` (components/v2/youtube-connect-panel.tsx), which localizes it. */
export const YOUTUBE_DISCONNECTED_LABEL = "YouTube channel (disconnected)";
