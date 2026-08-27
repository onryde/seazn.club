// Board.tsx W1: theme/highlights/orientation/motion additions.
//
// Rendered through react-dom/server — vitest runs `environment: "node"` and
// this workspace has no jsdom (see pass-checkout-parity.test.tsx for the same
// pattern). Board calls useProgress(), so every render here is wrapped in a
// ProgressProvider (storage-less: window is undefined under node, so the
// provider falls back to session-only state — the same path progress.test.ts
// exercises via a bare createProgressState()).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { sqIdx } from "../../engine";
import { ProgressProvider } from "../../lib/progress";
import {
  Board,
  cellFor,
  detectSingleMove,
  dragTransition,
  resolveDropSquare,
  runDragAction,
  type DragState,
} from "../Board";

const EMPTY_BOARD: string[] = Array(64).fill("");

/** The full `<button …>…</button>` element for a given data-square (attributes
 * AND children — overlay spans/pieces render as children, not attributes). */
function squareTag(html: string, square: string): string {
  const marker = `data-square="${square}"`;
  const at = html.indexOf(marker);
  if (at === -1) throw new Error(`data-square="${square}" not found in markup`);
  const tagStart = html.lastIndexOf("<button", at);
  const tagEnd = html.indexOf("</button>", at);
  if (tagStart === -1 || tagEnd === -1) throw new Error(`malformed <button> around ${square}`);
  return html.slice(tagStart, tagEnd + "</button>".length);
}

function renderBoard(props: Partial<React.ComponentProps<typeof Board>> = {}): string {
  return renderToStaticMarkup(
    <ProgressProvider>
      <Board position={EMPTY_BOARD} {...props} />
    </ProgressProvider>,
  );
}

describe("cellFor — square index to grid cell, both orientations", () => {
  it("white (default): a8 top-left, h1 bottom-right, a1 bottom-left, h8 top-right", () => {
    expect(cellFor(sqIdx("a8"), "white")).toEqual({ row: 1, col: 1 });
    expect(cellFor(sqIdx("h1"), "white")).toEqual({ row: 8, col: 8 });
    expect(cellFor(sqIdx("a1"), "white")).toEqual({ row: 8, col: 1 });
    expect(cellFor(sqIdx("h8"), "white")).toEqual({ row: 1, col: 8 });
  });

  // A board flip is a 180° rotation, not a mirror of one axis. Verified two
  // ways: (1) rotation arithmetic, (2) the universal "light square on your
  // own right" board-setup rule — a8 and h1 are both light squares, so each
  // side's own bottom-right corner in their own oriented view must be light.
  // a8 is light (confirmed: a1 dark, alternating up the a-file to a8 lands
  // light) — so a8 belongs at black's bottom-right, not a1.
  it("black (flipped 180°): a8 bottom-right, h1 top-left, a1 top-right, h8 bottom-left", () => {
    expect(cellFor(sqIdx("a8"), "black")).toEqual({ row: 8, col: 8 });
    expect(cellFor(sqIdx("h1"), "black")).toEqual({ row: 1, col: 1 });
    expect(cellFor(sqIdx("a1"), "black")).toEqual({ row: 1, col: 8 });
    expect(cellFor(sqIdx("h8"), "black")).toEqual({ row: 8, col: 1 });
  });

  it("every index maps to a unique cell in [1,8]x[1,8] for either orientation", () => {
    for (const orientation of ["white", "black"] as const) {
      const seen = new Set<string>();
      for (let idx = 0; idx < 64; idx++) {
        const { row, col } = cellFor(idx, orientation);
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(8);
        expect(col).toBeGreaterThanOrEqual(1);
        expect(col).toBeLessThanOrEqual(8);
        const key = `${row},${col}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("Board rendered — orientation flips grid placement, data-square stays put", () => {
  it("default (white) places a1 bottom-left, h8 top-right", () => {
    const html = renderBoard();
    expect(squareTag(html, "a1")).toContain("grid-row:8");
    expect(squareTag(html, "a1")).toContain("grid-column:1");
    expect(squareTag(html, "h8")).toContain("grid-row:1");
    expect(squareTag(html, "h8")).toContain("grid-column:8");
  });

  it("orientation=\"black\" places a8 bottom-right, h1 top-left", () => {
    const html = renderBoard({ orientation: "black" });
    expect(squareTag(html, "a8")).toContain("grid-row:8");
    expect(squareTag(html, "a8")).toContain("grid-column:8");
    expect(squareTag(html, "h1")).toContain("grid-row:1");
    expect(squareTag(html, "h1")).toContain("grid-column:1");
  });

  it("data-square invariant: every square name is present exactly once in both orientations", () => {
    for (const orientation of ["white", "black"] as const) {
      const html = renderBoard({ orientation });
      const matches = html.match(/data-square="[a-h][1-8]"/g) ?? [];
      expect(matches).toHaveLength(64);
      expect(new Set(matches).size).toBe(64);
      // The square's own aria-label (its logical name, board is empty) must
      // not change just because it was drawn somewhere else on screen.
      expect(squareTag(html, "e4")).toContain('aria-label="e4"');
    }
  });
});

describe("Board rendered — coordinates follow orientation to the outer edge", () => {
  it("white: rank numbers on the a-file, file letters on rank 1", () => {
    const html = renderBoard();
    expect(squareTag(html, "a5")).toContain('data-rank="5"');
    expect(squareTag(html, "b5")).not.toContain("data-rank");
    expect(squareTag(html, "c1")).toContain('data-file="c"');
    expect(squareTag(html, "c2")).not.toContain("data-file");
  });

  it("black: rank numbers move to the h-file, file letters to rank 8", () => {
    const html = renderBoard({ orientation: "black" });
    expect(squareTag(html, "h5")).toContain('data-rank="5"');
    expect(squareTag(html, "g5")).not.toContain("data-rank");
    expect(squareTag(html, "c8")).toContain('data-file="c"');
    expect(squareTag(html, "c7")).not.toContain("data-file");
  });

  it("labels default to true — no prop needed to see coordinates", () => {
    const html = renderBoard();
    expect(squareTag(html, "a1")).toContain("data-rank");
  });
});

describe("Board rendered — check/last/sel overlays and move/cap markers", () => {
  it("checkSquare renders a check overlay", () => {
    const html = renderBoard({ checkSquare: sqIdx("e1") });
    expect(squareTag(html, "e1")).toContain("cq-ov-check");
  });

  it("lastMove renders overlays on both its from and to squares", () => {
    const html = renderBoard({ lastMove: { from: sqIdx("e2"), to: sqIdx("e4") } });
    expect(squareTag(html, "e2")).toContain("cq-ov-last");
    expect(squareTag(html, "e4")).toContain("cq-ov-last");
  });

  it("a square can carry last AND check at once", () => {
    const html = renderBoard({
      lastMove: { from: sqIdx("d2"), to: sqIdx("e1") },
      checkSquare: sqIdx("e1"),
    });
    const tag = squareTag(html, "e1");
    expect(tag).toContain("cq-ov-last");
    expect(tag).toContain("cq-ov-check");
  });

  it("sel and hint render as overlays; move/cap render as the button's own class", () => {
    const html = renderBoard({
      highlights: { [sqIdx("d1")]: "sel", [sqIdx("d2")]: "hint", [sqIdx("d3")]: "move", [sqIdx("d4")]: "cap" },
    });
    expect(squareTag(html, "d1")).toContain("cq-ov-sel");
    expect(squareTag(html, "d2")).toContain("cq-ov-hint");
    expect(squareTag(html, "d3")).toContain("cq-hl-move");
    expect(squareTag(html, "d4")).toContain("cq-hl-cap");
  });
});

describe("detectSingleMove — the FLIP-slide detector", () => {
  it("no change → null", () => {
    expect(detectSingleMove(EMPTY_BOARD, EMPTY_BOARD)).toBeNull();
  });

  it("a simple move (origin empties, destination gains the piece)", () => {
    const prev = EMPTY_BOARD.slice();
    prev[sqIdx("e2")] = "P";
    const next = prev.slice();
    next[sqIdx("e2")] = "";
    next[sqIdx("e4")] = "P";
    expect(detectSingleMove(prev, next)).toEqual({ from: sqIdx("e2"), to: sqIdx("e4") });
  });

  it("a capture (destination held an enemy piece)", () => {
    const prev = EMPTY_BOARD.slice();
    prev[sqIdx("e4")] = "P";
    prev[sqIdx("d5")] = "p";
    const next = prev.slice();
    next[sqIdx("e4")] = "";
    next[sqIdx("d5")] = "P";
    expect(detectSingleMove(prev, next)).toEqual({ from: sqIdx("e4"), to: sqIdx("d5") });
  });

  it("a promotion (destination content differs from the origin's old piece)", () => {
    const prev = EMPTY_BOARD.slice();
    prev[sqIdx("e7")] = "P";
    const next = prev.slice();
    next[sqIdx("e7")] = "";
    next[sqIdx("e8")] = "Q";
    expect(detectSingleMove(prev, next)).toEqual({ from: sqIdx("e7"), to: sqIdx("e8") });
  });

  it("loading a whole new position (many squares differ) → null, no slide", () => {
    const prev = EMPTY_BOARD.slice();
    prev[0] = "r";
    prev[1] = "n";
    prev[2] = "b";
    const next = EMPTY_BOARD.slice();
    next[10] = "P";
    next[20] = "Q";
    next[30] = "k";
    expect(detectSingleMove(prev, next)).toBeNull();
  });

  it("mismatched lengths → null", () => {
    expect(detectSingleMove(EMPTY_BOARD, EMPTY_BOARD.slice(0, 63))).toBeNull();
  });

  it("two squares differ but neither vacates → null (not a move)", () => {
    const prev = EMPTY_BOARD.slice();
    prev[0] = "P";
    prev[1] = "p";
    const next = prev.slice();
    next[0] = "Q"; // same square changed content, didn't empty
    expect(detectSingleMove(prev, next)).toBeNull();
  });
});

// W2 — drag reducer. Pure function, no DOM: down/up always resolve against
// plain state objects, never against real pointer events. down and "up on a
// different square" report a tap (reusing tap selection, so the game
// component sees exactly what a tap would produce); "up" back on the SAME
// square as down reports no further tap — the down's tap already covered a
// stationary press, so a plain tap performed via pointer events still fires
// onTap exactly once overall (see the "Rendered" describe block below for
// that count); "up" outside the board (idx null) is a cancel, also no tap.
describe("dragTransition — W2 drag reducer (down → move → up)", () => {
  it("down starts a drag from the pressed square and reports a tap for it", () => {
    const { state, tap } = dragTransition(null, { type: "down", idx: 12, x: 10, y: 20, pointerId: 1 });
    expect(state).toEqual({ fromIdx: 12, x: 10, y: 20, pointerId: 1 });
    expect(tap).toBe(12);
  });

  it("move updates the ghost position and never taps", () => {
    const afterDown = dragTransition(null, {
      type: "down",
      idx: 12,
      x: 10,
      y: 20,
      pointerId: 1,
    }).state;
    const { state, tap } = dragTransition(afterDown, { type: "move", x: 30, y: 40, pointerId: 1 });
    expect(state).toEqual({ fromIdx: 12, x: 30, y: 40, pointerId: 1 });
    expect(tap).toBeNull();
  });

  it("move before any down is a no-op (defensive — should not happen in practice)", () => {
    const { state, tap } = dragTransition(null, { type: "move", x: 30, y: 40, pointerId: 1 });
    expect(state).toBeNull();
    expect(tap).toBeNull();
  });

  it("up on a legal target: ends the drag and taps the target", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "up", idx: 29, pointerId: 1 });
    expect(state).toBeNull();
    expect(tap).toBe(29);
  });

  it("up on an illegal target: still ends the drag and taps it — legality is not this function's job", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "up", idx: 40, pointerId: 1 });
    expect(state).toBeNull();
    expect(tap).toBe(40);
  });

  it("up on the SAME square as down: ends the drag, no second tap (down's tap already covered it)", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "up", idx: 12, pointerId: 1 });
    expect(state).toBeNull();
    expect(tap).toBeNull();
  });

  it("up outside the board (idx null): cancels, no tap", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "up", idx: null, pointerId: 1 });
    expect(state).toBeNull();
    expect(tap).toBeNull();
  });

  // Found in review 2026-08-27: a second finger going down mid-drag used to
  // silently steal `fromIdx`, so the FIRST finger's eventual release fired
  // onTap with the SECOND finger's (now stale) square — a real misfire, not
  // just a missed tap. These three lock in the fix: single-pointer-only.
  it("a second pointer's down mid-drag is dropped, not stolen — the first drag keeps its fromIdx", () => {
    const afterFirstDown = dragTransition(null, {
      type: "down",
      idx: 12,
      x: 0,
      y: 0,
      pointerId: 1,
    }).state;
    const { state, tap } = dragTransition(afterFirstDown, {
      type: "down",
      idx: 40,
      x: 0,
      y: 0,
      pointerId: 2,
    });
    expect(state).toEqual({ fromIdx: 12, x: 0, y: 0, pointerId: 1 });
    expect(tap).toBeNull();
  });

  it("move from a pointer that isn't the active drag's is ignored", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "move", x: 99, y: 99, pointerId: 2 });
    expect(state).toEqual({ fromIdx: 12, x: 0, y: 0, pointerId: 1 });
    expect(tap).toBeNull();
  });

  it("up from a pointer that isn't the active drag's is ignored — the real drag stays open", () => {
    const afterDown = dragTransition(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }).state;
    const { state, tap } = dragTransition(afterDown, { type: "up", idx: 40, pointerId: 2 });
    expect(state).toEqual({ fromIdx: 12, x: 0, y: 0, pointerId: 1 });
    expect(tap).toBeNull();
  });
});

// Found in review 2026-08-27: touch pointers get implicit capture on
// pointerdown, so a touch drag's pointerup.target is always the ORIGIN
// square, never wherever the finger actually released — resolveDropSquare
// reads the live coordinate via elementFromPoint instead, sidestepping
// capture. Faked here without a real DOM by injecting a stub
// elementFromPoint (this workspace has no jsdom).
describe("resolveDropSquare — reads the point under the pointer, not e.target", () => {
  function fakeSquareEl(square: string): Element {
    return { closest: () => ({ dataset: { square } }) } as unknown as Element;
  }

  it("resolves the square at the given coordinates via the injected elementFromPoint", () => {
    const elementFromPoint = vi.fn().mockReturnValue(fakeSquareEl("e4"));
    const idx = resolveDropSquare(123, 456, elementFromPoint);
    expect(elementFromPoint).toHaveBeenCalledWith(123, 456);
    expect(idx).toBe(sqIdx("e4"));
  });

  it("returns null when the point isn't over a square (outside the board)", () => {
    const elementFromPoint = vi.fn().mockReturnValue({ closest: () => null });
    expect(resolveDropSquare(0, 0, elementFromPoint)).toBeNull();
  });

  it("returns null when the point resolves to nothing at all", () => {
    const elementFromPoint = vi.fn().mockReturnValue(null);
    expect(resolveDropSquare(0, 0, elementFromPoint)).toBeNull();
  });
});

// W2 — "Rendered" per the spec: "pointerdown on a piece then pointerup on a
// legal target calls onTap with the target index once." This workspace has
// no jsdom/react-test-renderer (Board.test.tsx's own header above, and
// attribution-link.test.tsx, document it: "call the component function
// directly... instead of rendering to a DOM" is the established pattern for
// anything interactive), so a real mounted pointerdown→pointerup cannot be
// simulated. `runDragAction` is the exact glue Board's pointer handlers call
// on every down/move/up (see Board.tsx) — calling it directly with the same
// actions a real gesture would produce exercises identical logic without a
// live DOM.
describe("runDragAction — the onTap-invoking wiring behind Board's pointer handlers", () => {
  it("pointerdown on a piece then pointerup on a legal target calls onTap with the target index once", () => {
    const onTap = vi.fn();
    let state: DragState = null;
    state = runDragAction(state, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }, onTap);
    state = runDragAction(state, { type: "up", idx: 29, pointerId: 1 }, onTap);
    expect(state).toBeNull();
    expect(onTap.mock.calls.filter((c) => c[0] === 29)).toHaveLength(1);
  });

  it("the down call itself taps the source square (so sel/move highlights appear immediately, same as a tap)", () => {
    const onTap = vi.fn();
    runDragAction(null, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }, onTap);
    expect(onTap).toHaveBeenCalledWith(12);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("a stationary press-release (down then up on the same square) calls onTap exactly once total — parity with a plain tap", () => {
    const onTap = vi.fn();
    let state: DragState = null;
    state = runDragAction(state, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }, onTap);
    state = runDragAction(state, { type: "up", idx: 12, pointerId: 1 }, onTap);
    expect(state).toBeNull();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(12);
  });

  it("releasing outside the board cancels without ever calling onTap for the release", () => {
    const onTap = vi.fn();
    let state: DragState = null;
    state = runDragAction(state, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }, onTap);
    onTap.mockClear(); // keep only calls from the release under test
    state = runDragAction(state, { type: "up", idx: null, pointerId: 1 }, onTap);
    expect(state).toBeNull();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("a second pointer's down/up mid-drag never calls onTap — the first drag's release still does", () => {
    const onTap = vi.fn();
    let state: DragState = null;
    state = runDragAction(state, { type: "down", idx: 12, x: 0, y: 0, pointerId: 1 }, onTap);
    onTap.mockClear();
    state = runDragAction(state, { type: "down", idx: 40, x: 0, y: 0, pointerId: 2 }, onTap);
    state = runDragAction(state, { type: "up", idx: 40, pointerId: 2 }, onTap);
    expect(onTap).not.toHaveBeenCalled();
    state = runDragAction(state, { type: "up", idx: 29, pointerId: 1 }, onTap);
    expect(state).toBeNull();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith(29);
  });

  it("does nothing if onTap is undefined (board without an onTap prop stays inert)", () => {
    expect(() =>
      runDragAction(null, { type: "down", idx: 5, x: 0, y: 0, pointerId: 1 }, undefined),
    ).not.toThrow();
  });
});
