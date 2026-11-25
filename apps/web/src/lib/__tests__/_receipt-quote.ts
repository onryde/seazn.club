// A package quote for the receipt's suites. Every figure is DERIVED from the price leaf and the quote's own arithmetic (spec
// 2026-11-23-online-chess-credits-design.md §7.4 item 1): the price is `packagePrice`, `owed` is price less what the row's own size cost, the
// debit splits the included credits first (P4), a short balance's `shortBy` is owed less balance. Nothing here reads the receipt's code.
import { packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { ReceiptQuote } from "@/lib/online-receipt";

export interface QuoteSpec {
  size: OnlineSize;
  cameras?: boolean;
  /** The paid package's own size and camera state; absent = an unpaid row (owed is the whole price). */
  paid?: { size: OnlineSize; camerasPaid: boolean };
  /** The two buckets the org holds. */
  monthly?: number;
  pack?: number;
  held?: number;
  rounds?: number;
  refusal?: ReceiptQuote["refusal"];
  /** On a move down: how much of the return is an earlier month's included credits (forfeited), and how much of the rest was this month's. */
  forfeited?: number;
  backMonthly?: number;
}

export function quoteOf(s: QuoteSpec): ReceiptQuote {
  const cameras = s.cameras ?? false;
  const price = packagePrice(s.size, cameras);
  const owed = s.paid === undefined ? price : price - packagePrice(s.paid.size, s.paid.camerasPaid);
  const monthly = s.monthly ?? 0;
  const pack = s.pack ?? 0;
  const balance = monthly + pack;
  const refusal = s.refusal ?? null;
  let take: ReceiptQuote["take"] = null;
  let shortBy: number | null = null;
  let back: ReceiptQuote["back"] = null;
  if (refusal === null && owed > 0) {
    if (balance >= owed) {
      const m = Math.min(monthly, owed);
      take = { monthly: m, pack: owed - m };
    } else shortBy = owed - balance;
  } else if (refusal === null && owed < 0) {
    const returned = -owed;
    const forfeited = s.forfeited ?? 0;
    const kept = returned - forfeited;
    const backMonthly = Math.min(s.backMonthly ?? 0, kept);
    back = { pack: kept - backMonthly, monthly: backMonthly, forfeited };
  }
  return {
    size: s.size,
    cameras,
    price,
    owed,
    take,
    shortBy,
    back,
    monthlyExpiresOn: "2026-11-30",
    balance,
    held: s.held ?? 0,
    rounds: s.rounds ?? 0,
    refusal,
    covers: false,
  };
}
