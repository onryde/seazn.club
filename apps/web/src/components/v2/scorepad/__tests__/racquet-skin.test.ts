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
import type { AnySportModule, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { allActionViews, buildPadView, type PadActionView, type PadPanelView, type PadView, type PadViewCtx } from "../view-model";
import { createSkinDispatch, layoutActionTypes, layoutActionTypesAt, type SkinLayoutCtx } from "../skins/types";
import { racquetSkin } from "../skins/racquet-skin";
import { cfgSpace, grantAllEntitlements } from "./_cfg-space";

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
    expect(layoutActionTypesAt(layout, "primary").slice().sort()).toEqual(["badminton.rally", "tabletennis.rally"]);
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

// ---------------------------------------------------------------------------
// STAGE 2 — real engine integration. skin-coverage.test.ts is the SHARED gate
// (every skin, every sport, whole cfg space via __tests__/_cfg-space.ts) —
// this section proves this skin independently, against the same cfg space,
// BEFORE relying on that shared gate, plus pins racquet-specific behaviour
// the shared gate does not: named-variant cfg reactivity, the tabletennis
// expedite RUNTIME gate, the score-bound difference, and the rally type's
// multiple co-existing shapes collapsing to one placement.
// ---------------------------------------------------------------------------

const FULL_BAND = 3 as const;
const RACQUET_SPORTS = ["volleyball", "badminton", "tabletennis"] as const;

function moduleFor(sport: string): AnySportModule {
  const found = (builtinModules as readonly AnySportModule[]).find((m) => m.key === sport);
  if (!found) throw new Error(`no builtin sportModule for "${sport}" — engine catalog changed under this test`);
  return found;
}

/** Gate-free view: every action the spec declares, band/entitlement filtered
 *  only. Mirrors skin-coverage.test.ts's own (non-exported) `fullView`
 *  technique exactly, built from the SAME exported `allActionViews` the
 *  shared gate itself uses as its one source of "what does this spec
 *  declare" — a small, deliberate local restatement, never a second,
 *  independent policy (this repo has a recorded bug where two parallel
 *  lookup paths drifted; the two must agree on what "declares" means). */
function fullView(spec: PadSpec): PadView {
  const entitlements = grantAllEntitlements(spec);
  const resolved = allActionViews(spec, { band: FULL_BAND, entitlements });
  const byType = new Map(resolved.map((a) => [a.type, a] as const));
  const panels = spec.panels
    .map((panel) => ({
      labelKey: panel.labelKey,
      phase: panel.phase,
      layout: panel.layout,
      actions: panel.actions.map((a) => byType.get(a.type)).filter((a): a is PadActionView => a !== undefined),
    }))
    .filter((panel) => panel.actions.length > 0);
  return { phase: "live", phases: ["pre", "live", "post"], panels };
}

// Accepts either a raw engine `PadAction` (straight off `sportModule.padSpec()`,
// no `availability` — this describe block reads bounds directly off the
// spec, never through `layout()`, which never touches field bounds at all)
// or a view-model `PadActionView`.
function numberFieldMax(action: Pick<PadActionView, "type" | "fields">, path: string): number {
  const field = action.fields.find((f) => f.path === path);
  if (!field || field.kind !== "number") throw new Error(`expected a number field at "${path}" on ${action.type}`);
  return field.max;
}

describe("racquet skin — full cfg-space sweep (real engine specs)", () => {
  it("places every action exactly once, rally always primary, header always present — for all three sports across their whole cfg space", () => {
    let cfgsSwept = 0;
    const problems: string[] = [];
    for (const sport of RACQUET_SPORTS) {
      const sportModule = moduleFor(sport);
      for (const cfg of cfgSpace(sportModule)) {
        const spec = sportModule.padSpec?.(cfg);
        if (!spec) continue;
        cfgsSwept += 1;
        const view = fullView(spec);
        const entitlements = grantAllEntitlements(spec);
        const expected = new Set(allActionViews(spec, { band: FULL_BAND, entitlements }).map((a) => a.type));
        const layout = racquetSkin.layout(view, { cfg, state: {}, summary: {}, band: FULL_BAND });
        const placed = layoutActionTypes(layout);
        const placedSet = new Set(placed);
        const cfgId = JSON.stringify(cfg).slice(0, 100);

        for (const type of expected) if (!placedSet.has(type)) problems.push(`${sport} [${cfgId}]: missing ${type}`);
        for (const type of placedSet) if (!expected.has(type)) problems.push(`${sport} [${cfgId}]: invented ${type}`);
        if (placed.length !== placedSet.size) problems.push(`${sport} [${cfgId}]: duplicated in [${placed.join(",")}]`);

        const rallyType = `${sport}.rally`;
        if (!layoutActionTypesAt(layout, "primary").includes(rallyType)) {
          problems.push(`${sport} [${cfgId}]: ${rallyType} not primary`);
        }
        if (!layout.header || layout.header.fields.length === 0) {
          problems.push(`${sport} [${cfgId}]: no header`);
        }
      }
    }
    // Guards the sweep itself (skin-coverage.test.ts's own recorded lesson):
    // a walk that silently stops finding cfgs would make every assertion
    // above vacuously green.
    expect(cfgsSwept).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  });
});

describe("racquet skin — cfg knobs visibly change the layout", () => {
  it("badminton: records.timeouts toggles the timeouts group — no shipped variant sets it true, so this is a synthetic cfg override (the same flag cfgSpace's own leaf-override pass discovers)", () => {
    const sportModule = moduleFor("badminton");
    const withoutTimeouts = sportModule.configSchema.parse({});
    const specOff = sportModule.padSpec!(withoutTimeouts);
    const layoutOff = racquetSkin.layout(fullView(specOff), { cfg: withoutTimeouts, state: {}, summary: {}, band: FULL_BAND });
    expect(layoutActionTypes(layoutOff)).not.toContain("badminton.timeout");
    expect(layoutOff.groups.some((g) => g.id === "timeouts")).toBe(false);

    const withTimeouts = sportModule.configSchema.parse({
      records: { timeouts: true, sanctions: true, substitutions: false, expedite: false },
    });
    const specOn = sportModule.padSpec!(withTimeouts);
    const layoutOn = racquetSkin.layout(fullView(specOn), { cfg: withTimeouts, state: {}, summary: {}, band: FULL_BAND });
    expect(layoutActionTypes(layoutOn)).toContain("badminton.timeout");
    const timeoutsGroup = layoutOn.groups.find((g) => g.id === "timeouts");
    expect(timeoutsGroup?.prominence).toBe("drawer");
    expect(timeoutsGroup?.actions).toEqual(["badminton.timeout"]);
  });

  it("volleyball: indoor keeps subs, beach drops them (records.substitutions — the shipped variant divergence the W5 regression fix introduced)", () => {
    const sportModule = moduleFor("volleyball");
    const indoorCfg = sportModule.configSchema.parse(sportModule.variants!.indoor as Record<string, unknown>);
    const beachCfg = sportModule.configSchema.parse(sportModule.variants!.beach as Record<string, unknown>);
    const indoorLayout = racquetSkin.layout(fullView(sportModule.padSpec!(indoorCfg)), {
      cfg: indoorCfg,
      state: {},
      summary: {},
      band: FULL_BAND,
    });
    const beachLayout = racquetSkin.layout(fullView(sportModule.padSpec!(beachCfg)), {
      cfg: beachCfg,
      state: {},
      summary: {},
      band: FULL_BAND,
    });
    expect(layoutActionTypes(indoorLayout)).toContain("volleyball.sub");
    expect(layoutActionTypes(beachLayout)).not.toContain("volleyball.sub");
    expect(beachLayout.groups.some((g) => g.id === "subs")).toBe(false);
  });
});

describe("racquet skin — tabletennis expedite is a RUNTIME state flag, not a cfg one", () => {
  const sportModule = moduleFor("tabletennis");
  const cfg = sportModule.configSchema.parse({});
  const spec = sportModule.padSpec!(cfg);
  const entitlements = grantAllEntitlements(spec);

  function liveView(state: unknown): PadView {
    const ctx: PadViewCtx = { state, summary: {}, phase: "live", band: FULL_BAND, entitlements };
    return buildPadView(spec, ctx);
  }

  it("before expedite: start-expedite is offered; the expedite rally shape (returns/serving) is not in the view at all", () => {
    const v = liveView({});
    const rallyActionsPre = v.panels.flatMap((p) => p.actions).filter((a) => a.type === "tabletennis.rally");
    expect(rallyActionsPre.some((a) => a.fields.some((f) => f.path === "returns"))).toBe(false);

    const layout = racquetSkin.layout(v, { cfg, state: {}, summary: {}, band: FULL_BAND });
    expect(layoutActionTypes(layout)).toContain("tabletennis.expedite.start");
  });

  it("once expedite is live: the rally action GAINS the returns/serving shape — the second shape genuinely surfacing in the view — the start action is gone (can't start twice), and the skin still places tabletennis.rally exactly once, primary", () => {
    const v = liveView({ expedite: true });
    const rallyActionsLive = v.panels.flatMap((p) => p.actions).filter((a) => a.type === "tabletennis.rally");
    expect(rallyActionsLive.some((a) => a.fields.some((f) => f.path === "returns"))).toBe(true);

    const layout = racquetSkin.layout(v, { cfg, state: { expedite: true }, summary: {}, band: FULL_BAND });
    expect(layoutActionTypes(layout)).not.toContain("tabletennis.expedite.start");
    expect(layout.groups.some((g) => g.id === "expedite")).toBe(false);
    const placed = layoutActionTypes(layout);
    expect(placed.filter((t) => t === "tabletennis.rally")).toHaveLength(1);
    expect(layoutActionTypesAt(layout, "primary")).toContain("tabletennis.rally");
  });

  it("collapses the rally type to ONE placement even when handed a gate-free view carrying it from TWO panels at once (Rally + Expedite scoring) — exactly the shape skin-coverage.test.ts's sweep feeds every skin, for every tabletennis cfg", () => {
    const v = fullView(spec);
    const rallyPanelsCount = v.panels.filter((p) => p.actions.some((a) => a.type === "tabletennis.rally")).length;
    // Sanity on the scenario itself: if this ever drops to 1, the kernel
    // stopped emitting two rally-bearing panels and this test is no longer
    // exercising the collapse it claims to.
    expect(rallyPanelsCount).toBeGreaterThanOrEqual(2);

    const layout = racquetSkin.layout(v, { cfg, state: {}, summary: {}, band: FULL_BAND });
    const placed = layoutActionTypes(layout);
    expect(placed.filter((t) => t === "tabletennis.rally")).toHaveLength(1);
  });
});

describe("racquet skin — the score-bound difference (cap vs uncapped) passes through the view untouched", () => {
  it("badminton: capped at cfg.cap — 30 for bwf, 15 for the short junior/social variant", () => {
    const sportModule = moduleFor("badminton");
    const bwf = sportModule.configSchema.parse(sportModule.variants!.bwf as Record<string, unknown>);
    const short = sportModule.configSchema.parse(sportModule.variants!.short as Record<string, unknown>);
    const summaryFor = (cfg: unknown) =>
      sportModule
        .padSpec!(cfg)
        .panels.flatMap((p) => p.actions)
        .find((a) => a.type === "badminton.game.summary")!;
    expect(numberFieldMax(summaryFor(bwf), "home")).toBe(30);
    expect(numberFieldMax(summaryFor(short), "home")).toBe(15);
  });

  it("volleyball/tabletennis: uncapped, bound is max(setTo, finalSetTo) + 20", () => {
    const volleyball = moduleFor("volleyball");
    const indoor = volleyball.configSchema.parse(volleyball.variants!.indoor as Record<string, unknown>);
    const beach = volleyball.configSchema.parse(volleyball.variants!.beach as Record<string, unknown>);
    const boundFor = (sportModule: AnySportModule, cfg: unknown, type: string) =>
      numberFieldMax(
        sportModule
          .padSpec!(cfg)
          .panels.flatMap((p) => p.actions)
          .find((a) => a.type === type)!,
        "home",
      );
    expect(boundFor(volleyball, indoor, "volleyball.set.summary")).toBe(45); // max(25,15)+20
    expect(boundFor(volleyball, beach, "volleyball.set.summary")).toBe(41); // max(21,15)+20

    const tabletennis = moduleFor("tabletennis");
    const bo5 = tabletennis.configSchema.parse({});
    const hardbat = tabletennis.configSchema.parse(tabletennis.variants!["hardbat-21"] as Record<string, unknown>);
    expect(boundFor(tabletennis, bo5, "tabletennis.game.summary")).toBe(31); // max(11,11)+20
    expect(boundFor(tabletennis, hardbat, "tabletennis.game.summary")).toBe(41); // max(21,21)+20
  });
});
