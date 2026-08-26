"use client";

// Tap-to-move chess board (React port of the original js/board.js).
// Controlled: position/highlights/coins come in as props; taps go out.
// pop/shake are token-driven so a parent can retrigger CSS animations.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FILES, fileOf, isWhitePiece, Move, rankRow, sqName } from "../engine";
import { useProgress } from "../lib/progress";

export const GLYPH: Record<string, string> = {
  P: "♟",
  N: "♞",
  B: "♝",
  R: "♜",
  Q: "♛",
  K: "♚",
};

const PIECE_NAMES: Record<string, string> = {
  P: "pawn",
  N: "knight",
  B: "bishop",
  R: "rook",
  Q: "queen",
  K: "king",
};

// sel/hint render as an overlay under the piece (see chess-quest.css .cq-ov-*);
// move/cap stay a small dot/ring driven by the button's own class; last/check
// come from dedicated props below, not this map.
export type Highlight = "sel" | "move" | "cap" | "hint" | "last" | "check";

/**
 * Square index (0 = a8 … 63 = h1, FEN reading order) to 1-indexed CSS grid
 * cell. White keeps the identity layout (a8 top-left, h1 bottom-right).
 * Black is a full 180° rotation of that grid, not a mirror of one axis:
 * a8 → bottom-right, h1 → top-left, a1 → top-right, h8 → bottom-left.
 */
export function cellFor(idx: number, orientation: "white" | "black"): { row: number; col: number } {
  const file = fileOf(idx);
  const rank = rankRow(idx);
  return orientation === "black" ? { row: 8 - rank, col: 8 - file } : { row: rank + 1, col: file + 1 };
}

/**
 * Detects "exactly one piece moved" between two 64-square positions, for the
 * FLIP slide. Covers a plain move, a capture, and a promotion (destination
 * content need not equal the origin's old piece) — all of them vacate
 * exactly one square and newly occupy exactly one other. Any other shape of
 * change (a whole new puzzle loaded, a multi-square reset) returns null so
 * the position just swaps instantly, no slide.
 */
export function detectSingleMove(prev: string[], next: string[]): Move | null {
  if (prev.length !== next.length) return null;
  const diffs: number[] = [];
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) {
      diffs.push(i);
      if (diffs.length > 2) return null;
    }
  }
  if (diffs.length !== 2) return null;
  const [a, b] = diffs;
  if (prev[a] !== "" && next[a] === "" && next[b] !== "") return { from: a, to: b };
  if (prev[b] !== "" && next[b] === "" && next[a] !== "") return { from: b, to: a };
  return null;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Board({
  position,
  highlights,
  coins,
  labels = true,
  orientation = "white",
  lastMove,
  checkSquare,
  onTap,
  popToken,
  shakeToken,
}: {
  position: string[];
  highlights?: Partial<Record<number, Highlight>>;
  coins?: ReadonlySet<number>;
  labels?: boolean;
  orientation?: "white" | "black";
  lastMove?: Move | null;
  checkSquare?: number | null;
  onTap?(idx: number): void;
  popToken?: { idx: number; n: number } | null;
  shakeToken?: number;
}) {
  const progress = useProgress();
  const theme = progress.getBoardTheme();
  const boardRef = useRef<HTMLDivElement>(null);
  const prevPositionRef = useRef<string[] | null>(null);

  // popToken drives the pop animation directly: the popped piece's `key`
  // includes popToken.n, so bumping it re-mounts that span and replays the
  // CSS keyframes — no extra state needed.
  const popping = popToken ?? null;

  // Shake replays a CSS animation for ~320ms after each shakeToken change.
  const [shaking, setShaking] = useState(false);
  const firstShake = useRef(true);
  useEffect(() => {
    if (firstShake.current) {
      firstShake.current = false;
      return;
    }
    setShaking(true);
    const t = setTimeout(() => setShaking(false), 320);
    return () => clearTimeout(t);
  }, [shakeToken]);

  // FLIP slide: squares themselves never move on screen, only their
  // occupants do, so the origin square's CURRENT rect stands in for "where
  // the piece used to be" — no pre-render measurement needed. Runs after
  // the DOM commit (useLayoutEffect), skipped entirely on the first mount
  // (nothing to slide from) and under prefers-reduced-motion.
  useLayoutEffect(() => {
    const prev = prevPositionRef.current;
    prevPositionRef.current = position;
    if (!prev || !boardRef.current || reducedMotion()) return;
    const move = detectSingleMove(prev, position);
    if (!move) return;
    const board = boardRef.current;
    const fromEl = board.children[move.from] as HTMLElement | undefined;
    const toEl = board.children[move.to] as HTMLElement | undefined;
    const toImg = toEl?.querySelector<HTMLImageElement>(".cq-pc");
    if (!fromEl || !toEl || !toImg) return;
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    if (!dx && !dy) return;
    toImg.style.transition = "none";
    toImg.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      toImg.style.transition = "transform 120ms ease-out";
      toImg.style.transform = "translate(0, 0)";
    });
    const clear = () => {
      toImg.style.transition = "";
      toImg.style.transform = "";
    };
    toImg.addEventListener("transitionend", clear, { once: true });
  }, [position]);

  const squares = [];
  for (let idx = 0; idx < 64; idx++) {
    const p = position[idx];
    const name = sqName(idx);
    const primary = highlights?.[idx];
    const light = (fileOf(idx) + rankRow(idx)) % 2 === 0;
    const label = p !== "" ? `${name} ${isWhitePiece(p) ? "white" : "black"} ${PIECE_NAMES[p.toUpperCase()]}` : name;
    const { row, col } = cellFor(idx, orientation);
    // The coordinate edge follows orientation so it stays on the outer edge
    // when the board is flipped; the value (rank number / file letter) is
    // the square's own identity and never changes.
    const rankEdge = orientation === "black" ? fileOf(idx) === 7 : fileOf(idx) === 0;
    const fileEdge = orientation === "black" ? rankRow(idx) === 0 : rankRow(idx) === 7;
    const isLast = !!lastMove && (lastMove.from === idx || lastMove.to === idx);
    const isCheck = checkSquare === idx;
    const afterClass = primary === "move" ? " cq-hl-move" : primary === "cap" ? " cq-hl-cap" : "";

    squares.push(
      <button
        key={idx}
        type="button"
        data-square={name}
        aria-label={label}
        data-rank={labels && rankEdge ? 8 - rankRow(idx) : undefined}
        data-file={labels && fileEdge ? FILES[fileOf(idx)] : undefined}
        style={{ gridRow: row, gridColumn: col }}
        className={`cq-sq ${light ? "cq-light" : "cq-dark"}${afterClass}`}
        onClick={onTap ? () => onTap(idx) : undefined}
      >
        {isCheck ? <span className="cq-ov cq-ov-check" /> : null}
        {isLast ? <span className="cq-ov cq-ov-last" /> : null}
        {primary === "sel" ? <span className="cq-ov cq-ov-sel" /> : null}
        {primary === "hint" ? <span className="cq-ov cq-ov-hint" /> : null}
        {p !== "" ? (
          // Classic Cburnett SVG pieces (see public/games/chess-quest/pieces/LICENSE.md)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={popping?.idx === idx ? `pop-${popping.n}` : "pc"}
            src={`/games/chess-quest/pieces/${p.toLowerCase()}${isWhitePiece(p) ? "l" : "d"}.svg`}
            alt=""
            draggable={false}
            className={`cq-pc${popping?.idx === idx ? " cq-pop" : ""}`}
          />
        ) : coins?.has(idx) ? (
          <span className="cq-coin" />
        ) : null}
      </button>,
    );
  }

  return (
    <div ref={boardRef} className={`cq-board${shaking ? " cq-shake" : ""}`} data-theme={theme}>
      {squares}
    </div>
  );
}
