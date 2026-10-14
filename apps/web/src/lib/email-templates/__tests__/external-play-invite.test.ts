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
});
