// Fix round 4 (visual-pass-task5.md, "Round 3 re-drive" — R1/R2/R3/R4), one
// root cause: `cellsOf()` (`@/lib/overlay-model`) has always returned TWO
// different kinds of thing under `OverlayModel.cells` — a set/game breakdown
// for tennis/badminton/tabletennis/volleyball (`_THEMES.md` §3/§4's "sets as
// cells" / "games as cells" rows, WITH a between-cells LED) and a period
// breakdown for football/hockey/icehockey, which §3/§4 give NO cell group
// and NO between-cells LED at all — `score 2 / meta none` plus a separate
// clock cell. Round 3 rendered `model.cells` for every sport (R1 bar, R3
// bug — the score rendered twice) and gated the between-cells LED on
// `!model.header.clock` (R2) — wrong whenever a football fold carries no
// clock, which `clockOf`'s `asOf.period === s.phase` requirement makes
// common; the live fixture driven in the visual pass was exactly that state
// and got the sets-won LED cell too (the score rendered THREE times). R4 is
// the bug's own unconditional `.ovl-bug-meta` span, F8's twin left unfixed.
//
// `OverlayModel.cellsKind` ("sets" | "periods" | "none") is the fix: the
// discriminator `cellsOf` always knew and was throwing away. These tests
// construct models directly (same pattern as `decided-void-and-cells.test.
// tsx`) so a renderer-gate mutant is caught here independently of
// `overlay-model.test.ts`'s own `cellsOf`-kind assertions (badminton →
// "sets", football → "periods") — mutating per surface, not per test.
import { describe, expect, it } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import { nameLadder, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";

/** Fix round 5 — both themes now resolve the brand wordmark through `msg`
 *  (`overlay.brand`, I5). Returning the key keeps every assertion below about
 *  the CELL GATES, not about copy. */
const keyMsg: OverlayMsg = (key) => key;

function classesOf(el: ReturnType<typeof walk>[number]): string {
  return (propsOf(el).className as string | undefined) ?? "";
}

const SIDES_PERIOD: OverlayModel["sides"] = [
  { short: "RED", name: "Redbridge United", ladder: nameLadder({ id: "x", name: "Redbridge United" }), big: "1", led: false, serving: false },
  { short: "BLU", name: "Blue Harbour", ladder: nameLadder({ id: "x", name: "Blue Harbour" }), big: "0", led: false, serving: false },
];

/** A period-kernel sport (football) live, mid-match, WITH a period cell
 *  already in `cells` (as `cellsOf` genuinely produces for this kind — the
 *  fix does not stop computing it, only stops rendering it) — proves the
 *  renderers gate on `cellsKind`, never on `cells.length` alone. */
const periodModel = (clock?: string): OverlayModel => ({
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "H1", ...(clock ? { clock } : {}) },
  sides: SIDES_PERIOD,
  cellsKind: "periods",
  cells: [{ key: "H1", value: "1–0" }],
  detail: [],
});

const SIDES_SET: OverlayModel["sides"] = [
  { short: "MIL", name: "Milton Keynes Rovers", ladder: nameLadder({ id: "x", name: "Milton Keynes Rovers" }), big: "21", led: false, serving: true },
  { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "x", name: "Northbridge Athletic" }), big: "18", led: true, serving: false },
];

/** A set-kernel sport (badminton/volleyball family) live, mid-match, no
 *  clock — the positive control the brief asks for: this kind must still
 *  render both the cell group and the between-cells LED. */
const setModel: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "overlay.header.game(n=2)" },
  sides: SIDES_SET,
  cellsKind: "sets",
  cells: [{ key: "1", value: "21–15" }],
  detail: [],
};

describe.each([
  ["OverlayBar", OverlayBar, "ovl-bar-cells"],
  ["OverlayBug", OverlayBug, "ovl-bug-cells"],
] as const)("%s — cellsKind \"periods\" renders no cell group (R1 bar / R3 bug)", (_name, Component, cellsClass) => {
  it("no clock at all — the EXACT state that defeated the round-3 guard (R2)", () => {
    const tree = walk(Component({ model: periodModel(), tick: [false, false], msg: keyMsg }));
    const groups = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells");
    expect(groups.length, "no per-period cell group anywhere").toBe(0);
    for (const el of tree) expect(classesOf(el)).not.toContain(cellsClass);
  });

  it("clock present — still no cell group (the gate is the kind, not the clock's absence)", () => {
    const tree = walk(Component({ model: periodModel("12:41"), tick: [false, false], msg: keyMsg }));
    expect(tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells").length).toBe(0);
  });

  it("the positive/negative pair — cellsKind \"sets\" still mounts the cell group", () => {
    const tree = walk(Component({ model: setModel, tick: [false, false], msg: keyMsg }));
    const groups = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells");
    expect(groups.length, "one per side").toBe(2);
  });
});

describe("OverlayBar — the between-cells LED is gated on cellsKind, never on header.clock (R2)", () => {
  it("cellsKind \"periods\", no clock — no LED (this is the regression case: three copies of the score, live)", () => {
    const tree = walk(OverlayBar({ model: periodModel(), tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display")).toBeUndefined();
  });

  it("cellsKind \"periods\", WITH a clock — still no LED, and the clock cell renders instead", () => {
    const tree = walk(OverlayBar({ model: periodModel("12:41"), tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display")).toBeUndefined();
    expect(tree.find((el) => classesOf(el) === "ovl-clock-cell ovl-display")).toBeDefined();
  });

  it("the positive/negative pair — cellsKind \"sets\" renders the LED with the sides' scores", () => {
    const tree = walk(OverlayBar({ model: setModel, tick: [false, false], msg: keyMsg }));
    const led = tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display");
    expect(led).toBeDefined();
  });
});

describe("OverlayBug — an empty meta never occupies the layout (R4, F8's twin, unfixed in round 3)", () => {
  it("a side with no sub renders no .ovl-bug-meta span at all", () => {
    const tree = walk(OverlayBug({ model: periodModel(), tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el) === "ovl-bug-meta")).toBeUndefined();
  });

  it("the positive/negative pair — a side WITH a sub still renders its meta", () => {
    const model: OverlayModel = {
      ...periodModel(),
      sides: [{ ...SIDES_PERIOD[0], sub: "12.3" }, SIDES_PERIOD[1]],
    };
    const tree = walk(OverlayBug({ model, tick: [false, false], msg: keyMsg }));
    const meta = tree.find((el) => classesOf(el) === "ovl-bug-meta");
    expect(meta).toBeDefined();
  });
});
