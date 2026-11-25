// The Online Chess receipt's rules (spec 2026-11-23-online-chess-credits-design.md §8.3-§8.6; plan Task 12): which button a quote arms,
// the body a press sends, how the server's refusals are read, the sizes listed and the size the receipt opens on.
//
// Expected values come from the spec, the price leaf and the pack catalogue - typed or derived from THEM, never from the module under test.
// Anti-vacuity: every sweep reports how many cells it checked and zero is a failure. The wire is checked against the server's OWN schemas
// (`OnlinePackageQuote`, `OnlinePackagePayInput`): a body this module builds must be one the pay door accepts.
import { describe, expect, it } from "vitest";
import { OnlinePackagePayInput, OnlinePackageQuote } from "@/server/api-v1/schemas/online-package";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import {
  confirmOf, expiryText, initialReceiptSize, payBodyOf, paymentNoticeOf, payFailureOf, quoteFromWire, receiptSizeRows, shortQuoteOf,
  smallestCoveringPack, unpaidOf, type ReceiptQuote,
} from "@/lib/online-receipt";
import type { OpenRoundResult } from "@/lib/open-round";
import { quoteOf } from "./_receipt-quote";

const REFUSALS = ["below_held", "plan", "rounds", "rounds_above_max", "frozen"] as const;

describe("quoteFromWire: the server's own schema decides what a quote is", () => {
  it("accepts a quote the server could send, for every size and camera state (sweep)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const cameras of [false, true]) {
        const q = quoteOf({ size, cameras, monthly: 3, pack: 40 });
        expect(OnlinePackageQuote.safeParse(q).success, `the fixture is a real quote: ${size}/${cameras}`).toBe(true);
        expect(quoteFromWire(JSON.parse(JSON.stringify(q)))).toEqual(q);
        checked += 1;
      }
    }
    expect(checked).toBe(10);
  });

  it("refuses what is not a quote: a missing field, a size off the ladder, an unknown refusal, text, null", () => {
    const good = quoteOf({ size: 32, monthly: 5 });
    const { owed: _owed, ...noOwed } = good;
    void _owed;
    for (const bad of [noOwed, { ...good, size: 48 }, { ...good, refusal: "other" }, { ...good, owed: "2" }, { ...good, take: { monthly: 1 } }, "quote", null, undefined, 7, []]) {
      expect(quoteFromWire(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("confirmOf: the button the quote on screen arms", () => {
  it("a payable quote is Pay, for the leaf's price, at every size and camera state (sweep)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const cameras of [false, true]) {
        const price = packagePrice(size, cameras);
        expect(confirmOf(quoteOf({ size, cameras, monthly: 100 })), `${size}/${cameras}`).toEqual({ kind: "pay", credits: price });
        checked += 1;
      }
    }
    expect(checked).toBe(10);
  });

  it("a loading read arms nothing", () => {
    expect(confirmOf(null)).toEqual({ kind: "none", why: "loading" });
  });

  it("every refusal arms nothing, even for a size that would otherwise be payable (sweep)", () => {
    let checked = 0;
    for (const refusal of REFUSALS) {
      expect(confirmOf(quoteOf({ size: 32, monthly: 100, refusal })), refusal).toEqual({ kind: "none", why: "refused" });
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("a short balance reads Buy credits with the smallest covering pack: a shortfall of 3 is the 5 pack (brief)", () => {
    // 64 players with cameras = 8 credits; the org holds 5, so it is 3 short.
    const q = quoteOf({ size: 64, cameras: true, monthly: 2, pack: 3 });
    expect(q.shortBy).toBe(3);
    expect(confirmOf(q)).toEqual({ kind: "buy", shortBy: 3, owed: 8, balance: 5, pack: 5 });
  });

  it("the covering pack, from the catalogue's three packs of 1, 5 and 20 credits: the smallest that covers, else the largest (table)", () => {
    const table: [number, number][] = [[1, 1], [2, 5], [3, 5], [5, 5], [6, 20], [20, 20], [21, 20], [32, 20]];
    for (const [shortBy, pack] of table) expect(smallestCoveringPack(shortBy), `short by ${shortBy}`).toBe(pack);
    expect(table.length).toBe(8);
  });

  it("a shortfall that is not a whole number of at least 1 never picks a pack", () => {
    for (const bad of [0, -1, 0.5, Number.NaN, Infinity]) expect(() => smallestCoveringPack(bad), String(bad)).toThrow(RangeError);
  });

  it("a move down arms Move down with what comes back and what is forfeited (bought + this month's, never the earlier month's)", () => {
    // 64 with cameras (8 paid) moved to 32 with cameras (4): 4 come back; 1 of them is an earlier month's included credit, forfeited.
    const q = quoteOf({ size: 32, cameras: true, paid: { size: 64, camerasPaid: true }, forfeited: 1, backMonthly: 1 });
    expect(q.owed).toBe(-4);
    expect(q.back).toEqual({ pack: 2, monthly: 1, forfeited: 1 });
    expect(confirmOf(q)).toEqual({ kind: "moveDown", back: 3, forfeited: 1 });
  });

  it("a plain change (owed 0) arms Change size; an unpaid quote can never be owed 0", () => {
    // 16 with cameras (2) bought for what 32 without (2) cost: the row moves, no credit does.
    const q = quoteOf({ size: 16, cameras: true, paid: { size: 32, camerasPaid: false } });
    expect(q.owed).toBe(0);
    expect(confirmOf(q)).toEqual({ kind: "change" });
  });

  it("figures that do not add up arm nothing (inconsistent): a take that is not the total, a shortfall that is not owed less balance", () => {
    const pay = quoteOf({ size: 32, monthly: 1, pack: 5 }); // owed 2 = 1 + 1
    const cases: [string, ReceiptQuote][] = [
      ["take under the total", { ...pay, take: { monthly: 1, pack: 0 } }],
      ["take over the total", { ...pay, take: { monthly: 1, pack: 2 } }],
      ["a negative part", { ...pay, take: { monthly: 3, pack: -1 } }],
      ["take AND shortBy", { ...pay, shortBy: 1 }],
      ["owed with neither take nor shortBy", { ...pay, take: null }],
      ["shortBy that is not owed less balance", { ...quoteOf({ size: 32, monthly: 1 }), shortBy: 2 }],
      ["a zero shortBy", { ...quoteOf({ size: 32, monthly: 1 }), shortBy: 0 }],
    ];
    const down = quoteOf({ size: 32, cameras: true, paid: { size: 64, camerasPaid: true }, forfeited: 1, backMonthly: 1 });
    cases.push(
      ["back under the return", { ...down, back: { pack: 2, monthly: 0, forfeited: 1 } }],
      ["back over the return", { ...down, back: { pack: 3, monthly: 1, forfeited: 1 } }],
      ["a move down with no split", { ...down, back: null }],
      ["a move down that also takes", { ...down, take: { monthly: 1, pack: 0 } }],
      ["owed 0 with a split", { ...quoteOf({ size: 16, cameras: true, paid: { size: 32, camerasPaid: false } }), back: { pack: 0, monthly: 0, forfeited: 0 } }],
    );
    for (const [name, q] of cases) expect(confirmOf(q), name).toEqual({ kind: "none", why: "inconsistent" });
    expect(cases.length).toBe(12);
  });
});

describe("payBodyOf: what the confirm sends is what the receipt showed", () => {
  it("a payment sends the size and the total shown, and nothing else", () => {
    expect(payBodyOf(quoteOf({ size: 64, monthly: 20 }), false)).toEqual({ size: 64, expectedOwed: 4 });
  });

  it("addCameras rides only when the organiser asked for it", () => {
    const q = quoteOf({ size: 32, cameras: true, monthly: 20 });
    expect(payBodyOf(q, true)).toEqual({ size: 32, expectedOwed: 4, addCameras: true });
    expect(payBodyOf(q, false)).toEqual({ size: 32, expectedOwed: 4 });
    expect("addCameras" in payBodyOf(q, false)!).toBe(false);
  });

  it("a move down carries the negative total and the forfeit the receipt printed - including 0", () => {
    const withForfeit = quoteOf({ size: 32, cameras: true, paid: { size: 64, camerasPaid: true }, forfeited: 1, backMonthly: 1 });
    expect(payBodyOf(withForfeit, false)).toEqual({ size: 32, expectedOwed: -4, expectedForfeited: 1 });
    const none = quoteOf({ size: 32, paid: { size: 64, camerasPaid: false }, backMonthly: 1 });
    expect(payBodyOf(none, false)).toEqual({ size: 32, expectedOwed: -2, expectedForfeited: 0 });
  });

  it("a payment never carries a forfeit", () => {
    expect("expectedForfeited" in payBodyOf(quoteOf({ size: 32, monthly: 20 }), false)!).toBe(false);
  });

  it("sends nothing for a quote that is loading, refused, short of credits or inconsistent", () => {
    expect(payBodyOf(null, false)).toBeNull();
    expect(payBodyOf(quoteOf({ size: 32, monthly: 20, refusal: "plan" }), false)).toBeNull();
    expect(payBodyOf(quoteOf({ size: 32, monthly: 1 }), false)).toBeNull(); // short: that is Buy credits
    expect(payBodyOf({ ...quoteOf({ size: 32, monthly: 20 }), take: { monthly: 0, pack: 0 } }, false)).toBeNull();
  });

  it("every body it builds is one the pay door's own strict schema accepts (sweep over sizes, cameras and the three kinds)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const cameras of [false, true]) {
        const bodies = [
          payBodyOf(quoteOf({ size, cameras, monthly: 100 }), false),
          payBodyOf(quoteOf({ size, cameras: true, monthly: 100 }), true),
          size === 256 ? null : payBodyOf(quoteOf({ size, cameras, paid: { size: 256, camerasPaid: cameras }, forfeited: 1, backMonthly: 1 }), false),
        ];
        for (const body of bodies) {
          if (body === null) continue;
          expect(OnlinePackagePayInput.safeParse(body).success, JSON.stringify(body)).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25);
  });
});

describe("payFailureOf / unpaidOf: the server's refusals, read", () => {
  const fresh = quoteOf({ size: 32, monthly: 20 });
  const err = (code: string, extra: Record<string, unknown>) => ({ status: 409, code, extra });

  it("409 ONLINE_QUOTE_CHANGED carries the fresh quote: changed", () => {
    expect(payFailureOf(err(ONLINE_PACKAGE_CODES.quoteChanged, { quote: fresh }))).toEqual({ kind: "changed", quote: fresh });
  });

  it("a 402 ONLINE_CHESS_UNPAID that carries a quote on a press with `pay` is a changed quote too", () => {
    expect(payFailureOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: fresh, next: null }))).toEqual({ kind: "changed", quote: fresh });
  });

  it("a 409 whose quote does not parse is a failure by its code, never a half-drawn receipt", () => {
    expect(payFailureOf(err(ONLINE_PACKAGE_CODES.quoteChanged, { quote: { size: 32 } }))).toEqual({ kind: "failed", code: "ONLINE_QUOTE_CHANGED" });
    expect(payFailureOf(err(ONLINE_PACKAGE_CODES.quoteChanged, {}))).toEqual({ kind: "failed", code: "ONLINE_QUOTE_CHANGED" });
  });

  it("402 ONLINE_CHESS_NO_CREDITS with its two whole numbers is noCredits; anything else by that code fails", () => {
    expect(payFailureOf(err(ONLINE_PACKAGE_CODES.noCredits, { owed: 8, balance: 5 }))).toEqual({ kind: "noCredits", owed: 8, balance: 5 });
    for (const extra of [{}, { owed: 8 }, { owed: 8.5, balance: 5 }, { owed: "8", balance: 5 }, { owed: 0, balance: 5 }, { owed: 8, balance: -1 }]) {
      expect(payFailureOf(err(ONLINE_PACKAGE_CODES.noCredits, extra)), JSON.stringify(extra)).toEqual({ kind: "failed", code: "ONLINE_CHESS_NO_CREDITS" });
    }
  });

  it("any other code, a non-error, and a missing code are failures by name", () => {
    expect(payFailureOf(err("PAYMENT_REQUIRED", {}))).toEqual({ kind: "failed", code: "PAYMENT_REQUIRED" });
    expect(payFailureOf(new Error("boom"))).toEqual({ kind: "failed", code: "UNKNOWN" });
    expect(payFailureOf(null)).toEqual({ kind: "failed", code: "UNKNOWN" });
    expect(payFailureOf("x")).toEqual({ kind: "failed", code: "UNKNOWN" });
  });

  it("unpaidOf reads the 402 an Open round press answers: the stored size's quote, the size that would hold the division and how many boards it would invite", () => {
    const stored = quoteOf({ size: 16, monthly: 20, held: 20, refusal: "below_held" });
    const next = quoteOf({ size: 32, monthly: 20, held: 20 });
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: stored, next, invitable: 3 }))).toEqual({ quote: stored, next, invitable: 3 });
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: next, next: null, invitable: 1 }))).toEqual({ quote: next, next: null, invitable: 1 });
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: next, invitable: 2 }))).toEqual({ quote: next, next: null, invitable: 2 });
  });

  it("unpaidOf: ZERO invitable boards is a count (the warning's case), not an absent one", () => {
    const q = quoteOf({ size: 16, monthly: 20 });
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: q, next: null, invitable: 0 }))!.invitable).toBe(0);
  });

  it("unpaidOf: a count the body does not carry, or carries malformed, is UNKNOWN (null) - never read as zero, so no warning is drawn from it", () => {
    const q = quoteOf({ size: 16, monthly: 20 });
    let checked = 0;
    for (const extra of [{}, { invitable: null }, { invitable: -1 }, { invitable: 1.5 }, { invitable: "3" }, { invitable: Number.NaN }, { invitable: undefined }]) {
      expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: q, next: null, ...extra }))!.invitable, JSON.stringify(extra)).toBeNull();
      checked += 1;
    }
    expect(checked, "every malformed shape was checked").toBe(7);
  });

  it("unpaidOf is null for another code or a quote that does not parse; a `next` that does not parse is dropped", () => {
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.quoteChanged, { quote: fresh }))).toBeNull();
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: { size: 32 } }))).toBeNull();
    expect(unpaidOf(null)).toBeNull();
    expect(unpaidOf(err(ONLINE_PACKAGE_CODES.unpaid, { quote: fresh, next: { size: 64 }, invitable: 2 }))).toEqual({ quote: fresh, next: null, invitable: 2 });
  });

  it("a short quote is the server's own owed less its balance", () => {
    const short = shortQuoteOf(fresh, { owed: 8, balance: 5 });
    expect(short).toMatchObject({ owed: 8, balance: 5, shortBy: 3, take: null, back: null });
    expect(confirmOf(short)).toMatchObject({ kind: "buy", shortBy: 3, pack: 5 });
  });
});

describe("receiptSizeRows: the sizes the receipt lists", () => {
  const FACTS = { reference: 64 as OnlineSize, planCap: null, held: 0, rounds: 0, cameras: false, paid: null };

  it("lists the whole ladder on an unpaid row, each at the leaf's price and rounds, and marks the stored size", () => {
    const rows = receiptSizeRows({ mode: "payAndOpen", ...FACTS });
    expect(rows.map((r) => r.size)).toEqual([...ONLINE_SIZES]);
    for (const r of rows) {
      expect(r.price, String(r.size)).toBe(packagePrice(r.size, false));
      expect(r.rounds, String(r.size)).toBe(includedRounds(r.size));
      expect(r.diff).toBeNull();
    }
    expect(rows.filter((r) => r.reference).map((r) => r.size)).toEqual([64]);
  });

  it("prices at the camera rate when the division needs cameras", () => {
    for (const r of receiptSizeRows({ mode: "pay", ...FACTS, cameras: true })) expect(r.price, String(r.size)).toBe(packagePrice(r.size, true));
  });

  it("a smaller size that still fits names its consequence: the places held and where late entry stops (spec 8.5)", () => {
    const rows = receiptSizeRows({ mode: "payAndOpen", ...FACTS, held: 30 });
    const by = Object.fromEntries(rows.map((r) => [r.size, r]));
    expect(by[16]!.disabled).toBe("held");
    expect(by[16]!.consequence).toBeNull(); // a size that does not fit carries its reason, not a consequence
    expect(by[32]!.disabled).toBeNull();
    expect(by[32]!.consequence).toEqual({ held: 30, size: 32 });
    expect(by[64]!.consequence).toBeNull(); // the stored size itself
    expect(by[128]!.consequence).toBeNull(); // a larger size
  });

  it("greys a size by the server's own refusal order: places held, then the plan, then the rounds", () => {
    const rows = receiptSizeRows({ mode: "payAndOpen", ...FACTS, held: 20, rounds: 8, planCap: 64 });
    const reasons = Object.fromEntries(rows.map((r) => [r.size, r.disabled]));
    expect(reasons).toEqual({ 16: "held", 32: "rounds", 64: null, 128: "plan", 256: "plan" });
  });

  it("change mode never lists the paid size, and lists the others as a difference to pay or to get back", () => {
    const paid = { size: 64 as OnlineSize, camerasPaid: false };
    const rows = receiptSizeRows({ mode: "change", ...FACTS, paid });
    expect(rows.map((r) => r.size)).toEqual([16, 32, 128, 256]);
    expect(rows.map((r) => r.diff)).toEqual([16, 32, 128, 256].map((s) => packagePrice(s as OnlineSize, false) - packagePrice(64, false)));
    expect(rows.map((r) => r.diff)).toEqual([-3, -2, 4, 12]);
  });

  it("a paid camera prices every other size at the camera rate (P19)", () => {
    const rows = receiptSizeRows({ mode: "change", ...FACTS, paid: { size: 32, camerasPaid: true } });
    for (const r of rows) expect(r.diff, String(r.size)).toBe(packagePrice(r.size, true) - packagePrice(32, true));
  });
});

describe("initialReceiptSize: the size the receipt opens on", () => {
  const stored = quoteOf({ size: 64, monthly: 20, held: 30 });

  it("Open round on an unpaid division preselects the size the organiser CHOSE, not the smallest that fits (decision 15)", () => {
    // 30 players are held: 32 is the smallest that fits. The organiser chose 64.
    expect(initialReceiptSize({ mode: "payAndOpen", stored: 64, requested: null, quote: stored, next: null })).toBe(64);
  });

  it("a server `next` never moves the choice while the stored size itself is accepted (next is a fallback, not a suggestion)", () => {
    const accepted = quoteOf({ size: 64, monthly: 20, held: 30 });
    const smaller = quoteOf({ size: 32, monthly: 20, held: 30 });
    expect(initialReceiptSize({ mode: "payAndOpen", stored: 64, requested: null, quote: accepted, next: smaller })).toBe(64);
  });

  it("when the server refused the stored size, it opens on the size the server offered - which the organiser still confirms by its price", () => {
    const refused = quoteOf({ size: 16, monthly: 20, held: 30, refusal: "below_held" });
    const next = quoteOf({ size: 32, monthly: 20, held: 30 });
    expect(initialReceiptSize({ mode: "payAndOpen", stored: 16, requested: null, quote: refused, next })).toBe(32);
    expect(initialReceiptSize({ mode: "payAndOpen", stored: 16, requested: null, quote: refused, next: null })).toBeNull();
  });

  it("pay opens on the stored size, or the checkout return's target; change opens on the size asked, else none", () => {
    expect(initialReceiptSize({ mode: "pay", stored: 32, requested: null, quote: null, next: null })).toBe(32);
    expect(initialReceiptSize({ mode: "pay", stored: 32, requested: 128, quote: null, next: null })).toBe(128);
    expect(initialReceiptSize({ mode: "change", stored: 32, requested: null, quote: null, next: null })).toBeNull();
    expect(initialReceiptSize({ mode: "change", stored: 32, requested: 64, quote: null, next: null })).toBe(64);
  });
});

describe("expiryText: the day this month's included credits expire", () => {
  it("is the day and month in the organiser's language (spec: 'expire 30 Nov')", () => {
    expect(expiryText("2026-11-30", "en")).toBe("30 Nov");
    expect(expiryText("2026-11-30", "es")).toBe("30 nov");
    expect(expiryText("2026-11-30", "fr")).toBe("30 nov.");
    expect(expiryText("2026-11-30", "nl")).toBe("30 nov");
  });

  it("is the server's date, in UTC: the last day of February, and the last of the year", () => {
    expect(expiryText("2027-02-28", "en")).toBe("28 Feb");
    expect(expiryText("2026-12-31", "en")).toBe("31 Dec");
  });

  it("reads anything that is not a plain ISO date as empty, never as a wrong day", () => {
    for (const bad of ["", "2026-11", "30 Nov", "2026-13-40", "2026-11-30T00:00:00Z", "tomorrow"]) expect(expiryText(bad, "en"), bad).toBe("");
  });
});

describe("paymentNoticeOf: never a word of money unless the payment was applied", () => {
  const opened = (payment: unknown): OpenRoundResult => ({ opened: true, invited: 2, retrying: 0, skipped: [], payment }) as OpenRoundResult;

  it("an applied payment of credits is a paid notice with the size and the lowered capacity", () => {
    expect(paymentNoticeOf(opened({ applied: true, credits: 4, size: 32, capacityLoweredTo: null }))).toEqual({ kind: "paid", credits: 4, size: 32, capacityLoweredTo: null });
    expect(paymentNoticeOf(opened({ applied: true, credits: 8, size: 64, capacityLoweredTo: 64 }))).toMatchObject({ kind: "paid", capacityLoweredTo: 64 });
  });

  it("a payment that was NOT applied says nothing, whatever credits it carries", () => {
    expect(paymentNoticeOf(opened({ applied: false, credits: 0, size: 32, capacityLoweredTo: null }))).toBeNull();
    expect(paymentNoticeOf(opened({ applied: false, credits: 4, size: 32, capacityLoweredTo: null }))).toBeNull(); // a figure on a skipped pay is not a payment
  });

  it("no pay was sent: nothing - whether the answer says null or omits the field (an older answer, a double that predates it)", () => {
    expect(paymentNoticeOf(opened(null))).toBeNull();
    expect(paymentNoticeOf({ opened: true, invited: 2, retrying: 0, skipped: [] } as unknown as OpenRoundResult)).toBeNull();
    expect(paymentNoticeOf(opened(undefined))).toBeNull();
  });

  it("a payment that is not an object (a number, a string) says nothing rather than throwing", () => {
    for (const bad of [0, 4, "applied", true]) expect(paymentNoticeOf(opened(bad)), String(bad)).toBeNull();
  });

  it("a round that did not open pays nothing, so says nothing", () => {
    expect(paymentNoticeOf({ opened: false, reason: "not_paired" })).toBeNull();
    expect(paymentNoticeOf({ opened: false, reason: "already_open", skipped: [] })).toBeNull();
  });

  it("an applied payment that took no credits, or returned them, is a size notice with NO credit figure (a move down's credits overstate)", () => {
    const moved = paymentNoticeOf(opened({ applied: true, credits: -4, size: 32, capacityLoweredTo: 32 }));
    expect(moved).toEqual({ kind: "moved", size: 32, capacityLoweredTo: 32 });
    expect("credits" in moved!).toBe(false);
    expect(paymentNoticeOf(opened({ applied: true, credits: 0, size: 16, capacityLoweredTo: null }))).toEqual({ kind: "moved", size: 16, capacityLoweredTo: null });
  });
});
