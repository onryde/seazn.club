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

/** C3: limit − used − Σ reservations. Poll-then-admit is unsound, not imprecise. */
export function headroomAfterReservations(
  usage: { totalStorageMinutes: number; totalStorageMinutesLimit: number },
  reservedMinutes: readonly number[],
): number {
  return usage.totalStorageMinutesLimit - usage.totalStorageMinutes - reservedMinutes.reduce((a, b) => a + b, 0);
}
