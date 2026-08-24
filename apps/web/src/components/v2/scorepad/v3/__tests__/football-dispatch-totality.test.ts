// R3/task B2 — the wave's headline acceptance: every one of the engine's own
// `football.*` event types must be reachable from the NEW v3 surface, or the
// registry flip (registry-totality.test.ts) ships a pad that can render but
// cannot record everything the engine understands.
//
// Deliberately a SEPARATE file from registry-totality.test.ts (which proves
// the LANE decision) and from skins/__tests__/football.test.ts (the skin's own
// unit tests): this is the cross-cutting one, spanning the skin
// (`skins/football.tsx`'s buildTiles/buildSheets/buildSwap), the host
// (`pad-host.tsx`'s dedicatedEventTypes/moreActions) and the engine's own
// `padSpec(cfg)`/`eventSchemas` — the only place all three are measured
// together against the engine's OWN declared vocabulary. Same shape as
// `cricket-dispatch-totality.test.ts`, kept parallel on purpose.
//
// FOUR SURFACES, per ruling R3-4: dedicated TILES (the two Goal tiles), the
// skin's GUIDED SHEETS (card ×6, period, penalty), its SWAP slots
// (`football.sub`), and the chassis's generic More sheet, which lists every
// `padSpec(cfg)` action the skin does not already dedicate — cfg-gated exactly
// as the engine gates it (the shoot-out panel needs `cfg.shootout` AND a
// `state.phase === "SHOOTOUT"` runtime gate; ET markers need
// `extraTime.enabled`).
//
// Driven off the engine's own `football.eventSchemas` and `variants`, never a
// hand-written list of nine — so this reds the moment the engine's vocabulary
// changes, not the moment someone forgets to update a constant here.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { SquadState } from "@seazn/engine/core";
import { buildSheets, buildSwap, buildTiles } from "../skins/football";
import { dedicatedEventTypes, moreActions } from "../pad-host";
import type { GuidedSheetSpec, PadHostView, SwapSlot, TileSpec } from "../types";
import { grantAllEntitlements } from "../../__tests__/_cfg-space";

const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule?.padSpec || !footballModule.eventSchemas) {
  throw new Error("football module (with padSpec/eventSchemas) not found in builtinModules — engine export moved?");
}
const football = footballModule;
// Read straight off `footballModule`, not the alias — `padSpec`/`eventSchemas`
// are OPTIONAL on AnySportModule and tsc's narrowing does not survive being
// re-derived through a second variable (the same pattern
// cricket-dispatch-totality.test.ts uses, for the same reason).
const padSpecFor = footballModule.padSpec;
const ALL_EVENT_TYPES = new Set(Object.keys(footballModule.eventSchemas));

const t = (key: string): string => key;

// ---------------------------------------------------------------------------
// cfg construction — every shipped variant preset, plus the two leaf overrides
// no preset sets (the same "a cfg leaf no shipped variant turns on" trap
// `__tests__/_cfg-space.ts` exists to close for the v2 skins' coverage sweep).
// ---------------------------------------------------------------------------

function variantNames(): string[] {
  return Object.keys((football.variants ?? {}) as Record<string, unknown>);
}

function cfgFor(variant: string, overrides: Record<string, unknown> = {}): unknown {
  const presets = (football.variants ?? {}) as Record<string, Record<string, unknown>>;
  const preset = presets[variant];
  if (!preset) throw new Error(`football module has no "${variant}" variant preset`);
  return football.configSchema.parse({ ...preset, ...overrides });
}

// ---------------------------------------------------------------------------
// Minimal synthetic views — a real fold is not needed: every builder swept
// here is a pure function of its input, and reachability depends only on
// state.phase / cfg, never on realistic scoreline numbers. The squad shape IS
// football's own private projection (`FootballSquad`), because that is what
// the skin reads.
// ---------------------------------------------------------------------------

function squads(): SquadState {
  return {
    home: { entrantId: "home-1", members: [], subsUsed: 0, exemptUsed: {} },
    away: { entrantId: "away-1", members: [], subsUsed: 0, exemptUsed: {} },
  };
}

function liveState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "H1",
    entrants: { home: "home-1", away: "away-1" },
    goals: { home: 0, away: 0 },
    periods: [],
    cards: [],
    squads: {
      home: { onPitch: ["h1", "h2"], bench: ["h3"], offUsed: [], sentOff: [] },
      away: { onPitch: ["a1", "a2"], bench: ["a3"], offUsed: [], sentOff: [] },
    },
    shootout: null,
    ...over,
  };
}

function baseView(cfg: unknown, state: unknown): PadHostView {
  return {
    cfg,
    state,
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: {},
    squads: squads(),
    events: [],
    contextOverrides: {},
  };
}

function tileEventTypes(tiles: readonly TileSpec[]): Set<string> {
  const out = new Set<string>();
  for (const tile of tiles) if ("event" in tile.action) out.add(tile.action.event.type);
  return out;
}

function sheetEventTypes(sheets: Record<string, GuidedSheetSpec>): Set<string> {
  return new Set(Object.values(sheets).map((s) => s.event));
}

function swapEventTypes(slots: readonly SwapSlot[]): Set<string> {
  return new Set(slots.map((slot) => slot.eventType));
}

interface SweepResult {
  viaTiles: Set<string>;
  viaSheets: Set<string>;
  viaSwap: Set<string>;
  viaMore: Set<string>;
}

function sweep(): SweepResult {
  const viaTiles = new Set<string>();
  const viaSheets = new Set<string>();
  const viaSwap = new Set<string>();
  const viaMore = new Set<string>();

  const cases: { cfg: unknown; shootout?: boolean }[] = [
    // Every shipped preset — 11-a-side, youth, small-sided, mini-soccer.
    ...variantNames().map((name) => ({ cfg: cfgFor(name) })),
    // The two leaves no preset turns on. Extra time widens the marker list;
    // the shoot-out adds a whole panel with its own runtime gate.
    { cfg: cfgFor("11-a-side", { extraTime: { enabled: true, halfMinutes: 15 } }) },
    { cfg: cfgFor("11-a-side", { shootout: true }), shootout: true },
  ];

  for (const { cfg, shootout } of cases) {
    const live = baseView(cfg, liveState());
    const tiles = buildTiles(live);
    const sheets = buildSheets(live);
    const slots = buildSwap(live, t);
    for (const type of tileEventTypes(tiles)) viaTiles.add(type);
    for (const type of sheetEventTypes(sheets)) viaSheets.add(type);
    for (const type of swapEventTypes(slots)) viaSwap.add(type);

    let dedicated = dedicatedEventTypes(tiles, sheets, slots);
    let ctxState: Record<string, unknown> = liveState();

    if (shootout) {
      // The panel's own runtime gate is `state.phase === "SHOOTOUT"`, so the
      // kick is only reachable from a state that has actually reached one —
      // exactly the state the fold produces under `cfg.shootout`.
      const so = baseView(cfg, liveState({ phase: "SHOOTOUT", shootout: { kicks: [] } }));
      const soTiles = buildTiles(so);
      for (const type of tileEventTypes(soTiles)) viaTiles.add(type);
      for (const type of swapEventTypes(buildSwap(so, t))) viaSwap.add(type);
      dedicated = new Set([...dedicated, ...dedicatedEventTypes(soTiles, buildSheets(so), buildSwap(so, t))]);
      ctxState = liveState({ phase: "SHOOTOUT", shootout: { kicks: [] } });
    }

    const spec = padSpecFor(cfg);
    const entitlements = grantAllEntitlements(spec);
    // Football declares every panel at "live" (football.ts's own comment), so
    // "live" is the only phase that can reach anything at all — swept anyway
    // so this stays honest if a pre/post panel is ever added.
    for (const phase of ["live", "pre", "post"] as const) {
      for (const action of moreActions(spec, { state: ctxState, summary: {}, phase, band: 3, entitlements }, dedicated)) {
        viaMore.add(action.type);
      }
    }
  }

  return { viaTiles, viaSheets, viaSwap, viaMore };
}

describe("football dispatch-guard totality (R3/task B2 headline)", () => {
  it("the engine declares exactly 9 football.* event types (pins today's known-good shape)", () => {
    expect(ALL_EVENT_TYPES.size).toBe(9);
  });

  it("every football.* event type is reachable via tiles, sheets, the swap sheet or More — swept across every shipped cfg", () => {
    const { viaTiles, viaSheets, viaSwap, viaMore } = sweep();

    // Each of the four surfaces pulls real weight — a vacuously empty bucket
    // would let the union assertion below pass for the wrong reason.
    expect([...viaTiles], "tiles reached nothing").not.toEqual([]);
    expect([...viaSheets], "guided sheets reached nothing").not.toEqual([]);
    expect([...viaSwap], "the swap sheet reached nothing").not.toEqual([]);
    expect([...viaMore], "the More sheet reached nothing").not.toEqual([]);

    const union = new Set([...viaTiles, ...viaSheets, ...viaSwap, ...viaMore]);
    const missing = [...ALL_EVENT_TYPES].filter((type) => !union.has(type)).sort();
    expect(missing, `unreachable football.* event types: ${missing.join(", ")}`).toEqual([]);

    // The dispatch guard's other half, read statically: nothing reachable here
    // invents a type the engine does not declare. `createSkinDispatch` enforces
    // this at runtime for whatever a scorer actually taps; this is the same
    // fact proved off the built specs, for every cfg this sweep explores.
    const invented = [...union].filter((type) => !ALL_EVENT_TYPES.has(type)).sort();
    expect(invented, `reachable type not in the engine's own eventSchemas: ${invented.join(", ")}`).toEqual([]);
  });

  it("the four More-sheet types are exactly the ones ruling R3-4 routes there, and no dedicated type joins them", () => {
    const { viaMore } = sweep();
    expect([...viaMore].sort()).toEqual([
      "football.shootout.kick",
      "football.shot",
      "football.sinbin.end",
      "football.sinbin.start",
    ]);
  });

  // The de-duplication ruling this wave took (see `dedicatedEventTypes`'
  // own doc, pad-host.tsx). A swap tile used to contribute nothing to the
  // dedicated set, so `football.sub` appeared BOTH on its Sub tile and again
  // as an un-narrowed generic form inside More — the same two-divergent-entry-
  // points defect R2c closed for `cricket.retire`.
  it("football.sub is reachable through the swap sheet, and NO LONGER through the generic More sheet", () => {
    const { viaSwap, viaMore } = sweep();
    expect(viaSwap.has("football.sub")).toBe(true);
    expect(viaMore.has("football.sub")).toBe(false);
  });

  it("the card, period and penalty flows are the skin's own sheets, never a duplicate generic form", () => {
    const { viaSheets, viaMore } = sweep();
    for (const type of ["football.card", "football.period", "football.penalty"]) {
      expect(viaSheets.has(type), type).toBe(true);
      expect(viaMore.has(type), `${type} is duplicated into More`).toBe(false);
    }
  });

  it("the goal is a direct tile tap — no sheet, no form, side-level on commit", () => {
    const { viaTiles, viaMore } = sweep();
    expect(viaTiles.has("football.goal")).toBe(true);
    expect(viaMore.has("football.goal")).toBe(false);
  });
});
