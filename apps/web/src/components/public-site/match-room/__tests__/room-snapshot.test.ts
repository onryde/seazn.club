import { describe, expect, it } from "vitest";
import { EngineError, FORFEIT_REASONS, foldMatch } from "@seazn/engine/core";
import { boardgame, BoardgameMethod } from "@seazn/engine/sports/boardgame";
import {
  ROOM_REALTIME_TTL_MS,
  forfeitResultFor,
  frozenFor,
  gameClocks,
  realtimeExpiry,
  resultFor,
  turnAfter,
  windowWire,
} from "../room-snapshot";
import { DEADLINE_AFTER_MS, windowFor } from "@/server/external-play/window";

describe("frozenFor (T11 M7 — which seat a token_revoked hold froze, seen by the viewer)", () => {
  it("the empty case: no frozen seat ⇒ null for either viewer", () => {
    expect(frozenFor(null, "white")).toBeNull();
    expect(frozenFor(null, "black")).toBeNull();
  });

  it("every seat × viewer: the frozen player reads `you`, the other `opponent`, both reads `both`", () => {
    const table: [("white" | "black" | "both"), ("white" | "black"), string][] = [
      ["white", "white", "you"],
      ["white", "black", "opponent"],
      ["black", "black", "you"],
      ["black", "white", "opponent"],
      ["both", "white", "both"],
      ["both", "black", "both"],
    ];
    let checked = 0;
    for (const [seat, me, want] of table) {
      expect(frozenFor(seat, me), `${seat} seen by ${me}`).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: seat × viewer cells").toBe(6);
  });
});

describe("gameClocks", () => {
  const limitMs = 600_000;
  it("before any move both clocks show the division's limit and do not run", () => {
    expect(gameClocks({ limitMs, whiteMs: null, blackMs: null, lastMoveAt: null, moveCount: 0, over: false })).toEqual({
      whiteMs: limitMs,
      blackMs: limitMs,
      clockAsOf: null,
      clockRunning: false,
    });
  });

  it("the boundary is ply TWO: after White's first move the clocks still stand (lila starts them when both have moved)", () => {
    const at = new Date("2026-10-12T10:00:00Z");
    expect(gameClocks({ limitMs, whiteMs: 600_000, blackMs: 600_000, lastMoveAt: at, moveCount: 1, over: false }).clockRunning).toBe(false);
    expect(gameClocks({ limitMs, whiteMs: 600_000, blackMs: 598_000, lastMoveAt: at, moveCount: 2, over: false }).clockRunning).toBe(true);
  });

  it("stored values win over the limit, as of the last move; a finished game never runs", () => {
    const at = new Date("2026-10-12T10:00:00Z");
    expect(gameClocks({ limitMs, whiteMs: 12_000, blackMs: 9_000, lastMoveAt: at, moveCount: 30, over: true })).toEqual({
      whiteMs: 12_000,
      blackMs: 9_000,
      clockAsOf: at.toISOString(),
      clockRunning: false,
    });
  });
});

describe("turnAfter", () => {
  it("even plies leave White to move, odd Black", () => {
    expect([0, 1, 2, 3].map(turnAfter)).toEqual(["white", "black", "white", "black"]);
  });
});

/** The room's word for an engine outcome kind, from the viewer "me": a win or an award (W2b: a forfeit is an award) is
 *  won/lost; a draw is a draw; a no result — and a double walkover, which is what the engine now folds a double forfeit
 *  to (W2b BG-DW-1) — is no result. The card's vocabulary, not the engine's: it is the one table this suite owns. */
function ROOM_WORD(kind: string, winner: string | null): string {
  if (kind === "win" || kind === "award") return winner === "me" ? "won" : "lost";
  if (kind === "draw") return "draw";
  if (kind === "no_result" || kind === "double_walkover") return "no_result";
  throw new Error(`no room word for ${kind}`);
}

describe("resultFor (review I7: the outcome and score are the ENGINE's — T12's boardgame.result, folded)", () => {
  const seats = { myEntrantId: "me", opponentEntrantId: "them" } as const;

  it("rulebook rows (FIDE Laws: a draw is ½–½; a double forfeit is 0–0 and no result — never a draw; W2b BG-DW-1 folds a legacy one to a double walkover)", () => {
    expect(resultFor({ ...seats, winnerEntrantId: null, method: "agreement", myColour: "white" })).toEqual({
      outcome: "draw",
      method: "agreement",
      score: "½–½",
    });
    const both = resultFor({ ...seats, winnerEntrantId: null, method: "double_forfeit", myColour: "black" });
    expect(both).toEqual({ outcome: "no_result", method: "double_forfeit", score: "0–0" });
  });

  it("every winner × my colour: won/lost from MY entrant, the score always White-first", () => {
    const rows: [string, "white" | "black", "won" | "lost", string][] = [
      ["me", "white", "won", "1–0"],
      ["me", "black", "won", "0–1"],
      ["them", "white", "lost", "0–1"],
      ["them", "black", "lost", "1–0"],
    ];
    let checked = 0;
    for (const [winner, colour, outcome, score] of rows) {
      const r = resultFor({ ...seats, winnerEntrantId: winner, method: "checkmate", myColour: colour });
      expect([r?.outcome, r?.score], `${winner} won, I am ${colour}`).toEqual([outcome, score]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: winner × colour cells").toBe(4);
  });

  it("every engine method × winner × colour: outcome and score are what the engine's own fold says — and what it refuses, refused", () => {
    // The expected values come from the engine (foldMatch over the boardgame
    // module, its default — FIDE — game scoring), never from room-snapshot.
    // W2b (spec §5.2, f-w2) made the method and the winner agree: a pair the
    // engine's own schema refuses (a double forfeit with a winner, a forfeit
    // without one) is refused here too — loudly, never worded as something else.
    const cfg = boardgame.configSchema.parse({});
    const env = (seq: number, type: string, payload: unknown) => ({
      id: `e${seq}`,
      fixtureId: "f",
      seq,
      type,
      payload,
      recordedAt: "2026-10-12T10:00:00.000Z",
      recordedBy: null,
    });
    const kinds = new Set<string>();
    let checked = 0;
    let refused = 0;
    for (const method of BoardgameMethod.options) {
      for (const winner of [null, "me", "them"] as const) {
        for (const myColour of ["white", "black"] as const) {
          const white = myColour === "white" ? "me" : "them";
          const black = myColour === "white" ? "them" : "me";
          const lineups = { home: { entrantId: white, slots: [] }, away: { entrantId: black, slots: [] } };
          let state: unknown;
          try {
            state = foldMatch(boardgame, cfg, lineups, [env(0, "core.start", {}), env(1, "boardgame.result", { winner, method })]);
          } catch (err) {
            if (!(err instanceof EngineError)) throw err;
            expect(() => resultFor({ ...seats, winnerEntrantId: winner, method, myColour }), `${method} / ${winner}: the engine refuses it`).toThrow(EngineError);
            refused += 1;
            continue;
          }
          const o = boardgame.outcome(state as never)!;
          const lines = boardgame.summary(state as never).perSide;
          const want = {
            outcome: ROOM_WORD(o.kind, o.kind === "win" || o.kind === "award" ? o.winner : null),
            score: `${lines.find((l) => l.entrantId === white)!.line}–${lines.find((l) => l.entrantId === black)!.line}`,
          };
          kinds.add(o.kind);
          const r = resultFor({ ...seats, winnerEntrantId: winner, method, myColour });
          expect({ outcome: r?.outcome, score: r?.score }, `${method} / ${winner} / ${myColour}`).toEqual(want);
          expect(r?.method).toBe(method);
          checked += 1;
        }
      }
    }
    expect(checked + refused, "anti-vacuity: method × winner × colour").toBe(BoardgameMethod.options.length * 6);
    expect(checked, "anti-vacuity: cells the engine folds").toBeGreaterThan(0);
    expect(refused, "anti-vacuity: cells the engine refuses (W2b f-w2)").toBeGreaterThan(0);
    expect([...kinds].sort(), "every outcome kind a game result folds to was reached").toEqual(["double_walkover", "draw", "win"]);
  });

  it("no recorded method folds as a plain result; a method the engine does not know is carried, not folded", () => {
    expect(resultFor({ ...seats, winnerEntrantId: "me", method: null, myColour: "white" })).toEqual({ outcome: "won", method: null, score: "1–0" });
    expect(resultFor({ ...seats, winnerEntrantId: null, method: "lichess_variant_end", myColour: "white" })).toEqual({
      outcome: "draw",
      method: "lichess_variant_end",
      score: "½–½",
    });
  });

  it("a winner who is neither seat is not a result this room can state: null (the screen says it is on its way)", () => {
    expect(resultFor({ ...seats, winnerEntrantId: "someone-else", method: "resign", myColour: "white" })).toBeNull();
  });
});

describe("forfeitResultFor (W2b spec §5.2: a chess forfeit is a core.forfeit now — the room reads it as the engine folds it)", () => {
  const seats = { myEntrantId: "me", opponentEntrantId: "them" } as const;

  it("rulebook rows (FIDE Laws Art. 6.7: an absent player loses by default, 1–0; both absent is 0–0 and no result)", () => {
    expect(forfeitResultFor({ ...seats, by: "them", reason: "walkover", myColour: "white" })).toEqual({ outcome: "won", method: "forfeit", score: "1–0" });
    expect(forfeitResultFor({ ...seats, by: "me", reason: "walkover", myColour: "white" })).toEqual({ outcome: "lost", method: "forfeit", score: "0–1" });
    expect(forfeitResultFor({ ...seats, by: "both", reason: "walkover", myColour: "black" })).toEqual({ outcome: "no_result", method: "double_forfeit", score: "0–0" });
  });

  it("every forfeit reason × who × colour: outcome, method and score are the engine's own fold — and what it refuses, refused", () => {
    const cfg = boardgame.configSchema.parse({});
    const env = (seq: number, type: string, payload: unknown) => ({
      id: `e${seq}`,
      fixtureId: "f",
      seq,
      type,
      payload,
      recordedAt: "2026-10-12T10:00:00.000Z",
      recordedBy: null,
    });
    const kinds = new Set<string>();
    let checked = 0;
    let refused = 0;
    for (const reason of FORFEIT_REASONS) {
      for (const by of ["me", "them", "both"] as const) {
        for (const myColour of ["white", "black"] as const) {
          const white = myColour === "white" ? "me" : "them";
          const black = myColour === "white" ? "them" : "me";
          const lineups = { home: { entrantId: white, slots: [] }, away: { entrantId: black, slots: [] } };
          let state: unknown;
          try {
            state = foldMatch(boardgame, cfg, lineups, [env(0, "core.start", {}), env(1, "core.forfeit", { by, reason })]);
          } catch (err) {
            if (!(err instanceof EngineError)) throw err;
            expect(() => forfeitResultFor({ ...seats, by, reason, myColour }), `${reason} / ${by}: the engine refuses it`).toThrow(EngineError);
            refused += 1;
            continue;
          }
          const o = boardgame.outcome(state as never)!;
          const summary = boardgame.summary(state as never);
          const lines = summary.perSide;
          const want = {
            outcome: ROOM_WORD(o.kind, o.kind === "win" || o.kind === "award" ? o.winner : null),
            method: (summary.detail as { method?: string }).method ?? null,
            score: `${lines.find((l) => l.entrantId === white)!.line}–${lines.find((l) => l.entrantId === black)!.line}`,
          };
          kinds.add(o.kind);
          expect(forfeitResultFor({ ...seats, by, reason, myColour }), `${reason} / ${by} / ${myColour}`).toEqual(want);
          checked += 1;
        }
      }
    }
    expect(checked + refused, "anti-vacuity: reason × who × colour").toBe(FORFEIT_REASONS.length * 6);
    expect(checked, "anti-vacuity: cells the engine folds").toBeGreaterThan(0);
    expect(refused, "anti-vacuity: cells the engine refuses (a double forfeit is a walkover only)").toBeGreaterThan(0);
    expect([...kinds].sort(), "both outcome kinds a forfeit folds to were reached").toEqual(["award", "double_walkover"]);
  });

  it("a forfeit by someone who holds neither seat is not a result this room can state: null", () => {
    expect(forfeitResultFor({ ...seats, by: "someone-else", reason: "walkover", myColour: "white" })).toBeNull();
  });
});

describe("windowWire", () => {
  it("unopened ⇒ no window at all", () => {
    expect(windowWire(null)).toEqual({ opensAt: null, deadline: null });
  });
  it("opened ⇒ windowFor's own instants", () => {
    const at = new Date("2026-10-12T10:00:00Z");
    const w = windowFor(at);
    expect(windowWire(at)).toEqual({ opensAt: w.opensAt.toISOString(), deadline: w.deadline.toISOString() });
  });
});

describe("realtimeExpiry (T10 carry — the subscriber token must outlive a game running past T+20)", () => {
  it("a read made AFTER the deadline still mints a token that expires in the future", () => {
    const opened = new Date("2026-10-12T10:00:00Z");
    const readAt = new Date(opened.getTime() + DEADLINE_AFTER_MS + 5 * 60_000); // 5 min past T+20, mid-game
    const exp = realtimeExpiry(readAt);
    expect(exp.getTime()).toBeGreaterThan(readAt.getTime());
    expect(exp.getTime()).toBeGreaterThan(windowFor(opened).deadline.getTime());
    expect(exp.getTime() - readAt.getTime()).toBe(ROOM_REALTIME_TTL_MS);
  });
});
