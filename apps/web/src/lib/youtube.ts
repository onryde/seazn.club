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

/** The replay link for a broadcast: a YouTube broadcast id is also the id of its video. */
export const youtubeWatchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

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
