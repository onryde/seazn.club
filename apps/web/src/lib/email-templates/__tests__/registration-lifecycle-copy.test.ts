// Polish wave P2: the five registrant lifecycle mails (payment received, approved, released, withdrawn by the organiser, joined).
// What a template owns: who it greets, which entry and division it names, the honest state, the link, and that no locale ships a raw
// dictionary token or an unfilled {placeholder}. Every assertion is a differential over the four shipped locales, never one sampled
// language. The queueing (kind, recipient, once-key, locale choice) is the producers' and is tested in registration-lifecycle-mail.test.ts.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { LOCALES } from "@/lib/i18n-constants";
import {
  registrationApprovedTemplate,
  registrationExpiredTemplate,
  registrationJoinedTemplate,
  registrationPaidTemplate,
  registrationWithdrawnTemplate,
  type JoinedState,
} from "@/lib/email-templates";

const PERSON = "Dana Captain";
const ENTRY = "Riverside Rovers";
const DIVISION = "Open Doubles";
const COMP = "Spring Open";
const ORG = "Riverside Club";
const REF = "RVR-4821";
const LINK = "https://seazn.club/live/riverside-club/spring-open";

const base = { orgName: ORG, competitionName: COMP, divisionName: DIVISION, displayName: ENTRY, refCode: REF };
const dictOf = (locale: (typeof LOCALES)[number]) => getDictionary(locale, "emails");
const words = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const STATES: JoinedState[] = ["confirmed", "waitlisted", "payment", "approval", "payment_and_approval"];

async function renderAll(locale: (typeof LOCALES)[number]) {
  const dict = await dictOf(locale);
  return {
    paidConfirmed: registrationPaidTemplate({ ...base, contactName: PERSON, amountCents: 1500, currency: "gbp", confirmed: true, statusUrl: LINK }, dict),
    paidApproval: registrationPaidTemplate({ ...base, contactName: PERSON, amountCents: 1500, currency: "gbp", confirmed: false, statusUrl: LINK }, dict),
    approved: registrationApprovedTemplate({ ...base, recipientName: PERSON, competitionUrl: LINK }, dict),
    expired: registrationExpiredTemplate({ ...base, contactName: PERSON, registerUrl: LINK }, dict),
    withdrawn: registrationWithdrawnTemplate({ ...base, contactName: PERSON }, dict),
    ...Object.fromEntries(
      STATES.map((s) => [`joined_${s}`, registrationJoinedTemplate({ ...base, refCode: null, playerName: PERSON, state: s, competitionUrl: LINK }, dict)]),
    ),
  } as Record<string, { subject: string; html: string; text: string }>;
}

describe("every lifecycle mail, in every locale", () => {
  it.each(LOCALES)("%s: greets the person BEFORE the entry, names the division, carries no raw token or {placeholder}", async (locale) => {
    const outs = await renderAll(locale);
    let checked = 0;
    for (const [name, out] of Object.entries(outs)) {
      const visible = words(out.html);
      const at = visible.indexOf(PERSON);
      expect(at, `${locale} ${name}: the person is named`).toBeGreaterThanOrEqual(0);
      // The hidden preheader (the inbox preview line) may name the entry first; the BODY names the person before the entry.
      const entryAt = visible.indexOf(ENTRY, at);
      expect(entryAt, `${locale} ${name}: the entry is named after the greeting`).toBeGreaterThan(at);
      expect(out.html, `${locale} ${name}: html names the division`).toContain(DIVISION);
      expect(out.text, `${locale} ${name}: text names the division`).toContain(DIVISION);
      for (const part of [out.subject, out.html, out.text]) {
        expect(part, `${locale} ${name}: no raw dictionary token`).not.toMatch(/\b(registrationPaid|registrationApproved|registrationExpired|registrationWithdrawn|registrationJoined)\.[a-zA-Z]+\b/);
        expect(part, `${locale} ${name}: no unfilled placeholder`).not.toMatch(/\{\w+\}/);
      }
      expect(out.subject, `${locale} ${name}: the subject is non-empty`).not.toBe("");
      checked += 1;
    }
    expect(checked, "anti-vacuity: 5 kinds, joined in 5 states, paid in 2 = 10 renders").toBe(10);
  });

  it("the subjects differ between locales (an untranslated key would repeat the English one)", async () => {
    const en = await renderAll("en");
    let checked = 0;
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const other = await renderAll(locale);
      for (const name of Object.keys(en)) {
        expect(other[name]!.subject, `${locale} ${name}`).not.toBe(en[name]!.subject);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every render of every non-English locale").toBe(30);
  });
});

describe("the state each mail states", () => {
  it.each(LOCALES)("%s: paid-and-confirmed and paid-awaiting-approval are different mails, and the unconfirmed one never says confirmed", async (locale) => {
    const dict = await dictOf(locale);
    const confirmed = (await renderAll(locale)).paidConfirmed;
    const approval = (await renderAll(locale)).paidApproval;
    expect(confirmed.text).toContain(dict["registrationPaid.confirmedTitle"]);
    expect(approval.text).toContain(dict["registrationPaid.approvalTitle"]);
    expect(approval.text, "the approval-pending mail does not claim a confirmation").not.toContain(dict["registrationPaid.confirmedTitle"]);
    expect(confirmed.text, "and the confirmed one does not say it is waiting").not.toContain(dict["registrationPaid.approvalTitle"]);
    expect(confirmed.text).not.toBe(approval.text);
  });

  it.each(LOCALES)("%s: the paid mail quotes THIS entry's amount, with two decimals", async (locale) => {
    const out = (await renderAll(locale)).paidConfirmed;
    // money() is the house formatter; 1500 pence is 15.00 in every locale's text (symbol and separator vary, the digits do not).
    expect(out.text).toMatch(/15[.,]00/);
  });

  it.each(LOCALES)("%s: a joiner is told five different things for five entry states, and never 'confirmed' unless the entry is", async (locale) => {
    const outs = await renderAll(locale);
    const dict = await dictOf(locale);
    const texts = STATES.map((s) => outs[`joined_${s}`]!.text);
    expect(new Set(texts).size, "five states, five texts").toBe(5);
    for (const s of STATES) {
      const text = outs[`joined_${s}`]!.text;
      const confirmedTitle = dict["registrationJoined.stateConfirmedTitle"]!;
      if (s === "confirmed") expect(text).toContain(confirmedTitle);
      else expect(text, `${s}: must not claim the entry is confirmed`).not.toContain(confirmedTitle);
    }
    // The waiting states name what they wait on.
    expect(outs.joined_payment!.text).toContain(dict["registrationJoined.statePaymentTitle"]);
    expect(outs.joined_approval!.text).toContain(dict["registrationJoined.stateApprovalTitle"]);
    expect(outs.joined_payment_and_approval!.text).toContain(dict["registrationJoined.statePaymentApprovalTitle"]);
  });

  it.each(LOCALES)("%s: a joiner mail with NO state says nothing about the entry's standing (null is not 'confirmed')", async (locale) => {
    const dict = await dictOf(locale);
    const out = registrationJoinedTemplate({ ...base, refCode: null, playerName: PERSON, state: null, competitionUrl: LINK }, dict);
    for (const key of Object.keys(dict).filter((k) => /^registrationJoined\.state.*Title$/.test(k))) {
      expect(out.text, key).not.toContain(dict[key]!);
      expect(out.html, key).not.toContain(dict[key]!);
    }
    expect(out.text).toContain(ENTRY);
  });
});

describe("links and reference", () => {
  it("the reference is shown to the owner of the entry and omitted when the recipient has none (a joiner)", async () => {
    const dict = await dictOf("en");
    const withRef = registrationApprovedTemplate({ ...base, recipientName: PERSON, competitionUrl: LINK }, dict);
    const without = registrationApprovedTemplate({ ...base, refCode: null, recipientName: PERSON, competitionUrl: LINK }, dict);
    expect(withRef.text).toContain(REF);
    expect(withRef.html).toContain(REF);
    expect(without.text).not.toContain(REF);
    expect(without.html).not.toContain(REF);
    // Not an empty "Registration reference: ." line either: the label goes with the value.
    expect(without.text).not.toContain("Registration reference");
    expect(without.html).not.toContain("Registration reference");
    expect(withRef.text).toContain("Registration reference");
  });

  it("every link the producer passes is rendered, and none is invented when it passes none", async () => {
    const dict = await dictOf("en");
    const calls: Array<[string, { subject: string; html: string; text: string }, { subject: string; html: string; text: string }]> = [
      ["paid", registrationPaidTemplate({ ...base, contactName: PERSON, amountCents: 100, currency: "gbp", confirmed: true, statusUrl: LINK }, dict), registrationPaidTemplate({ ...base, contactName: PERSON, amountCents: 100, currency: "gbp", confirmed: true }, dict)],
      ["approved", registrationApprovedTemplate({ ...base, recipientName: PERSON, competitionUrl: LINK }, dict), registrationApprovedTemplate({ ...base, recipientName: PERSON }, dict)],
      ["expired", registrationExpiredTemplate({ ...base, contactName: PERSON, registerUrl: LINK }, dict), registrationExpiredTemplate({ ...base, contactName: PERSON }, dict)],
      ["joined", registrationJoinedTemplate({ ...base, playerName: PERSON, state: "confirmed", competitionUrl: LINK }, dict), registrationJoinedTemplate({ ...base, playerName: PERSON, state: "confirmed" }, dict)],
    ];
    let checked = 0;
    for (const [name, linked, bare] of calls) {
      expect(linked.html, `${name} html`).toContain(LINK);
      expect(linked.text, `${name} text`).toContain(LINK);
      expect(bare.html, `${name} html without a link`).not.toContain(LINK);
      expect(bare.text, `${name} text without a link`).not.toContain("https://");
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("names are escaped in the html and left raw in the text (a team called 'A & B <x>')", async () => {
    const dict = await dictOf("en");
    const out = registrationWithdrawnTemplate({ ...base, displayName: "A & B <x>", contactName: "Zoe <b>", divisionName: "D & E" }, dict);
    expect(out.html).toContain("A &amp; B &lt;x&gt;");
    expect(out.html).not.toContain("<x>");
    expect(out.html).not.toContain("Zoe <b>");
    expect(out.text).toContain("A & B <x>");
  });
});
