// The Online Chess receipt as a state machine (spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6; plan Task 12): which size and camera
// choice is on the receipt, which quote is on screen FOR it, whether a confirm is in flight, and what the last one came to.
// Pure, so every rule below is proven without a browser; `components/v2/online-chess/receipt.tsx` only draws it.
//
// THE RULES (each is a way a money screen goes wrong, and each has its test):
//  R1. A quote is on screen only for the choice it was read FOR. A new size or camera choice hides the old figures at once (the pick is
//      drawn with "checking the price", never with the previous size's total under it); an answer for a choice that is no longer wanted is
//      dropped.
//  R2. One confirm at a time. A press while one is in flight does nothing, and a press on a quote with no payable confirm does nothing
//      (loading, refused, inconsistent, short of credits: that one opens the credits chooser, it is never a payment).
//  R3. A 409 redraws the receipt with the fresh quote and says the price changed. Nothing was taken, and nothing is taken until the
//      organiser confirms the figure they now see: the press is not retried by the state machine.
//  R4. A short balance found at the debit turns the receipt into the Buy credits receipt, from the numbers the server answered.
//  R5. Any other failure keeps the receipt open on the same quote, with the code, and allows another press (the pay door is exactly-once by
//      state and the confirmed total: a repeated press cannot pay twice).
//  R6. The camera of a PAID package is a change AT the paid size (spec §8.6). A change receipt opens with no size chosen and does not list the paid
//      size (a size is changed TO another), so a camera ticked alone has no size to quote: ticking it with none chosen chooses the paid size, and
//      unticking it from there gives the size back (the paid size without a camera is nothing to pay). With another size chosen it changes nothing.
import type { OnlineSize } from "@/lib/online-chess-package";
import { confirmOf, payBodyOf, shortQuoteOf, type PayBody, type PayFailure, type ReceiptMode, type ReceiptQuote } from "@/lib/online-receipt";

export interface ReceiptChoice {
  size: OnlineSize;
  addCameras: boolean;
}

export interface ReceiptState {
  mode: ReceiptMode;
  /** The size the package is PAID at, on a `change` receipt over a paid package (R6); null otherwise. */
  paidSize: OnlineSize | null;
  /** The size on the receipt; null while none is chosen (`change`: it is chosen in the list). */
  size: OnlineSize | null;
  addCameras: boolean;
  /** The last quote that arrived, and the choice it was read for. */
  quote: ReceiptQuote | null;
  quoteFor: ReceiptChoice | null;
  /** The choice whose read failed (so the receipt says so and does not read it again in a loop). */
  readFailedFor: ReceiptChoice | null;
  submitting: boolean;
  /** The quote on screen was replaced after a 409: the receipt says the price changed until the organiser changes the choice. */
  changed: boolean;
  /** The code of the last press that failed in a way the receipt does not redraw for. */
  failed: string | null;
  /** `receipt`, or the credits chooser (the Buy credits press). */
  view: "receipt" | "buy";
}

export function initialReceipt(a: { mode: ReceiptMode; size: OnlineSize | null; quote: ReceiptQuote | null; paidSize?: OnlineSize | null }): ReceiptState {
  return {
    mode: a.mode,
    paidSize: a.mode === "change" ? (a.paidSize ?? null) : null,
    size: a.size,
    addCameras: false,
    quote: a.quote,
    quoteFor: a.quote !== null && a.size !== null && a.quote.size === a.size ? { size: a.size, addCameras: false } : null,
    readFailedFor: null,
    submitting: false,
    changed: false,
    failed: null,
    view: "receipt",
  };
}

export type ReceiptAction =
  | { type: "pick"; size: OnlineSize }
  | { type: "cameras"; on: boolean }
  | { type: "read"; choice: ReceiptChoice; quote: ReceiptQuote }
  | { type: "readFailed"; choice: ReceiptChoice }
  | { type: "submit" }
  | { type: "settled"; failure: PayFailure | null }
  | { type: "buy" }
  | { type: "back" };

const same = (a: ReceiptChoice | null, b: ReceiptChoice | null) => a !== null && b !== null && a.size === b.size && a.addCameras === b.addCameras;

/** The choice the receipt wants a quote for, or null while no size is chosen. */
export function wantedOf(s: ReceiptState): ReceiptChoice | null {
  return s.size === null ? null : { size: s.size, addCameras: s.addCameras };
}

/** The quote ON SCREEN (R1): the last one that arrived, only while it answers the choice now wanted. */
export function shownQuote(s: ReceiptState): ReceiptQuote | null {
  return same(s.quoteFor, wantedOf(s)) ? s.quote : null;
}

/** Whether a read is owed: a choice is made, no quote answers it, and its read has not already failed. */
export function readOwed(s: ReceiptState): ReceiptChoice | null {
  const want = wantedOf(s);
  return want !== null && !same(s.quoteFor, want) && !same(s.readFailedFor, want) ? want : null;
}

export function receiptReducer(s: ReceiptState, a: ReceiptAction): ReceiptState {
  switch (a.type) {
    case "pick":
      // R1: the new size's figures are not the old one's. A picked size while a confirm is in flight is ignored (the press is on its way).
      if (s.submitting || s.size === a.size) return s;
      return { ...s, size: a.size, changed: false, failed: null, view: "receipt" };
    case "cameras":
      if (s.submitting || s.addCameras === a.on) return s;
      // R6: the camera of a paid package is quoted AT the paid size; the tick with no size chosen chooses it, the untick from it gives it back.
      const size = s.paidSize === null ? s.size : a.on && s.size === null ? s.paidSize : !a.on && s.size === s.paidSize ? null : s.size;
      return { ...s, size, addCameras: a.on, changed: false, failed: null, view: "receipt" };
    case "read": {
      // R1: an answer for a choice nobody wants any more is dropped, and so is one whose own size is not the size it was read for.
      if (!same(a.choice, wantedOf(s)) || a.quote.size !== a.choice.size) return s;
      return { ...s, quote: a.quote, quoteFor: a.choice, readFailedFor: null };
    }
    case "readFailed":
      return same(a.choice, wantedOf(s)) ? { ...s, readFailedFor: a.choice } : s;
    case "submit": {
      // R2: one at a time, and only on a payable quote.
      if (s.submitting || payBodyOf(shownQuote(s), s.addCameras) === null) return s;
      return { ...s, submitting: true, failed: null };
    }
    case "settled": {
      if (!s.submitting) return s;
      const f = a.failure;
      if (f === null) return { ...s, submitting: false };
      if (f.kind === "changed") {
        // R3: the figures the server holds now. The size follows the quote's own (the server priced the size it was sent), and the
        // quote is for the choice the organiser had made, so the receipt shows it at once with the price-changed line.
        const choice: ReceiptChoice = { size: f.quote.size, addCameras: s.addCameras };
        return { ...s, submitting: false, size: f.quote.size, quote: f.quote, quoteFor: choice, readFailedFor: null, changed: true, failed: null };
      }
      if (f.kind === "noCredits") {
        // R4
        const q = shownQuote(s);
        if (q === null) return { ...s, submitting: false, failed: "ONLINE_CHESS_NO_CREDITS" };
        return { ...s, submitting: false, quote: shortQuoteOf(q, f), changed: false, failed: null };
      }
      return { ...s, submitting: false, failed: f.code }; // R5
    }
    case "buy":
      return !s.submitting && confirmOf(shownQuote(s)).kind === "buy" ? { ...s, view: "buy" } : s;
    case "back":
      return s.view === "buy" ? { ...s, view: "receipt" } : s;
  }
}

/** The body a press would send now, or null when no press is payable: what the confirm sends is what the receipt shows (R1, R2). */
export function pressBody(s: ReceiptState): PayBody | null {
  return s.submitting ? null : payBodyOf(shownQuote(s), s.addCameras);
}
