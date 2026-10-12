// T14 — the match room driven through its REAL producers (AGENTS.md class 1:
// a seam is proven only through its real producer and consumer). Two players
// take their seats through `claimRoomSeat` with NO injected create, so T9's
// real `createGameIfReady` makes the game; a move goes through
// `actInRoom` → T10's real `act`; both players then read the moved board
// through `readRoom`. Lichess is mocked at the Board API boundary only — every
// default REFUSES, each case scripts the answers it needs.
//
// Expected boards come from chess.js (the rules), never from room.ts.
// Single-sport by construction: online play exists only for `boardgame`.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Chess } from "chess.js";
import { sql } from "@/lib/db";
import type { BoardCall } from "@/server/external-play/types";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { actInRoom, claimRoomSeat, readRoom, type RoomDeps } from "../external-play/room";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const UNEXPECTED: BoardCall = { ok: false, code: "unavailable", raw: "unexpected Board API call" };
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
  submitMove: vi.fn(),
  resignGame: vi.fn(),
  offerOrAcceptDraw: vi.fn(),
  abortGame: vi.fn(),
  readGameStream: vi.fn(),
  exportGame: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/external-play/lichess/board-api")>();
  return { ...real, ...board };
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  for (const f of [board.exportGameMeta, board.submitMove, board.resignGame, board.offerOrAcceptDraw, board.abortGame]) {
    f.mockResolvedValue(UNEXPECTED);
  }
  board.readGameStream.mockResolvedValue({ ok: false, code: "unavailable", raw: "no stream scripted" });
  board.exportGame.mockResolvedValue({ ok: false, code: "unavailable", raw: "no export scripted" });
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// Real clock: check-ins are stamped by the DB's now() and judged against the
// open's window, so the round is opened two minutes ago.
const OPENED = new Date(Date.now() - 2 * 60_000);
const deps = (): RoomDeps => ({ now: new Date(), publish: async () => {}, offered: async () => true, mintRealtime: async () => "rt" });

describe.skipIf(!HAS_DB)("match room through the real producers", () => {
  it("both seats ⇒ T9 creates the game ONCE; a move through act lands on both players' boards", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: OPENED,
      roundOpenedAt: OPENED,
      linked: true,
    });
    const gameId = `gm-${randomUUID().slice(0, 12)}`;
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
    board.acceptChallenge.mockResolvedValue({ ok: true });
    board.submitMove.mockResolvedValue({ ok: true });

    const first = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    expect(first.seat?.seated).toBe(true);
    expect(board.createChallengeToUser, "one seat creates nothing").not.toHaveBeenCalled();

    const second = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(second.create).toEqual({ created: true, gameId });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    expect(second.snapshot.game).toMatchObject({ gameId, moves: [], turn: "white", over: false });
    expect(second.snapshot.creation, "a game on file is no longer being created").toBeNull();

    // White moves through the room (T10's real act, Board API answering 200).
    const white = second.snapshot.you.colour === "white" ? s.away : s.home;
    const black = white === s.home ? s.away : s.home;
    expect(await actInRoom({ kind: "session", userId: white.userId }, s.fixtureId, { kind: "move", uci: "e2e4" }, deps())).toEqual({
      ok: true,
      applied: true,
    });
    expect(board.submitMove).toHaveBeenCalledWith(expect.objectContaining({ gameId, uci: "e2e4" }));

    const rules = new Chess();
    rules.move({ from: "e2", to: "e4" });
    let checked = 0;
    for (const p of [white, black]) {
      const v = await readRoom({ kind: "session", userId: p.userId }, s.fixtureId, deps());
      expect(v.game).toMatchObject({ moves: ["e2e4"], fen: rules.fen(), lastMove: ["e2", "e4"], turn: "black", clockRunning: false });
      checked += 1;
    }
    expect(checked, "anti-vacuity: both players read the board").toBe(2);

    // The SAME player moving again is refused by T10 before Lichess hears it.
    const again = await actInRoom({ kind: "session", userId: white.userId }, s.fixtureId, { kind: "move", uci: "d2d4" }, deps());
    expect(again).toMatchObject({ ok: false });
    expect(board.submitMove).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!HAS_DB)("match room — a game the player ends is written by THAT call (review I5: the real reconcile, no sweep)", () => {
  it("resign through the room ⇒ the room's own reconcile(game_end) reads Lichess and writes the result and the game's end — before any sweep runs", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: OPENED,
      roundOpenedAt: OPENED,
      linked: true,
    });
    const gameId = `gm-${randomUUID().slice(0, 12)}`;
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
    board.acceptChallenge.mockResolvedValue({ ok: true });
    board.submitMove.mockResolvedValue({ ok: true });
    await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, deps());
    const seated = await claimRoomSeat({ kind: "session", userId: s.away.userId }, s.fixtureId, deps());
    expect(seated.create, "premise: T9's real producer made the game").toEqual({ created: true, gameId });
    const white = seated.snapshot.you.colour === "white" ? s.away : s.home;
    const black = white === s.home ? s.away : s.home;
    expect(await actInRoom({ kind: "session", userId: white.userId }, s.fixtureId, { kind: "move", uci: "e2e4" }, deps())).toEqual({ ok: true, applied: true });
    expect(await actInRoom({ kind: "session", userId: black.userId }, s.fixtureId, { kind: "move", uci: "e7e5" }, deps())).toEqual({ ok: true, applied: true });

    const endOf = async () => {
      const [b] = await sql<{ status: string; finished_at: Date | null; game_over_at: Date | null }[]>`
        select status, finished_at, game_over_at from fixture_external_play where fixture_id = ${s.fixtureId}`;
      const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
      const results = await sql`select 1 from score_events where fixture_id = ${s.fixtureId} and type = 'boardgame.result'`;
      return { bridge: b!, fixture: fx!.status, results: results.length };
    };
    const before = await endOf();
    expect([before.bridge.status, before.bridge.finished_at, before.bridge.game_over_at, before.results], "premise: a live game, nothing ended").toEqual([
      "live",
      null,
      null,
      0,
    ]);

    // Lichess: White's resignation is accepted, and the export says so.
    board.resignGame.mockResolvedValue({ ok: true });
    board.exportGame.mockResolvedValue({
      gameId,
      status: "resign",
      winner: "black",
      movesSan: ["e4", "e5"],
      whiteMs: 590_000,
      blackMs: 592_000,
      increment: 5,
    });
    // NO injected reconcile: deps() carries none, so actInRoom calls the real one.
    expect(deps().reconcile, "premise: the real reconcile is the one called").toBeUndefined();
    const out = await actInRoom({ kind: "session", userId: white.userId }, s.fixtureId, { kind: "resign" }, deps());
    expect(out).toEqual({ ok: true, applied: true });
    expect(board.resignGame).toHaveBeenCalledWith(expect.objectContaining({ gameId }));
    expect(board.exportGame, "that call's reconcile read Lichess").toHaveBeenCalledWith(gameId);

    const after = await endOf();
    expect(after.bridge.status).toBe("finished");
    expect(after.bridge.finished_at, "finished_at written by the act's own reconcile").not.toBeNull();
    expect(after.results, "the result is on the ledger, once").toBe(1);
    expect(after.fixture).toBe("decided");
    // And the room says so to both players, with no sweep in between.
    expect((await readRoom({ kind: "session", userId: white.userId }, s.fixtureId, deps())).result).toMatchObject({ outcome: "lost", method: "resign", score: "0–1" });
    expect((await readRoom({ kind: "session", userId: black.userId }, s.fixtureId, deps())).result).toMatchObject({ outcome: "won", score: "0–1" });
  });
});
