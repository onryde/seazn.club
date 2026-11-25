// The receipt as a state machine (rules R1-R5 in lib/online-receipt-state.ts; spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6).
// Every rule is a way a money screen goes wrong. Expected totals are the price leaf's; the sequences are the organiser's own: pick a size, change
// their mind, press twice, find the price moved, find the balance short.
import { describe, expect, it } from "vitest";
import { packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import {
  initialReceipt, pressBody, readOwed, receiptReducer, shownQuote, wantedOf, type ReceiptAction, type ReceiptChoice, type ReceiptState,
} from "@/lib/online-receipt-state";
import { quoteOf } from "./_receipt-quote";

const run = (s: ReceiptState, ...actions: ReceiptAction[]) => actions.reduce(receiptReducer, s);
const read = (size: OnlineSize, addCameras = false, monthly = 50): ReceiptAction => ({
  type: "read",
  choice: { size, addCameras },
  quote: quoteOf({ size, cameras: addCameras, monthly }),
});
const open = (size: OnlineSize | null = 32) => initialReceipt({ mode: "pay", size, quote: null });

describe("R1: a quote is on screen only for the choice it was read for", () => {
  it("the first read draws the receipt; before it, nothing is shown and a read is owed", () => {
    const s0 = open(32);
    expect(shownQuote(s0)).toBeNull();
    expect(readOwed(s0)).toEqual({ size: 32, addCameras: false });
    const s1 = run(s0, read(32));
    expect(shownQuote(s1)?.owed).toBe(packagePrice(32, false));
    expect(readOwed(s1)).toBeNull();
  });

  it("picking another size hides the old figures at once - the old total is never under the new pick", () => {
    const s = run(open(32), read(32), { type: "pick", size: 64 });
    expect(shownQuote(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
    expect(readOwed(s)).toEqual({ size: 64, addCameras: false });
  });

  it("an answer for a size nobody wants any more is dropped (a slow read landing after a second pick)", () => {
    const s = run(open(32), { type: "pick", size: 64 }, { type: "pick", size: 128 }, read(64), read(128));
    expect(wantedOf(s)).toEqual({ size: 128, addCameras: false });
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
    const s = run(open(32), { type: "read", choice: { size: 32, addCameras: false }, quote: quoteOf({ size: 64, monthly: 50 }) });
    expect(shownQuote(s)).toBeNull();
  });

  it("the camera choice is part of the choice: toggling it hides the figures, and the answer must match it", () => {
    const s = run(open(32), read(32), { type: "cameras", on: true });
    expect(shownQuote(s)).toBeNull();
    expect(readOwed(s)).toEqual({ size: 32, addCameras: true });
    const after = run(s, read(32, false), read(32, true));
    expect(shownQuote(after)?.cameras).toBe(true);
    expect(shownQuote(after)?.owed).toBe(packagePrice(32, true));
  });

  it("a change-mode receipt opens with no size chosen: nothing to read, nothing to press", () => {
    const s = initialReceipt({ mode: "change", size: null, quote: null });
    expect(wantedOf(s)).toBeNull();
    expect(readOwed(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
    expect(receiptReducer(s, { type: "submit" })).toBe(s);
  });

  it("an initial quote (the 402's) is shown at once for its own size and not for another", () => {
    const q = quoteOf({ size: 32, monthly: 50 });
    expect(shownQuote(initialReceipt({ mode: "payAndOpen", size: 32, quote: q }))).toBe(q);
    expect(shownQuote(initialReceipt({ mode: "payAndOpen", size: 64, quote: q }))).toBeNull();
  });

  it("a read that failed is not read again in a loop, until the choice changes", () => {
    const s = run(open(32), { type: "readFailed", choice: { size: 32, addCameras: false } });
    expect(readOwed(s)).toBeNull();
    expect(readOwed(run(s, { type: "pick", size: 64 }))).toEqual({ size: 64, addCameras: false });
    // a failure for a choice no longer wanted changes nothing
    const other = run(open(32), { type: "pick", size: 64 }, { type: "readFailed", choice: { size: 32, addCameras: false } });
    expect(readOwed(other)).toEqual({ size: 64, addCameras: false });
  });
});

describe("R2: one confirm at a time, and only on a payable quote", () => {
  it("a payable quote arms exactly the body the receipt shows", () => {
    const s = run(open(64), read(64));
    expect(pressBody(s)).toEqual({ size: 64, expectedOwed: packagePrice(64, false) });
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
    const refused = run(open(32), { type: "read", choice: { size: 32, addCameras: false }, quote: quoteOf({ size: 32, monthly: 50, refusal: "plan" }) });
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
    expect(pressBody(s)).toEqual({ size: 32, expectedOwed: moved.owed });
    expect(pressBody(s)?.expectedOwed).not.toBe(packagePrice(32, false)); // not the figure they confirmed first
    // exactly one in-flight press across the whole sequence: a second submit is a new, deliberate one
    const again = receiptReducer(s, { type: "submit" });
    expect(again.submitting).toBe(true);
    expect(receiptReducer(again, { type: "submit" })).toBe(again);
  });

  it("choosing something else clears the price-changed line", () => {
    const s = run(open(32), read(32), { type: "submit" }, { type: "settled", failure: { kind: "changed", quote: moved } }, { type: "pick", size: 64 });
    expect(s.changed).toBe(false);
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
        const choice: ReceiptChoice = { size, addCameras: cameras };
        const s = run(open(size), cameras ? { type: "cameras", on: true } : { type: "pick", size }, { type: "read", choice, quote: quoteOf({ size, cameras, monthly: 100 }) });
        expect(pressBody(s), `${size}/${cameras}`).toEqual(cameras ? { size, expectedOwed: packagePrice(size, true), addCameras: true } : { size, expectedOwed: packagePrice(size, false) });
        checked += 1;
      }
    }
    expect(checked).toBe(10);
  });
});

// R6 (fix round 2): the camera of a PAID package. The change receipt opens with NO size chosen (the paid size is not in its list: a size is
// changed TO another), so a camera ticked on its own had no size to read a quote for and the button stayed "Choose a size" - the camera upgrade
// at the paid size (spec 8.6) was unreachable. Ticking the camera now chooses the paid size; unticking it with nothing else chosen gives it back.
describe("R6: adding the camera to a paid package is a change AT the paid size", () => {
  const SIZES = [16, 32, 64, 128, 256] as const;
  const paidOpen = (paidSize: OnlineSize | null, size: OnlineSize | null = null, mode: "change" | "pay" = "change") =>
    initialReceipt({ mode, size, quote: null, paidSize });
  const paidQuote = (size: OnlineSize, paidSize: OnlineSize, addCameras: boolean) =>
    quoteOf({ size, cameras: addCameras, paid: { size: paidSize, camerasPaid: false }, monthly: 100 });

  it("with no size chosen, ticking the camera chooses the paid size: a read is owed for (paid size, camera on) and nothing is shown before it", () => {
    const s = run(paidOpen(64), { type: "cameras", on: true });
    expect(wantedOf(s)).toEqual({ size: 64, addCameras: true });
    expect(readOwed(s)).toEqual({ size: 64, addCameras: true });
    expect(shownQuote(s)).toBeNull();
    expect(pressBody(s)).toBeNull();
  });

  it("the quote that answers it arms the camera difference at the paid size, and only that: the server's owed, addCameras sent", () => {
    const choice: ReceiptChoice = { size: 64, addCameras: true };
    const s = run(paidOpen(64), { type: "cameras", on: true }, { type: "read", choice, quote: paidQuote(64, 64, true) });
    const diff = packagePrice(64, true) - packagePrice(64, false);
    expect(diff, "premise: the camera costs something at 64").toBeGreaterThan(0);
    expect(shownQuote(s)?.owed).toBe(diff);
    expect(pressBody(s)).toEqual({ size: 64, expectedOwed: diff, addCameras: true });
  });

  it("unticking it with nothing else chosen gives the size back: the paid size without a camera is nothing to pay, never an armed no-op", () => {
    const choice: ReceiptChoice = { size: 64, addCameras: true };
    const ticked = run(paidOpen(64), { type: "cameras", on: true }, { type: "read", choice, quote: paidQuote(64, 64, true) });
    const off = run(ticked, { type: "cameras", on: false });
    expect(wantedOf(off)).toBeNull();
    expect(shownQuote(off)).toBeNull();
    expect(readOwed(off)).toBeNull();
    expect(pressBody(off)).toBeNull();
  });

  it("with another size chosen, the camera tick leaves the size alone (a move up or down with cameras), and unticking leaves it too", () => {
    const up = run(paidOpen(64), { type: "pick", size: 128 }, { type: "cameras", on: true });
    expect(wantedOf(up)).toEqual({ size: 128, addCameras: true });
    expect(wantedOf(run(up, { type: "cameras", on: false }))).toEqual({ size: 128, addCameras: false });
    const down = run(paidOpen(64), { type: "pick", size: 32 }, { type: "cameras", on: true });
    expect(wantedOf(down)).toEqual({ size: 32, addCameras: true });
  });

  it("picking another size after the camera tick moves off the paid size and keeps the camera", () => {
    const s = run(paidOpen(64), { type: "cameras", on: true }, { type: "pick", size: 128 });
    expect(wantedOf(s)).toEqual({ size: 128, addCameras: true });
    expect(wantedOf(run(s, { type: "cameras", on: false })), "off at another size stays at that size").toEqual({ size: 128, addCameras: false });
  });

  it("only a change receipt over a PAID package does this: pay mode and an unpaid package (no paid size) keep the old behaviour", () => {
    expect(wantedOf(run(paidOpen(null), { type: "cameras", on: true })), "no paid size: nothing to choose").toBeNull();
    expect(wantedOf(run(paidOpen(64, null, "pay"), { type: "cameras", on: true })), "pay mode").toBeNull();
    expect(wantedOf(run(paidOpen(null, 32, "pay"), { type: "cameras", on: true })), "pay mode keeps its size").toEqual({ size: 32, addCameras: true });
  });

  it("sweep: at every paid size the tick chooses THAT size, and the camera difference is the leaf's", () => {
    let checked = 0;
    for (const paidSize of SIZES) {
      const choice: ReceiptChoice = { size: paidSize, addCameras: true };
      const s = run(paidOpen(paidSize), { type: "cameras", on: true }, { type: "read", choice, quote: paidQuote(paidSize, paidSize, true) });
      expect(pressBody(s), `paid ${paidSize}`).toEqual({ size: paidSize, expectedOwed: packagePrice(paidSize, true) - packagePrice(paidSize, false), addCameras: true });
      checked += 1;
    }
    expect(checked).toBe(SIZES.length);
  });

  it("a confirm in flight keeps the choice: the tick while submitting is ignored", () => {
    const choice: ReceiptChoice = { size: 64, addCameras: true };
    const submitting = run(paidOpen(64), { type: "cameras", on: true }, { type: "read", choice, quote: paidQuote(64, 64, true) }, { type: "submit" });
    expect(submitting.submitting).toBe(true);
    expect(run(submitting, { type: "cameras", on: false })).toBe(submitting);
  });

  it("seeded with the camera intent (the return from buying credits for it): the paid size and the box on, a read owed at once; only on a change receipt over a paid package", () => {
    const seeded = initialReceipt({ mode: "change", size: 64, quote: null, paidSize: 64, addCameras: true });
    expect(wantedOf(seeded)).toEqual({ size: 64, addCameras: true });
    expect(readOwed(seeded)).toEqual({ size: 64, addCameras: true });
    for (const [label, s] of [
      ["pay mode", initialReceipt({ mode: "pay", size: 64, quote: null, paidSize: 64, addCameras: true })],
      ["no paid size", initialReceipt({ mode: "change", size: 64, quote: null, paidSize: null, addCameras: true })],
      ["intent off", initialReceipt({ mode: "change", size: 64, quote: null, paidSize: 64, addCameras: false })],
    ] as const) expect(wantedOf(s)?.addCameras, label).toBe(false);
  });
});
