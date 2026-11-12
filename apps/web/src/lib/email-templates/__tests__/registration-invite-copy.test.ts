// Polish wave P6: the cart confirmation carries an "Invite your teammates" block - the team's join link for a team entry, the partner's
// claim link for a pair - so the captain has the link in the one mail they keep. The link is meant to be FORWARDED, so it is a panel the
// captain copies from (the same shape as the reference panel), not a button.
//
// Every assertion is a differential over the four shipped locales, never one sampled language: an untranslated key renders as its own
// raw token, and a locale whose wording drops the placeholder would pass a single-language test.
import { describe, expect, it } from "vitest";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { LOCALES } from "@/lib/i18n-constants";
import { registrationTemplate, type RegistrationEmailArgs } from "@/lib/email-templates";

const TEAM = "Riverside Rovers";
const PAIR = "Maya Chen & Priya Rao";
const DIVISION = "Open Doubles";
const TEAM_URL = "https://seazn.club/live/acme/spring/register/join?join_code=TEAMCODE1";
const PAIR_URL = "https://seazn.club/live/acme/spring/register/join?join_code=PAIRCODE2&player_id=11111111-2222-3333-4444-555555555555";
const STATUS_URL = "https://seazn.club/live/acme/spring/register/status?rid=g1&token=tok";

const dictOf = (locale: (typeof LOCALES)[number]) => getDictionary(locale, "emails");

const base = (over: Partial<RegistrationEmailArgs> = {}): RegistrationEmailArgs => ({
  orgName: "Riverside Club",
  competitionName: "Spring Open",
  contactName: "Dana Captain",
  entries: [
    { displayName: TEAM, divisionName: DIVISION, status: "pending", feeCents: 0, approval: "auto" },
    { displayName: PAIR, divisionName: "Mixed Pairs", status: "pending", feeCents: 0, approval: "auto" },
  ],
  totalCents: 0,
  currency: "gbp",
  paymentInstructions: null,
  statusUrl: STATUS_URL,
  ...over,
});

const INVITES: NonNullable<RegistrationEmailArgs["invites"]> = [
  { displayName: TEAM, divisionName: DIVISION, kind: "team", url: TEAM_URL },
  { displayName: PAIR, divisionName: "Mixed Pairs", kind: "pair", url: PAIR_URL },
];

describe("the cart confirmation's invite block", () => {
  it.each(LOCALES)("%s: a team and a pair each get a block with their own link and their own wording", async (locale) => {
    const dict = await dictOf(locale);
    const out = registrationTemplate(base({ invites: INVITES }), dict, locale);
    let checked = 0;
    // Both parts carry the link: the html escapes the `&` of a pair link, the text part carries it verbatim.
    expect(out.html, `${locale} html: team link`).toContain(TEAM_URL);
    expect(out.html, `${locale} html: pair link, ampersand escaped`).toContain(PAIR_URL.replace("&", "&amp;"));
    expect(out.html, `${locale} html: no raw ampersand in the pair link`).not.toContain("&player_id=");
    expect(out.text, `${locale} text: team link`).toContain(TEAM_URL);
    expect(out.text, `${locale} text: pair link verbatim`).toContain(PAIR_URL);
    checked += 4;
    // The wording is the dictionary's own, one set for a team and a different one for a pair.
    const titleTeam = t(dict, "registration.invitePanelTitleTeam", { displayName: TEAM, divisionName: DIVISION });
    const titlePair = t(dict, "registration.invitePanelTitlePair", { displayName: PAIR, divisionName: "Mixed Pairs" });
    const bodyTeam = t(dict, "registration.inviteBodyTeam", { displayName: TEAM, divisionName: DIVISION });
    const bodyPair = t(dict, "registration.inviteBodyPair", { displayName: PAIR, divisionName: "Mixed Pairs" });
    expect(titleTeam, `${locale}: premise - the team and pair titles are different words`).not.toBe(titlePair);
    expect(bodyTeam, `${locale}: premise - the team and pair bodies are different words`).not.toBe(bodyPair);
    for (const piece of [titleTeam, bodyTeam]) {
      expect(out.text, `${locale} text: ${piece}`).toContain(piece);
      checked += 1;
    }
    for (const piece of [titlePair, bodyPair]) {
      expect(out.text, `${locale} text: ${piece}`).toContain(piece);
      checked += 1;
    }
    // Each block's link follows ITS OWN title (a pair's link under the team's title would be the wrong invite).
    expect(out.text.indexOf(titleTeam)).toBeLessThan(out.text.indexOf(TEAM_URL));
    expect(out.text.indexOf(TEAM_URL)).toBeLessThan(out.text.indexOf(titlePair));
    expect(out.text.indexOf(titlePair)).toBeLessThan(out.text.indexOf(PAIR_URL));
    checked += 3;
    for (const part of [out.html, out.text]) expect(part, `${locale}: no raw dictionary token`).not.toMatch(/registration\.(invite|entry)[A-Za-z]+/);
    checked += 2;
    expect(checked, `${locale}: anti-vacuity`).toBe(13);
  });

  it.each(LOCALES)("%s: the invite sits before the view-status button, which stays last", async (locale) => {
    const out = registrationTemplate(base({ invites: INVITES }), await dictOf(locale), locale);
    expect(out.html.indexOf(TEAM_URL)).toBeGreaterThan(-1);
    expect(out.html.indexOf(PAIR_URL.replace("&", "&amp;"))).toBeGreaterThan(-1);
    const statusInHtml = out.html.indexOf(STATUS_URL.replace("&", "&amp;"));
    expect(statusInHtml, `${locale} html: the view button is present`).toBeGreaterThan(-1);
    expect(out.html.indexOf(TEAM_URL), `${locale} html`).toBeLessThan(statusInHtml);
    expect(out.text.indexOf(PAIR_URL), `${locale} text`).toBeLessThan(out.text.indexOf(STATUS_URL));
  });

  it.each(LOCALES)("%s: no invites (absent, or empty) leaves the mail exactly as it was and carries no join link", async (locale) => {
    const dict = await dictOf(locale);
    const without = registrationTemplate(base(), dict, locale);
    const empty = registrationTemplate(base({ invites: [] }), dict, locale);
    const withInvites = registrationTemplate(base({ invites: INVITES }), dict, locale);
    expect(empty, `${locale}: an empty list is the absent list`).toEqual(without);
    for (const part of [without.html, without.text]) expect(part, `${locale}: no join link`).not.toMatch(/join_code|\/register\/join/);
    expect(withInvites.html, `${locale}: premise - the invite block changes the mail`).not.toBe(without.html);
    expect(withInvites.text).not.toBe(without.text);
  });

  it("a single-entry team cart says it too, and an html-special team name is escaped once", async () => {
    const dict = await dictOf("en");
    const out = registrationTemplate(
      base({
        entries: [{ displayName: "A & B <Rovers>", divisionName: DIVISION, status: "pending", feeCents: 0, approval: "auto" }],
        invites: [{ displayName: "A & B <Rovers>", divisionName: DIVISION, kind: "team", url: TEAM_URL }],
      }),
      dict,
      "en",
    );
    expect(out.html).toContain("Invite your teammates to A &amp; B &lt;Rovers&gt;");
    expect(out.html).not.toContain("<Rovers>");
    expect(out.html, "escaped once, not twice").not.toContain("&amp;amp;");
    expect(out.text).toContain("Invite your teammates to A & B <Rovers>");
  });

  it("English wording, typed from the product's own copy so a dictionary drift is seen", async () => {
    const dict = await dictOf("en");
    const out = registrationTemplate(base({ invites: INVITES }), dict, "en");
    expect(out.text).toContain(`Invite your teammates to ${TEAM}`);
    expect(out.text).toContain(`Invite your partner to ${PAIR}`);
    expect(out.text).toContain(`so they can join ${TEAM} (${DIVISION})`);
    expect(out.text).toContain(`confirm their place in ${PAIR} (Mixed Pairs)`);
  });
});
