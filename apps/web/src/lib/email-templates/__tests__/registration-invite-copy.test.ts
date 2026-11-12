// Polish wave P6: the cart confirmation carries an "Invite your teammates" block, so the captain has the links in the one mail they keep.
// Waves I and K (owner feedback): each link is LABELLED with whose it is ("Dana Whitfield's link", "Link for anyone else") and, in the
// html part, is a real hyperlink on that label instead of a printed URL; the text part keeps the URL on the label's line. A team gets
// one link per teammate still to join plus the general link; a pair its partner's.
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
const DANA_URL = "https://seazn.club/live/acme/spring/register/join?join_code=TEAMCODE1&player_id=99999999-2222-3333-4444-555555555555";
const PAIR_URL = "https://seazn.club/live/acme/spring/register/join?join_code=PAIRCODE2&player_id=11111111-2222-3333-4444-555555555555";
const STATUS_URL = "https://seazn.club/live/acme/spring/register/status?rid=g1&token=tok";

const dictOf = (locale: (typeof LOCALES)[number]) => getDictionary(locale, "emails");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The html hyperlink for `url` whose visible text is `label`: an anchor, its href the escaped url, its text the escaped label. */
const anchorOf = (url: string, label: string) => new RegExp(`<a href="${reEscape(esc(url))}"[^>]*>${reEscape(esc(label))}</a>`);

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
  {
    displayName: TEAM,
    divisionName: DIVISION,
    kind: "team",
    links: [
      { name: "Dana Whitfield", url: DANA_URL },
      { name: null, url: TEAM_URL },
    ],
  },
  { displayName: PAIR, divisionName: "Mixed Pairs", kind: "pair", links: [{ name: "Priya Rao", url: PAIR_URL }] },
];

describe("the cart confirmation's invite block", () => {
  it.each(LOCALES)("%s: every link is labelled with whose it is: a hyperlink on the label in html, the label and its url in text", async (locale) => {
    const dict = await dictOf(locale);
    const out = registrationTemplate(base({ invites: INVITES }), dict, locale);
    const labels: [string, string][] = [
      [DANA_URL, t(dict, "registration.inviteLinkFor", { name: "Dana Whitfield" })],
      [TEAM_URL, t(dict, "registration.inviteLinkAnyone")],
      [PAIR_URL, t(dict, "registration.inviteLinkFor", { name: "Priya Rao" })],
    ];
    expect(new Set(labels.map(([, l]) => l)).size, `${locale}: premise - three different labels`).toBe(3);
    let checked = 0;
    for (const [url, label] of labels) {
      expect(out.html, `${locale} html: ${label} is a hyperlink`).toMatch(anchorOf(url, label));
      expect(out.html, `${locale} html: the url is not printed as text`).not.toContain(`>${esc(url)}<`);
      expect(out.text, `${locale} text: ${label} with its url`).toContain(t(dict, "registration.inviteTextLine", { label, url }));
      checked += 3;
    }
    // The html never carries a raw ampersand of a link: the hrefs are escaped once.
    expect(out.html).not.toContain("&player_id=");
    // The wording is the dictionary's own, one set for a team and a different one for a pair.
    const titleTeam = t(dict, "registration.invitePanelTitleTeam", { displayName: TEAM, divisionName: DIVISION });
    const titlePair = t(dict, "registration.invitePanelTitlePair", { displayName: PAIR, divisionName: "Mixed Pairs" });
    const bodyTeam = t(dict, "registration.inviteBodyTeam", { displayName: TEAM, divisionName: DIVISION });
    const bodyPair = t(dict, "registration.inviteBodyPair", { displayName: PAIR, divisionName: "Mixed Pairs" });
    expect(titleTeam, `${locale}: premise - the team and pair titles are different words`).not.toBe(titlePair);
    expect(bodyTeam, `${locale}: premise - the team and pair bodies are different words`).not.toBe(bodyPair);
    for (const piece of [titleTeam, bodyTeam, titlePair, bodyPair]) {
      expect(out.text, `${locale} text: ${piece}`).toContain(piece);
      checked += 1;
    }
    // Each link sits under ITS OWN entry's title, the teammate's before the general one (a pair's link under the team's title would be
    // the wrong invite).
    // Read by whole lines: the general link is a prefix of the teammate's claim link, so a bare url search would find the wrong one.
    const at = (s: string) => out.text.indexOf(s);
    const [dana, anyone, priya] = labels.map(([url, label]) => t(dict, "registration.inviteTextLine", { label, url }) + "\n");
    expect(at(titleTeam)).toBeLessThan(at(dana!));
    expect(at(dana!)).toBeLessThan(at(anyone!));
    expect(at(anyone!)).toBeLessThan(at(titlePair));
    expect(at(titlePair)).toBeLessThan(at(priya!));
    checked += 4;
    for (const part of [out.html, out.text]) expect(part, `${locale}: no raw dictionary token`).not.toMatch(/registration\.(invite|entry)[A-Za-z]+/);
    checked += 2;
    expect(checked, `${locale}: anti-vacuity`).toBe(19);
  });

  it.each(LOCALES)("%s: the invite sits before the view-status button, which stays last", async (locale) => {
    const out = registrationTemplate(base({ invites: INVITES }), await dictOf(locale), locale);
    const teamInHtml = out.html.indexOf(`href="${esc(TEAM_URL)}"`);
    expect(teamInHtml).toBeGreaterThan(-1);
    const statusInHtml = out.html.indexOf(esc(STATUS_URL));
    expect(statusInHtml, `${locale} html: the view button is present`).toBeGreaterThan(-1);
    expect(teamInHtml, `${locale} html`).toBeLessThan(statusInHtml);
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

  it("an entry with no link left gets no block (an empty links list is nothing to invite to)", async () => {
    const dict = await dictOf("en");
    const without = registrationTemplate(base(), dict, "en");
    const linkless = registrationTemplate(base({ invites: [{ displayName: TEAM, divisionName: DIVISION, kind: "team", links: [] }] }), dict, "en");
    expect(linkless).toEqual(without);
  });

  it("html-special team and person names are escaped once, in the title and in the link label", async () => {
    const dict = await dictOf("en");
    const out = registrationTemplate(
      base({
        entries: [{ displayName: "A & B <Rovers>", divisionName: DIVISION, status: "pending", feeCents: 0, approval: "auto" }],
        invites: [
          { displayName: "A & B <Rovers>", divisionName: DIVISION, kind: "team", links: [{ name: "Jo <O'Neil> & Co", url: DANA_URL }] },
        ],
      }),
      dict,
      "en",
    );
    expect(out.html).toContain("Invite your teammates to A &amp; B &lt;Rovers&gt;");
    expect(out.html).toMatch(anchorOf(DANA_URL, t(dict, "registration.inviteLinkFor", { name: "Jo <O'Neil> & Co" })));
    expect(out.html).not.toContain("<Rovers>");
    expect(out.html).not.toContain("<O'Neil>");
    expect(out.html, "escaped once, not twice").not.toContain("&amp;amp;");
    expect(out.text).toContain("Invite your teammates to A & B <Rovers>");
  });

  it("English wording, typed from the product's own copy so a dictionary drift is seen", async () => {
    const dict = await dictOf("en");
    const out = registrationTemplate(base({ invites: INVITES }), dict, "en");
    expect(out.text).toContain(`Invite your teammates to ${TEAM}`);
    expect(out.text).toContain(`Invite your partner to ${PAIR}`);
    expect(out.text).toContain(`Dana Whitfield's link: ${DANA_URL}`);
    expect(out.text).toContain(`Link for anyone else: ${TEAM_URL}`);
    expect(out.text).toContain(`Priya Rao's link: ${PAIR_URL}`);
    expect(out.html).toMatch(anchorOf(DANA_URL, "Dana Whitfield's link"));
  });
});
