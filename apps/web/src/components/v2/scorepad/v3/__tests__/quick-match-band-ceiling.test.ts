// Quick match cricket (decision log 2026-11-13: QM cricket = bands 0–1, the pad HIDES the ball tiles and the bowler slot;
// today they show disabled with "No bowler is eligible"). The guest's pad caps the Recording band at the sport's quick
// match ceiling (`quickMatchBandCeiling`, lib/quick-match-pad.ts), offers only the bands up to it, and drops the context
// strip's person pickers (a quick match side has nobody in it to pick). The organiser's cricket pad is unchanged.
//
// The harness cannot mount a whole PadHostV3 (pad-host-band-storage.test.tsx: its pipeline never converges under the node
// harness), so the host's rule is these pure pieces, each driven here against the REAL cricket skin over a REAL fold of a
// quick match's own shape (two name-only sides, no lineup), and the wiring is pinned in the host's source below and driven
// for real by e2e/mobile/quick-match.spec.ts's cricket leg. Expected sets come from the engine's band map, never the host.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initSquads, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { makeEnvelope } from "@seazn/engine/testkit";
import { personAttributedEvents, quickMatchBandCeiling } from "@/lib/quick-match-pad";
import { foldClient } from "../../module-client";
import {
  bandsUpTo,
  capBand,
  dedicatedEventTypes,
  defaultBandFor,
  filterTilesByBand,
  moreActions,
  quickMatchSkin,
  reachableControls,
  tileEventType,
  withoutPersonSlots,
} from "../pad-host";
import { BANDS } from "../recording-chip";
import { resolvePad } from "../registry";
import type { ContextStripSpec, PadHostView, ScorebugSpec, SkinDefV3, TileSpec } from "../types";

const t = (key: string) => key;
const modules = builtinModules as readonly AnySportModule[];
const cricket = modules.find((m) => m.key === "cricket")!;

/** A quick match's seats: two name-only sides, nobody in them (quick-match-create.ts creates no members). */
const NAMELESS: LineupPair = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } };

function viewOf(variant: string, events: readonly { type: string; payload: unknown }[], band: FidelityBand): PadHostView {
  const cfg = cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[variant]);
  const envelopes: EventEnvelope[] = events.map((e, i) => makeEnvelope(i, { type: e.type, payload: e.payload } as never));
  const state = foldClient(cricket, cfg, NAMELESS, envelopes);
  return {
    cfg,
    state,
    summary: cricket.summary(state as never),
    phase: "live",
    band,
    entitlements: {},
    personNames: {},
    squads: initSquads(NAMELESS),
    events: envelopes,
    contextOverrides: {},
    stageKind: "league",
    canOrganise: false,
    entrantNames: { home: "Falcons", away: "Kites" },
  };
}

/** What the pad draws at `band`: the skin's tiles through the host's own band filter, and its context strip. */
function drawn(view: PadHostView, nameless: boolean) {
  const skin = resolvePad("cricket", t);
  const spec = cricket.padSpec!(view.cfg as never);
  const sheets = skin.sheets?.(view) ?? {};
  const swaps = skin.swap?.(view) ?? [];
  const tiles = filterTilesByBand(skin.tiles(view), sheets, swaps, spec.fidelity, view.band);
  const raw = skin.context?.(view) ?? null;
  return { spec, sheets, swaps, tiles, context: nameless ? withoutPersonSlots(raw) : raw };
}
const START = [{ type: "core.start", payload: {} }];
const AFTER_AN_OVER = [...START, { type: "cricket.innings.summary", payload: { runs: 9, wickets: 0, legalBalls: 6, boundaries: 1, partial: true } }];

describe("capBand / bandsUpTo / withoutPersonSlots: the empty cases first", () => {
  it("no ceiling leaves the band and the four bands alone; a ceiling caps and cuts", () => {
    for (const b of BANDS) expect(capBand(b, null)).toBe(b);
    expect(bandsUpTo(null)).toEqual(BANDS);
    let checked = 0;
    for (const ceiling of BANDS) {
      for (const b of BANDS) {
        expect(capBand(b, ceiling), `${b} under ${ceiling}`).toBe(Math.min(b, ceiling));
        checked++;
      }
      expect(bandsUpTo(ceiling)).toEqual(BANDS.filter((b) => b <= ceiling));
    }
    expect(checked).toBe(16);
  });

  it("no strip stays no strip; a strip of person pickers only is no strip; a mode statement survives", () => {
    expect(withoutPersonSlots(null)).toBeNull();
    const person = { id: "bowler", label: "l", pool: "onfield", required: true } as const;
    const mode = { id: "mode", label: "m", pool: "onfield", required: false, kind: "mode", readOnly: true } as const;
    expect(withoutPersonSlots({ slots: [person] })).toBeNull();
    expect(withoutPersonSlots({ slots: [{ ...person, kind: "person" }] })).toBeNull();
    const kept = withoutPersonSlots({ slots: [person, mode], modeReserve: [{ label: "x", message: "y" }] }) as ContextStripSpec;
    expect(kept.slots.map((s) => s.id)).toEqual(["mode"]);
    expect(kept.modeReserve).toEqual([{ label: "x", message: "y" }]);
  });
});

describe("the quick match cricket pad against the organiser's: a control-set diff from the real skin and fold", () => {
  const ballTypes = new Set(["cricket.ball", "cricket.superover.ball"]);
  const variants = Object.keys(cricket.variants as object);

  it("anti-vacuity: every cricket variant has a ceiling below the sport's own default band", () => {
    expect(variants.length).toBeGreaterThan(0);
    for (const v of variants) {
      const spec = cricket.padSpec!(cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[v]) as never);
      const ceiling = quickMatchBandCeiling("cricket", spec);
      expect(ceiling, v).not.toBeNull();
      expect(ceiling!, v).toBeLessThan(defaultBandFor(spec.fidelity));
    }
  });

  for (const [label, events] of [["before the first over", START], ["after an over summary", AFTER_AN_OVER]] as const) {
    it(`${label}: the organiser's pad draws the ball tiles and the bowler; the guest's draws neither, on every variant`, () => {
      let checked = 0;
      for (const v of variants) {
        const spec0 = cricket.padSpec!(cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[v]) as never);
        const organiserBand = defaultBandFor(spec0.fidelity);
        const guestBand = capBand(organiserBand, quickMatchBandCeiling("cricket", spec0));
        const organiser = drawn(viewOf(v, events, organiserBand), false);
        const guest = drawn(viewOf(v, events, guestBand), true);
        const typeOf = (d: typeof organiser, tile: TileSpec) => tileEventType(tile, d.sheets, d.swaps);
        const bandOf = (d: typeof organiser, tile: TileSpec) => {
          const type = typeOf(d, tile);
          return type === null ? undefined : d.spec.fidelity[type];
        };

        // The guest draws no tile above its ceiling, so no ball (band 3 in the engine's map) and no player line (2).
        for (const tile of guest.tiles) {
          const band = bandOf(guest, tile);
          if (band !== undefined) expect(band, `${v} ${tile.id}`).toBeLessThanOrEqual(guestBand);
          expect(ballTypes.has(typeOf(guest, tile) ?? ""), `${v} ${tile.id}: a ball tile on the guest's pad`).toBe(false);
        }
        const guestIds = new Set(guest.tiles.map((x) => x.id));
        const organiserIds = new Set(organiser.tiles.map((x) => x.id));
        // Every tile the guest keeps is one the organiser has: the cap only removes.
        for (const id of guestIds) expect(organiserIds.has(id), `${v}: ${id} only on the guest's pad`).toBe(true);
        // What the cap removed is exactly the organiser's tiles above the ceiling.
        const removed = organiser.tiles.filter((x) => !guestIds.has(x.id));
        for (const tile of removed) expect(bandOf(organiser, tile), `${v} ${tile.id}`).toBeGreaterThan(guestBand);

        // The person pickers: the organiser's strip has the bowler (and the batters); the guest's has no picker at all.
        const organiserSlots = organiser.context?.slots.map((s) => s.id) ?? [];
        expect(organiserSlots, `${v}: the organiser's bowler slot`).toContain("bowler");
        expect(guest.context?.slots.some((s) => s.kind !== "mode") ?? false, `${v}: a person picker on the guest's pad`).toBe(false);
        checked++;
      }
      expect(checked, "variants compared").toBe(variants.length);
    });
  }

  it("before the first over the organiser's ball tiles wait on a bowler (the 'No bowler is eligible' pad the guest no longer sees)", () => {
    const v = "t20";
    const spec = cricket.padSpec!(cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[v]) as never);
    const organiser = drawn(viewOf(v, START, defaultBandFor(spec.fidelity)), false);
    const balls = organiser.tiles.filter((x) => ballTypes.has(tileEventType(x, organiser.sheets, organiser.swaps) ?? ""));
    expect(balls.length, "premise: the organiser's pad draws ball tiles").toBeGreaterThan(0);
    expect(balls.every((x) => x.disabled === true), "and every one waits").toBe(true);
    const bowler = organiser.context!.slots.find((s) => s.id === "bowler")!;
    expect(bowler.message).toBe("pad.cricket.context.bowler.blocked.noEligible");
    // The guest's pad offers the over summary instead, enabled (single-sport: the over-summary lane is cricket's own).
    const guest = drawn(viewOf(v, START, 1), true);
    const over = guest.tiles.find((x) => x.id === "overSummary");
    expect(over, "the over-summary tile").toBeDefined();
    expect(over!.disabled ?? false).toBe(false);
  });
});

// Sign-off 2026-11-14 (controller, PO rec): the guest's pad still drew a Review tile, and its scorebug strip still held the
// striker's ▸ and the bowler's ⚾ with nobody's name beside them. A capped pad's skin (`quickMatchSkin`) leaves out every
// action about a player (`personAttributedEvents`, from the engine's attributions) and every strip slot fed only by an
// event above the ceiling (`StripItem.fedBy`, read against the engine's band map). The organiser's skin is untouched.
describe("quickMatchSkin: the guest's cricket pad against the organiser's, same band, same fold", () => {
  const skin = resolvePad("cricket", t);
  const variants = Object.keys(cricket.variants as object);
  const specOf = (v: string) => cricket.padSpec!(cricket.configSchema.parse((cricket.variants as Record<string, unknown>)[v]) as never);
  /** The tiles a skin draws through the host's band filter, by id. */
  function tileIds(s: SkinDefV3, view: PadHostView, spec: ReturnType<typeof specOf>): string[] {
    return filterTilesByBand(s.tiles(view), s.sheets?.(view) ?? {}, s.swap?.(view) ?? [], spec.fidelity, view.band).map((x) => x.id);
  }
  /** The More sheet's entries as the host builds them from a skin. */
  function moreTypes(s: SkinDefV3, view: PadHostView, spec: ReturnType<typeof specOf>): string[] {
    const sheets = s.sheets?.(view) ?? {};
    const swaps = s.swap?.(view) ?? [];
    const tiles = filterTilesByBand(s.tiles(view), sheets, swaps, spec.fidelity, view.band);
    const dedicated = dedicatedEventTypes(tiles, sheets, swaps, s.scorebug(view));
    const refused = new Set(s.refusedEventTypes?.(view) ?? []);
    return moreActions(spec, { state: view.state, summary: view.summary, phase: view.phase, band: view.band }, dedicated, refused).map((a) => a.type);
  }
  const markers = (bug: ScorebugSpec) => bug.strip.filter((i) => i.value.startsWith("▸") || i.value.startsWith("⚾"));
  const CHASE = [
    ...AFTER_AN_OVER,
    { type: "cricket.innings.close", payload: { reason: "all_out" } },
    { type: "cricket.innings.summary", payload: { runs: 4, wickets: 0, legalBalls: 6, boundaries: 0, partial: true } },
  ];

  it("the empty case: a pad whose actions name nobody and whose strip feeds on nothing is drawn unchanged", () => {
    const view = viewOf("t20", AFTER_AN_OVER, 1);
    const empty = { panels: [], fidelity: {} };
    const unfed = (bug: ScorebugSpec): ScorebugSpec => ({ ...bug, strip: bug.strip.map((i) => ({ ...i, fedBy: undefined })) });
    const bare: SkinDefV3 = { ...skin, scorebug: (v) => unfed(skin.scorebug(v)) };
    const capped = quickMatchSkin(bare, empty, 1);
    expect(capped.tiles(view).map((x) => x.id)).toEqual(bare.tiles(view).map((x) => x.id));
    expect(capped.scorebug(view).strip).toEqual(bare.scorebug(view).strip);
    expect(new Set(capped.refusedEventTypes?.(view) ?? [])).toEqual(new Set(bare.refusedEventTypes?.(view) ?? []));
  });

  for (const [label, events] of [["after an over summary", AFTER_AN_OVER], ["in the chase", CHASE]] as const) {
    it(`${label}: the guest's pad drops the Review and the ▸/⚾ markers; the organiser's keeps both, on every variant`, () => {
      let checked = 0;
      for (const v of variants) {
        const spec = specOf(v);
        const ceiling = quickMatchBandCeiling("cricket", spec)!;
        const view = viewOf(v, events, ceiling);
        const guest = quickMatchSkin(skin, spec, ceiling);
        const about = personAttributedEvents(spec);

        // Tiles: the organiser's skin at the guest's band draws the Review; the guest's skin draws every one of the
        // organiser's tiles but the ones about a player, which is the Review alone at this band.
        const organiserIds = tileIds(skin, view, spec);
        const guestIds = tileIds(guest, view, spec);
        expect(organiserIds, `${v}: premise, the organiser's Review`).toContain("review");
        const sheets = skin.sheets?.(view) ?? {};
        const dropped = organiserIds.filter((id) => !guestIds.includes(id));
        expect(dropped, `${v}: what the guest's pad drops`).toEqual(["review"]);
        expect(guestIds, `${v}: the rest, in order`).toEqual(organiserIds.filter((id) => id !== "review"));
        for (const tile of guest.tiles(view)) {
          expect(about.has(tileEventType(tile, sheets, []) ?? ""), `${v} ${tile.id}: about a player`).toBe(false);
        }
        // Nor does the Review come back through the More sheet.
        expect(moreTypes(skin, view, spec), `${v}: premise, the organiser dedicates the review to its tile`).not.toContain("cricket.review");
        expect(moreTypes(guest, view, spec), `${v}: the guest's More sheet`).not.toContain("cricket.review");
        // And the Recording chip's count for the guest's band is the pad it draws: one control fewer.
        expect(reachableControls(guest, spec, view, ceiling).total, v).toBe(reachableControls(skin, spec, view, ceiling).total - 1);

        // Strip: the organiser's (at the same band) still holds the empty ▸ and ⚾; the guest's holds neither, nor the
        // over dots or the free hit slot (all fed by the ball, band 3); what is left is fed by nothing above the ceiling.
        const organiserBug = skin.scorebug(view);
        const guestBug = guest.scorebug(view);
        expect(markers(organiserBug).length, `${v}: premise, the organiser's markers`).toBe(2);
        expect(markers(guestBug), `${v}: the guest's markers`).toEqual([]);
        for (const item of guestBug.strip) {
          if (item.fedBy !== undefined) expect(spec.fidelity[item.fedBy] ?? 0, `${v} ${item.value}`).toBeLessThanOrEqual(ceiling);
        }
        // Everything else on the scorebug is the organiser's: the halves (the score), the context line.
        expect(guestBug.halves).toEqual(organiserBug.halves);
        expect(guestBug.context).toBe(organiserBug.context);
        checked++;
      }
      expect(checked, "variants compared").toBe(variants.length);
    });
  }

  it("an action about a player that only the More sheet offers is refused there too (a sheet with no tile stays claimed today)", () => {
    // Today the Review's sheet keeps it out of More even with its tile gone (`dedicatedEventTypes`: a sheet no tile opens
    // stays claimed), so the refusal is proved on the shape it exists for: the same skin with no Review sheet, where the
    // organiser's More sheet lists the review and the guest's must not.
    const spec = specOf("t20");
    const view = viewOf("t20", AFTER_AN_OVER, 1);
    const sheetless: SkinDefV3 = {
      ...skin,
      tiles: (v) => skin.tiles(v).filter((x) => x.id !== "review"),
      sheets: (v) => Object.fromEntries(Object.entries(skin.sheets?.(v) ?? {}).filter(([, sh]) => sh.event !== "cricket.review")),
    };
    expect(moreTypes(sheetless, view, spec), "premise: More lists a tile-less review").toContain("cricket.review");
    expect(moreTypes(quickMatchSkin(sheetless, spec, 1), view, spec)).not.toContain("cricket.review");
  });

  it("the first innings leaves the guest's strip empty; the chase leaves it the target alone", () => {
    const spec = specOf("t20");
    const guest = quickMatchSkin(skin, spec, 1);
    expect(guest.scorebug(viewOf("t20", AFTER_AN_OVER, 1)).strip).toEqual([]);
    const chase = guest.scorebug(viewOf("t20", CHASE, 1)).strip;
    expect(chase.map((i) => [i.label, i.value])).toEqual([["scorepad.skin.cricket.header.target", "10"]]);
  });
});

describe("the host wires the cap only for a quick match (the seam, read in the source)", () => {
  // Driven for real by e2e/mobile/quick-match.spec.ts (the guest's cricket pad) and by the organiser cricket e2e specs,
  // which this change leaves alone.
  const src = readFileSync(resolve(import.meta.dirname, "../pad-host.tsx"), "utf8");
  it("the ceiling is read only when the pad is a quick match's, and the band, the chip's rows and the strip all take it", () => {
    expect(src).toMatch(/props\.quickMatch\s*\?\s*quickMatchBandCeiling\(props\.module\.key, spec\)\s*:\s*null/);
    expect(src).toContain("const [band, onBandChange] = usePadBand(props.fixtureId, spec.fidelity, bandCeiling);");
    expect(src).toMatch(/<RecordingChip\s+activeBand=\{band\}\s+onBandChange=\{onBandChange\}\s+bands=\{bandsUpTo\(bandCeiling\)\}/);
    expect(src).toMatch(/bandCeiling === null \? raw : withoutPersonSlots\(raw\)/);
  });
  it("the capped skin replaces the skin only on a quick match's pad, and the tiles, the count, the scorebug and the refusals read it", () => {
    expect(src).toMatch(/bandCeiling === null \? props\.skin : quickMatchSkin\(props\.skin, spec, bandCeiling\)/);
    expect(src).toContain("const allTiles = useMemo(() => padSkin.tiles(view), [padSkin, view]);");
    expect(src).toContain("reachableControls(padSkin, spec, view, candidate)");
    expect(src).toContain("const scorebugSpec = useMemo(() => padSkin.scorebug(view), [padSkin, view]);");
    expect(src).toContain("new Set(padSkin.refusedEventTypes?.(view) ?? [])");
  });
});
