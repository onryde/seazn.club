// Truth-in-copy for the help page's section about the register form's "I'm one of the players" tick box
// (registration/open-registration.md, "Linking an entry to an account"). The section names the tick box and the follow-up question
// on a team entry in bold, and both are dictionary strings the form draws (step-who.tsx, entry-details.tsx). The tick box's words
// changed once already (B2 T9 retired "I'm registering myself") and the page kept the old ones behind a green suite, so the page's
// bold labels are checked against the English dictionary's own values, never typed here.
// Sport: not applicable (registration is sport-agnostic).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { helpArticleBySlug } from "./_help-copy";

const EN = en as Record<string, string>;
const SLUG = "registration/open-registration";
const HEADING = "## Linking an entry to an account";
/** The two controls this section talks about, by dictionary key. */
const NAMED_KEYS = ["register.who.playing.title", "register.self.rosterLabel"] as const;

/** The section, from its heading to the next one. */
function section(): string {
  const md = helpArticleBySlug(SLUG);
  const start = md.indexOf(HEADING);
  expect(start, "the section exists").toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next === -1 ? undefined : next);
}

describe("help: the register form's self tick box", () => {
  it("names the tick box and the roster question word for word from the dictionary, in bold", () => {
    const s = section();
    let named = 0;
    for (const key of NAMED_KEYS) {
      const words = EN[key];
      expect(words, `${key} exists in the English dictionary`).toBeTruthy();
      expect(s, `${key}: "${words}"`).toContain(`**${words}**`);
      named++;
    }
    expect(named, "anti-vacuity: every control was checked").toBe(NAMED_KEYS.length);
  });

  it("names no bold phrase that is not a dictionary string (a retired label cannot linger)", () => {
    const s = section();
    const strings = new Set(Object.values(EN));
    const bold = [...s.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
    expect(bold.length, "anti-vacuity: the section names a control at all").toBeGreaterThan(0);
    for (const b of bold) expect(strings.has(b), `"${b}" is a string the form shows`).toBe(true);
    expect(s, "the retired label").not.toContain("I'm registering myself");
  });
});
