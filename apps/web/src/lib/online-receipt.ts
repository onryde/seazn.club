// The Online Chess receipt's rules, pure and client-safe (spec 2026-11-23-online-chess-credits-design.md §8.3-§8.6; plan Task 12):
// what a quote says to the organiser, which button it arms, which figures the receipt prints, and how the server's refusals are read.
// Nothing here prices anything. Every number is the SERVER's (the quote's own `owed`, `take`, `back`, `shortBy`) or the leaf's
// (`lib/online-chess-package`: the ladder, the rounds a size includes, the price table); this module only decides what to SHOW and
// refuses to show a figure that does not add up.
//
// THE GUARDS, because a wrong figure here charges or tells the organiser the wrong amount:
//  * a quote from the wire is PARSED by the server's own schema (`OnlinePackageQuote`), never trusted as a type;
//  * the split a receipt prints must ADD UP to the total it asks them to confirm (take.monthly + take.pack = owed; back.pack +
//    back.monthly + back.forfeited = -owed). A quote that does not is "inconsistent": no confirm, and the receipt says it could not
//    check the price, rather than print figures that disagree with the button;
//  * the confirm button reads the quote that is ON SCREEN (`confirmOf`), and a quote read for another size or camera choice is not it.
import { OnlinePackageQuote } from "@/server/api-v1/schemas/online-package";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds, isOnlineSize, type OnlineSize } from "@/lib/online-chess-package";
import { onlineSizeOptions, type OnlineSizeDisabled } from "@/lib/online-size-options";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { STREAM_CREDIT_PACKS, type StreamPackSize } from "@/lib/stream-credit-packs";
import type { OpenRoundPayment, OpenRoundResult } from "@/lib/open-round";

/** The three ways the receipt opens (brief): `pay` the stored size (the amber line, a checkout return), `payAndOpen` the same at the
 *  moment the organiser presses Open round (decision 15), `change` a paid size (the chip, the select). */
export type ReceiptMode = "pay" | "payAndOpen" | "change";

/** A package quote as the receipt reads it: the server's `OnlinePackageQuote`, parsed. */
export type ReceiptQuote = ReturnType<typeof OnlinePackageQuote.parse>;

/** The quote a wire value is, or null when it is not one. The server's own schema decides - a body that does not parse is never drawn. */
export function quoteFromWire(raw: unknown): ReceiptQuote | null {
  const parsed = OnlinePackageQuote.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---- what the confirm button does ---------------------------------------------------------------------------------------------------

/** Why there is no confirm: the quote is still being read (`loading`), the server refused the size (`refused`: the reason is the quote's),
 *  the figures disagree with each other (`inconsistent`), or there is nothing to pay or change (`nothing`). */
export type NoConfirm = "loading" | "refused" | "inconsistent" | "nothing";

export type Confirm =
  /** Pay `credits` (> 0): the quote's `take` covers it. */
  | { kind: "pay"; credits: number }
  /** The balance is short: `shortBy` credits, `pack` the smallest bought pack that covers it. The button reads Buy credits. */
  | { kind: "buy"; shortBy: number; owed: number; balance: number; pack: StreamPackSize }
  /** A move down: `back` credits come back (bought + this month's; the earlier month's are `forfeited`, never returned). */
  | { kind: "moveDown"; back: number; forfeited: number }
  /** The size or camera state changes and no credit moves (a smaller size with cameras for what a larger one cost without). */
  | { kind: "change" }
  | { kind: "none"; why: NoConfirm };

/** The smallest bought pack whose credits cover `shortBy`; when none does (a shortfall above the largest pack), the largest - the
 *  organiser buys it and reads the receipt again. Throws on a shortfall that is not a whole number of at least 1: nothing is short by
 *  0 or by a fraction, and a pack must never be picked for one. */
export function smallestCoveringPack(shortBy: number): StreamPackSize {
  if (!Number.isInteger(shortBy) || shortBy < 1) throw new RangeError(`a shortfall must be a whole number of at least 1, got ${String(shortBy)}`);
  const packs = [...STREAM_CREDIT_PACKS].sort((a, b) => a.credits - b.credits);
  return (packs.find((p) => p.credits >= shortBy) ?? packs[packs.length - 1]!).size;
}

/** The confirm of the quote on screen. `quote` null is the read still in flight. */
export function confirmOf(quote: ReceiptQuote | null): Confirm {
  if (quote === null) return { kind: "none", why: "loading" };
  if (quote.refusal !== null) return { kind: "none", why: "refused" };
  if (quote.owed > 0) {
    if (quote.take !== null && quote.shortBy === null) {
      return quote.take.monthly >= 0 && quote.take.pack >= 0 && quote.take.monthly + quote.take.pack === quote.owed
        ? { kind: "pay", credits: quote.owed }
        : { kind: "none", why: "inconsistent" };
    }
    if (quote.take === null && quote.shortBy !== null) {
      // The shortfall is what the balance is missing: a figure that is not owed - balance is not the price the organiser is asked to cover.
      return quote.shortBy >= 1 && quote.shortBy === quote.owed - quote.balance
        ? { kind: "buy", shortBy: quote.shortBy, owed: quote.owed, balance: quote.balance, pack: smallestCoveringPack(quote.shortBy) }
        : { kind: "none", why: "inconsistent" };
    }
    return { kind: "none", why: "inconsistent" };
  }
  if (quote.owed < 0) {
    const b = quote.back;
    if (b === null || quote.take !== null || quote.shortBy !== null) return { kind: "none", why: "inconsistent" };
    return b.pack >= 0 && b.monthly >= 0 && b.forfeited >= 0 && b.pack + b.monthly + b.forfeited === -quote.owed
      ? { kind: "moveDown", back: b.pack + b.monthly, forfeited: b.forfeited }
      : { kind: "none", why: "inconsistent" };
  }
  return quote.take === null && quote.shortBy === null && quote.back === null ? { kind: "change" } : { kind: "none", why: "inconsistent" };
}

/** What the organiser confirmed, as the pay door and the open-round `pay` take it (`OnlinePackagePayInput`): the size and the TOTAL
 *  THE RECEIPT SHOWED, at most the one `addCameras` intent, and on a move down the credits the receipt said would not come back. */
export interface PayBody {
  size: OnlineSize;
  expectedOwed: number;
  addCameras?: true;
  expectedForfeited?: number;
}

/** The body for the quote on screen. Null unless its confirm is a payment, a move down or a plain change: a quote that is loading,
 *  refused, short of credits or inconsistent sends nothing. `addCameras` is sent only when the organiser asked for it. */
export function payBodyOf(quote: ReceiptQuote | null, addCameras: boolean): PayBody | null {
  const c = confirmOf(quote);
  if (quote === null || (c.kind !== "pay" && c.kind !== "moveDown" && c.kind !== "change")) return null;
  const body: PayBody = { size: quote.size, expectedOwed: quote.owed };
  if (addCameras) body.addCameras = true;
  // The forfeit the receipt printed rides with a move down (a month turning between the receipt and the confirm changes which credits
  // return without changing `owed`); a payment forfeits nothing.
  if (c.kind === "moveDown") body.expectedForfeited = c.forfeited;
  return body;
}

// ---- the server's refusals ----------------------------------------------------------------------------------------------------------

/** What a pay or a pay-and-open press came to. `changed`: the figures moved (409, or a 402 that carries a new quote) - the receipt redraws
 *  with `quote` and says so; nothing was taken. `noCredits`: the debit found the balance short. `failed`: anything else, by its code. */
export type PayFailure =
  | { kind: "changed"; quote: ReceiptQuote }
  | { kind: "noCredits"; owed: number; balance: number }
  | { kind: "failed"; code: string };

/** Reads an error thrown by the pay door or the open's `pay` (`ApiV1Error`-shaped: `code`, `extra`). A 409 ONLINE_QUOTE_CHANGED or a 402
 *  ONLINE_CHESS_UNPAID that carries a quote is `changed`; ONLINE_CHESS_NO_CREDITS with its two whole numbers is `noCredits`; a body that
 *  lacks what its code promises is `failed`, never a half-drawn receipt. */
export function payFailureOf(err: unknown): PayFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; extra?: unknown };
  const code = typeof e.code === "string" ? e.code : "UNKNOWN";
  const extra = (typeof e.extra === "object" && e.extra !== null ? e.extra : {}) as Record<string, unknown>;
  if (code === ONLINE_PACKAGE_CODES.quoteChanged || code === ONLINE_PACKAGE_CODES.unpaid) {
    const quote = quoteFromWire(extra.quote);
    return quote === null ? { kind: "failed", code } : { kind: "changed", quote };
  }
  if (code === ONLINE_PACKAGE_CODES.noCredits) {
    const { owed, balance } = extra;
    return Number.isInteger(owed) && Number.isInteger(balance) && (owed as number) > 0 && (balance as number) >= 0
      ? { kind: "noCredits", owed: owed as number, balance: balance as number }
      : { kind: "failed", code };
  }
  return { kind: "failed", code };
}

/** The 402 an unpaid Open round answers (`ONLINE_CHESS_UNPAID { quote, next, invitable }`): the quote for the STORED size, when that size cannot be
 *  bought for the division the smallest size that would hold it, and how many boards of the round the press would invite (the boards no Lichess
 *  link holds back - `invitable` 0 is the receipt's "nobody to invite" warning). `invitable` is null when the body does not carry a whole,
 *  non-negative count: UNKNOWN, never read as zero. Null when the error is not an unpaid 402, or its quote does not parse. */
export function unpaidOf(err: unknown): { quote: ReceiptQuote; next: ReceiptQuote | null; invitable: number | null } | null {
  const e = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; extra?: unknown };
  if (e.code !== ONLINE_PACKAGE_CODES.unpaid) return null;
  const extra = (typeof e.extra === "object" && e.extra !== null ? e.extra : {}) as Record<string, unknown>;
  const quote = quoteFromWire(extra.quote);
  if (quote === null) return null;
  const next = extra.next === null || extra.next === undefined ? null : quoteFromWire(extra.next);
  const invitable = Number.isInteger(extra.invitable) && (extra.invitable as number) >= 0 ? (extra.invitable as number) : null;
  // A `next` that is present and does not parse is dropped: the receipt still offers the stored size's own reason.
  return { quote, next, invitable };
}

/** After a refused or short payment: the quote with the balance the server found, for the Buy credits button. The shortfall is the server's
 *  own `owed` less its `balance`. */
export function shortQuoteOf(quote: ReceiptQuote, f: { owed: number; balance: number }): ReceiptQuote {
  return { ...quote, owed: f.owed, balance: f.balance, take: null, back: null, shortBy: f.owed - f.balance };
}

// ---- the sizes the receipt lists ----------------------------------------------------------------------------------------------------

/** What choosing a smaller size than the reference one costs the organiser in entry (spec §8.5): the places held and where late entry stops. */
export interface SizeConsequence {
  held: number;
  size: OnlineSize;
}

export interface ReceiptSizeRow {
  size: OnlineSize;
  rounds: number;
  /** The leaf's price at the division's camera state. */
  price: number;
  /** On a paid row: the price less what the row's own size and camera state cost (> 0 pay, < 0 back). Null when unpaid. */
  diff: number | null;
  disabled: OnlineSizeDisabled | null;
  /** The size the package already is (paid), or the stored size the organiser chose (unpaid): the one a payment does not move. */
  reference: boolean;
  /** A smaller size than the reference one that still fits: its entry consequence. */
  consequence: SizeConsequence | null;
}

/** The ladder as the receipt lists it. `reference` is the paid size, or the stored size of an unpaid row. In `change` mode the paid size is
 *  not offered (a size is changed TO another); in `pay` and `payAndOpen` every size is, the stored one included. */
export function receiptSizeRows(a: {
  mode: ReceiptMode;
  reference: OnlineSize;
  planCap: number | null;
  held: number;
  rounds: number;
  cameras: boolean;
  paid: { size: OnlineSize; camerasPaid: boolean } | null;
}): ReceiptSizeRow[] {
  const options = onlineSizeOptions({ planCap: a.planCap, held: a.held, rounds: a.rounds, cameras: a.cameras, paid: a.paid });
  return options
    .filter((o) => !(a.mode === "change" && o.size === a.reference))
    .map((o): ReceiptSizeRow => ({
      size: o.size,
      rounds: o.rounds,
      price: o.price,
      diff: o.diff,
      disabled: o.disabled,
      reference: o.size === a.reference,
      consequence: o.disabled === null && o.size < a.reference ? { held: a.held, size: o.size } : null,
    }));
}

/** The size the receipt opens on. `payAndOpen` (decision 15): the size the organiser CHOSE, i.e. the stored one - never the smallest that
 *  fits - unless the server refused it for this division, then the smallest size it offered (`next`), which the organiser still confirms
 *  by its own price. `pay`: the stored size, or the checkout return's target. `change`: the size a select pick or a return named, else none
 *  (a size is chosen in the list). */
export function initialReceiptSize(a: {
  mode: ReceiptMode;
  stored: OnlineSize;
  requested: OnlineSize | null;
  quote: ReceiptQuote | null;
  next: ReceiptQuote | null;
}): OnlineSize | null {
  if (a.mode === "change") return a.requested;
  if (a.mode === "payAndOpen") return a.quote !== null && a.quote.refusal !== null ? (a.next?.size ?? null) : a.stored;
  return a.requested ?? a.stored;
}

// ---- why a size is refused ------------------------------------------------------------------------------------------------------------

/** The sentence a refused quote says, as a dictionary key and its variables: the SERVER's reason (`quote.refusal`), in the organiser's words.
 *  A key per reason, so a new reason is a compile error here and a missing sentence in the dictionary test, never a blank line. */
export const RECEIPT_REFUSAL_KEYS = {
  below_held: "onlineChess.receipt.refused.held",
  plan: "onlineChess.receipt.refused.plan",
  rounds: "onlineChess.receipt.refused.rounds",
  rounds_above_max: "onlineChess.roundsAboveMax",
  frozen: "onlineChess.receipt.refused.frozen",
} as const satisfies Record<NonNullable<ReceiptQuote["refusal"]>, string>;

export function refusalCopyOf(quote: ReceiptQuote & { refusal: NonNullable<ReceiptQuote["refusal"]> }): { key: (typeof RECEIPT_REFUSAL_KEYS)[keyof typeof RECEIPT_REFUSAL_KEYS]; vars: Record<string, number> } {
  const key = RECEIPT_REFUSAL_KEYS[quote.refusal];
  switch (quote.refusal) {
    case "below_held": return { key, vars: { held: quote.held } };
    case "rounds": return { key, vars: { rounds: quote.rounds } };
    case "rounds_above_max": return { key, vars: { max: includedRounds(ONLINE_SIZES[ONLINE_SIZES.length - 1]!) } };
    case "plan":
    case "frozen": return { key, vars: {} };
  }
}

// ---- words and dates ----------------------------------------------------------------------------------------------------------------

/** "30 Nov": the last day of the month this month's included credits expire (`monthlyExpiresOn`, an ISO date), in the organiser's language.
 *  UTC on purpose - the ledger's month is the UTC month, so the date is the server's own. Anything that is not a plain ISO date reads as "". */
export function expiryText(isoDate: string, locale: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocaleFor(locale), { day: "numeric", month: "short", timeZone: "UTC" }).format(at);
}

/** What an Open round press's `payment` says happened, for the round's notice. Never a word about money unless the payment was APPLIED
 *  (`applied` false: the `pay` was ignored - the package was frozen or already at that size - and `credits` is 0). A move down says the
 *  new size and no credit figure: `payment.credits` is the quote's owed, which overstates what returns when earlier-month credits are
 *  forfeited (the receipt printed the real split from the quote). */
export type PaymentNotice =
  | { kind: "paid"; credits: number; size: number; capacityLoweredTo: number | null }
  | { kind: "moved"; size: number; capacityLoweredTo: number | null };

export function paymentNoticeOf(result: OpenRoundResult): PaymentNotice | null {
  // `payment` is null when no `pay` was sent; an answer from before the field existed omits it, and a body that is not an object is no payment.
  const p = result.opened ? (result.payment as unknown) : null;
  if (typeof p !== "object" || p === null || (p as { applied?: unknown }).applied !== true) return null;
  return paymentNoticeFrom(p as OpenRoundPayment);
}

function paymentNoticeFrom(p: OpenRoundPayment): PaymentNotice {
  return p.credits > 0
    ? { kind: "paid", credits: p.credits, size: p.size, capacityLoweredTo: p.capacityLoweredTo }
    : { kind: "moved", size: p.size, capacityLoweredTo: p.capacityLoweredTo };
}

/** Whether `n` is a size on the ladder, narrowed (the checkout return's `size`, a radio's value). */
export function asOnlineSize(n: unknown): OnlineSize | null {
  return typeof n === "number" && isOnlineSize(n) ? n : null;
}

export { ONLINE_SIZES };
