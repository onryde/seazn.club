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
    const base = { orgName: "Riverside Club", competitionName: "Spring Open", displayName: TEAM, divisionName: DIVISION, contactName: CONTACT, currency: "gbp" };
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

  // Polish wave P5 (W12): the organiser approved the manual, unpaid "Ladies Singles" entry ahead of its payment (`approved`, V511, as the
  // cart mail's rebuild reads it). It now waits on payment alone - the SAME word as "Open Singles" (auto, unpaid) - never "payment and
  // approval". The expected word is another line of the same mail, not this function's output for the approved line.
  it.each(LOCALES)("%s: an entry approved ahead of its payment waits on payment alone - the same word as an unpaid auto entry", async (locale) => {
    const status = (text: string, division: string): string =>
      text.split("\n").find((l) => l.includes(division))!.replace(division, "").replace(/Maya/g, "").replace(/[£€$]\s?[\d.,]+/g, "").replace(/[()·—:\-\s]+/g, " ").trim();
    const approvedEntries = entries.map((e) => (e.divisionName === "Ladies Singles" ? { ...e, approved: true } : e));
    const args = { orgName: "Riverside Club", competitionName: "Spring Open", contactName: CONTACT, totalCents: 3700, currency: "gbp", paymentInstructions: null, statusUrl: "https://seazn.club/s" };
    const before = registrationTemplate({ ...args, entries }, await dictOf(locale)).text;
    const after = registrationTemplate({ ...args, entries: approvedEntries }, await dictOf(locale)).text;
    expect(status(before, "Ladies Singles"), "premise: unapproved, it waits on both").not.toBe(status(before, "Open Singles"));
    expect(status(after, "Ladies Singles")).toBe(status(after, "Open Singles"));
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

// Polish wave sign-off V2 (2026-11-12): the confirmation for ONE entry in a manual-approval division said "Registration received" and,
// in its preheader, "Your entry ... is in" - while the entry waited on the organiser. A cart's lines already named each entry's wait
// (above); a single entry never lists itself, so it named nothing. It now carries the SAME word its cart line would, and the preheader
// follows the wait. Expected words come from the dictionaries (the product's declared labels), never from this template's output.
describe("a single-entry confirmation says what the entry is waiting on (V2)", () => {
  type Entry = { status: string; feeCents: number; approval: "auto" | "manual"; approved?: boolean };
  const raw = (dict: Awaited<ReturnType<typeof dictOf>>, key: string): string => {
    const value = (dict as unknown as Record<string, unknown>)[key];
    expect(typeof value, `premise: ${key} is a dictionary string`).toBe("string");
    return value as string;
  };
  const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const fill = (s: string) => s.replace("{competitionName}", "Spring Open");
  const one = (entry: Entry, dict: Awaited<ReturnType<typeof dictOf>>) =>
    registrationTemplate(
      {
        orgName: "Riverside Club",
        competitionName: "Spring Open",
        contactName: CONTACT,
        entries: [{ displayName: "Maya", divisionName: "Masters Singles", ...entry }],
        totalCents: entry.feeCents,
        currency: "gbp",
        paymentInstructions: null,
        statusUrl: "https://seazn.club/s",
      },
      dict,
    );
  const WAITING: { name: string; entry: Entry; label: string; preheader: string; reviewed: boolean }[] = [
    { name: "free, manual", entry: { status: "pending", feeCents: 0, approval: "manual" }, label: "registration.entryStatusAwaitingApproval", preheader: "registration.preheaderAwaitingApproval", reviewed: true },
    { name: "fee owed, manual", entry: { status: "pending", feeCents: 1500, approval: "manual" }, label: "registration.entryStatusAwaitingPaymentApproval", preheader: "registration.preheaderAwaitingPaymentApproval", reviewed: true },
    { name: "paid, manual", entry: { status: "paid", feeCents: 1500, approval: "manual" }, label: "registration.entryStatusPaidAwaitingApproval", preheader: "registration.preheaderPaidAwaitingApproval", reviewed: true },
    { name: "fee owed, auto", entry: { status: "pending", feeCents: 1500, approval: "auto" }, label: "registration.entryStatusAwaitingPayment", preheader: "registration.preheaderPaid", reviewed: false },
    { name: "approved ahead of payment", entry: { status: "pending", feeCents: 1500, approval: "manual", approved: true }, label: "registration.entryStatusAwaitingPayment", preheader: "registration.preheaderPaid", reviewed: false },
  ];

  it.each(LOCALES)("%s: each waiting state names its wait in the html, the text and the preheader; a review wait says the organiser decides", async (locale) => {
    const dict = await dictOf(locale);
    const isIn = [fill(raw(dict, "registration.preheaderFree")), fill(raw(dict, "registration.preheaderPaid"))];
    const note = raw(dict, "registration.approvalNote");
    let checked = 0;
    for (const c of WAITING) {
      const out = one(c.entry, dict);
      const html = unescape(out.html);
      const label = raw(dict, c.label);
      expect(unescape(words(out.html)), `${locale} ${c.name}: html names the wait`).toContain(label);
      expect(out.text, `${locale} ${c.name}: text names the wait`).toContain(label);
      expect(html, `${locale} ${c.name}: preheader`).toContain(fill(raw(dict, c.preheader)));
      if (c.reviewed) {
        for (const claim of isIn) expect(html, `${locale} ${c.name}: never "is in" while the organiser decides`).not.toContain(claim);
        expect(html, `${locale} ${c.name}: html says the organiser decides`).toContain(note);
        expect(out.text, `${locale} ${c.name}: text says the organiser decides`).toContain(note);
      } else {
        expect(html, `${locale} ${c.name}: no review note when nobody reviews`).not.toContain(note);
      }
      expect(out.html, `${locale} ${c.name}: no raw key`).not.toMatch(/\bregistration\.[a-zA-Z]+\b/);
      checked += 1;
    }
    expect(checked, "anti-vacuity: five waiting states judged").toBe(5);
  });

  it.each(LOCALES)("%s: nothing waiting - a confirmed entry, a waitlisted one - carries no status line and no review note", async (locale) => {
    const dict = await dictOf(locale);
    const statusPrefix = raw(dict, "registration.textSingleStatus").split("{status}")[0]!.trim();
    expect(statusPrefix.length, "premise: the status line has a lead-in word").toBeGreaterThan(0);
    const settled: Entry[] = [
      { status: "confirmed", feeCents: 1500, approval: "manual" },
      { status: "waitlisted", feeCents: 1500, approval: "manual" },
    ];
    for (const entry of settled) {
      const out = one(entry, dict);
      expect(out.text, `${locale} ${entry.status}: no status line`).not.toContain(statusPrefix);
      expect(unescape(out.html), `${locale} ${entry.status}: no review note`).not.toContain(raw(dict, "registration.approvalNote"));
    }
  });

  it("English wording (typed, so a dictionary drift is seen)", async () => {
    const dict = await dictOf("en");
    const out = one({ status: "pending", feeCents: 0, approval: "manual" }, dict);
    expect(out.text).toContain("Status: Awaiting approval");
    expect(unescape(out.html)).toContain("Your entry for Spring Open is waiting for the organiser's approval.");
    expect(out.text).toContain("We'll email you as soon as it's approved.");
  });
});

// Polish wave sign-off V5: the payment reminder named the entry ("Maya") but not its division, so a registrant holding two entries
// for one person (singles and doubles) could not tell which one owed. It now names the division, html and text, like every line of
// the cart confirmation (W7).
describe("the payment reminder names the entry's division (V5)", () => {
  it.each(LOCALES)("%s: html and text both carry the division beside the entry, for a card and an offline reminder", async (locale) => {
    const dict = await dictOf(locale);
    const args = { orgName: "Riverside Club", competitionName: "Spring Open", displayName: "Maya", divisionName: "Masters Singles", contactName: CONTACT, feeCents: 1500, currency: "gbp", paymentInstructions: "Pay at the desk", payPageUrl: PAY_PAGE };
    let checked = 0;
    for (const method of ["card", "offline"] as const) {
      const out = paymentReminderTemplate({ ...args, method }, dict, locale);
      for (const [part, body] of [["html", words(out.html)], ["text", out.text]] as const) {
        expect(body, `${locale} ${method} ${part}: names the division`).toContain("Masters Singles");
        expect(body, `${locale} ${method} ${part}: still names the entry`).toContain("Maya");
        checked += 1;
      }
      expect(out.html, `${locale} ${method}: no unfilled placeholder`).not.toMatch(/\{[a-zA-Z]+\}/);
    }
    expect(checked, "anti-vacuity: two methods x two parts").toBe(4);
  });
});

// Polish wave sign-off V8 (the confirmation, reminder, promotion and refund mails; the lifecycle mails are in
// registration-lifecycle-copy.test.ts): "Thanks Dana Captain - your registration for Spring Open (Dana Captain, Open Doubles)". When the
// entry's name IS the contact's, the mail names the entry by its division and never repeats the person's name: the differential is the
// SAME mail for an entry with another name, so the contact is named exactly as often (the greeting) and the other entry's name appears.
describe("a registrant mail never names the contact back to themselves as the entry (V8)", () => {
  async function renders(locale: (typeof LOCALES)[number], displayName: string, contactName: string) {
    const dict = await dictOf(locale);
    const base = { orgName: "Riverside Club", competitionName: "Spring Open", displayName, divisionName: DIVISION, contactName, currency: "gbp" };
    const entry = (divisionName: string, feeCents: number) => ({ displayName, divisionName, status: "pending", feeCents, approval: "auto" as const });
    const confirmation = (entries: ReturnType<typeof entry>[]) =>
      registrationTemplate(
        { orgName: base.orgName, competitionName: base.competitionName, contactName, entries, totalCents: 1500, currency: "gbp", paymentInstructions: null, statusUrl: "https://seazn.club/s" },
        dict,
      );
    return {
      confirmation: confirmation([entry(DIVISION, 1500)]),
      confirmationCart: confirmation([entry(DIVISION, 1500), entry("Masters Doubles", 0)]),
      reminder: paymentReminderTemplate({ ...base, feeCents: 1500, paymentInstructions: null, method: "card", payPageUrl: PAY_PAGE }, dict),
      promotion: registrationPromotedTemplate({ ...base, feeCents: 1500, method: "card", payPageUrl: PAY_PAGE }, dict),
      refund: refundIssuedTemplate({ ...base, amountCents: 1500 }, dict),
    } as Record<string, { subject: string; html: string; text: string }>;
  }
  const count = (hay: string, needle: string) => hay.toLowerCase().split(needle.toLowerCase()).length - 1;

  it.each(LOCALES)("%s: the contact's own entry adds no mention of their name; another entry's name is printed (counted)", async (locale) => {
    const other = await renders(locale, TEAM, CONTACT);
    let checked = 0;
    for (const contactSpelling of [CONTACT, "  dana   CAPTAIN "]) {
      const own = await renders(locale, CONTACT, contactSpelling);
      for (const name of Object.keys(other)) {
        const o = own[name]!;
        const t = other[name]!;
        expect(words(t.html), `${locale} ${name}: premise - the other entry is named`).toContain(TEAM);
        const greetings = count(words(t.html), CONTACT);
        // A cart's confirmation has no greeting (its intro names the competition): there the contact's name must not appear at all.
        if (name !== "confirmationCart") expect(greetings, `${locale} ${name}: premise - the contact is greeted`).toBeGreaterThan(0);
        expect(count(words(o.html), "dana captain"), `${locale} ${name}: html - the greeting only`).toBe(greetings);
        expect(count(o.text, "dana captain"), `${locale} ${name}: text`).toBe(count(t.text, CONTACT));
        expect(count(o.subject, "dana captain"), `${locale} ${name}: subject`).toBe(0);
        for (const part of [o.subject, o.html, o.text]) {
          expect(part, `${locale} ${name}: no raw dictionary token`).not.toMatch(/\b(registration|paymentReminder|registrationPromoted|refundIssued)\.[a-zA-Z]+\b/);
          expect(part, `${locale} ${name}: no unfilled placeholder`).not.toMatch(/\{\w+\}/);
        }
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 5 mails x 2 spellings").toBe(10);
  });

  it("en, written out: the single confirmation names the division alone; a cart lists each own entry by its division", async () => {
    const own = await renders("en", CONTACT, CONTACT);
    expect(words(own.confirmation!.html)).toContain("Thanks Dana Captain — your registration for Spring Open (Open Doubles) has been received.");
    expect(own.confirmationCart!.text).toContain("Open Doubles — ");
    expect(own.confirmationCart!.text).toContain("Masters Doubles — ");
    expect(own.reminder!.text).toContain("Open Doubles");
  });
});
