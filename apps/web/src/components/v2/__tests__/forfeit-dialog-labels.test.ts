// W2b Task 11 fix round 1 (review I-3): the console's organiser actions and the forfeit dialog's choices are told
// apart by their labels alone. In es the Forfeit opener and Abandon both read "Abandonar…" and sat side by side in the
// match-actions band, so a no-show could be recorded as an abandon. Every locale the app ships (LOCALES, read, never
// retyped) is checked, and each group's labels must differ from one another once case, spacing and a trailing
// ellipsis are set aside ("Abandonar…" and "abandonar" are the same button to a reader).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/lib/i18n-constants";

const dict = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../dictionaries/${locale}/ui.json`, import.meta.url)), "utf8")) as Record<string, string>;

/** Labels a person chooses BETWEEN, so no two in a group may read alike. */
const GROUPS: Record<string, readonly string[]> = {
  // fixture-console.tsx's match-actions band and the Scoring header beside it.
  "the console's actions": ["score.startMatch", "score.finalize", "score.forfeit", "score.abandon"],
  // forfeit-dialog.tsx: Neither and the reason radios.
  "the dialog's choices": ["forfeitDialog.who.both", "forfeitDialog.reason.walkover", "forfeitDialog.reason.retired", "forfeitDialog.reason.disqualified"],
  // forfeit-dialog.tsx: Cancel and every label Confirm can carry.
  "the dialog's buttons": [
    "editor.cancel",
    "forfeitDialog.confirm.choose",
    "forfeitDialog.confirm.walkover",
    "forfeitDialog.confirm.retired",
    "forfeitDialog.confirm.disqualified",
    "forfeitDialog.confirm.doubleWalkover",
    "forfeitDialog.confirm.withdrew",
  ],
};

const reads = (label: string) => label.normalize("NFC").replace(/[….]+\s*$/u, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

describe("the forfeit dialog's labels can be told apart (review I-3)", () => {
  it("in every locale, Forfeit and Abandon never read alike — nor any two labels a person chooses between", () => {
    const collisions: string[] = [];
    let locales = 0;
    let pairs = 0;
    for (const locale of LOCALES) {
      const d = dict(locale);
      for (const [group, keys] of Object.entries(GROUPS)) {
        for (const k of keys) expect(d[k], `${locale} ${k}`).toBeTruthy();
        for (let i = 0; i < keys.length; i++) {
          for (let j = i + 1; j < keys.length; j++) {
            pairs++;
            if (reads(d[keys[i]!]!) === reads(d[keys[j]!]!)) collisions.push(`${locale} ${group}: ${keys[i]} = ${keys[j]} ("${d[keys[i]!]}")`);
          }
        }
      }
      locales++;
    }
    expect(collisions).toEqual([]);
    // Anti-vacuity: every shipped locale, every pair (4 + 6 + 21 per locale).
    expect(locales, `locales checked: ${locales}`).toBe(LOCALES.length);
    expect(locales).toBeGreaterThan(0);
    const perLocale = Object.values(GROUPS).reduce((n, keys) => n + (keys.length * (keys.length - 1)) / 2, 0);
    expect(pairs, `pairs checked: ${pairs}`).toBe(perLocale * LOCALES.length);
  });

  it("the comparison is not blind: an ellipsis, case and spacing do not tell two labels apart", () => {
    expect(reads("Abandonar…")).toBe(reads(" abandonar "));
    expect(reads("Dar por perdido…")).not.toBe(reads("Abandonar…"));
  });
});

// Design audit 1.1: "Who forfeits?" is answered by the parties. The both-sides chip once read "Neither side turned up" —
// "nobody", the opposite of a double walkover. Its label names the parties in every locale (no negation), and the
// no-next-match guidance, which names that chip, quotes its label exactly.
describe("the both-sides chip names the parties (audit 1.1)", () => {
  // The negations each locale would use to say "nobody" — the shape the label must not take.
  const NOBODY: Record<string, RegExp> = { en: /\b(neither|nobody|no one|none)\b/iu, fr: /\b(aucun|personne|ni)\b/iu, es: /\b(ning[uú]n[oa]?|nadie|ni)\b/iu, nl: /\b(geen|niemand|noch)\b/iu };
  it("in every locale: no negation, and the guidance quotes the chip's own label", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = dict(locale);
      const label = d["forfeitDialog.who.both"]!;
      expect(NOBODY[locale], `${locale}: a negation pattern for every shipped locale`).toBeDefined();
      expect(label, `${locale}: "${label}" names the parties`).not.toMatch(NOBODY[locale]!);
      expect(d["forfeitDialog.guidance.noNextMatch"], `${locale}: the guidance quotes "${label}"`).toContain(label);
      checked++;
    }
    expect(checked, `locales checked: ${checked}`).toBe(LOCALES.length);
  });
});

// Design audit 1.2: the reason radios took two forms — "Walkover: didn't turn up", "Retired: stopped during the match"
// and a bare "Disqualified". One form for all three, in every locale: "Noun: gloss" (the locale's own colon spacing),
// and the noun is the one the Confirm button records ("Record retirement"), so the action keeps its name through the
// flow. The Confirm labels are read, never retyped.
describe("the reason radios share one form, and name what Confirm records (audit 1.2)", () => {
  const REASONS = ["walkover", "retired", "disqualified"] as const;
  it("in every locale: each reason is \"Noun: gloss\", and the Confirm label carries the noun", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = dict(locale);
      for (const r of REASONS) {
        const label = d[`forfeitDialog.reason.${r}`]!;
        const m = /^(\S[^:]*?)\s?:\s+(\S.*)$/u.exec(label);
        expect(m, `${locale} ${r}: "${label}" is "Noun: gloss"`).not.toBeNull();
        const noun = m![1]!.toLocaleLowerCase(locale);
        const confirm = d[`forfeitDialog.confirm.${r}`]!.toLocaleLowerCase(locale);
        expect(confirm, `${locale} ${r}: Confirm "${d[`forfeitDialog.confirm.${r}`]}" records the radio's noun "${noun}"`).toContain(noun);
        checked++;
      }
    }
    expect(checked, `reason labels checked: ${checked}`).toBe(LOCALES.length * REASONS.length);
  });
});

// Design audit 1.3: in chess the retirement radio sits beside a dock whose in-game stop is "Resignation"
// (`method.resign`). Chess's radio keeps the house form and noun (audit 1.2 — Confirm still records a retirement) with
// a gloss in the board's own terms, different from the match sports' gloss in every locale. Its noun must differ from
// the dock's resignation word — except where the house retirement noun IS the chess word for resigning (fr "Abandon",
// nl "Opgave"): that is a vocabulary question routed to the owner, listed here and asserted to still collide, so the
// decision has to move this test.
describe("chess's retirement radio cannot be read as a resignation (audit 1.3)", () => {
  const ROUTED_NOUN_COLLISIONS = new Set(["fr", "nl"]);
  it("in every locale: the board's own gloss, the house noun, and a noun apart from the dock's Resignation", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = dict(locale);
      const chess = d["forfeitDialog.reason.retired.boardgame"];
      expect(chess, `${locale}: chess's retirement label`).toBeTruthy();
      const m = /^(\S[^:]*?)\s?:\s+(\S.*)$/u.exec(chess!);
      expect(m, `${locale}: "${chess}" is "Noun: gloss"`).not.toBeNull();
      const house = /^(\S[^:]*?)\s?:\s+(\S.*)$/u.exec(d["forfeitDialog.reason.retired"]!)!;
      expect(m![1], `${locale}: the house noun (Confirm records a retirement)`).toBe(house[1]);
      expect(m![2], `${locale}: the board's gloss, not the match sports'`).not.toBe(house[2]);
      const resign = d["method.resign"]!.toLocaleLowerCase(locale);
      const collides = m![1]!.toLocaleLowerCase(locale) === resign;
      expect(collides, `${locale}: noun "${m![1]}" vs the dock's "${d["method.resign"]}"${ROUTED_NOUN_COLLISIONS.has(locale) ? " (routed: still collides)" : ""}`).toBe(ROUTED_NOUN_COLLISIONS.has(locale));
      checked++;
    }
    expect(checked, `locales checked: ${checked}`).toBe(LOCALES.length);
  });
});
