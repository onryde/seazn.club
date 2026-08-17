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
import { MORE_SHEET_KEY, type GuidedSheetSpec, type TileSpec } from "../types";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";

function tile(id: string, action: TileSpec["action"]): TileSpec {
  return { id, label: `l.${id}`, kind: "standard", phases: ["live"], action };
}

const FIDELITY: PadSpec["fidelity"] = {
  "cricket.ball": 3,
  "cricket.innings.summary": 0,
  "cricket.player.line": 2,
  "cricket.toss": 1,
};

const SHEETS: Record<string, GuidedSheetSpec> = {
  wicket: { event: "cricket.ball", steps: [], buildPayload: () => ({}) },
  summary: { event: "cricket.innings.summary", steps: [], buildPayload: () => ({}) },
};

const bands = (...b: FidelityBand[]): ReadonlySet<FidelityBand> => new Set(b);

describe("tileEventType", () => {
  it("reads a direct event tile's type", () => {
    expect(tileEventType(tile("t", { event: { type: "cricket.ball", payload: {} } }), SHEETS)).toBe("cricket.ball");
  });

  it("resolves a sheet tile through the skin's own sheet map", () => {
    expect(tileEventType(tile("w", { sheet: "wicket" }), SHEETS)).toBe("cricket.ball");
  });

  it("returns null for the MORE sheet — it hosts the whole padSpec action list, not one event", () => {
    expect(tileEventType(tile("more", { sheet: MORE_SHEET_KEY }), SHEETS)).toBeNull();
  });

  it("returns null for a swap tile — its event is built from the picked people at tap time", () => {
    expect(tileEventType(tile("s", { swap: true }), SHEETS)).toBeNull();
  });

  it("returns null for a sheet key the skin does not declare", () => {
    expect(tileEventType(tile("x", { sheet: "nope" }), SHEETS)).toBeNull();
  });
});

describe("filterTilesByBand", () => {
  it("hides a band-3 ball tile from an org holding only 0 and 1 — the defect this fixes", () => {
    const tiles = [
      tile("ball", { event: { type: "cricket.ball", payload: {} } }),
      tile("toss", { event: { type: "cricket.toss", payload: {} } }),
    ];
    const kept = filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0, 1)).map((t) => t.id);
    expect(kept).toEqual(["toss"]);
  });

  it("keeps the ball tile for an org that holds band 3", () => {
    const tiles = [tile("ball", { event: { type: "cricket.ball", payload: {} } })];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0, 1, 2, 3))).toHaveLength(1);
  });

  it("hides a SHEET tile whose underlying event is above the band — a wicket sheet dispatches cricket.ball", () => {
    const tiles = [tile("wicket", { sheet: "wicket" })];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0, 1))).toHaveLength(0);
  });

  it("NEVER hides the MORE tile — it is exactly where a low-band org reaches innings.summary", () => {
    const tiles = [tile("more", { sheet: MORE_SHEET_KEY })];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("fail-open: keeps a tile whose event type carries no fidelity entry at all", () => {
    const tiles = [tile("unknown", { event: { type: "cricket.brand.new", payload: {} } })];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("fail-open: keeps a swap tile, whose event cannot be known statically", () => {
    const tiles = [tile("swap", { swap: true })];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0))).toHaveLength(1);
  });

  it("a band-0 org still keeps its summary tile — hiding must not leave an empty pad", () => {
    const tiles = [
      tile("ball", { event: { type: "cricket.ball", payload: {} } }),
      tile("summary", { sheet: "summary" }),
    ];
    expect(filterTilesByBand(tiles, SHEETS, FIDELITY, bands(0)).map((t) => t.id)).toEqual(["summary"]);
  });
});
