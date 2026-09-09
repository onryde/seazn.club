// Fix round 3 (visual-pass-task5.md F3/F4/F5/F6/F8) — the RENDERING half of
// each finding: `overlay-model.ts`'s own unit tests (`overlay-model.test.ts`)
// pin what the model COMPUTES; this file pins what `OverlayBar`/`OverlayBug`
// DO WITH IT, provable under `environment: "node"` the same way
// `discipline-chip-and-hairline.test.tsx` does — neither renderer uses a
// hook, so calling them as plain functions and walking the returned element
// tree is a real, non-mocked render of THIS wave's actual production
// components.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel } from "@/lib/overlay-model";
import type { ReactNode } from "react";

const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "H1" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

function classesOf(el: ReturnType<typeof walk>[number]): string {
  return (propsOf(el).className as string | undefined) ?? "";
}

function childrenOf(el: ReturnType<typeof walk>[number]): ReactNode {
  return propsOf(el).children as ReactNode;
}

describe.each([
  ["OverlayBar", OverlayBar, "ovl-team-cell"],
  ["OverlayBug", OverlayBug, "ovl-bug-row"],
] as const)("%s — void, no verdict drops both sides to ink-50%% (F3)", (_name, Component, rowClass) => {
  it("model.voided adds ovl-voided to both side rows", () => {
    const model: OverlayModel = { ...BASE_MODEL, voided: true };
    const tree = walk(Component({ model, tick: [false, false] }));
    const rows = tree.filter((el) => classesOf(el).includes(rowClass));
    expect(rows.length, "one row per side").toBe(2);
    for (const row of rows) expect(classesOf(row), "every side row must carry the class").toContain("ovl-voided");
  });

  it("the positive/negative pair — voided:false renders no ovl-voided class anywhere", () => {
    const model: OverlayModel = { ...BASE_MODEL, voided: false };
    const tree = walk(Component({ model, tick: [false, false] }));
    for (const el of tree) expect(classesOf(el)).not.toContain("ovl-voided");
  });
});

describe("OverlayBar — the live cell splits into a status word and a context line (F4)", () => {
  it("renders header.context in the live row and header.period as its own .ovl-context line", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false] }));
    const liveRow = tree.find((el) => classesOf(el) === "ovl-live-row");
    expect(liveRow, "the dot + status word row must exist").toBeDefined();
    expect(textOf(liveRow!)).toBe("overlay.header.live");
    const context = tree.find((el) => classesOf(el) === "ovl-context");
    expect(context, "a defined header.period must render its own .ovl-context line").toBeDefined();
    expect(textOf(context!)).toBe("H1");
  });

  it("the positive/negative pair — an undefined header.period renders no .ovl-context line at all", () => {
    const model: OverlayModel = { ...BASE_MODEL, header: { context: "overlay.header.live" } };
    const tree = walk(OverlayBar({ model, tick: [false, false] }));
    expect(tree.find((el) => classesOf(el) === "ovl-context")).toBeUndefined();
  });
});

describe("OverlayBug — the header splits into a status word and a context line (F4)", () => {
  it("renders header.context in .ovl-bug-status and header.period in .ovl-bug-context", () => {
    const tree = walk(OverlayBug({ model: BASE_MODEL, tick: [false, false] }));
    const status = tree.find((el) => classesOf(el) === "ovl-bug-status");
    expect(status).toBeDefined();
    expect(textOf(status!)).toBe("overlay.header.live");
    const context = tree.find((el) => classesOf(el) === "ovl-bug-context");
    expect(context, "a defined header.period must render its own .ovl-bug-context line").toBeDefined();
    expect(textOf(context!)).toBe("H1");
  });

  it("the positive/negative pair — an undefined header.period renders no .ovl-bug-context line", () => {
    const model: OverlayModel = { ...BASE_MODEL, header: { context: "overlay.header.live" } };
    const tree = walk(OverlayBug({ model, tick: [false, false] }));
    expect(tree.find((el) => classesOf(el) === "ovl-bug-context")).toBeUndefined();
  });
});

describe("OverlayBar — per-side set/game cells move into the team cell, not the context line (F5)", () => {
  const WITH_CELLS: OverlayModel = {
    ...BASE_MODEL,
    cellsKind: "sets",
    cells: [
      { key: "1", value: "21–15" },
      { key: "2", value: "18–21" },
      { key: "3", value: "21–19" },
    ],
  };

  it("mounts ovl-cells TWICE — once per side — inside the team cell, never joined in the context line", () => {
    const tree = walk(OverlayBar({ model: WITH_CELLS, tick: [false, false] }));
    const cellGroups = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells");
    expect(cellGroups.length, "one per side, matching the bug's own mount count").toBe(2);
    for (const group of cellGroups) expect(classesOf(group)).toBe("ovl-bar-cells");
    // The old bug: the context line must never carry the raw joined string.
    const context = tree.find((el) => classesOf(el) === "ovl-context");
    expect(textOf(context!), "the context line is the period, never a joined cell string").toBe("H1");
  });

  it("each side shows its OWN half of every cell, and the LAST cell carries the current-cell emphasis class", () => {
    const tree = walk(OverlayBar({ model: WITH_CELLS, tick: [false, false] }));
    const cellGroups = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells");
    const homeCells = walk(childrenOf(cellGroups[0]!));
    const awayCells = walk(childrenOf(cellGroups[1]!));
    const homeValues = homeCells.map((el) => textOf(el));
    const awayValues = awayCells.map((el) => textOf(el));
    expect(homeValues, "home's own half of every cell, in order").toEqual(["21", "18", "21"]);
    expect(awayValues, "away's own half — an ordering-differential case, not the same as home's").toEqual([
      "15",
      "21",
      "19",
    ]);
    expect(homeValues).not.toEqual(awayValues);
    expect(classesOf(homeCells.at(-1)!), "the LAST cell is the current one").toBe("ovl-bar-cell-current");
    expect(classesOf(homeCells[0]!), "an earlier cell is NOT current").not.toBe("ovl-bar-cell-current");
  });

  it("the positive/negative pair — no cells at all mounts no ovl-cells anywhere", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false] }));
    expect(tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells").length).toBe(0);
  });
});

describe("OverlayBar — the between-cells LED count (F6, corrected round 4 — gated on cellsKind, not on the clock)", () => {
  const WITH_CELLS_NO_CLOCK: OverlayModel = {
    ...BASE_MODEL,
    cellsKind: "sets",
    cells: [{ key: "1", value: "1–0" }],
    header: { context: "overlay.header.live" },
  };

  it("renders sides[0].big : sides[1].big in LED when cellsKind is \"sets\" and there is no clock cell", () => {
    const tree = walk(OverlayBar({ model: WITH_CELLS_NO_CLOCK, tick: [false, false] }));
    const led = tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display");
    expect(led, "the between-cells LED element must mount").toBeDefined();
    expect(textOf(led!).replace(/\s+/g, " ")).toBe("2 : 1");
  });

  it("round 4, R2 — a clock cell does NOT suppress the between-cells LED when cellsKind is \"sets\": the gate is the breakdown kind, never the clock", () => {
    const withClock: OverlayModel = {
      ...WITH_CELLS_NO_CLOCK,
      header: { context: "overlay.header.live", clock: "12:41" },
    };
    const tree = walk(OverlayBar({ model: withClock, tick: [false, false] }));
    expect(
      tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display"),
      "the LED still renders — a set-sport carrying a clock is a synthetic case, but it proves the guard reads cellsKind, not header.clock",
    ).toBeDefined();
    expect(tree.find((el) => classesOf(el) === "ovl-clock-cell ovl-display")).toBeDefined();
  });

  it("no between-cells LED when there are no cells at all (cricket/generic, cellsKind \"none\")", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false] }));
    expect(tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display")).toBeUndefined();
  });
});

describe("OverlayBar — an empty meta never occupies the layout (F8)", () => {
  it("a side with no sub renders no .ovl-team-meta span at all", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false] }));
    expect(tree.find((el) => classesOf(el) === "ovl-team-meta")).toBeUndefined();
  });

  it("the positive/negative pair — a side WITH a sub still renders its meta", () => {
    const model: OverlayModel = {
      ...BASE_MODEL,
      sides: [
        { ...BASE_MODEL.sides[0], sub: "12.3" },
        BASE_MODEL.sides[1],
      ],
    };
    const tree = walk(OverlayBar({ model, tick: [false, false] }));
    const meta = tree.find((el) => classesOf(el) === "ovl-team-meta");
    expect(meta).toBeDefined();
    expect(textOf(meta!)).toBe("12.3");
  });
});
