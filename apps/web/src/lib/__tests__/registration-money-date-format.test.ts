// Polish wave P3 (walkthrough W1, W4): one amount and one deadline were printed two ways. The status page and the review step wrote
// "£15" (`formatMinor` drops the decimals of a whole amount) while the mail, Checkout and the pay page wrote "£15.00"; the status page
// wrote a deadline "14 Nov 2026, 11:15 UTC" and the pay page "Nov 14, 2026, 11:15 AM UTC". These two helpers are the ONE spelling the
// registration surfaces now share; the cases below are literals from the walkthrough's own screens, not values the helpers produced.
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";
import { REGISTRATION_CURRENCIES, formatMinor, formatMoneyExact } from "@/lib/currency";
import { fmtPublicDeadline, fmtPublicDateTime, fmtPublicZoneAbbrev } from "@/lib/format";

describe("formatMoneyExact: the currency's own minor unit, always shown", () => {
  it("a whole amount keeps its decimals (the walkthrough's £15 vs £15.00)", () => {
    expect(formatMoneyExact(1500, "gbp", "en")).toBe("£15.00");
    expect(formatMoneyExact(1250, "eur", "en")).toBe("€12.50");
    expect(formatMoneyExact(150000, "inr", "en")).toBe("₹1,500.00");
    expect(formatMoneyExact(0, "gbp", "en")).toBe("£0.00");
    // The differential that makes the case above witness the fix: the old formatter's answer for the same amount.
    expect(formatMinor(1500, "gbp", "en")).toBe("£15");
    expect(formatMoneyExact(1500, "gbp", "en")).not.toBe(formatMinor(1500, "gbp", "en"));
  });

  it("every registration currency x every locale x whole and fractional amounts prints exactly two decimals (counted)", () => {
    // 15.00, 12.50, 0.05, 999.99, 0.00 as cents. The tail of the numeric part is the decimal separator and two digits, whatever the
    // locale's separator, grouping or symbol position (a symbol after the number, "15,00 €", leaves the digits at the end of the match).
    const AMOUNTS = [1500, 1250, 5, 99999, 0];
    let checked = 0;
    for (const currency of REGISTRATION_CURRENCIES) {
      for (const locale of LOCALES) {
        for (const cents of AMOUNTS) {
          const out = formatMoneyExact(cents, currency, locale);
          const numeric = out.match(/\d[\d.,\s  ]*\d|\d/)?.[0] ?? "";
          expect(numeric, `${currency}/${locale}/${cents} -> ${out}`).toMatch(/[.,]\d{2}$/);
          checked += 1;
        }
      }
    }
    expect(REGISTRATION_CURRENCIES.length, "premise: the registration currencies exist").toBeGreaterThan(0);
    expect(checked).toBe(REGISTRATION_CURRENCIES.length * LOCALES.length * AMOUNTS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an unknown currency code still prints an amount (never throws into a render)", () => {
    expect(formatMoneyExact(1500, "zz", "en")).toBe("15.00 ZZ");
  });
});

describe("fmtPublicDeadline: one deadline spelling, in the org's zone and the page's locale", () => {
  it("is the status page's own spelling: day-month, the zone's label after it", () => {
    // The walkthrough's own deadline (W4), written on the status page as "14 Nov 2026, 11:15 UTC".
    expect(fmtPublicDeadline("en", "UTC", "2026-11-14T11:15:00.000Z")).toBe("14 Nov 2026, 11:15 UTC");
    // The pay page's old spelling was the US one: that string must not come out of the shared helper.
    expect(fmtPublicDeadline("en", "UTC", "2026-11-14T11:15:00.000Z")).not.toBe("Nov 14, 2026, 11:15 AM UTC");
  });

  it("is written in the ORG's zone: the same instant moves with the zone, and the label says which", () => {
    // 11:15Z in July is 12:15 in London (BST). A formatter that pinned UTC (the pay page's old rule) cannot give this.
    expect(fmtPublicDeadline("en", "Europe/London", "2026-07-01T11:15:00.000Z")).toBe("1 Jul 2026, 12:15 BST");
    expect(fmtPublicDeadline("en", "UTC", "2026-07-01T11:15:00.000Z")).toBe("1 Jul 2026, 11:15 UTC");
  });

  it("is the two public helpers composed, in every locale (a Date, an ISO string and an epoch read the same)", () => {
    const iso = "2026-11-14T11:15:00.000Z";
    let checked = 0;
    for (const locale of LOCALES) {
      const want = `${fmtPublicDateTime(locale, "Europe/London", iso)} ${fmtPublicZoneAbbrev(locale, "Europe/London", iso)}`;
      expect(fmtPublicDeadline(locale, "Europe/London", iso), locale).toBe(want);
      expect(fmtPublicDeadline(locale, "Europe/London", new Date(iso)), locale).toBe(want);
      expect(fmtPublicDeadline(locale, "Europe/London", Date.parse(iso)), locale).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an empty or invalid instant prints nothing (the empty case)", () => {
    expect(fmtPublicDeadline("en", "UTC", null)).toBe("");
    expect(fmtPublicDeadline("en", "UTC", undefined)).toBe("");
    expect(fmtPublicDeadline("en", "UTC", "not a date")).toBe("");
  });
});
