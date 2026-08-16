// R2/task E — the wave's headline acceptance: every one of the engine's own
// `cricket.*` event types must be reachable from the NEW v3 surface, or the
// flip (registry-totality.test.ts) ships a pad that can render but cannot
// actually record everything the engine understands. This is deliberately a
// SEPARATE file from registry-totality.test.ts (which proves the LANE
// decision) and from skins/__tests__/cricket.test.ts (task C's own skin
// unit tests) — this file is the cross-cutting one, spanning the skin
// (`skins/cricket.tsx`'s buildTiles/buildSheets/buildSwap), the host
// (`pad-host.tsx`'s dedicatedEventTypes/moreActions) and the engine's own
// `padSpec(cfg)`/`eventSchemas`, and it is the only place that measures all
// three together against the engine's OWN declared vocabulary.
//
// Reachability comes from exactly three surfaces (cricket.tsx's own header,
// "OWNER HYBRID RULING"): the skin's dedicated TILES (run keypad, wide,
// declare), its GUIDED/SWAP SHEETS (toss, wicket, review, innings-close,
// retire), and the chassis's generic "More" sheet, which lists every
// `padSpec(cfg)` action the skin does not already dedicate — cfg-gated
// exactly like the engine gates it (declare/follow-on/match-close need
// `inningsPerSide===2`, follow-on additionally `cfg.followOn?.enabled`,
// super-over `cfg.superOver`, revise `cfg.dls.enabled`). No SHIPPED variant
// preset turns superOver/dls.enabled on (the same documented trap
// `__tests__/_cfg-space.ts` exists to close for the v2 skin's own coverage
// sweep — "cricket's superOver/dls.enabled ... exist only behind a cfg leaf
// no shipped variant sets"), so this sweeps the 4 named variants (t20/odi/
// hundred/test) PLUS the same two targeted leaf overrides
// `__tests__/cricket-skin.test.ts` already uses for the v2 skin (lines
// ~150/307: `cfgFor("t20", { superOver: true })`, `cfgFor("odi", { dls: {
// enabled: true, ... } })`).
//
// Driven off the engine's OWN `cricket.eventSchemas` (== `CRICKET_EVENT_
// SCHEMAS`, assigned by reference inside the module literal — not
// re-exported standalone from the barrel, so this is how every other
// apps/web cricket test already reads it, e.g. `cricketEngine.eventSchemas!
// ["cricket.ball"]` in cricket-skin.test.ts) — never a hand-written list of
// 15, so this test goes stale the moment the engine's own vocabulary
// changes, not the moment someone forgets to update a hardcoded count here.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { SquadState } from "@seazn/engine/core";
import { buildSheets, buildSwap, buildTiles } from "../skins/cricket";
import { dedicatedEventTypes, moreActions } from "../pad-host";
import type { GuidedSheetSpec, PadHostView, TileSpec } from "../types";
import { grantAllEntitlements } from "../../__tests__/_cfg-space";

const cricketModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "cricket");
if (!cricketModule || !cricketModule.padSpec || !cricketModule.eventSchemas) {
  throw new Error("cricket module (with padSpec/eventSchemas) not found in builtinModules — engine export moved?");
}
const cricket = cricketModule;
// Read straight off `cricketModule` here, not the `cricket` alias above —
// `padSpec`/`eventSchemas` are OPTIONAL fields on AnySportModule, and tsc's
// narrowing from the guard does not survive being re-derived through a
// second variable (cricket-skin.test.ts's own cfgFor helper hits the same
// thing and uses this exact pattern for the same reason).
const padSpecFor = cricketModule.padSpec;
const ALL_EVENT_TYPES = new Set(Object.keys(cricketModule.eventSchemas));

// ---------------------------------------------------------------------------
// cfg construction — mirrors __tests__/cricket-skin.test.ts's own cfgFor,
// deliberately: two independent tests building cfgs two different ways is
// exactly how a coverage sweep silently drifts from what it claims to sweep
// (reference_parallel_vocab_lookup_paths_drift).
// ---------------------------------------------------------------------------

type VariantName = "t20" | "odi" | "hundred" | "test";

function variantPreset(name: VariantName): Record<string, unknown> {
  const variants = cricket.variants as Record<string, Record<string, unknown>> | undefined;
  const preset = variants?.[name];
  if (!preset) throw new Error(`cricket module has no "${name}" variant preset`);
  return preset;
}

function cfgFor(variant: VariantName, overrides: Record<string, unknown> = {}): unknown {
  return cricket.configSchema.parse({ ...variantPreset(variant), ...overrides });
}

// ---------------------------------------------------------------------------
// Minimal synthetic view — a real fold is not needed: every builder swept
// here (buildTiles/buildSheets/buildSwap/dedicatedEventTypes/moreActions)
// is a pure function of its input, and reachability depends only on
// state.phase / cfg, never on realistic scorecard numbers.
// ---------------------------------------------------------------------------

function squads(): SquadState {
  return {
    home: { entrantId: "home-1", members: [], subsUsed: 0, exemptUsed: {} },
    away: { entrantId: "away-1", members: [], subsUsed: 0, exemptUsed: {} },
  };
}

function liveState(): Record<string, unknown> {
  return {
    phase: "live",
    innings: [{ battingSide: "home", runs: 10, wickets: 1, legalBalls: 7, closed: false, fine: null }],
    // Non-empty so resolvePeople() resolves a real striker (buildSwap needs
    // one to return non-null) — the exact ids are never asserted on.
    orders: { home: ["p1", "p2", "p3"], away: ["p4", "p5", "p6"] },
  };
}

function superOverState(): Record<string, unknown> {
  return { ...liveState(), phase: "super_over" };
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

// ---------------------------------------------------------------------------
// The sweep. `probeSuperOver` additionally builds a `state.phase:
// "super_over"` view — real-engine-faithful, since the fold itself only
// ever reaches that phase when `cfg.superOver` is true (cricket.ts:734), so
// this is restricted to the one cfg case that actually sets it, not run
// unconditionally across every variant.
// ---------------------------------------------------------------------------

interface SweepCase {
  label: string;
  cfg: unknown;
  probeSuperOver?: boolean;
}

function sweepCases(): SweepCase[] {
  return [
    { label: "t20", cfg: cfgFor("t20") },
    { label: "odi", cfg: cfgFor("odi") },
    { label: "hundred", cfg: cfgFor("hundred") },
    // test's own preset already sets inningsPerSide:2 and followOn:{enabled:
    // true,...} (cricket.ts's variants block) — no override needed to reach
    // declare/match.close/follow-on.
    { label: "test", cfg: cfgFor("test") },
    { label: "t20+superOver", cfg: cfgFor("t20", { superOver: true }), probeSuperOver: true },
    { label: "odi+dls", cfg: cfgFor("odi", { dls: { enabled: true, edition: "standard" } }) },
  ];
}

interface SweepResult {
  viaTiles: Set<string>;
  viaSheetsAndSwap: Set<string>;
  viaMore: Set<string>;
}

function sweep(): SweepResult {
  const viaTiles = new Set<string>();
  const viaSheetsAndSwap = new Set<string>();
  const viaMore = new Set<string>();

  for (const { cfg, probeSuperOver } of sweepCases()) {
    const live = baseView(cfg, liveState());
    const tiles = buildTiles(live);
    const sheets = buildSheets(live);
    for (const t of tileEventTypes(tiles)) viaTiles.add(t);
    for (const t of sheetEventTypes(sheets)) viaSheetsAndSwap.add(t);

    const swap = buildSwap(live);
    if (swap) viaSheetsAndSwap.add(swap.buildEvent("p1", "p9").type);

    let dedicated = dedicatedEventTypes(tiles, sheets);

    if (probeSuperOver) {
      const so = baseView(cfg, superOverState());
      const soTiles = buildTiles(so);
      for (const t of tileEventTypes(soTiles)) viaTiles.add(t);
      dedicated = new Set([...dedicated, ...dedicatedEventTypes(soTiles, buildSheets(so))]);
    }

    const spec = padSpecFor(cfg);
    const entitlements = grantAllEntitlements(spec);
    // "live" reaches every innings/DLS/super-over panel; "post" is the only
    // phase playerLineAction's own panel is declared at (moreActions is
    // phase-scoped via buildPadView, pad-host.test.ts's own "never lists
    // the same type twice" test proves this scoping directly).
    for (const phase of ["live", "post"] as const) {
      const actions = moreActions(spec, { state: liveState(), summary: {}, phase, band: 3, entitlements }, dedicated);
      for (const a of actions) viaMore.add(a.type);
    }
  }

  return { viaTiles, viaSheetsAndSwap, viaMore };
}

describe("cricket dispatch-guard totality (R2/task E headline)", () => {
  it("the engine declares exactly 15 cricket.* event types (pins today's known-good shape)", () => {
    expect(ALL_EVENT_TYPES.size).toBe(15);
  });

  it("every cricket.* event type is reachable via tiles, guided/swap sheets, or the More sheet — swept across every cfg variant that gates it", () => {
    const { viaTiles, viaSheetsAndSwap, viaMore } = sweep();

    // Each of the three surfaces the brief names pulls real weight — none
    // is vacuously empty (a vacuous bucket would let the union assertion
    // below pass for the wrong reason).
    expect([...viaTiles].sort(), "tiles reached nothing").not.toEqual([]);
    expect([...viaSheetsAndSwap].sort(), "guided/swap sheets reached nothing").not.toEqual([]);
    expect([...viaMore].sort(), "the More sheet reached nothing").not.toEqual([]);

    const union = new Set([...viaTiles, ...viaSheetsAndSwap, ...viaMore]);
    const missing = [...ALL_EVENT_TYPES].filter((t) => !union.has(t)).sort();
    expect(missing, `unreachable cricket.* event types: ${missing.join(", ")}`).toEqual([]);

    // The dispatch guard's other half, read statically: nothing reachable
    // here invents a type the engine does not declare. createSkinDispatch
    // enforces this at runtime (skins/types.ts) for whatever a scorer
    // actually taps; this is the same fact, proven off the built specs
    // themselves, for every cfg this sweep explores.
    const invented = [...union].filter((t) => !ALL_EVENT_TYPES.has(t)).sort();
    expect(invented, `reachable type not in the engine's own eventSchemas: ${invented.join(", ")}`).toEqual([]);
  });
});
