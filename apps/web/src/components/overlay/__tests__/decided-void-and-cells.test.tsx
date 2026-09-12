// Fix round 3 (visual-pass-task5.md F3/F4/F5/F6/F8) — the RENDERING half of
// each finding: `overlay-model.ts`'s own unit tests (`overlay-model.test.ts`)
// pin what the model COMPUTES; this file pins what `OverlayBar`/`OverlayBug`
// DO WITH IT, provable under `environment: "node"` the same way
// `discipline-chip-and-hairline.test.tsx` does — neither renderer uses a
// hook, so calling them as plain functions and walking the returned element
// tree is a real, non-mocked render of THIS wave's actual production
// components.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope, SIM_CONFIGS } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { nameLadder, overlayModel } from "@/lib/overlay-model";
import { OverlayBar } from "../overlay-bar";
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { ReactNode } from "react";

/** Fix round 5 — both themes now resolve the brand wordmark through `msg`
 *  (`overlay.brand`, I5); returning the key keeps this file about the frame. */
const keyMsg: OverlayMsg = (key) => key;

const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live", period: "H1" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", ladder: nameLadder({ id: "x", name: "Milton Keynes Rovers" }), big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "x", name: "Northbridge Athletic" }), big: "1", led: true, serving: false },
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
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    const rows = tree.filter((el) => classesOf(el).includes(rowClass));
    expect(rows.length, "one row per side").toBe(2);
    for (const row of rows) expect(classesOf(row), "every side row must carry the class").toContain("ovl-voided");
  });

  it("the positive/negative pair — voided:false renders no ovl-voided class anywhere", () => {
    const model: OverlayModel = { ...BASE_MODEL, voided: false };
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    for (const el of tree) expect(classesOf(el)).not.toContain("ovl-voided");
  });
});

describe("OverlayBar — the live cell splits into a status word and a context line (F4)", () => {
  it("renders header.context in the live row and header.period as its own .ovl-context line", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    const liveRow = tree.find((el) => classesOf(el) === "ovl-live-row");
    expect(liveRow, "the dot + status word row must exist").toBeDefined();
    expect(textOf(liveRow!)).toBe("overlay.header.live");
    const context = tree.find((el) => classesOf(el) === "ovl-context");
    expect(context, "a defined header.period must render its own .ovl-context line").toBeDefined();
    expect(textOf(context!)).toBe("H1");
  });

  it("the positive/negative pair — an undefined header.period renders no .ovl-context line at all", () => {
    const model: OverlayModel = { ...BASE_MODEL, header: { context: "overlay.header.live" } };
    const tree = walk(OverlayBar({ model, tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el) === "ovl-context")).toBeUndefined();
  });
});

describe("OverlayBug — the header splits into a status word and a context line (F4)", () => {
  it("renders header.context in .ovl-bug-status and header.period in .ovl-bug-context", () => {
    const tree = walk(OverlayBug({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    const status = tree.find((el) => classesOf(el) === "ovl-bug-status");
    expect(status).toBeDefined();
    expect(textOf(status!)).toBe("overlay.header.live");
    const context = tree.find((el) => classesOf(el) === "ovl-bug-context");
    expect(context, "a defined header.period must render its own .ovl-bug-context line").toBeDefined();
    expect(textOf(context!)).toBe("H1");
  });

  it("the positive/negative pair — an undefined header.period renders no .ovl-bug-context line", () => {
    const model: OverlayModel = { ...BASE_MODEL, header: { context: "overlay.header.live" } };
    const tree = walk(OverlayBug({ model, tick: [false, false], msg: keyMsg }));
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
    const tree = walk(OverlayBar({ model: WITH_CELLS, tick: [false, false], msg: keyMsg }));
    const cellGroups = tree.filter((el) => propsOf(el)["data-testid"] === "ovl-cells");
    expect(cellGroups.length, "one per side, matching the bug's own mount count").toBe(2);
    for (const group of cellGroups) expect(classesOf(group)).toBe("ovl-bar-cells");
    // The old bug: the context line must never carry the raw joined string.
    const context = tree.find((el) => classesOf(el) === "ovl-context");
    expect(textOf(context!), "the context line is the period, never a joined cell string").toBe("H1");
  });

  it("each side shows its OWN half of every cell, and the LAST cell carries the current-cell emphasis class", () => {
    const tree = walk(OverlayBar({ model: WITH_CELLS, tick: [false, false], msg: keyMsg }));
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
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
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
    const tree = walk(OverlayBar({ model: WITH_CELLS_NO_CLOCK, tick: [false, false], msg: keyMsg }));
    const led = tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display");
    expect(led, "the between-cells LED element must mount").toBeDefined();
    expect(textOf(led!).replace(/\s+/g, " ")).toBe("2 : 1");
  });

  it("round 4, R2 — a clock cell does NOT suppress the between-cells LED when cellsKind is \"sets\": the gate is the breakdown kind, never the clock", () => {
    const withClock: OverlayModel = {
      ...WITH_CELLS_NO_CLOCK,
      header: { context: "overlay.header.live", clock: "12:41" },
    };
    const tree = walk(OverlayBar({ model: withClock, tick: [false, false], msg: keyMsg }));
    expect(
      tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display"),
      "the LED still renders — a set-sport carrying a clock is a synthetic case, but it proves the guard reads cellsKind, not header.clock",
    ).toBeDefined();
    expect(tree.find((el) => classesOf(el) === "ovl-clock-cell ovl-display")).toBeDefined();
  });

  it("no between-cells LED when there are no cells at all (cricket/generic, cellsKind \"none\")", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
    expect(tree.find((el) => classesOf(el) === "ovl-cells-led ovl-display")).toBeUndefined();
  });
});

describe("OverlayBar — an empty meta never occupies the layout (F8)", () => {
  it("a side with no sub renders no .ovl-team-meta span at all", () => {
    const tree = walk(OverlayBar({ model: BASE_MODEL, tick: [false, false], msg: keyMsg }));
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
    const tree = walk(OverlayBar({ model, tick: [false, false], msg: keyMsg }));
    const meta = tree.find((el) => classesOf(el) === "ovl-team-meta");
    expect(meta).toBeDefined();
    expect(textOf(meta!)).toBe("12.3");
  });
});

// ---------------------------------------------------------------------------
// Fix round 5, I2 — the RENDERING half of §3's decided/void context line.
// `overlay-model.test.ts` pins what the projection computes for each of the
// three cases; this pins that each one reaches the DOM slot §3 draws it in,
// driven end to end through the REAL producer (a real engine fold →
// `overlayModel`) and the REAL consumers, never a hand-written model.
// ---------------------------------------------------------------------------
describe("§3's decided/void context line reaches the rendered second line (I2)", () => {
  const TEMPLATES: DecidedOutcomeTemplates = {
    tie: "TIE",
    plain: "WIN {winner}",
    shootoutPlain: "WIN {winner} SO",
    byMethod: { regulation: "WIN {winner} REG" },
  };
  const SIDES: [{ id: string; name: string }, { id: string; name: string }] = [
    { id: "H", name: "Milton Keynes Rovers" },
    { id: "A", name: "Northbridge Athletic" },
  ];

  /** One real football fold, projected at whatever status/outcome a case needs. */
  function modelFor(status: string, outcome: OverlayLiveData["outcome"]): OverlayModel {
    const mod = builtinModules.find((m) => m.key === "football")!;
    const cfg = mod.configSchema.parse(SIM_CONFIGS["football"] ?? {});
    const events: EventEnvelope[] = (
      [
        ["core.start", {}],
        ["football.goal", { by: "H" }],
        ["football.period", { phase: "HT" }],
      ] as const
    ).map(([type, p], i) => makeEnvelope(i, { type, payload: p } as never));
    const state = foldMatch(mod as never, cfg as never, defaultLineupPair(mod.positions), events);
    const summary = (mod as { summary: (s: unknown) => OverlayLiveData["summary"] }).summary(state);
    return overlayModel({
      sportKey: "football",
      data: { status, summary, outcome, lastSeq: null, venueTz: "UTC" },
      sides: SIDES,
      startLabel: null,
      clockLabel: null,
      msg: keyMsg,
      decidedTemplates: TEMPLATES,
    });
  }

  const contextLineOf = (Component: typeof OverlayBar | typeof OverlayBug, model: OverlayModel) => {
    const tree = walk(Component({ model, tick: [false, false], msg: keyMsg }));
    const cls = Component === OverlayBar ? "ovl-context" : "ovl-bug-context";
    const el = tree.find((node) => classesOf(node) === cls);
    return el === undefined ? undefined : textOf(el);
  };

  describe("OverlayBar", () => {
    it("live: the sport's own line", () => {
      expect(contextLineOf(OverlayBar, modelFor("in_play", null))).toBe("H2");
    });

    it("decided: the SHORT form of the result sentence, not the phase", () => {
      const line = contextLineOf(OverlayBar, modelFor("decided", { kind: "win", winner: "H", method: "regulation" }));
      expect(line, "the winner reduced to the cell's short name").toBe("WIN MIL REG");
      expect(line, "the phase must not survive under a decided status cell").not.toBe("H2");
    });

    it("void carrying a verdict: the same short form as decided", () => {
      const line = contextLineOf(
        OverlayBar,
        modelFor("forfeited", { kind: "award", winner: "A", method: "regulation" }),
      );
      expect(line).toBe("WIN NOR REG");
    });

    it("void, no verdict: the sport's own line SURVIVES — the regression this closes", () => {
      // Before I2 this rendered no second line at all: an abandoned match lost
      // the phase (or, for tennis, its "Set 3") the instant it ended.
      expect(contextLineOf(OverlayBar, modelFor("abandoned", null))).toBe("H2");
    });

    it("the negative pair: a scheduled fixture renders no second line at all", () => {
      expect(contextLineOf(OverlayBar, modelFor("scheduled", null))).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // `_THEMES.md` §4 (product ruling 2026-09-10, review finding IMPORTANT 1).
  // `header.period` is ONE field and BOTH themes read it, but §4 puts the
  // bug's result in the FOOTER and specs its 48px header context at 19.5/500
  // for "2nd half"-sized labels: "NOR won by 8 wickets with 12 balls
  // remaining" wraps there and clips, and fr/nl run 15-25% longer. So the bug
  // — and only the bug — ignores the field once `decided`. The four other
  // cases are unchanged: this is a branch, not a removal.
  // -------------------------------------------------------------------------
  describe("OverlayBug — the same field, minus the decided sentence (§4)", () => {
    it("live: the sport's own line, exactly as the bar shows it", () => {
      expect(contextLineOf(OverlayBug, modelFor("in_play", null))).toBe("H2");
    });

    it("decided: the model still CARRIES the sentence and the bug drops it", () => {
      const model = modelFor("decided", { kind: "win", winner: "H", method: "regulation" });
      // The differential that stops this reading as "the projection stopped
      // computing it": the field is populated, the bar renders it, the bug
      // does not. Without all three, an empty `header.period` passes too.
      expect(model.header.period, "the projection is unchanged").toBe("WIN MIL REG");
      expect(contextLineOf(OverlayBar, model), "§3 still shows it").toBe("WIN MIL REG");
      expect(contextLineOf(OverlayBug, model), "§4 puts the result in the footer instead").toBeUndefined();
    });

    it("void carrying a verdict: dropped too — `decided` covers both rows", () => {
      const model = modelFor("forfeited", { kind: "award", winner: "A", method: "regulation" });
      expect(model.decided, "a verdict-carrying void IS decided for §3/§4's purposes").toBe(true);
      expect(model.header.period).toBe("WIN NOR REG");
      expect(contextLineOf(OverlayBug, model)).toBeUndefined();
    });

    it("void, no verdict: the sport's own line SURVIVES in the bug as well", () => {
      // NOT decided, so the branch above must not reach it — the header keeps
      // the phase ("Set 3" for tennis) that I2 restored.
      const model = modelFor("abandoned", null);
      expect(model.decided).toBe(false);
      expect(contextLineOf(OverlayBug, model)).toBe("H2");
    });

    it("the negative pair: a scheduled fixture renders no second line at all", () => {
      expect(contextLineOf(OverlayBug, modelFor("scheduled", null))).toBeUndefined();
    });
  });
});
