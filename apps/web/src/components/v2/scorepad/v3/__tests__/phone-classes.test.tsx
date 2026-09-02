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
    // Fix round 1 — deliberately NOT tappable: the static <div data-role=
    // "v3-scorebug-half"> variant (scorebug.tsx:319) is a DIFFERENT render
    // branch from the tappable <button> variant (:309), and with both
    // halves tappable the original fixture's regex could only ever see the
    // button — the div's own max-md:px-2/py-2 was unguarded.
    { who: [{ name: "Gallery Badminton Away mtgyvvf39ppg" }], big: "0" },
  ],
  strip: [
    // Plain branch (scorebug.tsx ≈477) — id lets the test target this exact
    // item rather than asserting on the whole strip.
    { id: "games", label: "Games", value: "0–0" },
    { label: "Serving", value: "Gallery Badminton Home mtgyvvf39ppg", accent: true },
    // `led` branch (≈349) — StripItem.tone: "led" (types.ts).
    { tone: "led", label: "Time", value: "45+2" },
    // Width-reservation branch (≈403-467) — StripItem.reserve (types.ts):
    // every value this slot can take, laid out invisibly to hold the
    // widest one's width. Answered (not `reserved`), so the visible value
    // renders too and the branch is exercised in its normal, non-empty state.
    { label: "Serve", value: "1st serve", reserve: ["1st serve", "2nd serve"] },
  ],
} as ScorebugSpec; // if ScorebugSpec needs more fields, add them from types.ts — do not loosen the type

describe("scorebug phone classes", () => {
  const html = renderToStaticMarkup(<Scorebug spec={spec} t={t} />);

  it("the tappable half (button) drops to px-2 on phones", () => {
    const half = html.match(/<button[^>]*data-role="v3-scorebug-half"[^>]*>/);
    expect(half).not.toBeNull();
    expect(half![0]).toMatch(/class="[^"]*\bmax-md:px-2\b[^"]*\bmax-md:py-2\b/);
  });
  it("the static half (div — non-tappable) drops to px-2 on phones", () => {
    const half = html.match(/<div[^>]*data-role="v3-scorebug-half"[^>]*>/);
    expect(half).not.toBeNull();
    expect(half![0]).toMatch(/class="[^"]*\bmax-md:px-2\b[^"]*\bmax-md:py-2\b/);
  });
  it("the name box clamps to two lines on phones (a pair stays readable)", () => {
    expect(html).toMatch(/class="[^"]*\bline-clamp-6\b[^"]*\bmax-md:line-clamp-2\b/);
  });
  it("the hint is one truncated line on phones", () => {
    expect(html).toMatch(/class="[^"]*\bmax-md:truncate\b[^"]*"[^>]*>pad\.hint\.rally</);
  });
  it("the meta strip is a non-wrapping rail on phones", () => {
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bmax-md:flex-nowrap\b[^"]*\bmax-md:overflow-x-auto\b/);
  });
  it("the plain strip item refuses to shrink and stays single-line", () => {
    const item = html.match(/<span[^>]*data-strip-item-id="games"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:whitespace-nowrap\b/);
  });
  it("the led strip item refuses to shrink and stays single-line", () => {
    const item = html.match(/<span[^>]*data-strip-tone="led"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:whitespace-nowrap\b/);
  });
  it("the reserved (width-reservation) strip item refuses to shrink but is NOT forced nowrap", () => {
    // Controller ruling: this branch's sizers hold the widest candidate's
    // width by wrapping like normal text (scorebug.tsx ≈388-391 — "NO
    // truncate/whitespace-nowrap anywhere in here ... reintroduces exactly
    // the floor min-w-0 just removed"). It must refuse to SHRINK on the
    // phone rail without adopting nowrap, which would defeat the mechanism.
    const item = html.match(/<span[^>]*data-strip-reserve="true"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).not.toMatch(/max-md:whitespace-nowrap/);
  });
});
