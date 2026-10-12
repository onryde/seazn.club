// T16 (design §3.4 step 3, controller ruling T10 carry) — the public page
// watches the game HERE: `PublicExternalPlay` carries a view-only board
// (`watch`) and `isWatchable` says when there is one to draw. Statuses are
// the bridge's own vocabulary (ExternalPlayStatus); the table below is the
// rule — a board is drawn only while a game is on or over, and only when the
// board itself is there (a status alone must never draw an empty board).
import { describe, expect, it } from "vitest";
import { isWatchable, overFromStatus, plyOfFen, type PublicExternalPlay, type PublicWatch } from "../public-view";
import { LICHESS_STATUSES } from "../types";

const WATCH: PublicWatch = {
  fen: "rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2",
  lastMove: "g8f6",
  turn: "white",
  ply: 2,
  whiteMs: 598_000,
  blackMs: 597_000,
  asOf: "2026-10-13T10:00:00.000Z",
  clockRunning: true,
  over: false,
  whiteSide: "home",
};

describe("isWatchable", () => {
  it("live and finished with a board are watchable; pending, ready and a hold are not", () => {
    const cases: [PublicExternalPlay["status"], boolean][] = [
      ["pending", false],
      ["ready", false],
      ["live", true],
      ["finished", true],
      ["needs_organiser", false],
    ];
    let checked = 0;
    for (const [status, want] of cases) {
      expect(isWatchable({ status, watch: WATCH }), status).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every bridge status").toBe(5);
  });

  it("the empty case: a live status with no board yet is NOT watchable — never a blank board", () => {
    expect(isWatchable({ status: "live", watch: null })).toBe(false);
    expect(isWatchable({ status: "finished", watch: null })).toBe(false);
  });
});

describe("overFromStatus — a broadcast's Lichess status, as the spectator's 'is it over'", () => {
  it("only created and started are a game still on; every terminal status is over", () => {
    // The rulebook: Lichess's game status list (lila Status.scala) — created and started are the two live states.
    const LIVE = new Set(["created", "started"]);
    let checked = 0;
    for (const s of LICHESS_STATUSES) {
      expect(overFromStatus(s), s).toBe(!LIVE.has(s));
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared status").toBe(LICHESS_STATUSES.length);
    expect(checked).toBeGreaterThan(2);
  });
});

describe("plyOfFen — the order of two boards, from the FEN's own fields", () => {
  it("side to move and fullmove number give the half-moves played (FEN spec)", () => {
    const cases: [string, number][] = [
      ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 0],
      ["rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", 1],
      ["rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKBNR w KQkq - 2 2", 2],
      ["rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2", 3],
    ];
    let checked = 0;
    for (const [fen, ply] of cases) {
      expect(plyOfFen(fen), fen).toBe(ply);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("not a FEN is a refusal, never a guessed ply", () => {
    let checked = 0;
    for (const bad of ["", "8/8/8/8/8/8/8/8", "8/8/8/8/8/8/8/8 x - - 0 1", "8/8/8/8/8/8/8/8 w - - 0 0", "8/8/8/8/8/8/8/8 w - - 0 z"]) {
      expect(() => plyOfFen(bad), JSON.stringify(bad)).toThrow(/not a FEN/);
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});
