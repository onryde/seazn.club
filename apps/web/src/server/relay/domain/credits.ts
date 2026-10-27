// server/relay/domain/credits.ts — the match-credit value object (design §5.2).
// PURE. `debit` is FS10 in memory (owner ruling 1 keeps the CHECK too): a
// consume that would overdraw is refused before any row is written.
import { CREDIT_REUSE_HOURS, FINALISATION_GRACE_SECONDS, RESERVATION_BUFFER_MINUTES } from "../config";

export class InsufficientCredits extends Error {
  constructor(readonly balance: number, readonly amount: number) { super(`insufficient credits: ${balance} < ${amount}`); }
}

function positiveInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer, got ${n}`);
}

export function debit(balance: number, amount = 1): { balanceAfter: number } {
  positiveInt(amount, "debit amount");
  if (balance - amount < 0) throw new InsufficientCredits(balance, amount);
  return { balanceAfter: balance - amount };
}

export function credit(balance: number, amount: number): { balanceAfter: number } {
  positiveInt(amount, "credit amount");
  return { balanceAfter: balance + amount };
}

/** §5.2: a consume for the same fixture within 24 h → no second consume. */
export function withinReuseWindow(lastConsumeAt: Date | null, now: Date, hours = CREDIT_REUSE_HOURS): boolean {
  if (!lastConsumeAt) return false;
  return now.getTime() - lastConsumeAt.getTime() < hours * 3_600_000;
}

/** W23 (capture QR v2): a restart is free iff a reuse window is open AND fewer than `limit` restarts that reached video
 *  have been counted since the window's anchor. A closed window is never free (the empty case). A count or limit that is
 *  not a whole number in range is refused by name — read as "free" it would give a stream away. */
export function restartIsFree(a: { windowOpen: boolean; used: number }, limit: number): boolean {
  if (!Number.isInteger(a.used) || a.used < 0) throw new RangeError(`restartIsFree: used must be a whole non-negative count, got ${a.used}`);
  positiveInt(limit, "restartIsFree: limit");
  return a.windowOpen && a.used < limit;
}

/** R2008 free-gaps (owner ruling 2026-10-20): the platform's never-live refund is bounded — at most `limit` per fixture per reuse
 *  window. `priorRefundAts` are the instants of the fixture's EARLIER never-live refunds (any order, any age); only those inside
 *  the window (the reuse rule's own `withinReuseWindow`, so one boundary for both) count. Capped = the window already holds
 *  `limit` of them, so this end is NOT refunded. No earlier refund is never capped (the empty case). A limit that is not a
 *  positive integer is refused by name: read as 0 or NaN it would cap everything, or nothing. */
export function neverLiveRefundCapped(priorRefundAts: readonly Date[], now: Date, limit: number): boolean {
  positiveInt(limit, "neverLiveRefundCapped: limit");
  return priorRefundAts.filter((at) => withinReuseWindow(at, now)).length >= limit;
}

/** R2004 (owner ruling 2026-10-18, option (a)): how many recordings a session of each mode makes while it runs. A composed
 *  session's camera input (A) keeps recording — Cloudflare serves an input's HLS only while it records, and the phone's
 *  delivery watch reads A's — and its programme input (B) records the product. Passthrough records its one input. */
export const RECORDINGS_PER_SESSION: Readonly<Record<"passthrough" | "composed", number>> = { passthrough: 1, composed: 2 };

/** C3 + R2004, amended by the owner ruling 2026-10-26 (E1, "30 mins buffer"): the storage minutes one RUNNING session reserves.
 *  Each recording it makes reserves `min(maxDurationMinutes, ceil(elapsed) + RESERVATION_BUFFER_MINUTES)` — rolling with the
 *  minutes the session has run, never a full match up front. `elapsedMinutes` defaults to 0, which is ADMISSION: a session
 *  that has not begun holds the buffer alone (composed 2 × 30, passthrough 30), and a booking shorter than the buffer holds
 *  its own length. A duration that is not a whole non-negative number, or an elapsed that is not a finite non-negative one,
 *  is refused by name: read as a number it would reserve a fraction, or nothing, or NaN. */
export function reservationMinutes(mode: "passthrough" | "composed", maxDurationMinutes: number, elapsedMinutes = 0): number {
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 0) {
    throw new RangeError(`reservationMinutes: maxDurationMinutes must be a whole non-negative number, got ${maxDurationMinutes}`);
  }
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0) {
    throw new RangeError(`reservationMinutes: elapsedMinutes must be a finite non-negative number, got ${elapsedMinutes}`);
  }
  return RECORDINGS_PER_SESSION[mode] * Math.min(maxDurationMinutes, Math.ceil(elapsedMinutes) + RESERVATION_BUFFER_MINUTES);
}

/** A running session's elapsed minutes (fractional) from its start to `now`. No start yet is 0 — a session that has not
 *  begun owes the buffer only — and a start in the future (clock skew between writers) is 0 too, never negative. */
export function elapsedMinutesSince(from: Date | null, now: Date): number {
  if (from === null) return 0;
  return Math.max(0, (now.getTime() - from.getTime()) / 60_000);
}

/** Owner ruling 2026-10-26 ("C"): the storage minutes ONE recording of an ended session reserves — the minutes the session
 *  actually ran, rounded UP to a whole minute and capped at the booking. Counted from `warmingAt`, so a session that never
 *  warmed (`null`: stopped or failed while provisioning, no credential ever served) recorded NOTHING and reserves zero (review
 *  of PR #1041, m3; the legacy sessions that predate the column are older than the recording horizon, so a null inside it
 *  means "never warmed"). A warmed session whose END was not recorded, or whose span cannot be read (an end before the start,
 *  an invalid date), is the WHOLE booking: an unknown span is conservative, never zero. A span of exactly zero is a real
 *  measurement and reserves zero. The booking itself must be a whole non-negative number, refused by name. */
export function endedCameraReservationMinutes(warmingAt: Date | null, endedAt: Date | null, maxDurationMinutes: number): number {
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 0) {
    throw new RangeError(`endedCameraReservationMinutes: maxDurationMinutes must be a whole non-negative number, got ${maxDurationMinutes}`);
  }
  if (warmingAt === null) return 0;
  if (endedAt === null) return maxDurationMinutes;
  const spanMs = endedAt.getTime() - warmingAt.getTime();
  if (!Number.isFinite(spanMs) || spanMs < 0) return maxDurationMinutes;
  return Math.min(maxDurationMinutes, Math.ceil(spanMs / 60_000));
}

/** Review I1 of PR #1041 (owner-directed 2026-10-26): what an ENDED session reserves at `now`.
 *
 *  An in-progress recording is counted by NOTHING — `storage-usage` shows it only when Cloudflare finalises it, after the hold
 *  window that follows the input's disconnect plus a cautious processing allowance (R0 F2; `FINALISATION_GRACE_SECONDS`). The programme (composed B) and a passthrough input
 *  disconnect at the session's end, so for the grace after `endedAt` EVERY recording keeps its span reserved: composed twice
 *  (the camera A and the programme B), passthrough once. After it the programme and the passthrough recording are in
 *  Cloudflare's usage and stop reserving; the camera alone keeps its span until its recordings are deleted (`cameraHeld`:
 *  the camera input was made and not yet marked `recordings_deleted_at`), as the ruling of 2026-10-26 (C) says.
 *  An `endedAt` that was never recorded has no grace to be inside (composed keeps the camera's whole booking, passthrough
 *  nothing). The span is `endedCameraReservationMinutes`: zero for a session that never warmed. */
export function endedReservationMinutes(a: {
  mode: "passthrough" | "composed"; warmingAt: Date | null; endedAt: Date | null; maxDurationMinutes: number; now: Date; cameraHeld: boolean;
}): number {
  const span = endedCameraReservationMinutes(a.warmingAt, a.endedAt, a.maxDurationMinutes);
  const finalising = a.endedAt !== null && a.now.getTime() < a.endedAt.getTime() + FINALISATION_GRACE_SECONDS * 1000;
  if (a.mode === "passthrough") return finalising ? span : 0;
  return (a.cameraHeld ? span : 0) + (finalising ? span : 0);
}

/** C3: limit − used − Σ reservations. Poll-then-admit is unsound, not imprecise. */
export function headroomAfterReservations(
  usage: { totalStorageMinutes: number; totalStorageMinutesLimit: number },
  reservedMinutes: readonly number[],
): number {
  return usage.totalStorageMinutesLimit - usage.totalStorageMinutes - reservedMinutes.reduce((a, b) => a + b, 0);
}
