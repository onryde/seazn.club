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
import { tilesForPhase, assertTileHierarchy, TileGrid } from "../tile-grid";
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

// Fix round 1, review finding 1 (Important): a grid item's default
// `min-width: auto` is content-based, so an unbreakable single-token i18n
// label in the last column can push the whole grid past a 320px viewport
// even though `grid-cols-4` resolves to `repeat(4, minmax(0,1fr))` —
// `minmax(0,1fr)` frees the TRACK's automatic minimum, not the ITEM's own
// content-based one. Fix: `min-w-0` on the tile button (the grid item) +
// `break-words` on the label/sublabel spans (so the text's own min-content
// size can shrink below its full unbroken width).
//
// The primary proof for this fix is EMPIRICAL, not this unit test: the
// real compiled Tailwind v4 CSS (via `@tailwindcss/postcss`, the same
// plugin apps/web's own build uses) rendered at a 320px viewport in
// headless Chromium, comparing `document.scrollWidth` against
// `clientWidth` before and after these two classes — see
// task-6-report.md's FIX ROUND 1 section for the exact numbers. That
// browser session was attempted from this environment but the shared
// Playwright MCP browser profile was locked by a concurrent session in
// this worktree at the time (confirmed via a harmless read-only
// `browser_tabs` "list" call, which failed identically to the navigate
// call — not something safe to force past by killing another agent's
// live browser). This describe block is the sanctioned fallback named in
// the review: a direct assertion that the fix's classes are present on
// the actual rendered output, reached by calling `TileGrid` as a plain
// function (React elements are plain objects; no jsdom needed) and
// invoking its child `Tile` element's own function to reach the real
// <button>/<span> props.
/** Minimal shape for reading rendered props back out — deliberately NOT
 *  React's own `ReactElement<P, T>` generics (its `.type` field's built-in
 *  type is `string | JSXElementConstructor<P>`, which has no call
 *  signature, so a real ReactElement type can't express "call `.type` as a
 *  function" without fighting the library's own types). This describes
 *  only the structural shape this test actually reads. */
interface RenderedEl<P> {
  type: (props: P) => RenderedEl<unknown> | { props: { className: string } };
  props: P;
}
interface SpanEl {
  props: { className: string };
}

describe("Tile rendering — finding 1 fix: min-w-0 / break-words present on the rendered output", () => {
  function renderTile(spec: TileSpec) {
    const grid = TileGrid({ tiles: [spec], phase: "live", t: (k) => k }) as unknown as RenderedEl<{
      children: RenderedEl<unknown>[];
    }>;
    const [tileEl] = grid.props.children;
    const button = tileEl.type(tileEl.props) as unknown as {
      props: { className: string; children: [SpanEl, SpanEl | false] };
    };
    return button;
  }

  it("the tile button carries min-w-0, so it can shrink below its content width as a grid item", () => {
    const button = renderTile(tile({ kind: "standard" }));
    expect(button.props.className).toContain("min-w-0");
  });

  it("the label span carries break-words, so an unbreakable token can wrap instead of forcing overflow", () => {
    const button = renderTile(tile({ kind: "standard" }));
    const [labelSpan] = button.props.children;
    expect(labelSpan.props.className).toContain("break-words");
  });

  it("the sublabel span also carries break-words when a sublabel is declared", () => {
    const button = renderTile(tile({ kind: "standard", sublabel: "pad.tile.sub" }));
    const [, sublabelSpan] = button.props.children;
    expect(sublabelSpan && sublabelSpan.props.className).toContain("break-words");
  });
});
