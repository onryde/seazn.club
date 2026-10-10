// The play loop (chess in-page board design §3.4, Task 10). DB-backed blocks
// guard on DATABASE_URL; the pure blocks always run.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`), so the one other-sport case below is
// the guard's refusal, not a second play path.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { fenAfter } from "@/server/usecases/external-play/play";

const HAS_DB = !!process.env.DATABASE_URL;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("fenAfter", () => {
  it("an EMPTY move list is the start position, replayed 0", () => {
    expect(fenAfter([])).toEqual({ fen: START_FEN, replayed: 0 });
  });

  it("replays a UCI list and reports how many it applied", () => {
    const out = fenAfter(["e2e4", "e7e5", "g1f3"]);
    expect(out.replayed, "three legal moves").toBe(3);
    // Side to move after three plies is Black; the half-move/full-move
    // counters come from chess.js, not from us.
    expect(out.fen.split(" ")[1]).toBe("b");
    expect(out.fen.startsWith("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R")).toBe(true);
  });

  it("carries a promotion suffix through (M7: e7e8q → e8=Q)", () => {
    // A legal promotion reached by a short real sequence.
    const moves = ["e2e4", "d7d5", "e4d5", "c7c6", "d5c6", "b8d7", "c6b7", "d7b6", "b7a8q"];
    const out = fenAfter(moves);
    expect(out.replayed).toBe(9);
    // The promoted White queen stands on a8.
    expect(out.fen.split(" ")[0]!.split("/")[0]!.startsWith("Q")).toBe(true);
  });

  it("an under-promotion keeps its piece (b7a8n ⇒ a White KNIGHT on a8, not a queen)", () => {
    // The differential for the case above: a pass-through that always
    // promoted to a queen would pass it.
    const moves = ["e2e4", "d7d5", "e4d5", "c7c6", "d5c6", "b8d7", "c6b7", "d7b6", "b7a8n"];
    const out = fenAfter(moves);
    expect(out.replayed).toBe(9);
    expect(out.fen.split(" ")[0]!.split("/")[0]!.startsWith("N")).toBe(true);
  });

  it("STOPS at a move chess.js rejects and reports the shorter count — it never throws", () => {
    // Lichess is the authority on legality (global constraint), so a
    // disagreement is not ours to adjudicate: we report the last FEN we
    // could build and the caller reconciles.
    const out = fenAfter(["e2e4", "e2e4"]);
    expect(out.replayed, "the second e2e4 is illegal — replay stopped").toBe(1);
    expect(out.fen.split(" ")[1]).toBe("b");
  });

  it("a rejected FIRST move reports replayed 0 and the start position", () => {
    expect(fenAfter(["e2e5"])).toEqual({ fen: START_FEN, replayed: 0 });
  });
});
