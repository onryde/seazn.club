// Match Day's court stream, the desk's pure rules (court stream spec 2026-11-14 §5; web plan Task 12): which court may be linked,
// what a match's Stream switch shows, which words a phone's status and a refusal take. No react, no fetch: the components
// (components/v2/match-day/court-stream-*.tsx, court-phone-status.tsx) paint what these decide.
import type { StreamTarget } from "@/server/api-v1/schemas";
import { STREAM_POLL_MS, type PairSeen } from "@/lib/stream-session-view";
import type { MatchDayCourt, MatchDayCourtStream, MatchDayFixture } from "./types";

/** Who may write: an editor of a competition that is not billing-frozen. A frozen or view-only desk shows the status and nothing
 *  that writes (Task 12 rules; the server refuses each write on its own). */
export const canWriteCourtStream = (c: { readOnly: boolean; frozen: boolean }): boolean => !c.readOnly && !c.frozen;

/** "Stream this court" shows on a court with no live link, to a writer, once the page knows the organisation to ask for channels. */
export function canLinkCourt(c: { readOnly: boolean; frozen: boolean; orgId?: string }, court: Pick<MatchDayCourt, "stream_link">): boolean {
  return court.stream_link === null && canWriteCourtStream(c) && typeof c.orgId === "string" && c.orgId !== "";
}

/** Why a Stream switch cannot be turned: the match has its own stream code, its court has no link, or the desk is view-only /
 *  frozen (nothing to say: the page is read-only as a whole). */
export type SwitchLock = "own_code" | "not_streaming" | "locked";
export type SwitchSpec = { on: boolean; lock: SwitchLock | null };

/**
 * What a match's Stream switch looks like (Task 12): null for none.
 *  - a linked court's current or queued match always has one: on or off, free to turn for a writer; locked by its own stream
 *    code (`own_code`) whoever reads it; locked silently ("locked") for a view-only or frozen desk, and then only while it is ON
 *    (an OFF switch nobody can turn says nothing);
 *  - on a court with no link only a match whose switch is already ON shows it, locked, "Court not streaming" (an intent left
 *    behind by a withdrawn link: R5, the switch is the per-match intent and never ends a video).
 * A waiting-to-be-called (candidate) row reaches this too (ruling O14, 2026-11-16, superseding R11's "candidates always read
 * false"): its `court_stream` / `own_stream_code` are the real ones, so the day's first match can be switched on before it is called.
 */
export function switchSpec(f: Pick<MatchDayFixture, "court_stream" | "own_stream_code">, linked: boolean, canWrite: boolean): SwitchSpec | null {
  if (!linked) return f.court_stream ? { on: true, lock: "not_streaming" } : null;
  if (f.own_stream_code) return { on: f.court_stream, lock: "own_code" };
  if (!canWrite) return f.court_stream ? { on: true, lock: "locked" } : null;
  return { on: f.court_stream, lock: null };
}

/** Task 35 Part B (owner 2026-11-24): a court's phone as the close-on-pair rule reads it (`closeCodeOnPair`, lib/stream-session-view.ts).
 *  No link, or a link whose phone is `unpaired` (the server's no-pairing answer, `courtPhoneStatus`): nothing paired. Any other status
 *  is a paired phone. The desk's read names no pairing, so the LINK is the identity it can tell: a phone read on another link is
 *  another pairing; the same link's phone moving between waiting, live and offline is the same one. */
export function courtPairSeen(link: MatchDayCourtStream | null): PairSeen {
  if (link === null || link.phone === "unpaired") return null;
  return { id: link.link_id };
}

/** Task 35 Part B: while the court's QR sheet is open on a link whose phone has not paired, the focus reads the day this often — so
 *  the pairing that closes the sheet shows within one read. The Phone tab's own read cadence (`STREAM_POLL_MS`): the band's quiet
 *  cadence is 90 s (`QUIET_POLL_MS`, components/v2/desk/band-poll.ts), which would leave the credential on screen that long after
 *  the phone had it. It runs only while the sheet waits, so a desk with no sheet open reads exactly as before. */
export const COURT_SHEET_PAIR_POLL_MS = STREAM_POLL_MS;

/** The dictionary key a phone's status is said in. */
export const phoneKey = (phone: MatchDayCourtStream["phone"]) => `matchDay.courtStream.phone.${phone}` as const;

/** The last minute the link works. The server's `expires_at` is the next midnight (24:00 of the day), which a clock prints as
 *  "00:00"; "Works until 00:00 today" would read as already over, so the line names the minute before it. */
export const lastWorkingMinute = (expiresAt: string): string => new Date(Date.parse(expiresAt) - 60_000).toISOString();

/** The destinations a court may stream to: the connected YouTube channels only (a pasted stream key is one match's, not a
 *  court's: `court_destination_not_youtube`). */
export const youtubeTargets = (list: readonly StreamTarget[]): StreamTarget[] => list.filter((t) => t.youtube !== null);

/** The words for a refused Stream switch (409): by the server's own code, else the generic line. */
export function switchFailureKey(code: string): "matchDay.courtStream.ownCode" | "matchDay.courtStream.notStreaming" | "matchDay.refusal.other" {
  if (code === "has_own_stream_code") return "matchDay.courtStream.ownCode";
  if (code === "court_not_streaming") return "matchDay.courtStream.notStreaming";
  return "matchDay.refusal.other";
}

/** The words for a refused link: by the server's own code (a 402 reads `PAYMENT_REQUIRED`: no streaming plan for this organisation;
 *  `court_streaming_unconfigured`: this server has no minimum app version to hand out court codes for), else the generic line. */
export function linkFailureKey(
  code: string,
): "matchDay.courtStream.alreadyStreaming" | "matchDay.courtStream.noPlan" | "matchDay.courtStream.notConfigured" | "matchDay.refusal.other" {
  if (code === "court_already_streaming") return "matchDay.courtStream.alreadyStreaming";
  if (code === "PAYMENT_REQUIRED") return "matchDay.courtStream.noPlan";
  if (code === "court_streaming_unconfigured") return "matchDay.courtStream.notConfigured";
  return "matchDay.refusal.other";
}
