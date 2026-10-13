// T16 (design §3.4 step 3, controller ruling T10 carry) — the public page
// watches the game HERE: `PublicExternalPlay` carries a view-only board
// (`watch`). Which view draws it is the panel's (watch-state.ts, tested
// there); this file pins the public reading of a hold, a broadcast's status
// and a FEN's ply.
import { describe, expect, it } from "vitest";
import { PUBLIC_HOLD, overFromStatus, plyOfFen, type PublicHold } from "../public-view";
import { LICHESS_STATUSES, NEEDS_REASONS, type NeedsReason } from "../types";

describe("PUBLIC_HOLD — what a spectator is told about a board held for the organiser", () => {
  it("every hold reason is read: a knockout draw is 'winner to be decided', a revoked token is no hold (the game goes on), the rest 'to be confirmed'", () => {
    // The rulebook: tiebreak_owed is the one hold whose game is already decided as a draw (T13); token_revoked
    // holds one seat's link, not the game (RECONCILED_WHILE_HELD). Every other reason waits on the organiser.
    const SPECIAL: Partial<Record<NeedsReason, PublicHold | null>> = { tiebreak_owed: "tiebreak", token_revoked: null };
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      expect(PUBLIC_HOLD[reason], reason).toBe(reason in SPECIAL ? SPECIAL[reason] : "confirm");
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared reason").toBe(NEEDS_REASONS.length);
    expect(Object.keys(PUBLIC_HOLD).sort(), "no reason the engine does not declare").toEqual([...NEEDS_REASONS].sort());
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

  it("a status nobody declared is a refusal, never read as 'still on' or 'over'", () => {
    expect(() => overFromStatus("unrecognised" as never)).toThrow(/unknown status/);
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
