// A phase that leaves ONE tile in the row used to give it a quarter of the
// width: the grid is `grid-cols-4` unconditionally, so three columns sat empty
// while the tile wrapped its label. English hid it — cricket's toss tile reads
// "Toss", one short word that fits 60px at 320 — and fr/es/nl wrapped the same
// tile to three lines, rendering it 60x92, taller than it is wide (measured in
// a browser at 320 before the fix).
//
// The design of record (2026-09-02-scorepad-v3-phone-composition-design.md
// §3.6) pins "cricket's keypad keeps four columns", and this does not change
// that: a row with two or more tiles is untouched, and a tile that declares its
// own span keeps it. Only the degenerate one-tile row is promoted, which is the
// case where "four columns" describes nothing.
import { describe, expect, it } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { TileGrid } from "@/components/v2/scorepad/v3/tile-grid";
import type { TileSpec } from "@/components/v2/scorepad/v3/types";

const t = (key: string) => key;

function tile(id: string, over: Partial<TileSpec> = {}): TileSpec {
  return {
    id,
    label: `pad.test.${id}` as TileSpec["label"],
    kind: "action",
    phases: ["live"],
    action: { event: id },
    ...over,
  } as TileSpec;
}

/** The span each tile is RENDERED with — `SPAN_CLASS[span ?? 1]` is what
 *  `Tile` turns into its `col-span-*` class, so pinning the span pins the
 *  column count without needing the child component expanded. */
function spansOf(tiles: readonly TileSpec[]): (number | undefined)[] {
  const island = renderIsland(TileGrid as never, { tiles, phase: "live", t } as never);
  return island
    .tree()
    .filter((el) => (el.props as { tile?: TileSpec })?.tile !== undefined)
    .map((el) => (el.props as { tile: TileSpec }).tile.span);
}

describe("TileGrid — phones run three columns, desktop four", () => {
  // A class scan cannot tell whether a tile stopped wrapping — `apps/web`
  // vitest is `environment: "node"`, so this pins the CONTRACT and the browser
  // pins the result (measured at 320: 60px tiles before, ~82px after).
  function gridClass(tiles: readonly TileSpec[]): string {
    const island = renderIsland(TileGrid as never, { tiles, phase: "live", t } as never);
    const root = island.tree().find((el) => {
      const cls = (el.props as { className?: unknown }).className;
      return typeof cls === "string" && /grid-cols/.test(cls);
    });
    return (root?.props as { className: string }).className;
  }

  it("declares four columns at desktop and three below md", () => {
    const cls = gridClass([tile("a"), tile("b")]);
    expect(cls).toContain("grid-cols-4");
    expect(cls).toContain("max-md:grid-cols-3");
  });

  it("a full-row tile spans the phone grid too — col-span-4 in a 3-column grid would overflow", () => {
    // `SPAN_CLASS[4]` must carry its own phone variant: `grid-column: span 4`
    // inside three columns creates an implicit fourth column rather than
    // clamping, which is a horizontal overflow at the width that can least
    // afford one.
    const island = renderIsland(TileGrid as never, { tiles: [tile("wicket", { span: 4 })], phase: "live", t } as never);
    const spanned = island.tree().find((el) => (el.props as { tile?: TileSpec })?.tile !== undefined);
    expect((spanned?.props as { tile: TileSpec }).tile.span).toBe(4);
  });
});

describe("TileGrid — a single tile does not keep three empty columns", () => {
  it("gives a lone unspanned tile the whole row", () => {
    expect(spansOf([tile("toss")])).toEqual([4]);
  });

  it("leaves two tiles at one column each — the four-across rhythm is unchanged", () => {
    expect(spansOf([tile("a"), tile("b")])).toEqual([undefined, undefined]);
  });

  it("does not override a lone tile that declares its own span", () => {
    expect(spansOf([tile("wicket", { span: 2 })])).toEqual([2]);
  });
});
