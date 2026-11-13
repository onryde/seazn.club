// Truth-in-copy for the help page's sentence about the register form's submit button (registration/registering-for-a-competition.md,
// "Paying, and what happens after"). The page names the button's words: its three ready labels (free, pay-the-organiser, card) and,
// since registration redesign B1, the two phases it shows once pressed. Every one of those is a dictionary string the stepper draws
// (register-stepper.tsx), so a reworded label would leave the page wrong behind a green suite. The expected words are the English
// dictionary's own, never typed here; `{fee}` stays a placeholder because the page has no amount to show.
// Sport: not applicable (registration is sport-agnostic).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { helpArticleBySlug } from "./_help-copy";

const EN = en as Record<string, string>;
const SLUG = "registration/registering-for-a-competition";
const BUTTON_KEYS = [
  "register.submit.free",
  "register.submit.fee",
  "register.submit.card",
  "register.submit.saving",
  "register.submit.openingPayment",
] as const;

/** The section, from its heading to the next one. */
function section(): string {
  const md = helpArticleBySlug(SLUG);
  const start = md.indexOf("## Paying, and what happens after");
  expect(start, "the section exists").toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

describe("help: the register form's submit button", () => {
  it("names every label the button shows, word for word from the dictionary, in bold", () => {
    const s = section();
    let named = 0;
    for (const key of BUTTON_KEYS) {
      const words = EN[key];
      expect(words, `${key} exists in the English dictionary`).toBeTruthy();
      expect(s, `${key}: "${words}"`).toContain(`**${words}**`);
      named++;
    }
    expect(named, "anti-vacuity: every label was checked").toBe(BUTTON_KEYS.length);
  });

  it("names no other bold button label than those (a retired label cannot linger)", () => {
    const s = section();
    const labels = new Set(BUTTON_KEYS.map((k) => EN[k]));
    const bold = [...s.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
    const claimed = bold.filter((b) => /^(Enter|Continue|Saving|Opening)\b/.test(b));
    expect(claimed.length, "anti-vacuity: the page names the button at all").toBeGreaterThan(0);
    for (const c of claimed) expect(labels.has(c), `"${c}" is one of the button's labels`).toBe(true);
  });
});
