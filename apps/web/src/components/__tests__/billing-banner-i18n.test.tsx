// The billing banner in the console's language (billing lifecycle mails, 2026-11-15: the banner was English-only).
//
// Every arm of the banner is rendered in all four locales against the mirror row it reads. Expected text comes from the dictionary
// files on disk with `{count}` filled here and the plural category picked by `Intl.PluralRules` (the language's rule), never from the
// banner. English must stay byte-identical to the copy it replaced: e2e/billing-states.spec.ts and lib/__tests__/billing-payment-method
// .test.ts match those exact sentences, so the legacy literals are pinned here too.
//
// The DB read is stubbed (the row is the input under test; billing-payment-method.test.ts drives the real query) and so is the
// locale (resolveLocale's cookie/account/header order has its own tests).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

type Row = { plan_key: string; status: string; trial_end: string | null; has_payment_method: boolean; org_status: string };
const seam = vi.hoisted(() => ({ row: null as unknown, locale: "en" as string }));
vi.mock("@/lib/db", () => ({ sql: async () => (seam.row ? [seam.row] : []) }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => seam.locale }));

import { BillingBanner } from "@/components/billing-banner";

const DAY = 86_400_000;
const dictOf = (locale: Locale): Record<string, string> =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "..", "dictionaries", locale, "ui.json"), "utf8"));
const unescape = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const textOf = (html: string) => unescape(html.replace(/<[^>]+>/g, ""));

async function render(locale: Locale, row: Partial<Row>): Promise<string> {
  seam.locale = locale;
  seam.row = { plan_key: "pro", status: "trialing", trial_end: null, has_payment_method: false, org_status: "active", ...row };
  const el = await BillingBanner({ orgId: "org-under-test" });
  return el ? textOf(renderToStaticMarkup(el)) : "";
}

/** A trial ending in `days` days, as the banner counts them (ceil of the time left). */
const trialIn = (days: number) => new Date(Date.now() + days * DAY - 3_600_000).toISOString();

afterEach(() => {
  seam.row = null;
});

describe("BillingBanner in four languages", () => {
  // [arm, row, the dictionary sentences it must carry (key, count?), the sentences it must NOT carry]
  type Case = [string, Partial<Row>, [string, number?][], string[]];
  const cases: Case[] = [
    ["suspended", { org_status: "suspended", status: "active" }, [["billing.banner.suspended"], ["billing.banner.reactivate"]], []],
    ["trial 11 days, no card", { trial_end: trialIn(11) }, [["billing.banner.trialLeftLong", 11], ["billing.banner.addCardKeepPro"]], []],
    ["trial 11 days, card on file", { trial_end: trialIn(11), has_payment_method: true }, [["billing.banner.trialLeftLong", 11]], ["billing.banner.addCardKeepPro"]],
    ["trial 4 days, no card", { trial_end: trialIn(4) }, [["billing.banner.trialLeftShort", 4], ["billing.banner.addPaymentMethod"]], []],
    ["trial 1 day, no card", { trial_end: trialIn(1) }, [["billing.banner.trialLeftShort", 1], ["billing.banner.addPaymentMethod"]], []],
    ["trial ended", { trial_end: trialIn(-1) }, [["billing.banner.trialEnded"], ["billing.banner.addPaymentMethod"]], []],
    ["past due", { status: "past_due" }, [["billing.banner.pastDue"], ["billing.banner.updatePayment"]], []],
  ];

  it.each(LOCALES)("%s: every arm says the dictionary's sentences, no raw key, no unfilled count", async (locale) => {
    const dict = dictOf(locale);
    const rules = new Intl.PluralRules(locale);
    let checked = 0;
    for (const [arm, row, must, mustNot] of cases) {
      const text = await render(locale, row);
      expect(text, `${locale}/${arm}: rendered`).not.toBe("");
      expect(text, `${locale}/${arm}`).not.toMatch(/billing\.banner\.|\{count\}/);
      for (const [key, count] of must) {
        const template = count === undefined ? dict[key] : (dict[`${key}.${rules.select(count)}`] ?? dict[`${key}.other`]);
        expect(template, `${locale}: ${key} is in the dictionary`).toBeTypeOf("string");
        expect(text, `${locale}/${arm}: ${key}`).toContain(template!.replace("{count}", String(count)));
        checked++;
      }
      for (const key of mustNot) expect(text, `${locale}/${arm}: no ${key}`).not.toContain(dict[key]!);
    }
    expect(checked, "anti-vacuity: 13 sentences checked per locale").toBe(13);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s: translated — no arm renders the English text", async (locale) => {
    for (const [arm, row] of cases) expect(await render(locale, row), `${locale}/${arm}`).not.toBe(await render("en", row));
  });

  it("English is the copy it replaced, character for character", async () => {
    expect(await render("en", { org_status: "suspended", status: "active" })).toBe(
      "Your account is suspended due to a failed payment. Data is preserved. Reactivate →",
    );
    expect(await render("en", { trial_end: trialIn(11) })).toBe("11 days left on your Pro trial. Add a card to keep Pro →");
    expect(await render("en", { trial_end: trialIn(4) })).toBe("4 days left in your Pro trial. Add a payment method →");
    expect(await render("en", { trial_end: trialIn(1) })).toBe("1 day left in your Pro trial. Add a payment method →");
    expect(await render("en", { trial_end: trialIn(-1) })).toBe("Your Pro trial has ended. Add a payment method →");
    expect(await render("en", { status: "past_due" })).toBe("Payment failed — your subscription is past due. Update payment →");
  });

  it("a healthy or community group shows nothing, in any language (positive pair: the same row past due shows the banner)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      expect(await render(locale, { status: "active" }), locale).toBe("");
      expect(await render(locale, { plan_key: "community", status: "past_due" }), locale).toBe("");
      expect(await render(locale, { status: "past_due" }), locale).not.toBe("");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
