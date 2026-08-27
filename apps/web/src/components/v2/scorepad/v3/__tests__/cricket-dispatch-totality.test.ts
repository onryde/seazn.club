// R2/task E — the wave's headline acceptance: every one of the engine's own
// `cricket.*` event types must be reachable from the NEW v3 surface, or the
// flip (registry-totality.test.ts) ships a pad that can render but cannot
// actually record everything the engine understands. This is deliberately a
// SEPARATE file from registry-totality.test.ts (which proves the LANE
// decision) and from skins/__tests__/cricket.test.ts (task C's own skin
// unit tests) — this file is the cross-cutting one, spanning the skin
// (`skins/cricket.tsx`'s buildTiles/buildSheets), the host
// (`pad-host.tsx`'s dedicatedEventTypes/moreActions) and the engine's own
// `padSpec(cfg)`/`eventSchemas`, and it is the only place that measures all
// three together against the engine's OWN declared vocabulary.
//
// Reachability comes from exactly three surfaces (cricket.tsx's own header,
// "OWNER HYBRID RULING"): the skin's dedicated TILES (run keypad, wide,
// declare), its GUIDED SHEETS (toss, wicket, review, innings-close), and the
// chassis's generic "More" sheet, which lists every
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
import { buildScorebug, buildSheets, buildTiles, refusedEventTypes } from "../skins/cricket";
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
// here (buildTiles/buildSheets/dedicatedEventTypes/moreActions)
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
    // R2b: `fine` non-null (ball-level), not the pre-R2b `null` this fixture
    // used to carry. The fold's per-innings fidelity (cricket.tsx's own
    // `inningsFidelity`) now gates the run/wide/wicket/extras tiles this
    // sweep depends on to reach `cricket.ball`/`cricket.superover.ball` —
    // `fine: null` (coarse) would hide every one of them, exactly the
    // regression this fixture change fixes (found running the full v3 suite
    // after R2b's over-summary tile landed). This sweep's whole point is
    // ball-derived reachability, so ball-level is the correct fixture, not
    // an arbitrary pick — the ORIGINAL `fine: null` predates fidelity
    // meaning anything at all (R2/task E, before R2b existed).
    innings: [{
      battingSide: "home", runs: 10, wickets: 1, legalBalls: 7, closed: false,
      fine: { striker: "p1", nonStriker: "p2", currentBowler: "p4", freeHitPending: false },
    }],
    // Non-empty so resolvePeople() resolves a real striker/bowler — the
    // wicket sheet's own person steps need real candidates too — the exact
    // ids are never asserted on.
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
  viaSheets: Set<string>;
  viaMore: Set<string>;
}

/**
 * The generic More sheet's own reachable types for ONE situation (one cfg,
 * one host view) — `dedicated`/`refused` must both be computed against THAT
 * SAME view, never a different one, and never unioned with another
 * situation's own sets first. `hostView.state` (not a hardcoded
 * `liveState()`) is what `moreActions`' own panel walk (`buildPadView`) sees
 * — exactly what `PadHostV3` itself passes in production (`pad-host.tsx`'s
 * `padViewCtx`), and exactly the fact a prior version of this sweep got
 * wrong (see `sweep`'s own header below).
 *
 * "live" reaches every innings/DLS/super-over panel; "post" is the only
 * phase `playerLineAction`'s own panel is declared at (`moreActions` is
 * phase-scoped via `buildPadView`, `pad-host.test.ts`'s own "never lists the
 * same type twice" test proves this scoping directly) — swept regardless of
 * which situation this is, same as before this fix.
 */
function moreTypesFor(cfg: unknown, hostView: PadHostView, dedicated: ReadonlySet<string>): Set<string> {
  const spec = padSpecFor(cfg);
  const entitlements = grantAllEntitlements(spec);
  // R3.5 F2 (review finding, BLOCKER) — the SKIN's own refusal set, exactly
  // as `PadHostV3` passes it (`pad-host.tsx`'s `refusedTypes`), never a set
  // this test invents or leaves empty — cricket declared none at all before
  // this fix, which is how five dead-end taps (review/retire/inningsClose/
  // declare/overSummary) reached the generic form during a super over with
  // this whole file staying green throughout.
  const refused = new Set(refusedEventTypes(hostView));
  const out = new Set<string>();
  for (const phase of ["live", "post"] as const) {
    const actions = moreActions(spec, { state: hostView.state, summary: {}, phase, band: 3, entitlements }, dedicated, refused);
    for (const a of actions) out.add(a.type);
  }
  return out;
}

/**
 * R3.5 F2 (review finding, BLOCKER) — this sweep used to UNION `dedicated`
 * across the live view AND the super-over probe, then query `moreActions`
 * with `state: liveState()` unconditionally regardless of which situation
 * produced that union. A type dedicated ONLY in the live view (e.g.
 * `cricket.review`, whose tile `superOverTile` disables during a super
 * over) stayed in the union even while probing the super-over situation, so
 * `moreActions` never saw it as reachable there — masking the exact
 * per-phase hole `refusedEventTypes` (skins/cricket.tsx) now closes in
 * production, and doing so for the WRONG reason (an accidental union, not a
 * real refusal). A test that unions across phases can never see a
 * per-phase hole. Mirrors football's own `reachIn`, which fixed the
 * identical class of bug first (`__tests__/football-dispatch-totality.
 * test.ts`'s own "never from a union across phases" comment) — every
 * situation below now gets its OWN `dedicated`/`viaMore`, computed and
 * consumed together, never shared with another situation.
 */
function sweep(): SweepResult {
  const viaTiles = new Set<string>();
  const viaSheets = new Set<string>();
  const viaMore = new Set<string>();

  for (const { cfg, probeSuperOver } of sweepCases()) {
    const live = baseView(cfg, liveState());
    const tiles = buildTiles(live);
    const sheets = buildSheets(live, (k: string) => k);
    for (const t of tileEventTypes(tiles)) viaTiles.add(t);
    for (const t of sheetEventTypes(sheets)) viaSheets.add(t);

    // R3/football widened `dedicatedEventTypes` with the swap slot table, so a
    // Sub tile's own event stops being duplicated into the More sheet. Cricket
    // declares NO swap at all (skins/cricket.tsx's own "swap() — DROPPED"
    // section), so the honest argument here is the empty one — which is also
    // what keeps this sweep's own answer identical to what it was before that
    // widening landed.
    // R4/tennis widened this with the SCOREBUG (tap model S makes a half a
    // real entry point). Cricket's own is passed rather than a fixture — it
    // is a tapModel-T readout with no `tappable` half, so it contributes
    // nothing, and this sweep's answer is identical to what it was before the
    // widening. Same argument the empty slot table makes one line up.
    const liveDedicated = dedicatedEventTypes(tiles, sheets, [], buildScorebug(live, (k: string) => k));
    for (const t of moreTypesFor(cfg, live, liveDedicated)) viaMore.add(t);

    if (probeSuperOver) {
      const so = baseView(cfg, superOverState());
      const soTiles = buildTiles(so);
      const soSheets = buildSheets(so, (k: string) => k);
      for (const t of tileEventTypes(soTiles)) viaTiles.add(t);
      // The super-over situation's OWN dedicated set — never unioned with
      // the live pass above (this function's own header explains why).
      const soDedicated = dedicatedEventTypes(soTiles, soSheets, [], buildScorebug(so, (k: string) => k));
      for (const t of moreTypesFor(cfg, so, soDedicated)) viaMore.add(t);
    }
  }

  return { viaTiles, viaSheets, viaMore };
}

describe("cricket dispatch-guard totality (R2/task E headline)", () => {
  it("the engine declares exactly 15 cricket.* event types (pins today's known-good shape)", () => {
    expect(ALL_EVENT_TYPES.size).toBe(15);
  });

  it("every cricket.* event type is reachable via tiles, guided sheets, or the More sheet — swept across every cfg variant that gates it", () => {
    const { viaTiles, viaSheets, viaMore } = sweep();

    // Each of the three surfaces the brief names pulls real weight — none
    // is vacuously empty (a vacuous bucket would let the union assertion
    // below pass for the wrong reason).
    expect([...viaTiles].sort(), "tiles reached nothing").not.toEqual([]);
    expect([...viaSheets].sort(), "guided sheets reached nothing").not.toEqual([]);
    expect([...viaMore].sort(), "the More sheet reached nothing").not.toEqual([]);

    const union = new Set([...viaTiles, ...viaSheets, ...viaMore]);
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

  // R3.5 F2 (review finding, BLOCKER) — the five non-ball types
  // `superOverTile` (skins/cricket.tsx) disables outright during a super
  // over must never reappear in the generic More sheet as a live 422:
  // `cricket.review`/`.retire`/`.innings.close`/`.innings.summary` below.
  // `cricket.innings.declare` is EXCLUDED from this specific assertion —
  // structurally unreachable for ANY super-over cfg at all (the cfg refine
  // forbids `inningsPerSide: 2` together with `superOver: true`, C21), so it
  // can never appear in `viaMore` here whether or not the fix works; the
  // `refusedEventTypes` unit test (skins/__tests__/cricket.test.ts) is where
  // that fifth type is actually pinned, against the bare function.
  //
  // Computed directly (not via `sweep()`, which unions every cfg case
  // together): this test's whole point is ONE situation's own reachability,
  // and a union would risk masking exactly the class of bug `sweep`'s own
  // header now explains.
  it("cricket.review/.retire/.innings.close/.innings.summary never reach the generic More sheet during a super over", () => {
    const cfg = cfgFor("t20", { superOver: true });
    const so = baseView(cfg, superOverState());
    const soTiles = buildTiles(so);
    const soSheets = buildSheets(so, (k: string) => k);
    const dedicated = dedicatedEventTypes(soTiles, soSheets, [], buildScorebug(so, (k: string) => k));
    const viaMore = moreTypesFor(cfg, so, dedicated);
    const leaked = ["cricket.review", "cricket.retire", "cricket.innings.close", "cricket.innings.summary"].filter((type) =>
      viaMore.has(type),
    );
    expect(leaked, `dead-end taps offered via the generic More sheet during a super over: ${leaked.join(", ")}`).toEqual([]);
  });

  // R2c / C2 (owner-approved amendment to defect 4's ruling, 2026-08-18):
  // `cricket.retire` moves from the generic More sheet to the skin's own
  // guided sheet, and — this is the half that matters — it is reachable
  // through EXACTLY ONE of them, never both. Two divergent entry points was
  // the original defect, and this sweep is what proves it has not come back:
  // it computes both reachability sets independently from the built specs.
  //
  // The de-duplication is structural rather than hand-maintained.
  // `dedicatedEventTypes` (pad-host.tsx) folds every sheet's own `event` into
  // the dedicated set, and the More sheet lists only what is NOT dedicated —
  // so declaring `retireSheet` is itself what removes the generic entry. The
  // old `{swap:true}` tile could not do that (a swap action contributes no
  // type at all), which is precisely how the duplication arose in the first
  // place.
  it("cricket.retire is reachable through the skin's own guided sheet, and NO LONGER through the generic More sheet", () => {
    const { viaSheets, viaMore } = sweep();
    expect(viaSheets.has("cricket.retire")).toBe(true);
    expect(viaMore.has("cricket.retire")).toBe(false);
  });
});
