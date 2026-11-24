// The stream panel's read cadence and Task 35's close-on-pair rule: no imports, so a client surface (Match Day's court QR sheet)
// reads them without pulling `stream-session-view` and what IT imports into its bundle. `stream-session-view` re-exports all three.

/** Prompt watch 4 closed: `live-score.tsx` exports no POLL_MS after W1's lift;
 *  the desk's LIVE_POLL_MS (20 s) is too slow for an organiser holding a
 *  phone at a QR code. One constant, here. */
export const STREAM_POLL_MS = 5_000;

/**
 * Task 35 (owner 2026-11-24, "when phone is pair then can we close the QR automatically"): a phone as the close-on-pair rule
 * reads it. null: no phone paired. Otherwise the pairing, `id` naming it as far as the surface's read can tell one pairing from
 * the next — null when it cannot (the read carries no identity, or has stopped serving the one it had).
 */
export type PairSeen = { id: string | null } | null;

/**
 * Task 35: an open QR closes ONCE when a phone pairs — the read goes from no phone to a phone, or names a different pairing than
 * the last read did. Every other step closes nothing, so a QR the organiser opens again stays open:
 *  - a read with no phone (the empty case, or a pairing that ended);
 *  - a re-poll of the same pairing, whatever its own facts do (silent, a later beat);
 *  - an identity that becomes UNKNOWN: on the Phone tab that is Revoke & reissue answering a takeover (B7 review I-2: the server
 *    stops serving it with the old code) while the phone a live session holds stays — the organiser is looking at the new code
 *    they just asked for.
 * Both surfaces fold it over their own polls: the Phone tab's "Show the code again" (`streamPairSeen`) and Match Day's court QR
 * sheet (`courtPairSeen`, lib/match-day/court-stream.ts).
 */
export function closeCodeOnPair(prev: PairSeen, next: PairSeen): boolean {
  if (next === null) return false;
  if (prev === null) return true;
  return next.id !== null && next.id !== prev.id;
}
