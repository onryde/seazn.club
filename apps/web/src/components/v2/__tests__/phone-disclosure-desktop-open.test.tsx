// PhoneDisclosure's desktop-collapsible open/close rule, in sequence (ESLint
// L3). It used to be a `useLayoutEffect` setting `open`; it is now a render-
// phase adjustment keyed on (desktopCollapsible, startOpen, hydrated), with the
// width read through `useMediaQuery`. phone-disclosure.test.tsx pins the
// static server markup; this pins what happens AFTER hydration, per width:
//   - desktopCollapsible + startOpen, wide → opens; narrow → stays closed;
//   - the plain phone-only variant never opens on its own at any width;
//   - startOpen flipping false (the match starts) folds it live, and flipping
//     back true re-opens it at a wide width;
//   - a scorer's own tap is not overridden by a later re-render.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { PhoneDisclosure, type PhoneDisclosureProps } from "../phone-disclosure";

afterEach(() => {
  vi.unstubAllGlobals();
});

function at(width: number, props: Partial<PhoneDisclosureProps>) {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      // The one query the component asks; anything else is a test bug.
      matches: q === "(min-width: 768px)" ? width >= 768 : (() => {
        throw new Error(`unexpected media query ${q}`);
      })(),
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const base: PhoneDisclosureProps = {
    summary: "Zq Home",
    showLabel: "Show lineup",
    hideLabel: "Hide lineup",
    children: null,
    ...props,
  };
  const island = renderIsland(PhoneDisclosure, base, undefined, { hydrate: true });
  return { island, base };
}
const toggle = (tree: ReactElement[]) =>
  tree.find((e) => propsOf(e)["data-role"] === "phone-disclosure-toggle")!;
const isOpen = (tree: ReactElement[]) => propsOf(toggle(tree))["aria-expanded"] as boolean;

describe("PhoneDisclosure after hydration", () => {
  it("desktopCollapsible + startOpen: open at 1280 and 768, closed at 767 and 320", () => {
    const widths = [1280, 768, 767, 320];
    const seen = widths.map((w) => isOpen(at(w, { desktopCollapsible: true, startOpen: true }).island.tree()));
    expect(seen).toEqual([true, true, false, false]);
  });

  it("the phone-only variant (empty case: no desktopCollapsible) never opens on its own, even at 1280", () => {
    expect(isOpen(at(1280, { startOpen: true }).island.tree())).toBe(false);
  });

  it("startOpen false → closed at 1280; the match starting folds an open one live; back to true re-opens", () => {
    expect(isOpen(at(1280, { desktopCollapsible: true, startOpen: false }).island.tree())).toBe(false);

    const { island, base } = at(1280, { desktopCollapsible: true, startOpen: true });
    expect(isOpen(island.tree())).toBe(true);
    island.rerender({ ...base, startOpen: false });
    expect(isOpen(island.tree()), "core.start folds it").toBe(false);
    island.rerender({ ...base, startOpen: true });
    expect(isOpen(island.tree())).toBe(true);
  });

  it("a tap is the scorer's: a re-render with the same props does not re-open what they closed", () => {
    const { island, base } = at(1280, { desktopCollapsible: true, startOpen: true });
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree())).toBe(false);
    island.rerender({ ...base });
    expect(isOpen(island.tree())).toBe(false);
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree())).toBe(true);
  });
});
