// W1 / Task 4 review, C-1 + I-1 — what the Recording sheet promises under each
// of its four rows.
//
// THE DEFECT THIS FILE EXISTS FOR. `bandActionCounts` used to take the host's
// own `allTiles` — `skin.tiles(view)`, already built at the CURRENT band — and
// re-run only the CHASSIS filter across the four candidates. Seven skins
// band-filter INSIDE `buildTiles` (football/badminton/tabletennis/tennis/
// volleyball/generic/boardgame each have their own `withinBand`), and the
// chassis filter can only ever REMOVE, so every row above the current band was
// capped at the current band's tile set. Measured on 11-a-side football at H1:
// a scorer sitting at band 0 or 1 opened the picker and was told all four
// options were identical — the control reading as a no-op to exactly the
// person who most needs to raise it.
//
// THE PROPERTY, and it is deliberately not a table of expected numbers: what
// the sheet says about band N, computed from ANY current band, must equal what
// the pad ACTUALLY offers once band N is picked. That ground truth is the same
// function evaluated on a view already AT band N — no oracle typed into this
// file, so a change to a skin's own declarations moves the expectation with
// it. The old implementation fails this at current band 0 and 1; the ONE
// current band it passed at is 3, which is the band every test fixture in this
// suite happened to use.
//
// Also pinned here (the owner's ruling on the metric): the count is
// DISPATCHABLE ACTIONS, not grid tiles. A tile count cannot express football's
// band-2-vs-3 difference at all, because `football.shot` is band 3 and has no
// tile of its own — it rides the never-band-filtered More sheet.
import { describe, expect, it } from "vitest";
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import { makeEnvelope } from "@seazn/engine/testkit";
import { foldClient } from "../../module-client";
import { reachableActionTypes } from "../pad-host";
import { footballSkinV3, resolvePhase } from "../skins/football";
import { badmintonSkinV3 } from "../skins/badminton";
import type { PadHostView } from "../types";
import { foldedPhases } from "./_football-fold";

const BANDS: readonly FidelityBand[] = [0, 1, 2, 3];
const t = (key: string): string => key;

function moduleFor(key: string): AnySportModule & { padSpec: NonNullable<AnySportModule["padSpec"]> } {
  const mod = (builtinModules as readonly AnySportModule[]).find((m) => m.key === key);
  if (!mod?.padSpec) throw new Error(`${key} module (with padSpec) not found in builtinModules`);
  return mod as AnySportModule & { padSpec: NonNullable<AnySportModule["padSpec"]> };
}

const football = moduleFor("football");
const footballSkin = footballSkinV3(t);

/** The kernel's own squad projection (`PadHostView.squads`), not football's
 *  `state.squads` — different shapes on purpose, and nothing counted here
 *  reads the members. Same fixture `football-dispatch-totality.test.ts` uses. */
const chassisSquads: SquadState = {
  home: { entrantId: "H", members: [], subsUsed: 0, exemptUsed: {} },
  away: { entrantId: "A", members: [], subsUsed: 0, exemptUsed: {} },
};

/** The 11-a-side fixture one whistle into the first half — the same situation
 *  `e2e/scoring-free.spec.ts` seeds and the same one the review measured. */
function footballH1() {
  const folded = foldedPhases().find((f) => f.label.startsWith("11-a-side") && f.phase === "H1");
  if (!folded) throw new Error("no folded 11-a-side H1 situation — _football-fold.ts changed shape?");
  return folded;
}

function viewAt(folded: { cfg: unknown; state: unknown }, band: FidelityBand): PadHostView {
  return {
    cfg: folded.cfg,
    state: folded.state,
    summary: {},
    phase: resolvePhase({ state: folded.state } as PadHostView),
    band,
    entitlements: {},
    personNames: {},
    squads: chassisSquads,
    events: [],
    contextOverrides: {},
  };
}

/** The racquet fixture's own view: `phase: "live"` (the setbased skins read
 *  the fold, not a `resolvePhase` of football's shape) and the REAL ledger
 *  beside the REAL state, which `setBasedServeContext` needs to agree. */
function badmintonView(
  folded: { cfg: unknown; state: unknown; lineups: LineupPair; events: readonly EventEnvelope[] },
  band: FidelityBand,
): PadHostView {
  return {
    cfg: folded.cfg,
    state: folded.state,
    summary: {},
    phase: "live",
    band,
    entitlements: {},
    personNames: { H1: "Home One", A1: "Away One" },
    squads: initSquads(folded.lineups),
    events: folded.events,
    contextOverrides: {},
  };
}

/** The four numbers the sheet would print, computed from a pad sitting at
 *  `currentBand` — exactly what `pad-host.tsx`'s `bandActionCounts` does. */
function sheetSaysFrom(
  skin: Parameters<typeof reachableActionTypes>[0],
  spec: PadSpec,
  folded: { cfg: unknown; state: unknown },
  currentBand: FidelityBand,
): number[] {
  const view = viewAt(folded, currentBand);
  return BANDS.map((candidate) => reachableActionTypes(skin, spec, view, candidate).size);
}

/** What the pad ACTUALLY offers once each band is picked — the ground truth,
 *  computed one band at a time on a view already sitting at that band. */
function truthFor(
  skin: Parameters<typeof reachableActionTypes>[0],
  spec: PadSpec,
  folded: { cfg: unknown; state: unknown },
): number[] {
  return BANDS.map((band) => reachableActionTypes(skin, spec, viewAt(folded, band), band).size);
}

describe("the Recording sheet's counts do not depend on the band the scorer is currently on", () => {
  it("football, 11-a-side, H1: all four current bands print the same four numbers, and they are the truth", () => {
    const folded = footballH1();
    const spec = football.padSpec(folded.cfg);
    const truth = truthFor(footballSkin, spec, folded);
    for (const currentBand of BANDS) {
      expect(
        sheetSaysFrom(footballSkin, spec, folded, currentBand),
        `sitting at band ${currentBand}, the sheet must still describe every band correctly`,
      ).toEqual(truth);
    }
  });

  it("...and those four numbers actually SAY something — a picker whose rows all read alike is a no-op", () => {
    const folded = footballH1();
    const truth = truthFor(footballSkin, football.padSpec(folded.cfg), folded);
    expect(new Set(truth).size, `football H1 counts were all identical: ${truth.join("/")}`).toBeGreaterThan(1);
    // Monotone: a higher band can never offer FEWER actions than a lower one.
    for (let i = 1; i < truth.length; i += 1) {
      expect(truth[i], `band ${i} offers fewer actions than band ${i - 1}`).toBeGreaterThanOrEqual(truth[i - 1]!);
    }
  });

  it("band 3 beats band 2 on football, which a GRID-TILE count cannot see at all", () => {
    // `football.shot` is the sport's only band-3 type and it has no dedicated
    // tile — it rides the More sheet, which `filterTilesByBand` never filters,
    // so a tile count is identical at bands 2 and 3. The premise is re-derived
    // from the engine here rather than asserted from memory.
    const folded = footballH1();
    const spec = football.padSpec(folded.cfg);
    const bandThreeOnly = Object.entries(spec.fidelity).filter(([, band]) => band === 3);
    expect(bandThreeOnly.length, "football no longer declares a band-3 type — this case needs rewriting").toBeGreaterThan(0);

    const truth = truthFor(footballSkin, spec, folded);
    expect(truth[3]).toBeGreaterThan(truth[2]!);
    // ...and the extra action is exactly the band-3 type the engine declares.
    const atTwo = reachableActionTypes(footballSkin, spec, viewAt(folded, 2), 2);
    const atThree = reachableActionTypes(footballSkin, spec, viewAt(folded, 3), 3);
    const gained = [...atThree].filter((type) => !atTwo.has(type)).sort();
    expect(gained).toEqual(bandThreeOnly.map(([type]) => type).sort());
  });

  it("counts only what a thumb can land on — a sheet no tile opens is NOT an action on the pad", () => {
    // `dedicatedEventTypes` deliberately keeps a sheet's event claimed when no
    // tile opens it at all (its own doc: "left claimed, deliberately"), which
    // is right for its real job — removing a duplicate from More — and wrong
    // as a count. Football still BUILDS its card and penalty sheets at band 0;
    // no tile opens either. A count that trusted `dedicated` advertised them.
    const folded = footballH1();
    const spec = football.padSpec(folded.cfg);
    const atZero = reachableActionTypes(footballSkin, spec, viewAt(folded, 0), 0);
    const aboveZero = Object.entries(spec.fidelity)
      .filter(([, band]) => band > 0)
      .map(([type]) => type);
    expect(aboveZero.length, "football declares no type above band 0 — this case needs rewriting").toBeGreaterThan(0);
    const leaked = aboveZero.filter((type) => atZero.has(type));
    expect(leaked, `band 0 advertised actions it cannot reach: ${leaked.join(", ")}`).toEqual([]);
  });

  it("a tapModel-S skin counts its scorebug half: badminton gains the rally at band 3", () => {
    // The other shape entirely — badminton's rally is dispatched from a
    // scorebug HALF, not a tile, so a count built only from the grid would
    // miss the one action that band 3 buys on that sport. Folded through the
    // REAL fold and past `core.start`, because `applyRally` refuses while the
    // phase is still "pre" and an unstarted match makes no half tappable.
    const badmintonModule = moduleFor("badminton");
    const cfg = badmintonModule.configSchema.parse({});
    const spec = badmintonModule.padSpec(cfg);
    const skin = badmintonSkinV3(t);
    const lineups: LineupPair = {
      home: { entrantId: "H", slots: [{ personId: "H1", slot: "starting", orderNo: 1 }] },
      away: { entrantId: "A", slots: [{ personId: "A1", slot: "starting", orderNo: 1 }] },
    };
    const events = [makeEnvelope(0, { type: "core.start", payload: {} } as never)];
    const folded = { cfg, state: foldClient(badmintonModule as never, cfg, lineups, events), lineups, events };
    const counts = BANDS.map((band) => reachableActionTypes(skin, spec, badmintonView(folded, band), band).size);
    const rallyType = Object.entries(spec.fidelity).find(([type]) => type.endsWith(".rally"));
    expect(rallyType?.[1], "badminton's rally is no longer band 3 — this case needs rewriting").toBe(3);
    expect(counts[3], `badminton counts were ${counts.join("/")}`).toBeGreaterThan(counts[2]!);
  });
});
