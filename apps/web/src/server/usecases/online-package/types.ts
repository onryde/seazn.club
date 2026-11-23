// server/usecases/online-package/types.ts — the shapes the Online Chess package modules share (spec
// 2026-11-23-online-chess-credits-design.md §7.1, §7.4). Types only.
import type { OnlineSize } from "@/lib/online-chess-package";

/** One `division_online_packages` row (V549), as the package doors read it. The four states (§7.1): unpaid (`paidAt` null,
 *  `frozenAt` null), paid (`paidAt` set, `frozenAt` null), frozen (`frozenAt` set; frozen with `paidAt` null is a
 *  grandfathered row of the backfill, and only that) and refunded (`refundedAt` set; history, never live). */
export interface PackageRow {
  id: string;
  orgId: string;
  /** Null once the division is deleted (`on delete set null`): a paid row outlives its division. */
  divisionId: string | null;
  /** The division's name when the row was written, for the credit history after a delete. */
  divisionName: string;
  /** On the ladder: asserted when the row is read (`livePackage`), so a price is never quoted for a size off it. */
  size: OnlineSize;
  /** Null until paid; true = the camera price was paid (P19: never lowered). */
  camerasPaid: boolean | null;
  /** Everything ever debited for this package; only ever grows. */
  creditsPaid: number;
  /** Everything returned to the balance. */
  creditsRefunded: number;
  /** Included credits given up on a move down or a refund because their month had ended (P6). */
  creditsForfeited: number;
  paidAt: Date | null;
  paidBy: string | null;
  frozenAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
}

/** How a package debit splits over the ledger's two buckets (V426): `monthly`, this month's included credits, is drawn
 *  first; `pack`, bought credits, pays the rest (P4). One ledger row per non-zero part. */
export type BucketSplit = { monthly: number; pack: number };

/** What a package can still give back, read from its OWN ledger rows (spec §7.4):
 *  - `pack`: bought credits, pack consumes minus pack refunds. Always returnable.
 *  - `monthlyThisMonth`: included credits debited in the UTC month of `now`, minus included credits returned in that month.
 *    Returnable (P6).
 *  - `monthlyExpired`: every other included credit still debited — spent in a month that has ended. Never returnable;
 *    a return that reaches it forfeits it. It does NOT net the row's `credits_forfeited`: the caller subtracts that. */
export type Returnable = { pack: number; monthlyThisMonth: number; monthlyExpired: number };

/** A return of `credits` in P21's order: `pack` and `monthly` are written back to their buckets; `forfeited` is counted
 *  on the package row and writes nothing. */
export type ReturnPlan = { pack: number; monthly: number; forfeited: number };
