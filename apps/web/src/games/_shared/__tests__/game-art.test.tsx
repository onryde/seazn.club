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

/** The listing's two art heights (phone / sm+) and the share images' two sizes. */
const SIZES: [number | "100%", number][] = [
  ["100%", 150],
  ["100%", 188],
  [320, 196],
  [430, 430],
];

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
      for (const [width, height] of SIZES.filter(([w]) => typeof w === "number")) {
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
  const [vbX, , vbW, vbH] = String(svg.props.viewBox).split(" ").map(Number);
  return { svg, vbX: vbX!, vbW: vbW!, vbH: vbH! };
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
    for (const [width, height] of SIZES.filter(([w]) => typeof w === "number") as [number, number][]) {
      it(`${slug} @ ${width}×${height}: every child of the art fits inside it`, () => {
        const [root] = art(slug, width, height);
        const kids = directChildren(root!, ["div", "svg"]);
        expect(kids.length).toBeGreaterThan(0);
        for (const kid of kids) {
          const w = kid.type === "svg" ? (kid.props.width as number) : laidOutWidth(kid);
          expect(w).toBeLessThanOrEqual(width);
        }
      });
    }
  }

  it("chess-quest: one svg exactly the box, its viewBox the strip's centred window at the box's own aspect", () => {
    for (const [width, height] of [
      [320, 196],
      [430, 430],
    ] as const) {
      const { svg, vbX, vbW, vbH } = chessSvg(width, height);
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
    }
  });

  it("chess-quest: with a radius, the svg rounds its own corners (in-svg clipPath, sized in viewBox units)", () => {
    for (const [width, height, radius] of [
      [430, 430, 28],
      [320, 196, 19],
    ] as const) {
      const [root] = flatten(<GameArt slug="chess-quest" width={width} height={height} radius={radius} />);
      const svg = directChildren(root!, ["svg"])[0]!;
      const [vbX, , vbW, vbH] = String(svg.props.viewBox).split(" ").map(Number);
      const els = rawElements(svg.props.children);
      const clip = els.find((e) => e.type === "clipPath");
      expect(clip).toBeDefined();
      const [shape] = rawElements(clip!.props.children).filter((e) => e.type === "rect");
      expect(shape!.props).toMatchObject({ x: vbX, y: 0, width: vbW, height: vbH });
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
      it(`${slug} @ fluid×${height}: the centred cluster fits a ${NARROWEST_CARD}px card`, () => {
        const [root] = art(slug, "100%", height);
        const [cluster] = directChildren(root!);
        const w = laidOutWidth(cluster!);
        expect(w).toBeGreaterThan(100);
        expect(w).toBeLessThanOrEqual(NARROWEST_CARD - 2 * 8);
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
