// Racquet/net skin tests (S11/#420 W9). Rally-first layout serving the three
// setbased/kernel.ts sports: volleyball, badminton, tabletennis. See the
// dispatch brief and ./types.ts / ../skins/registry.ts for the contract this
// file holds racquet-skin.tsx to. `skin-coverage.test.ts` is the SHARED gate
// (every skin, every sport, whole cfg space) — this file additionally pins
// racquet-specific behaviour the shared gate does not: cfg/state reactivity,
// the score-bound difference, and the rally type's two/three co-existing
// action shapes collapsing to one placement.
//
// STAGE 1 (this block): layout mechanics against small hand-built PadViews,
// so the categorisation/header logic is pinned before the real engine specs
// are pulled in. STAGE 2 (appended below once stage 1 is green): real
// builtinModules sweep, named-variant cfg reactivity, score bounds, the
// expedite gate.
import { describe, expect, it } from "vitest";
import type { PadActionView, PadPanelView, PadView } from "../view-model";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinLayoutCtx } from "../skins/types";
import { racquetSkin } from "../skins/racquet-skin";

function action(type: string): PadActionView {
  return {
    type,
    labelKey: { key: `pad.test.${type}`, label: type },
    fields: [],
    attribution: [],
    availability: { kind: "available" },
  };
}

function view(types: readonly string[]): PadView {
  const panel: PadPanelView = {
    labelKey: { key: "pad.test.panel", label: "Test panel" },
    phase: "live",
    layout: "primary",
    actions: types.map(action),
  };
  return { phase: "live", phases: ["live"], panels: [panel] };
}

const EMPTY_CTX: SkinLayoutCtx = { cfg: {}, state: {}, summary: {}, band: 3 };

describe("racquet skin — identity", () => {
  it("claims exactly volleyball, badminton, tabletennis", () => {
    expect(racquetSkin.key).toBe("racquet");
    expect(racquetSkin.sports).toEqual(["volleyball", "badminton", "tabletennis"]);
  });
});

describe("racquet skin — layout mechanics (hand-built view)", () => {
  it("places every declared type exactly once", () => {
    const v = view(["volleyball.rally", "volleyball.set.summary"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypes(layout).slice().sort()).toEqual(["volleyball.rally", "volleyball.set.summary"]);
  });

  it("places the rally action at primary prominence, alone", () => {
    const v = view(["volleyball.rally", "volleyball.set.summary"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypesAt(layout, "primary")).toEqual(["volleyball.rally"]);
  });

  it("never places the set-score summary action at primary prominence", () => {
    const v = view(["volleyball.rally", "volleyball.set.summary"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypesAt(layout, "primary")).not.toContain("volleyball.set.summary");
  });

  it("reads the sport prefix off the view rather than hardcoding one — proven with badminton and tabletennis types the volleyball-only stub would drop", () => {
    const v = view(["badminton.rally", "badminton.game.summary", "tabletennis.rally", "tabletennis.game.summary"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypes(layout).slice().sort()).toEqual(
      ["badminton.game.summary", "badminton.rally", "tabletennis.game.summary", "tabletennis.rally"].sort(),
    );
    expect(layoutActionTypesAt(layout, "primary").sort()).toEqual(["badminton.rally", "tabletennis.rally"]);
  });

  it("never invents a type absent from the view", () => {
    const v = view(["volleyball.rally"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypes(layout)).toEqual(["volleyball.rally"]);
  });

  it("routes an action type it does not recognise into a catch-all group rather than dropping it (forward-compat safety net)", () => {
    const v = view(["volleyball.rally", "volleyball.future.thing"]);
    const layout = racquetSkin.layout(v, EMPTY_CTX);
    expect(layoutActionTypes(layout).slice().sort()).toEqual(["volleyball.future.thing", "volleyball.rally"]);
    // Never at primary — an unrecognised type has not earned headline billing.
    expect(layoutActionTypesAt(layout, "primary")).toEqual(["volleyball.rally"]);
  });
});

describe("racquet skin — header", () => {
  it("is always present with the three racquet header fields, in the brief's order", () => {
    const layout = racquetSkin.layout(view(["volleyball.rally"]), EMPTY_CTX);
    expect(layout.header).not.toBeNull();
    expect(layout.header!.fields.length).toBeGreaterThan(0);
    expect(layout.header!.fields.map((f) => f.captionKey)).toEqual([
      "scorepad.skin.racquet.header.sets",
      "scorepad.skin.racquet.header.points",
      "scorepad.skin.racquet.header.serving",
    ]);
  });

  it("defaults to a 0-0 scoreline on an empty/unfolded state (the coverage sweep's own state: {})", () => {
    const layout = racquetSkin.layout(view(["volleyball.rally"]), EMPTY_CTX);
    const sets = layout.header!.fields.find((f) => f.id === "sets")!;
    const points = layout.header!.fields.find((f) => f.id === "points")!;
    expect(sets.value).toBe("0–0");
    expect(points.value).toBe("0–0");
  });

  it("reflects real folded state — sets won and the CURRENT (open) set's live points, not a match-wide total", () => {
    const state = {
      entrants: { home: "H", away: "A" },
      setsWon: { home: 2, away: 1 },
      sets: [
        { home: 25, away: 20, closed: true },
        { home: 22, away: 25, closed: true },
        { home: 25, away: 18, closed: true },
        { home: 14, away: 11, closed: false },
      ],
    };
    const layout = racquetSkin.layout(view(["volleyball.rally"]), { ...EMPTY_CTX, state });
    const sets = layout.header!.fields.find((f) => f.id === "sets")!;
    const points = layout.header!.fields.find((f) => f.id === "points")!;
    expect(sets.value).toBe("2–1");
    expect(points.value).toBe("14–11"); // the open 4th set, NOT totalPoints() across all sets
  });

  it("shows 0-0 points between sets, once the last set has closed", () => {
    const state = {
      entrants: { home: "H", away: "A" },
      setsWon: { home: 1, away: 0 },
      sets: [{ home: 25, away: 20, closed: true }],
    };
    const layout = racquetSkin.layout(view(["volleyball.rally"]), { ...EMPTY_CTX, state });
    const points = layout.header!.fields.find((f) => f.id === "points")!;
    expect(points.value).toBe("0–0");
  });
});

describe("racquet skin — dispatch", () => {
  it("refuses an action a real volleyball view does not declare, and passes through one it does", async () => {
    const v = view(["volleyball.rally", "volleyball.set.summary"]);
    const sent: string[] = [];
    const dispatch = createSkinDispatch(v, async (type) => void sent.push(type));
    await dispatch("volleyball.rally", { wonBy: "H" });
    await expect(dispatch("volleyball.invented", {})).rejects.toThrow(/does not declare/);
    expect(sent).toEqual(["volleyball.rally"]);
  });
});
