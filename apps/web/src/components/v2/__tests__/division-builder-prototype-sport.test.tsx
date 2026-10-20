// W2c Task 22 carry 3 (batch-6 review, T20-2). The division builder asked
// `(SPORT_RULES[sportKey] ?? []).length > 0` whether to draw the "Match rules"
// section. `SPORT_RULES` is a plain object, so a sport key that is also an
// Object.prototype name answers the INHERITED function: `constructor` has
// `.length` 1, so the section drew for a sport that has no rules at all.
// `rulesFor` (lib/match-rules) reads own keys only. Pinned for every
// Object.prototype name, with the positive pair beside it (a real sport still
// draws the section), because a "never draws" test passes on a section that
// was deleted.
//
// `@/lib/venue` is stubbed: its own `VENUE_BY_SPORT[key]` read has the same
// hazard (`venueLabel("constructor")` throws "n.charAt is not a function" at
// the builder's line 503, before the Match rules section is reached), and it is
// not what this file pins. Routed to the controller as a finding, not fixed
// here (Task 22 changes no product code beyond rulesFor and one copy period).
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { SPORT_RULES } from "@/lib/match-rules";
import uiEn from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

vi.mock("@/lib/venue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/venue")>()),
  venueNoun: () => "court",
  venueLabel: () => "Court",
}));

const HEADING = uiEn["wizard.matchRules"];

/** The builder with only REAL sports listed (the list never holds a prototype name), then the sport select driven to `key`:
 *  the production path `selectSport(e.target.value)` that sets `sportKey`. */
function mountOn(key: string) {
  const sports: SportOption[] = [{ key: "football", name: "Football", variants: [{ key: "score", name: "Score", system: true }] }];
  const h = renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
  });
  const select = h.tree().find((e) => e.type === "select" && propsOf(e).value === "football");
  if (!select) throw new Error("no sport select found");
  (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: key } });
  return h;
}

describe("division builder — the Match rules section follows OWN sport keys only", () => {
  it("a sport that declares fields draws the section (the positive pair)", () => {
    const declared = Object.keys(SPORT_RULES).filter((k) => SPORT_RULES[k]!.length > 0);
    expect(declared.length, "the registry declares curated fields for at least one sport").toBeGreaterThan(0);
    for (const key of declared) {
      expect(mountOn(key).text(), `${key} has curated fields, so the section draws`).toContain(HEADING);
    }
  });

  it("a key that is only an Object.prototype name draws no section, whatever its inherited .length", () => {
    const names = Object.getOwnPropertyNames(Object.prototype);
    // Assumption guard: the sweep is about names SPORT_RULES does not own.
    for (const name of names) expect(Object.hasOwn(SPORT_RULES, name), `${name} must not be a sport`).toBe(false);
    // Anti-vacuity: the names include one with an inherited .length above 0 (the case the old read got wrong).
    const witnesses = names.filter((n) => typeof (SPORT_RULES as Record<string, unknown>)[n] === "function" && ((SPORT_RULES as Record<string, unknown>)[n] as { length: number }).length > 0);
    expect(witnesses, "at least `constructor` answers a function with .length > 0").toContain("constructor");
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      expect(mountOn(name).text(), `${name} is not a sport`).not.toContain(HEADING);
    }
  });
});
