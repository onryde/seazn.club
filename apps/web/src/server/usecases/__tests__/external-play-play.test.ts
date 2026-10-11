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
import { holdForOrganiser } from "../external-play/result";
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
  // reconcile's two reads, reached when a case does not inject `reconcile`.
  readGameStream: vi.fn(),
  exportGame: vi.fn(),
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
  board.readGameStream.mockResolvedValue(UNEXPECTED);
  board.exportGame.mockResolvedValue(null);
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
  needs_reason: string | null;
  revoked_seat: string | null;
};
async function ledger(fixtureId: string): Promise<Ledger> {
  const [row] = await sql<Ledger[]>`
    select status, white_side, moves_uci, move_count, started_at, last_move_at, white_ms, black_ms,
           clock_increment_s, draw_offer_by, white_draw_offer_ply, black_draw_offer_ply, needs_reason, revoked_seat
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
 *  it carried) and answers what the case says. Records every broadcast, and
 *  every reconcile T10 asks for (T11's real one is driven end to end in
 *  external-play-reconcile.test.ts). */
function boardStub(answer: (c: Call) => BoardCall | Promise<BoardCall> = () => ({ ok: true })) {
  const calls: Call[] = [];
  const sent: { fixtureId: string; body: RoomBroadcast }[] = [];
  const reconciles: string[] = [];
  /** The move each reconcile was told T10 had sent (review N1). */
  const submissions: unknown[] = [];
  /** Work T10 deferred past its answer (review N3), run here at once. */
  const deferredTasks: Promise<unknown>[] = [];
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
    reconcile: async (_fixtureId, trigger, submitted) => {
      reconciles.push(trigger);
      submissions.push(submitted);
    },
    defer: (task) => {
      deferredTasks.push(task());
    },
  };
  return { calls, sent, deps, reconciles, submissions, deferredTasks };
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
      // T9's create-time token_revoked hold records no seat: both frozen.
      sql`status = 'needs_organiser', needs_reason = 'token_revoked'`,
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
    expect(checked, "anti-vacuity: 3 states × 5 actions").toBe(15);
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
  /** Moves already on file when both tabs submit. */
  prefix: readonly string[] = [],
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
      if ((await ledger(g.fixtureId)).move_count === prefix.length + 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await ledger(g.fixtureId)).moves_uci, "premise: the winner is recorded first").toEqual([...prefix, winner]);
    refused = true;
    return loserAnswer;
  });
  return { deps: stub.deps, refusedTab: () => refused };
}

describe.runIf(HAS_DB)("act — Lichess refusals (nothing is written, nothing broadcast)", () => {
  it("each refusal code passes through UNCHANGED as reconcile:<code> — no branch collapses two; each asks reconcile but a 429", async () => {
    const codes = ["unauthorized", "unplayable_time_control", "rate_limited", "unavailable", "not_your_turn_or_over"] as const;
    let checked = 0;
    for (const code of codes) {
      const g = await readyGame();
      const { calls, sent, deps, reconciles, submissions, deferredTasks } = boardStub(() => ({ ok: false, code, raw: code }));
      expect(await mv(g, "white", "e2e4", deps), code).toEqual(reconcile(code));
      expect(calls.length).toBe(1);
      expect(sent).toEqual([]);
      // Review N3: the reconcile is deferred past the answer, never awaited by it.
      expect(deferredTasks.length, code).toBe(code === "rate_limited" ? 0 : 1);
      await Promise.all(deferredTasks);
      // Review N1: it is told exactly what T10 sent, at which ply.
      expect(submissions, code).toEqual(code === "rate_limited" ? [] : [{ ply: 0, uci: "e2e4" }]);
      // Spec §3.5's first trigger (T11 review I4): M6's 400 covers two states
      // and a 5xx may have played the move — reconcile, never assume. A 429
      // stops every call, reconcile's read included.
      expect(reconciles, code).toEqual(code === "rate_limited" ? [] : ["rejected_move"]);
      // A 401 is a revoked token: held for the organiser, THIS seat recorded
      // (spec §3.6; ruling M7). Nothing else holds.
      expect(await ledger(g.fixtureId), code).toMatchObject(
        code === "unauthorized"
          ? { status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "white", move_count: 0 }
          : { status: "ready", needs_reason: null, move_count: 0 },
      );
      checked++;
    }
    expect(checked, "anti-vacuity: every BoardErrorCode").toBe(codes.length);
  });

  it("a move refused HERE (out of turn), an accepted move and an absorbed duplicate ask reconcile for nothing", async () => {
    const g = await readyGame();
    const { calls, deps, reconciles } = boardStub();
    expect(await mv(g, "white", "e2e4", deps)).toEqual(APPLIED);
    expect(await mv(g, "white", "e2e4", deps)).toEqual(ABSORBED);
    expect(await mv(g, "white", "d2d4", deps)).toEqual(reconcile("not_your_turn_or_over"));
    expect(calls.length, "premise: only the first reached Lichess").toBe(1);
    expect(reconciles, "nothing Lichess refused").toEqual([]);
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

  it("resign and abort REFUSED (401) pass the code through, hold the caller's seat, and reconcile nothing (not a move) — counted", async () => {
    let checked = 0;
    for (const kind of ["resign", "abort"] as const) {
      for (const who of ["white", "black"] as const) {
        const g = await readyGame();
        const { deps, reconciles } = boardStub(() => ({ ok: false, code: "unauthorized", raw: "401" }));
        expect(await by(g, who, { kind }, deps), `${kind} ${who}`).toEqual(reconcile("unauthorized"));
        expect(await ledger(g.fixtureId), `${kind} ${who}`).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: who });
        expect(reconciles).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(4);
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
      expect(await ledger(g.fixtureId)).toMatchObject({
        draw_offer_by: null,
        white_draw_offer_ply: null,
        // A 401 is a revoked token — White's seat held (ruling M7).
        needs_reason: code === "unauthorized" ? "token_revoked" : null,
        revoked_seat: code === "unauthorized" ? "white" : null,
      });
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
describe.runIf(HAS_DB)("act — M7: a revoked token freezes ITS seat only (controller ruling, T11 fix round 1)", () => {
  // Ruling M7: a token_revoked hold must not freeze the seat whose token still
  // works — the innocent player keeps playing and can still win on the clock;
  // T10 refuses acts for the revoked seat alone, and the organiser queue still
  // shows the revoke (the row stays needs_organiser). Every hold here is T10's
  // OWN, placed by its real `act` on Lichess's 401 — no hand-written row.
  const other = (c: "white" | "black") => (c === "white" ? "black" : "white");
  const REFUSE_401 = () => ({ ok: false, code: "unauthorized", raw: "401 Unauthorized" }) as const;

  /** A live game where `revoked` is NOT to move, then `revoked`'s resign is
   *  refused 401: White to move at ply 2 (Black revoked), Black to move at
   *  ply 3 (White revoked). `offerFirst`: `revoked` offers a draw (recorded)
   *  before the revoke. */
  async function revokedOffTurn(revoked: "white" | "black", offerFirst = false) {
    const g = await readyGame();
    const ok = boardStub();
    await playOut(g, revoked === "black" ? ["e2e4", "e7e5"] : ["e2e4", "e7e5", "g1f3"], ok.deps);
    if (offerFirst) expect(await by(g, revoked, { kind: "draw", accept: true }, ok.deps)).toEqual(APPLIED);
    const refusing = boardStub(REFUSE_401);
    expect(await by(g, revoked, { kind: "resign" }, refusing.deps)).toEqual(reconcile("unauthorized"));
    expect(await ledger(g.fixtureId), "premise: T10's 401 held the board for THIS seat").toMatchObject({
      status: "needs_organiser",
      needs_reason: "token_revoked",
      revoked_seat: revoked,
    });
    return g;
  }
  const NEXT: Record<"white" | "black", string> = { white: "f1c4", black: "b8c6" };

  it("the innocent seat plays on: its move reaches Lichess, is recorded and broadcast, the hold and its seat stand — BOTH seats, counted", async () => {
    let checked = 0;
    for (const revoked of ["white", "black"] as const) {
      const innocent = other(revoked);
      const g = await revokedOffTurn(revoked);
      const before = await ledger(g.fixtureId);
      const { calls, sent, deps, reconciles } = boardStub();
      expect(await mv(g, innocent, NEXT[innocent], deps), `${revoked} revoked: ${innocent} moves`).toEqual(APPLIED);
      expect(calls).toEqual([{ kind: "move", token: tokenOf(g[innocent]), gameId: g.gameId, uci: NEXT[innocent] }]);
      expect(await ledger(g.fixtureId), `${revoked} revoked`).toMatchObject({
        // NOT flipped to 'live': the organiser queue still shows the revoke.
        status: "needs_organiser",
        needs_reason: "token_revoked",
        revoked_seat: revoked,
        moves_uci: [...before.moves_uci, NEXT[innocent]],
        move_count: before.move_count + 1,
      });
      expect(sent.length, "the room sees the move").toBe(1);
      expect(reconciles).toEqual([]);
      // …and may offer a draw on the held row.
      expect(await by(g, innocent, { kind: "draw", accept: true }, deps)).toEqual(APPLIED);
      expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: innocent, status: "needs_organiser", revoked_seat: revoked });
      checked++;
    }
    expect(checked, "both seats").toBe(2);
  });

  it("the frozen seat's every act is a 404 that never reaches Lichess, on its turn and off it — BOTH seats × 4 actions, counted", async () => {
    let checked = 0;
    for (const revoked of ["white", "black"] as const) {
      const g = await revokedOffTurn(revoked);
      const { calls, sent, deps, reconciles } = boardStub();
      const offTurn = await ledger(g.fixtureId);
      for (const turn of ["off", "on"] as const) {
        if (turn === "on") expect(await mv(g, other(revoked), NEXT[other(revoked)], deps), "premise: now the frozen seat's turn").toEqual(APPLIED);
        for (const action of [
          { kind: "move", uci: NEXT[revoked] },
          { kind: "draw", accept: true },
          { kind: "resign" },
          { kind: "abort" },
        ] as const satisfies readonly PlayAction[]) {
          await expect(by(g, revoked, action, deps), `${revoked} ${turn} ${action.kind}`).rejects.toMatchObject(NOT_FOUND);
          checked++;
        }
      }
      expect(calls.map((c) => c.token), "only the innocent's one move reached Lichess").toEqual([tokenOf(g[other(revoked)])]);
      expect(sent.length).toBe(1);
      expect(reconciles).toEqual([]);
      expect((await ledger(g.fixtureId)).move_count).toBe(offTurn.move_count + 1);
    }
    expect(checked, "2 seats × 2 turns × 4 actions").toBe(16);
  });

  it("the innocent seat may decline a draw the frozen seat offered before its revoke — BOTH seats", async () => {
    let checked = 0;
    for (const revoked of ["white", "black"] as const) {
      const g = await revokedOffTurn(revoked, true);
      expect((await ledger(g.fixtureId)).draw_offer_by, "premise: the frozen seat's offer stands").toBe(revoked);
      const { deps, sent } = boardStub();
      expect(await by(g, other(revoked), { kind: "draw", accept: false }, deps)).toEqual(APPLIED);
      expect(await ledger(g.fixtureId)).toMatchObject({ draw_offer_by: null, status: "needs_organiser", revoked_seat: revoked });
      expect(sent.length).toBe(1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the innocent seat's OWN 401 widens the hold to both — then neither seat acts — BOTH orders", async () => {
    let checked = 0;
    for (const revoked of ["white", "black"] as const) {
      const innocent = other(revoked);
      const g = await revokedOffTurn(revoked);
      const refusing = boardStub(REFUSE_401);
      expect(await mv(g, innocent, NEXT[innocent], refusing.deps)).toEqual(reconcile("unauthorized"));
      expect(refusing.reconciles, "a refused move asks reconcile").toEqual(["rejected_move"]);
      expect(await ledger(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "both" });
      const { calls, deps } = boardStub();
      for (const who of ["white", "black"] as const) {
        await expect(mv(g, who, NEXT[who], deps), who).rejects.toMatchObject(NOT_FOUND);
      }
      expect(calls).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a revoke that WIDENS to the innocent seat while its move is in flight: the write re-checks the row and records nothing", async () => {
    // Staged: the hold lands between T10's read of the row and its append —
    // inside the Lichess call. The SQL predicate, not the read, decides.
    let checked = 0;
    for (const revoked of ["white", "black"] as const) {
      const innocent = other(revoked);
      const g = await revokedOffTurn(revoked);
      const before = await ledger(g.fixtureId);
      let landed = false;
      const { deps } = boardStub(async () => {
        await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked", seat: innocent });
        landed = true;
        return { ok: true };
      });
      expect(await mv(g, innocent, NEXT[innocent], deps), "Lichess took it; the ledger is reconcile's to adopt").toEqual(ABSORBED);
      expect(landed, "the stage fired").toBe(true);
      expect(await ledger(g.fixtureId)).toMatchObject({ move_count: before.move_count, revoked_seat: "both", status: "needs_organiser" });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

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

  it("a move Lichess accepted that chess.js cannot replay is RECORDED (Lichess is the authority) but never broadcast — named `unreplayable`, never the `unavailable` that means it may not have landed", async () => {
    const g = await readyGame();
    const errors = vi.spyOn(log, "error");
    try {
      const { sent, deps } = boardStub();
      // e2e5 is well-formed and illegal; this "Lichess" accepts it anyway.
      expect(await mv(g, "white", "e2e5", deps)).toEqual(reconcile("unreplayable"));
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

// ---------------------------------------------------------------------------
// Non-canonical UCI (review I1). lila plays two well-formed strings chess.js
// cannot replay — lila source, not measured; live measurement owed (T17):
//   scalachess @ 2ab0a403 Position.scala:401 — a standard castle takes BOTH
//   its rook's square and the king's target as the king's destination
//   (`destInput = List(rook, kingTo)`), so `e1h1` is O-O;
//   variant/Variant.scala:112-117 `findMove` — a pawn move to the last rank
//   with no suffix is played as a queen.
// Recorded verbatim, either one froze every later broadcast (the reviewer's
// probe: 9 moves recorded, 6 broadcast). The castle is rewritten to the
// king's own move before submit; the suffix-less promotion is refused.

/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3 d6 5.Nc3 Nf6 6.Be3 Be6 7.Qd2 Qd7 — both
 *  sides may castle on either wing; White to move. */
const CASTLE_READY = [
  "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "d2d3", "d7d6", "b1c3", "g8f6", "c1e3", "c8e6", "d1d2", "d8d7",
];
/** 1.a4 b5 2.axb5 a6 3.bxa6 Bb7 4.axb7 Nc6 — White's pawn on b7 may promote
 *  on b8 or capture on a8; White to move. */
const PROMO_READY = ["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "b8c6"];

// FENs written out as literals (from the SAN castles O-O / O-O-O — never
// through our UCI path).
const CASTLES = [
  { who: "white", raw: "e1h1", canonical: "e1g1", before: [], reply: "a7a6",
    fen: "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R4RK1 b kq - 7 8" },
  { who: "white", raw: "e1a1", canonical: "e1c1", before: [], reply: "a7a6",
    fen: "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/2KR3R b kq - 7 8" },
  { who: "black", raw: "e8h8", canonical: "e8g8", before: ["h2h3"], reply: "a2a3",
    fen: "r4rk1/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN1P/PPPQ1PP1/R3K2R w KQ - 1 9" },
  { who: "black", raw: "e8a8", canonical: "e8c8", before: ["h2h3"], reply: "a2a3",
    fen: "2kr3r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN1P/PPPQ1PP1/R3K2R w KQ - 1 9" },
] as const;

describe.runIf(HAS_DB)("act — non-canonical UCI lila would play (review I1)", () => {
  it("a castle sent KING-TO-ROOK is submitted, recorded and broadcast as the king's move — both colours, both wings; the king's-target form is the same move; the game goes on", async () => {
    let checked = 0;
    for (const c of CASTLES) {
      for (const form of [c.raw, c.canonical]) {
        const label = `${c.who} ${form}`;
        const g = await readyGame();
        const { calls, sent, deps } = boardStub();
        await playOut(g, [...CASTLE_READY, ...c.before], deps);
        expect(await mv(g, c.who, form, deps), label).toEqual(APPLIED);
        expect(calls.at(-1)?.uci, `${label}: Lichess is sent the king's own move`).toBe(c.canonical);
        expect(sent.at(-1)?.body, label).toMatchObject({ fen: c.fen, lastMove: c.canonical });
        // The probe's failure was every LATER move: the reply still plays and broadcasts.
        expect(await mv(g, c.who === "white" ? "black" : "white", c.reply, deps), `${label}: the reply`).toEqual(APPLIED);
        const l = await ledger(g.fixtureId);
        expect(l.moves_uci, label).toEqual([...CASTLE_READY, ...c.before, c.canonical, c.reply]);
        expect(sent.length, `${label}: one broadcast per recorded move`).toBe(l.move_count);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 colours × 2 wings × 2 forms").toBe(8);
  });

  it("a castle sent king-to-rook and refused (5xx) tells reconcile the move in the form it is RECORDED — the king's own move, at its ply (review N1)", async () => {
    let checked = 0;
    for (const c of CASTLES) {
      const g = await readyGame();
      const ok = boardStub();
      await playOut(g, [...CASTLE_READY, ...c.before], ok.deps);
      const ply = CASTLE_READY.length + c.before.length;
      const { calls, submissions, deferredTasks, deps } = boardStub(() => ({ ok: false, code: "unavailable", raw: "502" }));
      expect(await mv(g, c.who, c.raw, deps), c.raw).toEqual(reconcile("unavailable"));
      await Promise.all(deferredTasks);
      expect(calls.at(-1)?.uci, "premise: Lichess was sent the king's own move").toBe(c.canonical);
      expect(submissions, `${c.who} ${c.raw}`).toEqual([{ ply, uci: c.canonical }]);
      checked++;
    }
    expect(checked, "2 colours × 2 wings").toBe(CASTLES.length);
  });

  it("a king-to-rook string is sent AS IT CAME when castling is not legal — at the start, and after the king walked and came back", async () => {
    let checked = 0;
    for (const [label, line] of [
      ["start position", []],
      ["castling rights lost (Kf1 a6 Ke1 a5)", [...CASTLE_READY, "e1f1", "a7a6", "f1e1", "a6a5"]],
    ] as const) {
      const g = await readyGame();
      const { calls, sent, deps } = boardStub((c) =>
        c.uci === "e1h1" ? { ok: false, code: "unavailable", raw: "400 Piece on e1 cannot move to h1" } : { ok: true },
      );
      await playOut(g, [...line], deps);
      expect(await mv(g, "white", "e1h1", deps), label).toEqual(reconcile("unavailable"));
      expect(calls.at(-1)?.uci, `${label}: not rewritten — Lichess judges it`).toBe("e1h1");
      expect((await ledger(g.fixtureId)).moves_uci, label).toEqual([...line]);
      expect(sent.length, label).toBe(line.length);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a promotion with NO suffix is refused 400 INVALID_UCI and sent nowhere — lila would pick a queen; with a suffix it plays", async () => {
    // Single colour: the rank is the side-to-move's own last rank by
    // chess.js's legal list, not a literal in our code.
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    await playOut(g, PROMO_READY, deps);
    const before = await ledger(g.fixtureId);
    let refused = 0;
    for (const raw of ["b7b8", "b7a8"]) {
      await expect(mv(g, "white", raw, deps), raw).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
      refused++;
    }
    expect(refused, "anti-vacuity: push and capture").toBe(2);
    expect(calls.length, "nothing reached Lichess").toBe(PROMO_READY.length);
    expect(sent.length, "nothing broadcast").toBe(PROMO_READY.length);
    expect(await ledger(g.fixtureId)).toEqual(before);
    expect(await mv(g, "white", "b7a8n", deps), "the under-promotion, suffixed").toEqual(APPLIED);
    expect(calls.at(-1)?.uci).toBe("b7a8n");
    expect(sent.at(-1)?.body).toMatchObject({ fen: "N2qkbnr/2pppppp/2n5/8/8/8/1PPPPPPP/RNBQKBNR b KQk - 0 5", lastMove: "b7a8n" });
  });

  it("a ROOK reaching the last rank with no suffix is not a promotion — it plays", async () => {
    const g = await readyGame();
    const { calls, sent, deps } = boardStub();
    await playOut(g, PROMO_READY, deps);
    expect(await mv(g, "white", "a1a8", deps)).toEqual(APPLIED);
    expect(calls.at(-1)?.uci).toBe("a1a8");
    expect(sent.at(-1)?.body).toMatchObject({ fen: "R2qkbnr/1Ppppppp/2n5/8/8/8/1PPPPPPP/1NBQKBNR b Kk - 0 5" });
  });

  it("a twin tab RE-SENDING the castle in either form is absorbed — canonical against canonical; the next real move still plays", async () => {
    let checked = 0;
    for (const [first, retap] of [["e1h1", "e1h1"], ["e1h1", "e1g1"], ["e1g1", "e1h1"]] as const) {
      const label = `${first} then ${retap}`;
      const g = await readyGame();
      const { calls, sent, deps } = boardStub();
      await playOut(g, CASTLE_READY, deps);
      expect(await mv(g, "white", first, deps), label).toEqual(APPLIED);
      const n = calls.length;
      expect(await mv(g, "white", retap, deps), label).toEqual(ABSORBED);
      expect(calls.length, `${label}: the retap never reached Lichess`).toBe(n);
      expect(await mv(g, "black", "a7a6", deps), `${label}: the reply`).toEqual(APPLIED);
      const l = await ledger(g.fixtureId);
      expect(l.moves_uci, label).toEqual([...CASTLE_READY, "e1g1", "a7a6"]);
      expect(sent.length, `${label}: one broadcast per recorded move`).toBe(l.move_count);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("twin tabs, one sending e1g1 and one e1h1: Lichess refuses the second after the first is recorded ⇒ absorbed, not reconciled", async () => {
    const g = await readyGame();
    const setup = boardStub();
    await playOut(g, CASTLE_READY, setup.deps);
    const { deps, refusedTab } = twinTabs(g, "e1g1", "e1g1", undefined, CASTLE_READY);
    const results = await Promise.all([mv(g, "white", "e1g1", deps), mv(g, "white", "e1h1", deps)]);
    expect(refusedTab(), "premise: the M6 path ran").toBe(true);
    expect(results.sort((a, b) => Number(b.ok && b.applied) - Number(a.ok && a.applied))).toEqual([APPLIED, ABSORBED]);
    expect((await ledger(g.fixtureId)).moves_uci).toEqual([...CASTLE_READY, "e1g1"]);
  });

  it("on a ledger chess.js cannot follow, nothing is rewritten — Lichess judges the string as sent", async () => {
    // This stub "Lichess" accepts h2h5, which chess.js rejects, so
    // our replay stops at ply 14 — a position where White COULD castle.
    const g = await readyGame();
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      const { calls, deps } = boardStub();
      await playOut(g, CASTLE_READY, deps);
      await mv(g, "white", "h2h5", deps);
      await mv(g, "black", "a7a6", deps);
      await mv(g, "white", "e1h1", deps);
      expect(calls.at(-1)?.uci, "not judged against a position chess.js only half-knows").toBe("e1h1");
    } finally {
      errors.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// A move that ENDS the game (review I2, controller ruling). T10 reports the
// end so T14 can reconcile at once; it adjudicates nothing and writes no
// status. `ended` is lila's automatic end on a move (scalachess @ 2ab0a403
// Position.scala:80 `end = checkMate || staleMate || autoDraw …`) limited by
// the ruling to checkmate, stalemate and insufficient material — the
// expected value below is chess.js's own predicate on an independent
// replay, never play.ts.

/** The reference board after `line`, replayed by the test. */
const boardAfter = (line: readonly string[]) => {
  const b = new Chess();
  for (const m of line) b.move(uciMove(m));
  return b;
};

const ENDINGS = [
  { name: "checkmate (Fool's mate)", is: (b: Chess) => b.isCheckmate(),
    line: ["f2f3", "e7e5", "g2g4", "d8h4"] },
  { name: "stalemate (Loyd's ten-move stalemate)", is: (b: Chess) => b.isStalemate(),
    line: ["e2e3", "a7a5", "d1h5", "a8a6", "h5a5", "h7h5", "h2h4", "a6h6", "a5c7", "f7f6", "c7d7", "e8f7", "d7b7",
      "d8d3", "b7b8", "d3h7", "b8c8", "f7g6", "c8e6"] },
  { name: "insufficient material (bare kings, Kxe6)", is: (b: Chess) => b.isInsufficientMaterial(),
    line: ["a2a4", "b8c6", "g1h3", "h7h6", "b2b4", "c6b4", "c2c4", "b4a2", "a1a2", "g8f6", "h3g5", "h6g5", "a4a5",
      "h8h2", "h1h2", "f6g4", "h2h5", "g4f2", "e1f2", "a8b8", "h5g5", "f7f5", "g5g7", "f8g7", "d1e1", "f5f4", "a2a1",
      "g7a1", "d2d3", "b7b6", "c1f4", "b6a5", "f4c7", "d8c7", "e1a5", "b8b1", "a5a1", "b1f1", "f2f1", "c7c4", "a1a7",
      "c4d3", "a7d7", "e8d7", "e2d3", "d7d6", "f1g1", "c8f5", "g1h1", "f5d3", "g2g4", "d3f5", "g4f5", "d6c6", "h1g1",
      "c6d6", "g1f2", "e7e6", "f5e6", "d6e6"] },
] as const;

describe.runIf(HAS_DB)("act — a move that ENDS the game (review I2)", () => {
  it("checkmate, stalemate and insufficient material each answer ended:true — the row stays 'live', the move is broadcast, nothing is adjudicated", { timeout: 60_000 }, async () => {
    let checked = 0;
    for (const e of ENDINGS) {
      const ref = boardAfter(e.line);
      expect(e.is(ref), `premise: chess.js calls ${e.name}`).toBe(true);
      expect(boardAfter(e.line.slice(0, -1)).isGameOver(), `premise: ${e.name} is reached by the LAST move`).toBe(false);
      const g = await readyGame();
      const { sent, deps } = boardStub();
      await playOut(g, e.line.slice(0, -1), deps);
      const who = (e.line.length - 1) % 2 === 0 ? "white" : "black";
      expect(await mv(g, who, e.line.at(-1)!, deps), e.name).toEqual({ ok: true, applied: true, ended: true });
      const l = await ledger(g.fixtureId);
      expect(l, `${e.name}: T10 writes no result`).toMatchObject({ status: "live", moves_uci: [...e.line] });
      expect(sent.length, `${e.name}: the ending move is broadcast like any other`).toBe(e.line.length);
      expect(sent.at(-1)?.body, e.name).toMatchObject({ fen: ref.fen(), status: "started" });
      checked++;
    }
    expect(checked, "anti-vacuity: three endings").toBe(3);
  });

  it("the FIFTY-move rule ends the game on the 100th half-move without a pawn move or capture — ended:true; at 99 it is absent", { timeout: 60_000 }, async () => {
    // scalachess @ 2ab0a403 variant/Variant.scala:146-147, 172-173: lila's
    // autoDraw includes `halfMoveClock >= 100`. Knights only — no pawn move,
    // no capture, no check, no position more than twice (so no fivefold) —
    // found by a DFS over chess.js's legal moves and written in as a literal.
    const line: string[] = ["b1a3","b8c6","a3b5","g8h6","b5d4","c6b8","d4b5","b8c6","b5d4","c6b8","d4b5","b8a6","b5d4","a6c5","d4b5","h6g8","b5d4","g8h6","d4b5","h6g8","b5d4","g8f6","d4b5","f6h5","b5d4","c5a6","d4b5","a6b8","b5d4","b8c6","d4b5","c6b8","b5d4","b8c6","d4b5","c6e5","b5d4","e5g6","d4b5","g6h4","b5d4","h5f6","d4b5","f6g8","b5d4","g8h6","d4b5","h6g8","b5d4","g8h6","d4b5","h6g4","b5d4","g4e5","d4b5","e5c6","b5d4","c6b8","d4b5","b8c6","b5d4","c6b8","d4b5","b8a6","b5d4","a6c5","d4b5","c5a6","b5d4","a6c5","d4b5","c5e6","b5d4","e6g5","d4b5","g5e6","b5d4","e6g5","d4b5","g5h3","b5d4","h4f5","d4b5","f5d6","b5d4","d6f5","d4b5","f5d6","b5d4","d6e4","d4b5","e4c5","b5d4","c5a6","d4b5","a6b8","b5d4","b8c6","d4b5","c6b8"];
    expect(line.length, "premise: exactly 100 half-moves").toBe(100);
    const at99 = boardAfter(line.slice(0, 99));
    const at100 = boardAfter(line);
    // Hand-written: b1-knight on b5, g8-knight on h3, b8-knight home again.
    const FEN_100 = "rnbqkb1r/pppppppp/8/1N6/8/7n/PPPPPPPP/R1BQKBNR w KQkq - 100 51";
    expect(at100.fen(), "premise: the hand-written position, half-move clock 100").toBe(FEN_100);
    expect(at99.fen().split(" ")[4], "premise: the neighbour's clock").toBe("99");
    expect([at99.isDrawByFiftyMoves(), at100.isDrawByFiftyMoves()], "premise: chess.js's own fifty-move predicate").toEqual([false, true]);
    expect(at100.isCheckmate() || at100.isStalemate() || at100.isInsufficientMaterial(), "premise: nothing else ends it").toBe(false);
    const g = await readyGame();
    const { sent, deps } = boardStub();
    await playOut(g, line.slice(0, 98), deps);
    expect(await mv(g, "white", line[98]!, deps), "half-move 99").toStrictEqual(APPLIED);
    expect(await mv(g, "black", line[99]!, deps), "half-move 100").toEqual({ ok: true, applied: true, ended: true });
    expect(await ledger(g.fixtureId), "T10 writes no result").toMatchObject({ status: "live", move_count: 100 });
    expect(sent.length).toBe(100);
    expect(sent.at(-1)?.body).toMatchObject({ fen: FEN_100, status: "started" });
  });

  it("a move that ends nothing carries NO `ended` — nor does a threefold repetition, which chess.js calls over and lila leaves to a claim", async () => {
    const cases = [
      { name: "an opening move", line: ["e2e4"], overByChessJs: false },
      // Nf3 Nf6 Ng1 Ng8 twice: the start position for the third time.
      { name: "threefold repetition", line: ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"], overByChessJs: true },
    ];
    let checked = 0;
    for (const c of cases) {
      const ref = boardAfter(c.line);
      expect(ref.isGameOver(), `premise: chess.js's own isGameOver for ${c.name}`).toBe(c.overByChessJs);
      expect(ref.isCheckmate() || ref.isStalemate() || ref.isInsufficientMaterial(), `premise: ${c.name}`).toBe(false);
      const g = await readyGame();
      const { deps } = boardStub();
      await playOut(g, c.line.slice(0, -1), deps);
      const who = (c.line.length - 1) % 2 === 0 ? "white" : "black";
      expect(await mv(g, who, c.line.at(-1)!, deps), c.name).toStrictEqual(APPLIED);
      checked++;
    }
    expect(checked).toBe(2);
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
        // V434's policy matches `external-play:{lobby_fixture_id}`, so riding
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
      else if (this.board.isStalemate() || this.board.isInsufficientMaterial() || this.board.isDrawByFiftyMoves()) this.over = "draw";
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
        const pending: Promise<void>[] = [];
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
          // T11's reconcile is NOT this property's subject: a no-op stands in,
          // deferred through a collected task so nothing runs past the case
          // (re-review 2, R1). Counted below so the stand-in is not vacuous.
          reconcile: async (_f, trigger) => {
            expect(trigger).toBe("rejected_move");
            bump("noop_reconcile_reached");
          },
          defer: (task) => {
            bump("noop_defer_reached");
            pending.push(task());
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
            // A move that ends lila's game says so (review I2) — the model's
            // own end, not T10's arithmetic.
            expect(r, "Lichess accepted it ⇒ applied").toEqual(lila.over === null ? APPLIED : { ...APPLIED, ended: true });
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
        await Promise.all(pending);
      }),
      { numRuns: RUNS_PER_PREFIX, endOnFailure: true },
    );
    expect(runs, "anti-vacuity: the property ran").toBe(NUM_RUNS);
    console.info(`[T10 property] runs=${runs} ${JSON.stringify(totals)}`);
    // R1: every refused move reached the no-op stand-ins, never the real reconcile.
    expect(totals.noop_reconcile_reached ?? 0, "anti-vacuity: the no-op reconcile was reached").toBeGreaterThan(0);
    expect(totals.noop_defer_reached, "one deferral per reconcile").toBe(totals.noop_reconcile_reached);
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

// ---------------------------------------------------------------------------
// The property for RAW move strings (review I1). The interleavings property
// above draws its moves from chess.js's own legal list and judges them with
// chess.js, so it cannot see a string lila plays that chess.js does not
// know. Here the strings are raw — the king-to-rook castles, promotions with
// and without a suffix, and arbitrary well-formed UCI — and "Lichess" is a
// model of scalachess's own move lookup (lila source, not measured — T17):
//   variant/Variant.scala:116-117 `findMove`: a legal move whose destination
//   is `to` and whose promotion is the suffix given, or a queen when none is
//   given and the move promotes;
//   Position.scala:401: a standard castle's destinations are the rook's
//   square AND the king's target.
// lila records the move it played in its own (king's-target) notation.

type RawOp = { k: "raw"; uci: string } | { k: "legal"; pick: number } | { k: "retap" };

/** scalachess's `findMove`, over chess.js's legal list: the move lila plays
 *  for `raw`, or null when it refuses. */
function lilaFinds(board: Chess, raw: string): { lan: string; promotes: boolean; castleToRook: boolean } | null {
  const to = raw.slice(2, 4);
  const suffix = raw.length > 4 ? raw.slice(4) : null;
  for (const m of board.moves({ square: raw.slice(0, 2) as never, verbose: true })) {
    const corner = m.isKingsideCastle() ? `h${m.from[1]}` : m.isQueensideCastle() ? `a${m.from[1]}` : null;
    const dests = corner === null ? [m.to] : [m.to, corner];
    const wanted = suffix ?? (m.promotion !== undefined ? "q" : null);
    if (dests.includes(to) && (m.promotion ?? null) === wanted) {
      return { lan: m.lan, promotes: m.promotion !== undefined, castleToRook: corner === to };
    }
  }
  return null;
}

const FILES = "abcdefgh";
const sqArb = fc.integer({ min: 0, max: 63 }).map((i) => `${FILES[i % 8]}${Math.floor(i / 8) + 1}`);
const suffixArb = fc.option(fc.constantFrom("q", "r", "b", "n"), { nil: "" });
const rawArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("e1h1", "e1a1", "e8h8", "e8a8") },
  { weight: 2, arbitrary: fc.constantFrom("e1g1", "e1c1", "e8g8", "e8c8") },
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: -1, max: 1 }), fc.boolean(), suffixArb)
      .filter(([f, d]) => f + d >= 0 && f + d <= 7)
      .map(([f, d, white, s]) => `${FILES[f]}${white ? "7" : "2"}${FILES[f + d]}${white ? "8" : "1"}${s}`),
  },
  { weight: 3, arbitrary: fc.tuple(sqArb, sqArb, suffixArb).map(([a, b, s]) => `${a}${b}${s}`) },
);
const rawOpArb: fc.Arbitrary<RawOp> = fc.oneof(
  { weight: 6, arbitrary: rawArb.map((uci) => ({ k: "raw" as const, uci })) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("legal" as const), pick: fc.nat(80) }) },
  { weight: 2, arbitrary: fc.constant({ k: "retap" as const }) },
);
const raw = (uci: string): RawOp => ({ k: "raw", uci });
const RAW_PREFIXES: RawOp[][] = [
  [],
  [...CASTLE_READY.map(raw), raw("e1h1")],
  [...CASTLE_READY.map(raw), raw("e1a1")],
  [...CASTLE_READY.map(raw), raw("h2h3"), raw("e8h8")],
  [...CASTLE_READY.map(raw), raw("h2h3"), raw("e8a8")],
  [...CASTLE_READY.map(raw), raw("e1h1"), { k: "retap" }],
  [...PROMO_READY.map(raw), raw("b7b8")],
  [...PROMO_READY.map(raw), raw("b7a8n")],
];

describe.runIf(HAS_DB)("act — property: raw move strings against scalachess's move lookup", () => {
  const RUNS_PER_PREFIX = 3;
  const totals: Record<string, number> = {};
  const bump = (k: string, n = 1) => (totals[k] = (totals[k] ?? 0) + n);

  it("whatever string lila would play is recorded in lila's notation, replays, and is broadcast once; a suffix-less promotion is refused unsent; a retap in any form is absorbed", { timeout: 600_000 }, async () => {
    let runs = 0;
    const tailArb = fc.array(rawOpArb, { minLength: 0, maxLength: 16, size: "max" });
    for (const prefix of RAW_PREFIXES) await fc.assert(
      fc.asyncProperty(tailArb.map((tail) => [...prefix, ...tail]), async (ops) => {
        runs++;
        const g = await readyGame();
        const lila = new Chess();
        const lilaMoves: string[] = [];
        let calls: string[] = [];
        let published = 0;
        let lastRecorded: { who: Who; raw: string } | null = null;
        const pending: Promise<void>[] = [];
        const deps: PlayDeps = {
          submitMove: async (x) => {
            calls.push(x.uci);
            const found = lilaFinds(lila, x.uci);
            if (found === null) return clientError(`Piece on ${x.uci.slice(0, 2)} cannot move to ${x.uci.slice(2, 4)}`);
            lila.move(uciMove(found.lan));
            lilaMoves.push(found.lan);
            return OK;
          },
          publish: async () => {
            published++;
          },
          // T11's reconcile is NOT this property's subject: a no-op stands in,
          // deferred through a collected task so nothing runs past the case
          // (re-review 2, R1). Counted below so the stand-in is not vacuous.
          reconcile: async (_f, trigger) => {
            expect(trigger).toBe("rejected_move");
            bump("noop_reconcile_reached");
          },
          defer: (task) => {
            bump("noop_defer_reached");
            pending.push(task());
          },
        };
        for (const op of ops) {
          if (lila.isGameOver()) {
            bump("skip:game_over");
            break;
          }
          const before = await ledger(g.fixtureId);
          const turn: Who = before.move_count % 2 === 0 ? "white" : "black";
          let who = turn;
          let sentRaw: string;
          if (op.k === "retap") {
            if (lastRecorded === null) {
              bump("skip:retap_before_any_move");
              continue;
            }
            who = lastRecorded.who;
            sentRaw = lastRecorded.raw;
          } else if (op.k === "legal") {
            const legal = lila.moves({ verbose: true });
            sentRaw = legal[op.pick % legal.length]!.lan;
          } else sentRaw = op.uci;
          const found = op.k === "retap" ? null : lilaFinds(lila, sentRaw);
          calls = [];
          published = 0;
          let result: PlayResult | null = null;
          let thrown: { status?: number; code?: string } | null = null;
          try {
            result = await act({ fixtureId: g.fixtureId, personId: g[who].personId, action: { kind: "move", uci: sentRaw } }, deps);
          } catch (err) {
            const e = err as { status?: number; code?: string };
            thrown = { status: e.status, code: e.code };
          }
          const after = await ledger(g.fixtureId);

          if (op.k === "retap") {
            // The tab one move behind re-sends what it sent: already on file.
            expect(result, `retap ${sentRaw}`).toEqual(ABSORBED);
            expect(calls, "a retap never reaches Lichess").toEqual([]);
            bump(sentRaw === before.moves_uci.at(-1) ? "retap_absorbed_same" : "retap_absorbed_other_form");
          } else if (found !== null && found.promotes && sentRaw.length === 4) {
            expect(thrown, `${sentRaw}: lila would pick a queen`).toEqual({ status: 400, code: "INVALID_UCI" });
            expect(calls, "refused unsent").toEqual([]);
            bump("suffixless_promotion_refused");
          } else if (found !== null) {
            expect(thrown, sentRaw).toBeNull();
            expect(calls, `${sentRaw}: Lichess is sent lila's own notation`).toEqual([found.lan]);
            expect(result?.ok && result.applied, sentRaw).toBe(true);
            expect(after.moves_uci, "recorded as lila records it").toEqual([...before.moves_uci, found.lan]);
            lastRecorded = { who, raw: sentRaw };
            if (found.castleToRook) bump(`castle_to_rook:${who}:${sentRaw.slice(2, 3)}`);
            else if (found.promotes) bump("suffixed_promotion_recorded");
            else bump(op.k === "legal" ? "legal_recorded" : "raw_recorded");
          } else {
            expect(thrown, sentRaw).toBeNull();
            expect(calls, `${sentRaw}: lila refuses it — sent as it came`).toEqual([sentRaw]);
            expect(result, sentRaw).toEqual(reconcile("unavailable"));
            bump("raw_refused_by_lila");
          }

          // ---- invariants ----------------------------------------------------
          expect(after.moves_uci, "the ledger IS lila's game").toEqual(lilaMoves);
          const replay = replayLedger(after.moves_uci);
          expect(replay.illegalAt, "the ledger replays (independent chess.js replay)").toBeNull();
          bump("plies_checked", replay.turnsChecked);
          expect(published, "one broadcast per recorded move, none otherwise").toBe(after.move_count - before.move_count);
          bump("broadcasts_checked", published);
          bump("ops");
        }
        await Promise.all(pending);
      }),
      { numRuns: RUNS_PER_PREFIX, endOnFailure: true },
    );
    expect(runs, "anti-vacuity: the property ran").toBe(RUNS_PER_PREFIX * RAW_PREFIXES.length);
    console.info(`[T10 raw-UCI property] runs=${runs} ${JSON.stringify(totals)}`);
    // R1: every refused move reached the no-op stand-ins, never the real reconcile.
    expect(totals.noop_reconcile_reached ?? 0, "anti-vacuity: the no-op reconcile was reached").toBeGreaterThan(0);
    expect(totals.noop_defer_reached, "one deferral per reconcile").toBe(totals.noop_reconcile_reached);
    let checked = 0;
    for (const path of [
      "castle_to_rook:white:h",
      "castle_to_rook:white:a",
      "castle_to_rook:black:h",
      "castle_to_rook:black:a",
      "retap_absorbed_same",
      "retap_absorbed_other_form",
      "suffixless_promotion_refused",
      "suffixed_promotion_recorded",
      "legal_recorded",
      "raw_recorded",
      "raw_refused_by_lila",
      "plies_checked",
      "broadcasts_checked",
    ]) {
      expect(totals[path] ?? 0, `anti-vacuity: ${path}`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(13);
  });
});
