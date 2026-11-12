// Polish wave P2 (walkthrough W4, W7): the four registrant mails that used to greet the ENTRY's name ("Thanks Riverside Rovers") now
// greet the person the mail is for, and the cart confirmation says which division each line is and what each line is really waiting on.
//
// Every assertion is a differential over the four shipped locales, never one sampled language: an untranslated key renders as its own
// raw token, and a locale whose word order buries the greeting would pass a single-language test.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n-constants";
import {
  paymentReminderTemplate,
  refundIssuedTemplate,
  registrationPromotedTemplate,
  registrationTemplate,
} from "@/lib/email-templates";

const CONTACT = "Dana Captain";
const TEAM = "Riverside Rovers";
const DIVISION = "Open Doubles";
const PAY_PAGE = "https://seazn.club/r/pay/tok";

const dictOf = (locale: (typeof LOCALES)[number]) => getDictionary(locale, "emails");

/** The visible words of an html part: tags dropped, entities left (the names under test have none). */
const words = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a registrant mail greets the person, not the entry", () => {
  it.each(LOCALES)("%s: cart confirmation, reminder, promotion and refund name the contact BEFORE the entry", async (locale) => {
    const dict = await dictOf(locale);
    const base = { orgName: "Riverside Club", competitionName: "Spring Open", displayName: TEAM, contactName: CONTACT, currency: "gbp" };
    const outs = {
      confirmation: registrationTemplate(
        {
          orgName: base.orgName,
          competitionName: base.competitionName,
          contactName: CONTACT,
          entries: [{ displayName: TEAM, divisionName: DIVISION, status: "pending", feeCents: 1500, approval: "auto" }],
          totalCents: 1500,
          currency: "gbp",
          paymentInstructions: null,
          statusUrl: "https://seazn.club/s",
        },
        dict,
      ),
      reminder: paymentReminderTemplate(
        { ...base, feeCents: 1500, paymentInstructions: null, method: "card", payPageUrl: PAY_PAGE },
        dict,
      ),
      promotion: registrationPromotedTemplate({ ...base, feeCents: 1500, method: "card", payPageUrl: PAY_PAGE }, dict),
      refund: refundIssuedTemplate({ ...base, amountCents: 1500 }, dict),
    };
    let checked = 0;
    for (const [name, out] of Object.entries(outs)) {
      const visible = words(out.html);
      const at = visible.indexOf(CONTACT);
      expect(at, `${locale} ${name}: the contact is named`).toBeGreaterThanOrEqual(0);
      const entryAt = visible.indexOf(TEAM);
      expect(entryAt, `${locale} ${name}: the entry stays named (a rep may hold several)`).toBeGreaterThan(at);
      expect(out.html, `${locale} ${name}: no raw dictionary token`).not.toMatch(/\b(registration|paymentReminder|registrationPromoted|refundIssued)\.[a-zA-Z]+\b/);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four mails judged per locale").toBe(4);
  });
});

describe("the cart confirmation's entry lines", () => {
  const entries = [
    { displayName: "Maya", divisionName: "Open Singles", status: "pending", feeCents: 1500, approval: "auto" as const },
    { displayName: "Maya", divisionName: "Masters Singles", status: "pending", feeCents: 0, approval: "manual" as const },
    { displayName: "Maya", divisionName: "Social Singles", status: "paid", feeCents: 1000, approval: "manual" as const },
    { displayName: "Maya", divisionName: "Ladies Singles", status: "pending", feeCents: 1200, approval: "manual" as const },
    { displayName: "Maya", divisionName: "Veterans Singles", status: "confirmed", feeCents: 0, approval: "auto" as const },
  ];
  const render = async (locale: (typeof LOCALES)[number]) =>
    registrationTemplate(
      {
        orgName: "Riverside Club",
        competitionName: "Spring Open",
        contactName: CONTACT,
        entries,
        totalCents: 3700,
        currency: "gbp",
        paymentInstructions: null,
        statusUrl: "https://seazn.club/s",
      },
      await dictOf(locale),
    );

  it.each(LOCALES)("%s: every line names its division (html and text), so two lines for one person can be told apart", async (locale) => {
    const out = await render(locale);
    let checked = 0;
    for (const e of entries) {
      expect(out.html, `${locale} html names ${e.divisionName}`).toContain(e.divisionName);
      expect(out.text, `${locale} text names ${e.divisionName}`).toContain(e.divisionName);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it.each(LOCALES)("%s: the status is what the entry is waiting on, not a bare 'Pending' (four different words for four different states)", async (locale) => {
    const out = await render(locale);
    // The line for each entry, found by its division; the status word is what follows it.
    const lineOf = (division: string): string => {
      const line = out.text.split("\n").find((l) => l.includes(division));
      expect(line, `${locale}: a text line for ${division}`).toBeDefined();
      return line!;
    };
    const statuses = ["Open Singles", "Masters Singles", "Social Singles", "Ladies Singles", "Veterans Singles"].map((d) =>
      lineOf(d).replace(d, "").replace(/Maya/g, "").replace(/[£€$]\s?[\d.,]+/g, "").replace(/[()·—:\-\s]+/g, " ").trim(),
    );
    // payment only / approval only / paid and waiting for approval / payment and approval / confirmed: five states, five labels.
    expect(new Set(statuses).size, `${locale}: ${JSON.stringify(statuses)}`).toBe(5);
    for (const line of out.text.split("\n")) expect(line, `${locale}: no raw key`).not.toMatch(/registration\.entryStatus/);
  });

  it("English wording of the waiting states (typed from the product's own labels, so a dictionary drift is seen)", async () => {
    const out = await render("en");
    const line = (d: string) => out.text.split("\n").find((l) => l.includes(d))!;
    expect(line("Open Singles")).toContain("Awaiting payment");
    expect(line("Masters Singles")).toContain("Awaiting approval");
    expect(line("Social Singles")).toContain("Paid");
    expect(line("Social Singles")).toContain("awaiting approval");
    expect(line("Ladies Singles")).toContain("Awaiting payment and approval");
    expect(line("Veterans Singles")).toContain("Confirmed");
  });
});
