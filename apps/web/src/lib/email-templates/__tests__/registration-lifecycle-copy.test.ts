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
/** The amount owed, as the producer hands it over (already spelled by `money()` in the recipient's language). */
const DUE = "£15.00";
const ENTRY = "Riverside Rovers";
const DIVISION = "Open Doubles";
const COMP = "Spring Open";
const ORG = "Riverside Club";
const REF = "RVR-4821";
const LINK = "https://seazn.club/live/riverside-club/spring-open";

const base = { orgName: ORG, competitionName: COMP, divisionName: DIVISION, displayName: ENTRY, refCode: REF };
// The payment mail is CART-shaped (fix round 1): a list of entries, each with its own amount and standing.
const ENTRY2 = "Second Squad";
const DIVISION2 = "Masters Doubles";
const entry1 = (confirmed: boolean, amountCents = 1500) => ({ displayName: ENTRY, divisionName: DIVISION, amountCents, confirmed });
const entry2 = (confirmed: boolean, amountCents = 900) => ({ displayName: ENTRY2, divisionName: DIVISION2, amountCents, confirmed });
const paidBase = { orgName: ORG, competitionName: COMP, refCode: REF, contactName: PERSON, currency: "gbp" };
const dictOf = (locale: (typeof LOCALES)[number]) => getDictionary(locale, "emails");
const words = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const STATES: JoinedState[] = ["confirmed", "waitlisted", "payment", "approval", "payment_and_approval"];

async function renderAll(locale: (typeof LOCALES)[number]) {
  const dict = await dictOf(locale);
  return {
    paidConfirmed: registrationPaidTemplate({ ...paidBase, entries: [entry1(true)], statusUrl: LINK }, dict),
    paidApproval: registrationPaidTemplate({ ...paidBase, entries: [entry1(false)], statusUrl: LINK }, dict),
    paidCartConfirmed: registrationPaidTemplate({ ...paidBase, entries: [entry1(true), entry2(true)], statusUrl: LINK }, dict),
    paidCartApproval: registrationPaidTemplate({ ...paidBase, entries: [entry1(false), entry2(false)], statusUrl: LINK }, dict),
    paidCartMixed: registrationPaidTemplate({ ...paidBase, entries: [entry1(true), entry2(false)], statusUrl: LINK }, dict),
    approved: registrationApprovedTemplate({ ...base, recipientName: PERSON, competitionUrl: LINK }, dict),
    // Polish wave P5 (W12): approved while the fee is still due.
    approvedPaymentDue: registrationApprovedTemplate({ ...base, recipientName: PERSON, competitionUrl: LINK, paymentDue: DUE }, dict),
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
    expect(checked, "anti-vacuity: 5 kinds, joined in 5 states, paid in 5 (2 single + 3 cart), approved in 2 = 14 renders").toBe(14);
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
    expect(checked, "anti-vacuity: every render of every non-English locale").toBe(42);
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

  it.each(LOCALES)("%s: approved with the fee still due (W12) is a different mail: its own subject and body, the amount, and never the plain 'confirmed' copy", async (locale) => {
    const dict = await dictOf(locale);
    const outs = await renderAll(locale);
    const plain = outs.approved!;
    const due = outs.approvedPaymentDue!;
    const fill = (key: string, vars: Record<string, string>) =>
      Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), String(dict[`registrationApproved.${key}`]));
    expect(due.subject).toBe(fill("subjectPaymentDue", { competitionName: COMP }));
    expect(plain.subject).toBe(fill("subject", { competitionName: COMP }));
    expect(due.subject, "two different subjects").not.toBe(plain.subject);
    expect(due.text).toContain(fill("textBodyPaymentDue", { displayName: ENTRY, divisionName: DIVISION, amount: DUE }));
    expect(due.text, "the plain body is not sent alongside").not.toContain(fill("textBody", { displayName: ENTRY, divisionName: DIVISION }));
    expect(words(due.html)).toContain(DUE);
    expect(plain.text, "the plain approval names no amount").not.toContain(DUE);
    expect(words(plain.html)).not.toContain(DUE);
  });

  it.each(LOCALES)("%s: the paid mail quotes THIS entry's amount, with two decimals", async (locale) => {
    const out = (await renderAll(locale)).paidConfirmed;
    // money() is the house formatter; 1500 pence is 15.00 in every locale's text (symbol and separator vary, the digits do not).
    expect(out.text).toMatch(/15[.,]00/);
  });

  it.each(LOCALES)("%s: a CART payment lists every entry with its own amount and standing, the total, and a panel that matches the mix", async (locale) => {
    const outs = await renderAll(locale);
    const dict = await dictOf(locale);
    const lineConfirmed = String(dict["registrationPaid.lineConfirmed"]);
    const lineApproval = String(dict["registrationPaid.lineApproval"]);
    expect(lineConfirmed.includes(lineApproval) || lineApproval.includes(lineConfirmed), `${locale}: premise: the two state words are not substrings of each other`).toBe(false);
    const opposite = (w: string) => (w === lineConfirmed ? lineApproval : lineConfirmed);
    let checked = 0;
    for (const name of ["paidCartConfirmed", "paidCartApproval", "paidCartMixed"] as const) {
      const out = outs[name]!;
      // Both entries, each with its own division, its own amount (15.00 and 9.00, never a smeared total), and the total (24.00).
      for (const part of [out.text, words(out.html)]) {
        expect(part, `${locale} ${name}: first entry`).toContain(ENTRY);
        expect(part, `${locale} ${name}: first division`).toContain(DIVISION);
        expect(part, `${locale} ${name}: second entry`).toContain(ENTRY2);
        expect(part, `${locale} ${name}: second division`).toContain(DIVISION2);
        expect(part, `${locale} ${name}: first amount`).toMatch(/15[.,]00/);
        expect(part, `${locale} ${name}: second amount`).toMatch(/9[.,]00/);
        expect(part, `${locale} ${name}: the total`).toMatch(/24[.,]00/);
      }
      // One line per entry in the text, each carrying its OWN state word.
      const lines = out.text.split("\n");
      const l1 = lines.find((l) => l.includes(ENTRY) && l.includes(DIVISION))!;
      const l2 = lines.find((l) => l.includes(ENTRY2) && l.includes(DIVISION2))!;
      expect(l1, `${locale} ${name}: the first entry's own line`).toBeDefined();
      expect(l2, `${locale} ${name}: the second entry's own line`).toBeDefined();
      const want = { paidCartConfirmed: [lineConfirmed, lineConfirmed], paidCartApproval: [lineApproval, lineApproval], paidCartMixed: [lineConfirmed, lineApproval] }[name];
      expect(l1, `${locale} ${name}: first state`).toContain(want[0]!);
      expect(l1, `${locale} ${name}: first line carries no other state`).not.toContain(opposite(want[0]!));
      expect(l2, `${locale} ${name}: second state`).toContain(want[1]!);
      expect(l2, `${locale} ${name}: second line carries no other state`).not.toContain(opposite(want[1]!));
      checked += 1;
    }
    const key = (k: string): string => String(dict[`registrationPaid.${k}`]);
    expect(outs.paidCartConfirmed!.text).toContain(key("cartAllConfirmedTitle"));
    expect(outs.paidCartApproval!.text).toContain(key("cartAllApprovalTitle"));
    expect(outs.paidCartMixed!.text).toContain(key("cartMixedTitle"));
    expect(outs.paidCartMixed!.text, "a mixed cart claims neither 'all confirmed' nor 'all awaiting'").not.toContain(key("cartAllConfirmedTitle"));
    expect(outs.paidCartMixed!.text).not.toContain(key("cartAllApprovalTitle"));
    expect(checked, "anti-vacuity: the three cart states").toBe(3);
  });

  it.each(LOCALES)("%s: a one-entry payment is the single-entry mail, not a one-line cart (no total, no list)", async (locale) => {
    const dict = await dictOf(locale);
    const out = (await renderAll(locale)).paidConfirmed;
    expect(out.text).not.toContain(String(dict["registrationPaid.textTotal"]).split("{amount}")[0]!);
    expect(out.text).toContain(String(dict["registrationPaid.confirmedTitle"]));
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
      ["paid", registrationPaidTemplate({ ...paidBase, entries: [entry1(true, 100)], statusUrl: LINK }, dict), registrationPaidTemplate({ ...paidBase, entries: [entry1(true, 100)] }, dict)],
      ["paid cart", registrationPaidTemplate({ ...paidBase, entries: [entry1(true), entry2(true)], statusUrl: LINK }, dict), registrationPaidTemplate({ ...paidBase, entries: [entry1(true), entry2(true)] }, dict)],
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
    expect(checked).toBe(5);
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
