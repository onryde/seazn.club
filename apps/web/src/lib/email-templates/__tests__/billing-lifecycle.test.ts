// The billing lifecycle mails (2026-11-15): six kinds, one template file. What a template owns is the copy: which sentence each case
// gets, that every locale ships its own words (no raw key, no unfilled placeholder, no "$undefined"), that the dates and amounts are
// the reader's, and that the link the reader acts on is in both halves. Who gets which mail is the producer's
// (server/usecases/__tests__/billing-lifecycle-mail.test.ts).
//
// Every case is rendered in all four locales: one lucky language proves nothing about the other three. Expected dates come from Intl
// directly and amounts from the house money spelling (`formatMoneyExact`, the one every mail and page uses), never from the template.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { formatMoneyExact } from "@/lib/format-money-exact";
import {
  planActivatedTemplate,
  renewalFailedTemplate,
  renewalPaidTemplate,
  renewalUpcomingTemplate,
  subscriptionChangedTemplate,
  trialExpiredTemplate,
} from "@/lib/email-templates";

const BILLING = "https://seazn.club/o/riverside/settings/billing";
const INVOICE = "https://invoice.stripe.com/i/acct_test/inv_test_123";
// Instants taken from the sandbox probe's payloads (2026-11-15): a trial end, an annual renewal, a retry an hour later.
const TRIAL_END = "2026-12-01T10:14:23.000Z";
const RENEWS = "2027-12-01T10:14:23.000Z";
const RETRY = "2026-12-06T11:14:23.000Z";
const GRACE_END = "2026-12-15T10:14:23.000Z";

const day = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(iso));
const words = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");

async function renderAll(locale: Locale) {
  const dict = await getDictionary(locale, "emails");
  const common = { planName: "Pro", billingUrl: BILLING, locale };
  const paid = { ...common, amountCents: 12899, currency: "usd", renewsAt: RENEWS, invoiceUrl: INVOICE };
  const failed = { ...common, amountDueCents: 1499, currency: "usd", graceEndsAt: GRACE_END, nextAttemptAt: RETRY };
  return {
    trialExpired: trialExpiredTemplate({ ...common, trialEnd: TRIAL_END }, dict),
    planActivated: planActivatedTemplate(paid, dict),
    planActivatedBare: planActivatedTemplate({ ...paid, renewsAt: null, invoiceUrl: null }, dict),
    renewalPaid: renewalPaidTemplate(paid, dict),
    renewalFailed14: renewalFailedTemplate({ ...failed, graceDaysLeft: 14 }, dict),
    renewalFailed1: renewalFailedTemplate({ ...failed, graceDaysLeft: 1 }, dict),
    renewalFailedLapsed: renewalFailedTemplate({ ...failed, graceDaysLeft: 0 }, dict),
    renewalFailedNoRetry: renewalFailedTemplate({ ...failed, graceDaysLeft: 14, nextAttemptAt: null }, dict),
    renewalUpcoming: renewalUpcomingTemplate({ ...common, amountDueCents: 12899, currency: "usd", renewsAt: RENEWS, cardOnFile: true }, dict),
    renewalUpcomingNoCard: renewalUpcomingTemplate({ ...common, amountDueCents: 12899, currency: "usd", renewsAt: RENEWS, cardOnFile: false }, dict),
    cancelScheduled: subscriptionChangedTemplate({ ...common, change: { variant: "cancel_scheduled", endsAt: TRIAL_END } }, dict),
    resumed: subscriptionChangedTemplate({ ...common, change: { variant: "resumed" } }, dict),
    annual: subscriptionChangedTemplate({ ...common, change: { variant: "plan_changed", interval: "year", nextBillingAt: RENEWS } }, dict),
    monthly: subscriptionChangedTemplate({ ...common, change: { variant: "plan_changed", interval: "month", nextBillingAt: TRIAL_END } }, dict),
    trialContinues: subscriptionChangedTemplate({ ...common, change: { variant: "trial_continues", trialEndsAt: TRIAL_END } }, dict),
  };
}

const PREFIXES = /\b(billingLifecycle|trialExpired|planActivated|renewalPaid|renewalFailed|renewalUpcoming|subscriptionChanged)\./;

describe("billing lifecycle templates", () => {
  it.each(LOCALES)("%s: no raw key, no unfilled placeholder, no $undefined, in any part of any case", async (locale) => {
    const all = await renderAll(locale);
    let checked = 0;
    for (const [name, out] of Object.entries(all)) {
      for (const part of [out.subject, words(out.html), out.text]) {
        expect(part, `${locale}/${name}`).not.toMatch(PREFIXES);
        expect(part, `${locale}/${name}`).not.toMatch(/\{[a-zA-Z]+\}/);
        expect(part, `${locale}/${name}`).not.toMatch(/\$undefined|undefined|NaN|\bnull\b/);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 15 cases x 3 parts").toBe(45);
  });

  it.each(LOCALES)("%s: every case links to the billing page in both halves", async (locale) => {
    const all = await renderAll(locale);
    for (const [name, out] of Object.entries(all)) {
      expect(out.html, `${locale}/${name}`).toContain(BILLING);
      expect(out.text, `${locale}/${name}`).toContain(BILLING);
    }
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s: every subject is translated (differs from en's)", async (locale) => {
    const en = await renderAll("en");
    const other = await renderAll(locale);
    for (const name of Object.keys(en) as (keyof typeof en)[]) {
      expect(other[name].subject, `${locale}/${name}`).not.toBe(en[name].subject);
    }
  });

  it.each(LOCALES)("%s: the six kinds and the four confirmation variants are different mails", async (locale) => {
    const a = await renderAll(locale);
    const subjects = [
      a.trialExpired,
      a.planActivated,
      a.renewalPaid,
      a.renewalFailed14,
      a.renewalUpcoming,
      a.cancelScheduled,
      a.resumed,
      a.annual,
      a.monthly,
      a.trialContinues,
    ].map((o) => o.subject);
    expect(new Set(subjects).size, `${locale}: ten distinct subjects`).toBe(10);
  });

  it.each(LOCALES)("%s: dates are the reader's, read as UTC", async (locale) => {
    const a = await renderAll(locale);
    expect(a.trialExpired.text).toContain(day(TRIAL_END, locale));
    expect(a.planActivated.text).toContain(day(RENEWS, locale));
    expect(a.renewalPaid.text).toContain(day(RENEWS, locale));
    expect(a.renewalUpcoming.subject).toContain(day(RENEWS, locale));
    expect(a.renewalFailed14.text).toContain(day(RETRY, locale));
    expect(a.renewalFailed14.text).toContain(day(GRACE_END, locale));
    expect(a.cancelScheduled.subject).toContain(day(TRIAL_END, locale));
    expect(a.annual.text).toContain(day(RENEWS, locale));
    expect(a.monthly.text).toContain(day(TRIAL_END, locale));
  });

  it.each(LOCALES)("%s: amounts are spelled the house way in the reader's language", async (locale) => {
    const a = await renderAll(locale);
    const annual = formatMoneyExact(12899, "usd", locale);
    const monthly = formatMoneyExact(1499, "usd", locale);
    for (const out of [a.planActivated, a.renewalPaid, a.renewalUpcoming]) expect(out.text).toContain(annual);
    expect(a.renewalFailed14.text).toContain(monthly);
    // The HTML half carries the same amount (escaped, but an amount has nothing to escape).
    expect(words(a.renewalUpcoming.html)).toContain(annual);
  });

  it.each(LOCALES)("%s: the dunning notice counts grace days by the language's plural rule, and says so when the grace is over", async (locale) => {
    const a = await renderAll(locale);
    // 14 days left vs 1 day left: different sentences (the plural category moves), both naming the grace end.
    expect(a.renewalFailed14.text).not.toBe(a.renewalFailed1.text);
    expect(a.renewalFailed14.text).toContain("14");
    expect(a.renewalFailed1.text).toContain(day(GRACE_END, locale));
    // Over: no countdown and no grace date, a different sentence.
    expect(a.renewalFailedLapsed.text).not.toContain(day(GRACE_END, locale));
    expect(a.renewalFailedLapsed.text).not.toBe(a.renewalFailed14.text);
    // No retry scheduled: the retry sentence (and its date) is gone, the rest stays.
    expect(a.renewalFailedNoRetry.text).not.toContain(day(RETRY, locale));
    expect(a.renewalFailedNoRetry.text).toContain(day(GRACE_END, locale));
  });

  it.each(LOCALES)("%s: the invoice link and the renewal date are there only when the invoice gave them", async (locale) => {
    const a = await renderAll(locale);
    expect(a.planActivated.html).toContain(INVOICE);
    expect(a.planActivated.text).toContain(INVOICE);
    expect(a.renewalPaid.text).toContain(INVOICE);
    expect(a.planActivatedBare.html).not.toContain(INVOICE);
    expect(a.planActivatedBare.text).not.toContain(INVOICE);
    expect(a.planActivatedBare.text).not.toContain(day(RENEWS, locale));
    expect(a.planActivatedBare.text, "positive pair: the bare mail still says the plan is active").toContain("Pro");
  });

  it.each(LOCALES)("%s: the renewal notice says 'nothing to do' only with a card on file; without one it asks for a payment method before the date", async (locale) => {
    const a = await renderAll(locale);
    const dict = (await getDictionary(locale, "emails")) as Record<string, string>;
    const vars: Record<string, string> = { planName: "Pro", date: day(RENEWS, locale), amount: formatMoneyExact(12899, "usd", locale) };
    const fill = (key: string) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), dict[key]!);
    expect(a.renewalUpcoming.text).toContain(fill("renewalUpcoming.body"));
    expect(a.renewalUpcoming.text).not.toContain(fill("renewalUpcoming.bodyNoCard"));
    expect(a.renewalUpcomingNoCard.text).toContain(fill("renewalUpcoming.bodyNoCard"));
    expect(a.renewalUpcomingNoCard.text).not.toContain(fill("renewalUpcoming.body"));
    expect(a.renewalUpcomingNoCard.text).toContain(`${dict["renewalUpcoming.ctaNoCard"]}: ${BILLING}`);
    expect(fill("renewalUpcoming.bodyNoCard"), "premise: the two sentences differ").not.toBe(fill("renewalUpcoming.body"));
  });

  it.each(LOCALES)("%s: a no-card trial's confirmation names the trial's end and is not the 'plan will continue' mail", async (locale) => {
    const a = await renderAll(locale);
    const dict = (await getDictionary(locale, "emails")) as Record<string, string>;
    const fill = (key: string) => dict[key]!.replaceAll("{planName}", "Pro").replaceAll("{date}", day(TRIAL_END, locale));
    expect(a.trialContinues.subject).toBe(fill("subscriptionChanged.trialContinues.subject"));
    expect(a.trialContinues.text).toContain(fill("subscriptionChanged.trialContinues.body"));
    expect(a.trialContinues.subject).not.toBe(a.resumed.subject);
    expect(a.trialContinues.text).not.toContain(dict["subscriptionChanged.resumed.body"]!.replaceAll("{planName}", "Pro"));
  });

  it("the resume confirmation names no date: a resumed no-card trial still ends unless a card is added, so no date is promised", async () => {
    for (const locale of LOCALES) {
      const a = await renderAll(locale);
      for (const iso of [TRIAL_END, RENEWS]) expect(a.resumed.text).not.toContain(day(iso, locale));
    }
  });

  it("an interpolated value is escaped in the HTML half and raw in the text half", async () => {
    const dict = await getDictionary("en", "emails");
    const out = trialExpiredTemplate({ planName: "Pro <b>", billingUrl: BILLING, locale: "en", trialEnd: TRIAL_END }, dict);
    expect(out.html).toContain("Pro &lt;b&gt;");
    expect(out.html).not.toContain("Pro <b>");
    expect(out.text).toContain("Pro <b>");
  });
});
