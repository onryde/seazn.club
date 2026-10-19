// T19 — the round-open invite, in every shipped locale.
import { describe, expect, it } from "vitest";
import { externalPlayInviteTemplate } from "../external-play-invite";
import enEmails from "@/dictionaries/en/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";
import { LOCALES } from "@/lib/i18n-constants";

const DICTS: Record<(typeof LOCALES)[number], Record<string, string>> = {
  en: enEmails,
  es: esEmails,
  fr: frEmails,
  nl: nlEmails,
};

const ARGS = {
  orgName: "Chess & Co",
  opponentName: "Alice <b>Bold</b>",
  roundNo: 3,
  deadlineLabel: "Wed 1 Oct, 12:30 UTC",
  fixtureUrl: "https://example.test/shared/org/comp/div/fixtures/abc",
};

const KEYS = ["subject", "preheader", "title", "body", "deadline", "button", "footer", "text"] as const;

describe("externalPlayInviteTemplate", () => {
  it("every invite key exists, non-empty, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of KEYS) {
        const v = DICTS[loc][`externalPlayInvite.${k}`];
        expect(typeof v === "string" && v.trim().length > 0, `${loc} externalPlayInvite.${k}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("names the round, opponent and deadline; links the Seazn match room, never Lichess", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const out = externalPlayInviteTemplate(ARGS, DICTS[loc]);
      expect(out.subject, loc).toContain("3");
      expect(out.subject, loc).toContain(ARGS.opponentName); // plain text: raw
      for (const part of [out.html, out.text]) {
        expect(part, loc).toContain(ARGS.fixtureUrl);
        expect(part, loc).not.toContain("lichess.org");
      }
      expect(out.text, loc).toContain(ARGS.deadlineLabel);
      expect(out.html, loc).toContain(ARGS.deadlineLabel);
      // No placeholder left unfilled — and T19 review M2: the mail names ONE
      // time, the deadline. A copy still promising a start ("scheduled for
      // {when}") contradicted it whenever the round opened early or late, so
      // the template no longer passes a start time at all: a locale that
      // still asks for one is left with a raw {when} here.
      expect(out.html, loc).not.toMatch(/\{(opponentName|roundNo|when|deadline|orgName|fixtureUrl)\}/);
      expect(out.text, loc).not.toMatch(/\{[a-zA-Z]+\}/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("escapes the organiser- and player-supplied names in the HTML body", () => {
    for (const loc of LOCALES) {
      const out = externalPlayInviteTemplate(ARGS, DICTS[loc]);
      expect(out.html, loc).not.toContain("<b>Bold</b>");
      expect(out.html, loc).toContain("Alice &lt;b&gt;Bold&lt;/b&gt;");
    }
  });

  // Capacity test 12 (spec §3.2.1, §8.1): a board in a later check-in group is told WHEN its check-in opens.
  const LATER_KEYS = ["bodyLater", "textLater"] as const;
  const OPENS = "Wed 1 Oct, 12:04 UTC";

  it("the later-batch keys exist, non-empty and different from the first-batch ones, in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of LATER_KEYS) {
        const v = DICTS[loc][`externalPlayInvite.${k}`];
        expect(typeof v === "string" && v.trim().length > 0, `${loc} externalPlayInvite.${k}`).toBe(true);
        expect(v, `${loc} ${k} takes the opening time`).toContain("{opens}");
        checked++;
      }
      expect(DICTS[loc]["externalPlayInvite.bodyLater"], loc).not.toBe(DICTS[loc]["externalPlayInvite.body"]);
      expect(DICTS[loc]["externalPlayInvite.textLater"], loc).not.toBe(DICTS[loc]["externalPlayInvite.text"]);
    }
    expect(checked).toBe(LOCALES.length * LATER_KEYS.length);
  });

  it("with an opens label the mail names when check-in opens AND the deadline, in html and text, with no placeholder left", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const out = externalPlayInviteTemplate({ ...ARGS, opensLabel: OPENS }, DICTS[loc]);
      expect(out.html, `${loc} html`).toContain(OPENS);
      expect(out.text, `${loc} text`).toContain(OPENS);
      expect(out.html, `${loc} html deadline`).toContain(ARGS.deadlineLabel);
      expect(out.text, `${loc} text deadline`).toContain(ARGS.deadlineLabel);
      expect(out.html, loc).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(out.text, loc).not.toMatch(/\{[a-zA-Z]+\}/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the pair: without one (batch 0) the mail never names an opening time and uses the original copy", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const out = externalPlayInviteTemplate(ARGS, DICTS[loc]);
      expect(out.html, loc).not.toContain(OPENS);
      expect(out.text, loc).not.toContain(OPENS);
      const base = externalPlayInviteTemplate({ ...ARGS, opensLabel: OPENS }, DICTS[loc]);
      expect(out.text, `${loc}: the later copy differs from the first-batch copy`).not.toBe(base.text);
      // The first-batch text, filled from the dictionary's own template (never the template under test).
      const want = DICTS[loc]["externalPlayInvite.text"]!
        .replaceAll("{opponentName}", ARGS.opponentName)
        .replaceAll("{roundNo}", String(ARGS.roundNo))
        .replaceAll("{deadline}", ARGS.deadlineLabel)
        .replaceAll("{orgName}", ARGS.orgName)
        .replaceAll("{fixtureUrl}", ARGS.fixtureUrl);
      expect(out.text, `${loc}: exactly the first-batch copy`).toBe(want);
      expect(out.html, loc).not.toMatch(/\{opens\}/);
      expect(out.text, loc).not.toMatch(/\{opens\}/);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("the opens label is escaped in the HTML body like the other supplied text", () => {
    for (const loc of LOCALES) {
      const out = externalPlayInviteTemplate({ ...ARGS, opensLabel: "12:04 <i>UTC</i>" }, DICTS[loc]);
      expect(out.html, loc).not.toContain("<i>UTC</i>");
      expect(out.html, loc).toContain("12:04 &lt;i&gt;UTC&lt;/i&gt;");
    }
  });
});
