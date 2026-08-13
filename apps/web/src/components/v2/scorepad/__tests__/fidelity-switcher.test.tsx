// fidelity-switcher.tsx (S10/#419 W8, chassis item 3): tier picker per
// fixture. Upgrade applies immediately (never touches score state — there is
// nothing here TO delete, band is a pure view/recording-depth concern);
// downgrade requires a confirm step first and never calls `onChange` on
// cancel. A band needing an entitlement the org lacks renders locked and is
// inert to a click, not merely visually dimmed.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { FidelitySwitcher, type FidelitySwitcherProps } from "../fidelity-switcher";

const isType = (type: string) => (el: ReactElement) => el.type === type;
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found");
  return el;
}

function mount(overrides: Partial<FidelitySwitcherProps> = {}) {
  let current = overrides.value ?? 1;
  const calls: number[] = [];
  const props: FidelitySwitcherProps = {
    value: current,
    onChange: (band) => {
      calls.push(band);
      current = band;
    },
    entitlements: {},
    fidelityEntitlements: {},
    ...overrides,
  };
  const island = renderIsland(FidelitySwitcher, props);
  return { island, calls, get current() { return current; } };
}

function bandButton(tree: ReactElement[], band: number): ReactElement {
  return find(findAll(tree, isType("button")), (b) => propsOf(b)["data-band"] === band);
}

describe("FidelitySwitcher — upgrade applies immediately", () => {
  it("clicking a HIGHER band calls onChange right away, no confirmation step", () => {
    const { island, calls } = mount({ value: 1 });
    (propsOf(bandButton(island.tree(), 3)).onClick as () => void)();
    expect(calls).toEqual([3]);
    expect(island.text()).not.toContain("hides actions above it");
  });
});

describe("FidelitySwitcher — downgrade warns before applying, and never deletes anything", () => {
  it("clicking a LOWER band does NOT call onChange immediately — shows a warning first", () => {
    const { island, calls } = mount({ value: 3 });
    (propsOf(bandButton(island.tree(), 1)).onClick as () => void)();
    expect(calls).toEqual([]);
    expect(island.text().length).toBeGreaterThan(0);
  });

  it("confirming the downgrade calls onChange exactly once, with the requested band", () => {
    const { island, calls } = mount({ value: 3 });
    (propsOf(bandButton(island.tree(), 0)).onClick as () => void)();
    const confirmBtn = find(findAll(island.tree(), isType("button")), (b) => propsOf(b)["data-role"] === "confirm-downgrade");
    (propsOf(confirmBtn).onClick as () => void)();
    expect(calls).toEqual([0]);
  });

  it("cancelling the downgrade NEVER calls onChange, and clears the warning", () => {
    const { island, calls } = mount({ value: 3 });
    (propsOf(bandButton(island.tree(), 1)).onClick as () => void)();
    let tree = island.tree();
    const cancelBtn = find(findAll(tree, isType("button")), (b) => propsOf(b)["data-role"] === "cancel-downgrade");
    (propsOf(cancelBtn).onClick as () => void)();
    expect(calls).toEqual([]);
    tree = island.tree();
    expect(findAll(tree, (b) => propsOf(b)["data-role"] === "confirm-downgrade").length).toBe(0);
  });
});

describe("FidelitySwitcher — a band needing a missing entitlement is locked and inert", () => {
  it("clicking a locked band calls onChange for NEITHER an upgrade nor a downgrade, and shows no confirmation", () => {
    const { island, calls } = mount({
      value: 1,
      fidelityEntitlements: { 3: "scoring.ball_by_ball" },
      entitlements: {}, // org lacks it
    });
    const locked = bandButton(island.tree(), 3);
    expect(propsOf(locked).disabled).toBe(true);
    (propsOf(locked).onClick as (() => void) | undefined)?.();
    expect(calls).toEqual([]);
  });

  it("granting the entitlement unlocks the same band for a normal upgrade click", () => {
    const { island, calls } = mount({
      value: 1,
      fidelityEntitlements: { 3: "scoring.ball_by_ball" },
      entitlements: { "scoring.ball_by_ball": true },
    });
    const unlocked = bandButton(island.tree(), 3);
    expect(unlocked.props && (unlocked.props as { disabled?: boolean }).disabled).not.toBe(true);
    (propsOf(unlocked).onClick as () => void)();
    expect(calls).toEqual([3]);
  });

  it("bands 0 and 1 are never locked, even with zero entitlements granted", () => {
    const { island } = mount({ value: 1, fidelityEntitlements: { 2: "stats.player", 3: "scoring.ball_by_ball" }, entitlements: {} });
    const tree = island.tree();
    expect(propsOf(bandButton(tree, 0)).disabled).not.toBe(true);
    expect(propsOf(bandButton(tree, 1)).disabled).not.toBe(true);
  });
});

describe("FidelitySwitcher — every band renders through the dictionary, never a bare number", () => {
  it("renders four bands with non-numeric text labels", () => {
    const { island } = mount({ value: 0 });
    for (let band = 0; band <= 3; band++) {
      const text = textOf(bandButton(island.tree(), band));
      expect(text.length, `band ${band}`).toBeGreaterThan(0);
      expect(/^\d+$/.test(text.trim()), `band ${band} rendered a bare number: "${text}"`).toBe(false);
    }
  });
});
