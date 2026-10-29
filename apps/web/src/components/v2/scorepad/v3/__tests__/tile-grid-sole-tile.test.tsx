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
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { SPAN_CLASS, TILE_GRID_CLASS, TileGrid } from "@/components/v2/scorepad/v3/tile-grid";
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

describe("TileGrid — phones run six tracks (three tiles across), desktop four", () => {
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

  it("declares four columns at desktop and six tracks below md", () => {
    const cls = gridClass([tile("a"), tile("b")]);
    expect(cls).toBe(TILE_GRID_CLASS);
    expect(cls).toContain("grid-cols-4");
    expect(cls).toContain("max-md:grid-cols-6");
  });

  it("a full-row tile spans the phone grid too — col-span-4 in a 6-track grid would be two thirds of the row, and 6 of 4 would overflow", () => {
    // `SPAN_CLASS[4]` must carry its own phone variant: `grid-column: span 4`
    // inside a smaller grid creates implicit tracks rather than clamping, which
    // is a horizontal overflow at the width that can least afford one.
    const island = renderIsland(TileGrid as never, { tiles: [tile("wicket", { span: 4 })], phase: "live", t } as never);
    const spanned = island.tree().find((el) => (el.props as { tile?: TileSpec })?.tile !== undefined);
    expect((spanned?.props as { tile: TileSpec }).tile.span).toBe(4);
  });
});

// The owner's 320 tennis screenshot ("why not aligned in the center?"): the phone grid was three tracks and a span-2 tile kept
// `col-span-2`, so a Home/Away PAIR took two of three tracks, its partner could not sit beside it, and every pair stacked one
// per row in the left two thirds. The relation that keeps a pair side by side is a ratio between the grid's phone track
// count and each span's phone span, so it is read OFF the two class constants the renderer uses, never typed here.
describe("TileGrid — a half-row pair sits side by side on a phone, as it does on desktop", () => {
  const num = (re: RegExp, from: string, what: string): number => {
    const m = re.exec(from);
    if (m === null) throw new Error(`${what}: no match for ${re} in "${from}"`);
    return Number(m[1]);
  };
  const phoneTracks = num(/max-md:grid-cols-(\d+)/, TILE_GRID_CLASS, "the phone track count");
  const deskTracks = num(/(?:^|\s)grid-cols-(\d+)/, TILE_GRID_CLASS, "the desktop track count");
  const phoneSpan = (span: 1 | 2 | 3 | 4): number => num(/max-md:col-span-(\d+)/, SPAN_CLASS[span], `span ${span} phone class`);
  const deskSpan = (span: 1 | 2 | 3 | 4): number => num(/(?:^|\s)col-span-(\d+)/, SPAN_CLASS[span], `span ${span} desktop class`);
  const SPANS = [1, 2, 3, 4] as const;

  it("a span-2 tile is half the phone track count, so two of them fill one row", () => {
    expect(phoneSpan(2) * 2, "two span-2 tiles take the whole phone row").toBe(phoneTracks);
    // ...which is the same fraction of the row it is on desktop: the pair does not change shape between the grids.
    expect(phoneSpan(2) / phoneTracks).toBe(deskSpan(2) / deskTracks);
    expect(phoneTracks % 2, "the phone grid divides into halves").toBe(0);
  });

  it("a one-column tile keeps its phone share (three across), and spans 3 and 4 take the whole phone row", () => {
    // Design of record: phones put three one-column tiles across (the ~82px word-width the 320 cricket keypad needs).
    const PHONE_TILES_ACROSS = 3;
    expect(phoneTracks / phoneSpan(1), "three one-column tiles fill a phone row").toBe(PHONE_TILES_ACROSS);
    expect(phoneSpan(3)).toBe(phoneTracks);
    expect(phoneSpan(4)).toBe(phoneTracks);
  });

  it("no span exceeds the phone grid (an over-wide span adds implicit tracks and overflows the card), and desktop spans are unchanged", () => {
    let judged = 0;
    for (const span of SPANS) {
      expect(phoneSpan(span), `span ${span} fits the phone grid`).toBeLessThanOrEqual(phoneTracks);
      expect(deskSpan(span), `span ${span} keeps its desktop span`).toBe(span);
      expect(deskSpan(span), `span ${span} fits the desktop grid`).toBeLessThanOrEqual(deskTracks);
      judged++;
    }
    expect(judged, "every declared span was judged").toBe(Object.keys(SPAN_CLASS).length);
  });

  it("the real renderer puts that class on the buttons: a Home/Away pair of span-2 tiles, and a lone tile promoted to a full row", () => {
    const html = renderToStaticMarkup(
      <TileGrid tiles={[tile("home", { span: 2 }), tile("away", { span: 2 })]} phase="live" t={t} />,
    );
    const classes = [...html.matchAll(/<button[^>]*data-tile-id="([^"]+)"[^>]*class="([^"]*)"/g)].map((m) => [m[1], m[2]] as const);
    expect(classes.map(([id]) => id)).toEqual(["home", "away"]);
    for (const [id, cls] of classes) expect(cls, `${id} carries the span-2 class`).toContain(SPAN_CLASS[2]);
    expect(html).toContain(`class="${TILE_GRID_CLASS}"`);
    const lone = renderToStaticMarkup(<TileGrid tiles={[tile("toss")]} phase="live" t={t} />);
    expect(lone, "a lone unspanned tile gets the whole phone row").toContain(SPAN_CLASS[4]);
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
