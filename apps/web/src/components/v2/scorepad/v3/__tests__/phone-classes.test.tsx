// Spec §3.2–3.8. Node render only: proves WHICH nodes carry the phone classes.
// Effect at real widths: e2e/mobile.spec.ts `expectPhoneComposition`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Scorebug } from "../scorebug";
import type { ScorebugSpec } from "../types";

const t = ((key: string) => key) as unknown as Parameters<typeof Scorebug>[0]["t"];
const spec: ScorebugSpec = {
  phase: "live",
  context: "Best of 3 · Game 1",
  halves: [
    { who: [{ name: "Gallery Badminton Home mtgyvvf39ppg", serving: true }], big: "1", tappable: true, hintKey: "pad.hint.rally", tapEvent: { type: "badminton.rally", payload: { side: "home" } } },
    { who: [{ name: "Gallery Badminton Away mtgyvvf39ppg" }], big: "0", tappable: true, hintKey: "pad.hint.rally", tapEvent: { type: "badminton.rally", payload: { side: "away" } } },
  ],
  strip: [
    { label: "Games", value: "0–0" },
    { label: "Serving", value: "Gallery Badminton Home mtgyvvf39ppg", accent: true },
    { value: "Left service court" },
  ],
} as ScorebugSpec; // if ScorebugSpec needs more fields, add them from types.ts — do not loosen the type

describe("scorebug phone classes", () => {
  const html = renderToStaticMarkup(<Scorebug spec={spec} t={t} />);
  it("both halves drop to px-2 on phones", () => {
    const halves = html.match(/<button[^>]*data-role="v3-scorebug-half"[^>]*>/g) ?? [];
    expect(halves).toHaveLength(2);
    for (const h of halves) expect(h).toMatch(/class="[^"]*\bmax-md:px-2\b/);
  });
  it("the name box clamps to two lines on phones (a pair stays readable)", () => {
    expect(html).toMatch(/class="[^"]*\bline-clamp-6\b[^"]*\bmax-md:line-clamp-2\b/);
  });
  it("the hint is one truncated line on phones", () => {
    expect(html).toMatch(/class="[^"]*\bmax-md:truncate\b[^"]*"[^>]*>pad\.hint\.rally</);
  });
  it("the meta strip is a non-wrapping rail on phones and every item refuses to shrink", () => {
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bmax-md:flex-nowrap\b[^"]*\bmax-md:overflow-x-auto\b/);
    expect((html.match(/max-md:shrink-0/g) ?? []).length).toBe(3); // one per strip item, no more
  });
});
