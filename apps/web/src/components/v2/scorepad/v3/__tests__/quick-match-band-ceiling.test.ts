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
import { quickMatchBandCeiling } from "@/lib/quick-match-pad";
import { foldClient } from "../../module-client";
import { bandsUpTo, capBand, defaultBandFor, filterTilesByBand, tileEventType, withoutPersonSlots } from "../pad-host";
import { BANDS } from "../recording-chip";
import { resolvePad } from "../registry";
import type { ContextStripSpec, PadHostView, TileSpec } from "../types";

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
});
