// GameArt — each game's miniature "box art", drawn in two places from one
// definition: the /games listing cards (react-dom) and the Open Graph share
// images (satori, through next/og's ImageResponse). Design of record: the
// owner-approved "Option A" mockups (games-canvas gen.py — chess_art,
// word_art, tiles_art); colours and proportions are copied from there.
//
// Server-safe and purely presentational — no "use client", no state. Because
// satori renders it too, the rules are satori's, not the browser's:
//   - flexbox ONLY: every div declares `display: flex` (satori has no grid —
//     the mockup's CSS grids are rebuilt here as rows of flex rows);
//   - INLINE STYLES ONLY: satori cannot read a className;
//   - no <img>/emoji for a live game: satori FETCHES both, server-side. The
//     emoji fallback exists for a registry entry with no art yet (a future
//     coming-soon game); game-art.test.tsx fails if a LIVE game lands on it.
//
// `width` is a number for satori (it has no container to fill) or "100%" on
// the page, where the card's width is unknown to the server. Fluid art sizes
// its fixed-size tile clusters for a 320px box, so they fit the listing's
// narrowest card (288px: a 320px phone minus its gutters), and draws the chess
// strip wider than any card, sliced to the card's width, centred on the
// knight. Nothing ever
// overhangs the box (see chessBoard for why that matters to satori), and the
// root still clips, so the art can never push the page sideways.
import type { ReactNode } from "react";
import { getGame } from "@/games/registry";

export type GameArtProps = {
  slug: string;
  /** px for satori; "100%" to fill a card on the page. */
  width: number | "100%";
  /** px — every tile and square is sized off it. */
  height: number;
  /** Corner radius of the art panel, px. */
  radius?: number;
};

/** Fluid art sizes its tile clusters as if drawn this wide (see header). */
const FLUID_SIZING_WIDTH = 320;
/** …and its chess strip at least this wide: the listing's max-w-5xl. */
const FLUID_STRIP_WIDTH = 1024;

type Box = {
  width: number | "100%";
  height: number;
  /** The width the art's geometry is computed against. */
  sizingWidth: number;
  radius: number;
};

type Art = {
  /** Panel colour behind the art. Required: satori throws on a style key
   *  that is present but undefined. */
  background: string;
  draw: (box: Box) => ReactNode;
};

// ---------- Chess Quest: a strip of board with a knight mid-move ----------

const CQ_LIGHT = "#eeeed2";
const CQ_DARK = "#769656";
const CQ_LAST_LIGHT = "#f6f669";
const CQ_LAST_DARK = "#baca44";

/** One square, in viewBox units. */
const UNIT = 100;

/**
 * The knight on the square whose top-left is (x, y), at 82% of it. A plain
 * function CALLED for its elements, never mounted as <Knight />: a function
 * component inside an <svg> makes satori drop the whole svg (measured — the
 * board rendered as an empty panel). game-art.test.tsx pins this.
 */
function knightOn(x: number, y: number) {
  const inset = (UNIT * (1 - 0.82)) / 2;
  return (
    <g transform={`translate(${x + inset} ${y + inset}) scale(0.82)`}>
      <path
        d="M28 90 H76 V82 C76 76 72 72 68 70 C66 58 70 50 76 42 C82 32 80 20 70 14 C62 9 54 9 48 10 L44 3 L38 12 C30 16 24 24 22 34 L14 50 C12 56 16 60 22 58 L30 52 C34 54 40 54 44 50 C44 56 38 62 32 68 C28 72 28 76 28 82 Z"
        fill="#1c1917"
        stroke="#fafaf9"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <circle cx={44} cy={26} r={3.2} fill="#fafaf9" />
    </g>
  );
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The mockup's strip: three squares tall. */
const ROWS = 3;
/** The move, in squares from the knight: the square it came from… */
const LAST_MOVE = { dc: -1, dr: 1 };
/** …and two squares it can go to next (knight moves: two across, one down/up). */
const MOVE_DOTS = [
  { dc: 2, dr: -1 },
  { dc: 2, dr: 1 },
];
/** A move dot's radius, in squares. */
const DOT_R = 0.14;
/** Clear board kept between the move and the art's side edges, in squares. */
const SIDE_MARGIN = 0.12;
/**
 * The fewest squares the art may show across. The window is centred on the
 * knight, so each half must reach from the knight square's centre past the far
 * edge of everything the move draws — the last-move square on the left (1.5),
 * a dot on the right (2.14) — plus the margin: 2 × 2.26 = 4.52. Down, the
 * mockup's three rows already frame the move (last-move square flush with the
 * bottom edge, as drawn there).
 */
const MIN_ACROSS =
  2 *
  (Math.max(Math.abs(LAST_MOVE.dc) + 0.5, ...MOVE_DOTS.map(({ dc }) => Math.abs(dc) + DOT_R)) + SIDE_MARGIN);

// The board is ONE <svg>, not a grid of divs: satori rasterises an svg as a
// single image, so the per-game card's rotate(-5deg) tilts it as one piece.
// Built from ~45 divs it drifted off its tilted frame by a few px — satori
// composes a transform element by element, and its overflow clip does not
// follow the transform at all.
//
// What shows is a window onto the board CENTRED ON THE KNIGHT — so the knight
// sits mid-art and the whole move (last-move square, both dots) is in view at
// every size. The window is three squares tall (the mockup's strip) unless the
// box is too narrow to show MIN_ACROSS squares that way — the 430px square
// share-card art — and then the squares shrink until it can. The board drawn
// is every square the window touches, so it is always covered.
//
// HOW the window is cut differs by renderer:
//   - fluid (the page, in a browser): the window is a strip wider than any
//     card (a whole, odd number of squares, so centred on the knight it ends
//     on square edges), and `preserveAspectRatio="xMidYMid slice"` covers the
//     card with it, about its centre — the knight — at whatever width the card
//     turns out to be;
//   - numeric (satori): satori ignores preserveAspectRatio and stretches the
//     svg to its box, so the viewBox IS the window, at the box's own aspect,
//     and the svg viewport does the cropping. A rounded box is rounded INSIDE
//     the svg too (a clipPath resvg applies itself), because the art root does
//     not clip at a satori size — see GameArt.
function chessBoard({ width, height, radius }: Box): ReactNode {
  const fluid = typeof width !== "number";
  // The window's size in squares, down and across.
  const down = fluid ? ROWS : Math.max(ROWS, (MIN_ACROSS * height) / width);
  const across = fluid
    ? 2 * Math.ceil((FLUID_STRIP_WIDTH / (height / down) - 1) / 2) + 1
    : (down * width) / height;
  // In squares from the knight square's top-left corner, the window runs
  // 0.5 ± across/2 and 0.5 ± down/2. The board: every square it touches.
  const c0 = Math.floor(0.5 - across / 2);
  const r0 = Math.floor(0.5 - down / 2);
  const cols = Math.ceil(0.5 + across / 2) - c0;
  const rows = Math.ceil(0.5 + down / 2) - r0;
  const knight = { c: -c0, r: -r0 };
  const last = { c: knight.c + LAST_MOVE.dc, r: knight.r + LAST_MOVE.dr };
  const dots = MOVE_DOTS.map(({ dc, dr }) => ({ c: knight.c + dc, r: knight.r + dr }));
  const view = {
    x: round3((0.5 - across / 2 - c0) * UNIT),
    y: round3((0.5 - down / 2 - r0) * UNIT),
    w: round3(across * UNIT),
    h: round3(down * UNIT),
  };
  const clipId = !fluid && radius > 0 ? `cq-art-${width}x${height}r${radius}` : null;
  const rx = round3((radius * view.h) / height);
  const squares = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Coloured relative to the knight, which always stands on a dark square
      // (as on the mockup's 320×196 card), whatever board the window needs.
      const light = (r + c + knight.r + knight.c) % 2 === 1;
      const isLast = c === last.c && r === last.r;
      squares.push(
        <rect
          key={`${r}-${c}`}
          x={c * UNIT}
          y={r * UNIT}
          width={UNIT}
          height={UNIT}
          fill={isLast ? (light ? CQ_LAST_LIGHT : CQ_LAST_DARK) : light ? CQ_LIGHT : CQ_DARK}
        />,
      );
    }
  }
  return (
    <svg
      width={width}
      height={height}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {clipId ? (
        <defs>
          <clipPath id={clipId}>
            <rect x={view.x} y={view.y} width={view.w} height={view.h} rx={rx} ry={rx} />
          </clipPath>
        </defs>
      ) : null}
      <g {...(clipId ? { clipPath: `url(#${clipId})` } : {})}>
        {/* crispEdges: no anti-aliased hairline between neighbouring squares. */}
        <g shapeRendering="crispEdges">{squares}</g>
        {dots.map(({ c, r }) => (
          <circle
            key={`${r}-${c}`}
            cx={c * UNIT + UNIT / 2}
            cy={r * UNIT + UNIT / 2}
            r={UNIT * DOT_R}
            fill="#000000"
            fillOpacity={0.16}
          />
        ))}
        {knightOn(knight.c * UNIT, knight.r * UNIT)}
      </g>
    </svg>
  );
}

// ---------- Daily Word: two guesses, the second one solved ----------

const WORD_COLOURS = { hit: "#16a34a", near: "#eab308", miss: "#64748b" } as const;
type WordState = keyof typeof WORD_COLOURS;
const WORD_ROWS: [string, WordState][][] = [
  [["S", "near"], ["L", "hit"], ["A", "hit"], ["T", "miss"], ["E", "miss"]],
  [["P", "hit"], ["L", "hit"], ["A", "hit"], ["Y", "hit"], ["S", "hit"]],
];

function wordTiles({ height, sizingWidth }: Box): ReactNode {
  const n = WORD_ROWS.length;
  const t = Math.floor(Math.min((sizingWidth - 48) / 5.5, (height - 32) / (n + (n - 1) * 0.12)));
  const gap = Math.max(4, Math.floor(t * 0.1));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {WORD_ROWS.map((row, r) => (
        <div key={r} style={{ display: "flex", gap }}>
          {row.map(([letter, state], i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexShrink: 0,
                width: t,
                height: t,
                background: WORD_COLOURS[state],
                color: "#ffffff",
                borderRadius: Math.max(3, Math.floor(t / 14)),
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: Math.floor(t * 0.52),
                lineHeight: 1,
              }}
            >
              {letter}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------- 2048: a 2×2 board climbing to the 2048 tile ----------

const TILES: [value: number, background: string, color: string][] = [
  [2, "#eee4da", "#776e65"],
  [8, "#f2b179", "#ffffff"],
  [128, "#edcf72", "#ffffff"],
  [2048, "#edc22e", "#ffffff"],
];

function tileBoard({ height, sizingWidth }: Box): ReactNode {
  const s = Math.floor(Math.min((sizingWidth - 48) / 2.3, (height - 32) / 2.3));
  const gap = Math.max(5, Math.floor(s * 0.09));
  const tile = ([value, background, color]: (typeof TILES)[number]) => (
    <div
      key={value}
      style={{
        display: "flex",
        flexShrink: 0,
        width: s,
        height: s,
        background,
        color,
        borderRadius: Math.max(3, Math.floor(s / 16)),
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: Math.floor(s * (value < 100 ? 0.5 : value < 1000 ? 0.36 : 0.28)),
        lineHeight: 1,
      }}
    >
      {value}
    </div>
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        padding: gap,
        background: "#bbada0",
        borderRadius: Math.max(4, Math.floor(s / 12)),
      }}
    >
      <div style={{ display: "flex", gap }}>{TILES.slice(0, 2).map(tile)}</div>
      <div style={{ display: "flex", gap }}>{TILES.slice(2).map(tile)}</div>
    </div>
  );
}

// ---------- the lookup: one entry per live game ----------

const GAME_ART: Record<string, Art> = {
  // The board covers the whole panel, so its colour never shows.
  "chess-quest": { background: CQ_DARK, draw: chessBoard },
  "daily-word": { background: "#f8fafc", draw: wordTiles },
  "2048": { background: "#faf8ef", draw: tileBoard },
};

/** A registry entry with no art yet: its emoji thumbnail on a quiet panel. */
const FALLBACK_BACKGROUND = "#f1f5f9";

export function GameArt({ slug, width, height, radius = 0 }: GameArtProps) {
  // Object.hasOwn, not `in`/index: a slug like "constructor" must not resolve
  // to Object.prototype's own members.
  const art = Object.hasOwn(GAME_ART, slug) ? GAME_ART[slug]! : null;
  const fluid = typeof width !== "number";
  const box: Box = {
    width,
    height,
    sizingWidth: fluid ? FLUID_SIZING_WIDTH : width,
    radius,
  };
  const thumbnail = art ? null : getGame(slug)?.thumbnail;
  return (
    <div
      aria-hidden
      data-game-art={slug}
      data-game-art-fallback={art ? undefined : "true"}
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        width,
        height,
        // Clip only on the page. At a satori size nothing overflows (the
        // tests pin it), and a satori clip under a transform — the per-game
        // card's rotate(-5deg) — is applied twice to the clipped children,
        // cutting the art along a steeper edge than its own panel's. The
        // rounded panel is this div's background either way.
        ...(fluid ? { overflow: "hidden" as const } : {}),
        borderRadius: radius,
        background: art ? art.background : FALLBACK_BACKGROUND,
      }}
    >
      {art ? (
        art.draw(box)
      ) : (
        <div style={{ display: "flex", fontSize: Math.floor(height * 0.4), lineHeight: 1 }}>
          {thumbnail ?? ""}
        </div>
      )}
    </div>
  );
}
