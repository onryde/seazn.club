// Sign-off review 2026-08-17: the v3 host rendered every tile a skin declared
// regardless of the org's fidelity band, so an org without
// `scoring.ball_by_ball` saw the ball tiles and each tap earned a server
// refusal (`assertEntitledToScore`, server/usecases/scoring.ts gates at the
// scoring door). No data was lost — but a control that always fails is not a
// control.
//
// The filter is FAIL-OPEN on purpose, and the two fail-open cases below are
// the ones that matter: hiding a control we could not classify is worse than
// showing one that refuses, because a scorer can report a refusal but cannot
// report a button that was never drawn.
import { describe, it, expect } from "vitest";
import { filterTilesByBand, tileEventType } from "../pad-host";
import { MORE_SHEET_KEY, type GuidedSheetSpec, type SwapSlot, type TileSpec } from "../types";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";

function tile(id: string, action: TileSpec["action"]): TileSpec {
  return { id, label: `l.${id}`, kind: "standard", phases: ["live"], action };
}

const FIDELITY: PadSpec["fidelity"] = {
  "cricket.ball": 3,
  "cricket.innings.summary": 0,
  "cricket.player.line": 2,
  "cricket.toss": 1,
  "football.sub": 2,
};

const SHEETS: Record<string, GuidedSheetSpec> = {
  wicket: { event: "cricket.ball", steps: [], buildPayload: () => ({}) },
  summary: { event: "cricket.innings.summary", steps: [], buildPayload: () => ({}) },
};

// R3 chassis sub-wave, defect 3 (owner ruling 2026-08-24). A swap tile was
// NEVER band-filtered: `tileEventType` returned null for it, so it was always
// kept. `football.sub` sits at band 2, absent from tiers 0/1 — a band-0 scorer
// would tap Sub, pick two people, and be refused at the scoring door. That is
// the dead-end tap this programme keeps closing.
const SWAPS: readonly SwapSlot[] = [
  {
    id: "subHome",
    offLabel: "l.off",
    onLabel: "l.on",
    side: "home",
    eventType: "football.sub",
    policyOk: true,
    buildEvent: () => ({ type: "football.sub", payload: {} }),
  },
];

const bands = (...b: FidelityBand[]): ReadonlySet<FidelityBand> => new Set(b);

describe("tileEventType", () => {
  it("reads a direct event tile's type", () => {
    expect(tileEventType(tile("t", { event: { type: "cricket.ball", payload: {} } }), SHEETS, SWAPS)).toBe("cricket.ball");
  });

  it("resolves a sheet tile through the skin's own sheet map", () => {
    expect(tileEventType(tile("w", { sheet: "wicket" }), SHEETS, SWAPS)).toBe("cricket.ball");
  });

  it("returns null for the MORE sheet — it hosts the whole padSpec action list, not one event", () => {
    expect(tileEventType(tile("more", { sheet: MORE_SHEET_KEY }), SHEETS, SWAPS)).toBeNull();
  });

  it("resolves a swap tile through the skin's own declared slots — the defect was a swap tile that could never be classified", () => {
    expect(tileEventType(tile("s", { swap: "subHome" }), SHEETS, SWAPS)).toBe("football.sub");
  });

  it("returns null for a swap tile naming a slot the skin does not declare — fail-open, never a guess", () => {
    expect(tileEventType(tile("s", { swap: "subNobody" }), SHEETS, SWAPS)).toBeNull();
  });

  it("returns null for a sheet key the skin does not declare", () => {
    expect(tileEventType(tile("x", { sheet: "nope" }), SHEETS, SWAPS)).toBeNull();
  });
});

describe("filterTilesByBand", () => {
  it("hides a band-3 ball tile from an org holding only 0 and 1 — the defect this fixes", () => {
    const tiles = [
      tile("ball", { event: { type: "cricket.ball", payload: {} } }),
      tile("toss", { event: { type: "cricket.toss", payload: {} } }),
    ];
    const kept = filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0, 1)).map((t) => t.id);
    expect(kept).toEqual(["toss"]);
  });

  it("keeps the ball tile for an org that holds band 3", () => {
    const tiles = [tile("ball", { event: { type: "cricket.ball", payload: {} } })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0, 1, 2, 3))).toHaveLength(1);
  });

  it("hides a SHEET tile whose underlying event is above the band — a wicket sheet dispatches cricket.ball", () => {
    const tiles = [tile("wicket", { sheet: "wicket" })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0, 1))).toHaveLength(0);
  });

  it("NEVER hides the MORE tile — it is exactly where a low-band org reaches innings.summary", () => {
    const tiles = [tile("more", { sheet: MORE_SHEET_KEY })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("fail-open: keeps a tile whose event type carries no fidelity entry at all", () => {
    const tiles = [tile("unknown", { event: { type: "cricket.brand.new", payload: {} } })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("HIDES a swap tile whose declared event is above the band — defect 3: a band-0 scorer could tap Sub, pick two people, and only THEN be refused", () => {
    const tiles = [tile("swap", { swap: "subHome" })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0, 1))).toHaveLength(0);
  });

  it("keeps that same swap tile for an org that holds the band", () => {
    const tiles = [tile("swap", { swap: "subHome" })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0, 1, 2))).toHaveLength(1);
  });

  it("fail-open: keeps a swap tile naming a slot the skin does not declare — an unclassifiable control is shown, never hidden", () => {
    const tiles = [tile("swap", { swap: "subNobody" })];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("NEVER band-filters the MORE tile even now that swap tiles ARE filtered — the two nulls are different and must stay different", () => {
    const tiles = [tile("more", { sheet: MORE_SHEET_KEY })];
    expect(tileEventType(tiles[0]!, SHEETS, SWAPS)).toBeNull();
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("a band-0 org still keeps its summary tile — hiding must not leave an empty pad", () => {
    const tiles = [
      tile("ball", { event: { type: "cricket.ball", payload: {} } }),
      tile("summary", { sheet: "summary" }),
    ];
    expect(filterTilesByBand(tiles, SHEETS, SWAPS, FIDELITY, bands(0)).map((t) => t.id)).toEqual(["summary"]);
  });
});
