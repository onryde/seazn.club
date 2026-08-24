// R3/task B2 — football SkinDefV3. Pure-data assertions only (apps/web vitest
// is `environment: "node"`, no jsdom — the convention every v3 primitive
// follows): the skin is a spec BUILDER, so this file asserts the specs it
// returns and leaves the DOM to e2e.
//
// Two things are proved by driving the REAL chassis rather than a stand-in,
// because a re-implemented stand-in is exactly how a `when` predicate ships
// broken with a green suite:
//   - guided-sheet gating goes through `initialSheetState`/`currentStep`/
//     `answerStep` from ../../guided-sheet;
//   - every mirrored engine vocabulary (card colours, offence reasons,
//     penalty outcomes, period markers, and the per-event fidelity band) is
//     pinned against the ENGINE's own `padSpec(cfg)`, so a module change reds
//     here instead of drifting silently.
//
// There is no shared skin-test factory in this tree — cricket.test.ts defines
// its own local `t`/`squads()`/`state()`/`cfg()`/`view()`; this file follows
// that precedent deliberately rather than inventing a shared one for two
// callers.
import { describe, expect, it } from "vitest";
import type { AnySportModule, PadAction, PadField } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import { answerStep, currentStep, initialSheetState } from "../../guided-sheet";
import type { GuidedSheetSpec, PadHostView, TileSpec } from "../../types";
import { cricketSkinV3 } from "../cricket";
import {
  CARD_COLORS,
  CARD_REASONS,
  EVENT_BAND,
  PENALTY_OUTCOMES,
  buildDock,
  buildScorebug,
  buildSheets,
  buildSwap,
  buildTiles,
  footballDetail,
  footballSkinV3,
  periodMarkersOf,
  readClock,
  resolvePhase,
} from "../football";
import type { TFn } from "../football";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const t: TFn = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

const NAMES: Record<string, string> = {
  h1: "Home One", h2: "Home Two", h3: "Home Three", h4: "Home Sub", h5: "Home Sub Two",
  a1: "Away One", a2: "Away Two", a3: "Away Three", a4: "Away Sub", a5: "Away Sub Two",
};

function squads(): SquadState {
  return initSquads({
    home: {
      entrantId: "home-1",
      slots: [
        { personId: "h1", slot: "starting", orderNo: 1 },
        { personId: "h2", slot: "starting", orderNo: 2 },
        { personId: "h3", slot: "starting", orderNo: 3 },
        { personId: "h4", slot: "bench", orderNo: 4 },
        { personId: "h5", slot: "bench", orderNo: 5 },
      ],
    },
    away: {
      entrantId: "away-1",
      slots: [
        { personId: "a1", slot: "starting", orderNo: 1 },
        { personId: "a2", slot: "starting", orderNo: 2 },
        { personId: "a3", slot: "starting", orderNo: 3 },
        { personId: "a4", slot: "bench", orderNo: 4 },
        { personId: "a5", slot: "bench", orderNo: 5 },
      ],
    },
  });
}

/** Football's OWN squad projection (`FootballSquad`, football.ts) — NOT the
 *  kernel's `SquadState`. That divergence is the whole reason the skin reads
 *  this rather than `view.squads`, so the fixture must have this shape. */
function footballSquad(over: Record<string, unknown> = {}) {
  return { onPitch: ["h1", "h2", "h3"], bench: ["h4", "h5"], offUsed: [], sentOff: [], ...over };
}

function state(over: Record<string, unknown> = {}) {
  return {
    phase: "H1" as const,
    entrants: { home: "home-1", away: "away-1" },
    goals: { home: 1, away: 0 },
    periods: [{ phase: "H1", home: 1, away: 0 }],
    cards: [] as { side: string; person?: string; color: string }[],
    squads: {
      home: footballSquad(),
      away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
    },
    shootout: null,
    ...over,
  };
}

function cfg(over: Record<string, unknown> = {}) {
  return {
    halfMinutes: 45,
    halves: 2 as 2 | 4,
    extraTime: { enabled: false, halfMinutes: 15 },
    shootout: false,
    maxSubs: 3,
    subWindows: 3,
    ...over,
  };
}

function view(over: Partial<PadHostView> = {}): PadHostView {
  return {
    cfg: cfg(),
    state: state(),
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: NAMES,
    squads: squads(),
    events: [],
    contextOverrides: {},
    ...over,
  };
}

const tileById = (tiles: readonly TileSpec[], id: string): TileSpec | undefined => tiles.find((tile) => tile.id === id);

// The engine module itself — every mirrored vocabulary below is pinned
// against its own `padSpec(cfg)`, never a hand-copied list.
const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule?.padSpec || !footballModule.eventSchemas) {
  throw new Error("football module (with padSpec/eventSchemas) not found in builtinModules — engine export moved?");
}
const padSpecFor = footballModule.padSpec;
const ENGINE_EVENT_TYPES = new Set(Object.keys(footballModule.eventSchemas));

function engineCfg(over: Record<string, unknown> = {}): unknown {
  return footballModule!.configSchema.parse(over);
}

function engineAction(spec: ReturnType<typeof padSpecFor>, type: string): PadAction {
  for (const panel of spec.panels) {
    for (const action of panel.actions) if (action.type === type) return action;
  }
  throw new Error(`padSpec declares no action "${type}"`);
}

function enumValues(action: PadAction, path: string): readonly string[] {
  const field = action.fields.find((f: PadField) => f.path === path);
  if (!field || field.kind !== "enum") throw new Error(`action has no enum field "${path}"`);
  return field.values;
}

// ---------------------------------------------------------------------------
// Mirrored engine vocabularies — drift pins.
// ---------------------------------------------------------------------------

describe("engine mirrors (a module change must red HERE, not drift silently)", () => {
  const spec = padSpecFor(engineCfg());

  it("CARD_COLORS mirrors football.card's own colour enum, in order", () => {
    expect([...CARD_COLORS]).toEqual([...enumValues(engineAction(spec, "football.card"), "color")]);
    expect(CARD_COLORS).toHaveLength(3); // vacuity guard: an empty mirror would satisfy the line above
  });

  it("CARD_REASONS mirrors football.card's own offence enum, all 13 of them", () => {
    expect([...CARD_REASONS]).toEqual([...enumValues(engineAction(spec, "football.card"), "reason")]);
    expect(CARD_REASONS).toHaveLength(13);
  });

  it("PENALTY_OUTCOMES mirrors football.penalty's own outcome enum — the shared attempt vocabulary MINUS scored", () => {
    expect([...PENALTY_OUTCOMES]).toEqual([...enumValues(engineAction(spec, "football.penalty"), "outcome")]);
    expect(PENALTY_OUTCOMES).not.toContain("scored");
  });

  it("EVENT_BAND mirrors padSpec's own fidelity map exactly — every type, every band", () => {
    expect(EVENT_BAND).toEqual(spec.fidelity);
    expect(Object.keys(EVENT_BAND)).toHaveLength(9);
  });

  it("periodMarkersOf mirrors football.period's own marker enum for halves, quarters and extra time", () => {
    expect([...periodMarkersOf(cfg())]).toEqual([...enumValues(engineAction(padSpecFor(engineCfg()), "football.period"), "phase")]);
    expect([...periodMarkersOf(cfg({ halves: 4 }))]).toEqual([
      ...enumValues(engineAction(padSpecFor(engineCfg({ halves: 4 })), "football.period"), "phase"),
    ]);
    expect([...periodMarkersOf(cfg({ extraTime: { enabled: true, halfMinutes: 15 } }))]).toEqual([
      ...enumValues(engineAction(padSpecFor(engineCfg({ extraTime: { enabled: true, halfMinutes: 15 } })), "football.period"), "phase"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// phase() — G3. OPT-IN: a skin that omits it silently keeps the tab-shaped
// default the host falls back to, so this is a real deliverable, not a detail.
// ---------------------------------------------------------------------------

describe("resolvePhase", () => {
  it("maps football's richer engine phases DOWN to the three PadPhase values", () => {
    expect(resolvePhase(view({ state: state({ phase: "pre" }) }))).toBe("pre");
    for (const phase of ["H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2", "SHOOTOUT"]) {
      expect(resolvePhase(view({ state: state({ phase }) })), phase).toBe("live");
    }
    for (const phase of ["done", "final", "abandoned"]) {
      expect(resolvePhase(view({ state: state({ phase }) })), phase).toBe("post");
    }
  });

  it("reads an unfolded/empty state as 'pre' — football's own documented starting value", () => {
    expect(resolvePhase(view({ state: {} }))).toBe("pre");
  });
});

// ---------------------------------------------------------------------------
// scorebug() — tapModel T: the halves are READOUTS, never tap targets.
// ---------------------------------------------------------------------------

describe("buildScorebug", () => {
  it("shows each side's goals as its own half, and neither half is tappable (tapModel T)", () => {
    const spec = buildScorebug(view(), t);
    expect(spec.halves[0].big).toBe("1");
    expect(spec.halves[1].big).toBe("0");
    expect(spec.halves[0].tappable).toBeFalsy();
    expect(spec.halves[1].tappable).toBeFalsy();
    expect(spec.halves[0].who[0]?.name).toBe("scorepad.attribution.home");
    expect(spec.halves[1].who[0]?.name).toBe("scorepad.attribution.away");
  });

  it("the strip is period · clock, each with a stable id", () => {
    const spec = buildScorebug(view({ state: state({ asOf: { period: "H1", elapsed: 754 } }) }), t);
    expect(spec.strip.map((item) => item.id)).toEqual(["period", "clock"]);
    expect(spec.strip[0]?.value).toBe("H1");
    expect(spec.strip[1]?.value).toBe("12:34");
  });

  it("the clock falls back to the placeholder when asOf is missing or names another phase (v2's own staleness guard)", () => {
    expect(buildScorebug(view(), t).strip[1]?.value).toBe("—");
    const stale = view({ state: state({ phase: "H2", asOf: { period: "H1", elapsed: 100 } }) });
    expect(buildScorebug(stale, t).strip[1]?.value).toBe("—");
  });

  it("appends Law 7 added time as a locale-invariant +N item only when the fold carries one", () => {
    const withAdded = view({ state: state({ periods: [{ phase: "H1", home: 1, away: 0, addedMinutes: 3 }] }) });
    expect(buildScorebug(withAdded, t).strip.map((i) => i.value)).toContain("+3");
    expect(buildScorebug(view(), t).strip.map((i) => i.id)).not.toContain("added");
  });

  it("the context line states the FORMAT, which is the one thing cfg shrinks for a small-sided variant", () => {
    expect(buildScorebug(view(), t).context).toContain("pad.football.context.smallSided");
    expect(buildScorebug(view(), t).context).toContain('"size":11');
    const mini = view({ cfg: cfg({ teamSize: 7, halves: 4 }) });
    expect(buildScorebug(mini, t).context).toContain('"size":7');
    expect(buildScorebug(mini, t).context).toContain("pad.football.context.quarters");
  });

  it("carries the skin's own phase() answer, never the host's tab state", () => {
    expect(buildScorebug(view({ state: state({ phase: "final" }), phase: "live" }), t).phase).toBe("post");
  });
});

// ---------------------------------------------------------------------------
// tiles() — per-side Goal/Card/Sub columns, shared Period, minor Pen, More.
// ---------------------------------------------------------------------------

describe("buildTiles", () => {
  it("declares a Goal tile per side, each committing SIDE-LEVEL with that side's own entrant id", () => {
    const tiles = buildTiles(view());
    const home = tileById(tiles, "goal-home")!;
    const away = tileById(tiles, "goal-away")!;
    expect(home.action).toEqual({ event: { type: "football.goal", payload: { by: "home-1" } } });
    expect(away.action).toEqual({ event: { type: "football.goal", payload: { by: "away-1" } } });
    expect(home.kind).toBe("primary");
  });

  it("declares three INLINE card colours per side — yellow, red AND second yellow (R3-1)", () => {
    const tiles = buildTiles(view());
    for (const side of ["home", "away"]) {
      for (const colour of CARD_COLORS) {
        const tile = tileById(tiles, `card-${side}-${colour}`);
        expect(tile, `card-${side}-${colour}`).toBeDefined();
        expect(tile!.sublabel).toBe(side === "home" ? "scorepad.attribution.home" : "scorepad.attribution.away");
      }
    }
    expect(tileById(tiles, "card-home-second_yellow")!.label).toBe("cardColor.second_yellow");
  });

  it("declares a Sub tile per side, each addressing its OWN swap slot", () => {
    const tiles = buildTiles(view());
    expect(tileById(tiles, "sub-home")!.action).toEqual({ swap: "sub-home" });
    expect(tileById(tiles, "sub-away")!.action).toEqual({ swap: "sub-away" });
  });

  it("declares Period once (shared), Pen as a MINOR tile, and the generic More sheet", () => {
    const tiles = buildTiles(view());
    expect(tileById(tiles, "period")!.action).toEqual({ sheet: "period" });
    expect(tileById(tiles, "penalty")!.kind).toBe("minor");
    expect(tiles.filter((tile) => tile.id.startsWith("period"))).toHaveLength(1);
    expect(tileById(tiles, "more")).toBeDefined();
  });

  it("every tile is declared for the LIVE phase only — padSpec declares no pre/post panel for this sport", () => {
    for (const tile of buildTiles(view())) expect(tile.phases, tile.id).toEqual(["live"]);
  });

  it("every {swap} tile names a slot this skin's own swap() declares, and every {sheet} tile a sheet it builds", () => {
    const v = view();
    const slotIds = new Set(buildSwap(v, t).map((slot) => slot.id));
    const sheetKeys = new Set(Object.keys(buildSheets(v)));
    for (const tile of buildTiles(v)) {
      if ("swap" in tile.action) expect(slotIds.has(tile.action.swap), tile.id).toBe(true);
      if ("sheet" in tile.action && tile.action.sheet !== "__pad-host/more__") {
        expect(sheetKeys.has(tile.action.sheet), tile.id).toBe(true);
      }
    }
  });

  // The host's own band filter runs on ENTITLED bands; the dispatch guard runs
  // on the ACTIVE one (`buildPadView` drops an action whose band exceeds
  // `ctx.band`). A tile above the active band is therefore visible and THROWS
  // on tap — the dead-end tap this programme keeps closing — so the skin
  // withholds it.
  it("withholds every tile whose event sits above the ACTIVE fidelity band, keeping the band-0 ones", () => {
    const ids = buildTiles(view({ band: 0 })).map((tile) => tile.id);
    expect(ids).toContain("goal-home");
    expect(ids).toContain("period");
    expect(ids).toContain("more");
    expect(ids).not.toContain("card-home-yellow");
    expect(ids).not.toContain("sub-home");
    expect(ids).not.toContain("penalty");
  });

  it("offers every band-2 tile once the active band reaches 2", () => {
    const ids = buildTiles(view({ band: 2 })).map((tile) => tile.id);
    expect(ids).toContain("card-home-yellow");
    expect(ids).toContain("sub-home");
    expect(ids).toContain("penalty");
  });

  it("withholds the play-phase-only tiles during a shoot-out, where the fold refuses them — cards stay, they are legal there", () => {
    const ids = buildTiles(view({ state: state({ phase: "SHOOTOUT" }) })).map((tile) => tile.id);
    expect(ids).not.toContain("goal-home");
    expect(ids).not.toContain("sub-home");
    expect(ids).not.toContain("penalty");
    expect(ids).not.toContain("period");
    expect(ids).toContain("card-home-yellow");
    expect(ids).toContain("more");
  });
});

// ---------------------------------------------------------------------------
// sheets() — driven through the REAL step machine.
// ---------------------------------------------------------------------------

function drive(spec: GuidedSheetSpec, answers: readonly string[]) {
  let state = initialSheetState();
  for (const answer of answers) {
    const outcome = answerStep(spec, state, answer);
    if (outcome.done) return outcome.event;
    state = outcome.state;
  }
  return null;
}

describe("buildSheets — the card flow (R3-1)", () => {
  it("asks the offence at band 2+, offering all 13 CardReason values, and commits colour + side + reason", () => {
    const sheets = buildSheets(view({ band: 2 }));
    const spec = sheets["card-home-yellow"]!;
    const step = currentStep(spec, initialSheetState());
    expect(step?.id).toBe("reason");
    expect(step?.kind === "choice" && step.options).toHaveLength(13);
    expect(drive(spec, ["dissent"])).toEqual({
      type: "football.card",
      payload: { by: "home-1", color: "yellow", reason: "dissent" },
    });
  });

  it("HIDES the offence step below band 2 — `reason` is optional in the engine, so bands 0-1 commit without it", () => {
    const spec = buildSheets(view({ band: 1 }))["card-home-yellow"]!;
    expect(currentStep(spec, initialSheetState())).toBeNull();
  });

  // The consequence of the line above, and the reason the tile action is
  // band-dependent: `GuidedSheet` renders `null` when no step is visible, so a
  // {sheet} tile at band 0-1 would open an invisible sheet — a dead-end tap
  // with no visible feedback at all.
  it("the card TILE dispatches directly below band 2 and opens the sheet at band 2+, so no tap can open an empty sheet", () => {
    const low = tileById(buildTiles(view({ band: 1 })), "card-home-yellow");
    expect(low).toBeUndefined(); // band 2 event: withheld entirely at band 1

    const high = tileById(buildTiles(view({ band: 2 })), "card-home-yellow")!;
    expect(high.action).toEqual({ sheet: "card-home-yellow" });
  });

  it("declares one sheet per side x colour, each carrying its OWN side and colour into the payload", () => {
    const sheets = buildSheets(view());
    expect(drive(sheets["card-away-second_yellow"]!, ["violent_conduct"])).toEqual({
      type: "football.card",
      payload: { by: "away-1", color: "second_yellow", reason: "violent_conduct" },
    });
  });
});

describe("buildSheets — period and penalty", () => {
  it("offers exactly the markers this cfg's own fold accepts", () => {
    const halves = buildSheets(view())["period"]!;
    expect((halves.steps[0] as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["HT", "FT"]);
    const quarters = buildSheets(view({ cfg: cfg({ halves: 4 }) }))["period"]!;
    expect((quarters.steps[0] as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["QT", "HT", "3QT", "FT"]);
  });

  it("commits a period marker with no side attribution — a whistle belongs to neither team", () => {
    expect(drive(buildSheets(view())["period"]!, ["HT"])).toEqual({
      type: "football.period",
      payload: { phase: "HT" },
    });
  });

  it("asks which side was awarded the penalty, then what happened — outcome is REQUIRED in the engine", () => {
    const spec = buildSheets(view())["penalty"]!;
    expect(spec.steps.map((s) => s.id)).toEqual(["by", "outcome"]);
    expect(drive(spec, ["away-1", "saved"])).toEqual({
      type: "football.penalty",
      payload: { by: "away-1", outcome: "saved" },
    });
  });
});

// ---------------------------------------------------------------------------
// swap() — R3-2 + R3-5. The wave's centrepiece.
// ---------------------------------------------------------------------------

describe("buildSwap", () => {
  it("declares one slot per side, addressed by the Sub tiles, both dispatching football.sub", () => {
    const slots = buildSwap(view(), t);
    expect(slots.map((slot) => slot.id)).toEqual(["sub-home", "sub-away"]);
    expect(slots[0]!.side).toBe("home");
    expect(slots[1]!.side).toBe("away");
  });

  // R3's chassis wave: `eventType` is declared STATICALLY (the band filter
  // runs before any pick exists) and NOTHING checks it against what
  // `buildEvent` returns — "a skin owes its own test that the pair agree".
  // This is that test. A skin that declared one type and built another would
  // be correctly band-filtered on a lie.
  it("declares the SAME event type it actually builds — the pin the chassis cannot make for itself", () => {
    for (const slot of buildSwap(view(), t)) {
      expect(slot.buildEvent("h1", "h4").type, slot.id).toBe(slot.eventType);
      expect(ENGINE_EVENT_TYPES.has(slot.eventType), slot.eventType).toBe(true);
    }
  });

  it("builds the substitution against the side's own entrant id, off and on both required", () => {
    const home = buildSwap(view(), t)[0]!;
    expect(home.buildEvent("h1", "h4")).toEqual({
      type: "football.sub",
      payload: { by: "home-1", off: "h1", on: "h4" },
    });
  });

  it("scopes the OFF list to who is on the pitch RIGHT NOW, not the kickoff sheet", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.offCandidates).toEqual(["h2", "h3", "h4"]);
  });

  it("scopes the ON list to everyone the kernel still knows and is not on the pitch — bench PLUS the already-substituted", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).toEqual(["h5", "h1"]);
  });

  it("keeps an already-substituted player VISIBLE with the reason rather than removing them (reentry: none)", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3", "h4"], bench: ["h5"], offUsed: ["h1"] }),
        away: footballSquad({ onPitch: ["a1", "a2", "a3"], bench: ["a4", "a5"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.blocked?.h1).toBe("pad.football.context.sub.blocked.reentry.short");
    expect(home.blocked?.h5).toBeUndefined();
  });

  it("blocks nobody under rolling substitutions — the variant that permits a return", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3"], bench: ["h5", "h1"], offUsed: [] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const slots = buildSwap(view({ cfg: cfg({ rollingSubs: true }), state: live }), t);
    expect(slots[0]!.blocked).toEqual({});
    expect(slots[0]!.policyOk).toBe(true);
  });

  it("keeps a sent-off SUBSTITUTE visible on the bench with its own reason — the only way that ground is reachable", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h1", "h2", "h3"], bench: ["h4", "h5"], sentOff: ["h4"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).toContain("h4");
    expect(home.blocked?.h4).toBe("pad.football.context.sub.blocked.sentOff.short");
    expect(home.blocked?.h5).toBeUndefined();
  });

  it("blocks a sent-off player from returning, and never offers them as a replacement for themselves", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2", "h3"], bench: ["h4", "h5"], sentOff: ["h1"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.candidates).not.toContain("h1");
    expect(home.offCandidates).not.toContain("h1");
  });

  // TWO INDEPENDENT refusals, both owed: the PLAYER cap (lineupPolicy) and the
  // WINDOW cap (Law 3 stoppages). Neither implies the other.
  it("refuses with the PLAYER cap once maxSubs is spent, worded with the numbers", () => {
    const live = state({
      squads: {
        home: footballSquad({ onPitch: ["h2"], bench: ["h5"], offUsed: ["h1", "h3", "hx"] }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.policyOk).toBe(false);
    expect(home.policyMessage).toContain("pad.football.context.sub.blocked.maxSubs");
    expect(home.policyMessage).toContain('"used":3');
    expect(home.policyMessage).toContain('"max":3');
  });

  it("refuses with the WINDOW cap once every stoppage is spent, even with substitutions still in hand", () => {
    const live = state({
      phase: "H2",
      asOf: { period: "H2", elapsed: 1000 },
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H2", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    const home = buildSwap(view({ state: live }), t)[0]!;
    expect(home.policyOk).toBe(false);
    expect(home.policyMessage).toContain("pad.football.context.sub.blocked.subWindows");
    expect(home.policyMessage).toContain('"windows":3');
  });

  it("does NOT refuse on the window cap when this stamp is a window the side has already opened — three subs at one stoppage are one window", () => {
    const live = state({
      phase: "H2",
      asOf: { period: "H2", elapsed: 300 },
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H2", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    expect(buildSwap(view({ state: live }), t)[0]!.policyOk).toBe(true);
  });

  it("does NOT refuse on the window cap when nothing can be stamped — an unstamped substitution consumes no window", () => {
    const live = state({
      squads: {
        home: footballSquad({
          subWindows: [
            { period: "H1", elapsed: 100 },
            { period: "H1", elapsed: 200 },
            { period: "H1", elapsed: 300 },
          ],
        }),
        away: footballSquad({ onPitch: ["a1"], bench: ["a4"] }),
      },
    });
    expect(buildSwap(view({ state: live }), t)[0]!.policyOk).toBe(true);
  });

  // R3-2 + the `at`-stamp note: stamp from the fold's own `asOf`, with v2's
  // staleness guard. A WRONG stamp mis-attributes a stoppage; no stamp merely
  // consumes no window.
  it("stamps `at` from the fold's asOf when it names the CURRENT phase", () => {
    const stamped = view({ state: state({ asOf: { period: "H1", elapsed: 754 } }) });
    expect(buildSwap(stamped, t)[0]!.buildEvent("h1", "h4").payload).toEqual({
      by: "home-1",
      off: "h1",
      on: "h4",
      at: { period: "H1", elapsed: 754 },
    });
  });

  it("OMITS `at` when the fold carries none", () => {
    expect(buildSwap(view(), t)[0]!.buildEvent("h1", "h4").payload).not.toHaveProperty("at");
  });

  it("OMITS `at` when asOf names a phase the match has already left — never a stamp from the wrong period", () => {
    const stale = view({ state: state({ phase: "H2", asOf: { period: "H1", elapsed: 754 } }) });
    expect(buildSwap(stale, t)[0]!.buildEvent("h1", "h4").payload).not.toHaveProperty("at");
  });

  it("offers nothing outside a play phase — the fold refuses a substitution in a shoot-out", () => {
    expect(buildSwap(view({ state: state({ phase: "SHOOTOUT" }) }), t)).toEqual([]);
    expect(buildSwap(view({ state: state({ phase: "pre" }) }), t)).toEqual([]);
  });

  it("labels both pickers with this skin's own keys", () => {
    const home = buildSwap(view(), t)[0]!;
    expect(home.offLabel).toBe("scorepad.skin.football.swap.off");
    expect(home.onLabel).toBe("scorepad.skin.football.swap.on");
  });
});

// ---------------------------------------------------------------------------
// dock() — the goal's scorer/assist chips and the card's person chips.
// ---------------------------------------------------------------------------

describe("buildDock", () => {
  it("returns null for an event with nothing worth enriching", () => {
    expect(buildDock("football.period", view(), t, {})).toBeNull();
    expect(buildDock("football.shot", view(), t, {})).toBeNull();
  });

  it("offers the two payload toggles plus scorer and assist chips for the SCORING side's on-pitch players", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    const ids = dock.chips.map((chip) => chip.id);
    expect(ids.slice(0, 2)).toEqual(["ownGoal", "penalty"]);
    expect(ids).toContain("scorer:h1");
    expect(ids).toContain("assist:h2");
    expect(ids).not.toContain("scorer:a1"); // the other side never scored this one
    expect(ids).not.toContain("scorer:h4"); // on the bench: the fold refuses a scorer who is not on the pitch
  });

  it("labels a person chip with the NAME, pre-localised, never through a dictionary key", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    expect(dock.chips.find((chip) => chip.id === "scorer:h1")!.labelText).toBe("Home One");
    expect(dock.chips.find((chip) => chip.id === "assist:h1")!.labelText).toContain("Home One");
  });

  it("chips mutate only their own field, leaving the rest of the payload alone", () => {
    const dock = buildDock("football.goal", view(), t, { by: "home-1" })!;
    const withScorer = dock.chips.find((chip) => chip.id === "scorer:h2")!.mutate({ by: "home-1" });
    expect(withScorer).toEqual({ by: "home-1", scorer: "h2" });
    expect(dock.chips.find((chip) => chip.id === "assist:h3")!.mutate(withScorer)).toEqual({
      by: "home-1",
      scorer: "h2",
      assist: "h3",
    });
    expect(dock.chips.find((chip) => chip.id === "ownGoal")!.mutate({ by: "home-1" })).toEqual({
      by: "home-1",
      ownGoal: true,
    });
  });

  it("withholds the attribution chips below band 2, keeping the two toggles — attribution is the band-2 timeline", () => {
    const dock = buildDock("football.goal", view({ band: 0 }), t, { by: "home-1" })!;
    expect(dock.chips.map((chip) => chip.id)).toEqual(["ownGoal", "penalty"]);
  });

  it("narrows the card's person chips by COLOUR — the engine refuses a second yellow to anyone without a first", () => {
    const carded = state({ cards: [{ side: "home", person: "h2", color: "yellow" }] });
    const v = view({ state: carded });
    const yellow = buildDock("football.card", v, t, { by: "home-1", color: "yellow" })!;
    expect(yellow.chips.map((c) => c.id)).toEqual(["person:h1", "person:h3"]);
    const second = buildDock("football.card", v, t, { by: "home-1", color: "second_yellow" })!;
    expect(second.chips.map((c) => c.id)).toEqual(["person:h2"]);
    const red = buildDock("football.card", v, t, { by: "home-1", color: "red" })!;
    expect(red.chips.map((c) => c.id)).toEqual(["person:h1", "person:h2", "person:h3"]);
  });
});

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half. The nine per-sport ribbon
// keys are VAR-FREE bases; every name reaches the line through
// `pad.ribbon.withDetail` with the SKIN supplying `detail`.
// ---------------------------------------------------------------------------

function detail(eventType: string, payload: Record<string, unknown>): string | undefined {
  return footballDetail({ t, eventType, payload, personNames: NAMES, cfg: cfg() });
}

describe("footballDetail", () => {
  it("names the scorer, the assist and the flags for a goal", () => {
    expect(detail("football.goal", { by: "home-1", scorer: "h1" })).toBe("Home One");
    expect(detail("football.goal", { by: "home-1", scorer: "h1", assist: "h2" })).toContain("Home One");
    expect(detail("football.goal", { by: "home-1", scorer: "h1", assist: "h2" })).toContain("Home Two");
    expect(detail("football.goal", { by: "home-1", ownGoal: true })).toContain("pad.football.ribbon.goal.ownGoal");
    expect(detail("football.goal", { by: "home-1", penalty: true })).toContain("pad.football.ribbon.goal.penalty");
  });

  it("returns undefined for a goal with nothing to add, leaving the static caption untouched", () => {
    expect(detail("football.goal", { by: "home-1" })).toBeUndefined();
  });

  it("names the colour and the player for a card — second_yellow's copy already exists, none was minted", () => {
    const text = detail("football.card", { by: "home-1", color: "second_yellow", person: "h2" })!;
    expect(text).toContain("cardColor.second_yellow");
    expect(text).toContain("Home Two");
  });

  it("names both players of a substitution", () => {
    const text = detail("football.sub", { by: "home-1", off: "h1", on: "h4" })!;
    expect(text).toContain("Home One");
    expect(text).toContain("Home Sub");
  });

  it("names the marker for a period, and the outcome for a penalty, a shot and a shoot-out kick", () => {
    expect(detail("football.period", { phase: "HT" })).toContain("matchPhase.HT");
    expect(detail("football.penalty", { by: "home-1", outcome: "saved", taker: "h1" })).toContain("outcome.saved");
    expect(detail("football.shot", { by: "home-1", outcome: "blocked" })).toContain("outcome.blocked");
    expect(detail("football.shootout.kick", { by: "home-1", scored: true, person: "h1" })).toContain("outcome.scored");
  });

  it("names the player for both sin-bin events", () => {
    expect(detail("football.sinbin.start", { by: "home-1", person: "h3" })).toContain("Home Three");
    expect(detail("football.sinbin.end", { by: "home-1", person: "h3" })).toContain("Home Three");
  });

  it("never renders a raw person id when a name is unknown", () => {
    const text = detail("football.card", { by: "home-1", color: "red", person: "ghost" })!;
    expect(text).not.toContain("ghost");
    expect(text).toContain("eventCopy.unknownPerson");
  });
});

// ---------------------------------------------------------------------------
// readClock — v2's staleness guard, restated because the stamp depends on it.
// ---------------------------------------------------------------------------

describe("readClock", () => {
  it("formats MM:SS only for a stamp naming the current phase", () => {
    expect(readClock({ asOf: { period: "H1", elapsed: 0 } }, "H1")).toBe("0:00");
    expect(readClock({ asOf: { period: "H1", elapsed: 65 } }, "H1")).toBe("1:05");
    expect(readClock({ asOf: { period: "H1", elapsed: 65 } }, "H2")).toBe("—");
    expect(readClock({}, "H1")).toBe("—");
    expect(readClock({ asOf: { period: "H1", elapsed: -1 } }, "H1")).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

describe("footballSkinV3", () => {
  it("is a FACTORY over t, declares tapModel T, and opts in to phase()", () => {
    const skin = footballSkinV3(t);
    expect(skin.key).toBe("football");
    expect(skin.tapModel).toBe("T");
    expect(typeof skin.phase).toBe("function");
    expect(skin.phase!(view({ state: state({ phase: "final" }) }))).toBe("post");
  });

  it("wires swap, sheets and activityDetail — a builder that exists but is not declared ships INERT", () => {
    const skin = footballSkinV3(t);
    expect(typeof skin.swap).toBe("function");
    expect(typeof skin.sheets).toBe("function");
    expect(typeof skin.activityDetail).toBe("function");
    expect(skin.swap!(view())).toHaveLength(2);
    expect(Object.keys(skin.sheets!(view())).length).toBeGreaterThan(0);
  });

  it("declares no context strip — football has no persistent per-person slot the fold can hold", () => {
    expect(footballSkinV3(t).context).toBeUndefined();
    expect(footballSkinV3(t).contextSelect).toBeUndefined();
  });

  it("leaves cricket alone: it still declares NO swap at all", () => {
    expect(cricketSkinV3(t).swap).toBeUndefined();
  });
});
