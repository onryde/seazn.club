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
