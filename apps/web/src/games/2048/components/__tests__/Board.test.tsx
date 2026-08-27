// Board -- rendered through react-dom/server (no jsdom in this workspace;
// see _shared/use-game-store.test.tsx's header for the same fact across the
// games toolkit). Pure function of props (same posture as Daily Word's
// Grid.tsx) -- index.tsx owns all state, this just renders it. Assertions
// anchor on `="` per this repo's standing rule: React serialises an omitted
// prop as the literal string "$undefined", so a bare `data-*` substring
// probe would pass whether or not the attribute is really set.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyBoard } from "../../engine";
import { Board } from "../Board";

describe("Board", () => {
  it("renders all 16 cells, even on an empty board", () => {
    const html = renderToStaticMarkup(<Board board={emptyBoard()} anims={new Map()} moveGen={0} />);
    expect((html.match(/data-cell="/g) ?? []).length).toBe(16);
    expect((html.match(/data-value="0"/g) ?? []).length).toBe(16);
  });

  it("renders each non-zero cell's numeric value as text", () => {
    const board = emptyBoard();
    board[0][0] = 2;
    board[1][2] = 2048;
    const html = renderToStaticMarkup(<Board board={board} anims={new Map()} moveGen={0} />);
    expect(html).toContain('data-value="2"');
    expect(html).toContain('data-value="2048"');
    expect(html).toContain(">2048<");
  });

  it("marks a spawned cell with the spawn animation class", () => {
    const board = emptyBoard();
    board[0][0] = 2;
    const html = renderToStaticMarkup(
      <Board board={board} anims={new Map([["0-0", "spawn"]])} moveGen={3} />,
    );
    expect(html).toMatch(/data-cell="0-0"[^>]*class="[^"]*tile-2048-spawn/);
  });

  it("marks a merged cell with the merge-pop animation class", () => {
    const board = emptyBoard();
    board[0][0] = 4;
    const html = renderToStaticMarkup(
      <Board board={board} anims={new Map([["0-0", "merge"]])} moveGen={3} />,
    );
    expect(html).toMatch(/data-cell="0-0"[^>]*class="[^"]*tile-2048-merge/);
  });

  it("applies no animation class to a cell absent from anims", () => {
    const board = emptyBoard();
    board[0][0] = 2;
    const html = renderToStaticMarkup(<Board board={board} anims={new Map()} moveGen={0} />);
    expect(html).not.toContain("tile-2048-spawn");
    expect(html).not.toContain("tile-2048-merge");
  });
});
