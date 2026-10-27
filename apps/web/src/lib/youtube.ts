// lib/youtube.ts — YouTube Connect's CLIENT-SAFE vocabulary (plan T5). Constants and types only: no secret, no server import,
// nothing a browser bundle must not carry. The port, the fake and the Google driver live under server/youtube/.

/** The one OAuth scope the feature asks for (spec §3.1): insert / bind / transition accept `youtube` or `youtube.force-ssl`;
 *  `youtube` is not a restricted scope. Every grant is checked against it by the connect callback. */
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

/** The version of the consent text a user ticked (D7). Bump it when the wording changes; the Directory then shows
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

// --- The connect round trip's landing --------------------------------------------------------------------------------
// Every exit of the OAuth callback (and the start's own refusals that are not a bad request) is a 303 to the Directory's
// streaming tab carrying one outcome, as `?youtube=<code>`. The Directory (plan T9) maps a code to a sentence; a value that
// is not one of these shows nothing. `pick` also carries the pending grant's id, `&pending=<id>`.

/** The Directory page the connect flow always lands on. */
export const YOUTUBE_LANDING_PATH = "/directory?tab=streaming";
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
] as const;
export type YoutubeLandingCode = (typeof YOUTUBE_LANDING_CODES)[number];

/** Where the connect flow lands: `/directory?tab=streaming&youtube=<code>`, plus `&pending=<id>` for a `pick`. The ONE
 *  builder for the start route, the callback and the page that reads the parameters, so they cannot drift. */
export function youtubeLanding(code: YoutubeLandingCode, pendingId?: string): string {
  const base = `${YOUTUBE_LANDING_PATH}&${YOUTUBE_LANDING_PARAM}=${code}`;
  return pendingId === undefined ? base : `${base}&${YOUTUBE_LANDING_PENDING_PARAM}=${encodeURIComponent(pendingId)}`;
}

/** The code in a `?youtube=` value a page was handed - `null` for anything that is not one of ours. */
export function youtubeLandingCode(value: string | null | undefined): YoutubeLandingCode | null {
  return (YOUTUBE_LANDING_CODES as readonly string[]).includes(value ?? "") ? (value as YoutubeLandingCode) : null;
}
