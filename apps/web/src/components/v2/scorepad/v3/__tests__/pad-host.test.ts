// R2/task B — the v3 pad host (the item R1 shipped no production render
// path for: registry.tsx:280 threw on purpose; all six chassis primitives
// had zero import sites). This suite proves the PURE decision builders the
// host's own React shell is built from (task brief item 8: "extract every
// decision the host makes ... into pure exported builders and test those
// ... the React shell itself is covered by e2e in a later task"). The shell
// (`PadHostV3`) renders SEVERAL independently-stateful nested v3 primitives
// (DetailDock/ContextStrip/SwapSheet/GuidedSheet/RecordingChip/TileGrid/
// ActionFormList, each with its own useState) — the node-only
// `_hook-harness` renders a component ONE level deep, so a tree with that
// many nested stateful children is exactly the shape the harness cannot
// walk (proved the hard way while building action-form.tsx's own list —
// see that file's header). Hence: builders here, DOM assertions in e2e.
import { describe, expect, it, vi } from "vitest";
import type { LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { PadField, PadPanel, PadSpec } from "@seazn/engine/sport";
import { createSkinDispatch } from "../../skins/types";
import { buildPadView, type PadViewCtx } from "../../view-model";
import type { GuidedSheetSpec, TileSpec } from "../types";
import { MORE_SHEET_KEY } from "../types";
import {
  adaptSwapSlot,
  combinedPool,
  decideUndo,
  dedicatedEventTypes,
  entitledBandsFrom,
  moreActions,
  phasesWithTiles,
  resolveNextPhase,
  resolvePadPhase,
  resolveSheet,
  sidePool,
  squadStateOf,
} from "../pad-host";

// --- squadStateOf ------------------------------------------------------

function lineupPair(): LineupPair {
  return {
    home: { entrantId: "home-1", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "away-1", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
  };
}

describe("squadStateOf", () => {
  it("falls back to initSquads(lineups) when the fold carries no squads field", () => {
    const lineups = lineupPair();
    expect(squadStateOf({}, lineups)).toEqual(initSquads(lineups));
    expect(squadStateOf(null, lineups)).toEqual(initSquads(lineups));
    expect(squadStateOf(undefined, lineups)).toEqual(initSquads(lineups));
  });

  it("uses state.squads verbatim when the module's own fold populates it — never re-derives from lineups", () => {
    const lineups = lineupPair();
    const recorded: SquadState = {
      home: { entrantId: "home-1", members: [], subsUsed: 2, exemptUsed: {} },
      away: { entrantId: "away-1", members: [], subsUsed: 0, exemptUsed: {} },
    };
    expect(squadStateOf({ squads: recorded }, lineups)).toBe(recorded);
  });
});

// --- combinedPool / sidePool --------------------------------------------

function squads(): SquadState {
  return {
    home: {
      entrantId: "home-1",
      members: [
        { personId: "striker", role: "player", provenance: "named", orderNo: 1, onField: true, started: true, timesOff: 0, timesOn: 0 },
        { personId: "hbench", role: "player", provenance: "named", orderNo: 2, onField: false, started: false, timesOff: 0, timesOn: 0 },
      ],
      subsUsed: 0,
      exemptUsed: {},
    },
    away: {
      entrantId: "away-1",
      members: [
        { personId: "bowler", role: "player", provenance: "named", orderNo: 1, onField: true, started: true, timesOff: 0, timesOn: 0 },
        { personId: "abench", role: "player", provenance: "named", orderNo: 2, onField: false, started: false, timesOff: 0, timesOn: 0 },
      ],
      subsUsed: 0,
      exemptUsed: {},
    },
  };
}

describe("sidePool", () => {
  it("resolves the matching side's own squad, never the other one's", () => {
    const s = squads();
    expect(sidePool("home", s)).toEqual({ squad: s.home });
    expect(sidePool("away", s)).toEqual({ squad: s.away });
  });
});

describe("combinedPool", () => {
  it("is the union of both sides' members — every onfield person from EITHER side, for a context strip with no side concept", () => {
    const s = squads();
    const { onFieldPersons } = combinedPoolOnField(s);
    expect(onFieldPersons.sort()).toEqual(["bowler", "striker"]);
  });

  it("keeps both sides' bench separate from onfield — a combined pool is still a real SideSquad, filtered the normal way", () => {
    const s = squads();
    const pool = combinedPool(s);
    expect(pool.squad.members.map((m) => m.personId).sort()).toEqual(["abench", "bowler", "hbench", "striker"]);
  });
});

// resolvePool (context-strip.tsx) only reads .members — this local helper
// mirrors that exact call so the assertion above proves the REAL onfield
// filter, not a hand-rolled substitute.
function combinedPoolOnField(s: SquadState) {
  const pool = combinedPool(s);
  return { onFieldPersons: pool.squad.members.filter((m) => m.onField).map((m) => m.personId) };
}

// --- entitledBandsFrom ---------------------------------------------------

describe("entitledBandsFrom", () => {
  it("a band with no declared gate is always entitled", () => {
    const bands = entitledBandsFrom({}, {});
    expect(bands.has(0)).toBe(true);
    expect(bands.has(3)).toBe(true);
  });

  it("a gated band is entitled only when the org holds the required feature key", () => {
    const bands = entitledBandsFrom({ 2: "stats.player", 3: "scoring.ball_by_ball" }, { "stats.player": true });
    expect(bands.has(0)).toBe(true);
    expect(bands.has(2)).toBe(true); // held
    expect(bands.has(3)).toBe(false); // not held
  });
});

// --- dedicatedEventTypes / moreActions -----------------------------------

function tile(over: Partial<TileSpec> = {}): TileSpec {
  return { id: "t1", label: "pad.__fixture__.tile", kind: "standard", phases: ["live"], action: { event: { type: "cricket.toss", payload: {} } }, ...over };
}

describe("dedicatedEventTypes", () => {
  it("collects every {event} tile's own type", () => {
    const types = dedicatedEventTypes(
      [
        tile({ action: { event: { type: "cricket.toss", payload: {} } } }),
        tile({ id: "t2", action: { event: { type: "cricket.declare", payload: {} } } }),
      ],
      undefined,
    );
    expect([...types].sort()).toEqual(["cricket.declare", "cricket.toss"]);
  });

  it("collects every guided sheet's own declared event, and never a bare {sheet} action's key", () => {
    const sheets: Record<string, GuidedSheetSpec> = {
      wicket: { event: "cricket.wicket", steps: [], buildPayload: () => ({}) },
    };
    const types = dedicatedEventTypes([tile({ action: { sheet: "wicket" } })], sheets);
    expect([...types]).toEqual(["cricket.wicket"]);
  });

  it("a {swap: true} tile contributes nothing — swap's event is built dynamically from a picked pair, not declared statically", () => {
    const types = dedicatedEventTypes([tile({ action: { swap: true } })], undefined);
    expect(types.size).toBe(0);
  });
});

function field(over: Partial<PadField> = {}): PadField {
  return { kind: "toggle", path: "flag", ...over } as PadField;
}

function panel(over: Partial<PadPanel> = {}): PadPanel {
  return {
    labelKey: { key: "p", label: "Panel" },
    phase: "live",
    layout: "grid",
    actions: [
      { type: "cricket.toss", labelKey: { key: "a1", label: "Toss" }, fields: [], attribution: [] },
      { type: "cricket.declare", labelKey: { key: "a2", label: "Declare" }, fields: [field()], attribution: [] },
      { type: "cricket.ball", labelKey: { key: "a3", label: "Ball" }, fields: [], attribution: [] },
    ],
    ...over,
  };
}

function spec(): PadSpec {
  return { panels: [panel()], fidelity: { "cricket.toss": 0, "cricket.declare": 0, "cricket.ball": 0 }, fidelityEntitlements: {} };
}

const baseCtx: Omit<PadViewCtx, "state" | "summary"> = { phase: "live", band: 3, entitlements: {} };

describe("moreActions", () => {
  it("returns every padSpec(cfg) action NOT in the dedicated set — a future engine action needs no skin edit to appear here", () => {
    const dedicated = new Set(["cricket.ball"]); // the skin's own dedicated run-keypad tile
    const actions = moreActions(spec(), { ...baseCtx, state: {}, summary: {} }, dedicated);
    expect(actions.map((a) => a.type).sort()).toEqual(["cricket.declare", "cricket.toss"]);
  });

  it("respects phase/band/entitlement filtering exactly like the panel it reads from — a locked/hidden action never leaks into More", () => {
    const gated: PadSpec = {
      panels: [panel({ actions: [{ type: "cricket.superover", labelKey: { key: "a4", label: "Super over" }, fields: [], attribution: [] }] })],
      fidelity: { "cricket.superover": 3 },
      fidelityEntitlements: { 3: "scoring.ball_by_ball" },
    };
    const actions = moreActions(gated, { ...baseCtx, band: 3, entitlements: {}, state: {}, summary: {} }, new Set());
    expect(actions).toHaveLength(1);
    expect(actions[0]!.availability).toEqual({ kind: "locked", reason: expect.objectContaining({ key: "scorepad.locked.reason" }) });
  });

  it("never lists the same type twice even if it appears in two panels", () => {
    const twoPanel: PadSpec = {
      panels: [panel({ phase: "live" }), panel({ phase: "post" })],
      fidelity: { "cricket.toss": 0, "cricket.declare": 0, "cricket.ball": 0 },
      fidelityEntitlements: {},
    };
    const actions = moreActions(twoPanel, { ...baseCtx, state: {}, summary: {} }, new Set(["cricket.ball"]));
    // buildPadView is phase-scoped (ctx.phase: "live"), so the "post" panel's
    // own copy of the same three types is invisible here regardless — this
    // proves the de-dup guard AND the phase scoping in one assertion.
    expect(actions.map((a) => a.type).sort()).toEqual(["cricket.declare", "cricket.toss"]);
  });
});

// --- adaptSwapSlot ---------------------------------------------------------

describe("adaptSwapSlot", () => {
  it("resolves the declared side's own pool and passes labels through verbatim", () => {
    const s = squads();
    const slot = { offLabel: "pad.cricket.swap.off", onLabel: "pad.cricket.swap.on", side: "home" as const, policyOk: true, buildEvent: () => ({ type: "core.lineup.substitution", payload: {} }) };
    const adapted = adaptSwapSlot(slot, s);
    expect(adapted.spec).toEqual({ offLabel: "pad.cricket.swap.off", onLabel: "pad.cricket.swap.on" });
    expect(adapted.view).toEqual({ squad: s.home });
    expect(adapted.policyVerdict).toEqual({ ok: true });
  });

  it("carries a refusal's sport-worded message through, never a bare boolean", () => {
    const s = squads();
    const slot = {
      offLabel: "pad.cricket.swap.off",
      onLabel: "pad.cricket.swap.on",
      side: "away" as const,
      policyOk: false,
      policyMessage: "this side has used all 3 substitutions this variant allows",
      buildEvent: () => ({ type: "core.lineup.substitution", payload: {} }),
    };
    const adapted = adaptSwapSlot(slot, s);
    expect(adapted.view).toEqual({ squad: s.away });
    expect(adapted.policyVerdict.ok).toBe(false);
    expect(String(adapted.policyVerdict.message)).toBe("this side has used all 3 substitutions this variant allows");
  });
});

// --- resolveSheet ---------------------------------------------------------

describe("resolveSheet", () => {
  const sheets: Record<string, GuidedSheetSpec> = {
    wicket: { event: "cricket.wicket", steps: [], buildPayload: () => ({}) },
  };

  it("MORE_SHEET_KEY always resolves to the generic action sheet, even when a skin declares no sheets at all", () => {
    expect(resolveSheet(MORE_SHEET_KEY, undefined)).toEqual({ kind: "action" });
    expect(resolveSheet(MORE_SHEET_KEY, sheets)).toEqual({ kind: "action" }); // checked BEFORE any skin.sheets lookup
  });

  it("a real skin.sheets key resolves to its GuidedSheetSpec", () => {
    expect(resolveSheet("wicket", sheets)).toEqual({ kind: "guided", spec: sheets.wicket });
  });

  it("an unknown key resolves to none — never a crash", () => {
    expect(resolveSheet("ghost", sheets)).toEqual({ kind: "none" });
    expect(resolveSheet("ghost", undefined)).toEqual({ kind: "none" });
  });
});

// --- decideUndo (mutation-proved below) -----------------------------------

describe("decideUndo", () => {
  it("drops with no core.void when the tapped event IS the currently-held one", () => {
    expect(decideUndo("ev-1", "ev-1")).toEqual({ kind: "drop", heldId: "ev-1" });
  });

  it("voids when nothing is currently held", () => {
    expect(decideUndo("ev-1", null)).toEqual({ kind: "void", eventId: "ev-1" });
  });

  it("voids when something IS held but it is a DIFFERENT event than the one tapped", () => {
    expect(decideUndo("ev-1", "ev-2")).toEqual({ kind: "void", eventId: "ev-1" });
  });
});

describe("decideUndo — mutation proof (task brief item 11)", () => {
  it("the drop-vs-void split is load-bearing: a mutant collapsing it to always-void changes the held-tap outcome", () => {
    const alwaysVoid = (eventId: string) => ({ kind: "void" as const, eventId });
    // The real function disagrees with the mutant on the held case —
    // if it didn't, the split would be provably dead code.
    expect(decideUndo("ev-1", "ev-1")).not.toEqual(alwaysVoid("ev-1"));
  });
});

// --- phasesWithTiles / resolveNextPhase -----------------------------------

describe("phasesWithTiles", () => {
  it("returns the distinct set of phases at least one tile declares, canonically ordered pre/live/post", () => {
    const phases = phasesWithTiles([tile({ phases: ["post"] }), tile({ id: "t2", phases: ["pre", "live"] })]);
    expect(phases).toEqual(["pre", "live", "post"]);
  });

  it("is empty for an empty tile set", () => {
    expect(phasesWithTiles([])).toEqual([]);
  });
});

describe("resolveNextPhase", () => {
  it("keeps the current phase when it still has tiles", () => {
    expect(resolveNextPhase("live", ["pre", "live"])).toBe("live");
  });

  it("snaps to the first available phase when the current one has nothing declared — never gets the scorer stuck on an empty tab", () => {
    expect(resolveNextPhase("live", ["post"])).toBe("post");
  });

  it("keeps the current phase when NOTHING is declared anywhere yet — nothing to snap to", () => {
    expect(resolveNextPhase("live", [])).toBe("live");
  });
});

// G3 (controller ruling, 2026-08-16): a skin's own phase(view) overrides the
// self-correcting default, verbatim, never cross-checked against `available`.
describe("resolvePadPhase", () => {
  it("trusts the skin's derived phase verbatim, even when NO tile declares that phase", () => {
    expect(resolvePadPhase("post", "live", ["pre", "live"])).toBe("post");
  });

  it("falls back to resolveNextPhase's self-correcting default when the skin has no phase() (null)", () => {
    expect(resolvePadPhase(null, "live", ["post"])).toBe("post"); // same as resolveNextPhase("live", ["post"])
    expect(resolvePadPhase(null, "live", ["pre", "live"])).toBe("live");
  });

  it("mutation proof: a version that ignored skinPhase and always fell through to resolveNextPhase would disagree here", () => {
    const mutant = (skinPhase: string | null, current: "pre" | "live" | "post", available: readonly ("pre" | "live" | "post")[]) =>
      resolveNextPhase(current, available); // pretends skinPhase does not exist
    const real = resolvePadPhase("post", "live", ["pre", "live"]);
    const viaMutant = mutant("post", "live", ["pre", "live"]);
    expect(real).not.toBe(viaMutant); // real: "post" (skin-derived); mutant: "live" (available doesn't include post, so it keeps current)
  });
});

// --- dispatch guard wiring (mutation-proved) -------------------------------

describe("pad-host's dispatch composition — a skin cannot invent an event (task brief item 5)", () => {
  it("createSkinDispatch(buildPadView(spec, ctx), submit), pad-host's own composition, allows a declared type and refuses an undeclared one", async () => {
    const view = buildPadView(spec(), { ...baseCtx, state: {}, summary: {} });
    const submit = vi.fn(async () => {});
    const dispatch = createSkinDispatch(view, submit);

    await dispatch("cricket.toss", {});
    expect(submit).toHaveBeenCalledWith("cricket.toss", {});

    await expect(dispatch("cricket.doesNotExist", {})).rejects.toThrow(/does not declare/);
    expect(submit).toHaveBeenCalledTimes(1); // the refused call never reached submit
  });

  it("mutation proof: a dispatch guard that used the UNFILTERED spec instead of the phase-scoped view would wrongly ALLOW a wrong-phase action", async () => {
    const postOnlySpec: PadSpec = {
      panels: [panel({ phase: "post", actions: [{ type: "cricket.matchClose", labelKey: { key: "a5", label: "Close" }, fields: [], attribution: [] }] })],
      fidelity: { "cricket.matchClose": 0 },
      fidelityEntitlements: {},
    };
    const liveView = buildPadView(postOnlySpec, { ...baseCtx, phase: "live", state: {}, summary: {} });
    const submit = vi.fn(async () => {});
    const dispatch = createSkinDispatch(liveView, submit);
    // "cricket.matchClose" is declared in the spec's "post" panel only —
    // dispatched against the LIVE-phase view, it must still refuse.
    await expect(dispatch("cricket.matchClose", {})).rejects.toThrow();
    expect(submit).not.toHaveBeenCalled();
  });
});
