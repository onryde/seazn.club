// Polish wave P4 (the P3 carry): a registrant's mail wrote an amount through `money()`, pinned to en-GB, so a USD mail printed "US$15.00"
// while the page the same person had just been on printed "$15.00" (and a French mail "£15.00" against the page's "15,00 £GB"). The mail is
// now written in the RECIPIENT'S language like the rest of it, through the same `formatMoneyExact` the status page, the review step and the pay
// page use. Driven through the five REAL senders in lib/email.ts (the ones the outbox producers call), not the templates: a template that
// takes a locale its sender never passes is the inert seam, and only the sender's output can see it.
import { describe, expect, it } from "vitest";
import {
  paymentReminderEmail,
  refundIssuedEmail,
  registrationEmail,
  registrationPaidEmail,
  registrationPromotedEmail,
} from "@/lib/email";
import { REGISTRATION_CURRENCIES, formatMoneyExact } from "@/lib/currency";
import { LOCALES, type Locale } from "@/lib/i18n-constants";

const PAY = "https://seazn.club/r/pay/" + "T".repeat(43);
const STATUS = "https://seazn.club/r/status?token=abc";
const common = { orgName: "Riverside Club", competitionName: "Spring Open", contactName: "Mia Cole", displayName: "Mia Cole", divisionName: "Open Singles" };

type Sender = (currency: string, locale: Locale) => Promise<{ html: string; text: string }>;

// Every amount the sender quotes, so each sweep row proves every quoted amount, not just the first.
const SENDERS: { name: string; cents: number[]; send: Sender }[] = [
  {
    name: "registration confirmation (one card entry owing a fee)",
    cents: [1500],
    send: (currency, locale) =>
      registrationEmail(
        {
          orgName: common.orgName,
          competitionName: common.competitionName,
          contactName: common.contactName,
          entries: [{ displayName: "Mia Cole", divisionName: "Open Singles", status: "pending", feeCents: 1500, approval: "auto" }],
          totalCents: 1500,
          currency,
          paymentInstructions: null,
          payPageUrl: PAY,
          statusUrl: STATUS,
        },
        locale,
      ),
  },
  {
    name: "registration confirmation (a cart: each entry line and the amount owed)",
    cents: [1500, 900, 2400],
    send: (currency, locale) =>
      registrationEmail(
        {
          orgName: common.orgName,
          competitionName: common.competitionName,
          contactName: common.contactName,
          entries: [
            { displayName: "Mia Cole", divisionName: "Open Singles", status: "pending", feeCents: 1500, approval: "auto" },
            { displayName: "Mia Cole", divisionName: "Masters Singles", status: "pending", feeCents: 900, approval: "auto" },
          ],
          totalCents: 2400,
          currency,
          paymentInstructions: null,
          payPageUrl: PAY,
          statusUrl: STATUS,
        },
        locale,
      ),
  },
  {
    name: "payment reminder",
    cents: [1500],
    send: (currency, locale) =>
      paymentReminderEmail(
        { ...common, feeCents: 1500, currency, paymentInstructions: null, method: "card", payPageUrl: PAY },
        locale,
      ),
  },
  {
    name: "waitlist promotion",
    cents: [1500],
    send: (currency, locale) =>
      registrationPromotedEmail({ ...common, feeCents: 1500, currency, method: "card", payPageUrl: PAY }, locale),
  },
  {
    name: "payment received (one entry)",
    cents: [1500],
    send: (currency, locale) =>
      registrationPaidEmail(
        {
          orgName: common.orgName,
          competitionName: common.competitionName,
          contactName: common.contactName,
          currency,
          entries: [{ displayName: "Mia Cole", divisionName: "Open Singles", amountCents: 1500, confirmed: true }],
          statusUrl: STATUS,
        },
        locale,
      ),
  },
  {
    name: "payment received (a cart: each line and the total)",
    cents: [1500, 900, 2400],
    send: (currency, locale) =>
      registrationPaidEmail(
        {
          orgName: common.orgName,
          competitionName: common.competitionName,
          contactName: common.contactName,
          currency,
          entries: [
            { displayName: "Mia Cole", divisionName: "Open Singles", amountCents: 1500, confirmed: true },
            { displayName: "Mia Cole", divisionName: "Masters Singles", amountCents: 900, confirmed: true },
          ],
          statusUrl: STATUS,
        },
        locale,
      ),
  },
  {
    name: "refund receipt",
    cents: [1250],
    send: (currency, locale) => refundIssuedEmail({ ...common, amountCents: 1250, currency }, locale),
  },
];

describe("a registrant's mail writes every amount exactly as the page does, in the recipient's language (P3 carry)", () => {
  it("the walkthrough's own case first: a USD mail in English reads $15.00 and never US$15.00", async () => {
    const out = await registrationEmail(
      {
        orgName: common.orgName,
        competitionName: common.competitionName,
        contactName: common.contactName,
        entries: [{ displayName: "Mia Cole", divisionName: "Open Singles", status: "pending", feeCents: 1500, approval: "auto" }],
        totalCents: 1500,
        currency: "usd",
        paymentInstructions: null,
        payPageUrl: PAY,
        statusUrl: STATUS,
      },
      "en",
    );
    expect(out.text).toContain("$15.00");
    expect(out.text).not.toContain("US$");
    expect(out.html).not.toContain("US$");
    // The differential that makes the line above witness the change: the old spelling is what en-GB gives for the same amount.
    expect(formatMoneyExact(1500, "usd", "en-GB")).toBe("US$15.00");
    expect(formatMoneyExact(1500, "usd", "en")).toBe("$15.00");
  });

  it("every sender x every registration currency x every locale: each quoted amount is the page's own spelling (counted)", async () => {
    let checked = 0;
    for (const sender of SENDERS) {
      for (const currency of REGISTRATION_CURRENCIES) {
        for (const locale of LOCALES) {
          const out = await sender.send(currency, locale);
          for (const cents of sender.cents) {
            const want = formatMoneyExact(cents, currency, locale);
            expect(out.text, `${sender.name} / ${currency} / ${locale}: text carries ${want}`).toContain(want);
            expect(out.html, `${sender.name} / ${currency} / ${locale}: html carries ${want}`).toContain(want);
            checked += 1;
          }
        }
      }
    }
    expect(REGISTRATION_CURRENCIES.length, "premise: the registration currencies exist").toBeGreaterThan(0);
    const perCombo = SENDERS.reduce((n, s) => n + s.cents.length, 0);
    expect(checked).toBe(perCombo * REGISTRATION_CURRENCIES.length * LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a locale changes the spelling for the same amount (so the sweep above cannot pass on one fixed locale)", () => {
    const spellings = new Set(LOCALES.map((l) => formatMoneyExact(1500, "gbp", l)));
    expect(spellings.size, "en, es, fr and nl do not all print GBP alike").toBeGreaterThan(1);
  });
});
