// F8's other half, and the screen it was actually seen on.
//
// A new customer's first screen showed five identical 🏅 tiles, because
// `onboarding-wizard.tsx` and `discovery-cards.tsx` each kept their OWN glyph
// map and the two had drifted (discovery knew Carrom; onboarding did not, and
// neither knew Hockey, Ice Hockey or Tennis). The fix consolidated both onto
// `lib/sport-emoji.ts`.
//
// `sport-emoji.test.ts` pins that consolidation for discovery-cards by
// IDENTITY (`expect(VIA_DISCOVERY).toBe(SPORT_EMOJI)`), but the wizard is a
// component, not a module that re-exports anything, and it had no test
// coverage of any kind: replacing `sportEmoji(s.key)` with an inline two-entry
// map restored the exact F8 defect and survived 967 tests across 301 suites
// (independent mutation campaign G3, 2026-09-21).
//
// Both rows below are PROVENANCE, not value equality — a second literal that
// happens to match today passes a value comparison and drifts again tomorrow,
// which is precisely what happened the first time.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The client component calls `useRouter` for its two buttons; stub it for the
// SSR render, the same way `create-org-form.test.tsx` does.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The shared module, replaced by a sentinel. Nothing else in the tree reads
// it, so a glyph that reaches the markup can only have come through here.
// `vi.hoisted`, because `vi.mock`'s factory is hoisted above every top-level
// const — a plain one reads as "Cannot access 'SENTINEL' before
// initialization", which collects ZERO tests and is easily mistaken for green.
const { SENTINEL } = vi.hoisted(() => ({ SENTINEL: "GLYPH-FROM-THE-SHARED-MAP" }));
vi.mock("@/lib/sport-emoji", () => ({
  SPORT_EMOJI: { generic: SENTINEL },
  sportEmoji: (key: string | null | undefined) => `${SENTINEL}:${key ?? "generic"}`,
}));

import { OnboardingWizard } from "../onboarding-wizard";

/** What the wizard actually lists: the `sports` table, which `sync:sports`
 *  seeds from the engine's modules. The four below are the ones F8 showed a
 *  medal for. */
const SPORTS = [
  { key: "carrom", name: "Carrom" },
  { key: "hockey", name: "Hockey" },
  { key: "icehockey", name: "Ice Hockey" },
  { key: "tennis", name: "Tennis" },
];

describe("the onboarding wizard's sport glyphs come from the shared map", () => {
  it("every tile's glyph is resolved by `lib/sport-emoji`, not by a map of the wizard's own", () => {
    const html = renderToStaticMarkup(<OnboardingWizard sports={SPORTS} orgSlug="riverside" />);

    // The tiles really rendered — without this the absence checks below pass
    // on an empty page.
    for (const s of SPORTS) expect(html, `no tile for ${s.name}`).toContain(s.name);

    // One call through the shared function per tile, each carrying ITS OWN
    // key: a wizard that called `sportEmoji("generic")` for everything (the
    // F8 symptom) would print one repeated glyph, and a wizard that kept its
    // own map would print none of these at all.
    for (const s of SPORTS) {
      expect(html, `${s.key}'s tile did not ask the shared map for its glyph`).toContain(
        `${SENTINEL}:${s.key}`,
      );
    }
    expect([...html.matchAll(new RegExp(SENTINEL, "g"))]).toHaveLength(SPORTS.length);
  });

  it("the wizard's source carries no glyph literal of its own", async () => {
    // The second half of the same fact, from the other side: a re-drifted map
    // would have to spell the glyphs out somewhere. Derived from the shared
    // map's real values (imported past the mock above), so a new sport is
    // covered the day it is added.
    const { SPORT_EMOJI } = await vi.importActual<typeof import("@/lib/sport-emoji")>(
      "@/lib/sport-emoji",
    );
    const glyphs = Object.values(SPORT_EMOJI);
    expect(glyphs.length, "the shared map is empty, so this row proves nothing").toBeGreaterThan(5);

    const src = readFileSync(
      fileURLToPath(new URL("../onboarding-wizard.tsx", import.meta.url)),
      "utf8",
    );
    expect(src, "the wizard no longer imports the shared glyph map").toContain(
      'from "@/lib/sport-emoji"',
    );
    const inlined = glyphs.filter((g) => src.includes(g));
    expect(
      inlined,
      `the onboarding wizard spells out glyphs again (${inlined.join(" ")}) — this is how the two maps drifted`,
    ).toEqual([]);
  });
});
