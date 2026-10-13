// T16 — the spectators' view-only board (brief Steps 4-5). The board itself
// is chessground, reached only through the room's Board (client-only, via
// board-loader — licence-isolation.test.ts holds the one-importer rule), so a
// node render paints the frame around it: names, clocks, whose move, the end.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicWatch } from "@/server/external-play/public-view";
import { WatchBoard } from "../watch-board";

const t = (key: string) => key;
// After 1.e4, Black to move; White has used 18 s.
const watch: PublicWatch = {
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  lastMove: "e2e4",
  turn: "black",
  ply: 1,
  whiteMs: 582_000,
  blackMs: 600_000,
  asOf: "2026-10-09T10:00:00.000Z",
  clockRunning: false,
  over: false,
  whiteSide: "home",
};
const ROOM_CONTROLS = ["room-draw", "room-resign", "room-abort", "room-promotion", "room-offer-draw", "room-checkin"];
const render = (w: PublicWatch | null, names: { white: string; black: string } | null = { white: "Ada", black: "Bo" }, nowMs: number | null = null) =>
  renderToStaticMarkup(<WatchBoard watch={w} names={names} nowMs={nowMs} t={t} />);

describe("WatchBoard", () => {
  it("renders view-only and offers no move affordance", () => {
    const html = render(watch);
    expect(html).toContain('data-testid="watch-board"');
    expect(html).toContain('data-view-only="true"');
    expect(html).toContain("externalPlay.watch.viewOnly");
    let checked = 0;
    for (const id of ROOM_CONTROLS) {
      expect(html, id).not.toContain(`data-testid="${id}`);
      checked += 1;
    }
    expect(checked).toBe(ROOM_CONTROLS.length);
    expect(html).not.toContain("lichess.org");
    expect(html).not.toContain("<button");
  });

  it("the empty case: no board states 'not started', never an empty board", () => {
    const html = render(null);
    expect(html).toContain("externalPlay.watch.notStarted");
    expect(html).not.toContain('data-testid="watch-board"');
  });

  it("each side's name and clock; the side to move is marked, and an unread clock shows a dash, never 0:00", () => {
    const html = render(watch);
    expect(html).toMatch(/data-testid="watch-clock-white" data-active="false"[^]*?Ada[^]*?9:42/);
    expect(html).toMatch(/data-testid="watch-clock-black" data-active="true"[^]*?Bo[^]*?10:00/);
    const unread = render({ ...watch, whiteMs: null, blackMs: null });
    expect(unread).toMatch(/data-testid="watch-clock-white"[^]*?—/);
    expect(unread).not.toContain("0:00");
  });

  it("a running clock counts down from the moment its value was true; a stopped one does not", () => {
    const asOf = Date.parse(watch.asOf!);
    const running = { ...watch, ply: 2, turn: "white" as const, clockRunning: true };
    // White to move, 582 s at asOf; 12 s later the face reads 9:30.
    expect(render(running, null, asOf + 12_000)).toMatch(/data-testid="watch-clock-white"[^]*?9:30/);
    expect(render({ ...running, clockRunning: false }, null, asOf + 12_000)).toMatch(/data-testid="watch-clock-white"[^]*?9:42/);
    // Only the side to move counts down: Black, not to move, still reads its 600 s at asOf.
    const face = (html: string, colour: "white" | "black") =>
      new RegExp(`data-testid="watch-clock-${colour}"[^]*?(\\d+:\\d\\d)`).exec(html)?.[1];
    const both = render(running, null, asOf + 12_000);
    expect(face(both, "white")).toBe("9:30");
    expect(face(both, "black")).toBe("10:00");
    const blackToMove = render({ ...running, ply: 3, turn: "black" }, null, asOf + 12_000);
    expect(face(blackToMove, "white"), "White, not to move, holds its 582 s").toBe("9:42");
    expect(face(blackToMove, "black")).toBe("9:48");
  });

  it("no names yet: each side says its colour", () => {
    const html = render(watch, null);
    expect(html).toContain("externalPlay.room.colour.white");
    expect(html).toContain("externalPlay.room.colour.black");
  });

  it("a game that is over says so, and marks neither side to move", () => {
    const html = render({ ...watch, over: true });
    expect(html).toContain('data-testid="watch-over"');
    expect(html).toContain("externalPlay.room.over.title");
    expect(html).not.toContain('data-active="true"');
    expect(html).toContain('data-over="true"');
  });

  it("reaches chessground only through the room's client-only Board, view-only", () => {
    const src = readFileSync(join(__dirname, "..", "watch-board.tsx"), "utf8");
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\.\/match-room\/board"\),\s*\{\s*ssr:\s*false\s*\}\s*\)/);
    expect(src).toMatch(/<Board[^>]*\bviewOnly\b/);
    const pkg = ["chess", "ground"].join("");
    expect(src).not.toContain(`from "${pkg}`);
    expect(src).not.toContain(`import("${pkg}`);
  });
});
