// server/youtube/auto-backoff.ts — the AUTOMATIC start's backoff on a channel (Phase 0, YouTube channel safety; V538), as pure
// decisions: how long the window is, whether it is still open, which refusals open it, and what a backed-off start answers. No
// database, no network. The writes that keep the window live with the connection's data access (connections.ts
// `recordAutoBackoff` / `clearAutoBackoff`); prepare.ts asks these questions and calls those writes.
import {
  YOUTUBE_AUTO_BACKOFF_BASE_SECONDS, YOUTUBE_AUTO_BACKOFF_CODES, YOUTUBE_AUTO_BACKOFF_MAX_SECONDS, isYoutubeRefusalCode,
  type YoutubeRefusalCode,
} from "@/lib/youtube";

/** The window after `count` backoff refusals in a row (count >= 1): BASE seconds, doubling, capped at MAX. The exponent is bounded so
 *  a long run of refusals never overflows before the cap applies. connections.ts `recordAutoBackoff` writes the same table in SQL. */
export function backoffSeconds(count: number): number {
  const doublings = Math.min(Math.max(0, Math.floor(count) - 1), 30);
  return Math.min(YOUTUBE_AUTO_BACKOFF_BASE_SECONDS * 2 ** doublings, YOUTUBE_AUTO_BACKOFF_MAX_SECONDS);
}

/** Is the window still open? It is until `auto_retry_after`; at that instant and after, the start asks YouTube again. */
export function autoBackoffRefusal(r: { auto_retry_after: Date | null }, now: Date): boolean {
  return r.auto_retry_after !== null && now.getTime() < r.auto_retry_after.getTime();
}

/** Does this refusal open (or extend) the window? Only a refusal YouTube or the pool answered (never null, a fault of Seazn's own)
 *  and only one in YOUTUBE_AUTO_BACKOFF_CODES. */
export function opensAutoBackoff(code: YoutubeRefusalCode | null): code is YoutubeRefusalCode {
  return code !== null && YOUTUBE_AUTO_BACKOFF_CODES.includes(code);
}

/** Step 1 of prepare, for an AUTOMATIC start only: the refusal a start inside the window answers — the stored code that opened it,
 *  or `youtube_unavailable` when none is stored — or null when the window is closed and the start asks YouTube. */
export function autoBackoffRefusalCode(
  r: { auto_retry_after: Date | null; auto_backoff_code: string | null }, now: Date,
): YoutubeRefusalCode | null {
  if (!autoBackoffRefusal(r, now)) return null;
  return isYoutubeRefusalCode(r.auto_backoff_code) ? r.auto_backoff_code : "youtube_unavailable";
}
