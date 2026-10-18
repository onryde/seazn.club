// server/relay/domain/credits.ts — the match-credit value object (design §5.2).
// PURE. `debit` is FS10 in memory (owner ruling 1 keeps the CHECK too): a
// consume that would overdraw is refused before any row is written.
import { CREDIT_REUSE_HOURS } from "../config";

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

/** R2004 (owner ruling 2026-10-18, option (a)): how many recordings a session of each mode makes while it runs. A composed
 *  session's camera input (A) keeps recording — Cloudflare serves an input's HLS only while it records, and the phone's
 *  delivery watch reads A's — and its programme input (B) records the product. Passthrough records its one input. */
export const RECORDINGS_PER_SESSION: Readonly<Record<"passthrough" | "composed", number>> = { passthrough: 1, composed: 2 };

/** C3 + R2004: the storage minutes one session reserves while it runs — a full match per recording it makes. A duration
 *  that is not a whole non-negative number is refused by name: read as a number it would reserve a fraction, or nothing. */
export function reservationMinutes(mode: "passthrough" | "composed", maxDurationMinutes: number): number {
  if (!Number.isInteger(maxDurationMinutes) || maxDurationMinutes < 0) {
    throw new RangeError(`reservationMinutes: maxDurationMinutes must be a whole non-negative number, got ${maxDurationMinutes}`);
  }
  return RECORDINGS_PER_SESSION[mode] * maxDurationMinutes;
}

/** C3: limit − used − Σ reservations. Poll-then-admit is unsound, not imprecise. */
export function headroomAfterReservations(
  usage: { totalStorageMinutes: number; totalStorageMinutesLimit: number },
  reservedMinutes: readonly number[],
): number {
  return usage.totalStorageMinutesLimit - usage.totalStorageMinutes - reservedMinutes.reduce((a, b) => a + b, 0);
}
