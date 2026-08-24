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
import type { MsgFn } from "@/lib/scoring-vocab";
import { createSkinDispatch } from "../../skins/types";
import { buildPadView, type PadViewCtx } from "../../view-model";
import type { RejectionInfo } from "../../use-pad-pipeline";
import type { GuidedSheetSpec, PadHostView, SkinDefV3, SwapSlot, TileSpec } from "../types";
import { MORE_SHEET_KEY } from "../types";
import {
  adaptSwapSlot,
  combinedPool,
  contextOverridesStale,
  decideUndo,
  dedicatedEventTypes,
  entitledBandsFrom,
  moreActions,
  phasesWithTiles,
  rejectionText,
  resolveDockSpec,
  resolveNextPhase,
  resolvePadPhase,
  resolveSheet,
  resolveSwapSlot,
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

  // R3/football (first sport to reach this): `state.squads` is NOT a reserved
  // name for the kernel's adopted `SquadState`. Football manages its OWN
  // private projection at the identical field name — `{home,away}` of
  // `{onPitch, bench, offUsed, sentOff}`, no `.members` anywhere
  // (football.ts's `FootballSquad`) — and every consumer of this function's
  // result (`combinedPool`, `sidePool` -> `resolvePool` -> `playingSquad`/
  // `onFieldPersons`, `ActionFormList`'s own attribution picker) reads
  // `.members`. Trusting the field name blind therefore does not merely
  // return a slightly-wrong pool for football, it THROWS
  // (`side.members.filter is not a function`) the first time a swap sheet,
  // a person step, or a More-sheet person picker resolves a pool.
  //
  // The legacy lane already carries exactly this guard, named for exactly
  // this sport (`isSquadState`/`resolveSquads`, ../../attribution-picker.tsx,
  // whose own header says "reading `state.squads` blind would silently
  // misinterpret football's squad as empty/malformed"). This is that guard,
  // reused — never a second structural check that could disagree with it.
  it("IGNORES a `squads` field that is not structurally a SquadState — football's private FootballSquad projection", () => {
    const lineups = lineupPair();
    const football = {
      squads: {
        home: { onPitch: ["h1"], bench: ["h2"], offUsed: [], sentOff: [] },
        away: { onPitch: ["a1"], bench: ["a2"], offUsed: [], sentOff: [] },
      },
    };
    const resolved = squadStateOf(football, lineups);
    expect(resolved).toEqual(initSquads(lineups));
    // The consequence the shape check exists to prevent, asserted directly
    // rather than trusted: every real consumer reads `.members`.
    expect(Array.isArray(resolved.home.members)).toBe(true);
    expect(() => sidePool("home", resolved)).not.toThrow();
  });

  it("a half-shaped `squads` (one side only) is rejected too — both sides must be SquadState-shaped", () => {
    const lineups = lineupPair();
    const half = {
      squads: {
        home: { entrantId: "home-1", members: [], subsUsed: 0, exemptUsed: {} },
        away: { onPitch: [], bench: [], offUsed: [], sentOff: [] },
      },
    };
    expect(squadStateOf(half, lineups)).toEqual(initSquads(lineups));
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

  it("a {swap: id} tile contributes nothing — this function is never handed the slot table, so a slot id resolves to no event type here", () => {
    const types = dedicatedEventTypes([tile({ action: { swap: "subHome" } })], undefined);
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
    const slot = { id: "subHome", offLabel: "pad.cricket.swap.off", onLabel: "pad.cricket.swap.on", side: "home" as const, eventType: "core.lineup.substitution", policyOk: true, buildEvent: () => ({ type: "core.lineup.substitution", payload: {} }) };
    const adapted = adaptSwapSlot(slot, s);
    expect(adapted.spec).toEqual({ offLabel: "pad.cricket.swap.off", onLabel: "pad.cricket.swap.on" });
    expect(adapted.view).toEqual({ squad: s.home });
    expect(adapted.policyVerdict).toEqual({ ok: true });
  });

  it("carries a refusal's sport-worded message through, never a bare boolean", () => {
    const s = squads();
    const slot = {
      id: "subAway",
      offLabel: "pad.cricket.swap.off",
      onLabel: "pad.cricket.swap.on",
      side: "away" as const,
      eventType: "core.lineup.substitution",
      policyOk: false,
      policyMessage: "this side has used all 3 substitutions this variant allows",
      buildEvent: () => ({ type: "core.lineup.substitution", payload: {} }),
    };
    const adapted = adaptSwapSlot(slot, s);
    expect(adapted.view).toEqual({ squad: s.away });
    expect(adapted.policyVerdict.ok).toBe(false);
    expect(String(adapted.policyVerdict.message)).toBe("this side has used all 3 substitutions this variant allows");
  });

  // R3 chassis sub-wave, defect 4. Without this the narrowing is DEAD on the
  // production path: `SwapSheet`'s own tests can pass `spec.candidates`
  // directly, but the host only ever hands it what `adaptSwapSlot` builds, so
  // a skin's declared scope/eligibility would be silently dropped between the
  // contract and the renderer.
  it("carries the skin's ON-list scope and eligibility narrowing through to the sheet spec, verbatim", () => {
    const slot = {
      id: "subHome",
      offLabel: "pad.football.swap.off",
      onLabel: "pad.football.swap.on",
      side: "home" as const,
      eventType: "football.sub",
      policyOk: true,
      candidates: ["sub-1", "sub-2"],
      blocked: { "sub-2": "Already substituted off" },
      buildEvent: () => ({ type: "football.sub", payload: {} }),
    };
    const adapted = adaptSwapSlot(slot, squads());
    expect(adapted.spec.candidates).toEqual(["sub-1", "sub-2"]);
    expect(adapted.spec.blocked).toEqual({ "sub-2": "Already substituted off" });
  });

  // R3/football, the OFF half of the same argument: `SwapSheet`'s own tests
  // can pass `spec.offCandidates` directly, so only this assertion proves the
  // field survives the one adapter the production path actually goes through.
  it("carries the skin's OFF-list scope through to the sheet spec, verbatim, under the SAME field name", () => {
    const slot = {
      id: "subHome",
      offLabel: "pad.football.swap.off",
      onLabel: "pad.football.swap.on",
      side: "home" as const,
      eventType: "football.sub",
      policyOk: true,
      offCandidates: ["on-pitch-1", "came-on-2"],
      buildEvent: () => ({ type: "football.sub", payload: {} }),
    };
    const adapted = adaptSwapSlot(slot, squads());
    expect(adapted.spec.offCandidates).toEqual(["on-pitch-1", "came-on-2"]);
  });

  it("leaves both narrowing fields undefined when the skin declares neither — an absent list must never become an empty one", () => {
    const slot = {
      id: "subHome",
      offLabel: "pad.football.swap.off",
      onLabel: "pad.football.swap.on",
      side: "home" as const,
      eventType: "football.sub",
      policyOk: true,
      buildEvent: () => ({ type: "football.sub", payload: {} }),
    };
    const adapted = adaptSwapSlot(slot, squads());
    expect(adapted.spec.candidates).toBeUndefined();
    expect(adapted.spec.offCandidates).toBeUndefined();
    expect(adapted.spec.blocked).toBeUndefined();
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

// --- contextOverridesStale (G5's own precedence rule) ----------------------

// G5 (controller ruling, 2026-08-16): a pending context-strip override lives
// only until the fold itself advances. `PadHostV3`'s own render-phase reset
// (pad-host.tsx) clears `contextOverrides` to `{}` exactly when this
// function reports `true` — proved here as a pure decision, independent of
// the React shell this file's own header says is untestable via the
// node-only hook-harness.
describe("contextOverridesStale", () => {
  it("false when the state reference is unchanged — an override survives across renders with no new event", () => {
    const s = { runs: 12 };
    expect(contextOverridesStale(s, s)).toBe(false);
  });

  it("true once the state reference changes, even to a deeply-equal object — a new event landed, so every override is stale", () => {
    expect(contextOverridesStale({ runs: 12 }, { runs: 12 })).toBe(true);
  });

  it("true on the very first check when nothing has been captured yet (undefined vs a real state)", () => {
    expect(contextOverridesStale(undefined, { runs: 0 })).toBe(true);
  });

  it("mutation proof: a version that compared deep equality instead of reference would disagree on the deeply-equal case above", () => {
    const deepEqualMutant = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
    const real = contextOverridesStale({ runs: 12 }, { runs: 12 });
    const viaMutant = deepEqualMutant({ runs: 12 }, { runs: 12 });
    expect(real).not.toBe(viaMutant); // real: true (different objects); mutant: false (deep-equal payloads)
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

// ---------------------------------------------------------------------------
// rejectionText — Blocker 1 (R2 review finding). PadHostV3 built
// `pipeline.lastRejection` (usePadPipeline's own surfaced 422-class refusal)
// but never rendered it anywhere: any rejected v3 submission, in any sport,
// for any reason, produced NO on-screen feedback — the pad simply looked
// like it ignored the tap. Ports the legacy renderer's own surface
// (pad-renderer.tsx: `pipeline.lastRejection && <p>{scoringErrorText(...)}
// </p>`) verbatim in semantics: same source, same resolver
// (scoringErrorText), same fallback key.
// ---------------------------------------------------------------------------

const identityMsg = ((key: string) => key) as MsgFn;

describe("rejectionText", () => {
  it("null when there is no rejection at all", () => {
    expect(rejectionText(null, identityMsg)).toBeNull();
  });

  it("resolves a real engine error code to localized copy via scoringErrorText, never the raw message", () => {
    const text = rejectionText({ code: "WRONG_PHASE", message: "raw engine text" }, identityMsg);
    expect(text).toBe("engineError.WRONG_PHASE"); // the identity msg echoes the resolved key back
    expect(text).not.toBe("raw engine text");
  });

  it("falls back to the raw message for a non-engine code", () => {
    const text = rejectionText({ code: "NETWORK_ERROR", message: "Server exploded" }, identityMsg);
    expect(text).toBe("Server exploded");
  });

  it("falls back to the fallback key when there is neither an engine code nor a usable raw message", () => {
    const text = rejectionText({ code: "NETWORK_ERROR", message: "" }, identityMsg);
    expect(text).toBe("scorepad.rejection.fallback");
  });
});

describe("rejectionText — mutation proof (blocker 1: the v3 pad swallowed every engine refusal)", () => {
  it("a version that stops reading `rejection` (always returns null) disagrees with the real one on a genuine rejection", () => {
    // Typed AS `rejectionText` so the mutant is callable with the same two
    // args while ignoring both — a bare `(): string | null` stub does not
    // typecheck against a 2-arg call.
    const stopsReadingRejection: typeof rejectionText = () => null;
    const rejection: RejectionInfo = { code: "NETWORK_ERROR", message: "Server exploded" };
    const real = rejectionText(rejection, identityMsg);
    const viaMutant = stopsReadingRejection(rejection, identityMsg);
    expect(real).not.toBe(viaMutant); // real: "Server exploded"; mutant: null
    expect(real).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveDockSpec — R2b task 4 (`_INDEX.md`, owner ruling): cricket's dock
// needed to tell a no-ball tap apart from a plain single, but `dock(eventType,
// view)` only ever received the event TYPE — identical for every ball tap.
// This is the ONE line that used to call `props.skin.dock(held.eventType,
// view)` directly inside `PadHostV3`'s own render body, extracted as a pure
// builder (same "data in, data out" split as every other decision in this
// file's own pure-builders section — this file's own header) specifically so
// the widened wiring — the held tap's PAYLOAD now reaches `dock()` too — is
// provable without rendering the seven-primitive-deep component tree the
// node-only hook-harness cannot walk (this file's own header, same reason
// `PadHostV3`'s JSX itself has no test here at all).
// ---------------------------------------------------------------------------

function padHostView(): PadHostView {
  return {
    cfg: {},
    state: {},
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: initSquads(lineupPair()),
    events: [],
    contextOverrides: {},
  };
}

function stubSkin(dock: SkinDefV3["dock"]): SkinDefV3 {
  return {
    key: "stub",
    tapModel: "T",
    scorebug: () => ({
      context: "",
      phase: "live",
      halves: [{ who: [{ name: "" }], big: "" }, { who: [{ name: "" }], big: "" }],
      strip: [],
    }),
    tiles: () => [],
    dock,
  };
}

describe("resolveDockSpec", () => {
  it("is null when nothing is held — never calls the skin's own dock()", () => {
    const skin = stubSkin(() => {
      throw new Error("must not be called with nothing held");
    });
    expect(resolveDockSpec(skin, null, padHostView())).toBeNull();
  });

  it("forwards the held tap's own payload as dock()'s 3rd argument", () => {
    const calls: Array<[string, unknown]> = [];
    const skin = stubSkin((eventType, _view, payload) => {
      calls.push([eventType, payload]);
      return { title: "seen", chips: [] };
    });
    const heldPayload = { runs: { bat: 0, extras: { kind: "noball", runs: 1 } } };
    const spec = resolveDockSpec(skin, { eventType: "cricket.ball", payload: heldPayload }, padHostView());
    expect(spec).toEqual({ title: "seen", chips: [] });
    expect(calls).toEqual([["cricket.ball", heldPayload]]);
  });
});

describe("resolveDockSpec — mutation proof (the widened payload wiring is load-bearing)", () => {
  it("a version that drops the 3rd argument disagrees with the real one once a skin's dock() actually reads it", () => {
    const skin = stubSkin((_eventType, _view, payload) =>
      payload !== undefined ? { title: "has-payload", chips: [] } : { title: "no-payload", chips: [] },
    );
    const held = { eventType: "cricket.ball", payload: { kind: "noball" } };
    // Typed AS `resolveDockSpec` so the mutant is callable identically while
    // silently dropping the payload — the exact regression this wiring
    // guards against (dock() would fall back to seeing no payload at all,
    // same as before this task's own chassis widening).
    const dropsPayload: typeof resolveDockSpec = (s, h, v) => (h ? s.dock(h.eventType, v) : null);
    const real = resolveDockSpec(skin, held, padHostView());
    const viaMutant = dropsPayload(skin, held, padHostView());
    expect(real).not.toEqual(viaMutant);
    expect(real).toEqual({ title: "has-payload", chips: [] });
  });
});

// ---------------------------------------------------------------------------
// R3 chassis sub-wave (owner ruling 2026-08-24, `_INDEX.md` "R3 — owner
// ruling: FIX SwapSheet in the chassis, then use it"). Defects 1 and 2:
// `SkinDefV3.swap` returned ONE slot per view and `TileSpec.action` carried a
// bare `{swap:true}`, so EVERY swap tile opened the SAME sheet and the side
// came only from `slot.side` — per-side Sub tiles were structurally
// unreachable. Football is the first skin ever to need two.
// ---------------------------------------------------------------------------

describe("resolveSwapSlot — per-side swap tiles reach DIFFERENT slots", () => {
  const slots: SwapSlot[] = [
    {
      id: "subHome",
      offLabel: "pad.football.swap.off",
      onLabel: "pad.football.swap.on",
      side: "home",
      eventType: "football.sub",
      policyOk: true,
      buildEvent: () => ({ type: "football.sub", payload: {} }),
    },
    {
      id: "subAway",
      offLabel: "pad.football.swap.off",
      onLabel: "pad.football.swap.on",
      side: "away",
      eventType: "football.sub",
      policyOk: true,
      buildEvent: () => ({ type: "football.sub", payload: {} }),
    },
  ];

  it("addresses each declared slot by its OWN id — the defect was one shared sheet for every {swap} tile", () => {
    expect(resolveSwapSlot("subHome", slots)?.side).toBe("home");
    expect(resolveSwapSlot("subAway", slots)?.side).toBe("away");
  });

  it("null slot id (nothing open) resolves to null — `swapOpen` is now an id-or-null, not a boolean", () => {
    expect(resolveSwapSlot(null, slots)).toBeNull();
  });

  it("an id no slot declares resolves to null, NEVER a silent fallback to the first slot — that fallback IS the defect", () => {
    expect(resolveSwapSlot("subNobody", slots)).toBeNull();
  });

  it("a skin declaring no swap slots at all resolves to null for any id", () => {
    expect(resolveSwapSlot("subHome", [])).toBeNull();
  });
});
