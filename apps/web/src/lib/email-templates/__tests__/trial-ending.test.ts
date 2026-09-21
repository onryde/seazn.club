// V411 — the `customer.subscription.trial_will_end` email.
//
// The thing worth testing here is not that a template renders. It is that the
// email SAYS A DIFFERENT THING depending on whether the group has a card: a
// no-card trial CANCELS at trial end and the reader must act, while a
// card-on-file trial simply charges and they need do nothing. Telling the
// second group to add a card would be wrong copy about their own money.
//
// So every assertion below is a differential. A test that only checked "the
// subject is non-empty" would pass with both variants pointing at one key,
// which is exactly the defect this file exists to catch.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n-constants";
import { trialEndingTemplate } from "../trial-ending";

const BASE = {
  planName: "Pro",
  trialEnd: "2026-10-01T00:00:00.000Z",
  billingUrl: "https://seazn.club/o/demo/settings/billing",
} as const;

async function render(locale: (typeof LOCALES)[number], hasPaymentMethod: boolean) {
  const dict = await getDictionary(locale, "emails");
  return trialEndingTemplate({ ...BASE, locale, hasPaymentMethod }, dict);
}

describe("trialEndingTemplate", () => {
  // Enumerated rather than sampled: one lucky locale proves nothing about the
  // other three, and an untranslated key renders as its own raw token, which a
  // single-locale test never sees.
  it.each(LOCALES)("%s: the two variants are genuinely different emails", async (locale) => {
    const noCard = await render(locale, false);
    const withCard = await render(locale, true);
    expect(noCard.subject).not.toBe(withCard.subject);
    expect(noCard.html).not.toBe(withCard.html);
    expect(noCard.text).not.toBe(withCard.text);
  });

  it.each(LOCALES)("%s: no key renders as its own raw token", async (locale) => {
    // `t()` falls back to the key itself for a missing entry, so an
    // untranslated string appears as "trialEnding.body.card" on the page. This
    // is the assertion that catches a locale someone forgot.
    for (const hasCard of [false, true]) {
      const out = await render(locale, hasCard);
      expect(out.subject).not.toMatch(/trialEnding\./);
      expect(out.html).not.toMatch(/trialEnding\./);
      expect(out.text).not.toMatch(/trialEnding\./);
    }
  });

  it.each(LOCALES)("%s: both variants carry the billing link", async (locale) => {
    for (const hasCard of [false, true]) {
      const out = await render(locale, hasCard);
      expect(out.html).toContain(BASE.billingUrl);
      // The text part is what a plain-text client shows; a link only in the
      // HTML half is a dead end for that reader.
      expect(out.text).toContain(BASE.billingUrl);
    }
  });

  it("the date is formatted in the reader's own language, not the platform's", async () => {
    // Differential against `en` rather than a hardcoded string: a date library
    // change moves both sides together, and pinning "1 October 2026" here would
    // only assert what Intl did on the day this was written.
    const en = await render("en", false);
    const fr = await render("fr", false);
    const expectedFr = new Intl.DateTimeFormat("fr", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(BASE.trialEnd));
    expect(fr.subject).toContain(expectedFr);
    expect(en.subject).not.toContain(expectedFr);
  });

  it("the trial-end date is read as UTC, not as the server's local day", async () => {
    // A trial ending at midnight UTC must not be announced as the day before
    // to a reader whose server sits in a negative offset. Stripe's trial_end is
    // an instant; the date shown is the one the charge actually falls on.
    const out = await render("en", true);
    const expected = new Intl.DateTimeFormat("en", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(BASE.trialEnd));
    expect(out.subject).toContain(expected);
  });

  it("the plan name reaches the reader in both variants", async () => {
    // Positive pair for the differential assertions above: proves the args are
    // actually interpolated and the two variants are not just two constants.
    const noCard = await render("en", false);
    const withCard = await render("en", true);
    expect(noCard.subject).toContain("Pro");
    expect(withCard.subject).toContain("Pro");
    expect(noCard.text).toContain("Pro");
  });
});
