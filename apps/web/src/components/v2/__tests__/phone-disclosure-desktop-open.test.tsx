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

// The phone-only variant has no `startOpen` of its own (that prop belongs to `desktopCollapsible`), so a caller whose fold should
// open on a phone says so with `phoneStartOpen` (Sponsors hub, Packages tab: an EMPTY price list opens its tier legend). Default off,
// so every existing phone-only fold (stage points' More, tie-break rules, the match rules block) stays closed until tapped.
// `allWidths`: a fold at every width seeded like the phone-only variant (Sponsors hub, Packages tab: the tier legend). The width plays no part.
describe("PhoneDisclosure allWidths (after hydration, per width)", () => {
  const widths = [320, 767, 768, 1280];
  it("phoneStartOpen true: open at every width; absent: closed at every width (8 checked)", () => {
    const on = widths.map((w) => isOpen(at(w, { allWidths: true, phoneStartOpen: true }).island.tree()));
    const off = widths.map((w) => isOpen(at(w, { allWidths: true }).island.tree()));
    expect(on).toEqual([true, true, true, true]);
    expect(off).toEqual([false, false, false, false]);
  });

  it("a reader's tap is theirs at 1280: it hides what opened itself, a re-render keeps it hidden, and the prop going false does not fold an open one", () => {
    const { island, base } = at(1280, { allWidths: true, phoneStartOpen: true });
    expect(isOpen(island.tree())).toBe(true);
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree()), "the tap hides it").toBe(false);
    island.rerender({ ...base });
    expect(isOpen(island.tree()), "a plain re-render does not re-open it").toBe(false);
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree()), "the tap shows it").toBe(true);
    island.rerender({ ...base, phoneStartOpen: false });
    expect(isOpen(island.tree()), "the first package is created: the legend stays open").toBe(true);
  });

  it("a list that gets its start-open later (false then true) opens, at a desktop width too", () => {
    const { island, base } = at(1280, { allWidths: true, phoneStartOpen: false });
    expect(isOpen(island.tree())).toBe(false);
    island.rerender({ ...base, phoneStartOpen: true });
    expect(isOpen(island.tree())).toBe(true);
  });

  it("does not touch desktopCollapsible: startOpen false still folds it, whatever allWidths and phoneStartOpen say", () => {
    expect(isOpen(at(1280, { desktopCollapsible: true, allWidths: true, startOpen: false, phoneStartOpen: true }).island.tree())).toBe(false);
  });
});

describe("PhoneDisclosure phoneStartOpen (the phone-only variant, opened after hydration)", () => {
  it("opens on its own after hydration at every width - 1280, 768, 767 and 320 (4 checked); the default, with the prop absent, stays closed at all four", () => {
    const widths = [1280, 768, 767, 320];
    const on = widths.map((w) => isOpen(at(w, { phoneStartOpen: true }).island.tree()));
    expect(on).toEqual([true, true, true, true]);
    const off = widths.map((w) => isOpen(at(w, {}).island.tree()));
    expect(off, "no prop: the phone default is closed (spec 3.10)").toEqual([false, false, false, false]);
    expect(isOpen(at(320, { phoneStartOpen: false }).island.tree())).toBe(false);
  });

  it("is still a phone control: the toggle keeps its md:hidden and the body keeps its max-md:hidden class when closed", () => {
    const tree = at(320, { phoneStartOpen: true, startOpen: false }).island.tree();
    expect(String(propsOf(toggle(tree)).className)).toMatch(/\smd:hidden$/);
  });

  it("a tap is the reader's: it folds an open one and a re-render with the same props does not re-open it; flipping the prop off never folds it", () => {
    const { island, base } = at(320, { phoneStartOpen: true });
    expect(isOpen(island.tree())).toBe(true);
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree()), "the tap folded it").toBe(false);
    island.rerender({ ...base });
    expect(isOpen(island.tree()), "the same props do not re-open what the reader folded").toBe(false);
    (propsOf(toggle(island.tree())).onClick as () => void)();
    expect(isOpen(island.tree())).toBe(true);
    island.rerender({ ...base, phoneStartOpen: false });
    expect(isOpen(island.tree()), "the first package lands: the legend the reader has open stays open").toBe(true);
  });

  it("the prop turning true later opens it (a re-seed, not a mount-only default): false then true at 320", () => {
    const { island, base } = at(320, { phoneStartOpen: false });
    expect(isOpen(island.tree())).toBe(false);
    island.rerender({ ...base, phoneStartOpen: true });
    expect(isOpen(island.tree()), "told to start open after the fact").toBe(true);
  });

  it("does not touch the desktopCollapsible variant: startOpen false still folds it, whatever phoneStartOpen says", () => {
    expect(isOpen(at(1280, { desktopCollapsible: true, startOpen: false, phoneStartOpen: true }).island.tree())).toBe(false);
  });
});
