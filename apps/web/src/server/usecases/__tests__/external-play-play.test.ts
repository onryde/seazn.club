// The play loop (chess in-page board design §3.4, Task 10). DB-backed blocks
// guard on DATABASE_URL; the pure blocks always run.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`), so the one other-sport case below is
// the guard's refusal, not a second play path.
//
// Every game a move is played on here is created by T9's REAL producer
// (`createGameIfReady`, Board API module-mocked at its boundary), so it
// starts as the 'ready' row production writes — never an SQL-seeded 'live'
// one (Task 8 re-review, binding). Rows edited by SQL are labelled with the
// writer they stand for and make no claim about T10.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Chess } from "chess.js";
import fc from "fast-check";
import { sql } from "@/lib/db";
import type { RoomBroadcast } from "@/lib/realtime";
import { appendEvent } from "@/server/engine-db";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import type { BoardCall } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady } from "../external-play/create-game";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../external-play/guard";
import { act, fenAfter, type PlayAction, type PlayDeps, type PlayResult } from "../external-play/play";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg, seedFutureDivision } from "./_seed";
import { seedOnlineChessFixture, seedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// The Board API is module-mocked: T9's creation consumes it, and the module
// boundary IS the seam. T10's own calls are injected per case through
// PlayDeps, so every default below REFUSES — a case that reaches Lichess
// without saying what Lichess answers fails loudly.
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
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");
/** `s` seconds after NOW. */
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
// 5+3 is in SHIP1_TIME_CONTROLS; `base` is seconds (mapBoardgameClockToLichess).
const BASE_S = 300;
const INC_S = 3;

const freshGameId = () => `gm-${randomUUID().slice(0, 12)}`;
/** The token the seed helper seals for a linked player (_external-play-seed.ts
 *  `seedPlayer`), opened by the REAL getLichessAccessToken in every case that
 *  does not inject one. */
const tokenOf = (p: { lichessId: string }) => `lio_seed_${p.lichessId}`;

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue(UNEXPECTED);
  board.submitMove.mockResolvedValue(UNEXPECTED);
  board.resignGame.mockResolvedValue(UNEXPECTED);
  board.offerOrAcceptDraw.mockResolvedValue(UNEXPECTED);
  board.abortGame.mockResolvedValue(UNEXPECTED);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const seed = () =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: BASE_S, increment: INC_S },
  });

type Ledger = {
  status: string;
  white_side: string | null;
  moves_uci: string[];
  move_count: number;
  started_at: Date | null;
  last_move_at: Date | null;
  white_ms: number | null;
  black_ms: number | null;
  clock_increment_s: number | null;
  draw_offer_by: string | null;
  white_draw_offer_ply: number | null;
  black_draw_offer_ply: number | null;
};
async function ledger(fixtureId: string): Promise<Ledger> {
  const [row] = await sql<Ledger[]>`
    select status, white_side, moves_uci, move_count, started_at, last_move_at, white_ms, black_ms,
           clock_increment_s, draw_offer_by, white_draw_offer_ply, black_draw_offer_ply
      from fixture_external_play where fixture_id = ${fixtureId}`;
  if (!row) throw new Error(`no bridge row for ${fixtureId}`);
  return row;
}

type Player = { entrantId: string; personId: string; userId: string; lichessId: string };
type Game = Awaited<ReturnType<typeof seed>> & { gameId: string; white: Player; black: Player };

/** A game as T9's real producer leaves it: 'ready', no moves, no clocks. */
async function readyGame(over: { whiteAway?: boolean } = {}): Promise<Game> {
  const s = await seed();
  if (over.whiteAway) {
    await appendEvent(s.orgId, s.fixtureId, 0, { type: "boardgame.pairing", payload: { white: s.away.entrantId } });
  }
  const gameId = freshGameId();
  // Per game, not per case: the property below creates dozens in one case,
  // and T4's per-IP budget would throttle them.
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  const out = await createGameIfReady(s.fixtureId, { now: NOW, publish: async () => {} });
  expect(out, "premise: T9's REAL producer created the game").toEqual({ created: true, gameId });
  expect(await ledger(s.fixtureId), "premise: T9 leaves 'ready' — created, never started").toMatchObject({
    status: "ready",
    white_side: over.whiteAway ? "away" : "home",
    moves_uci: [],
    move_count: 0,
    started_at: null,
    white_ms: null,
    black_ms: null,
  });
  return over.whiteAway ? { ...s, gameId, white: s.away, black: s.home } : { ...s, gameId, white: s.home, black: s.away };
}

type Call = { kind: "move" | "resign" | "draw" | "abort"; token: string; gameId: string; uci?: string; accept?: boolean };

/** Stands in for Lichess at T10's seam: records every call (with the token
 *  it carried) and answers what the case says. Records every broadcast. */
function boardStub(answer: (c: Call) => BoardCall | Promise<BoardCall> = () => ({ ok: true })) {
  const calls: Call[] = [];
  const sent: { fixtureId: string; body: RoomBroadcast }[] = [];
  const hit = async (c: Call) => {
    calls.push(c);
    return answer(c);
  };
  const deps: PlayDeps = {
    submitMove: (x) => hit({ kind: "move", token: x.token, gameId: x.gameId, uci: x.uci }),
    resignGame: (x) => hit({ kind: "resign", token: x.token, gameId: x.gameId }),
    offerOrAcceptDraw: (x) => hit({ kind: "draw", token: x.token, gameId: x.gameId, accept: x.accept }),
    abortGame: (x) => hit({ kind: "abort", token: x.token, gameId: x.gameId }),
    publish: async (fixtureId, body) => {
      sent.push({ fixtureId, body });
    },
  };
  return { calls, sent, deps };
}

const by = (g: Game, who: "white" | "black", action: PlayAction, deps: PlayDeps, now?: Date) =>
  act({ fixtureId: g.fixtureId, personId: g[who].personId, action }, now ? { ...deps, now } : deps);
const mv = (g: Game, who: "white" | "black", uci: string, deps: PlayDeps, now?: Date) =>
  by(g, who, { kind: "move", uci }, deps, now);

/** Plays `ucis` alternately from the current ply; each must be applied. */
async function playOut(g: Game, ucis: string[], deps: PlayDeps, startPly = 0): Promise<void> {
  let ply = startPly;
  for (const uci of ucis) {
    const who = ply % 2 === 0 ? "white" : "black";
    expect(await mv(g, who, uci, deps), `ply ${ply} ${uci}`).toEqual({ ok: true, applied: true });
    ply++;
  }
}

const APPLIED: PlayResult = { ok: true, applied: true };
const ABSORBED: PlayResult = { ok: true, applied: false };
const reconcile = (reason: string) => ({ ok: false, reconcile: true, reason });
const NOT_FOUND = { status: 404, code: "NOT_FOUND" };

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

describe.runIf(HAS_DB)("act — the first move, from T9's real 'ready' row", () => {
  it("White's first move is submitted with WHITE's token and flips ready → live in the same write", async () => {
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    expect(await mv(g, "white", "e2e4", deps, at(0))).toEqual(APPLIED);
    expect(calls).toEqual([{ kind: "move", token: tokenOf(g.white), gameId: g.gameId, uci: "e2e4" }]);
    expect(await ledger(g.fixtureId)).toMatchObject({
      status: "live",
      moves_uci: ["e2e4"],
      move_count: 1,
      started_at: at(0),
      last_move_at: at(0),
      // Seeded from the division clock on the first move; the first two
      // plies cost nothing (scalachess: the clock runs once both have moved).
      white_ms: BASE_S * 1000,
      black_ms: BASE_S * 1000,
      clock_increment_s: INC_S,
      draw_offer_by: null,
    });
    expect(sent.length).toBe(1);
  });

  it("the guard REVIVES the ledger for its readers (T11, T14): an array, numbers, and last_move_at as a Date", async () => {
    // to_jsonb(ep) carries timestamps as ISO strings; reviveBridge parses
    // them back. T10 itself reads the row in SQL, so this pins the seam.
    const g = await readyGame();
    const { deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(0));
    await by(g, "black", { kind: "draw", accept: true }, deps); // ply 1: no offer, nothing written
    const b = (await loadOnlinePlayFixture(g.fixtureId))!.bridge!;
    expect(b.last_move_at).toBeInstanceOf(Date);
    expect(b).toMatchObject({
      status: "live",
      moves_uci: ["e2e4"],
      move_count: 1,
      last_move_at: at(0),
      white_ms: BASE_S * 1000,
      black_ms: BASE_S * 1000,
      clock_increment_s: INC_S,
      draw_offer_by: null,
      white_draw_offer_ply: null,
      black_draw_offer_ply: null,
    });
  });

  it("started_at is stamped ONCE — the second move leaves it at the first move's time", async () => {
    const g = await readyGame();
    const { deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(0));
    expect(await mv(g, "black", "e7e5", deps, at(9))).toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ started_at: at(0), last_move_at: at(9), move_count: 2 });
  });

  it("Black moving FIRST is refused without a Lichess call, and the row stays 'ready' (T13: never started)", async () => {
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    expect(await mv(g, "black", "e7e5", deps)).toEqual(reconcile("not_your_turn_or_over"));
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "ready", move_count: 0, started_at: null });
  });

  it("a 5xx on the first move writes NOTHING (it may have played) — the row stays 'ready' — and a retry is forwarded", async () => {
    const g = await readyGame();
    let n = 0;
    const { calls, sent, deps } = boardStub(() =>
      ++n === 1 ? { ok: false, code: "unavailable", raw: "502" } : { ok: true },
    );
    expect(await mv(g, "white", "e2e4", deps, at(0))).toEqual(reconcile("unavailable"));
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "ready", moves_uci: [], move_count: 0, started_at: null });
    expect(sent, "nothing to broadcast").toEqual([]);
    // Not latched as "not played", nor as "played": the retry goes to Lichess.
    expect(await mv(g, "white", "e2e4", deps, at(4))).toEqual(APPLIED);
    expect(calls.map((c) => c.uci)).toEqual(["e2e4", "e2e4"]);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "live", moves_uci: ["e2e4"], started_at: at(4) });
  });
});

describe.runIf(HAS_DB)("act — the order of the checks (shape, game, caller, grant, account)", () => {
  it("a malformed UCI throws 400 BEFORE anything is read — even for a fixture that does not exist", async () => {
    const { calls, deps } = boardStub();
    const tokenReads: string[] = [];
    const withSpy: PlayDeps = { ...deps, accessToken: async (u) => (tokenReads.push(u), "tok") };
    // M5: Lichess would truncate this to e7e6 and play it.
    await expect(
      act({ fixtureId: randomUUID(), personId: randomUUID(), action: { kind: "move", uci: "e7e6xx" } }, withSpy),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
    // The same string on a REAL game the caller plays: still 400, and still
    // nothing sent — the call-count half is what catches a late check.
    const g = await readyGame();
    await expect(mv(g, "white", "e7e6xx", withSpy)).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
    expect(calls).toEqual([]);
    expect(tokenReads).toEqual([]);
  });

  it("an unknown fixture, and a person who plays on neither side, both get the SAME 404 — no token read", async () => {
    const g = await readyGame();
    const outsider = await seedPlayer(g.orgId, "Spectator", `o-${randomUUID().slice(0, 8)}`, true);
    const { calls, deps } = boardStub();
    const tokenReads: string[] = [];
    const withSpy: PlayDeps = { ...deps, accessToken: async (u) => (tokenReads.push(u), "tok") };
    await expect(
      act({ fixtureId: randomUUID(), personId: g.white.personId, action: { kind: "move", uci: "e2e4" } }, withSpy),
    ).rejects.toMatchObject(NOT_FOUND);
    let checked = 0;
    for (const action of [
      { kind: "move", uci: "e2e4" },
      { kind: "resign" },
      { kind: "draw", accept: true },
      { kind: "abort" },
    ] as PlayAction[]) {
      await expect(act({ fixtureId: g.fixtureId, personId: outsider.personId, action }, withSpy), action.kind)
        .rejects.toMatchObject(NOT_FOUND);
      checked++;
    }
    expect(checked, "anti-vacuity: every action kind").toBe(4);
    expect(calls).toEqual([]);
    expect(tokenReads).toEqual([]);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "ready", move_count: 0 });
  });

  it("no game yet — no bridge row, then a 'pending' one from the REAL ensureBridgeRow — ⇒ 404", async () => {
    const s = await seed();
    const { calls, deps } = boardStub();
    const tryMove = () =>
      act({ fixtureId: s.fixtureId, personId: s.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
    await expect(tryMove(), "no bridge row at all").rejects.toMatchObject(NOT_FOUND);
    const f = await loadOnlinePlayFixture(s.fixtureId);
    await ensureBridgeRow(f!);
    expect((await ledger(s.fixtureId)).status, "premise: a pending row, no game").toBe("pending");
    await expect(tryMove(), "pending").rejects.toMatchObject(NOT_FOUND);
    expect(calls).toEqual([]);
  });

  it("'finished' and 'needs_organiser' accept NO action of any kind ⇒ 404, nothing sent", async () => {
    // SQL-set states: 'finished' stands for T11's reconcile, needs_organiser
    // for a hold (T9/T13). No claim about T10, which writes neither.
    let checked = 0;
    for (const state of [
      sql`status = 'finished', finished_at = now()`,
      sql`status = 'needs_organiser', needs_reason = 'mismatch'`,
    ]) {
      const g = await readyGame();
      const { deps: d0 } = boardStub();
      await playOut(g, ["e2e4", "e7e5"], d0);
      await sql`update fixture_external_play set ${state} where fixture_id = ${g.fixtureId}`;
      const { calls, sent, deps } = boardStub();
      for (const action of [
        { kind: "move", uci: "g1f3" },
        { kind: "resign" },
        { kind: "draw", accept: true },
        { kind: "draw", accept: false },
        { kind: "abort" },
      ] as PlayAction[]) {
        await expect(by(g, "white", action, deps), action.kind).rejects.toMatchObject(NOT_FOUND);
        checked++;
      }
      expect(calls).toEqual([]);
      expect(sent).toEqual([]);
      expect((await ledger(g.fixtureId)).moves_uci, "the ledger did not move").toEqual(["e2e4", "e7e5"]);
    }
    expect(checked, "anti-vacuity: 2 states × 5 actions").toBe(10);
  });

  it("a WITHDRAWAL mid-game (the real cascade leaves the board abandoned) ⇒ 404", async () => {
    const g = await readyGame();
    const { deps: d0 } = boardStub();
    await playOut(g, ["e2e4"], d0);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${g.fixtureId}`;
    expect(fx?.status, "premise: the league expunge path abandoned the board").toBe("abandoned");
    const { calls, deps } = boardStub();
    await expect(mv(g, "black", "e7e5", deps)).rejects.toMatchObject(NOT_FOUND);
    expect(calls).toEqual([]);
  });

  it("another sport — a non-boardgame fixture with onlinePlay forced into its config — ⇒ 404", async () => {
    // One case, not a sweep: the guard is the only place a sport enters, and
    // it admits boardgame alone (guard.ts). Built as the guard suite builds it.
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedFutureDivision(auth);
    await sql`
      update divisions
         set config = config || '{"onlinePlay":"lichess","clock":{"base":300,"increment":3}}'::jsonb
       where id = ${division.id}`;
    await startDivision(auth, division.id);
    const [fixture] = fixtures;
    if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
    const { calls, deps } = boardStub();
    await expect(
      act({ fixtureId: fixture.id, personId: randomUUID(), action: { kind: "move", uci: "e2e4" } }, deps),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(calls).toEqual([]);
  });

  it("a game on file WITHOUT recorded colours is a broken row: 404 and an error logged, never a guessed colour", async () => {
    // SQL-damaged: T9 writes white_side with the game id in one update, so
    // this stands for no writer. The guard is what it reaches.
    const g = await readyGame();
    await sql`update fixture_external_play set white_side = null where fixture_id = ${g.fixtureId}`;
    const errors = vi.spyOn(log, "error");
    try {
      const { calls, deps } = boardStub();
      await expect(mv(g, "white", "e2e4", deps)).rejects.toMatchObject(NOT_FOUND);
      expect(calls).toEqual([]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureId: g.fixtureId, gameId: g.gameId }),
        expect.stringMatching(/no recorded colours/),
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("a 'ready' row with NO game id is a broken row ⇒ 404, nothing sent", async () => {
    // SQL-damaged: T9 sets status and challenge_id in one update.
    const g = await readyGame();
    await sql`update fixture_external_play set challenge_id = null where fixture_id = ${g.fixtureId}`;
    const { calls, deps } = boardStub();
    await expect(mv(g, "white", "e2e4", deps)).rejects.toMatchObject(NOT_FOUND);
    expect(calls).toEqual([]);
  });

  it("colour is the RECORDED one: a pairing card swapping colours AFTER creation moves nothing", async () => {
    const g = await readyGame({ whiteAway: true });
    expect(g.white.entrantId, "premise: away is White").toBe(g.away.entrantId);
    // A later card making HOME White. The game at Lichess was created the
    // other way round, so the record — not the fold — says who moves.
    await appendEvent(g.orgId, g.fixtureId, 1, { type: "boardgame.pairing", payload: { white: g.home.entrantId } });
    const { calls, deps } = boardStub();
    expect(
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps),
      "home is BLACK in the game on file",
    ).toEqual(reconcile("not_your_turn_or_over"));
    expect(
      await act({ fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "move", uci: "e2e4" } }, deps),
    ).toEqual(APPLIED);
    expect(calls).toEqual([{ kind: "move", token: tokenOf(g.away), gameId: g.gameId, uci: "e2e4" }]);
  });

  it("a grant DOWNGRADED mid-game ⇒ lichess_reconsent_required, named — no token read, nothing sent", async () => {
    const g = await readyGame();
    const { deps: d0 } = boardStub();
    await playOut(g, ["e2e4", "e7e5"], d0);
    await sql`
      update user_external_accounts set scopes = array_remove(scopes, 'board:play')
       where user_id = ${g.white.userId} and provider = 'lichess'`;
    const { calls, deps } = boardStub();
    const tokenReads: string[] = [];
    const withSpy: PlayDeps = { ...deps, accessToken: async (u) => (tokenReads.push(u), "tok") };
    let checked = 0;
    for (const action of [
      { kind: "move", uci: "g1f3" },
      { kind: "resign" },
      { kind: "draw", accept: true },
      { kind: "abort" },
    ] as PlayAction[]) {
      expect(await by(g, "white", action, withSpy), action.kind).toEqual({
        ok: false,
        reconcile: false,
        reason: "lichess_reconsent_required",
      });
      checked++;
    }
    expect(checked).toBe(4);
    expect(calls).toEqual([]);
    expect(tokenReads).toEqual([]);
    // The opponent's grant is untouched: Black still plays.
    expect(await mv(g, "black", "g8f6", deps), "a refusal is per player").toEqual(reconcile("not_your_turn_or_over"));
  });

  it("an UNLINK mid-game ⇒ lichess_link_required", async () => {
    const g = await readyGame();
    await sql`delete from user_external_accounts where user_id = ${g.white.userId} and provider = 'lichess'`;
    const { calls, deps } = boardStub();
    expect(await mv(g, "white", "e2e4", deps)).toEqual({ ok: false, reconcile: false, reason: "lichess_link_required" });
    expect(calls).toEqual([]);
  });

  it("a player RE-LINKED to a different Lichess account cannot move the game with it ⇒ 404", async () => {
    // The grant is complete, so this is the recorded-account check alone.
    const g = await readyGame();
    await sql`
      update user_external_accounts set external_user_id = ${`x-${randomUUID().slice(0, 8)}`}
       where user_id = ${g.white.userId} and provider = 'lichess'`;
    const { calls, deps } = boardStub();
    await expect(mv(g, "white", "e2e4", deps)).rejects.toMatchObject(NOT_FOUND);
    expect(calls).toEqual([]);
  });

  it("a stored token that cannot be opened ⇒ the 503 PROPAGATES; nothing is sent or written", async () => {
    const g = await readyGame();
    await sql`
      update user_external_accounts set access_token_enc = ${Buffer.from("not-a-sealed-token")}
       where user_id = ${g.white.userId} and provider = 'lichess'`;
    const { calls, deps } = boardStub();
    await expect(mv(g, "white", "e2e4", deps)).rejects.toMatchObject({ status: 503, code: "LICHESS_TOKEN_UNAVAILABLE" });
    expect(calls).toEqual([]);
    expect((await ledger(g.fixtureId)).move_count).toBe(0);
  });

  it("a token that comes back ABSENT (an unlink landing after the grant check) ⇒ lichess_link_required, nothing sent", async () => {
    const g = await readyGame();
    const { calls, deps } = boardStub();
    const absent: PlayDeps = { ...deps, accessToken: async () => null };
    let checked = 0;
    for (const action of [
      { kind: "move", uci: "e2e4" },
      { kind: "resign" },
      { kind: "draw", accept: true },
      { kind: "abort" },
    ] as PlayAction[]) {
      expect(await by(g, "white", action, absent), action.kind).toEqual({
        ok: false,
        reconcile: false,
        reason: "lichess_link_required",
      });
      checked++;
    }
    expect(checked).toBe(4);
    expect(calls).toEqual([]);
  });
});

describe.runIf(HAS_DB)("act — turn, absorb and races (Review Focus 2)", () => {
  it("a second move by the SAME player before the reply is refused as out of turn — one Lichess call", async () => {
    const g = await readyGame();
    const { calls, deps } = boardStub();
    await mv(g, "white", "e2e4", deps);
    expect(await mv(g, "white", "d2d4", deps), "not our turn any more ⇒ reconcile, never a silent absorb")
      .toEqual(reconcile("not_your_turn_or_over"));
    expect(calls.length).toBe(1);
  });

  it("the SAME move submitted twice is ABSORBED: ok, applied:false, one Lichess call, one move on file, one broadcast", async () => {
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    expect(await mv(g, "white", "e2e4", deps)).toEqual(APPLIED);
    expect(await mv(g, "white", "e2e4", deps), "absorbed — NOT an error the player sees").toEqual(ABSORBED);
    expect(calls.length, "the duplicate never reached Lichess").toBe(1);
    expect(sent.length, "no state changed ⇒ nothing broadcast").toBe(1);
    expect(await ledger(g.fixtureId)).toMatchObject({ moves_uci: ["e2e4"], move_count: 1 });
  });

  it("the absorb does not LATCH: play, duplicate, reply, then the same player's NEXT move plays", async () => {
    const g = await readyGame();
    const { calls, deps } = boardStub();
    await mv(g, "white", "e2e4", deps);
    await mv(g, "white", "e2e4", deps);
    await mv(g, "black", "e7e5", deps);
    expect(await mv(g, "white", "g1f3", deps), "a real third move, not a duplicate").toEqual(APPLIED);
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4", "e7e5", "g1f3"]);
    expect(calls.map((c) => c.uci)).toEqual(["e2e4", "e7e5", "g1f3"]);
  });

  it("the OPPONENT sending the string of the last move on file is NOT absorbed — it is their own move, and Lichess judges it", async () => {
    // The differential for the absorb's turn condition: on Black's turn, the
    // last move on file is White's, so equal strings are not a duplicate.
    const g = await readyGame();
    const { calls, deps } = boardStub((c) =>
      c.token === tokenOf(g.black) ? { ok: false, code: "unavailable", raw: "400 illegal" } : { ok: true },
    );
    await mv(g, "white", "e2e4", deps);
    expect(await mv(g, "black", "e2e4", deps)).toEqual(reconcile("unavailable"));
    expect(calls.map((c) => c.token)).toEqual([tokenOf(g.white), tokenOf(g.black)]);
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4"]);
  });

  it("two SIMULTANEOUS submissions of the same move, both accepted, append exactly ONCE (staged: both read ply 0 first)", async () => {
    const g = await readyGame();
    let arrived = 0;
    let release!: () => void;
    const bothIn = new Promise<void>((r) => (release = r));
    const { calls, sent, deps } = boardStub(async () => {
      if (++arrived === 2) release();
      await bothIn; // neither returns until both have read the ledger and called
      return { ok: true };
    });
    const results = await Promise.all([mv(g, "white", "e2e4", deps), mv(g, "white", "e2e4", deps)]);
    expect(calls.length, "premise: both reached the seam with the same stale ply").toBe(2);
    expect(results.filter((r) => r.ok && r.applied).length, "one winner").toBe(1);
    expect(results.filter((r) => r.ok && !r.applied).length, "one absorbed — never two appends").toBe(1);
    expect(await ledger(g.fixtureId)).toMatchObject({ moves_uci: ["e2e4"], move_count: 1 });
    expect(sent.length).toBe(1);
  });

  it("twin tabs, same move, Lichess accepting one and refusing the other AFTER it is recorded ⇒ the refused tab is absorbed", async () => {
    const g = await readyGame();
    const { deps, refusedTab } = twinTabs(g, "e2e4", "e2e4");
    const results = await Promise.all([mv(g, "white", "e2e4", deps), mv(g, "white", "e2e4", deps)]);
    expect(refusedTab()).toBe(true);
    expect(results.sort((a, b) => Number(b.ok && b.applied) - Number(a.ok && a.applied))).toEqual([APPLIED, ABSORBED]);
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4"]);
  });

  it("twin tabs, DIFFERENT moves at one ply: the refused one is NOT absorbed — it reconciles", async () => {
    const g = await readyGame();
    const { deps, refusedTab } = twinTabs(g, "e2e4", "d2d4");
    const [a, b] = await Promise.all([mv(g, "white", "e2e4", deps), mv(g, "white", "d2d4", deps)]);
    expect(refusedTab()).toBe(true);
    expect(a).toEqual(APPLIED);
    expect(b).toEqual(reconcile("not_your_turn_or_over"));
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4"]);
  });

  it("twin tabs, same move, the other tab's call answering a 5xx AFTER the move is on file ⇒ still reconcile — only M6's refusal is read as 'a twin won'", async () => {
    const g = await readyGame();
    const { deps, refusedTab } = twinTabs(g, "e2e4", "e2e4", { ok: false, code: "unavailable", raw: "502" });
    const results = await Promise.all([mv(g, "white", "e2e4", deps), mv(g, "white", "e2e4", deps)]);
    expect(refusedTab()).toBe(true);
    expect(results.filter((r) => r.ok && r.applied).length).toBe(1);
    expect(results.filter((r) => !r.ok)).toEqual([reconcile("unavailable")]);
  });

  it("Lichess accepts, then the append finds a DIFFERENT game on the row (an organiser re-create) ⇒ nothing written onto it", async () => {
    // SQL-set, standing for T16's re-create: the row now names another game.
    const g = await readyGame();
    const replacement = freshGameId();
    const warns = vi.spyOn(log, "warn");
    try {
      const { sent, deps } = boardStub(async () => {
        await sql`update fixture_external_play set challenge_id = ${replacement} where fixture_id = ${g.fixtureId}`;
        return { ok: true };
      });
      expect(await mv(g, "white", "e2e4", deps)).toEqual(ABSORBED);
      expect(await ledger(g.fixtureId), "the new game's ledger is untouched").toMatchObject({ moves_uci: [], move_count: 0, status: "ready" });
      expect(sent).toEqual([]);
      expect(warns).toHaveBeenCalledWith(expect.objectContaining({ gameId: g.gameId, ply: 0 }), expect.stringMatching(/could not record/));
    } finally {
      warns.mockRestore();
    }
  });

  it("Lichess accepts, then the append finds the row moved on by reconcile WITH our move ⇒ absorbed, no warning, no broadcast", async () => {
    const g = await readyGame();
    const warns = vi.spyOn(log, "warn");
    try {
      const { sent, deps } = boardStub(async () => {
        // T11-shaped: the game ended on this very move and reconcile adopted
        // the stream's moves before our append ran.
        await sql`
          update fixture_external_play
             set status = 'finished', finished_at = now(), moves_uci = '["e2e4"]'::jsonb, move_count = 1
           where fixture_id = ${g.fixtureId}`;
        return { ok: true };
      });
      expect(await mv(g, "white", "e2e4", deps)).toEqual(ABSORBED);
      expect(sent).toEqual([]);
      expect(warns).not.toHaveBeenCalled();
      expect(await ledger(g.fixtureId)).toMatchObject({ status: "finished", moves_uci: ["e2e4"] });
    } finally {
      warns.mockRestore();
    }
  });

  it("Lichess accepts, then the append finds the board HELD without our move ⇒ ok, nothing written, a warning, no broadcast", async () => {
    const g = await readyGame();
    const warns = vi.spyOn(log, "warn");
    try {
      const { sent, deps } = boardStub(async () => {
        await sql`
          update fixture_external_play set status = 'needs_organiser', needs_reason = 'mismatch'
           where fixture_id = ${g.fixtureId}`;
        return { ok: true };
      });
      // ok: Lichess did play it — never reported as not played.
      expect(await mv(g, "white", "e2e4", deps)).toEqual(ABSORBED);
      expect(sent).toEqual([]);
      expect(warns).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureId: g.fixtureId, gameId: g.gameId, ply: 0 }),
        expect.stringMatching(/could not record/),
      );
      expect(await ledger(g.fixtureId)).toMatchObject({ status: "needs_organiser", move_count: 0 });
    } finally {
      warns.mockRestore();
    }
  });
});

/** Two tabs of one player racing at the same ply. Both are held until both
 *  have read the ledger and called; then Lichess accepts `winner` and
 *  answers the other tab's call (M6's 400) only once the winner's move is ON
 *  FILE — the order that makes the loser's re-read meaningful. */
function twinTabs(
  g: Game,
  winner: string,
  loser: string,
  loserAnswer: BoardCall = { ok: false, code: "not_your_turn_or_over", raw: "Not your turn, or game already over" },
) {
  let arrived = 0;
  let release!: () => void;
  const bothIn = new Promise<void>((r) => (release = r));
  let refused = false;
  let winnerAnswered = false;
  const stub = boardStub(async (c) => {
    if (++arrived === 2) release();
    await bothIn;
    if (c.uci === winner && !winnerAnswered) {
      winnerAnswered = true;
      return { ok: true };
    }
    expect(c.uci).toBe(loser);
    for (let i = 0; i < 200; i++) {
      if ((await ledger(g.fixtureId)).move_count === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await ledger(g.fixtureId)).moves_uci, "premise: the winner is recorded first").toEqual([winner]);
    refused = true;
    return loserAnswer;
  });
  return { deps: stub.deps, refusedTab: () => refused };
}

describe.runIf(HAS_DB)("act — Lichess refusals (nothing is written, nothing broadcast)", () => {
  it("each refusal code passes through UNCHANGED as reconcile:<code> — no branch collapses two", async () => {
    const codes = ["unauthorized", "unplayable_time_control", "rate_limited", "unavailable", "not_your_turn_or_over"] as const;
    const g = await readyGame();
    let checked = 0;
    for (const code of codes) {
      const { calls, sent, deps } = boardStub(() => ({ ok: false, code, raw: code }));
      expect(await mv(g, "white", "e2e4", deps), code).toEqual(reconcile(code));
      expect(calls.length).toBe(1);
      expect(sent).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every BoardErrorCode").toBe(codes.length);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "ready", move_count: 0 });
  });

  it("an ILLEGAL move (Lichess's 4xx, classified unavailable) records nothing, and the player's next legal move plays", async () => {
    const g = await readyGame();
    const { calls, deps } = boardStub((c) =>
      c.uci === "e2e5" ? { ok: false, code: "unavailable", raw: "400 Piece on e2 cannot move to e5" } : { ok: true },
    );
    expect(await mv(g, "white", "e2e5", deps)).toEqual(reconcile("unavailable"));
    expect(await mv(g, "white", "e2e4", deps)).toEqual(APPLIED);
    expect(calls.map((c) => c.uci)).toEqual(["e2e5", "e2e4"]);
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4"]);
  });
});

describe.runIf(HAS_DB)("act — resign, abort and draw are forwarded; T10 never writes 'finished' (ruling Q2)", () => {
  it("resign reaches the Board API with the CALLER's token, answers ok, writes nothing and broadcasts nothing", async () => {
    let checked = 0;
    for (const who of ["white", "black"] as const) {
      const g = await readyGame();
      const { deps: d0 } = boardStub();
      await playOut(g, ["e2e4", "e7e5"], d0);
      const before = await ledger(g.fixtureId);
      const { calls, sent, deps } = boardStub();
      expect(await by(g, who, { kind: "resign" }, deps)).toEqual(APPLIED);
      expect(calls).toEqual([{ kind: "resign", token: tokenOf(g[who]), gameId: g.gameId }]);
      expect(sent).toEqual([]);
      expect(await ledger(g.fixtureId), "the row stays live — the END is reconcile's").toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a move AFTER a resign gets Lichess's 400 and is answered reconcile — the ledger never grows", async () => {
    const g = await readyGame();
    let resigned = false;
    const { deps } = boardStub((c) => {
      if (c.kind === "resign") {
        resigned = true;
        return { ok: true };
      }
      // lila MovePlayer: a move on a finished game is "Not your turn, or
      // game already over" (M6), classified not_your_turn_or_over.
      return resigned ? { ok: false, code: "not_your_turn_or_over", raw: "Not your turn, or game already over" } : { ok: true };
    });
    await playOut(g, ["e2e4", "e7e5"], deps);
    expect(await by(g, "black", { kind: "resign" }, deps)).toEqual(APPLIED);
    expect(await mv(g, "white", "g1f3", deps)).toEqual(reconcile("not_your_turn_or_over"));
    expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e4", "e7e5"]);
  });

  it("abort at ply 0 is forwarded with the caller's token and the row stays 'ready'", async () => {
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    expect(await by(g, "black", { kind: "abort" }, deps)).toEqual(APPLIED);
    expect(calls).toEqual([{ kind: "abort", token: tokenOf(g.black), gameId: g.gameId }]);
    expect(sent).toEqual([]);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "ready", move_count: 0 });
  });

  it("abort REFUSED by Lichess (ply ≥ 2: 'can no longer be aborted', a 400 classified unavailable) ⇒ reconcile", async () => {
    const g = await readyGame();
    const { deps } = boardStub((c) =>
      c.kind === "abort" ? { ok: false, code: "unavailable", raw: "This game can no longer be aborted" } : { ok: true },
    );
    await playOut(g, ["e2e4", "e7e5"], deps);
    expect(await by(g, "white", { kind: "abort" }, deps)).toEqual(reconcile("unavailable"));
  });

  it("resign and abort REFUSED (401) pass the code through", async () => {
    const g = await readyGame();
    const { deps } = boardStub(() => ({ ok: false, code: "unauthorized", raw: "401" }));
    expect(await by(g, "white", { kind: "resign" }, deps)).toEqual(reconcile("unauthorized"));
    expect(await by(g, "white", { kind: "abort" }, deps)).toEqual(reconcile("unauthorized"));
  });
});

// The draw transition table (ruling Q1). lila source, not measured — live
// measurement owed (T17): Drawer.scala yes/no, Game.scala
// playerCanOfferDraw, MovePlayer.scala:77. Every Lichess answer below is
// 200 — PlayApi answers setDraw with 200 in every case — so these assert
// what OUR ledger makes of it.
describe.runIf(HAS_DB)("act — draw offers, as lila holds them", () => {
  /** A game at ply 2 (White to move), every call accepted. */
  async function atPly2() {
    const g = await readyGame();
    const stub = boardStub();
    await playOut(g, ["e2e4", "e7e5"], stub.deps, 0);
    stub.calls.length = 0;
    stub.sent.length = 0;
    return { g, ...stub };
  }
  const yes = { kind: "draw", accept: true } as const;
  const no = { kind: "draw", accept: false } as const;

  it("YES with no offer standing, at ply ≥ 2 ⇒ an offer by the caller, at this ply, broadcast", async () => {
    const { g, calls, sent, deps } = await atPly2();
    expect(await by(g, "white", yes, deps)).toEqual(APPLIED);
    expect(calls).toEqual([{ kind: "draw", token: tokenOf(g.white), gameId: g.gameId, accept: true }]);
    expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: "white", white_draw_offer_ply: 2, black_draw_offer_ply: null });
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toMatchObject({ drawOfferBy: "white", turn: "white", lastMove: "e7e5", status: "started" });
  });

  it("YES from the OTHER side while an offer stands is the ACCEPT: no local change, no status flip, nothing broadcast", async () => {
    const { g, calls, sent, deps } = await atPly2();
    await by(g, "white", yes, deps);
    sent.length = 0;
    expect(await by(g, "black", yes, deps)).toEqual(APPLIED);
    expect(calls.map((c) => c.token)).toEqual([tokenOf(g.white), tokenOf(g.black)]);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "live", draw_offer_by: "white", black_draw_offer_ply: null });
    expect(sent).toEqual([]);
  });

  it("YES from the offerer while their own offer stands changes nothing", async () => {
    const { g, sent, deps } = await atPly2();
    await by(g, "white", yes, deps);
    sent.length = 0;
    expect(await by(g, "white", yes, deps)).toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: "white", white_draw_offer_ply: 2 });
    expect(sent).toEqual([]);
  });

  it("YES before ply 2 is forwarded and records NOTHING — at ply 0 and at ply 1, from either side", async () => {
    let checked = 0;
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    for (const who of ["white", "black"] as const) {
      expect(await by(g, who, yes, deps), `ply 0 ${who}`).toEqual(APPLIED);
      checked++;
    }
    await mv(g, "white", "e2e4", deps);
    sent.length = 0;
    for (const who of ["white", "black"] as const) {
      expect(await by(g, who, yes, deps), `ply 1 ${who}`).toEqual(APPLIED);
      checked++;
    }
    expect(checked).toBe(4);
    expect(calls.filter((c) => c.kind === "draw").length, "all four forwarded").toBe(4);
    expect(await ledger(g.fixtureId), "no invented offer").toMatchObject({
      draw_offer_by: null,
      white_draw_offer_ply: null,
      black_draw_offer_ply: null,
    });
    expect(sent).toEqual([]);
  });

  it("NO from the other side DECLINES a standing offer (broadcast); the offer's ply is kept for the 20-ply rule", async () => {
    const { g, sent, deps } = await atPly2();
    await by(g, "white", yes, deps);
    sent.length = 0;
    expect(await by(g, "black", no, deps)).toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: null, white_draw_offer_ply: 2 });
    expect(sent.map((s) => s.body.drawOfferBy)).toEqual([null]);
  });

  it("NO from the OFFERER does not withdraw their own offer (Drawer.scala:66)", async () => {
    const { g, sent, deps } = await atPly2();
    await by(g, "white", yes, deps);
    sent.length = 0;
    expect(await by(g, "white", no, deps)).toEqual(APPLIED);
    expect((await ledger(g.fixtureId)).draw_offer_by).toBe("white");
    expect(sent).toEqual([]);
  });

  it("NO with no offer standing changes nothing", async () => {
    const { g, sent, deps } = await atPly2();
    expect(await by(g, "black", no, deps)).toEqual(APPLIED);
    expect((await ledger(g.fixtureId)).draw_offer_by).toBeNull();
    expect(sent).toEqual([]);
  });

  it("the offerer's OWN move keeps the offer; the OTHER side's move clears it (MovePlayer.scala:77)", async () => {
    const { g, sent, deps } = await atPly2();
    await by(g, "white", yes, deps);
    expect(await mv(g, "white", "g1f3", deps)).toEqual(APPLIED);
    expect((await ledger(g.fixtureId)).draw_offer_by, "own move: the offer stands").toBe("white");
    expect(await mv(g, "black", "b8c6", deps)).toEqual(APPLIED);
    expect((await ledger(g.fixtureId)).draw_offer_by, "the other side moved on").toBeNull();
    // Each move's broadcast carries the offer as it then stood.
    expect(sent.map((s) => s.body.drawOfferBy)).toEqual(["white", "white", null]);
  });

  it("a RE-OFFER within 20 plies of the side's last offer is a silent no-op at lila; at 21 plies it is an offer again", async () => {
    // Knight shuffles keep every ply legal; plies are counted from the
    // offer at ply 2. lila: recent ⇔ lastOffer >= ply - 20.
    const g = await readyGame();
    const { sent, deps } = boardStub();
    await playOut(g, ["e2e4", "e7e5"], deps, 0);
    await by(g, "white", yes, deps); // offer at ply 2
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
    const plies: string[] = [];
    for (let i = 0; plies.length < 20; i++) plies.push(shuffle[i % 4]!);
    await playOut(g, plies, deps, 2); // now at ply 22, White to move
    expect((await ledger(g.fixtureId)).move_count, "premise").toBe(22);
    sent.length = 0;
    expect(await by(g, "white", yes, deps), "ply 22: 2 >= 22 - 20 ⇒ recent").toEqual(APPLIED);
    expect(await ledger(g.fixtureId), "not invented").toMatchObject({ draw_offer_by: null, white_draw_offer_ply: 2 });
    expect(sent).toEqual([]);
    // Black's own offer is not limited by White's history.
    await mv(g, "white", "g1f3", deps); // ply 23, Black to move
    expect(await by(g, "black", yes, deps)).toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: "black", black_draw_offer_ply: 23 });
    await by(g, "white", no, deps); // White declines; ply 23
    expect(await by(g, "white", yes, deps), "ply 23: 2 < 23 - 20 ⇒ allowed").toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: "white", white_draw_offer_ply: 23 });
  });

  it("a draw REFUSED by Lichess, or a 5xx, writes nothing and reconciles", async () => {
    let checked = 0;
    for (const code of ["unauthorized", "unavailable"] as const) {
      const { g } = await atPly2();
      const { sent, deps } = boardStub(() => ({ ok: false, code, raw: code }));
      expect(await by(g, "white", yes, deps), code).toEqual(reconcile(code));
      expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: null, white_draw_offer_ply: null });
      expect(sent).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a row FINISHED by reconcile, or given a NEW game, while the draw call was in flight records nothing", async () => {
    // SQL-set mid-call, standing for T11 (finished) and T16 (re-create).
    let checked = 0;
    for (const [label, change] of [
      ["finished", (g: Game) => sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${g.fixtureId}`],
      ["re-created", (g: Game) => sql`update fixture_external_play set challenge_id = ${freshGameId()} where fixture_id = ${g.fixtureId}`],
    ] as const) {
      for (const [accept, standing] of [
        [true, null],
        [false, "white"],
      ] as const) {
        const { g, deps: d0 } = await atPly2();
        if (standing) await by(g, standing, yes, d0);
        const { sent, deps } = boardStub(async () => {
          await change(g);
          return { ok: true };
        });
        const caller = standing ? other(standing) : "white";
        expect(await by(g, caller, { kind: "draw", accept }, deps), `${label} accept=${accept}`).toEqual(APPLIED);
        expect((await ledger(g.fixtureId)).draw_offer_by, `${label} accept=${accept}`).toBe(standing);
        expect(sent).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("an offer on a ledger chess.js cannot replay is recorded but NOT broadcast", async () => {
    const g = await readyGame();
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      const { sent, deps } = boardStub();
      await mv(g, "white", "e2e5", deps); // "accepted" by this Lichess; chess.js disagrees
      await mv(g, "black", "e7e5", deps);
      expect(sent, "premise: neither move broadcast").toEqual([]);
      expect(await by(g, "white", yes, deps)).toEqual(APPLIED);
      expect((await ledger(g.fixtureId)).draw_offer_by).toBe("white");
      expect(sent).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it("a draw broadcast's clocks read NOW: the side to move has been spending since the last move", async () => {
    const g = await readyGame();
    const { sent, deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(0));
    await mv(g, "black", "e7e5", deps, at(5)); // both clocks 300 000 (plies 0-1 are free)
    sent.length = 0;
    // White to move since t=5; Black offers at t=25 ⇒ White has spent 20 s.
    expect(await by(g, "black", yes, deps, at(25))).toEqual(APPLIED);
    expect(sent[0]!.body).toMatchObject({ whiteMs: BASE_S * 1000 - 20_000, blackMs: BASE_S * 1000, drawOfferBy: "black" });
  });
});

// Clocks are RENDERED from accepted-move times, never adjudicated (spec §6,
// M2). Expected values come from scalachess Clock.step (2ab0a403): no time
// runs until both sides have moved; then the mover pays the time since the
// last move and earns the increment only if time remained; clamped at zero.
describe.runIf(HAS_DB)("act — clocks", () => {
  it("plies 0-1 are free; then each mover pays the elapsed time and earns the increment", async () => {
    const g = await readyGame();
    const { sent, deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(0));
    await mv(g, "black", "e7e5", deps, at(5));
    expect(await ledger(g.fixtureId)).toMatchObject({ white_ms: 300_000, black_ms: 300_000 });
    await mv(g, "white", "g1f3", deps, at(17)); // White spent 12 s
    expect(await ledger(g.fixtureId)).toMatchObject({ white_ms: 300_000 - 12_000 + 3_000, black_ms: 300_000 });
    await mv(g, "black", "b8c6", deps, at(24)); // Black spent 7 s
    expect(await ledger(g.fixtureId)).toMatchObject({ white_ms: 291_000, black_ms: 296_000 });
    expect(sent.at(-1)!.body).toMatchObject({ whiteMs: 291_000, blackMs: 296_000, turn: "white" });
  });

  it("a mover whose time ran out by OUR arithmetic is clamped to 0, earns nothing, and the move is still recorded — no flag is declared", async () => {
    const g = await readyGame();
    const { deps } = boardStub();
    await playOut(g, ["e2e4", "e7e5"], { ...deps, now: at(0) });
    // White has 300 s and takes 400.
    expect(await mv(g, "white", "g1f3", deps, at(400))).toEqual(APPLIED);
    expect(await ledger(g.fixtureId)).toMatchObject({ status: "live", white_ms: 0, move_count: 3 });
  });

  it("time running out EXACTLY earns no increment (scalachess: only when moveTime < remaining)", async () => {
    const g = await readyGame();
    const { deps } = boardStub();
    await playOut(g, ["e2e4", "e7e5"], { ...deps, now: at(0) });
    await mv(g, "white", "g1f3", deps, at(300));
    expect((await ledger(g.fixtureId)).white_ms).toBe(0);
  });

  it("a NEGATIVE elapsed (a clock that went backwards) costs nothing", async () => {
    const g = await readyGame();
    const { deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(10));
    await mv(g, "black", "e7e5", deps, at(20));
    await mv(g, "white", "g1f3", deps, at(15));
    expect((await ledger(g.fixtureId)).white_ms).toBe(300_000 + 3_000);
  });

  it("a clock CORRECTED by reconcile while the move was in flight is the one the append charges", async () => {
    const g = await readyGame();
    const { deps: d0 } = boardStub();
    await playOut(g, ["e2e4", "e7e5", "g1f3"], { ...d0, now: at(0) });
    const { deps } = boardStub(async () => {
      // T11-shaped: the stream said Black has 100 s.
      await sql`update fixture_external_play set black_ms = 100000 where fixture_id = ${g.fixtureId}`;
      return { ok: true };
    });
    await mv(g, "black", "b8c6", deps, at(10)); // Black spent 10 s since t=0
    expect((await ledger(g.fixtureId)).black_ms).toBe(100_000 - 10_000 + 3_000);
  });
});

describe.runIf(HAS_DB)("act — the broadcast", () => {
  it("ONE broadcast per accepted move, carrying the full RoomBroadcast", async () => {
    const g = await readyGame();
    const { sent, deps } = boardStub();
    await mv(g, "white", "e2e4", deps, at(0));
    expect(sent.length).toBe(1);
    // The FEN from an independent replay (SAN, not our UCI path).
    const reference = new Chess();
    reference.move("e4");
    expect(sent[0]).toEqual({
      fixtureId: g.fixtureId,
      body: {
        fen: reference.fen(),
        lastMove: "e2e4",
        turn: "black",
        whiteMs: BASE_S * 1000,
        blackMs: BASE_S * 1000,
        status: "started",
        drawOfferBy: null,
      },
    });
  });

  it("a move Lichess accepted that chess.js cannot replay is RECORDED (Lichess is the authority) but never broadcast", async () => {
    const g = await readyGame();
    const errors = vi.spyOn(log, "error");
    try {
      const { sent, deps } = boardStub();
      // e2e5 is well-formed and illegal; this "Lichess" accepts it anyway.
      expect(await mv(g, "white", "e2e5", deps)).toEqual(reconcile("unavailable"));
      expect((await ledger(g.fixtureId)).moves_uci).toEqual(["e2e5"]);
      expect(sent).toEqual([]);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureId: g.fixtureId, replayed: 0, moveCount: 1 }),
        expect.stringMatching(/does not replay/),
      );
    } finally {
      errors.mockRestore();
    }
  });
});

describe("publishRoomBroadcast", () => {
  const BODY: RoomBroadcast = {
    fen: "x",
    lastMove: "e2e4",
    turn: "black",
    whiteMs: 1,
    blackMs: 2,
    status: "started",
    drawOfferBy: null,
  };
  async function withEnv<T>(env: Record<string, string | undefined>, fetchImpl: typeof fetch, run: () => Promise<T>) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    const realFetch = globalThis.fetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = fetchImpl;
    try {
      return await run();
    } finally {
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "svc" };

  it("posts to the lobby topic we already own, PRIVATE, event room_state, the body as payload, with a timeout", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await withEnv(
      ENV,
      (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      async () => {
        const { publishRoomBroadcast, externalPlayLobbyTopic } = await import("@/lib/realtime");
        await publishRoomBroadcast("fix-1", BODY);
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toBe("https://stub.supabase.test/realtime/v1/api/broadcast");
        expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer svc", apikey: "svc" });
        // V433's policy matches `external-play:{lobby_fixture_id}`, so riding
        // this topic needs NO new realtime policy for players.
        expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
          messages: [{ topic: externalPlayLobbyTopic("fix-1"), event: "room_state", payload: BODY, private: true }],
        });
        expect(calls[0]!.init.signal, "an endpoint that never answers must not hold the move").toBeInstanceOf(AbortSignal);
      },
    );
  });

  it("never throws: a fetch that rejects, and a non-2xx, both resolve", async () => {
    const { publishRoomBroadcast } = await import("@/lib/realtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      let checked = 0;
      for (const impl of [
        (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
        (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
      ]) {
        await withEnv(ENV, impl, () => expect(publishRoomBroadcast("fix-1", BODY)).resolves.toBeUndefined());
        checked++;
      }
      expect(checked).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("without the realtime env it sends nothing", async () => {
    const { publishRoomBroadcast } = await import("@/lib/realtime");
    const calls: unknown[] = [];
    await withEnv(
      { NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: "svc" },
      (async (...args: unknown[]) => {
        calls.push(args);
        return new Response("{}");
      }) as typeof fetch,
      () => publishRoomBroadcast("fix-1", BODY),
    );
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The property (spec §8.1 / TEST-STRATEGY rule 10): random interleavings of
// every action a room can see, against a MODEL of lila — not against T10's
// own rules. The model is lila source as read (not measured — T17):
// MovePlayer (turn, game over, a move declines the opponent's offer),
// Drawer.yes/no + Game.playerCanOfferDraw (ply >= 2, no standing own offer,
// 20-ply re-offer rule), BotPlayer.resign (an abort before ply 2) and
// .abort (refused from ply 2). A 5xx is modelled both ways: lila failed
// before acting, or acted and the answer was lost. `refresh` stands for
// T11's reconcile adopting Lichess's truth (moves, the standing offer and
// the offer plies, 'finished' once the game is over) — T11's writer, not
// T10's; it is how a lagging ledger catches up.

type Who = "white" | "black";
const other = (c: Who): Who => (c === "white" ? "black" : "white");
const uciMove = (uci: string) =>
  uci.length > 4 ? { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) } : { from: uci.slice(0, 2), to: uci.slice(2, 4) };

const OK: BoardCall = { ok: true };
const FIVE_XX: BoardCall = { ok: false, code: "unavailable", raw: "502 Bad Gateway" };
const M6: BoardCall = { ok: false, code: "not_your_turn_or_over", raw: "Not your turn, or game already over" };
/** lila's clientError 400s, which T3's classifier answers `unavailable`. */
const clientError = (raw: string): BoardCall => ({ ok: false, code: "unavailable", raw });

class LilaModel {
  readonly board = new Chess();
  readonly moves: string[] = [];
  over: string | null = null;
  readonly offering: Record<Who, boolean> = { white: false, black: false };
  readonly lastOffer: Record<Who, number | null> = { white: null, black: null };
  failNext: { played: boolean } | null = null;
  /** A "yes" lila ignored under its 20-ply re-offer rule. */
  reofferBlocked = 0;
  /** Set when the last call answered 5xx (whether or not lila acted). */
  lastWasFiveXX = false;
  get ply() {
    return this.moves.length;
  }
  offeringSide(): Who | null {
    return this.offering.white ? "white" : this.offering.black ? "black" : null;
  }
  private call(apply: () => BoardCall): BoardCall {
    const fail = this.failNext;
    this.failNext = null;
    this.lastWasFiveXX = fail !== null;
    if (fail && !fail.played) return FIVE_XX;
    const answer = apply();
    return fail ? FIVE_XX : answer;
  }
  move(c: Who, uci: string): BoardCall {
    return this.call(() => {
      if (this.over !== null || (this.ply % 2 === 0 ? "white" : "black") !== c) return M6;
      try {
        this.board.move(uciMove(uci));
      } catch {
        return clientError(`illegal move ${uci}`);
      }
      this.moves.push(uci);
      if (this.offering[other(c)]) this.offering[other(c)] = false;
      if (this.board.isCheckmate()) this.over = "mate";
      else if (this.board.isStalemate() || this.board.isInsufficientMaterial()) this.over = "draw";
      return OK;
    });
  }
  draw(c: Who, accept: boolean): BoardCall {
    return this.call(() => {
      if (this.over !== null || this.ply < 2) return OK; // !drawable: a silent no-op, still 200
      if (accept) {
        if (this.offering[other(c)]) this.over = "draw";
        else if (!this.offering[c] && !(this.lastOffer[c] !== null && this.lastOffer[c]! >= this.ply - 20)) {
          this.offering[c] = true;
          this.lastOffer[c] = this.ply;
        } else if (!this.offering[c]) this.reofferBlocked++;
      } else if (this.offering[other(c)]) this.offering[other(c)] = false;
      return OK;
    });
  }
  resign(): BoardCall {
    return this.call(() => {
      if (this.over !== null) return clientError("This game cannot be resigned");
      this.over = this.ply < 2 ? "aborted" : "resign";
      return OK;
    });
  }
  abort(): BoardCall {
    return this.call(() => {
      if (this.over !== null || this.ply >= 2) return clientError("This game can no longer be aborted");
      this.over = "aborted";
      return OK;
    });
  }
}

type Op =
  | { k: "move"; who: Who | "turn"; pick: number }
  | { k: "dup" }
  | { k: "outsider" }
  | { k: "fail"; played: boolean }
  | { k: "illegal"; sq: number }
  | { k: "echo" }
  | { k: "resign"; who: Who }
  | { k: "abort"; who: Who }
  | { k: "draw"; who: Who; accept: boolean }
  | { k: "refresh" };

const whoArb = fc.constantFrom<Who>("white", "black");
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({
      k: fc.constant("move" as const),
      who: fc.oneof({ weight: 5, arbitrary: fc.constant("turn" as const) }, { weight: 1, arbitrary: whoArb }),
      pick: fc.nat(80),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ k: "dup" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "outsider" as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("fail" as const), played: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("illegal" as const), sq: fc.nat(63) }) },
  { weight: 1, arbitrary: fc.constant({ k: "echo" as const }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("resign" as const), who: whoArb }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("abort" as const), who: whoArb }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("draw" as const), who: whoArb, accept: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constant({ k: "refresh" as const }) },
);
const T_ = { k: "move", who: "turn", pick: 0 } as const;
/** Edge prefixes, each ENDING with the claim it exists for, so its path is
 *  reached whenever the prefix is drawn rather than by tail luck. */
const PREFIXES: Op[][] = [
  [],
  [T_, T_, { k: "draw", who: "white", accept: true }, { k: "draw", who: "black", accept: false }],
  [T_, T_, { k: "draw", who: "white", accept: true }, T_, T_],
  [T_, T_, { k: "draw", who: "white", accept: true }, { k: "draw", who: "black", accept: true }, { k: "refresh" }],
  [{ k: "fail", played: true }, T_, T_, { k: "refresh" }],
  [{ k: "fail", played: false }, T_, T_],
  [T_, T_, { k: "resign", who: "white" }, T_, { k: "refresh" }, T_],
  [{ k: "abort", who: "black" }, { k: "refresh" }, T_],
  [T_, { k: "dup" }],
  [T_, T_, { k: "fail", played: true }, { k: "draw", who: "white", accept: true }, { k: "refresh" }],
  [T_, { k: "illegal", sq: 12 }],
  [T_, { k: "echo" }],
  [{ k: "outsider" }],
  // White offers at 2, Black's move clears it, White re-offers at 4: recent.
  [T_, T_, { k: "draw", who: "white", accept: true }, T_, T_, { k: "draw", who: "white", accept: true }],
];
const tailArb = fc.array(opArb, { minLength: 0, maxLength: 28, size: "max" });

/** An independent UCI replay (the test's, not fenAfter): the position, or
 *  the index of the first move chess.js rejects. */
function replayLedger(moves: readonly string[]): { board: Chess; illegalAt: number | null; turnsChecked: number } {
  const b = new Chess();
  let turnsChecked = 0;
  for (let i = 0; i < moves.length; i++) {
    // Plies alternate colours: the side to move before ply i is i's parity.
    expect(b.turn(), `ply ${i} is ${i % 2 === 0 ? "White" : "Black"}'s`).toBe(i % 2 === 0 ? "w" : "b");
    turnsChecked++;
    try {
      b.move(uciMove(moves[i]!));
    } catch {
      return { board: b, illegalAt: i, turnsChecked };
    }
  }
  return { board: b, illegalAt: null, turnsChecked };
}
const toUci = (m: { from: string; to: string; promotion?: string }) => `${m.from}${m.to}${m.promotion ?? ""}`;

describe.runIf(HAS_DB)("act — property: interleavings against a lila model", () => {
  // Every prefix runs the same number of times — drawing one at random
  // left a path's counter at 0 in ~4% of suites (measured: abort, 1 in 3).
  const RUNS_PER_PREFIX = 3;
  const NUM_RUNS = RUNS_PER_PREFIX * PREFIXES.length;
  const totals: Record<string, number> = {};
  const bump = (k: string, n = 1) => (totals[k] = (totals[k] ?? 0) + n);

  it("the ledger stays a legal, alternating, duplicate-free PREFIX of Lichess's game; nothing lands after the end; a 5xx is never 'rejected'", { timeout: 600_000 }, async () => {
    let runs = 0;
    for (const prefix of PREFIXES) await fc.assert(
      fc.asyncProperty(tailArb.map((tail) => [...prefix, ...tail]), async (ops) => {
        runs++;
        const g = await readyGame();
        const outsider = await seedPlayer(g.orgId, "Spectator", `o-${randomUUID().slice(0, 8)}`, true);
        const lila = new LilaModel();
        // Per run: true from a 5xx until the next refresh — T10 cannot know
        // what a 5xx did, so its draw state is only compared outside it.
        let lagged = false;
        let finishedLedger: string[] | null = null;
        let lastSubmitted: { who: Who; uci: string } | null = null;
        let published = 0;
        let bodies: RoomBroadcast[] = [];
        let lichessCalls = 0;
        const whoOf = (token: string): Who => {
          if (token === tokenOf(g.white)) return "white";
          if (token === tokenOf(g.black)) return "black";
          throw new Error("a token that belongs to neither player reached Lichess");
        };
        const seen = (gameId: string) => {
          expect(gameId).toBe(g.gameId);
          lichessCalls++;
        };
        const deps: PlayDeps = {
          submitMove: async (x) => (seen(x.gameId), lila.move(whoOf(x.token), x.uci)),
          resignGame: async (x) => (seen(x.gameId), whoOf(x.token), lila.resign()),
          abortGame: async (x) => (seen(x.gameId), whoOf(x.token), lila.abort()),
          offerOrAcceptDraw: async (x) => (seen(x.gameId), lila.draw(whoOf(x.token), x.accept)),
          publish: async (_f, body) => {
            published++;
            bodies.push(body);
          },
        };
        const run = async (personId: string, action: PlayAction) => {
          try {
            return { result: await act({ fixtureId: g.fixtureId, personId, action }, deps) };
          } catch (err) {
            const e = err as { status?: number; code?: string };
            return { thrown: { status: e.status, code: e.code } };
          }
        };

        for (const op of ops) {
          const before = await ledger(g.fixtureId);
          const terminalBefore = before.status === "finished";
          const lilaOverBefore = lila.over !== null;
          published = 0;
          bodies = [];
          lichessCalls = 0;
          lila.lastWasFiveXX = false;
          const lilaPlyBefore = lila.ply;
          /** Whether the acting player is on turn by OUR ledger (move-like ops). */
          let onTurn: boolean | null = null;
          let out: { result?: PlayResult; thrown?: { status?: number; code?: string } } | null = null;
          let submitted: string | null = null;
          const ourTurn: Who = before.move_count % 2 === 0 ? "white" : "black";

          switch (op.k) {
            case "move": {
              const who = op.who === "turn" ? ourTurn : op.who;
              let uci: string;
              if (who === ourTurn) {
                const legal = replayLedger(before.moves_uci).board.moves({ verbose: true });
                if (legal.length === 0) {
                  bump("skip:no_legal_move");
                  continue;
                }
                uci = toUci(legal[op.pick % legal.length]!);
              } else {
                uci = who === "white" ? "a2a3" : "a7a6";
              }
              submitted = uci;
              lastSubmitted = { who, uci };
              onTurn = who === ourTurn;
              out = await run(g[who].personId, { kind: "move", uci });
              break;
            }
            case "dup": {
              if (!lastSubmitted) {
                bump("skip:dup_before_any_move");
                continue;
              }
              submitted = lastSubmitted.uci;
              onTurn = lastSubmitted.who === ourTurn;
              out = await run(g[lastSubmitted.who].personId, { kind: "move", uci: lastSubmitted.uci });
              break;
            }
            case "outsider":
              out = await run(outsider.personId, { kind: "move", uci: "e2e4" });
              expect(out.thrown, "a non-player is a 404").toMatchObject(NOT_FOUND);
              expect(lichessCalls).toBe(0);
              bump("outsider_404");
              break;
            case "fail":
              lila.failNext = { played: op.played };
              continue;
            case "illegal": {
              const sq = `${"abcdefgh"[op.sq % 8]}${Math.floor(op.sq / 8) + 1}`;
              submitted = `${sq}${sq}`; // well-formed (assertUci passes) and never legal
              onTurn = true;
              out = await run(g[ourTurn].personId, { kind: "move", uci: submitted });
              break;
            }
            case "echo": {
              // The player on turn sends the string of the move on file —
              // the opponent's. Not a duplicate: it is theirs to send, and
              // Lichess's to judge.
              const last = before.moves_uci.at(-1);
              if (last === undefined) {
                bump("skip:echo_before_any_move");
                continue;
              }
              submitted = last;
              onTurn = true;
              out = await run(g[ourTurn].personId, { kind: "move", uci: last });
              if (!terminalBefore) bump("echo_forwarded");
              break;
            }
            case "resign":
            case "abort":
              out = await run(g[op.who].personId, { kind: op.k });
              break;
            case "draw":
              out = await run(g[op.who].personId, { kind: "draw", accept: op.accept });
              break;
            case "refresh": {
              const over = lila.over !== null;
              await sql`
                update fixture_external_play
                   set moves_uci = ${sql.json(lila.moves)}, move_count = ${lila.ply},
                       status = ${over ? "finished" : lila.ply > 0 ? "live" : before.status},
                       finished_at = ${over ? new Date() : null},
                       started_at = coalesce(started_at, ${lila.ply > 0 ? new Date() : null}),
                       draw_offer_by = ${lila.offeringSide()},
                       white_draw_offer_ply = ${lila.lastOffer.white},
                       black_draw_offer_ply = ${lila.lastOffer.black}
                 where fixture_id = ${g.fixtureId} and status in ('ready', 'live')`;
              lagged = false;
              bump("refresh");
              if (lila.ply > before.move_count) bump("five_xx_played_adopted");
              break;
            }
          }

          const after = await ledger(g.fixtureId);

          // ---- per-op rules ------------------------------------------------
          if (out && terminalBefore) {
            expect(out.thrown, "a finished row accepts nothing").toMatchObject(NOT_FOUND);
            expect(lichessCalls, "and calls nothing").toBe(0);
            bump("after_finished_404");
          }
          if (out?.thrown && op.k !== "outsider" && !terminalBefore) {
            throw new Error(`unexpected throw on ${op.k}: ${JSON.stringify(out.thrown)}`);
          }
          if (lila.lastWasFiveXX && lichessCalls > 0) {
            // The only honest answer to a 5xx: reconcile — never "rejected",
            // never "applied" — and the row is exactly as it was.
            expect(out?.result, "a 5xx answers reconcile:unavailable").toEqual(reconcile("unavailable"));
            expect(after).toEqual(before);
            lagged = true;
            bump(op.k === "move" || op.k === "dup" ? "five_xx_on_move" : "five_xx_on_other");
          }
          const r = out?.result;
          if (r && r.ok && r.applied && (op.k === "move" || op.k === "dup")) {
            expect(after.moves_uci, "an applied move appends exactly that move").toEqual([...before.moves_uci, submitted]);
            bump("move_applied");
          } else if (op.k !== "refresh") {
            if (op.k === "move" || op.k === "dup" || op.k === "illegal") {
              expect(after.moves_uci, "nothing else appends").toEqual(before.moves_uci);
            }
          }
          if (r && r.ok && !r.applied) bump("absorbed");
          if (r && !r.ok && r.reconcile && r.reason === "not_your_turn_or_over") bump("refused_turn_or_over");
          if (op.k === "illegal" && r && !r.ok) bump("illegal_refused");
          if (op.k === "resign" && r?.ok) bump("resign_forwarded");
          if (op.k === "abort" && r?.ok) bump("abort_forwarded");
          // Who reaches Lichess: an on-turn move always does (Lichess judges
          // it); an off-turn one never does (we answer it ourselves).
          if (onTurn !== null && !terminalBefore) {
            expect(lichessCalls, onTurn ? "an on-turn move reaches Lichess" : "an off-turn move never does").toBe(onTurn ? 1 : 0);
          }
          // Sequential, so no other writer: a move Lichess ACCEPTED (and
          // answered) is a move recorded, applied, broadcast.
          if (onTurn && lila.ply > lilaPlyBefore && !lila.lastWasFiveXX) {
            expect(r, "Lichess accepted it ⇒ applied").toEqual(APPLIED);
            expect(after.moves_uci).toEqual(lila.moves);
            bump("lichess_ok_recorded");
          }
          if (lilaOverBefore && op.k !== "refresh") {
            expect(after.move_count, "nothing is accepted after the game is over").toBe(before.move_count);
            bump("after_over_checked");
          }

          // Broadcasts: one per recorded change, none otherwise.
          const grew = after.move_count > before.move_count && op.k !== "refresh";
          const drawChanged = op.k === "draw" && after.draw_offer_by !== before.draw_offer_by;
          if (op.k !== "refresh") expect(published, "one broadcast per recorded change").toBe((grew ? 1 : 0) + (drawChanged ? 1 : 0));
          if (drawChanged) bump(after.draw_offer_by === null ? "draw_cleared" : "draw_recorded");
          // lila never hands a standing offer to the other side: a "yes"
          // against it is the accept, a "no" only clears it.
          if (op.k === "draw" && before.draw_offer_by !== null && after.draw_offer_by !== null) {
            expect(after.draw_offer_by, "an offer is never flipped to the other side").toBe(before.draw_offer_by);
            bump("standing_offer_checks");
          }
          // Every broadcast IS the row: an independent replay's board, the
          // last move, the turn by parity, the standing offer.
          for (const body of bodies) {
            const ref = replayLedger(after.moves_uci).board;
            expect(body).toMatchObject({
              fen: ref.fen(),
              lastMove: after.moves_uci.at(-1) ?? null,
              turn: after.move_count % 2 === 0 ? "white" : "black",
              status: "started",
              drawOfferBy: after.draw_offer_by,
            });
            bump("broadcasts_checked");
          }
          // 'ready' means created, never started (T13); 'live' means a move
          // was recorded and started_at stamped.
          if (after.status === "ready") {
            expect(after.move_count, "'ready' has no moves").toBe(0);
            expect(after.started_at, "'ready' was never started").toBeNull();
          }
          if (after.status === "live") {
            expect(after.move_count, "'live' has a move").toBeGreaterThan(0);
            expect(after.started_at, "'live' was started").not.toBeNull();
          }
          bump("status_checks");

          // ---- invariants ----------------------------------------------------
          expect(after.move_count).toBe(after.moves_uci.length);
          const replay = replayLedger(after.moves_uci);
          expect(replay.illegalAt, "the ledger is a legal game (independent chess.js replay)").toBeNull();
          bump("plies_checked", replay.turnsChecked);
          expect(lila.moves.slice(0, after.moves_uci.length), "the ledger is a prefix of Lichess's game")
            .toEqual(after.moves_uci);
          expect(new Set(after.moves_uci.map((m, i) => `${i}:${m}`)).size, "no ply twice").toBe(after.moves_uci.length);
          if (op.k === "refresh") {
            // Every move Lichess holds — including a 5xx that played — is
            // adoptable: nothing T10 wrote stands in its way.
            expect(after.moves_uci, "after reconcile, the ledger IS Lichess's game").toEqual(lila.moves);
          }
          if (finishedLedger !== null) {
            expect(after.moves_uci, "a finished ledger never moves again").toEqual(finishedLedger);
          }
          if (after.status === "finished" && finishedLedger === null) finishedLedger = after.moves_uci;
          if (!lagged && lila.over === null) {
            // Strict: the standing offer on file IS lila's — never invented,
            // never missed.
            expect(after.draw_offer_by, "the standing draw offer matches lila").toBe(lila.offeringSide());
            bump("draw_state_strict_checks");
          }
          bump("ops");
        }
        bump("reoffer_blocked", lila.reofferBlocked);
      }),
      { numRuns: RUNS_PER_PREFIX, endOnFailure: true },
    );
    expect(runs, "anti-vacuity: the property ran").toBe(NUM_RUNS);
    console.info(`[T10 property] runs=${runs} ${JSON.stringify(totals)}`);
    // Anti-vacuity, per path the property is named for.
    let checked = 0;
    for (const path of [
      "move_applied",
      "absorbed",
      "refused_turn_or_over",
      "five_xx_on_move",
      "five_xx_on_other",
      "illegal_refused",
      "outsider_404",
      "after_finished_404",
      "after_over_checked",
      "resign_forwarded",
      "abort_forwarded",
      "draw_recorded",
      "draw_cleared",
      "refresh",
      "draw_state_strict_checks",
      "plies_checked",
      "five_xx_played_adopted",
      "reoffer_blocked",
      "echo_forwarded",
      "lichess_ok_recorded",
      "standing_offer_checks",
      "broadcasts_checked",
      "status_checks",
    ]) {
      expect(totals[path] ?? 0, `anti-vacuity: ${path}`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(23);
  });
});
