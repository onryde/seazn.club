// W2c Task 22 carry 3 (batch-6 review, T20-2). The division builder asked
// `(SPORT_RULES[sportKey] ?? []).length > 0` whether to draw the "Match rules"
// section. `SPORT_RULES` is a plain object, so a sport key that is also an
// Object.prototype name answers the INHERITED function: `constructor` has
// `.length` 1, so the section drew for a sport that has no rules at all.
//
// Since Match Day C9 the rules live on the builder's Division rules step, which
// is the DivisionRulesStrip (draft mode). The builder mounts it only for a sport
// the engine ships (`moduleFor`, an own-key lookup over `builtinModules`). Pinned
// for every Object.prototype name LISTED as a sport (so the builder holds a
// `sport` for it and only the module lookup can refuse), with the positive pair
// beside it (every sport with curated fields mounts the strip on its own key),
// because a "never draws" test passes on a section that was deleted. The whole
// builder must also render for such a key: the Review step names the sport
// (`sportLabel`, which had the same `in` hazard).
//
// `@/lib/venue` is stubbed: its own `VENUE_BY_SPORT[key]` read has the same
// hazard (`venueLabel("constructor")` throws "n.charAt is not a function"), and
// it is not what this file pins.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DivisionRulesStrip } from "@/components/v2/rules/division-rules-strip";
import { SPORT_RULES } from "@/lib/match-rules";

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

/** The builder with `key` LISTED beside football, then the sport select driven to it: the production path
 *  `selectSport(e.target.value)` that sets `sportKey`. */
function mountOn(key: string) {
  const sports: SportOption[] = [
    { key: "football", name: "Football", variants: [{ key: "score", name: "Score", system: true }] },
    { key, name: key, variants: [{ key: "score", name: "Score", system: true }] },
  ];
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
const strips = (h: ReturnType<typeof mountOn>) => h.tree().filter((e) => e.type === DivisionRulesStrip);

describe("division builder — the Division rules step follows OWN sport keys only", () => {
  it("a sport that declares fields mounts the rules strip, on its own key (the positive pair)", () => {
    const declared = Object.keys(SPORT_RULES).filter((k) => SPORT_RULES[k]!.length > 0);
    expect(declared.length, "the registry declares curated fields for at least one sport").toBeGreaterThan(0);
    let mounted = 0;
    for (const key of declared) {
      const found = strips(mountOn(key));
      expect(found.map((e) => propsOf(e).sportKey), `${key} has curated fields, so the strip mounts`).toEqual([key]);
      mounted++;
    }
    expect(mounted).toBe(declared.length);
  });

  it("a key that is only an Object.prototype name mounts no strip, and the builder still renders (Review names it)", () => {
    const names = Object.getOwnPropertyNames(Object.prototype);
    // Assumption guard: the sweep is about names SPORT_RULES does not own.
    for (const name of names) expect(Object.hasOwn(SPORT_RULES, name), `${name} must not be a sport`).toBe(false);
    // Anti-vacuity: the names include one with an inherited .length above 0 (the case the old read got wrong).
    const witnesses = names.filter((n) => typeof (SPORT_RULES as Record<string, unknown>)[n] === "function" && ((SPORT_RULES as Record<string, unknown>)[n] as { length: number }).length > 0);
    expect(witnesses, "at least `constructor` answers a function with .length > 0").toContain("constructor");
    expect(names.length).toBeGreaterThanOrEqual(10);
    let checked = 0;
    for (const name of names) {
      const h = mountOn(name);
      expect(strips(h), `${name} is not a sport`).toEqual([]);
      expect(h.text(), `${name}: the Review row names it`).toContain(name.charAt(0).toUpperCase() + name.slice(1));
      checked++;
    }
    expect(checked).toBe(names.length);
  });
});
