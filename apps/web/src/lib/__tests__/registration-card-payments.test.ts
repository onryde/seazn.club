// Walk-fix F5 (walkthrough R17): with Connect charges off, the register page said only "Registration is not open", the public page
// gave no reason, and the organiser's hub warned of nothing. ONE derivation decides "card payments are not set up" for every surface.
// Expected values come from the rule the public panel already enforced (settings.ts, spec #9 / P2-10): a CARD division with a
// fee cannot take an entry while Connect cannot charge or the plan's paid-registration entitlement is gone; a free or offline
// division always can.
import { describe, expect, it } from "vitest";
import {
  CARD_PAYMENTS_UNAVAILABLE,
  cardDivisionsWaitOnConnect,
  cardPaymentsBroken,
  registrationWaitsOnCardPayments,
} from "../registration-card-payments";

describe("cardPaymentsBroken: one card division", () => {
  const ORG_OK = { charges_enabled: true, paid_entitled: true };
  it("the full table: only a card division with a fee, under a broken org, is broken (counted)", () => {
    let checked = 0;
    let broken = 0;
    for (const payment_method of ["stripe", "offline"] as const) {
      for (const fee_cents of [0, 1500]) {
        for (const charges_enabled of [true, false]) {
          for (const paid_entitled of [true, false]) {
            const got = cardPaymentsBroken({ payment_method, fee_cents }, { charges_enabled, paid_entitled });
            const want = payment_method === "stripe" && fee_cents > 0 && (!charges_enabled || !paid_entitled);
            expect(got, JSON.stringify({ payment_method, fee_cents, charges_enabled, paid_entitled })).toBe(want);
            checked++;
            if (got) broken++;
          }
        }
      }
    }
    expect(checked, "anti-vacuity: 2 methods x 2 fees x 2 x 2").toBe(16);
    expect(broken, "both sides of the table were reached").toBe(3);
  });
  it("a healthy org never breaks a card division", () => {
    expect(cardPaymentsBroken({ payment_method: "stripe", fee_cents: 1500 }, ORG_OK)).toBe(false);
  });
});

describe("registrationWaitsOnCardPayments: the public panel's divisions", () => {
  const card = { open: false, closed_reason: CARD_PAYMENTS_UNAVAILABLE };
  it("no divisions at all is not waiting on card payments (empty case first)", () => {
    expect(registrationWaitsOnCardPayments([])).toBe(false);
  });
  it("every division closed, at least one for card payments -> waiting; an open division anywhere -> not", () => {
    expect(registrationWaitsOnCardPayments([card])).toBe(true);
    expect(registrationWaitsOnCardPayments([card, { open: false, closed_reason: "window" }])).toBe(true);
    expect(registrationWaitsOnCardPayments([card, { open: true, closed_reason: null }]), "an offline/free division still registers").toBe(false);
    expect(registrationWaitsOnCardPayments([card, { open: true, closed_reason: "full" }]), "a full one still takes the waitlist").toBe(false);
  });
  it("closed for any other reason is not this one", () => {
    let checked = 0;
    for (const closed_reason of ["window", "entry_kind_unavailable", null]) {
      expect(registrationWaitsOnCardPayments([{ open: false, closed_reason }]), String(closed_reason)).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("cardDivisionsWaitOnConnect: the organiser's hub rows", () => {
  const row = { enabled: true, payment_method: "stripe", fee_cents: 1500 };
  it("no rows -> no banner (empty case first)", () => {
    expect(cardDivisionsWaitOnConnect([], false)).toBe(false);
  });
  it("an enabled card division with a fee, Connect unable to charge -> banner; Connect able -> none", () => {
    expect(cardDivisionsWaitOnConnect([row], false)).toBe(true);
    expect(cardDivisionsWaitOnConnect([row], true)).toBe(false);
  });
  it("a disabled, free, offline or unconfigured division is no reason for the banner (counted)", () => {
    const quiet = [
      { ...row, enabled: false },
      { ...row, fee_cents: 0 },
      { ...row, payment_method: "offline" },
      { ...row, payment_method: null },
    ];
    let checked = 0;
    for (const r of quiet) {
      expect(cardDivisionsWaitOnConnect([r], false), JSON.stringify(r)).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
    expect(cardDivisionsWaitOnConnect([...quiet, row], false), "one card division among them is enough").toBe(true);
  });
});
