// Bench hook (B03r) — the division builder's category control is a radio
// group with no other selector-free hook (`data-testid="division-builder-
// name"` already exists on the name input, line ~560 — this follows that
// file's own convention). Mounts the REAL DivisionBuilder via
// _hook-harness.tsx's renderIsland, same precedent as
// division-builder-archived-slot-note.test.tsx. No `expand` override is
// needed: the eligibility <fieldset> and its radios are rendered directly
// by DivisionBuilder itself (only CSS-hidden via the inactive-tab class,
// never unmounted), not nested inside another opaque function component, so
// plain walk() already reaches them.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

// `useMsg` falls back to the English catalog outside a provider; `useLocale`
// THROWS there (same reasoning as division-builder-archived-slot-note.test.tsx).
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const SPORTS: SportOption[] = [
  { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }] },
];

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
  });
}

describe("DivisionBuilder — division-builder-category bench hook", () => {
  it('the category group\'s fieldset carries data-testid="division-builder-category"', () => {
    const h = mount();
    const fieldset = h.tree().find((e) => e.type === "fieldset");
    expect(fieldset, "no <fieldset> in the tree").toBeTruthy();
    expect(propsOf(fieldset!)["data-testid"]).toBe("division-builder-category");
  });

  it("every category radio carries its own data-category, one per CATEGORIES entry (open/mens/womens/mixed)", () => {
    const h = mount();
    const radios = h
      .tree()
      .filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-category");
    const categories = radios.map((r) => propsOf(r)["data-category"]).sort();
    expect(categories).toEqual(["mens", "mixed", "open", "womens"]);
  });

  it("the checked radio's data-category matches the current selection (default: open)", () => {
    const h = mount();
    const radios = h
      .tree()
      .filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-category");
    const checked = radios.find((r) => propsOf(r).checked === true);
    expect(checked, "no radio is checked").toBeTruthy();
    expect(propsOf(checked!)["data-category"]).toBe("open");

    // Select "mens" the way a driver would (onChange, not internal state) —
    // proves data-category tracks the LIVE selection, not a static label.
    const mensRadio = radios.find((r) => propsOf(r)["data-category"] === "mens");
    expect(mensRadio, "no mens radio found").toBeTruthy();
    (propsOf(mensRadio!).onChange as () => void)();

    const radiosAfter = h
      .tree()
      .filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-category");
    const checkedAfter = radiosAfter.find((r) => propsOf(r).checked === true);
    expect(propsOf(checkedAfter!)["data-category"]).toBe("mens");
  });
});
