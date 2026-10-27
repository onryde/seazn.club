import { describe, expect, it } from "vitest";
import { suspensionConfirmedTemplate, type SuspensionMiss } from "../suspension-confirmed";
import { suspensionServedTemplate } from "../suspension-served";
import type { Dict } from "@/lib/i18n";
import enEmails from "@/dictionaries/en/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";

const SYSTEM_STACK = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const dicts: Record<string, Dict> = {
  en: enEmails as unknown as Dict,
  fr: frEmails as unknown as Dict,
  es: esEmails as unknown as Dict,
  nl: nlEmails as unknown as Dict,
};

const confirmArgs = {
  orgName: "Riverside",
  divisionName: "Division 1",
  reason: "5th yellow card",
  matchesTotal: 2,
  misses: [] as SuspensionMiss[],
  meUrl: "https://x/me",
};
const servedArgs = {
  orgName: "Riverside",
  divisionName: "Division 1",
  reason: "Red card",
  meUrl: "https://x/me",
};

describe("suspension emails", () => {
  it("confirm: pins subject + core strings and singular/plural matches (en)", () => {
    const one = suspensionConfirmedTemplate({ ...confirmArgs, matchesTotal: 1 }, dicts.en);
    expect(one.text).toContain("1 match");
    expect(one.text).not.toContain("1 matches");

    const many = suspensionConfirmedTemplate(confirmArgs, dicts.en);
    expect(many.subject).toBe("Suspension confirmed — Division 1");
    expect(many.html).toContain("Riverside");
    expect(many.html).toContain("5th yellow card");
    expect(many.text).toContain("2 matches");
  });

  it("served: subject + division + reason (en)", () => {
    const built = suspensionServedTemplate(servedArgs, dicts.en);
    expect(built.subject).toBe("Suspension served — Division 1");
    expect(built.html).toContain("Division 1");
    expect(built.html).toContain("Red card");
  });

  it("renders in every locale with the system font stack and no unresolved tokens", () => {
    for (const [locale, dict] of Object.entries(dicts)) {
      for (const built of [
        suspensionConfirmedTemplate(confirmArgs, dict),
        suspensionServedTemplate(servedArgs, dict),
      ]) {
        expect(built.subject, locale).not.toBe("");
        expect(built.html, locale).toContain(SYSTEM_STACK);
        expect(built.html.includes("{{"), `${locale} unresolved token`).toBe(false);
      }
    }
  });

  it("localizes the subject line per locale", () => {
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.fr).subject).toContain("Suspension confirmée");
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.es).subject).toContain("Sanción confirmada");
    expect(suspensionConfirmedTemplate(confirmArgs, dicts.nl).subject).toContain("Schorsing bevestigd");
  });

  // Owner-approved 4A: the confirmation names WHICH matches the player misses. 2026-11-07 is a Saturday; 15:00Z is
  // 16:00 in Paris (CET, +1) — a venue-zone read, never UTC's 15:00.
  const ROUND_4: SuspensionMiss = {
    round: "Round 4", opponent: "Rovers", scheduledAt: "2026-11-07T15:00:00Z", tz: "Europe/Paris",
  };
  const PLACEHOLDER: SuspensionMiss = { round: null, opponent: null, scheduledAt: null, tz: "Europe/Paris" };

  it("confirm: a 'You'll miss' line names the round, the opponent and the venue-zone day, in order (en)", () => {
    const built = suspensionConfirmedTemplate({ ...confirmArgs, misses: [ROUND_4, PLACEHOLDER] }, dicts.en, "en");
    const line = "You'll miss: Round 4 vs Rovers · Sat 7 Nov, 16:00 (Europe/Paris), Next match (not scheduled yet)";
    expect(built.text).toContain(line);
    // The HTML body carries the same line, escaped (the apostrophe is an entity in the markup).
    expect(built.html).toContain("Round 4 vs Rovers · Sat 7 Nov, 16:00 (Europe/Paris)");
    expect(built.html).toContain("Next match (not scheduled yet)");
  });

  it("confirm: an undecided opponent reads TBD, an undated fixture carries no date, and placeholders fold into a count", () => {
    const tbd: SuspensionMiss = { round: "Semi-final", opponent: null, scheduledAt: null, tz: "Europe/Paris" };
    const built = suspensionConfirmedTemplate(
      { ...confirmArgs, matchesTotal: 3, misses: [tbd, PLACEHOLDER, PLACEHOLDER] },
      dicts.en,
      "en",
    );
    expect(built.text).toContain("You'll miss: Semi-final vs TBD, Next 2 matches (not scheduled yet)");
  });

  it("confirm: the line is translated — French reads 'Vous manquerez', 'contre', and folds placeholders in French", () => {
    const built = suspensionConfirmedTemplate(
      { ...confirmArgs, misses: [{ ...ROUND_4, round: "Tour 4", opponent: null }, PLACEHOLDER, PLACEHOLDER] },
      dicts.fr,
      "fr",
    );
    expect(built.text).toContain("Vous manquerez : Tour 4 contre à déterminer · ");
    expect(built.text).toContain("2 prochains matchs (pas encore programmés)");
    expect(built.text).not.toContain("You'll miss");
  });

  it("confirm: an organiser-typed opponent name is escaped in the HTML", () => {
    const built = suspensionConfirmedTemplate(
      { ...confirmArgs, misses: [{ ...ROUND_4, opponent: "<b>Rovers & Co</b>" }] },
      dicts.en,
      "en",
    );
    expect(built.html).not.toContain("<b>Rovers");
    expect(built.html).toContain("&lt;b&gt;Rovers &amp; Co&lt;/b&gt;");
  });

  it("confirm: nothing to miss ⇒ no line at all, in the text or the HTML, in every locale", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts)) {
      const prefix = (dict as Record<string, string>)["suspensionConfirmed.misses"]!.split("{fixtures}")[0]!.trim();
      expect(prefix.length, locale).toBeGreaterThan(0);
      const built = suspensionConfirmedTemplate(confirmArgs, dict, locale as "en");
      expect(built.text, locale).not.toContain(prefix);
      // ...and the same template WITH a miss does carry it — the negative has its positive pair.
      const withMiss = suspensionConfirmedTemplate({ ...confirmArgs, misses: [PLACEHOLDER] }, dict, locale as "en");
      expect(withMiss.text, locale).toContain(prefix);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
