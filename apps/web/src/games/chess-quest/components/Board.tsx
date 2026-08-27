"use client";

// Tap-to-move chess board (React port of the original js/board.js).
// Controlled: position/highlights/coins come in as props; taps go out.
// pop/shake are token-driven so a parent can retrigger CSS animations.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FILES, fileOf, isWhitePiece, Move, rankRow, sqIdx, sqName } from "../engine";
import { useSfx, type SfxKind } from "../lib/useSfx";

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

// W2 — drag input. A drag is "two taps compressed into one gesture": down
// reports a tap for the pressed square (reusing the existing tap-selection
// path so a parent's sel/move/cap highlights appear exactly as they would
// for a first tap — Board itself has no idea what's legal, only the parent
// does), and up reports a tap for whatever square the pointer is over when
// released — again exactly as a second tap would. Board never special-cases
// legal vs illegal; the parent's own onTap already knows what to do with
// each. Only two cases suppress the release's tap: releasing back on the
// SAME square (the down's tap already covered a stationary press, so a
// plain tap performed via pointer events still fires onTap exactly once
// overall — see runDragAction's tests), and releasing outside the board
// (idx null), which cancels instead.
export type DragState = { fromIdx: number; x: number; y: number; pointerId: number } | null;

export type DragAction =
  | { type: "down"; idx: number; x: number; y: number; pointerId: number }
  | { type: "move"; x: number; y: number; pointerId: number }
  | { type: "up"; idx: number | null; pointerId: number };

/**
 * Pure state machine, no DOM — see the W2 unit tests in Board.test.tsx.
 *
 * Single-pointer only, by design: a second pointer going down while one is
 * already dragging is dropped rather than stealing the slot (found in review
 * 2026-08-27 — a kid poking the board with a second finger mid-drag used to
 * overwrite `fromIdx`, so the FIRST finger's eventual release fired onTap
 * with the SECOND finger's stale square). `move`/`up` for any pointerId
 * other than the one that started the drag are ignored the same way.
 */
export function dragTransition(
  state: DragState,
  action: DragAction,
): { state: DragState; tap: number | null } {
  switch (action.type) {
    case "down":
      if (state) return { state, tap: null };
      return {
        state: { fromIdx: action.idx, x: action.x, y: action.y, pointerId: action.pointerId },
        tap: action.idx,
      };
    case "move":
      if (!state || action.pointerId !== state.pointerId) return { state, tap: null };
      return { state: { ...state, x: action.x, y: action.y }, tap: null };
    case "up": {
      if (!state || action.pointerId !== state.pointerId) return { state, tap: null };
      const settledOrOutside = action.idx === null || action.idx === state.fromIdx;
      return { state: null, tap: settledOrOutside ? null : action.idx };
    }
  }
}

/**
 * Which square is under a pointer's actual screen position — NOT `e.target`.
 * Found in review 2026-08-27: touch pointers get implicit capture on
 * `pointerdown` (spec'd browser behaviour), which pins `e.target` on every
 * later event for that pointer back to the ORIGIN element regardless of
 * where the finger actually moved to — so a touch drag's `pointerup.target`
 * is always the square it started on, never the square it ended on, and the
 * piece silently snaps back on every real device. `elementFromPoint` reads
 * the live coordinate instead, sidestepping capture entirely.
 * `elementFromPoint` is injectable so this is testable without a real DOM
 * (this workspace has no jsdom — see this file's test header).
 */
export function resolveDropSquare(
  clientX: number,
  clientY: number,
  elementFromPoint: (x: number, y: number) => Element | null = (x, y) =>
    document.elementFromPoint(x, y),
): number | null {
  const square = elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-square]");
  return square ? sqIdx(square.dataset.square!) : null;
}

/**
 * The exact glue Board's pointer handlers call on every down/move/up: runs
 * the action through dragTransition and fires the resulting tap (if any) via
 * onTap. Exported and called directly by the "Rendered" tests — this
 * workspace has no jsdom/react-test-renderer (see this file's test header),
 * so a real mounted pointerdown→pointerup can't be simulated; this is the
 * same logic a real gesture would run.
 */
export function runDragAction(
  state: DragState,
  action: DragAction,
  onTap: ((idx: number) => void) | undefined,
): DragState {
  const { state: next, tap } = dragTransition(state, action);
  if (tap !== null) onTap?.(tap);
  return next;
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
  const boardRef = useRef<HTMLDivElement>(null);
  const prevPositionRef = useRef<string[] | null>(null);
  const { play } = useSfx();

  // popToken drives the pop animation directly: the popped piece's `key`
  // includes popToken.n, so bumping it re-mounts that span and replays the
  // CSS keyframes — no extra state needed.
  const popping = popToken ?? null;

  // W2 — drag input. dragRef mirrors `drag` synchronously so dispatch can
  // read the latest state without depending on the closure from whichever
  // render attached the window listeners (see the effect below). suppressed
  // guards against the native `click` a plain tap-via-pointer-events would
  // ALSO fire on the button (pointerdown already reports that tap itself —
  // see runDragAction) — set the moment a piece's pointerdown starts, and
  // consumed (and cleared) by that same square's onClick if the browser
  // fires one. It's also cleared shortly after pointerup regardless, so a
  // cross-square drag (no native click ever fires for it) can't leave a
  // stale `true` around to swallow some LATER, unrelated click.
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  const suppressClickRef = useRef(false);

  const dispatch = useCallback(
    (action: DragAction) => {
      const next = runDragAction(dragRef.current, action, onTap);
      dragRef.current = next;
      setDrag(next);
    },
    [onTap],
  );

  useEffect(() => {
    if (!drag) return;
    function move(e: PointerEvent) {
      dispatch({ type: "move", x: e.clientX, y: e.clientY, pointerId: e.pointerId });
    }
    function up(e: PointerEvent) {
      dispatch({
        type: "up",
        idx: resolveDropSquare(e.clientX, e.clientY),
        pointerId: e.pointerId,
      });
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    function cancel(e: PointerEvent) {
      dispatch({ type: "up", idx: null, pointerId: e.pointerId });
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    // Safety net, not part of the tap/drag contract above: if the tab is
    // hidden or the window loses focus mid-drag, no pointerup/pointercancel
    // may ever arrive for this pointer (OS-level interruption, alt-tab).
    // Found in review 2026-08-27 — without this, `drag` stays non-null
    // forever: the ghost image never clears and .cq-dragging's
    // touch-action: none stays stuck on the whole board. This bypasses
    // dragTransition entirely (it's a forced reset, not a real tap) and
    // clears suppressClickRef immediately, not on the usual setTimeout,
    // since no further click for this press is coming either.
    function forceCancel() {
      dragRef.current = null;
      setDrag(null);
      suppressClickRef.current = false;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", forceCancel);
    document.addEventListener("visibilitychange", forceCancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", forceCancel);
      document.removeEventListener("visibilitychange", forceCancel);
    };
    // Keyed on whether a drag is active, not on `drag` itself — `drag.x/y`
    // change on every pointermove, and re-subscribing window listeners that
    // often would be wasteful; the listeners always read the LATEST state
    // via dragRef/dispatch regardless of which render attached them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, dispatch]);

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
    if (!prev) return;
    const move = detectSingleMove(prev, position);
    // W2 — sound is a hearing concern, not a motion one, so it plays
    // regardless of prefers-reduced-motion (the slide below still respects
    // it). check wins over capture wins over a plain move — the rarer,
    // more important event masks the others, same as most chess UIs.
    if (move) {
      const kind: SfxKind = checkSquare != null ? "check" : prev[move.to] !== "" ? "capture" : "move";
      play(kind);
    }
    if (!move || !boardRef.current || reducedMotion()) return;
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
  }, [position, checkSquare, play]);

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
        onClick={
          onTap
            ? () => {
                // A plain tap-via-pointer-events already reported itself
                // through the piece's onPointerDown/window pointerup below —
                // this native click is the browser's own follow-up for that
                // same press-release and would double-fire onTap if let
                // through. Cross-square drags never reach here at all (down
                // and up land on different elements, so no click fires).
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onTap(idx);
              }
            : undefined
        }
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
            // .cq-pc is `pointer-events: none` in CSS (so a click anywhere on
            // the square, piece included, has always hit the button, not the
            // image) — W2 needs the piece itself to receive pointerdown, so
            // re-enable hit-testing on it, but only when there's an onTap to
            // drag for; a non-interactive Board render keeps the old
            // click-passes-through behaviour untouched.
            style={onTap ? { pointerEvents: "auto" } : undefined}
            onPointerDown={
              onTap
                ? (e) => {
                    // Only left-button / primary-touch presses start a drag.
                    if (e.button !== 0) return;
                    e.preventDefault();
                    suppressClickRef.current = true;
                    dispatch({ type: "down", idx, x: e.clientX, y: e.clientY, pointerId: e.pointerId });
                  }
                : undefined
            }
          />
        ) : coins?.has(idx) ? (
          <span className="cq-coin" />
        ) : null}
      </button>,
    );
  }

  // The dragged piece's own image follows the pointer as a ghost — same
  // sprite, positioned at the last known pointer coordinates. position[] is
  // read fresh here (not stashed on drag state) so it always reflects the
  // CURRENT board even if it changes mid-drag.
  const dragPiece = drag ? position[drag.fromIdx] : "";

  return (
    <div
      ref={boardRef}
      className={`cq-board${shaking ? " cq-shake" : ""}${drag ? " cq-dragging" : ""}`}
    >
      {squares}
      {drag && dragPiece ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          aria-hidden
          alt=""
          draggable={false}
          src={`/games/chess-quest/pieces/${dragPiece.toLowerCase()}${isWhitePiece(dragPiece) ? "l" : "d"}.svg`}
          className="cq-ghost"
          style={{ left: drag.x, top: drag.y }}
        />
      ) : null}
    </div>
  );
}
