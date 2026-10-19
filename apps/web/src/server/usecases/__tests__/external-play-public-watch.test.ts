// T16 — the spectator's board from the move ledger (`watchFromLedger`), the
// cases the database suite (public-fixture-external-play.test.ts) does not
// reach: no game yet, a ledger chess.js cannot replay in full, and when the
// clocks run. Expected positions are the rules' (FEN), not a replay of ours.
import { describe, expect, it } from "vitest";
import { watchFromLedger } from "../external-play-read";

const row = (o: Partial<Parameters<typeof watchFromLedger>[0]> = {}): Parameters<typeof watchFromLedger>[0] => ({
  status: "live",
  challenge_id: "gm123456",
  white_side: "home",
  moves_uci: [],
  move_count: 0,
  white_ms: null,
  black_ms: null,
  last_move_at: null,
  ...o,
});

describe("watchFromLedger", () => {
  it("the empty case first: no game at Lichess ⇒ no board, whatever the status", () => {
    let checked = 0;
    for (const status of ["pending", "ready", "live", "finished", "needs_organiser"] as const) {
      expect(watchFromLedger(row({ status, challenge_id: null })), status).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("a ledger chess.js cannot replay in full shows the plies it could — the last move is one the board shows", () => {
    // 1.e4 e5, then a move no position allows (a king from e1 to e8).
    const w = watchFromLedger(row({ moves_uci: ["e2e4", "e7e5", "e1e8"], move_count: 3, white_ms: 1, black_ms: 1 }))!;
    expect(w.fen).toBe("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
    expect(w).toMatchObject({ lastMove: "e7e5", ply: 2, turn: "white" });
  });

  it("the clocks run from ply 2 while the game is on and both are read — and not otherwise", () => {
    const cells: [string, Partial<Parameters<typeof watchFromLedger>[0]>, boolean][] = [
      ["ply 1", { moves_uci: ["e2e4"], move_count: 1, white_ms: 600_000, black_ms: 600_000 }, false],
      ["ply 2", { moves_uci: ["e2e4", "e7e5"], move_count: 2, white_ms: 600_000, black_ms: 600_000 }, true],
      ["ply 2, no clocks read", { moves_uci: ["e2e4", "e7e5"], move_count: 2 }, false],
      ["ply 2, over", { status: "finished", moves_uci: ["e2e4", "e7e5"], move_count: 2, white_ms: 1, black_ms: 1 }, false],
    ];
    let checked = 0;
    for (const [label, o, running] of cells) {
      expect(watchFromLedger(row(o))!.clockRunning, label).toBe(running);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });
});
