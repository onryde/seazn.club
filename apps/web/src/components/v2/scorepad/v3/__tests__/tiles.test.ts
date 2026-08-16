// Task 6 (R1 chassis): TileGrid pure functions.
//
// tilesForPhase is the mechanism that stops set-score entry being offered
// mid-game and stops post-match actions appearing while play is live
// (D-16) — a skin's tiles(view) declares `phases` per tile; this filters to
// the ones live right now.
//
// assertTileHierarchy is the mechanism that makes "monster-button
// monotony" (the defect the previous pad was rejected for — every action
// the same visual weight, so Abandon read like a rally tap) structurally
// impossible: no skin can declare more than two `primary` tiles for one
// phase (D-12). Framed PER PHASE, not globally, mirroring the brief
// exactly: two primaries in "live" and two more in "post" is a legal
// 4-primary skin; three in the SAME phase is not. Never throws — returns
// violation strings, same non-throwing convention as `assertScorebugSpec`
// in ../types.ts (see ../__tests__/types.test.ts).
import { describe, it, expect } from "vitest";
import { tilesForPhase, assertTileHierarchy } from "../tile-grid";
import type { TileSpec } from "../types";

const tile = (over: Partial<TileSpec> = {}): TileSpec => ({
  id: "t",
  label: "pad.tile.label",
  kind: "standard",
  phases: ["live"],
  action: { event: { type: "x", payload: {} } },
  ...over,
});

describe("tilesForPhase", () => {
  it("keeps only tiles whose phases include the requested phase", () => {
    const tiles = [tile({ id: "a", phases: ["live"] }), tile({ id: "b", phases: ["pre"] })];
    expect(tilesForPhase(tiles, "live").map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps a multi-phase tile for every phase it declares", () => {
    const tiles = [tile({ id: "a", phases: ["live", "post"] })];
    expect(tilesForPhase(tiles, "live").map((t) => t.id)).toEqual(["a"]);
    expect(tilesForPhase(tiles, "post").map((t) => t.id)).toEqual(["a"]);
    expect(tilesForPhase(tiles, "pre").map((t) => t.id)).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(tilesForPhase([tile({ phases: ["pre"] })], "post")).toEqual([]);
  });
});

describe("assertTileHierarchy", () => {
  it("accepts exactly two primary tiles declared for one phase", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "standard", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("rejects three primary tiles declared for the same phase", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "primary", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual(['phase "live": 3 primary tiles declared (max 2)']);
  });

  it("does not aggregate primaries declared in DIFFERENT phases", () => {
    // Two primaries total, but one lives in "live" and the other in "post"
    // — neither phase individually exceeds two, so this is legal.
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["post"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("treats each phase independently: 2 in live + 2 in post is legal, not a global 4", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live"] }),
      tile({ id: "b", kind: "primary", phases: ["live"] }),
      tile({ id: "c", kind: "primary", phases: ["post"] }),
      tile({ id: "d", kind: "primary", phases: ["post"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });

  it("counts a multi-phase primary tile toward EVERY phase it declares", () => {
    const tiles = [
      tile({ id: "a", kind: "primary", phases: ["live", "post"] }),
      tile({ id: "b", kind: "primary", phases: ["live", "post"] }),
      tile({ id: "c", kind: "primary", phases: ["live", "post"] }),
    ];
    const v = assertTileHierarchy(tiles);
    expect(v).toContain('phase "live": 3 primary tiles declared (max 2)');
    expect(v).toContain('phase "post": 3 primary tiles declared (max 2)');
    expect(v).toHaveLength(2);
  });

  it("ignores non-primary kinds entirely, however many are declared", () => {
    const tiles = [
      tile({ id: "a", kind: "standard", phases: ["live"] }),
      tile({ id: "b", kind: "destructive", phases: ["live"] }),
      tile({ id: "c", kind: "minor", phases: ["live"] }),
      tile({ id: "d", kind: "standard", phases: ["live"] }),
    ];
    expect(assertTileHierarchy(tiles)).toEqual([]);
  });
});
