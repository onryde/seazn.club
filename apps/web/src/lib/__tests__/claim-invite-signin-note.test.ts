// The invite email tells the recipient how long the link signs them in (owner decision 2026-10-19, I4):
// "This link signs you in for {hours} hours; after that it still works, you'll just sign in first. Don't forward
// it." (the second clause added at the owner's request 2026-10-19, so a reader opening it on day 4 is not
// surprised by the sign-in). The hours are DERIVED from CLAIM_EMAIL_SIGNIN_MS, never typed, so the copy cannot
// disagree with the rule claimByEmailLink enforces.
// Expected strings come from the shipped dictionaries and the constant, never from the template under test.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAIM_EMAIL_SIGNIN_HOURS, CLAIM_EMAIL_SIGNIN_MS } from "@/lib/claim-signin-window";
import { claimInviteTemplate, officialInviteTemplate } from "@/lib/email-templates";
import { LOCALES } from "@/lib/i18n-constants";
import type { Dict } from "@/lib/i18n";

const HOURS = String(CLAIM_EMAIL_SIGNIN_MS / (60 * 60 * 1000));
const ARGS = { orgName: "Riverside Racquets", personName: "Priya", claimUrl: "https://seazn.club/claim/pc_x" };
const KINDS = [
  { name: "player claim invite", key: "claimInvite.signinNote", build: claimInviteTemplate },
  { name: "officiating claim invite", key: "officialInvite.signinNote", build: officialInviteTemplate },
] as const;

const dictOf = (locale: string): Dict =>
  JSON.parse(readFileSync(path.join(__dirname, `../../dictionaries/${locale}/emails.json`), "utf8")) as Dict;

afterEach(() => vi.resetModules());

describe("the invite emails state the sign-in window", () => {
  it("the derived hours are a whole number (the copy prints an integer)", () => {
    expect(Number.isInteger(CLAIM_EMAIL_SIGNIN_HOURS)).toBe(true);
    expect(String(CLAIM_EMAIL_SIGNIN_HOURS)).toBe(HOURS);
  });

  it("every locale's email carries its own translated line, with the hours from the constant, in html AND text", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      for (const k of KINDS) {
        const line = (dict as Record<string, string>)[k.key];
        expect(line, `${locale} ${k.key}`).toBeTruthy();
        expect(line).toContain("{hours}"); // a placeholder, not a typed number
        if (locale !== "en") expect(line).not.toBe((dictOf("en") as Record<string, string>)[k.key]);
        // Three parts, in every language: the window, what happens after it (a clause set off after the hours),
        // and the don't-forward warning. The old two-sentence line had one full stop after the hours; the new
        // one carries the "after that" clause BEFORE it, so the {hours} placeholder is followed by a ';' and
        // then a further sentence.
        expect(line!.slice(line!.indexOf("{hours}")), `${locale} ${k.key}: window, after-window clause, warning`).toMatch(
          /;[^.;]+\.\s+\S[^.]*\.$/,
        );
        const sentence = line!.replace("{hours}", HOURS);
        const mail = k.build(ARGS, dict);
        expect(mail.html, `${locale} ${k.name} html`).toContain(sentence);
        expect(mail.text, `${locale} ${k.name} text`).toContain(sentence);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * KINDS.length);
  });

  it("the English copy is the sentence the owner asked for", () => {
    const en = dictOf("en") as Record<string, string>;
    for (const k of KINDS) {
      expect(en[k.key]!.replace("{hours}", HOURS)).toBe(
        `This link signs you in for ${HOURS} hours; after that it still works, you'll just sign in first. Don't forward it.`,
      );
    }
  });

  it("the hours FOLLOW the constant: with the window set to 48h the mail says 48, not 72", async () => {
    vi.resetModules();
    vi.doMock("@/lib/claim-signin-window", () => ({
      CLAIM_EMAIL_SIGNIN_MS: 48 * 60 * 60 * 1000,
      CLAIM_EMAIL_SIGNIN_HOURS: 48,
      emailSigninOpen: () => true,
    }));
    const { claimInviteTemplate: build } = await import("@/lib/email-templates");
    const mail = build(ARGS, dictOf("en"));
    expect(mail.text).toContain("signs you in for 48 hours");
    expect(mail.text).not.toContain(`for ${HOURS} hours`);
    vi.doUnmock("@/lib/claim-signin-window");
  });
});

describe("the help pages state the same window", () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, "../../../content/help", rel), "utf8");
  it.each(["players/invite-to-claim.md", "players/claim-your-profile.md", "scheduling/officials.md"])(
    "%s says the emailed link signs you in for the derived number of hours",
    (rel) => {
      expect(read(rel)).toContain(`${HOURS} hours`);
    },
  );
});
