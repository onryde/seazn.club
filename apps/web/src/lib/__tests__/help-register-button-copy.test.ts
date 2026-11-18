// Truth-in-copy for the help page's sentence about the register form's submit button (registration/registering-for-a-competition.md,
// "Paying, and what happens after"). The page names the button's words: its three ready labels (free, pay-the-organiser, card) and,
// since registration redesign B1, the two phases it shows once pressed. Every one of those is a dictionary string the stepper draws
// (register-stepper.tsx), so a reworded label would leave the page wrong behind a green suite. The expected words are the English
// dictionary's own, never typed here. `{fee}` is filled on the page by an example amount, as the screen shows it ("Enter — £12.00"),
// so the match takes the dictionary string and lets `{fee}` stand for any currency amount of the form £12.00.
// Sport: not applicable (registration is sport-agnostic).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { helpArticleBySlug } from "./_help-copy";

const EN = en as Record<string, string>;
const SLUG = "registration/registering-for-a-competition";
const BUTTON_KEYS = [
  "register.submit.free",
  "register.submit.waitlist",
  "register.submit.fee",
  "register.submit.pay",
  "register.submit.saving",
  "register.submit.openingPayment",
] as const;

/** The dictionary string as a pattern: `{fee}` is an amount such as £12.00, everything else is literal. */
function labelPattern(words: string): RegExp {
  const escaped = words.split("{fee}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("£\\d+\\.\\d{2}")}$`);
}

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
      const pattern = labelPattern(words!);
      const bold = [...s.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
      expect(
        bold.some((b) => pattern.test(b)),
        `${key}: "${words}" appears in bold (with {fee} as an amount)`,
      ).toBe(true);
      named++;
    }
    expect(named, "anti-vacuity: every label was checked").toBe(BUTTON_KEYS.length);
  });

  it("names no other bold button label than those (a retired label cannot linger)", () => {
    const s = section();
    const labels = BUTTON_KEYS.map((k) => labelPattern(EN[k]!));
    const bold = [...s.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
    const claimed = bold.filter((b) => /^(Enter|Pay|Join|Continue|Saving|Opening)\b/.test(b));
    expect(claimed.length, "anti-vacuity: the page names the button at all").toBeGreaterThan(0);
    for (const c of claimed) expect(labels.some((l) => l.test(c)), `"${c}" is one of the button's labels`).toBe(true);
  });
});
