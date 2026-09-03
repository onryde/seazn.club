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
// FOUR SURFACES, per ruling R3-4 (R3.5-5 amended it for ONE type — see
// below): dedicated TILES (the two Goal tiles live/H1/H2/ET; the two kick
// tiles during SHOOTOUT only, R3.5/Task J), the skin's GUIDED SHEETS
// (card ×2, period, penalty, kick ×2), its SWAP slots (`football.sub`), and
// the chassis's generic More sheet, which lists every `padSpec(cfg)` action
// the skin does not already dedicate.
//
// ---------------------------------------------------------------------------
// R3 REVIEW ROUND — THIS FILE WAS FALSE-GREEN, and the way it was false-green
// is the point of the rewrite.
//
// The previous sweep folded every situation into FOUR UNION SETS. For the
// shoot-out it built the `dedicated` set as `live ∪ SHOOTOUT`
// (`dedicated = new Set([...dedicated, ...dedicatedEventTypes(soTiles, …)])`)
// while `pad-host.tsx` recomputes `dedicated` from the CURRENT state alone.
// Production therefore drops `football.goal` and `football.sub` out of
// `dedicated` at SHOOTOUT — the Goal tile and the swap slots are both withheld
// there — and both reappear inside More as un-narrowed generic forms that
// `applyGoal`/`applySub` refuse with WRONG_PHASE. The union hid it: because
// the LIVE pass had already added them, `expect(viaMore.has("football.goal"))
// .toBe(false)` passed in exactly the phase where the duplicate existed. A
// band-0 org reaches that dead end in two taps.
//
// So the unit of measurement is now ONE SITUATION — one cfg, one really-folded
// state, one band — measured the way the host measures it, and every assertion
// quantifies over situations rather than over their union. Two consequences
// worth keeping:
//
//   - The oracle is the ENGINE, not a table. `phaseVerdict` (_football-fold.ts)
//     calls `football.apply` and reports whether the refusal was WRONG_PHASE.
//     The four dead ends this round fixed were all written against a MIRROR of
//     the engine's phase rules, and a mirror agrees with itself.
//   - "Reachable" means a scorer can TAP it now: tiles are phase-filtered, and
//     a sheet/swap slot counts only when some surviving tile opens it. The
//     `dedicated` set fed to `moreActions` is deliberately NOT filtered that
//     way — it mirrors the host, which passes the un-phase-filtered tiles.
import { describe, expect, it } from "vitest";
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { SquadState } from "@seazn/engine/core";
import {
  buildScorebug,
  buildSheets,
  buildSwap,
  buildTiles,
  periodMarkersOf,
  refusedEventTypes,
  resolvePhase,
} from "../skins/football";
import {
  dedicatedEventTypes,
  filterTilesByBand,
  moreActions,
} from "../pad-host";
import type { PadHostView, PadPhase, TileSpec } from "../types";
import { foldedPhases, phaseVerdict, probePayload, type FoldedPhase } from "./_football-fold";

const footballModule = (builtinModules as readonly AnySportModule[]).find((m) => m.key === "football");
if (!footballModule?.padSpec || !footballModule.eventSchemas) {
  throw new Error("football module (with padSpec/eventSchemas) not found in builtinModules — engine export moved?");
}
// Read straight off `footballModule`, not an alias — `padSpec`/`eventSchemas`
// are OPTIONAL on AnySportModule and tsc's narrowing does not survive being
// re-derived through a second variable (the same pattern
// cricket-dispatch-totality.test.ts uses, for the same reason).
const padSpecFor = footballModule.padSpec;
const ALL_EVENT_TYPES = new Set(Object.keys(footballModule.eventSchemas));

const t = (key: string): string => key;
const ALL_BANDS: readonly FidelityBand[] = [0, 1, 2, 3];

// ---------------------------------------------------------------------------
// One situation = one cfg + one really-folded state + one band. The sweep is
// the cross product; `foldedPhases()` already crosses every shipped variant
// preset with the two cfg leaves no preset turns on (extra time, the kicks).
// ---------------------------------------------------------------------------

interface Situation extends FoldedPhase {
  band: FidelityBand;
}

function situations(): Situation[] {
  return foldedPhases().flatMap((folded) =>
    ALL_BANDS.map((band) => ({ ...folded, band, label: `${folded.label} band ${band}` })),
  );
}

/** The squad projection the CHASSIS carries (`PadHostView.squads`), which is
 *  the kernel's `SquadState` and NOT football's own `state.squads` — the two
 *  are different shapes on purpose, and the skin reads the latter. Empty
 *  members: nothing swept here reads it (the skin's `squadOf` goes to
 *  `state.squads`), and filling it would imply otherwise. */
function chassisSquads(): SquadState {
  return {
    home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} },
    away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} },
  };
}

function viewFor(s: Situation): PadHostView {
  return {
    cfg: s.cfg,
    state: s.state,
    summary: {},
    phase: resolvePhase({ state: s.state }),
    band: s.band,
    entitlements: {},
    personNames: {},
    squads: chassisSquads(),
    events: [],
    contextOverrides: {},
  };
}

interface Reach {
  /** Every type a scorer can dispatch RIGHT NOW, by surface. */
  viaTiles: Set<string>;
  viaSheets: Set<string>;
  viaSwap: Set<string>;
  viaMore: Set<string>;
  /** The enabled marker options the period sheet currently offers. */
  periodMarkers: string[];
}

function reachIn(s: Situation): Reach {
  const view = viewFor(s);
  const spec = padSpecFor(s.cfg);
  const padPhase: PadPhase = view.phase;

  const sheets = buildSheets(view, t);
  const slots = buildSwap(view, t);
  const allTiles = buildTiles(view);
  // Exactly the host's own order of operations (pad-host.tsx): band-filter the
  // tiles against the band the SCORER picked, then derive `dedicated` from
  // THAT list — never from a union across phases, which is what this file used
  // to do.
  const tiles = filterTilesByBand(allTiles, sheets, slots, spec.fidelity, view.band);
  // R4/tennis widened this with the SCOREBUG, because tap model S makes a
  // half a real entry point. Football's own scorebug is passed rather than a
  // fixture: it is a tapModel-T readout that declares no `tappable` half, so
  // it must contribute nothing — and asserting that through the production
  // symbol is what proves this wave left football's More sheet alone, instead
  // of a comment claiming it did.
  const dedicated = dedicatedEventTypes(tiles, sheets, slots, buildScorebug(view, t));

  // A tile the current phase does not declare is not on screen, so nothing it
  // would open is reachable either.
  const tappable = tiles.filter((tile: TileSpec) => tile.phases.includes(padPhase));
  const viaTiles = new Set<string>();
  const viaSheets = new Set<string>();
  const viaSwap = new Set<string>();
  for (const tile of tappable) {
    if ("event" in tile.action) viaTiles.add(tile.action.event.type);
    else if ("sheet" in tile.action) {
      const sheet = sheets[tile.action.sheet];
      if (sheet) viaSheets.add(sheet.event);
    } else if ("swap" in tile.action) {
      const swapId = tile.action.swap;
      const slot = slots.find((candidate) => candidate.id === swapId);
      if (slot) viaSwap.add(slot.eventType);
    }
  }

  const viaMore = new Set(
    moreActions(
      spec,
      { state: s.state, summary: {}, phase: padPhase, band: s.band },
      dedicated,
      // The SKIN's own refusal set, exactly as `PadHostV3` passes it — not a
      // set this test computes, or the sweep would be measuring itself.
      new Set(refusedEventTypes(view)),
    ).map((action) => action.type),
  );

  const periodSheet = sheets.period;
  const blocked = periodSheet?.steps[0]?.kind === "choice" ? periodSheet.steps[0].blocked?.({}) : undefined;
  const periodMarkers =
    periodSheet?.steps[0]?.kind === "choice"
      ? periodSheet.steps[0].options.filter((option) => blocked?.[option.id] === undefined).map((o) => o.id)
      : [];

  return { viaTiles, viaSheets, viaSwap, viaMore, periodMarkers };
}

function allReachable(reach: Reach): Set<string> {
  return new Set([...reach.viaTiles, ...reach.viaSheets, ...reach.viaSwap, ...reach.viaMore]);
}

describe("football dispatch-guard totality (R3/task B2 headline)", () => {
  it("the engine declares exactly 9 football.* event types (pins today's known-good shape)", () => {
    expect(ALL_EVENT_TYPES.size).toBe(9);
  });

  it("every football.* event type is reachable via tiles, sheets, the swap sheet or More — swept across every shipped cfg", () => {
    const surfaces = { tiles: new Set<string>(), sheets: new Set<string>(), swap: new Set<string>(), more: new Set<string>() };
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of reach.viaTiles) surfaces.tiles.add(type);
      for (const type of reach.viaSheets) surfaces.sheets.add(type);
      for (const type of reach.viaSwap) surfaces.swap.add(type);
      for (const type of reach.viaMore) surfaces.more.add(type);
    }

    // Each of the four surfaces pulls real weight — a vacuously empty bucket
    // would let the union assertion below pass for the wrong reason.
    expect([...surfaces.tiles], "tiles reached nothing").not.toEqual([]);
    expect([...surfaces.sheets], "guided sheets reached nothing").not.toEqual([]);
    expect([...surfaces.swap], "the swap sheet reached nothing").not.toEqual([]);
    expect([...surfaces.more], "the More sheet reached nothing").not.toEqual([]);

    const union = new Set([...surfaces.tiles, ...surfaces.sheets, ...surfaces.swap, ...surfaces.more]);
    const missing = [...ALL_EVENT_TYPES].filter((type) => !union.has(type)).sort();
    expect(missing, `unreachable football.* event types: ${missing.join(", ")}`).toEqual([]);

    // The dispatch guard's other half, read statically: nothing reachable here
    // invents a type the engine does not declare. `createSkinDispatch` enforces
    // this at runtime for whatever a scorer actually taps; this is the same
    // fact proved off the built specs, for every cfg this sweep explores.
    const invented = [...union].filter((type) => !ALL_EVENT_TYPES.has(type)).sort();
    expect(invented, `reachable type not in the engine's own eventSchemas: ${invented.join(", ")}`).toEqual([]);
  });

  // THE DEAD-END GUARD. The defect class this programme keeps re-finding, now
  // measured against the fold instead of against a mirror of it: whatever the
  // pad offers in a situation, `football.apply` must not answer WRONG_PHASE.
  //
  // `football.period` is excluded here and asserted below instead — it is the
  // one type whose legality depends on the PAYLOAD (which marker) as well as
  // the phase, so a single probe payload cannot answer for it.
  it("nothing the pad offers is refused by the fold for being the wrong phase", () => {
    const deadEnds: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of allReachable(reach)) {
        if (type === "football.period") continue;
        const verdict = phaseVerdict(s.cfg, s.state, type, probePayload(type, s.state));
        if (verdict === "wrong-phase") deadEnds.push(`${s.label}: ${type}`);
      }
    }
    expect(deadEnds, `dead-end taps (the fold refuses these with WRONG_PHASE):\n${deadEnds.join("\n")}`).toEqual([]);
  });

  // E1's half of the same rule. `periodMarkersOf` mirrors the engine's private
  // `periodMarkers`, which gates on MODE alone, while `applyPeriod` ALSO gates
  // on `state.phase` — so in halves mode at H1 the sheet offered both HT and
  // FT, and FT raises WRONG_PHASE. Every marker the sheet leaves ENABLED must
  // be one the fold accepts here and now.
  it("every enabled period marker is one applyPeriod accepts in the current phase", () => {
    const offered: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      if (!reach.viaSheets.has("football.period")) continue;
      for (const marker of reach.periodMarkers) {
        const verdict = phaseVerdict(s.cfg, s.state, "football.period", { phase: marker });
        if (verdict === "wrong-phase") offered.push(`${s.label}: ${marker}`);
      }
    }
    expect(offered, `period markers the fold refuses in that phase:\n${offered.join("\n")}`).toEqual([]);
  });

  // The mirror of the assertion above: narrowing must not narrow to NOTHING.
  // A sheet whose every option is blocked is a tile that opens a dead panel,
  // which is the D-15 defect wearing the fix's coat.
  it("wherever the period sheet is reachable, at least one marker is enabled", () => {
    const empty: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      if (reach.viaSheets.has("football.period") && reach.periodMarkers.length === 0) empty.push(s.label);
    }
    expect(empty, `the period sheet is reachable with every marker blocked:\n${empty.join("\n")}`).toEqual([]);
    // And the cfg mirror still holds: an enabled marker is always one this
    // cfg's mode declares at all (quarters never offers a halves-only marker).
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const marker of reach.periodMarkers) {
        expect(periodMarkersOf(s.cfg), `${s.label}: ${marker} is not a marker of this cfg`).toContain(marker);
      }
    }
  });

  // R3.5/Task J (ruling R3.5-5) AMENDED R3-4 for `football.shootout.kick`
  // specifically: it now rides a dedicated tile+sheet pair during SHOOTOUT
  // (`buildTiles`/`buildSheets`, skins/football.tsx), the phase where it is
  // the ENTIRE match rather than a rare type. Outside SHOOTOUT it was already
  // REFUSED (`refusedEventTypes`), never offered via More either — so across
  // every situation this sweep measures, it never appears in `viaMore` at
  // all any more. R3-4 still stands for the other three: `football.shot` and
  // both sin-bin forms remain generic-form-only in every situation.
  it("the three remaining More-sheet types are exactly ruling R3-4's leftovers, and no dedicated type joins them", () => {
    const viaMore = new Set<string>();
    for (const s of situations()) for (const type of reachIn(s).viaMore) viaMore.add(type);
    expect([...viaMore].sort()).toEqual(["football.shot", "football.sinbin.end", "football.sinbin.start"]);
  });

  it("football.shootout.kick is a DEDICATED type during SHOOTOUT, and never appears in More in any situation (R3.5-5)", () => {
    // Via SHEETS, not tiles: the kick tile's own action is `{sheet:
    // "kick-<side>"}`, the SAME routing card/period/penalty already use —
    // only Goal emits `{event}` directly. `reachIn` credits a `{sheet}`
    // tile's reachability to `viaSheets` (see its own loop above).
    const viaSheets = new Set<string>();
    const leaks: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of reach.viaSheets) viaSheets.add(type);
      if (reach.viaMore.has("football.shootout.kick")) leaks.push(s.label);
    }
    expect(viaSheets.has("football.shootout.kick"), "no situation ever reached the SHOOTOUT kick sheets").toBe(true);
    expect(leaks, `football.shootout.kick offered as a generic More form in:\n${leaks.join("\n")}`).toEqual([]);
  });

  // The de-duplication ruling this wave took (see `dedicatedEventTypes`'
  // own doc, pad-host.tsx) — now asserted PER SITUATION. The union form of
  // this test is what let the shoot-out duplicate through.
  it("no type is ever offered by a dedicated surface AND the generic More sheet in the same situation", () => {
    const duplicates: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      const dedicatedNow = new Set([...reach.viaTiles, ...reach.viaSheets, ...reach.viaSwap]);
      for (const type of reach.viaMore) {
        if (dedicatedNow.has(type)) duplicates.push(`${s.label}: ${type}`);
      }
    }
    expect(duplicates, `duplicated into More:\n${duplicates.join("\n")}`).toEqual([]);
  });

  it("football.sub is reachable through the swap sheet, and NEVER through the generic More sheet", () => {
    const viaSwap = new Set<string>();
    const leaks: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of reach.viaSwap) viaSwap.add(type);
      if (reach.viaMore.has("football.sub")) leaks.push(s.label);
    }
    expect(viaSwap.has("football.sub")).toBe(true);
    expect(leaks, `football.sub offered as a generic More form in:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("the card, period and penalty flows are the skin's own sheets, never a duplicate generic form", () => {
    const viaSheets = new Set<string>();
    const leaks: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of reach.viaSheets) viaSheets.add(type);
      for (const type of ["football.card", "football.period", "football.penalty"]) {
        if (reach.viaMore.has(type)) leaks.push(`${s.label}: ${type}`);
      }
    }
    for (const type of ["football.card", "football.period", "football.penalty"]) {
      expect(viaSheets.has(type), type).toBe(true);
    }
    expect(leaks, `duplicated into More:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("the goal is a direct tile tap — no sheet, no form, side-level on commit", () => {
    const viaTiles = new Set<string>();
    const leaks: string[] = [];
    for (const s of situations()) {
      const reach = reachIn(s);
      for (const type of reach.viaTiles) viaTiles.add(type);
      if (reach.viaMore.has("football.goal")) leaks.push(s.label);
    }
    expect(viaTiles.has("football.goal")).toBe(true);
    expect(leaks, `football.goal offered as a generic More form in:\n${leaks.join("\n")}`).toEqual([]);
  });
});
