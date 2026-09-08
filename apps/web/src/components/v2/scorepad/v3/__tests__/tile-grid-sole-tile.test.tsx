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
