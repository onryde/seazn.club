// server/relay/domain/credits.ts — the match-credit value object (design §5.2).
// PURE. `debit` is FS10 in memory (owner ruling 1 keeps the CHECK too): a
// consume that would overdraw is refused before any row is written.
import { CREDIT_REUSE_HOURS, RESERVATION_BUFFER_MINUTES } from "../config";

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

/** Owner ruling 2026-10-26 ("C"): the storage minutes an ENDED composed session's camera input still reserves until the daily
 *  sweep deletes its recordings — the minutes it actually ran, rounded UP to a whole minute and capped at the booking. A span
 *  that cannot be read (either instant missing or invalid, or the end before the start) is the WHOLE booking: conservative,
 *  never zero. A span of exactly zero is a real measurement and reserves zero. The booking itself must be a whole
 *  non-negative number, refused by name. */
export function endedCameraReservationMinutes(startedAt: Date | null, endedAt: Date | null, maxDurationMinutes: number): number {
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 0) {
    throw new RangeError(`endedCameraReservationMinutes: maxDurationMinutes must be a whole non-negative number, got ${maxDurationMinutes}`);
  }
  if (startedAt === null || endedAt === null) return maxDurationMinutes;
  const spanMs = endedAt.getTime() - startedAt.getTime();
  if (!Number.isFinite(spanMs) || spanMs < 0) return maxDurationMinutes;
  return Math.min(maxDurationMinutes, Math.ceil(spanMs / 60_000));
}

/** C3: limit − used − Σ reservations. Poll-then-admit is unsound, not imprecise. */
export function headroomAfterReservations(
  usage: { totalStorageMinutes: number; totalStorageMinutesLimit: number },
  reservedMinutes: readonly number[],
): number {
  return usage.totalStorageMinutesLimit - usage.totalStorageMinutes - reservedMinutes.reduce((a, b) => a + b, 0);
}
