// GameArt — each game's miniature, drawn once and used twice: on the /games
// listing cards (react-dom) and inside the Open Graph share images (satori, via
// next/og's ImageResponse). Design of record: the owner-approved "Option A"
// mockups (games-canvas gen.py — chess_art / word_art / tiles_art).
//
// satori lays out flexbox ONLY: a div without `display: flex` (or a CSS grid,
// or a className it cannot read) renders wrong or throws inside the share
// image, and nothing on the page would show it. So the contract is pinned on
// the element tree itself, for every art at both a satori size and the page's
// fluid width.
import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { liveGames } from "@/games/registry";
import { GameArt } from "../game-art";
import { GAME_CARD_ART, hubTileSize } from "../og-frame";

type Props = Record<string, unknown> & { style?: Record<string, unknown>; children?: ReactNode };

/** Every intrinsic element in the tree, function components expanded. */
function flatten(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (!isValidElement<Props>(node)) return out;
  if (typeof node.type === "function") {
    return flatten((node.type as (p: Props) => ReactNode)(node.props), out);
  }
  out.push(node);
  flatten(node.props.children, out);
  return out;
}

const art = (slug: string, width: number | "100%", height: number) =>
  flatten(<GameArt slug={slug} width={width} height={height} />);

const styleOf = (el: ReactElement<Props>) => el.props.style ?? {};
const bg = (el: ReactElement<Props>) => styleOf(el).background;
const textOf = (el: ReactElement<Props>) =>
  typeof el.props.children === "string" || typeof el.props.children === "number"
    ? String(el.props.children)
    : null;

/** The hub share card's tile today, and once one more game goes live (tiles shrink). */
const HUB_TILE = hubTileSize(liveGames().length);
const HUB_TILE_MORE = hubTileSize(liveGames().length + 1);

/**
 * Every size the art is drawn at: the listing's two heights (phone / sm+, both
 * width 100% — see games/page.tsx CardArt), the hub card's tile (today's and
 * with one more live game) and the per-game card's square. The share-card
 * sizes come from og-frame, where the routes get them — never typed in here.
 */
const SIZES: [number | "100%", number][] = [
  ["100%", 150],
  ["100%", 188],
  [HUB_TILE.width, HUB_TILE.height],
  [HUB_TILE_MORE.width, HUB_TILE_MORE.height],
  [GAME_CARD_ART, GAME_CARD_ART],
];
const NUMERIC_SIZES = SIZES.filter(([w]) => typeof w === "number") as [number, number][];

/** The page's narrowest card: a 320px phone minus the 16px gutter each side. */
const NARROWEST_CARD = 320 - 2 * 16;

describe("GameArt — every live game has its own art", () => {
  it("premise: the registry has live games to check (an empty list passes every loop below)", () => {
    expect(liveGames().length).toBeGreaterThan(0);
  });

  // A live game with no entry would fall through to the emoji fallback — and
  // in a share image satori fetches emoji from a CDN, server-side. So a new
  // live game must bring its art with it, loudly.
  for (const { slug } of liveGames()) {
    it(`${slug}: renders its dedicated art, not the fallback panel`, () => {
      const html = renderToStaticMarkup(<GameArt slug={slug} width={320} height={196} />);
      expect(html).toContain(`data-game-art="${slug}"`);
      expect(html).not.toContain("data-game-art-fallback=");
    });
  }

  it("an unknown slug renders the fallback panel (the positive pair of the above)", () => {
    const html = renderToStaticMarkup(<GameArt slug="not-a-game" width={320} height={196} />);
    expect(html).toContain('data-game-art="not-a-game"');
    expect(html).toContain('data-game-art-fallback="true"');
  });
});

describe("GameArt — satori contract (flexbox only, inline styles only)", () => {
  const slugs = [...liveGames().map((g) => g.slug), "not-a-game"];
  for (const slug of slugs) {
    for (const [width, height] of SIZES) {
      it(`${slug} @ ${width}×${height}: every div is display:flex, no className, only divs and svg shapes`, () => {
        const els = art(slug, width, height);
        expect(els.length).toBeGreaterThan(0);
        for (const el of els) {
          expect(
            ["div", "svg", "defs", "clipPath", "g", "rect", "path", "circle"],
            `unsupported <${String(el.type)}>`,
          ).toContain(
            el.type,
          );
          expect(el.props.className, `<${String(el.type)}> carries a className`).toBeUndefined();
          // satori throws "Cannot read properties of undefined (reading
          // 'toString')" on a style key that is present but undefined.
          for (const [key, value] of Object.entries(styleOf(el))) {
            expect(value, `style.${key} is undefined on a <${String(el.type)}> in ${slug}`).not.toBeUndefined();
          }
          if (el.type === "div") {
            expect(styleOf(el).display, `a div without display:flex in ${slug}`).toBe("flex");
            expect(styleOf(el).display).not.toBe("grid");
          }
        }
      });
    }
  }

  it("the art root is decorative (aria-hidden) and clips to its box", () => {
    for (const slug of slugs) {
      const [root] = art(slug, "100%", 188);
      expect(root!.props["aria-hidden"]).toBe(true);
      expect(styleOf(root!).overflow).toBe("hidden");
      expect(styleOf(root!).width).toBe("100%");
      expect(styleOf(root!).height).toBe(188);
    }
  });

  it("premise: the share-card sizes are real boxes, the hub's in the mockup's 320:196", () => {
    expect(HUB_TILE).toEqual({ width: 320, height: 196 });
    expect(HUB_TILE_MORE.width).toBeLessThan(HUB_TILE.width);
    expect(HUB_TILE_MORE.height).toBeLessThan(HUB_TILE.height);
    expect(GAME_CARD_ART).toBe(430);
  });

  it("a numeric width is drawn at exactly that size (satori has no container to fill)", () => {
    const [root] = art("2048", 430, 430);
    expect(styleOf(root!).width).toBe(430);
    expect(styleOf(root!).height).toBe(430);
  });

  // satori applies a transform to a clip path TWICE for the clipped children:
  // under the per-game card's rotate(-5deg), an overflow:hidden art root cut
  // its own board along a ~-10deg edge, leaving a wedge of panel showing
  // (measured by rendering). At a satori size nothing overflows (pinned
  // below), so the root does not clip; its rounded panel is its background.
  it("at a numeric (satori) size the art root sets no overflow at all — and still rounds its panel", () => {
    for (const slug of slugs) {
      for (const [width, height] of NUMERIC_SIZES) {
        const [root] = flatten(<GameArt slug={slug} width={width} height={height} radius={19} />);
        expect(Object.hasOwn(styleOf(root!), "overflow"), `${slug} @ ${width}`).toBe(false);
        expect(styleOf(root!).borderRadius).toBe(19);
      }
    }
  });
});

/** Laid-out width of a flex subtree, from its fixed sizes, gaps and padding. */
function laidOutWidth(el: ReactElement<Props>): number {
  const s = styleOf(el);
  if (typeof s.width === "number") return s.width;
  const pad = typeof s.padding === "number" ? s.padding * 2 : 0;
  const gap = typeof s.gap === "number" ? s.gap : 0;
  const widths = directChildren(el).map(laidOutWidth);
  if (s.flexDirection === "column") return Math.max(0, ...widths) + pad;
  return widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1) + pad;
}

/** Laid-out height of a flex subtree — the same walk, down the other axis. */
function laidOutHeight(el: ReactElement<Props>): number {
  const s = styleOf(el);
  if (typeof s.height === "number") return s.height;
  const pad = typeof s.padding === "number" ? s.padding * 2 : 0;
  const gap = typeof s.gap === "number" ? s.gap : 0;
  const heights = directChildren(el).map(laidOutHeight);
  if (s.flexDirection === "column") return heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, heights.length - 1) + pad;
  return Math.max(0, ...heights) + pad;
}

function directChildren(el: ReactElement<Props>, types = ["div"]): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = [];
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (isValidElement<Props>(n) && types.includes(n.type as string)) out.push(n);
  };
  visit(el.props.children);
  return out;
}

/** The chess art's one <svg>, and its viewBox. */
function chessSvg(width: number | "100%", height: number) {
  const [root] = art("chess-quest", width, height);
  const svgs = directChildren(root!, ["svg"]);
  expect(svgs).toHaveLength(1);
  const svg = svgs[0]!;
  const [vbX, vbY, vbW, vbH] = String(svg.props.viewBox).split(" ").map(Number);
  return { svg, vbX: vbX!, vbY: vbY!, vbW: vbW!, vbH: vbH! };
}

/** Every element under `node`, WITHOUT expanding function components. */
function rawElements(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) {
    for (const n of node) rawElements(n, out);
    return out;
  }
  if (!isValidElement<Props>(node)) return out;
  out.push(node);
  rawElements(node.props.children, out);
  return out;
}

describe("GameArt — nothing overflows the art box at a satori (numeric) size", () => {
  // satori composes a transform element by element, and the per-game share
  // card tilts this art by -5deg: a chess board built from ~45 divs drifted off
  // its tilted frame by a few px (slivers of panel showing — seen in the
  // rendered PNG), and an overhanging strip poked out past it, because the
  // clip does not follow the transform either. So nothing may overhang, and
  // the board is ONE <svg>, which satori rasterises and tilts as a single image.
  for (const { slug } of liveGames()) {
    for (const [width, height] of NUMERIC_SIZES) {
      it(`${slug} @ ${width}×${height}: every child of the art fits inside it, across AND down`, () => {
        const [root] = art(slug, width, height);
        const kids = directChildren(root!, ["div", "svg"]);
        expect(kids.length).toBeGreaterThan(0);
        for (const kid of kids) {
          if (kid.type === "svg") {
            // The chess board: exactly the box (its viewBox does the cropping).
            expect(kid.props.width).toBe(width);
            expect(kid.props.height).toBe(height);
            continue;
          }
          const w = laidOutWidth(kid);
          const h = laidOutHeight(kid);
          expect(w, "premise: the cluster has a width").toBeGreaterThan(0);
          expect(h, "premise: the cluster has a height").toBeGreaterThan(0);
          expect(w, `${slug} cluster width`).toBeLessThanOrEqual(width);
          expect(h, `${slug} cluster height`).toBeLessThanOrEqual(height);
        }
      });
    }
  }

  it("chess-quest: one svg exactly the box, its viewBox the strip's centred window at the box's own aspect", () => {
    for (const [width, height] of NUMERIC_SIZES) {
      const { svg, vbX, vbY, vbW, vbH } = chessSvg(width, height);
      expect(svg.props.width).toBe(width);
      expect(svg.props.height).toBe(height);
      // satori IGNORES preserveAspectRatio — it stretches the svg to its box
      // (measured: a 900×200 viewBox "sliced" into 300×200 painted a third of
      // the pixels). So the viewBox must already have the box's aspect: the
      // crop is done here, not by `slice`.
      expect(vbW / vbH).toBeCloseTo(width / height, 3);
      // …and it is the CENTRE of a wider strip, fully covered by squares.
      const rects = rawElements(svg.props.children).filter((e) => e.type === "rect");
      const xs = rects.map((r) => r.props.x as number);
      const right = Math.max(...rects.map((r) => (r.props.x as number) + (r.props.width as number)));
      expect(vbX).toBeGreaterThan(0);
      expect(Math.min(...xs)).toBeLessThanOrEqual(vbX);
      expect(right).toBeGreaterThanOrEqual(vbX + vbW);
      expect(Math.abs(vbX - (right - (vbX + vbW)))).toBeLessThan(0.01);
      // …and down: no row of the window is left undrawn.
      const bottom = Math.max(...rects.map((r) => (r.props.y as number) + (r.props.height as number)));
      expect(Math.min(...rects.map((r) => r.props.y as number))).toBeLessThanOrEqual(vbY);
      expect(bottom).toBeGreaterThanOrEqual(vbY + vbH);
    }
  });

  it("chess-quest: with a radius, the svg rounds its own corners (in-svg clipPath, sized in viewBox units)", () => {
    for (const [width, height, radius] of [
      [430, 430, 28],
      [320, 196, 19],
    ] as const) {
      const [root] = flatten(<GameArt slug="chess-quest" width={width} height={height} radius={radius} />);
      const svg = directChildren(root!, ["svg"])[0]!;
      const [vbX, vbY, vbW, vbH] = String(svg.props.viewBox).split(" ").map(Number);
      const els = rawElements(svg.props.children);
      const clip = els.find((e) => e.type === "clipPath");
      expect(clip).toBeDefined();
      const [shape] = rawElements(clip!.props.children).filter((e) => e.type === "rect");
      expect(shape!.props).toMatchObject({ x: vbX, y: vbY, width: vbW, height: vbH });
      // rx in viewBox units = radius px × (units per px).
      expect(shape!.props.rx as number).toBeCloseTo((radius * vbH!) / height, 3);
      const clipped = els.find((e) => e.type === "g" && e.props.clipPath === `url(#${clip!.props.id})`);
      expect(clipped, "no group draws through the clip").toBeDefined();
      // Everything painted sits inside that group.
      const inside = new Set(rawElements(clipped!.props.children));
      for (const e of els.filter((x) => ["rect", "circle", "path"].includes(x.type as string))) {
        if (rawElements(clip!.props.children).includes(e)) continue;
        expect(inside.has(e), `a <${String(e.type)}> outside the rounded clip`).toBe(true);
      }
    }
  });

  it("chess-quest: square corners (radius 0) and the page's fluid art carry no clipPath", () => {
    for (const [width, height] of SIZES) {
      const { svg } = chessSvg(width, height);
      expect(rawElements(svg.props.children).some((e) => e.type === "clipPath")).toBe(false);
    }
    const [root] = flatten(<GameArt slug="chess-quest" width="100%" height={188} radius={12} />);
    const svg = directChildren(root!, ["svg"])[0]!;
    expect(rawElements(svg.props.children).some((e) => e.type === "clipPath")).toBe(false);
  });

  it("chess-quest: the svg holds intrinsic elements only (a function component inside an svg blanks it in satori)", () => {
    for (const [width, height] of SIZES) {
      const { svg } = chessSvg(width, height);
      for (const el of rawElements(svg.props.children)) {
        expect(typeof el.type, `a <${String((el.type as { name?: string }).name ?? el.type)}> component inside the svg`).toBe(
          "string",
        );
      }
    }
  });
});

describe("GameArt — fluid width on the listing never clips a tile cluster", () => {
  // On the page the art is width:100% of a card whose width the server cannot
  // know. The tile clusters are fixed-size and centred, so they must fit the
  // narrowest card the listing ever draws; the chess strip is the opposite —
  // wider than any card on purpose, and sliced to the card, centred.
  for (const height of [150, 188]) {
    for (const slug of ["daily-word", "2048"]) {
      it(`${slug} @ fluid×${height}: the centred cluster fits a ${NARROWEST_CARD}px card, and the panel's height`, () => {
        const [root] = art(slug, "100%", height);
        const [cluster] = directChildren(root!);
        const w = laidOutWidth(cluster!);
        expect(w).toBeGreaterThan(100);
        expect(w).toBeLessThanOrEqual(NARROWEST_CARD - 2 * 8);
        const h = laidOutHeight(cluster!);
        expect(h).toBeGreaterThan(60);
        expect(h).toBeLessThanOrEqual(height);
      });
    }

    it(`chess-quest @ fluid×${height}: the board strip is wider than the widest card (max-w-5xl), so no edge ever shows`, () => {
      const { svg, vbW, vbH } = chessSvg("100%", height);
      expect(svg.props.width).toBe("100%");
      expect(svg.props.height).toBe(height);
      expect(svg.props.preserveAspectRatio).toBe("xMidYMid slice");
      // Drawn at the card's height, the strip is this many px wide.
      expect((vbW / vbH) * height).toBeGreaterThanOrEqual(1024);
    });
  }
});

type Span = { what: string; x0: number; x1: number; y0: number; y1: number };

/**
 * The chess art's move as drawn, in viewBox units: the knight's square, the
 * last-move square and the two move dots (each dot as its disc's bounds).
 */
function chessMove(width: number | "100%", height: number) {
  const { svg, vbX, vbY, vbW, vbH } = chessSvg(width, height);
  const els = rawElements(svg.props.children);
  // Board squares carry a fill; the clipPath's shape does not.
  const squares = els.filter((e) => e.type === "rect" && typeof e.props.fill === "string");
  const unit = squares[0]!.props.width as number;
  const at = (x: number, y: number) => squares.find((q) => q.props.x === x && q.props.y === y);
  const last = squares.filter((q) => ["#f6f669", "#baca44"].includes(q.props.fill as string));
  expect(last, "exactly one last-move square").toHaveLength(1);
  const knights = els.filter((e) => e.type === "g" && String(e.props.transform ?? "").startsWith("translate("));
  expect(knights, "exactly one knight").toHaveLength(1);
  const [tx, ty] = /translate\(([-\d.]+) ([-\d.]+)\)/
    .exec(String(knights[0]!.props.transform))!
    .slice(1)
    .map(Number);
  // The knight is drawn inset in its square: the square is the one it starts in.
  const kx = Math.floor(tx! / unit) * unit;
  const ky = Math.floor(ty! / unit) * unit;
  const dots = els.filter((e) => e.type === "circle" && e.props.fillOpacity === 0.16);
  expect(dots, "exactly two move dots").toHaveLength(2);
  const square = (what: string, x: number, y: number): Span => ({ what, x0: x, x1: x + unit, y0: y, y1: y + unit });
  const knight = square("the knight's square", kx, ky);
  const spans: Span[] = [
    knight,
    square("the last-move square", last[0]!.props.x as number, last[0]!.props.y as number),
    ...dots.map((d, i) => {
      const [cx, cy, r] = [d.props.cx, d.props.cy, d.props.r] as number[];
      return { what: `move dot ${i + 1}`, x0: cx! - r!, x1: cx! + r!, y0: cy! - r!, y1: cy! + r! };
    }),
  ];
  return { vbX, vbY, vbW, vbH, knight, spans, knightFill: at(kx, ky)?.props.fill, lastFill: last[0]!.props.fill };
}

function expectInView(spans: Span[], view: Omit<Span, "what">, where: string) {
  const eps = 1e-6;
  for (const s of spans) {
    expect(s.x0, `${s.what} cut off on the left (${where})`).toBeGreaterThanOrEqual(view.x0 - eps);
    expect(s.x1, `${s.what} cut off on the right (${where})`).toBeLessThanOrEqual(view.x1 + eps);
    expect(s.y0, `${s.what} cut off at the top (${where})`).toBeGreaterThanOrEqual(view.y0 - eps);
    expect(s.y1, `${s.what} cut off at the bottom (${where})`).toBeLessThanOrEqual(view.y1 + eps);
  }
}

/** The knight's square centred in what is shown, within 5% of its width/height. */
function expectKnightCentred(knight: Span, view: Omit<Span, "what">, where: string) {
  const off = (a0: number, a1: number, b0: number, b1: number) => Math.abs((a0 + a1) / 2 - (b0 + b1) / 2);
  expect(off(knight.x0, knight.x1, view.x0, view.x1), `knight off-centre across (${where})`).toBeLessThanOrEqual(
    0.05 * (view.x1 - view.x0),
  );
  expect(off(knight.y0, knight.y1, view.y0, view.y1), `knight off-centre down (${where})`).toBeLessThanOrEqual(
    0.05 * (view.y1 - view.y0),
  );
}

/**
 * The art's width on the listing, per panel height: [narrowest, widest] card,
 * less the card's 1px border each side (games/page.tsx: main px-4, max-w-5xl;
 * grid gap-4 → sm:gap-5, 1 column → sm:2 → lg:3).
 *   150 (below sm, 1 column): a 320px phone → 286; a 639px window → 605.
 *   188 (sm and up): 640px, 2 columns → 292; 1023px, 2 columns → 483.5
 *       (3 columns at lg, in max-w-5xl, is 315 — inside that range).
 */
const LISTING_ART_WIDTHS: [height: number, widths: number[]][] = [
  [150, [286, 605]],
  [188, [292, 483.5]],
];

describe("GameArt — chess: the whole move is in view, the knight at its centre", () => {
  // Reviewed on the 430px share card: the window showed half of each move dot,
  // half the last-move square, and the knight left of centre — the strip was
  // centred, not the move. The window is now centred on the knight and wide
  // enough for everything the move draws, at every size the art is drawn.
  for (const [width, height] of NUMERIC_SIZES) {
    it(`@ ${width}×${height}: knight, last-move square and both dots wholly inside the viewBox`, () => {
      const m = chessMove(width, height);
      const view = { x0: m.vbX, x1: m.vbX + m.vbW, y0: m.vbY, y1: m.vbY + m.vbH };
      expectInView(m.spans, view, `${width}×${height}`);
      expectKnightCentred(m.knight, view, `${width}×${height}`);
    });
  }

  for (const [height, widths] of LISTING_ART_WIDTHS) {
    for (const cardWidth of widths) {
      it(`@ the listing's ${cardWidth}px × ${height}px card: the same, in the part of the strip the card shows`, () => {
        const m = chessMove("100%", height);
        // xMidYMid slice: the strip is scaled to the card's height and cut to
        // its width about the strip's centre. This much of it shows:
        const shown = (cardWidth * m.vbH) / height;
        const x0 = m.vbX + (m.vbW - shown) / 2;
        const view = { x0, x1: x0 + shown, y0: m.vbY, y1: m.vbY + m.vbH };
        expectInView(m.spans, view, `${cardWidth}px card`);
        expectKnightCentred(m.knight, view, `${cardWidth}px card`);
      });
    }
  }

  it("the picture is the same one at every size: knight on a dark square, the dark last-move tint", () => {
    for (const [width, height] of SIZES) {
      const m = chessMove(width, height);
      expect(m.knightFill, `${width}×${height}`).toBe("#769656");
      expect(m.lastFill, `${width}×${height}`).toBe("#baca44");
    }
  });
});

describe("GameArt — draws what the approved mockup draws", () => {
  it("chess-quest: three rows of checker squares, one knight, one last-move square, two move dots", () => {
    const els = art("chess-quest", 320, 196);
    const fill = (e: ReactElement<Props>) => e.props.fill as string;
    const squares = els.filter((e) => e.type === "rect");
    expect(squares.length).toBeGreaterThan(9);
    for (const sq of squares) {
      expect(["#eeeed2", "#769656", "#f6f669", "#baca44"]).toContain(fill(sq));
      expect(sq.props.width).toBe(sq.props.height);
    }
    expect(new Set(squares.map((sq) => sq.props.y)).size).toBe(3);
    // Checkered: horizontally adjacent squares never share a colour.
    for (const a of squares) {
      const b = squares.find((o) => o.props.y === a.props.y && o.props.x === (a.props.x as number) + (a.props.width as number));
      if (b) expect(fill(b)).not.toBe(fill(a));
    }
    expect(squares.filter((sq) => ["#f6f669", "#baca44"].includes(fill(sq)))).toHaveLength(1);
    expect(els.filter((e) => e.type === "path")).toHaveLength(1);
    const dots = els.filter((e) => e.type === "circle" && e.props.fillOpacity === 0.16);
    expect(dots).toHaveLength(2);
  });

  it("daily-word: SLATE (near, hit, hit, miss, miss) over PLAYS (all hit), white letters", () => {
    const COLOURS = { hit: "#16a34a", near: "#eab308", miss: "#64748b" } as const;
    const tiles = art("daily-word", 320, 196).filter((e) => textOf(e) !== null);
    expect(tiles.map(textOf).join("")).toBe("SLATEPLAYS");
    expect(tiles.map(bg)).toEqual(
      (["near", "hit", "hit", "miss", "miss", "hit", "hit", "hit", "hit", "hit"] as const).map(
        (k) => COLOURS[k],
      ),
    );
    for (const t of tiles) expect(styleOf(t).color).toBe("#ffffff");
    expect(bg(art("daily-word", 320, 196)[0]!)).toBe("#f8fafc");
  });

  it("2048: a 2×2 board of 2 / 8 / 128 / 2048 in the classic colours", () => {
    const els = art("2048", 320, 196);
    const tiles = els.filter((e) => textOf(e) !== null);
    expect(tiles.map((t) => [textOf(t), bg(t), styleOf(t).color])).toEqual([
      ["2", "#eee4da", "#776e65"],
      ["8", "#f2b179", "#ffffff"],
      ["128", "#edcf72", "#ffffff"],
      ["2048", "#edc22e", "#ffffff"],
    ]);
    expect(bg(els[0]!)).toBe("#faf8ef");
    expect(els.some((e) => bg(e) === "#bbada0")).toBe(true);
  });
});
