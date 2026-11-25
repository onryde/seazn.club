// The receipt as a state machine (rules R1-R6 in lib/online-receipt-state.ts; spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6).
// Every rule is a way a money screen goes wrong. Expected totals are the price leaf's; the sequences are the organiser's own: pick a size, change
// their mind, press twice, find the price moved, find the balance short.
import { describe, expect, it } from "vitest";
import { packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { payFailureOf } from "@/lib/online-receipt";
import {
  frozenOf, initialReceipt, pressBody, readOwed, receiptReducer, shownQuote, wantedOf, type ReceiptAction, type ReceiptChoice, type ReceiptState,
} from "@/lib/online-receipt-state";
import { quoteOf } from "./_receipt-quote";

const run = (s: ReceiptState, ...actions: ReceiptAction[]) => actions.reduce(receiptReducer, s);
const read = (size: OnlineSize, cameras = false, monthly = 50): ReceiptAction => ({
  type: "read",
  choice: { size, cameras },
  quote: quoteOf({ size, cameras, monthly }),
});
const open = (size: OnlineSize | null = 32, cameras = false) => initialReceipt({ mode: "pay", size, quote: null, cameras, setting: cameras });

describe("R1: a quote is on screen only for the choice it was read for", () => {
  it("the first read draws the receipt; before it, nothing is shown and a read is owed", () => {
    const s0 = open(32);
    expect(shownQuote(s0)).toBeNull();
    expect(readOwed(s0)).toEqual({ size: 32, cameras: false });
    const s1 = run(s0, read(32));
    expect(shownQuote(s1)?.owed).toBe(packagePrice(32, false));
    expect(readOwed(s1)).toBeNull();
  });

  it("picking another size hides the old figures at once - the old total is never under the new pick", () => {
    const s = run(open(32), read(32), { type: "pick", size: 64 });
    expect(shownQuote(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
    expect(readOwed(s)).toEqual({ size: 64, cameras: false });
  });

  it("an answer for a size nobody wants any more is dropped (a slow read landing after a second pick)", () => {
    const s = run(open(32), { type: "pick", size: 64 }, { type: "pick", size: 128 }, read(64), read(128));
    expect(wantedOf(s)).toEqual({ size: 128, cameras: false });
    expect(shownQuote(s)?.size).toBe(128);
    // ...and the other order: the answer for the size wanted lands FIRST, the stale one after - it must not clobber it
    const late = run(open(32), { type: "pick", size: 64 }, { type: "pick", size: 128 }, read(128), read(64));
    expect(shownQuote(late)?.size).toBe(128);
    expect(readOwed(late)).toBeNull(); // no re-read: the good quote survived
    // the stale one alone leaves nothing on screen
    const stale = run(open(32), { type: "pick", size: 64 }, read(32));
    expect(shownQuote(stale)).toBeNull();
  });

  it("an answer whose own size is not the size it was read for is dropped", () => {
    const s = run(open(32), { type: "read", choice: { size: 32, cameras: false }, quote: quoteOf({ size: 64, monthly: 50 }) });
    expect(shownQuote(s)).toBeNull();
  });

  it("the camera choice is part of the choice: toggling it hides the figures, and the answer must match it", () => {
    const s = run(open(32), read(32), { type: "cameras", on: true });
    expect(shownQuote(s)).toBeNull();
    expect(readOwed(s)).toEqual({ size: 32, cameras: true });
    const after = run(s, read(32, false), read(32, true));
    expect(shownQuote(after)?.cameras).toBe(true);
    expect(shownQuote(after)?.owed).toBe(packagePrice(32, true));
  });

  it("a change-mode receipt opens with no size chosen: nothing to read, nothing to press", () => {
    const s = initialReceipt({ mode: "change", size: null, quote: null, cameras: false, setting: false });
    expect(wantedOf(s)).toBeNull();
    expect(readOwed(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
    expect(receiptReducer(s, { type: "submit" })).toBe(s);
  });

  it("an initial quote (the 402's) is shown at once for its own size and camera answer, and not for another", () => {
    const q = quoteOf({ size: 32, monthly: 50 });
    expect(shownQuote(initialReceipt({ mode: "payAndOpen", size: 32, quote: q, cameras: false, setting: false }))).toBe(q);
    expect(shownQuote(initialReceipt({ mode: "payAndOpen", size: 64, quote: q, cameras: false, setting: false }))).toBeNull();
    // the receipt opened on the camera answer Yes: a quote priced without it is not its figure, and a read is owed instead
    const yes = initialReceipt({ mode: "payAndOpen", size: 32, quote: q, cameras: true, setting: true });
    expect(shownQuote(yes)).toBeNull();
    expect(readOwed(yes)).toEqual({ size: 32, cameras: true });
  });

  it("an answer that priced the OTHER camera answer is not drawn: the read counts as failed (no loop), until the choice changes", () => {
    const s = run(open(32, true), { type: "read", choice: { size: 32, cameras: true }, quote: quoteOf({ size: 32, cameras: false, monthly: 50 }) });
    expect(shownQuote(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
    expect(readOwed(s), "not read again in a loop").toBeNull();
    expect(s.readFailedFor).toEqual({ size: 32, cameras: true });
    expect(readOwed(run(s, { type: "cameras", on: false })), "another answer is read").toEqual({ size: 32, cameras: false });
  });

  it("a read that failed is not read again in a loop, until the choice changes", () => {
    const s = run(open(32), { type: "readFailed", choice: { size: 32, cameras: false } });
    expect(readOwed(s)).toBeNull();
    expect(readOwed(run(s, { type: "pick", size: 64 }))).toEqual({ size: 64, cameras: false });
    // a failure for a choice no longer wanted changes nothing
    const other = run(open(32), { type: "pick", size: 64 }, { type: "readFailed", choice: { size: 32, cameras: false } });
    expect(readOwed(other)).toEqual({ size: 64, cameras: false });
  });
});

describe("R2: one confirm at a time, and only on a payable quote", () => {
  it("a payable quote arms exactly the body the receipt shows", () => {
    const s = run(open(64), read(64));
    expect(pressBody(s)).toEqual({ size: 64, expectedOwed: packagePrice(64, false), cameras: false });
  });

  it("a second press while one is in flight does nothing, and the body is withheld", () => {
    const s1 = run(open(32), read(32), { type: "submit" });
    expect(s1.submitting).toBe(true);
    expect(pressBody(s1)).toBeNull();
    expect(receiptReducer(s1, { type: "submit" })).toBe(s1);
  });

  it("a pick or a camera toggle while a confirm is in flight is ignored: the figures on the wire cannot move", () => {
    const s1 = run(open(32), read(32), { type: "submit" });
    expect(receiptReducer(s1, { type: "pick", size: 64 })).toBe(s1);
    expect(receiptReducer(s1, { type: "cameras", on: true })).toBe(s1);
  });

  it("a press with no quote, a refused quote, a short balance does nothing", () => {
    const loading = open(32);
    expect(receiptReducer(loading, { type: "submit" })).toBe(loading);
    const refused = run(open(32), { type: "read", choice: { size: 32, cameras: false }, quote: quoteOf({ size: 32, monthly: 50, refusal: "plan" }) });
    expect(receiptReducer(refused, { type: "submit" })).toBe(refused);
    const short = run(open(32), read(32, false, 1));
    expect(receiptReducer(short, { type: "submit" })).toBe(short);
  });

  it("success ends the press and leaves the receipt for the caller to close", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: null });
    expect(s.submitting).toBe(false);
    expect(s.failed).toBeNull();
  });

  it("a settle with no press in flight is ignored", () => {
    const s = run(open(32), read(32));
    expect(receiptReducer(s, { type: "settled", failure: { kind: "failed", code: "X" } })).toBe(s);
  });
});

describe("R3: a 409 redraws with the fresh quote; nothing is taken until the organiser confirms the figure they now see", () => {
  const moved = quoteOf({ size: 32, monthly: 50, paid: { size: 16, camerasPaid: false } });

  it("redraws on the quote the server holds, says the price changed, and is NOT submitting", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "changed", quote: moved } });
    expect(s.submitting).toBe(false);
    expect(s.changed).toBe(true);
    expect(shownQuote(s)).toBe(moved);
    expect(readOwed(s)).toBeNull(); // no second read: the 409 carried the quote
  });

  it("the body to confirm is the NEW total, and onConfirm is not re-fired by the machine", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "changed", quote: moved } });
    expect(pressBody(s)).toEqual({ size: 32, expectedOwed: moved.owed, cameras: false });
    expect(pressBody(s)?.expectedOwed).not.toBe(packagePrice(32, false)); // not the figure they confirmed first
    // exactly one in-flight press across the whole sequence: a second submit is a new, deliberate one
    const again = receiptReducer(s, { type: "submit" });
    expect(again.submitting).toBe(true);
    expect(receiptReducer(again, { type: "submit" })).toBe(again);
  });

  it("the camera answer follows the fresh quote too: the server priced the division as it stands (an Open round's 402)", () => {
    const withCamera = quoteOf({ size: 32, cameras: true, monthly: 50 });
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "changed", quote: withCamera } });
    expect(s.cameras).toBe(true);
    expect(shownQuote(s)).toBe(withCamera);
    expect(pressBody(s)).toEqual({ size: 32, expectedOwed: packagePrice(32, true), cameras: true });
  });

  it("choosing something else clears the price-changed line", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "changed", quote: moved } }, { type: "pick", size: 64 });
    expect(s.changed).toBe(false);
  });
});

// R7. The refusal the server answers a pay with when a round opened in another tab is the SAME 409 ONLINE_QUOTE_CHANGED as a moved price
// (pay.ts `quoteChanged`: one code, the fresh quote in its body, whose `refusal` is "frozen"): there is no frozen code to branch on, so the
// state reads the quote. The package is then closed for good (spec 8.7): the receipt says so instead of "the price changed", and takes no
// further size or camera pick. Driven through the real reader of the wire error (`payFailureOf`), never a hand-built PayFailure.
describe("R7: a 409 that says a round has opened freezes the receipt: no 'price changed', no further pick", () => {
  /** What the pay door throws (ApiV1Error-shaped: `code`, `extra`) when the package was frozen under the press. */
  const wire = (quote: ReturnType<typeof quoteOf>) => ({ code: ONLINE_PACKAGE_CODES.quoteChanged, extra: { quote } });
  const MODES = {
    pay: () => open(32),
    payAndOpen: () => initialReceipt({ mode: "payAndOpen", size: 32, quote: null, cameras: false, setting: false }),
    change: () => initialReceipt({ mode: "change", size: 32, quote: null, paid: { size: 16, camerasPaid: false }, cameras: false, setting: false }),
  } as const;
  const paidAt16 = { size: 16 as OnlineSize, camerasPaid: false };

  /** The receipt as the organiser reaches it: a size chosen, its quote read, the press sent, the server's 409 settled through the real reader. */
  function pressedAndFrozen(mode: keyof typeof MODES): ReceiptState {
    const paid = mode === "change" ? paidAt16 : undefined;
    const frozen = quoteOf({ size: 32, monthly: 50, refusal: "frozen", ...(paid ? { paid } : {}) });
    const failure = payFailureOf(wire(frozen));
    expect(failure.kind, "premise: the 409 body is a quote the server's own schema reads").toBe("changed");
    return run(MODES[mode](), { type: "read", choice: { size: 32, cameras: false }, quote: quoteOf({ size: 32, monthly: 50, ...(paid ? { paid } : {}) }) }, { type: "submit" }, { type: "settled", failure });
  }

  it("the receipt does not say the price changed (it did not), and shows the refused quote it can no longer confirm", () => {
    let checked = 0;
    for (const mode of Object.keys(MODES) as (keyof typeof MODES)[]) {
      const s = pressedAndFrozen(mode);
      expect(s.submitting, mode).toBe(false);
      expect(frozenOf(s), `${mode}: frozen`).toBe(true);
      expect(s.changed, `${mode}: nothing about a price moving`).toBe(false);
      expect(shownQuote(s)?.refusal, `${mode}: the refusal is on screen`).toBe("frozen");
      expect(pressBody(s), `${mode}: nothing to confirm`).toBeNull();
      checked += 1;
    }
    expect(checked, "pay, payAndOpen, change").toBe(3);
  });

  it("a size or camera pick after the freeze does nothing: the state is the very same object", () => {
    let checked = 0;
    for (const mode of Object.keys(MODES) as (keyof typeof MODES)[]) {
      const s = pressedAndFrozen(mode);
      expect(receiptReducer(s, { type: "pick", size: 64 }), `${mode}: pick`).toBe(s);
      expect(receiptReducer(s, { type: "cameras", on: true }), `${mode}: cameras`).toBe(s);
      expect(readOwed(s), `${mode}: no read is owed for a locked choice`).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("the freeze is also learned from an ordinary read (the receipt opened after the round did): the same lock", () => {
    const s = run(open(32), { type: "read", choice: { size: 32, cameras: false }, quote: quoteOf({ size: 32, monthly: 50, refusal: "frozen" }) });
    expect(frozenOf(s)).toBe(true);
    expect(receiptReducer(s, { type: "pick", size: 64 })).toBe(s);
    expect(receiptReducer(s, { type: "cameras", on: true })).toBe(s);
  });

  it("frozen is the package's, not one choice's: a frozen quote in hand for another camera answer still locks the receipt", () => {
    // The 402's quote priced the stored size WITHOUT the camera; the receipt opens on Yes (a checkout return's answer): the quote is not on
    // screen for it, but a closed package is closed at every size and answer.
    const q = quoteOf({ size: 32, cameras: false, monthly: 50, refusal: "frozen" });
    const s = initialReceipt({ mode: "payAndOpen", size: 32, quote: q, cameras: true, setting: true });
    expect(shownQuote(s), "premise: that quote is not the one on screen for this answer").toBeNull();
    expect(frozenOf(s)).toBe(true);
    expect(receiptReducer(s, { type: "pick", size: 64 })).toBe(s);
    expect(receiptReducer(s, { type: "cameras", on: false })).toBe(s);
  });

  it("the other pair: a 409 over a moved price (and a refusal that is not frozen) is NOT frozen - the choice stays open and the price line still shows", () => {
    const moved = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: payFailureOf(wire(quoteOf({ size: 32, cameras: true, monthly: 50 }))) });
    expect(frozenOf(moved)).toBe(false);
    expect(moved.changed).toBe(true);
    expect(receiptReducer(moved, { type: "pick", size: 64 }).size).toBe(64);
    // a size refused for another reason (it cannot hold the places held) is a size to move away from, not a closed package
    const held = run(open(16), read(16), { type: "submit" }, { type: "settled", failure: payFailureOf(wire(quoteOf({ size: 16, monthly: 50, refusal: "below_held", held: 20 }))) });
    expect(frozenOf(held)).toBe(false);
    expect(receiptReducer(held, { type: "pick", size: 64 }).size).toBe(64);
    expect(frozenOf(open(32))).toBe(false);
    expect(frozenOf(run(open(32), read(32)))).toBe(false);
  });
});

describe("R4: a short balance found at the debit becomes the Buy credits receipt", () => {
  it("replaces the quote by the server's own numbers: shortfall = owed - balance, never a payable body", () => {
    const s = run(open(64), read(64), { type: "submit" }, { type: "settled", failure: { kind: "noCredits", owed: 4, balance: 1 } });
    const q = shownQuote(s)!;
    expect(q).toMatchObject({ owed: 4, balance: 1, shortBy: 3, take: null });
    expect(pressBody(s)).toBeNull();
    expect(s.submitting).toBe(false);
  });

  it("with no quote on screen it keeps the code as the failure", () => {
    const base = run(open(64), read(64), { type: "submit" });
    const noQuote: ReceiptState = { ...base, quoteFor: null };
    expect(receiptReducer(noQuote, { type: "settled", failure: { kind: "noCredits", owed: 4, balance: 1 } }).failed).toBe("ONLINE_CHESS_NO_CREDITS");
  });

  it("Buy credits opens the chooser only from a short quote, and Back returns to the receipt", () => {
    const payable = run(open(64), read(64));
    expect(receiptReducer(payable, { type: "buy" })).toBe(payable);
    const short = run(open(64), read(64, false, 1));
    const buying = receiptReducer(short, { type: "buy" });
    expect(buying.view).toBe("buy");
    expect(receiptReducer(buying, { type: "back" }).view).toBe("receipt");
    expect(receiptReducer(payable, { type: "back" })).toBe(payable);
  });
});

describe("R5: any other failure keeps the receipt open on the same quote and allows another press", () => {
  it("keeps the code, the quote and the choice, and the press is armed again", () => {
    const s0 = run(open(32), read(32));
    const s = run(s0, { type: "submit" }, { type: "settled", failure: { kind: "failed", code: "ONLINE_SIZE_FROZEN" } });
    expect(s.failed).toBe("ONLINE_SIZE_FROZEN");
    expect(s.submitting).toBe(false);
    expect(shownQuote(s)).toBe(shownQuote(s0));
    expect(pressBody(s)).not.toBeNull();
  });

  it("a new press clears the last failure", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "failed", code: "X" } }, { type: "submit" });
    expect(s.failed).toBeNull();
    expect(s.submitting).toBe(true);
  });
});

describe("sweep: every reachable choice reads, presses and settles", () => {
  it("each size and camera state arms its own body and nothing else", () => {
    let checked = 0;
    for (const size of [16, 32, 64, 128, 256] as const) {
      for (const cameras of [false, true]) {
        const choice: ReceiptChoice = { size, cameras };
        const s = run(open(size), cameras ? { type: "cameras", on: true } : { type: "pick", size }, { type: "read", choice, quote: quoteOf({ size, cameras, monthly: 100 }) });
        expect(pressBody(s), `${size}/${cameras}`).toEqual({ size, expectedOwed: packagePrice(size, cameras), cameras });
        checked += 1;
      }
    }
    expect(checked).toBe(10);
  });
});

// R6 (Task 15, owner 2026-11-25): every receipt asks "Fair-play camera: Yes / No", opening at the division's camera setting (`pay`,
// `payAndOpen`) or the paid package's (`change`). The answer is part of the choice (R1). A `change` receipt opens with no size chosen and does
// not list the paid size, so an answer alone is quoted AT the paid size; the paid size at the paid answer is no change at all. Expected totals
// are the price leaf's: on a paid package, what the answer costs at the size less what the package holds.
describe("R6: the Fair-play camera answer, on every receipt", () => {
  const SIZES = [16, 32, 64, 128, 256] as const;
  type Paid = { size: OnlineSize; camerasPaid: boolean };
  const change = (paid: Paid, cameras = paid.camerasPaid, size: OnlineSize | null = null) =>
    initialReceipt({ mode: "change", size, quote: null, paid, cameras, setting: cameras });
  const answer = (size: OnlineSize, cameras: boolean, paid?: Paid): ReceiptAction => ({
    type: "read",
    choice: { size, cameras },
    quote: quoteOf({ size, cameras, ...(paid ? { paid } : {}), monthly: 100 }),
  });
  const holds = (p: Paid) => packagePrice(p.size, p.camerasPaid);

  it("opens at the answer the caller gives, in every mode", () => {
    let checked = 0;
    for (const mode of ["pay", "payAndOpen"] as const) {
      for (const cameras of [false, true]) {
        expect(wantedOf(initialReceipt({ mode, size: 32, quote: null, cameras, setting: cameras })), `${mode}/${cameras}`).toEqual({ size: 32, cameras });
        checked += 1;
      }
    }
    for (const camerasPaid of [false, true]) {
      expect(change({ size: 64, camerasPaid }).cameras, `change/${camerasPaid}`).toBe(camerasPaid);
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("pay: Yes -> No -> Yes hides the figures at every turn, and each answer arms its own body; the same answer twice is no action", () => {
    const no1 = run(open(32), read(32));
    expect(pressBody(no1)).toEqual({ size: 32, expectedOwed: packagePrice(32, false), cameras: false });
    const yes = run(no1, { type: "cameras", on: true });
    expect(shownQuote(yes)).toBeNull();
    expect(pressBody(yes)).toBeNull();
    expect(readOwed(yes)).toEqual({ size: 32, cameras: true });
    const yesRead = run(yes, read(32, true));
    expect(pressBody(yesRead)).toEqual({ size: 32, expectedOwed: packagePrice(32, true), cameras: true });
    expect(receiptReducer(yesRead, { type: "cameras", on: true }), "Yes again changes nothing").toBe(yesRead);
    const no2 = run(yesRead, { type: "cameras", on: false });
    expect(shownQuote(no2)).toBeNull();
    expect(readOwed(no2)).toEqual({ size: 32, cameras: false });
    expect(pressBody(run(no2, read(32)))).toEqual({ size: 32, expectedOwed: packagePrice(32, false), cameras: false });
  });

  it("change: no size chosen at the answer the package holds is no change - nothing to read, nothing to press", () => {
    let checked = 0;
    for (const camerasPaid of [false, true]) {
      const s = change({ size: 64, camerasPaid });
      expect(wantedOf(s), `held ${camerasPaid}`).toBeNull();
      expect(readOwed(s)).toBeNull();
      expect(pressBody(s)).toBeNull();
      expect(receiptReducer(s, { type: "submit" })).toBe(s);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("change: Yes on a package paid without the camera is quoted AT the paid size, and arms the camera difference", () => {
    const paid = { size: 64, camerasPaid: false } as const;
    const s = run(change(paid), { type: "cameras", on: true });
    expect(wantedOf(s)).toEqual({ size: 64, cameras: true });
    expect(readOwed(s)).toEqual({ size: 64, cameras: true });
    const read1 = run(s, answer(64, true, paid));
    const diff = packagePrice(64, true) - holds(paid);
    expect(diff, "premise: the camera costs something at 64").toBeGreaterThan(0);
    expect(pressBody(read1)).toEqual({ size: 64, expectedOwed: diff, cameras: true });
  });

  it("change: No on a package paid WITH the camera is a move down at the paid size - the camera price comes back", () => {
    const paid = { size: 64, camerasPaid: true } as const;
    const s = run(change(paid), { type: "cameras", on: false });
    expect(wantedOf(s)).toEqual({ size: 64, cameras: false });
    const read1 = run(s, answer(64, false, paid));
    const back = holds(paid) - packagePrice(64, false);
    expect(back, "premise: the camera price is something to give back").toBeGreaterThan(0);
    expect(shownQuote(read1)?.owed).toBe(-back);
    expect(pressBody(read1)).toEqual({ size: 64, expectedOwed: -back, cameras: false, expectedForfeited: 0 });
  });

  it("change: on -> off -> on walks between a change and no change, and never leaves an old figure armed", () => {
    const paid = { size: 32, camerasPaid: false } as const;
    const on1 = run(change(paid), { type: "cameras", on: true }, answer(32, true, paid));
    expect(pressBody(on1)?.cameras).toBe(true);
    const off = run(on1, { type: "cameras", on: false });
    expect(wantedOf(off), "back at what is held: no change").toBeNull();
    expect(pressBody(off)).toBeNull();
    // Back at Yes: the one quote kept was read for exactly this choice (R1), so it is the figure again - as a size picked away and back is.
    const on2 = run(off, { type: "cameras", on: true });
    expect(shownQuote(on2)).toBe(shownQuote(on1));
    expect(pressBody(on2)).toEqual(pressBody(on1));
    // The same walk from a package paid WITH the camera: No (a move down), Yes (no change, nothing armed), No again (its figures).
    const paidNo = run(change({ size: 32, camerasPaid: true }), { type: "cameras", on: false }, answer(32, false, { size: 32, camerasPaid: true }));
    const viaYes = run(paidNo, { type: "cameras", on: true });
    expect(wantedOf(viaYes), "held answer: no change").toBeNull();
    const backNo = run(viaYes, { type: "cameras", on: false });
    expect(shownQuote(backNo)).toBe(shownQuote(paidNo));
  });

  it("change: the paid size at the paid answer is still a change when the SETTING says otherwise - it writes the setting back, 0 owed (fix round 3)", () => {
    // Division settings may move the camera off a paid camera (free, P19), or on over one paid without it. The receipt opens at the setting; the
    // organiser's answer that matches what was PAID, at the paid size, costs nothing but is still an answer the setting does not say: the pay door
    // writes it back. Only the paid size at the answer the package AND the setting both say is no change at all.
    let wanted = 0;
    let none = 0;
    for (const camerasPaid of [false, true]) {
      for (const setting of [false, true]) {
        for (const yes of [false, true]) {
          const paid = { size: 64, camerasPaid } as const;
          const s = run(initialReceipt({ mode: "change", size: null, quote: null, paid, cameras: setting, setting }), { type: "cameras", on: yes });
          const label = `paid camera ${camerasPaid}, setting ${setting}, answer ${yes}`;
          if (yes === camerasPaid && yes === setting) {
            expect(wantedOf(s), `${label}: nothing changes`).toBeNull();
            none += 1;
          } else {
            expect(wantedOf(s), label).toEqual({ size: 64, cameras: yes });
            const r = run(s, answer(64, yes, paid));
            expect(pressBody(r)?.expectedOwed, `${label}: the price leaf's difference`).toBe(packagePrice(64, yes) - holds(paid));
            wanted += 1;
          }
        }
      }
    }
    // The two at-target answers that differ from the setting are the round-3 cases (Yes over a paid camera turned off; No over one paid without, turned on).
    expect([wanted, none], "anti-vacuity").toEqual([6, 2]);
  });

  it("change: a size AND a camera change are ONE choice - one read, one body, the net of both", () => {
    let checked = 0;
    const cases: { paid: Paid; size: OnlineSize; cameras: boolean }[] = [
      { paid: { size: 64, camerasPaid: false }, size: 128, cameras: true }, // up, camera on
      { paid: { size: 64, camerasPaid: true }, size: 32, cameras: false }, // down, camera off
      { paid: { size: 32, camerasPaid: false }, size: 16, cameras: true }, // down a size, camera on: the net may be nothing
      { paid: { size: 32, camerasPaid: true }, size: 64, cameras: false }, // up a size, camera off
    ];
    for (const c of cases) {
      const s = run(change(c.paid), { type: "pick", size: c.size }, { type: "cameras", on: c.cameras });
      expect(wantedOf(s)).toEqual({ size: c.size, cameras: c.cameras });
      const r = run(s, answer(c.size, c.cameras, c.paid));
      const net = packagePrice(c.size, c.cameras) - holds(c.paid);
      const body = pressBody(r);
      expect(body?.expectedOwed, JSON.stringify(c)).toBe(net);
      expect(body?.size).toBe(c.size);
      expect(body?.cameras).toBe(c.cameras);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("change: picking back to the paid size at the answer held is no change again; the answer survives a size pick", () => {
    const paid = { size: 64, camerasPaid: false } as const;
    const s = run(change(paid), { type: "cameras", on: true }, { type: "pick", size: 128 });
    expect(wantedOf(s)).toEqual({ size: 128, cameras: true });
    expect(wantedOf(run(s, { type: "cameras", on: false })), "No at another size stays at that size").toEqual({ size: 128, cameras: false });
    expect(wantedOf(run(s, { type: "cameras", on: false }, { type: "pick", size: 64 })), "the paid size at the held answer").toBeNull();
    expect(wantedOf(run(s, { type: "pick", size: 64 })), "the paid size with the other answer is a change").toEqual({ size: 64, cameras: true });
  });

  it("a confirm in flight keeps the answer: a camera pick while submitting is ignored, in every mode", () => {
    const paid = { size: 64, camerasPaid: false } as const;
    const inFlight = [
      run(change(paid), { type: "cameras", on: true }, answer(64, true, paid), { type: "submit" }),
      run(open(32), read(32), { type: "submit" }),
      run(initialReceipt({ mode: "payAndOpen", size: 32, quote: null, cameras: true, setting: true }), read(32, true), { type: "submit" }),
    ];
    for (const s of inFlight) {
      expect(s.submitting).toBe(true);
      expect(receiptReducer(s, { type: "cameras", on: !s.cameras })).toBe(s);
    }
    expect(inFlight).toHaveLength(3);
  });

  it("seeded with a checkout return's answer, either way: the receipt reopens on the answer the buyer left with", () => {
    const yesOverNo = change({ size: 64, camerasPaid: false }, true);
    expect(wantedOf(yesOverNo)).toEqual({ size: 64, cameras: true });
    expect(readOwed(yesOverNo)).toEqual({ size: 64, cameras: true });
    const noOverYes = change({ size: 64, camerasPaid: true }, false);
    expect(wantedOf(noOverYes)).toEqual({ size: 64, cameras: false });
    const withSize = change({ size: 64, camerasPaid: false }, true, 128);
    expect(wantedOf(withSize)).toEqual({ size: 128, cameras: true });
    expect(wantedOf(initialReceipt({ mode: "pay", size: 32, quote: null, cameras: false, setting: false }))).toEqual({ size: 32, cameras: false });
    expect(wantedOf(initialReceipt({ mode: "pay", size: 32, quote: null, cameras: true, setting: true }))).toEqual({ size: 32, cameras: true });
  });

  it("the paid facts mean nothing outside a change receipt: pay mode with a paid package still wants its own size", () => {
    const s = initialReceipt({ mode: "pay", size: 64, quote: null, paid: { size: 64, camerasPaid: false }, cameras: false, setting: false });
    expect(s.paidSize).toBeNull();
    expect(wantedOf(s)).toEqual({ size: 64, cameras: false });
    expect(wantedOf(initialReceipt({ mode: "pay", size: null, quote: null, cameras: true, setting: true })), "no size: nothing to read").toBeNull();
  });

  it("sweep: at every paid size and held answer, the other answer alone is a change at that size by the leaf's difference", () => {
    let checked = 0;
    for (const size of SIZES) {
      for (const camerasPaid of [false, true]) {
        const paid = { size, camerasPaid };
        expect(wantedOf(change(paid)), `${size}/${camerasPaid}: held answer`).toBeNull();
        const s = run(change(paid), { type: "cameras", on: !camerasPaid }, answer(size, !camerasPaid, paid));
        const owed = packagePrice(size, !camerasPaid) - holds(paid);
        expect(owed, "premise: the answer moves the price").not.toBe(0);
        expect(pressBody(s)?.expectedOwed, `${size}/${camerasPaid}`).toBe(owed);
        expect(pressBody(s)?.cameras).toBe(!camerasPaid);
        checked += 1;
      }
    }
    expect(checked).toBe(SIZES.length * 2);
  });
});
