// R7-39 (owner-approved), corrected by R7-39a — the ScoringPad v3 "More"
// tile was offered even when the sheet it opens has nothing in it.
// R7-39's own filing overstated the symptom as a BLANK sheet:
// `action-form.tsx`'s own `actions.length === 0` branch always renders
// `pad.host.moreEmpty` ("Nothing else to record here yet."), never a blank
// panel, so this was never a rendering bug — it is a tile GUARANTEED TO BE
// A DEAD END at a knowable phase/band. Fixed CENTRALLY, in the chassis
// (`suppressEmptyMoreTile`, pad-host.tsx), never per-skin — see that
// function's own doc for the full ruling and correction text.
//
// `pad-host.test.ts`'s own `suppressEmptyMoreTile` suite proves the pure
// function structurally (id-string-agnostic, touches no other tile). THIS
// file proves the fix is not vacuous against two REAL sport modules — never
// a hand-typed fidelity table, because a synthetic mirror can drift from
// `packages/engine`'s own declarations the moment they change
// (reference_parallel_vocab_lookup_paths_drift) — driven through the REAL
// chassis pipeline in the SAME order pad-host.tsx's own render body uses:
// sheets/swap resolved, tiles band-filtered against ENTITLED bands,
// `dedicated` derived from that filtered list, `moreActions` run against the
// SCALAR ctx.band, `suppressEmptyMoreTile` the one and only place the tile
// is removed.
//
// PHASE-AWARE, not band-only, for cricket specifically — and this is why a
// band-only test would be WRONG, not merely weak. Cricket's only POST-phase
// action is `cricket.player.line` at band 2 (packages/engine/src/sports/
// cricket/cricket.ts's own "Scorecard" panel, `phase: "post"`), so the POST
// sheet is empty at bands 0 AND 1 (2 > 0, 2 > 1). But at band 1 LIVE the
// sheet is genuinely NON-EMPTY: `cricket.interruption`/`cricket.newball`/
// `cricket.powerplay` are all band 1, survive the band filter, and no tile
// or sheet in `skins/cricket.tsx` claims any of them. An assertion of "empty
// at band 1" would be false — the phase has to travel with the band.
import { describe, expect, it } from "vitest";
import type { SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import { cricket, type CricketCfg } from "@seazn/engine/sports/cricket";
import { football, type FootballCfg } from "@seazn/engine/sports/football";
import type { PadSpec } from "@seazn/engine/sport";
import {
  buildScorebug as cricketScorebug,
  buildSheets as cricketSheets,
  buildTiles as cricketTiles,
  refusedEventTypes as cricketRefused,
} from "../skins/cricket";
import {
  buildScorebug as footballScorebug,
  buildSheets as footballSheets,
  buildSwap as footballSwap,
  buildTiles as footballTiles,
  refusedEventTypes as footballRefused,
  resolvePhase as resolveFootballPhase,
} from "../skins/football";
import { dedicatedEventTypes, entitledBandsFrom, filterTilesByBand, moreActions, suppressEmptyMoreTile } from "../pad-host";
import { MORE_SHEET_KEY, type PadHostView, type TileSpec } from "../types";
import { footballCfg, foldFootball } from "./_football-fold";

if (!cricket.padSpec) throw new Error("cricket module has no padSpec — engine export moved?");
if (!football.padSpec) throw new Error("football module has no padSpec — engine export moved?");
const cricketPadSpec = cricket.padSpec;
const footballPadSpec = football.padSpec;

const t = (key: string, vars?: Record<string, string | number>): string => (vars ? `${key}(${JSON.stringify(vars)})` : key);

function hasMoreTile(tiles: readonly TileSpec[]): boolean {
  return tiles.some((tile) => "sheet" in tile.action && tile.action.sheet === MORE_SHEET_KEY);
}

interface PipelineResult {
  /** What `moreActions` really returns for this view — the same list
   *  `PadHostV3`'s own render body feeds `suppressEmptyMoreTile`. */
  moreListLength: number;
  /** Whether the More tile survives `suppressEmptyMoreTile`. */
  visibleHasMore: boolean;
  /** Whether it was offered BEFORE suppression — the non-vacuous
   *  precondition every "NO More tile" assertion below needs: a suite that
   *  never saw the tile pre-suppression could "pass" for the wrong reason. */
  rawHasMore: boolean;
}

// ---------------------------------------------------------------------------
// cricket
// ---------------------------------------------------------------------------

function cricketVariantCfg(name: "t20"): CricketCfg {
  const variants = cricket.variants as Record<string, Record<string, unknown>> | undefined;
  const preset = variants?.[name];
  if (!preset) throw new Error(`cricket module has no "${name}" variant preset`);
  return cricket.configSchema.parse(preset);
}

const CRICKET_CFG = cricketVariantCfg("t20");

function cricketSquads(): SquadState {
  return initSquads({
    home: {
      entrantId: "home-1",
      slots: [
        { personId: "h1", slot: "starting", orderNo: 1 },
        { personId: "h2", slot: "starting", orderNo: 2 },
        { personId: "h3", slot: "starting", orderNo: 3 },
      ],
    },
    away: {
      entrantId: "away-1",
      slots: [
        { personId: "a1", slot: "starting", orderNo: 1 },
        { personId: "a2", slot: "starting", orderNo: 2 },
        { personId: "a3", slot: "starting", orderNo: 3 },
      ],
    },
  });
}

/** A minimal but real-shaped cricket state — same fixture shape
 *  `skins/__tests__/cricket.test.ts`'s own `state()`/`innings()` use.
 *  `fine` non-null: ball-level fidelity, so a low band's own tiles are
 *  hidden by the BAND filter, never by the innings itself reading coarse. */
function cricketState(phase: "live" | "done"): Record<string, unknown> {
  return {
    phase,
    innings: [
      {
        battingSide: "home" as const,
        runs: 12,
        wickets: 1,
        legalBalls: 5,
        closed: false,
        fine: { striker: "h1", nonStriker: "h2", currentBowler: "a1", freeHitPending: false },
      },
    ],
    orders: { home: ["h1", "h2", "h3"], away: ["a1", "a2", "a3"] },
  };
}

function cricketView(band: 0 | 1 | 2 | 3, state: Record<string, unknown>): PadHostView {
  return {
    cfg: CRICKET_CFG,
    state,
    summary: {},
    // `view.phase` (the PAD phase) is derived through the exact same
    // `resolvePhase` `cricketSkinV3` declares as its own `phase()` method
    // (`phase: resolvePhase`, skins/cricket.tsx) — never hardcoded — so this
    // fixture is one the chassis could actually reach, not merely one this
    // test invented. `skins/cricket.tsx`'s own `resolvePhase` maps engine
    // phase "done"/"final" to PadPhase "post", everything else to "live".
    phase: state.phase === "done" || state.phase === "final" ? "post" : "live",
    band,
    // Empty entitlements — this suite is about a genuinely LOW-band org
    // (nothing bought above band 1), not the "grant every entitlement the
    // spec references" convention `cricket-dispatch-totality.test.ts` uses
    // for its own, different purpose (measuring whether the WHOLE engine
    // vocabulary is reachable by SOME org). `entitledBandsFrom` only
    // withholds a band that NEEDS an entitlement the org lacks — bands 0/1
    // need none (`fidelityEntitlements: {2: ..., 3: ...}`), so this is
    // exactly what a band-0/1 cricket org's real entitlement map looks like.
    entitlements: {},
    personNames: { h1: "H1", h2: "H2", h3: "H3", a1: "A1", a2: "A2", a3: "A3" },
    squads: cricketSquads(),
    events: [],
    contextOverrides: {},
  };
}

function cricketPipeline(view: PadHostView): PipelineResult {
  const spec: PadSpec = cricketPadSpec(view.cfg as CricketCfg);
  const sheets = cricketSheets(view, t);
  const entitledBands = entitledBandsFrom(spec.fidelityEntitlements, view.entitlements);
  const allTiles = cricketTiles(view, t);
  const tiles = filterTilesByBand(allTiles, sheets, [], spec.fidelity, entitledBands);
  const scorebug = cricketScorebug(view, t);
  const dedicated = dedicatedEventTypes(tiles, sheets, [], scorebug);
  const refused = new Set(cricketRefused(view));
  const moreList = moreActions(
    spec,
    { state: view.state, summary: view.summary, phase: view.phase, band: view.band, entitlements: view.entitlements },
    dedicated,
    refused,
  );
  const visible = suppressEmptyMoreTile(tiles, moreList);
  return { moreListLength: moreList.length, visibleHasMore: hasMoreTile(visible), rawHasMore: hasMoreTile(tiles) };
}

// ---------------------------------------------------------------------------
// football — proves the fix is chassis-wide, not a cricket special case.
// football has no dedicated "post" panel at all (its own padSpec doc: every
// registered type is a "live" action), so this proves the property along
// the OTHER axis instead: band alone, at a REAL folded "H1" (live) state.
// Goal(0)/period(0) are both dedicated by football's own always-on tiles, so
// at band 0 nothing else in band survives — empty. At band 2,
// `football.sinbin.start`/`football.sinbin.end` (band 2) have NO tile or
// sheet anywhere in `skins/football.tsx` (its own `buildTiles` doc: they
// "ride the chassis's generic sheet") — non-empty.
// ---------------------------------------------------------------------------

const FOOTBALL_CFG: FootballCfg = footballCfg();
const FOOTBALL_STATE = foldFootball(FOOTBALL_CFG, [["core.start"]]);

function footballChassisSquads(): SquadState {
  return {
    home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} },
    away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} },
  };
}

function footballView(band: 0 | 1 | 2 | 3): PadHostView {
  return {
    cfg: FOOTBALL_CFG,
    state: FOOTBALL_STATE,
    summary: {},
    phase: resolveFootballPhase({ state: FOOTBALL_STATE }),
    band,
    entitlements: {},
    personNames: {},
    squads: footballChassisSquads(),
    events: [],
    contextOverrides: {},
  };
}

function footballPipeline(view: PadHostView): PipelineResult {
  const spec: PadSpec = footballPadSpec(view.cfg as FootballCfg);
  const sheets = footballSheets(view, t);
  const slots = footballSwap(view, t);
  const entitledBands = entitledBandsFrom(spec.fidelityEntitlements, view.entitlements);
  const allTiles = footballTiles(view);
  const tiles = filterTilesByBand(allTiles, sheets, slots, spec.fidelity, entitledBands);
  const scorebug = footballScorebug(view, t);
  const dedicated = dedicatedEventTypes(tiles, sheets, slots, scorebug);
  const refused = new Set(footballRefused(view));
  const moreList = moreActions(
    spec,
    { state: view.state, summary: view.summary, phase: view.phase, band: view.band, entitlements: view.entitlements },
    dedicated,
    refused,
  );
  const visible = suppressEmptyMoreTile(tiles, moreList);
  return { moreListLength: moreList.length, visibleHasMore: hasMoreTile(visible), rawHasMore: hasMoreTile(tiles) };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("More-tile suppression is chassis-wide and phase-aware (R7-39/R7-39a)", () => {
  describe("cricket", () => {
    it("offers the More tile pre-suppression in POST phase too — non-vacuous precondition for the two cases below", () => {
      const view = cricketView(0, cricketState("done"));
      expect(view.phase, "fixture must actually resolve to 'post'").toBe("post");
      expect(cricketPipeline(view).rawHasMore).toBe(true);
    });

    it.each([0, 1] as const)(
      "POST phase, band %d: player.line (band 2) is above both bands, so the sheet is empty — NO More tile",
      (band) => {
        const result = cricketPipeline(cricketView(band, cricketState("done")));
        expect(result.moreListLength, "sanity: the real chassis computation must actually be empty here").toBe(0);
        expect(result.visibleHasMore).toBe(false);
      },
    );

    it("LIVE phase, band 1: the More tile IS present — this is the both-directions pin. A fix that suppressed the tile everywhere would fail THIS assertion", () => {
      const result = cricketPipeline(cricketView(1, cricketState("live")));
      expect(result.moreListLength).toBeGreaterThan(0);
      expect(result.visibleHasMore).toBe(true);
    });
  });

  describe("football — proves the chassis fix, not a cricket-only one", () => {
    it("offers the More tile pre-suppression at band 0 too — non-vacuous precondition", () => {
      expect(footballPipeline(footballView(0)).rawHasMore).toBe(true);
    });

    it("band 0: goal + period are the only band-0 types and both are dedicated by football's own tiles — NO More tile", () => {
      const result = footballPipeline(footballView(0));
      expect(result.moreListLength, "sanity: the real chassis computation must actually be empty here").toBe(0);
      expect(result.visibleHasMore).toBe(false);
    });

    it("band 2: sinbin.start/sinbin.end have no tile or sheet anywhere — the More tile IS present", () => {
      const result = footballPipeline(footballView(2));
      expect(result.moreListLength).toBeGreaterThan(0);
      expect(result.visibleHasMore).toBe(true);
    });
  });
});

// generic — the ONE skin that used to carry its own `moreHasContent` guard,
// now deleted (this task's other required change). Its full real-engine
// sweep across every mode x band x phase generic can reach lives in
// `skins/__tests__/generic.test.ts` ("suppressEmptyMoreTile agrees with the
// chassis"), not duplicated here, so the two suites cannot silently drift
// apart on what "generic" means.
