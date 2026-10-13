// T14 — the board wrapper is ours, client-only, and drives our own promotion
// picker (brief Step 19). Source facts, because the wrapper only runs in a
// browser; its behaviour is the room e2e's. `legalDests` is pure and tested
// against chess.js's rules directly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Board, { boardChrome, legalDests } from "../board";

const DIR = join(__dirname, "..");

describe("the board wrapper", () => {
  it("m8: the surface is a labelled group (its squares take clicks), never an image; it says whether it is movable", () => {
    // Its first paint, before chessground mounts (effects do not run here).
    const paint = (movable: boolean) =>
      renderToStaticMarkup(
        createElement(Board, {
          fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          orientation: "white",
          lastMove: null,
          movable,
          syncKey: 0,
          onMove: () => {},
          label: "White to move",
          t: (k: string) => k,
        }),
      );
    let checked = 0;
    for (const movable of [true, false]) {
      const html = paint(movable);
      expect(html).toMatch(/data-testid="room-board-surface"[^>]*role="group"/);
      expect(html).toMatch(/aria-label="White to move"/);
      expect(html).not.toContain('role="img"');
      expect(html).toContain(`data-movable="${movable}"`);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("T16: a view-only board (the spectators') takes no move, even when asked to be movable, and says so", () => {
    const html = renderToStaticMarkup(
      createElement(Board, {
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        orientation: "white",
        lastMove: null,
        movable: true,
        viewOnly: true,
        syncKey: 0,
        onMove: () => {},
        label: "White to move",
        t: (k: string) => k,
      }),
    );
    expect(html).toContain('data-movable="false"');
    expect(html).toContain('data-view-only="true"');
    // chessground's own switch, and no square to select (its README: viewOnly "don't bind events").
    expect(boardChrome(true)).toMatchObject({ viewOnly: true, selectable: { enabled: false }, drawable: { enabled: false } });
    // The positive pair: the room's board binds its events.
    expect(boardChrome(false)).toMatchObject({ viewOnly: false, selectable: { enabled: true } });
  });

  it("room-shell mounts the board through next/dynamic with ssr:false — chessground touches document", () => {
    const src = readFileSync(join(DIR, "room-shell.tsx"), "utf8");
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/board"\),\s*\{\s*ssr:\s*false\s*\}\s*\)/);
  });

  it("board.tsx reaches chessground ONLY through the licence loader", () => {
    const src = readFileSync(join(DIR, "board.tsx"), "utf8");
    expect(src).toContain('from "./board-loader"');
    // Spelled in two halves: licence-isolation.test.ts scans every source
    // file for the import pattern itself, and this test file must not match.
    const pkg = ["chess", "ground"].join("");
    expect(src).not.toContain(`from "${pkg}`);
    expect(src).not.toContain(`import("${pkg}`);
  });

  it("board.tsx asks OUR promotion module, never a chessground one", () => {
    const src = readFileSync(join(DIR, "board.tsx"), "utf8");
    expect(src).toContain('from "./promotion"');
    expect(src).toContain("needsPromotion");
  });

  it("board.tsx submits a UCI string upward and never calls Lichess itself (design §3.4 step 1)", () => {
    const src = readFileSync(join(DIR, "board.tsx"), "utf8");
    expect(src).not.toContain("lichess.org");
    expect(src).not.toContain("api/board");
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

describe("legalDests (chess.js's rules, the board's hints)", () => {
  it("the opening position: 20 legal moves from 10 squares (FIDE: 16 pawn + 4 knight)", () => {
    const d = legalDests("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    const total = [...d.values()].reduce((n, l) => n + l.length, 0);
    expect(total).toBe(20);
    expect(d.size).toBe(10);
    expect(d.get("g1")?.sort()).toEqual(["f3", "h3"]);
  });

  it("a promotion lists its square ONCE, not once per piece", () => {
    const d = legalDests("6k1/3P4/8/8/8/8/5PPP/6K1 w - - 0 40");
    expect(d.get("d7")).toEqual(["d8"]);
  });

  it("a mated side has no moves (empty case), and garbage is no moves rather than a throw", () => {
    expect(legalDests("r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4").size).toBe(0);
    expect(legalDests("not a fen").size).toBe(0);
  });
});
