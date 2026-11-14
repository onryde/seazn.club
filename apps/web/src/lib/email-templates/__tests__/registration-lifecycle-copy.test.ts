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
  registrationPromotionLapsedTemplate,
  registrationPromotionSkippedTemplate,
  registrationRejectedTemplate,
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
/** Walk-fix F16: the Lichess link start the skipped mail's one step points at (`lichessLinkStartHref`, absolute). */
const LICHESS = "https://seazn.club/api/auth/lichess?org=riverside-club";

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
    // Polish wave P5 (P2 carry): rejected (with and without the payer's refund line), and a promotion that lapsed.
    rejected: registrationRejectedTemplate({ ...base, contactName: PERSON }, dict),
    rejectedRefund: registrationRejectedTemplate({ ...base, contactName: PERSON, refundAmount: DUE }, dict),
    promotionLapsed: registrationPromotionLapsedTemplate({ ...base, contactName: PERSON, competitionUrl: LINK }, dict),
    // Walk-fix F16: an automatic promotion passed the entry over (no Lichess link that plays).
    promotionSkipped: registrationPromotionSkippedTemplate({ ...base, contactName: PERSON, linkUrl: LICHESS }, dict),
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
        expect(part, `${locale} ${name}: no raw dictionary token`).not.toMatch(/\b(registrationPaid|registrationApproved|registrationExpired|registrationWithdrawn|registrationJoined|registrationRejected|registrationPromotionLapsed|registrationPromotionSkipped)\.[a-zA-Z]+\b/);
        expect(part, `${locale} ${name}: no unfilled placeholder`).not.toMatch(/\{\w+\}/);
      }
      expect(out.subject, `${locale} ${name}: the subject is non-empty`).not.toBe("");
      checked += 1;
    }
    expect(checked, "anti-vacuity: 8 kinds, joined in 5 states, paid in 5 (2 single + 3 cart), approved in 2, rejected in 2 = 18 renders").toBe(18);
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
    expect(checked, "anti-vacuity: every render of every non-English locale").toBe(54);
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
      ["promotion lapsed", registrationPromotionLapsedTemplate({ ...base, contactName: PERSON, competitionUrl: LINK }, dict), registrationPromotionLapsedTemplate({ ...base, contactName: PERSON }, dict)],
    ];
    let checked = 0;
    for (const [name, linked, bare] of calls) {
      expect(linked.html, `${name} html`).toContain(LINK);
      expect(linked.text, `${name} text`).toContain(LINK);
      expect(bare.html, `${name} html without a link`).not.toContain(LINK);
      expect(bare.text, `${name} text without a link`).not.toContain("https://");
      checked += 1;
    }
    expect(checked).toBe(6);
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

describe("the rejection's refund line (polish wave P5)", () => {
  it.each(LOCALES)("%s: the payer's mail names what is coming back, in both parts; with no amount there is no refund line at all", async (locale) => {
    const dict = await dictOf(locale);
    const withRefund = registrationRejectedTemplate({ ...base, contactName: PERSON, refundAmount: DUE }, dict);
    const without = registrationRejectedTemplate({ ...base, contactName: PERSON, refundAmount: null }, dict);
    const fill = (key: string) => String(dict[key]).split("{amount}").join(DUE);
    expect(withRefund.text).toContain(fill("registrationRejected.textRefund"));
    expect(words(withRefund.html)).toContain(words(fill("registrationRejected.refund")).trim());
    const lead = String(dict["registrationRejected.textRefund"]).split("{amount}")[0]!.trim();
    expect(lead.length, "premise: the refund sentence has words before the amount").toBeGreaterThan(3);
    expect(without.text).not.toContain(DUE);
    expect(without.text).not.toContain(lead);
    expect(words(without.html)).not.toContain(DUE);
  });
});

// Polish wave sign-off V4: the paid cart mail's entry list rendered in the mail client's default serif - the one block of the mail
// with no font of its own (the paragraph, panel and button blocks each carry the house sans stack). The expected stack and colour
// are read off the SAME mail's intro paragraph right above the list, so the list follows the house block if the house block changes.
describe("the paid cart mail's entry list wears the mail's own type (V4)", () => {
  const styleOf = (tag: string, html: string): string => {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*style="([^"]*)"`));
    expect(m, `premise: a styled <${tag}> in the mail`).not.toBeNull();
    return m![1]!;
  };
  const prop = (style: string, name: string): string | undefined =>
    style.split(";").map((d) => d.split(":")).find(([k]) => k!.trim() === name)?.slice(1).join(":").trim();

  it.each(LOCALES)("%s: font-family and colour match the paragraph's", async (locale) => {
    const html = registrationPaidTemplate({ ...paidBase, entries: [entry1(true), entry2(false)], statusUrl: LINK }, await dictOf(locale)).html;
    const ul = styleOf("ul", html);
    // The paragraph block right above the list (the cart's intro), not the masthead's own <p>.
    const before = html.slice(0, html.indexOf("<ul"));
    const paragraphs = [...before.matchAll(/<p\b[^>]*style="([^"]*)"/g)];
    expect(paragraphs.length, "premise: a paragraph precedes the list").toBeGreaterThan(0);
    const p = paragraphs.at(-1)![1]!;
    let checked = 0;
    for (const name of ["font-family", "color"]) {
      const want = prop(p, name);
      expect(want, `premise: the paragraph declares ${name}`).toBeTruthy();
      expect(prop(ul, name), `${locale}: the list's ${name}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(2);
  });
});

// Polish wave sign-off V8: an individual registering themself got "Hi Mia Cole - the organiser has approved Mia Cole in Open Singles":
// the mail named the recipient back to them as the entry. When the entry's name IS the recipient's (compared trimmed, spaces collapsed,
// case-folded), every part of the mail calls it "your entry" and names it by its division ("Open Singles"); the greeting is then the
// only place the person's name appears. Any other entry (a team, a pair, someone the registrant entered for) is still named. The
// expected sentences below are written out, not read back from the template.
describe("a mail about the recipient's own entry calls it 'your entry', never their own name back (V8)", () => {
  const SELF = "Mia Cole";
  const SINGLES = "Open Singles";
  const MASTERS = "Masters Singles";
  const ownBase = { orgName: ORG, competitionName: COMP, divisionName: SINGLES, displayName: SELF, refCode: REF };
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  async function renderOwn(locale: (typeof LOCALES)[number], recipient: string) {
    const dict = await dictOf(locale);
    const own = (amountCents: number, divisionName: string, confirmed: boolean) => ({ displayName: SELF, divisionName, amountCents, confirmed });
    const paid = { ...paidBase, contactName: recipient };
    return {
      paid: registrationPaidTemplate({ ...paid, entries: [own(1500, SINGLES, true)], statusUrl: LINK }, dict),
      paidCart: registrationPaidTemplate({ ...paid, entries: [own(1500, SINGLES, true), own(900, MASTERS, false)], statusUrl: LINK }, dict),
      approved: registrationApprovedTemplate({ ...ownBase, recipientName: recipient, competitionUrl: LINK }, dict),
      approvedPaymentDue: registrationApprovedTemplate({ ...ownBase, recipientName: recipient, competitionUrl: LINK, paymentDue: DUE }, dict),
      expired: registrationExpiredTemplate({ ...ownBase, contactName: recipient, registerUrl: LINK }, dict),
      withdrawn: registrationWithdrawnTemplate({ ...ownBase, contactName: recipient }, dict),
      rejected: registrationRejectedTemplate({ ...ownBase, contactName: recipient, refundAmount: DUE }, dict),
      promotionLapsed: registrationPromotionLapsedTemplate({ ...ownBase, contactName: recipient, competitionUrl: LINK }, dict),
      promotionSkipped: registrationPromotionSkippedTemplate({ ...ownBase, contactName: recipient, linkUrl: LICHESS }, dict),
    } as Record<string, { subject: string; html: string; text: string }>;
  }

  it.each(LOCALES)("%s: the recipient's own entry - their name only in the greeting, the division named, no token or placeholder", async (locale) => {
    let checked = 0;
    // The same person, as the producer may spell them twice: exact, and with different case and stray spaces.
    for (const recipient of [SELF, "  mia   COLE "]) {
      for (const [name, out] of Object.entries(await renderOwn(locale, recipient))) {
        const visible = words(out.html);
        expect(count(visible.toLowerCase(), "mia cole") + count(visible.toLowerCase(), "mia   cole"), `${locale} ${name}: the greeting only`).toBe(1);
        expect(out.text.toLowerCase(), `${locale} ${name}: the text never names them as the entry`).not.toContain("mia cole");
        expect(out.subject.toLowerCase(), `${locale} ${name}: nor the subject`).not.toContain("mia cole");
        expect(visible, `${locale} ${name}: html names the division`).toContain(SINGLES);
        expect(out.text, `${locale} ${name}: text names the division`).toContain(SINGLES);
        for (const part of [out.subject, out.html, out.text]) {
          expect(part, `${locale} ${name}: no raw dictionary token`).not.toMatch(/\b(registrationPaid|registrationApproved|registrationExpired|registrationWithdrawn|registrationRejected|registrationPromotionLapsed|registrationPromotionSkipped)\.[a-zA-Z]+\b/);
          expect(part, `${locale} ${name}: no unfilled placeholder`).not.toMatch(/\{\w+\}/);
        }
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 9 renders x 2 spellings").toBe(18);
  });

  it("en, written out: the intro and the text say 'your entry' and the division", async () => {
    const outs = await renderOwn("en", SELF);
    expect(words(outs.approved!.html)).toContain("Hi Mia Cole — the organiser has approved your entry in Open Singles at Spring Open. Your place is confirmed.");
    expect(outs.approved!.text).toContain("The organiser has approved your entry in Open Singles. Your place is confirmed.");
    expect(outs.expired!.text).toContain("Your entry in Open Singles was not paid by its deadline, so the place has been released.");
    expect(words(outs.paid!.html)).toContain("for your entry in Open Singles at Spring Open.");
    // The cart lists each own entry by its division: no line opens with a lower-case "your entry".
    expect(outs.paidCart!.text).toContain("Open Singles — £15.00 — ");
    expect(outs.paidCart!.text).toContain("Masters Singles — £9.00 — ");
  });

  it.each(LOCALES)("%s: the pair - someone else's entry (the registrant entered another person) is still named, in every mail", async (locale) => {
    let checked = 0;
    for (const [name, out] of Object.entries(await renderOwn(locale, "Alex Parent"))) {
      expect(words(out.html), `${locale} ${name}: the entry is named`).toContain(SELF);
      expect(out.text, `${locale} ${name}: in the text too`).toContain(SELF);
      checked += 1;
    }
    expect(checked).toBe(9);
  });

  it.each(LOCALES)("%s: a cart mixing the recipient's own entry with a team names the team and not the recipient", async (locale) => {
    const dict = await dictOf(locale);
    const out = registrationPaidTemplate(
      { ...paidBase, contactName: SELF, entries: [{ displayName: SELF, divisionName: SINGLES, amountCents: 1500, confirmed: true }, entry1(true)], statusUrl: LINK },
      dict,
    );
    expect(count(words(out.html), SELF), "the greeting only").toBe(1);
    expect(out.text).not.toContain(SELF);
    expect(out.text).toContain(ENTRY);
    expect(out.text).toContain(SINGLES);
  });
});

// Walk-fix F16 (ruling): an automatic promotion on an online-play division passed the entry over because its Lichess account is not linked
// to play. ONE mail per skip saying so, that the entry KEEPS its place, and the one step that makes the next place theirs: link Lichess.
describe("registration_promotion_skipped (walk-fix F16)", () => {
  it.each(LOCALES)("%s: the Link step is the mail's button and its text line; the place-kept panel and the reference are said", async (locale) => {
    const dict = await dictOf(locale);
    const out = registrationPromotionSkippedTemplate({ ...base, contactName: PERSON, linkUrl: LICHESS }, dict);
    const html = out.html.replaceAll("&amp;", "&");
    expect(html, "the button's href is the link start").toContain(`href="${LICHESS}"`);
    expect(out.text, "the text carries the same link").toContain(LICHESS);
    expect(words(out.html), "the reference is quoted").toContain(REF);
    expect(out.text).toContain(REF);
    const en = registrationPromotionSkippedTemplate({ ...base, contactName: PERSON, linkUrl: LICHESS }, await dictOf("en"));
    if (locale !== "en") expect(words(out.html), `${locale}: translated, not the English body`).not.toBe(words(en.html));
  });

  it("en, written out: skipped, why, the place is kept, and the Link step", async () => {
    const dict = await dictOf("en");
    const own = registrationPromotionSkippedTemplate({ ...base, displayName: PERSON, contactName: PERSON, linkUrl: LICHESS }, dict);
    expect(own.subject).toBe("You were skipped on the waiting list — Spring Open");
    const visible = words(own.html);
    expect(visible).toContain(
      "Hi Dana Captain — a place opened in Open Doubles at Spring Open, but it could not go to you: games in this division are played on Lichess, and your Lichess account isn't linked to play yet. The place went to the next entry in line.",
    );
    expect(visible).toContain("Your entry keeps its place on the waiting list. Link your Lichess account, and the next place that opens can go to you.");
    expect(visible).toContain("Link your Lichess account");
    expect(own.text).toContain("Link your Lichess account:\n" + LICHESS);
    // A contact entering someone else (an entry named for another): the entry is named, never "you".
    const other = registrationPromotionSkippedTemplate({ ...base, contactName: PERSON, linkUrl: LICHESS }, dict);
    expect(words(other.html)).toContain("but it could not go to Riverside Rovers: games in this division are played on Lichess");
  });
});
