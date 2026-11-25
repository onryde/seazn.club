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
//  R6. Every receipt asks "Fair-play camera: Yes / No" (Task 15, owner 2026-11-25), and the answer is part of the choice a quote is read for (R1):
//      the total follows it. It opens at the division's camera SETTING in every mode, a change included (fix I2), or at the answer a checkout
//      return carried back; a change is still quoted against what was PAID (No at the paid size over a paid camera is the camera refund, Yes 0). A `change` receipt opens with no size chosen and does not list the paid size (a size is changed TO another), so
//      a camera answer with the size unchanged is quoted AT the paid size; the paid size at the paid camera state is no change at all (nothing is
//      read, nothing can be confirmed). The answer moves with the size and on its own alike, and one confirm pays the net of both.
import type { OnlineSize } from "@/lib/online-chess-package";
import { confirmOf, payBodyOf, shortQuoteOf, type PayBody, type PayFailure, type ReceiptMode, type ReceiptQuote } from "@/lib/online-receipt";

export interface ReceiptChoice {
  size: OnlineSize;
  /** The Fair-play camera answer: Yes (true) or No. */
  cameras: boolean;
}

export interface ReceiptState {
  mode: ReceiptMode;
  /** The size the package is PAID at, and whether its camera price was paid, on a `change` receipt over a paid package (R6); null otherwise. */
  paidSize: OnlineSize | null;
  paidCameras: boolean | null;
  /** The size on the receipt; null while none is chosen (`change`: it is chosen in the list, and none means the paid size, R6). */
  size: OnlineSize | null;
  /** The Fair-play camera answer on the receipt (R6). */
  cameras: boolean;
  /** Whether the division's camera SETTING says the camera is on, as the receipt opened over it. On a `change` receipt an answer at the paid size
   *  that matches what was paid but not the setting is still a change: it costs nothing and the pay door writes it back (fix round 3). */
  setting: boolean;
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

export function initialReceipt(a: {
  mode: ReceiptMode;
  size: OnlineSize | null;
  quote: ReceiptQuote | null;
  /** The paid package a `change` receipt changes (R6); ignored by the other modes. */
  paid?: { size: OnlineSize; camerasPaid: boolean } | null;
  /** The camera answer the receipt opens on (R6): the division's camera setting (every mode), or a checkout return's. */
  cameras: boolean;
  /** The division's camera setting (`facts.cameras`); when not given, the answer the receipt opens on - which is the setting, bar a checkout return. */
  setting?: boolean;
}): ReceiptState {
  const paid = a.mode === "change" ? (a.paid ?? null) : null;
  const s: ReceiptState = {
    mode: a.mode,
    paidSize: paid?.size ?? null,
    paidCameras: paid?.camerasPaid ?? null,
    size: a.size,
    cameras: a.cameras,
    setting: a.setting ?? a.cameras,
    quote: a.quote,
    quoteFor: null,
    readFailedFor: null,
    submitting: false,
    changed: false,
    failed: null,
    view: "receipt",
  };
  // A quote handed in is on screen only when it answers the choice the receipt opens on: its size AND its camera answer (R1).
  const want = wantedOf(s);
  return a.quote !== null && want !== null && a.quote.size === want.size && a.quote.cameras === want.cameras ? { ...s, quoteFor: want } : s;
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

const same = (a: ReceiptChoice | null, b: ReceiptChoice | null) => a !== null && b !== null && a.size === b.size && a.cameras === b.cameras;

/** The choice the receipt wants a quote for, or null when there is none: no size chosen (`pay`, `payAndOpen`), or - on a `change` receipt - the
 *  paid size at the paid camera state when the division's setting says it too, which changes nothing (R6). The paid size at the paid answer over a
 *  setting that says the other is a change of 0: the answer is written back to the setting (fix round 3). A `change` receipt with no size chosen
 *  asks about the PAID size. */
export function wantedOf(s: ReceiptState): ReceiptChoice | null {
  const size = s.size ?? (s.mode === "change" ? s.paidSize : null);
  if (size === null) return null;
  if (s.mode === "change" && size === s.paidSize && s.cameras === s.paidCameras && s.cameras === s.setting) return null;
  return { size, cameras: s.cameras };
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
      // R6: the answer is part of the choice (R1: its figures are not the other answer's). Ignored while a confirm is in flight.
      if (s.submitting || s.cameras === a.on) return s;
      return { ...s, cameras: a.on, changed: false, failed: null, view: "receipt" };
    case "read": {
      // R1: an answer for a choice nobody wants any more is dropped, and so is one whose own size is not the size it was read for.
      if (!same(a.choice, wantedOf(s)) || a.quote.size !== a.choice.size) return s;
      // A quote that did not price the camera answer it was asked about is not the figure the organiser chose: the read is counted as failed (the
      // receipt says the price could not be checked) rather than drawn, or read again in a loop.
      if (a.quote.cameras !== a.choice.cameras) return { ...s, readFailedFor: a.choice };
      return { ...s, quote: a.quote, quoteFor: a.choice, readFailedFor: null };
    }
    case "readFailed":
      return same(a.choice, wantedOf(s)) ? { ...s, readFailedFor: a.choice } : s;
    case "submit": {
      // R2: one at a time, and only on a payable quote.
      if (s.submitting || payBodyOf(shownQuote(s)) === null) return s;
      return { ...s, submitting: true, failed: null };
    }
    case "settled": {
      if (!s.submitting) return s;
      const f = a.failure;
      if (f === null) return { ...s, submitting: false };
      if (f.kind === "changed") {
        // R3: the figures the server holds now. The size AND the camera answer follow the quote's own (the server priced what it was sent - or,
        // for an unpaid Open round's 402, the division as it stands), so the receipt shows it at once, with the price-changed line.
        const choice: ReceiptChoice = { size: f.quote.size, cameras: f.quote.cameras };
        return { ...s, submitting: false, size: f.quote.size, cameras: f.quote.cameras, quote: f.quote, quoteFor: choice, readFailedFor: null, changed: true, failed: null };
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
  return s.submitting ? null : payBodyOf(shownQuote(s));
}
