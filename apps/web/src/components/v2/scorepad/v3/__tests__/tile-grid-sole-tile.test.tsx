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

describe("TileGrid — phones wrap flex rows that fill the width, desktop keeps its four-column grid", () => {
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

  it("declares four columns at desktop and a wrapping flex row below md", () => {
    const cls = gridClass([tile("a"), tile("b")]);
    expect(cls).toBe(TILE_GRID_CLASS);
    const tokens = cls.split(/\s+/);
    expect(tokens, "desktop: the grid and its four columns").toEqual(expect.arrayContaining(["grid", "grid-cols-4"]));
    expect(tokens, "phone: a wrapping flex row").toEqual(expect.arrayContaining(["max-md:flex", "max-md:flex-wrap"]));
    // a leftover phone column count would be inert (a flex container has no tracks) and read as if the phone still had a grid
    expect(tokens.filter((c) => c.startsWith("max-md:grid-cols")), "no phone grid columns survive").toEqual([]);
  });

  it("a full-row tile spans the phone row too — a span that says only its desktop span would shrink to its content below md", () => {
    const island = renderIsland(TileGrid as never, { tiles: [tile("wicket", { span: 4 })], phase: "live", t } as never);
    const spanned = island.tree().find((el) => (el.props as { tile?: TileSpec })?.tile !== undefined);
    expect((spanned?.props as { tile: TileSpec }).tile.span).toBe(4);
  });
});

// The owner's complaint is DEAD SPACE on a 320 phone, not pairing as such. First the grid was three tracks and a span-2 tile
// kept two of them, so every Home/Away pair stacked one per row in the left two thirds; then six tracks paired them but left
// a lone span-2 tile at half the row and a span-1 + span-2 row (cricket's Close innings + End of over) a track short. So a
// phone row is a wrapping flex row: each tile has a span-weighted BASIS (a third, a half, the whole row, gap included) and
// GROWS, so whatever a row holds, it fills.
//
// Everything below is read OFF the class constants the renderer uses (the track count, the gap, each span's basis), never typed
// here; the one stated design constant is the three-across of a one-column tile, the word-width cricket's keypad needs.
describe("TileGrid — every phone row fills the row: a pair at halves, three one-column tiles at thirds, a lone tile whole", () => {
  const SPANS = [1, 2, 3, 4] as const;
  type Span = (typeof SPANS)[number];
  const num = (re: RegExp, from: string, what: string): number => {
    const m = re.exec(from);
    if (m === null) throw new Error(`${what}: no match for ${re} in "${from}"`);
    return Number(m[1]);
  };
  const deskTracks = num(/(?:^|\s)grid-cols-(\d+)/, TILE_GRID_CLASS, "the desktop track count");
  /** Tailwind's spacing scale: `gap-N` is N quarter-rems. */
  const gapRem = num(/(?:^|\s)gap-(\d+)/, TILE_GRID_CLASS, "the gap") * 0.25;
  const deskSpan = (span: Span): number => num(/(?:^|\s)col-span-(\d+)/, SPAN_CLASS[span], `span ${span} desktop class`);
  /** The phone basis of a span: how many tiles of that span fit across, the gap the calc subtracts for them, and the slack (px) it
   *  gives up on top so a browser's rounding cannot push the last tile off the row. `basis-full` is a bare 100%: no calc, no slack. */
  function basisOf(span: Span): { across: number; gapRem: number; slackPx: number } {
    const cls = SPAN_CLASS[span];
    if (/(?:^|\s)max-md:basis-full(?:\s|$)/.test(cls)) return { across: 1, gapRem: 0, slackPx: 0 };
    const m = /max-md:basis-\[calc\(\(100%_-_([\d.]+)rem\)\/(\d+)_-_([\d.]+)px\)\]/.exec(cls);
    if (m === null) throw new Error(`span ${span}: no phone basis in "${cls}"`);
    return { across: Number(m[2]), gapRem: Number(m[1]), slackPx: Number(m[3]) };
  }
  /** What a layout engine does to a basis when it decides whether the next tile still fits: nothing (an exact engine), or rounds it UP. */
  interface Engine {
    /** Applied to a tile's basis for the fit decision only; growing shares the exact free space. */
    snap?: (px: number) => number;
    /** Replaces every calc span's slack: 0 reproduces the basis as it was before the half pixel was given up. */
    slackPx?: number;
  }
  /** Flex's own line breaking and growing (flex-wrap, equal flex-grow 1), for a container of `width` px: the width of each tile, by row. */
  function layoutPhone(spans: readonly Span[], width: number, engine: Engine = {}): number[][] {
    const snap = engine.snap ?? ((px: number) => px);
    const gap = gapRem * 16;
    const rows: { bases: number[]; fits: number[] }[] = [];
    for (const span of spans) {
      const { across, gapRem: calcGap, slackPx } = basisOf(span);
      const basis = (width - calcGap * 16) / across - (slackPx > 0 ? (engine.slackPx ?? slackPx) : 0);
      const row = rows[rows.length - 1];
      const used = row === undefined ? 0 : row.fits.reduce((a, b) => a + b, 0) + gap * row.fits.length;
      if (row !== undefined && used + snap(basis) <= width + 1e-6) { row.bases.push(basis); row.fits.push(snap(basis)); }
      else rows.push({ bases: [basis], fits: [snap(basis)] });
    }
    return rows.map(({ bases }) => {
      const free = width - bases.reduce((a, b) => a + b, 0) - gap * (bases.length - 1);
      return bases.map((b) => b + free / bases.length);
    });
  }
  const filled = (row: readonly number[], width: number): number => row.reduce((a, b) => a + b, 0) + gapRem * 16 * (row.length - 1) - width;
  /** The measured phone widths of the grid (the card inside the page padding at 320 / 360 / 390). */
  const WIDTHS = [262, 302, 332] as const;

  it("every span names its phone basis and grows, so no row can leave dead space", () => {
    for (const span of SPANS) {
      expect(SPAN_CLASS[span], `span ${span} grows to fill`).toMatch(/(?:^|\s)max-md:grow(?:\s|$)/);
      expect(basisOf(span).across, `span ${span} fits at least one tile across`).toBeGreaterThanOrEqual(1);
    }
  });

  it("a basis is the row less its gaps, and less a sub-pixel slack: N tiles and their N-1 gaps fall short of the row by N x slack, never over it", () => {
    let judged = 0;
    let withSlack = 0;
    for (const span of SPANS) {
      const { across, gapRem: calcGap, slackPx } = basisOf(span);
      expect(calcGap, `span ${span}: the calc subtracts exactly the gaps between ${across} tiles`).toBeCloseTo((across - 1) * gapRem, 10);
      for (const width of WIDTHS) {
        const basis = (width - calcGap * 16) / across - slackPx;
        const total = across * basis + (across - 1) * gapRem * 16;
        expect(total, `span ${span} at ${width}px: ${across} tiles + gaps are the row less ${across} x ${slackPx}px`).toBeCloseTo(width - across * slackPx, 8);
        expect(total, `span ${span} at ${width}px: never over the row`).toBeLessThanOrEqual(width);
      }
      // A bare 100% (spans 3, 4) cannot overflow its row and carries none; a calc basis gives up a positive, sub-pixel slack.
      if (/calc\(/.test(SPAN_CLASS[span])) {
        expect(slackPx, `span ${span} gives up some slack`).toBeGreaterThan(0);
        expect(slackPx, `span ${span}'s slack is sub-pixel: grow hands it straight back`).toBeLessThan(1);
        withSlack++;
      } else expect(slackPx, `span ${span} is a bare 100%`).toBe(0);
      judged++;
    }
    expect(judged).toBe(Object.keys(SPAN_CLASS).length);
    expect(withSlack, "the calc spans (1 and 2) were judged").toBe(2);
  });

  it("a tile the engine rounds UP to the next device pixel still fits: three one-column tiles and a pair stay on one row (iOS/WebKit snaps to half a CSS pixel at 2x), where the exact basis wrapped the last", () => {
    const halfPixelUp = (px: number): number => Math.ceil(px * 2) / 2;
    // Fractional container widths (a card inside page padding on a real phone is rarely a whole pixel) beside the measured ones.
    const widths = [...WIDTHS, 262.4, 301.7, 331.9];
    let judged = 0;
    let controlWrapped = 0;
    for (const width of widths) {
      for (const [spans, rowCount] of [[[1, 1, 1], 1], [[2, 2], 1], [[1, 1, 1, 1, 1, 1], 2]] as const) {
        const rows = layoutPhone(spans, width, { snap: halfPixelUp });
        expect(rows, `${width}px, spans ${spans.join(",")}: ${rowCount} row(s), no tile wraps early`).toHaveLength(rowCount);
        expect(rows.flat(), `${width}px, spans ${spans.join(",")}: every tile placed`).toHaveLength(spans.length);
        // And the same engine on the basis as it was (no slack): the control that shows this model can see the wrap.
        if (layoutPhone(spans, width, { snap: halfPixelUp, slackPx: 0 }).length !== rowCount) controlWrapped++;
        judged++;
      }
    }
    expect(judged).toBe(widths.length * 3);
    expect(controlWrapped, "the engine model wraps the slack-less basis at some width (else this test proves nothing)").toBeGreaterThan(0);
  });

  it("a span-2 tile is half the row, the same fraction of it as on desktop, so two of them are a pair at halves", () => {
    expect(basisOf(2).across, "a pair stays a pair").toBe(deskTracks / deskSpan(2));
    expect(basisOf(2).across).toBe(2);
    let rows = 0;
    for (const width of WIDTHS) {
      const [row, ...rest] = layoutPhone([2, 2], width);
      expect(rest, `${width}px: one row`).toEqual([]);
      expect(row, `${width}px: halves`).toEqual([(width - gapRem * 16) / 2, (width - gapRem * 16) / 2]);
      rows++;
    }
    expect(rows).toBe(WIDTHS.length);
  });

  it("three one-column tiles are thirds, exactly as before (the word-width the 320 cricket keypad needs)", () => {
    const PHONE_TILES_ACROSS = 3; // design of record: not derivable from a class
    expect(basisOf(1).across).toBe(PHONE_TILES_ACROSS);
    for (const width of WIDTHS) {
      const rows = layoutPhone([1, 1, 1, 1, 1, 1], width);
      expect(rows.map((r) => r.length), `${width}px: three across, twice`).toEqual([3, 3]);
      for (const row of rows) for (const w of row) expect(w).toBeCloseTo((width - gapRem * 16 * 2) / 3, 6);
    }
  });

  it("a lone tile of any span, and a one-column + half-row row, fill the whole width (the cases that left dead space)", () => {
    let rows = 0;
    for (const width of WIDTHS) {
      for (const span of SPANS) {
        const [only] = layoutPhone([span], width);
        expect(only, `${width}px: a lone span ${span} is the whole row`).toEqual([width]);
        rows++;
      }
      // cricket's Close innings (span 1) + End of over (span 2) were 5 of 6 tracks
      const [mixed] = layoutPhone([1, 2], width);
      expect(mixed!.length).toBe(2);
      expect(filled(mixed!, width), `${width}px: span 1 + span 2 fills`).toBeCloseTo(0, 6);
      rows++;
    }
    expect(rows).toBe(WIDTHS.length * (SPANS.length + 1));
  });

  it("a mixed sequence of spans leaves no row short: every row's tiles plus gaps are the row width, and spans 3 and 4 own a row", () => {
    const sequence: Span[] = [1, 1, 1, 2, 2, 1, 2, 4, 1, 1, 3, 2, 1, 1, 1, 1, 4];
    let rows = 0;
    for (const width of WIDTHS) {
      const laid = layoutPhone(sequence, width);
      for (const row of laid) {
        expect(filled(row, width), `${width}px: a row of ${row.length}`).toBeCloseTo(0, 6);
        rows++;
      }
      expect(laid.flat().length, `${width}px: every tile was placed`).toBe(sequence.length);
    }
    expect(rows).toBeGreaterThan(WIDTHS.length * 5);
    for (const span of [3, 4] as const) expect(layoutPhone([1, span, 1], 302).map((r) => r.length), `a span ${span} tile owns its row`).toEqual([1, 1, 1]);
  });

  it("desktop spans are unchanged: each span names its own count in the desktop grid, which they fit", () => {
    let judged = 0;
    for (const span of SPANS) {
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
