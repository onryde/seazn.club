import { describe, expect, it } from "vitest";
import { foldMatch } from "@seazn/engine/core";
import { boardgame, BoardgameMethod } from "@seazn/engine/sports/boardgame";
import {
  ROOM_REALTIME_TTL_MS,
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

describe("resultFor (review I7: the outcome and score are the ENGINE's — T12's boardgame.result, folded)", () => {
  const seats = { myEntrantId: "me", opponentEntrantId: "them" } as const;

  it("rulebook rows (FIDE Laws: a draw is ½–½; a double forfeit is 0–0 and no result — never a draw)", () => {
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

  it("every engine method × winner × colour: outcome and score are what the engine's own fold says", () => {
    // The expected values come from the engine (foldMatch over the boardgame
    // module, its default — FIDE — game scoring), never from room-snapshot.
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
    for (const method of BoardgameMethod.options) {
      for (const winner of [null, "me", "them"] as const) {
        for (const myColour of ["white", "black"] as const) {
          const white = myColour === "white" ? "me" : "them";
          const black = myColour === "white" ? "them" : "me";
          const lineups = { home: { entrantId: white, slots: [] }, away: { entrantId: black, slots: [] } };
          const state = foldMatch(boardgame, cfg, lineups, [env(0, "core.start", {}), env(1, "boardgame.result", { winner, method })]);
          const o = boardgame.outcome(state)!;
          const lines = boardgame.summary(state).perSide;
          const want = {
            outcome: o.kind === "win" ? (o.winner === "me" ? "won" : "lost") : o.kind,
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
    expect(checked, "anti-vacuity: method × winner × colour").toBe(BoardgameMethod.options.length * 6);
    expect([...kinds].sort(), "every outcome kind the room can show was reached").toEqual(["draw", "no_result", "win"]);
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
