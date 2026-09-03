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
//
// `data-category` lives on the <label>, NOT on the radio, and one of the
// tests below exists purely to keep it there. The radio is `sr-only`
// (clipped to a 1px box), so a real Playwright click on it is either "not
// visible" or intercepted by the enclosing label — and this suite runs in
// `environment: "node"` with no DOM, so nothing here can observe either
// failure. Found in review before the bench depended on it; the guard is
// what stops it coming back.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
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

/** Every element carrying a `data-category`, whatever its type. Deliberately
 *  NOT filtered to <label> — the point of several assertions below is to
 *  discover WHICH element carries the hook, so filtering by the expected
 *  answer would make them tautological. */
function categoryHooks(h: ReturnType<typeof mount>) {
  return h.tree().filter((e) => propsOf(e)["data-category"] !== undefined);
}

function categoryRadios(h: ReturnType<typeof mount>) {
  return h
    .tree()
    .filter((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-category");
}

describe("DivisionBuilder — division-builder-category bench hook", () => {
  it('the category group\'s fieldset carries data-testid="division-builder-category"', () => {
    const h = mount();
    const fieldset = h.tree().find((e) => e.type === "fieldset");
    expect(fieldset, "no <fieldset> in the tree").toBeTruthy();
    expect(propsOf(fieldset!)["data-testid"]).toBe("division-builder-category");
  });

  it("data-category appears once per category (open/mens/womens/mixed), no duplicates", () => {
    const h = mount();
    const values = categoryHooks(h)
      .map((e) => propsOf(e)["data-category"])
      .sort();
    expect(values).toEqual(["mens", "mixed", "open", "womens"]);
  });

  it("data-category is on the <label> and NOT on the sr-only radio — a click on the radio would not land", () => {
    const h = mount();

    // The hook must be on the clickable element.
    for (const el of categoryHooks(h)) {
      expect(el.type, `data-category="${propsOf(el)["data-category"]}" is on <${String(el.type)}>, not <label>`).toBe(
        "label",
      );
    }

    // And the radios must NOT carry it. Without this half, moving the
    // attribute back onto the input would leave the assertion above still
    // true (both would carry it) while breaking every driver click AND
    // making the selector match two elements — a Playwright strict-mode
    // violation that nothing in a DOM-less suite can see.
    for (const radio of categoryRadios(h)) {
      expect(propsOf(radio)["data-category"], "the sr-only radio must not carry the hook").toBeUndefined();
    }

    // The reason the hook is on the label rather than the input. If this
    // ever stops being sr-only, the trade-off above should be revisited
    // rather than silently inherited.
    for (const radio of categoryRadios(h)) {
      expect(String(propsOf(radio).className ?? "")).toContain("sr-only");
    }
  });

  it("each hooked label wraps exactly one radio, and its value matches the label's data-category", () => {
    const h = mount();
    for (const label of categoryHooks(h)) {
      const key = propsOf(label)["data-category"];
      const inner = walk(label).filter(
        (e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).name === "division-category",
      );
      expect(inner, `label[data-category="${key}"] wraps ${inner.length} radios, expected exactly 1`).toHaveLength(1);
      expect(propsOf(inner[0]!).value, `radio under label[data-category="${key}"] carries the wrong value`).toBe(key);
    }
  });

  it("the checked radio sits under the label whose data-category matches the selection (default: open)", () => {
    const h = mount();
    const checkedKey = (hh: ReturnType<typeof mount>) =>
      categoryHooks(hh).find(
        (label) =>
          walk(label)
            .filter((e) => e.type === "input" && propsOf(e).type === "radio")
            .some((r) => propsOf(r).checked === true),
      );

    expect(propsOf(checkedKey(h)!)["data-category"]).toBe("open");

    // Select "mens" the way a driver would — click the LABEL, which fires the
    // enclosed radio's onChange. Proves data-category tracks the LIVE
    // selection, not a static label.
    const mensLabel = categoryHooks(h).find((e) => propsOf(e)["data-category"] === "mens");
    expect(mensLabel, "no mens label found").toBeTruthy();
    const mensRadio = walk(mensLabel!).find((e) => e.type === "input" && propsOf(e).type === "radio");
    (propsOf(mensRadio!).onChange as () => void)();

    expect(propsOf(checkedKey(h)!)["data-category"]).toBe("mens");
  });
});
