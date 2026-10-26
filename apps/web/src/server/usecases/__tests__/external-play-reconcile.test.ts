// Reconcile (chess in-page board design §3.5, Task 11): the ONE read that
// brings our bridge row in line with Lichess's truth on five triggers, closes
// a finished game and hands its result to T12's writer.
//
// Lichess is served by a fake WIRE behind the REAL Board API client
// (`createBoardApi`): every line it serves is a RECORDING made 2026-10-11
// (fixtures README — ids substituted, never a game fact), or a synthetic
// shape whose source is named beside it. Expected values come from those
// recordings, the spec, lila's source as cited, or the engine's own
// declarations — never from reconcile.ts. Tokens are the seed's REAL sealed
// tokens, opened by the real `getLichessAccessToken`.
//
// Every game starts as T9's REAL producer leaves it (`createGameIfReady`,
// its Board API calls module-mocked); a 'live' one got there through T10's
// real `act`; results go through T12's real `writeResultFrom`. Rows edited by
// SQL are labelled with the writer they stand for.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`); reconcile adds no sport branch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { Chess } from "chess.js";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { RoomBroadcast } from "@/lib/realtime";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
// The mocked module's read IS the real client wired to the fake Lichess.
import { exportGame as wiredExportGame, readGameStream as wiredReadGameStream } from "@/server/external-play/lichess/board-api";
import { NEEDS_REASONS, type BoardCall } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { FLAG_CHECK_MS } from "../../../../e2e/lichess-fixture-server";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { listFlaggedExternalPlay, loadArbiterRound, resyncExternalPlay } from "../external-play/arbiter";
import { closeExternalPlayFlags } from "../external-play/flags";
import { listRunSheetOnlinePlay } from "../external-play/run-sheet";
import { createGameIfReady } from "../external-play/create-game";
import { closeBridgeIfUnplayable } from "../external-play/bridge-close";
import { act } from "../external-play/play";
import {
  CLOCK_MS_COLUMN_MAX,
  FLAG_SETTLE_HOLD_MS,
  FLAG_UNASKED_HOLD_MS,
  FLAG_UNSETTLED_HOLD_MS,
  RECONCILE_TRIGGERS,
  reconcile,
  revokedSeatOf,
  uciFromSan,
  type ReconcileDeps,
  type ReconcileTrigger,
} from "../external-play/reconcile";
import { holdForOrganiser } from "../external-play/result";
import { RESOLVE_KINDS, resolveExternalPlay } from "../external-play/resolve";
import type { AuthCtx } from "@/server/api-v1/auth";
import { offersSettle } from "@/lib/arbiter-view";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture } from "./_external-play-seed";
import { RealtimeKitDeferred, endMeeting, ensureMeeting } from "@/server/external-play/video/realtimekit";
import { endRoomAtResult } from "../external-play/room-end";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { after } from "next/server";

const HAS_DB = !!process.env.DATABASE_URL;

// T9's creation and T10's play consume the Board API: module-mocked at its
// boundary, every default REFUSING. The two reads reconcile makes —
// readGameStream and exportGame — are the REAL client, wired to the fake
// Lichess below, so the recorded bytes go through the real parser.
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
type Reply = { status: number; body: string };
const lichess = vi.hoisted(() => {
  type Answer = { status: number; body: string };
  type Wire = {
    calls: { kind: "stream" | "export" | "other"; gameId: string; token: string | null }[];
    /** D11: the holdMs of every SETTLING stream read, in order (a first-line read records nothing). */
    holds: number[];
    /** May be async: a case interleaves a write DURING a read (the settling read holds the stream ~9 s in life). */
    onStream: (c: { gameId: string; token: string | null }) => Answer | Promise<Answer>;
    onExport: (c: { gameId: string }) => Answer;
    reset(): void;
    serve(url: string, init?: RequestInit): Promise<Response>;
  };
  const refused = (what: string): Answer => ({ status: 503, body: `no ${what} scripted` });
  const state: Wire = {
    calls: [],
    holds: [],
    onStream: () => refused("stream"),
    onExport: () => refused("export"),
    reset() {
      state.calls = [];
      state.holds.length = 0;
      state.onStream = () => refused("stream");
      state.onExport = () => refused("export");
    },
    async serve(url: string, init?: RequestInit): Promise<Response> {
      const u = new URL(url);
      const auth = new Headers(init?.headers).get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
      const stream = /^\/api\/board\/game\/stream\/([^/]+)$/.exec(u.pathname);
      if (stream) {
        const c = { kind: "stream" as const, gameId: decodeURIComponent(stream[1]!), token };
        state.calls.push(c);
        const r = await state.onStream(c);
        return new Response(r.body, { status: r.status });
      }
      const exported = /^\/game\/export\/([^/]+)$/.exec(u.pathname);
      if (exported) {
        const c = { kind: "export" as const, gameId: decodeURIComponent(exported[1]!), token };
        state.calls.push(c);
        const r = state.onExport(c);
        return new Response(r.body, { status: r.status });
      }
      state.calls.push({ kind: "other", gameId: u.pathname, token });
      return new Response("reconcile made an unexpected Lichess call", { status: 418 });
    },
  };
  return state;
});
// Wrapped, not replaced: outside a request scope the REAL after() throws and
// `deferred` falls back to running the task at once; one case (review N3)
// stands in for a request scope with mockImplementationOnce.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn(actual.after) };
});
vi.mock("@/server/external-play/lichess/board-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/external-play/lichess/board-api")>();
  const wired = real.createBoardApi({
    baseUrl: "https://lichess.test",
    fetch: ((input: string | URL | Request, init?: RequestInit) => lichess.serve(String(input), init)) as typeof fetch,
  });
  return {
    ...real,
    ...board,
    readGameStream: (a: Parameters<typeof wired.readGameStream>[0]) => {
      if ((a.holdMs ?? 0) > 0) lichess.holds.push(a.holdMs!);
      return wired.readGameStream(a);
    },
    exportGame: wired.exportGame,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  lichess.reset();
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

// ---------------------------------------------------------------------------
// The recordings (src/server/external-play/__fixtures__/lichess, README).
// ---------------------------------------------------------------------------
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../external-play/__fixtures__/lichess");
const fixtureText = (name: string) => readFileSync(join(FIX, name), "utf8");
type GameFullJson = {
  id: string;
  white: { id: string; name: string };
  black: { id: string; name: string };
  /** The game's time control, ms (lila BotJsonView). */
  clock: { initial: number; increment: number };
  state: {
    moves: string; wtime: number; btime: number; winc: number; binc: number;
    status: string; winner?: string; wdraw?: boolean; bdraw?: boolean;
  };
};
const recorded = (name: string): GameFullJson => JSON.parse(fixtureText(name).split("\n")[0]!) as GameFullJson;
const MID = recorded("gamefull-mid-white.ndjson"); // 8 plies, started (10:09:49Z)
const EXPIRED_1 = recorded("gamefull-expired-1.ndjson"); // started, wtime 0 (10:13:17Z)
const EXPIRED_2 = recorded("gamefull-expired-2.ndjson"); // outoftime, winner black (10:13:20Z)
const LINE: readonly string[] = MID.state.moves.split(" ");
/** The recorded export's SAN for the same game (export-expired.json). */
const SAN: readonly string[] = (JSON.parse(fixtureText("export-expired.json")) as { moves: string }).moves.split(" ");

type Colour = "white" | "black";
type Player = { entrantId: string; personId: string; userId: string; lichessId: string };
type Game = Awaited<ReturnType<typeof seedOnlineChessFixture>> & {
  gameId: string;
  white: Player;
  black: Player;
};

/** The seed's sealed token for a player (`_external-play-seed.ts` seedPlayer). */
const tokenOf = (p: Player) => `lio_seed_${p.lichessId}`;

/** A recorded line re-addressed to OUR game and players — ids only — with
 *  the overrides a case names (each override says where its shape comes from). */
type LineOver = Partial<{
  moves: readonly string[]; status: string; winner: Colour; wtime: number; btime: number; winc: number;
  wdraw: true; bdraw: true; gameId: string; whiteId: string | null; blackId: string | null;
}>;
function gameFull(g: Game, base: GameFullJson, over: LineOver = {}): string {
  const j = JSON.parse(JSON.stringify(base)) as GameFullJson;
  j.id = over.gameId ?? g.gameId;
  if (over.whiteId === null) delete (j.white as Partial<GameFullJson["white"]>).id;
  else j.white.id = j.white.name = over.whiteId ?? g.white.lichessId;
  if (over.blackId === null) delete (j.black as Partial<GameFullJson["black"]>).id;
  else j.black.id = j.black.name = over.blackId ?? g.black.lichessId;
  if (over.moves !== undefined) j.state.moves = over.moves.join(" ");
  if (over.status !== undefined) {
    j.state.status = over.status;
    delete j.state.winner;
  }
  if (over.winner !== undefined) j.state.winner = over.winner;
  if (over.wtime !== undefined) j.state.wtime = over.wtime;
  if (over.btime !== undefined) j.state.btime = over.btime;
  if (over.winc !== undefined) j.state.winc = j.state.binc = over.winc;
  if (over.wdraw) j.state.wdraw = true;
  if (over.bdraw) j.state.bdraw = true;
  return `${JSON.stringify(j)}\n`;
}
/** The recorded export re-addressed to our game; `moves` = a SAN prefix. */
function exported(g: Game, name: "export-mid.json" | "export-expired.json", over: { moves?: readonly string[]; status?: string; winner?: Colour | null } = {}): string {
  const j = JSON.parse(
    fixtureText(name).replaceAll("Rc11Game", g.gameId).replaceAll("rec-white", g.white.lichessId).replaceAll("rec-black", g.black.lichessId),
  ) as Record<string, unknown>;
  if (over.moves !== undefined) {
    j.moves = over.moves.join(" ");
    j.clocks = (j.clocks as number[]).slice(0, over.moves.length);
  }
  if (over.status !== undefined) j.status = over.status;
  if (over.winner !== undefined) {
    if (over.winner === null) delete j.winner;
    else j.winner = over.winner;
  }
  return JSON.stringify(j);
}
const ok = (body: string): Reply => ({ status: 200, body });
const status = (code: number): Reply => ({ status: code, body: code === 401 ? '{"error":"No such token"}' : "" });

// ---------------------------------------------------------------------------
// Games, through the real producers.
// ---------------------------------------------------------------------------
const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const CREATED = new Date("2026-10-01T12:05:00.000Z");
const MOVED = new Date("2026-10-01T12:11:00.000Z");
const READ = new Date("2026-10-01T12:20:00.000Z");
const later = (ms: number) => new Date(READ.getTime() + ms);
const DAY_MS = 86_400_000;
/** A sweep ten minutes after the last move. Always MOVED-relative, NEVER the real clock: a reconcile that adds the time since
 *  `last_move_at` back onto a clock writes `white_ms`/`black_ms` (int4), so `new Date()` against these 2026-10-01 anchors made
 *  three tests fail from 2026-10-26 08:42Z (anchor + 24.855 d = 2^31 - 1 ms) - `value "2151706946" is out of range for type integer`. */
const SWEEP_AT = new Date(MOVED.getTime() + 10 * 60_000);

async function seed(): Promise<Awaited<ReturnType<typeof seedOnlineChessFixture>>> {
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: 300, increment: 3 },
  });
}

/** T9's real producer: 'ready', colours recorded (home = White). */
async function readyGame(over: { kind?: string; legacyCfg?: boolean } = {}): Promise<Game> {
  const s = await seed();
  if (over.kind) await sql`update stages set kind = ${over.kind} where id = ${s.stageId}`;
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  expect(await createGameIfReady(s.fixtureId, { now: CREATED, publish: async () => {} }), "premise: T9 created the game").toEqual({ created: true, gameId });
  if (over.legacyCfg) {
    // Standing for a fixture frozen before W2a: a bracket draw then finishes
    // through needs_decision (result test, readyGame legacyCfg).
    const { resolveFixtureCfg } = await import("@/server/engine-db/fixture-cfg");
    const { boardgame } = await import("@seazn/engine/sports/boardgame");
    const [row] = await sql<{ dcfg: unknown; scfg: Record<string, unknown> | null }[]>`
      select d.config as dcfg, st.config as scfg
        from fixtures f join divisions d on d.id = f.division_id join stages st on st.id = f.stage_id
       where f.id = ${s.fixtureId}`;
    const cfg = resolveFixtureCfg({ config_snapshot: null, rules_override: null }, row!.dcfg, { kind: "league", config: row!.scfg }, boardgame);
    await sql`update fixtures set config_snapshot = ${sql.json(cfg as never)}, config_snapshot_at = now() where id = ${s.fixtureId}`;
  }
  return { ...s, gameId, white: s.home, black: s.away };
}

/** T10's real `act`, each ply by the player whose turn it is. */
async function play(g: Game, moves: readonly string[]): Promise<void> {
  const [row] = await sql<{ move_count: number }[]>`select move_count from fixture_external_play where fixture_id = ${g.fixtureId}`;
  let ply = row!.move_count;
  for (const uci of moves) {
    const mover = ply % 2 === 0 ? g.white : g.black;
    const out = await act(
      { fixtureId: g.fixtureId, personId: mover.personId, action: { kind: "move", uci } },
      {
        now: new Date(MOVED.getTime() + ply * 1000),
        accessToken: async (u) => `tok-${u}`,
        publish: async () => {},
        submitMove: async () => ({ ok: true }),
      },
    );
    expect(out, `premise: T10 accepted ${uci}`).toEqual({ ok: true, applied: true });
    ply++;
  }
}

/** T10's real `act`: `who` offers a draw (Lichess answering 200). */
async function offerBy(g: Game, who: Colour): Promise<void> {
  const out = await act(
    { fixtureId: g.fixtureId, personId: g[who].personId, action: { kind: "draw", accept: true } },
    { now: new Date(), accessToken: async (u) => `tok-${u}`, publish: async () => {}, offerOrAcceptDraw: async () => ({ ok: true }) },
  );
  expect(out, `premise: T10 recorded ${who}'s offer`).toEqual({ ok: true, applied: true });
}

/** A game T10 moved to 'live' with the recorded game's first ply. */
async function liveGame(over: { kind?: string } = {}): Promise<Game> {
  const g = await readyGame(over);
  await play(g, LINE.slice(0, 1));
  return g;
}

type Row = {
  status: string; needs_reason: string | null; moves_uci: string[]; move_count: number;
  started_at: Date | null; finished_at: Date | null; last_move_at: Date | null;
  white_ms: number | null; black_ms: number | null; clock_increment_s: number | null;
  draw_offer_by: string | null; white_draw_offer_ply: number | null; black_draw_offer_ply: number | null;
  last_error: string | null; revoked_seat: string | null;
};
async function rowOf(fixtureId: string): Promise<Row> {
  const [r] = await sql<Row[]>`
    select status, needs_reason, moves_uci, move_count, started_at, finished_at, last_move_at,
           white_ms, black_ms, clock_increment_s, draw_offer_by, white_draw_offer_ply, black_draw_offer_ply, last_error,
           revoked_seat
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return r!;
}
/** V451's fair-play flags for a fixture, oldest first. */
async function flagsOf(fixtureId: string) {
  return sql<{ kind: string; org_id: string; person_id: string | null; note: string | null; closed_at: Date | null; resolved_by: string | null }[]>`
    select kind, org_id, person_id, note, closed_at, resolved_by from fixture_play_flags
     where fixture_id = ${fixtureId} order by opened_at, id`;
}
async function eventsOf(fixtureId: string) {
  return sql<{ type: string; payload: { winner?: string | null } }[]>`
    select type, payload from score_events where fixture_id = ${fixtureId} order by seq`;
}
async function resultsOf(fixtureId: string) {
  return (await eventsOf(fixtureId)).filter((e) => e.type === "boardgame.result");
}
async function fixtureStatus(fixtureId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return r!.status;
}
const streams = () => lichess.calls.filter((c) => c.kind === "stream");
const exports = () => lichess.calls.filter((c) => c.kind === "export");

/** Deps a case observes: the clock, the room, and (D11) the holdMs of each settling read from here on. */
function observed(now: Date = READ, over: Partial<ReconcileDeps> = {}) {
  const sent: RoomBroadcast[] = [];
  lichess.holds.length = 0;
  const deps: ReconcileDeps = {
    now,
    publish: async (_id, body) => { sent.push(body); },
    ...over,
  };
  return { deps, sent, settles: lichess.holds };
}
/** D11: a gameFull line followed by the `gameState` Lichess pushes on the held stream (lila onGameOver → pushState). */
const thenPushed = (full: string, pushed: GameFullJson) => `${full}${JSON.stringify({ type: "gameState", ...pushed.state })}\n`;
/** The position after a line, by chess.js — the test's own oracle. */
function fenOf(line: readonly string[]): string {
  const c = new Chess();
  for (const m of line) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return c.fen();
}
/** Every stream call answers this line, whatever the token. */
const serveStream = (line: string) => { lichess.onStream = () => ok(line); };

// ---------------------------------------------------------------------------
// No database: the domain and the pure pieces.
// ---------------------------------------------------------------------------
describe("revokedSeatOf — the seat(s) a stream refusal names (ruling M7, review N4)", () => {
  it("one seat, or both in either order; an EMPTY list is refused by name, never read as Black", () => {
    const cases: [readonly ("white" | "black")[], string][] = [
      [["white"], "white"], [["black"], "black"], [["white", "black"], "both"], [["black", "white"], "both"],
    ];
    for (const [revoked, seat] of cases) expect(revokedSeatOf(revoked), revoked.join("+")).toBe(seat);
    let caught: unknown = null;
    try {
      revokedSeatOf([]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ code: "REVOKED_SEAT_EMPTY" });
  });
});

describe("RECONCILE_TRIGGERS — spec §3.5's five, a value a sweep can enumerate", () => {
  it("is exactly the spec's five triggers, each once", () => {
    // Spec §3.5's list: "a rejected move", "a local clock reaching zero",
    // "game end", "an organiser pressing resync" (an explicit action, not a
    // page view — review M5), and "the cron sweep".
    const SPEC = ["rejected_move", "clock_zero", "game_end", "organiser", "sweep"];
    expect(new Set(RECONCILE_TRIGGERS).size, "no repeats").toBe(RECONCILE_TRIGGERS.length);
    expect([...RECONCILE_TRIGGERS].sort()).toEqual([...SPEC].sort());
    expect(RECONCILE_TRIGGERS.length, "anti-vacuity").toBe(5);
  });

  it("an unknown trigger is refused by name before anything is read", async () => {
    await expect(reconcile(randomUUID(), "poll" as ReconcileTrigger)).rejects.toMatchObject({
      status: 400,
      code: "UNKNOWN_RECONCILE_TRIGGER",
    });
    expect(lichess.calls).toEqual([]);
  });

  it("D11: the settling read holds past lila's CheckOnline tick (cited), and the hold bound is the ruling's minute", () => {
    // lila GameStateStream.scala:118-124 (ad760137c): the tick is 7 s after the stream opens — the fixture server's
    // FLAG_CHECK_MS cites it. The hold must outlast it, or the read closes before Lichess can flag the side to move.
    expect(FLAG_CHECK_MS, "lila's CheckOnline delay").toBe(7_000);
    expect(FLAG_SETTLE_HOLD_MS).toBeGreaterThan(FLAG_CHECK_MS);
    expect(FLAG_SETTLE_HOLD_MS, "…and stays a short read").toBeLessThanOrEqual(FLAG_CHECK_MS + 5_000);
    expect(FLAG_UNSETTLED_HOLD_MS, "controller ruling: 60 s after the flag").toBe(60_000);
  });

  it("uciFromSan converts what chess.js can replay, stops at what it cannot, and castles king-to-g", () => {
    expect(uciFromSan(SAN)).toEqual({ uci: [...LINE], replayed: LINE.length });
    expect(uciFromSan([])).toEqual({ uci: [], replayed: 0 });
    expect(uciFromSan(["e4", "Qh9"])).toEqual({ uci: ["e2e4"], replayed: 1 });
    // lila's own UCI (UciDump legacyStandardCastling) writes O-O as e1g1.
    expect(uciFromSan(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O"]).uci.at(-1)).toBe("e1g1");
  });
});

// ---------------------------------------------------------------------------
// The stream read, against the ledger.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — the stream is the read; the ledger follows it forward", () => {
  it("a READY game: adopts Lichess's line, goes live, takes the recorded clocks, tells the room once", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID));
    const { deps, sent } = observed();
    const out = await reconcile(g.fixtureId, "organiser", deps);
    expect(out).toMatchObject({ source: "stream", adopted: LINE.length, finished: false, result: null });
    expect(streams(), "one read, White's token first").toEqual([{ kind: "stream", gameId: g.gameId, token: tokenOf(g.white) }]);
    expect(exports(), "the export is not read while the stream opens").toEqual([]);
    const r = await rowOf(g.fixtureId);
    expect(r).toMatchObject({
      status: "live",
      moves_uci: LINE,
      move_count: LINE.length,
      white_ms: MID.state.wtime,
      black_ms: MID.state.btime,
      clock_increment_s: MID.state.winc / 1000,
      draw_offer_by: null,
    });
    expect(r.started_at, "the game began at Lichess — a read is the first we know of it").toEqual(READ);
    expect(r.last_move_at, "extending the ledger sets last_move_at (T10 carry)").toEqual(READ);
    expect(sent).toEqual([{
      fen: fenOf(LINE),
      lastMove: LINE.at(-1),
      turn: LINE.length % 2 === 0 ? "white" : "black",
      whiteMs: MID.state.wtime,
      blackMs: MID.state.btime,
      status: "started",
      drawOfferBy: null,
    }]);
  });

  it("a READY game Lichess shows with no move yet stays ready, not started", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID, { moves: [] }));
    await reconcile(g.fixtureId, "organiser", observed().deps);
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.started_at, r.move_count]).toEqual(["ready", null, 0]);
  });

  it("a SECOND reconcile is a no-op — at the same instant, and later with Lichess's clock having run on", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const first = await rowOf(g.fixtureId);
    const same = observed();
    expect(await reconcile(g.fixtureId, "sweep", same.deps)).toMatchObject({ adopted: 0, finished: false, result: null });
    expect(await rowOf(g.fixtureId)).toEqual(first);
    expect(same.sent, "nothing changed, so nothing is broadcast").toEqual([]);
    // 5 s later White (to move, 8 plies) has 5 s less on Lichess's clock: the
    // row already says that — its clocks are as at last_move_at.
    serveStream(gameFull(g, MID, { wtime: MID.state.wtime - 5_000 }));
    const on = observed(later(5_000));
    expect(await reconcile(g.fixtureId, "organiser", on.deps)).toMatchObject({ adopted: 0 });
    expect(await rowOf(g.fixtureId)).toEqual(first);
    expect(on.sent).toEqual([]);
    expect(streams().length, "each reconcile still reads").toBe(3);
  });

  it("a read that finds Lichess's clock elsewhere corrects the row, re-expressed at last_move_at", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    // 5 s on, White's clock reads 2 s lower than the 5 s it ran: Lichess's
    // reading wins, expressed as of last_move_at (READ) for the renderer.
    serveStream(gameFull(g, MID, { wtime: MID.state.wtime - 7_000 }));
    const on = observed(later(5_000));
    await reconcile(g.fixtureId, "sweep", on.deps);
    const r = await rowOf(g.fixtureId);
    expect(r.last_move_at, "still the last move's instant").toEqual(READ);
    expect(r.white_ms).toBe(MID.state.wtime - 7_000 + 5_000);
    expect(r.black_ms).toBe(MID.state.btime);
    expect(on.sent.map((b) => b.whiteMs), "the room sees Lichess's reading at the read").toEqual([MID.state.wtime - 7_000]);
  });

  it("at ply 1 no clock runs (scalachess Clock.step): a later read stores Lichess's clocks as they are, nothing added back", async () => {
    // T10 recorded White's first move at MOVED; READ is 9 min on. Neither
    // clock starts until both sides have moved, so at ply 1 both read the
    // recorded game's full limit (its gameFull `clock.initial`).
    const g = await liveGame();
    const limit = MID.clock.initial;
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), wtime: limit, btime: limit }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const r = await rowOf(g.fixtureId);
    expect([r.white_ms, r.black_ms]).toEqual([limit, limit]);
    expect(r.last_move_at, "nothing adopted: still T10's instant").toEqual(MOVED);
  });

  it("a read whose ONLY difference is Lichess's increment corrects it (brief Step 5)", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const first = await rowOf(g.fixtureId);
    expect(first.clock_increment_s, "premise: the recording's 3+0").toBe(MID.state.winc / 1000);
    // Synthetic: the same line with lila's winc/binc at 2000 ms (a 3+2 game).
    serveStream(gameFull(g, MID, { winc: 2_000 }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(await rowOf(g.fixtureId)).toEqual({ ...first, clock_increment_s: 2 });
  });

  it("a stream AHEAD of the ledger (out-of-band play): adopts the longer line from where ours ends", async () => {
    const g = await liveGame();
    const before = await rowOf(g.fixtureId);
    expect(before.moves_uci, "premise: T10 recorded one ply").toEqual(LINE.slice(0, 1));
    serveStream(gameFull(g, MID));
    const { deps, sent } = observed();
    expect(await reconcile(g.fixtureId, "rejected_move", deps)).toMatchObject({ adopted: LINE.length - 1 });
    const r = await rowOf(g.fixtureId);
    expect(r.moves_uci).toEqual(LINE);
    expect(r.started_at, "T10's start stands").toEqual(before.started_at);
    expect(r.last_move_at).toEqual(READ);
    expect(sent.length).toBe(1);
  });

  it("compares in CANONICAL UCI: a castle Lichess spells king-to-rook is the castle in our ledger", async () => {
    // lila PLAYS e1h1 as castling (scalachess Position.scala:401) though it
    // streams e1g1 (UciDump legacyStandardCastling). Either spelling must
    // match the e1g1 T10 recorded, and the ledger keeps the canonical form.
    const g = await readyGame();
    const castled = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"];
    await play(g, castled);
    serveStream(gameFull(g, MID, { moves: [...castled.slice(0, 6), "e1h1", "f8c5"] }));
    expect(await reconcile(g.fixtureId, "rejected_move", observed().deps)).toMatchObject({ adopted: 1, result: null });
    const r = await rowOf(g.fixtureId);
    expect(r.status).toBe("live");
    expect(r.moves_uci).toEqual([...castled, "f8c5"]);
  });

  it("a line that does NOT extend ours (a takeback at Lichess) is never rewound: held while it runs", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 3));
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
    const out = await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(out!.result).toEqual({ wrote: "needs_organiser", reason: "provider_error" });
    const r = await rowOf(g.fixtureId);
    expect(r.moves_uci, "accepted moves are never erased").toEqual(LINE.slice(0, 3));
    expect([r.status, r.needs_reason]).toEqual(["needs_organiser", "provider_error"]);
  });

  it("…and the same diverged line once the game has ENDED still gets its result", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 3));
    serveStream(gameFull(g, EXPIRED_2, { moves: LINE.slice(0, 2) }));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out!.result).toEqual({ wrote: "decided" });
    expect(out!.finished).toBe(true);
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 3));
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner)).toEqual([g.black.entrantId]);
  });

  /** The standing-offer scenario, run at `now`: four plies played by T10, then two sweeps that adopt no move (so each one adds the
   *  time since `last_move_at` back onto White's clock - the int4 write the time bomb overflowed). */
  async function standingOfferAt(now: Date): Promise<void> {
    // lila writes bdraw only while Black's offer stands (BotJsonView; source).
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4), bdraw: true }));
    const offered = observed(now);
    await reconcile(g.fixtureId, "sweep", offered.deps);
    let r = await rowOf(g.fixtureId);
    expect([r.draw_offer_by, r.black_draw_offer_ply, r.white_draw_offer_ply]).toEqual(["black", 4, null]);
    expect(offered.sent.map((b) => b.drawOfferBy)).toEqual(["black"]);
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4) }));
    await reconcile(g.fixtureId, "sweep", observed(now).deps);
    r = await rowOf(g.fixtureId);
    expect([r.draw_offer_by, r.black_draw_offer_ply], "the re-offer rule still reads the ply").toEqual([null, 4]);
  }

  it("a standing offer read from the stream is adopted at Lichess's ply, cleared when gone, its ply kept", async () => {
    await standingOfferAt(SWEEP_AT);
  });

  it("the same standing-offer sweep 25 days after the last move still reconciles (the time bomb: 24.855 d of ms overflows int4)", async () => {
    const at = new Date(MOVED.getTime() + 25 * DAY_MS);
    expect(at.getTime() - MOVED.getTime(), "premise: past 2^31 - 1 ms").toBeGreaterThan(2_147_483_647);
    await standingOfferAt(at);
  });

  it("a board last moved 24.855+ days ago: the stored clock is capped at the column's int4 ceiling - no 22003, and the cap is exact", async () => {
    // The oracle is Postgres's own int4 (2^31 - 1), typed here from the type, not read from the code under test.
    const INT4_MAX = 2_147_483_647;
    const cols = await sql<{ column_name: string; data_type: string; numeric_precision: number }[]>`
      select column_name, data_type, numeric_precision from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_external_play' and column_name in ('white_ms', 'black_ms')
       order by column_name`;
    expect(cols.map((c) => [c.column_name, c.data_type, c.numeric_precision]), "V454: both clocks are int4").toEqual([
      ["black_ms", "integer", 32],
      ["white_ms", "integer", 32],
    ]);
    expect(CLOCK_MS_COLUMN_MAX, "the exported ceiling IS int4's").toBe(INT4_MAX);
    // Both parities: MID's 8 plies leave WHITE to move, its first 7 leave BLACK to move; the second read re-expresses the mover's
    // clock as at last_move_at (READ) = Lichess's reading + the gap, and the side NOT to move keeps its reading.
    const sides = [
      { mover: "white", line: LINE, read: MID.state.wtime, other: MID.state.btime },
      { mover: "black", line: LINE.slice(0, 7), read: MID.state.btime, other: MID.state.wtime },
    ] as const;
    const gapsFor = (read: number) => [INT4_MAX - read - 1, INT4_MAX - read, INT4_MAX - read + 1, 25 * DAY_MS, 30 * DAY_MS, 400 * DAY_MS];
    let checked = 0;
    let capped = 0;
    for (const side of sides) {
      for (const gap of gapsFor(side.read)) {
        const g = await readyGame();
        serveStream(gameFull(g, MID, { moves: side.line }));
        await reconcile(g.fixtureId, "sweep", observed().deps); // adopts the line at READ
        expect((await rowOf(g.fixtureId)).last_move_at, "premise: last_move_at = READ").toEqual(READ);
        await reconcile(g.fixtureId, "sweep", observed(later(gap)).deps); // adopts nothing: the mover's clock = reading + the gap
        const r = await rowOf(g.fixtureId);
        const want = Math.min(INT4_MAX, side.read + gap);
        expect(side.mover === "white" ? r.white_ms : r.black_ms, `${side.mover} to move, gap ${gap} ms: reading + gap, capped at int4`).toBe(want);
        expect(side.mover === "white" ? r.black_ms : r.white_ms, "the side NOT to move keeps Lichess's reading").toBe(side.other);
        expect(r.last_move_at, "still the last move's instant").toEqual(READ);
        checked++;
        if (side.read + gap > INT4_MAX) capped++;
      }
    }
    expect(checked, "anti-vacuity: every parity x gap ran").toBe(12);
    expect(capped, "premise: 4 of the 6 gaps cross the ceiling, on both parities").toBe(8);
  });

  it("a game that has ENDED has no standing offer: the one on file is cleared, a flag on the final line is not adopted", async () => {
    // Synthetic: a resign read while lila still wrote bdraw (an offer is
    // only meaningful while the game is played — Drawer.scala; source).
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    await act(
      { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "draw", accept: true } },
      { now: new Date(), accessToken: async (u) => `tok-${u}`, publish: async () => {}, offerOrAcceptDraw: async () => ({ ok: true }) },
    );
    expect((await rowOf(g.fixtureId)).draw_offer_by, "premise: Black's offer on file").toBe("black");
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4), status: "resign", winner: "white", wdraw: true, bdraw: true }));
    const { deps, sent } = observed(new Date());
    expect(await reconcile(g.fixtureId, "game_end", deps)).toMatchObject({ finished: true });
    const r = await rowOf(g.fixtureId);
    expect([r.draw_offer_by, r.black_draw_offer_ply, r.white_draw_offer_ply], "no offer after the end; the ply history stays").toEqual([null, 4, null]);
    expect(sent.map((b) => b.drawOfferBy)).toEqual([null]);
  });

  it("an offer read before ply 2 is not adopted (lila registers none; V454 refuses one)", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), wdraw: true }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const r = await rowOf(g.fixtureId);
    expect([r.move_count, r.draw_offer_by, r.white_draw_offer_ply]).toEqual([1, null, null]);
  });

  it("an offer from BOTH sides at once (lila holds one) leaves the offer on file", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4), wdraw: true, bdraw: true }));
    await reconcile(g.fixtureId, "sweep", observed(SWEEP_AT).deps);
    expect((await rowOf(g.fixtureId)).draw_offer_by).toBeNull();
  });

  it("a line for ANOTHER game is no read: neither seat's line is used, nothing written", async () => {
    const g = await liveGame();
    const before = await rowOf(g.fixtureId);
    serveStream(gameFull(g, EXPIRED_2, { gameId: "OtherGame" }));
    expect(await reconcile(g.fixtureId, "game_end", observed().deps)).toBeNull();
    expect(streams().length, "both seats tried").toBe(2);
    expect(await rowOf(g.fixtureId)).toEqual(before);
    expect(await resultsOf(g.fixtureId)).toEqual([]);
  });

  it("a game whose players are not the ones on file is held provider_error; nothing adopted or written — EITHER seat, counted", async () => {
    // The winner becomes an entrant through T9's recorded colours, so a
    // stranger on either seat must stop the write (review I3, MX17).
    let checked = 0;
    for (const seat of ["whiteId", "blackId"] as const) {
      const g = await liveGame();
      serveStream(gameFull(g, EXPIRED_2, { [seat]: "someone-else" }));
      const out = await reconcile(g.fixtureId, "game_end", observed().deps);
      expect(out!.result, seat).toEqual({ wrote: "needs_organiser", reason: "provider_error" });
      const r = await rowOf(g.fixtureId);
      expect(r.moves_uci, seat).toEqual(LINE.slice(0, 1));
      expect(await resultsOf(g.fixtureId), seat).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a seat Lichess reports with no id is not read as a mismatch", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { whiteId: null }));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ result: null, adopted: LINE.length - 1 });
  });

  it("an offer already on file keeps the ply it was made at, though the line has moved on", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 3));
    const offered = await act(
      { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "draw", accept: true } },
      { now: new Date(), accessToken: async (u) => `tok-${u}`, publish: async () => {}, offerOrAcceptDraw: async () => ({ ok: true }) },
    );
    expect(offered, "premise: T10 recorded Black's offer").toMatchObject({ ok: true });
    expect([(await rowOf(g.fixtureId)).draw_offer_by, (await rowOf(g.fixtureId)).black_draw_offer_ply], "premise").toEqual(["black", 3]);
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4), bdraw: true }));
    await reconcile(g.fixtureId, "sweep", observed(new Date()).deps);
    const r = await rowOf(g.fixtureId);
    expect([r.move_count, r.draw_offer_by, r.black_draw_offer_ply]).toEqual([4, "black", 3]);
  });

  it("a game on file with no recorded colours is refused by name, never read", async () => {
    const g = await readyGame();
    // Standing for a row written before T9 recorded colours with the game.
    await sql`update fixture_external_play set white_side = null where fixture_id = ${g.fixtureId}`;
    serveStream(gameFull(g, MID));
    const error = vi.spyOn(log, "error");
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(lichess.calls).toEqual([]);
    expect(error.mock.calls.some((c) => String(c[1]).includes("no recorded colours"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D11 (T17B fix 2): the flag. T11's "a read settles it, visible on the NEXT
// read" was false (x0JKlePc sat at `started`, White at 0, for 7 minutes of
// first-line reads); lila flags from an OPEN stream's CheckOnline tick (cited
// in reconcile.ts). So a read that finds the side to move at zero reads once
// more, holding the stream, on ANY trigger — and past a minute, holds the board.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — D11: a clock at zero is read once more on a HELD stream, whatever the trigger", () => {
  it("the recorded pair: `started` with White at 0, then `outoftime` (Black) pushed on the held stream", async () => {
    const g = await liveGame();
    let n = 0;
    lichess.onStream = () => ok(n++ === 0 ? gameFull(g, EXPIRED_1) : thenPushed(gameFull(g, EXPIRED_1), EXPIRED_2));
    const { deps, settles, sent } = observed();
    const out = await reconcile(g.fixtureId, "clock_zero", deps);
    expect(settles, "one settling read, held past the tick").toEqual([FLAG_SETTLE_HOLD_MS]);
    expect(streams().length).toBe(2);
    expect(out).toMatchObject({ source: "stream", result: { wrote: "decided" }, finished: true, adopted: LINE.length - 1 });
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner), "the winner Lichess reported").toEqual([g.black.entrantId]);
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.finished_at]).toEqual(["finished", READ]);
    expect(sent.map((b) => b.status)).toEqual(["outoftime"]);
  });

  it("every trigger reads a zero clock the same way: one settling read — counted", async () => {
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      lichess.reset();
      const g = await liveGame();
      let n = 0;
      lichess.onStream = () => ok(n++ === 0 ? gameFull(g, EXPIRED_1) : thenPushed(gameFull(g, EXPIRED_1), EXPIRED_2));
      const { deps, settles } = observed();
      const out = await reconcile(g.fixtureId, trigger, deps);
      expect([[...settles], streams().length, out?.finished], trigger).toEqual([[FLAG_SETTLE_HOLD_MS], 2, true]);
      checked++;
    }
    expect(checked, "anti-vacuity: triggers").toBe(RECONCILE_TRIGGERS.length);
  });

  // Controller ruling (2026-10-14): the 9 s hold is paid ONLY for a mover at zero — a sweep over live boards with time
  // on the clock pays nothing. Swept over every trigger, counted.
  it("the empty cases, on EVERY trigger: a clock NOT at zero, the zero on the WAITING side, a flag Lichess already settled — no settling read", async () => {
    const cases: [string, (g: Game) => string][] = [
      ["mid-game (the mid recording)", (g) => gameFull(g, MID)],
      ["Black at 0, White to move", (g) => gameFull(g, MID, { btime: 0 })],
      ["already settled (expired-2)", (g) => gameFull(g, EXPIRED_2)],
    ];
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      for (const [why, line] of cases) {
        lichess.reset();
        const g = await liveGame();
        serveStream(line(g));
        const { deps, settles } = observed();
        await reconcile(g.fixtureId, trigger, deps);
        expect([[...settles], streams().length], `${trigger}: ${why}`).toEqual([[], 1]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: trigger × case").toBe(RECONCILE_TRIGGERS.length * cases.length);
  });

  it("a settling read that cannot be made keeps the first read", async () => {
    const g = await liveGame();
    let n = 0;
    lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1)) : status(503));
    const { deps, settles } = observed();
    const out = await reconcile(g.fixtureId, "clock_zero", deps);
    expect([...settles], "the settling read tried both players' tokens").toEqual([FLAG_SETTLE_HOLD_MS, FLAG_SETTLE_HOLD_MS]);
    expect(out).toMatchObject({ source: "stream", adopted: LINE.length - 1, finished: false });
    expect((await rowOf(g.fixtureId)).move_count).toBe(LINE.length);
  });
});

describe.runIf(HAS_DB)("reconcile — D11 (b, c): a flag Lichess has not settled is HELD a minute after it fell, never left", () => {
  /** A live game the row has caught up with — the recorded mid-game line read at READ (T11's own write: the ledger at
   *  LINE, `last_move_at` = READ, White's clock as at then) — so White's flag falls at READ + that clock. */
  async function caughtUp(): Promise<{ g: Game; flagAt: number }> {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed(READ).deps);
    const r = await rowOf(g.fixtureId);
    expect([r.move_count, r.last_move_at?.toISOString(), r.white_ms], "premise: caught up at READ").toEqual([
      LINE.length,
      READ.toISOString(),
      MID.state.wtime,
    ]);
    expect(LINE.length % 2, "premise: White to move").toBe(0);
    return { g, flagAt: READ.getTime() + MID.state.wtime };
  }
  /** Lichess, still not settled: every read — the held one too — says `started`, White at 0, the same line. */
  const unsettled = (g: Game) => serveStream(gameFull(g, EXPIRED_1, { moves: [...LINE] }));
  const bridge = async (fixtureId: string) =>
    (await sql<{ status: string; needs_reason: string | null; last_error: string | null; white_ms: number | null }[]>`
      select status, needs_reason, last_error, white_ms from fixture_external_play where fixture_id = ${fixtureId}`)[0]!;

  it("(c) a read that adds no plies with White at 0 keeps White's clock as at the move — never 0 + the time since", async () => {
    const { g, flagAt } = await caughtUp();
    unsettled(g);
    await reconcile(g.fixtureId, "clock_zero", observed(new Date(flagAt + 20_000)).deps);
    const r = await bridge(g.fixtureId);
    expect(r.white_ms, "as at the move (x0JKlePc stored 389906 on a 5+0)").toBe(MID.state.wtime);
    expect(r.white_ms!, "never above the time control").toBeLessThanOrEqual(300_000);
  });

  it("inside the bound (59.999 s after the flag): nothing held, nothing written — at the bound (60 s): HELD with the evidence", async () => {
    const { g, flagAt } = await caughtUp();
    unsettled(g);
    const inside = await reconcile(g.fixtureId, "clock_zero", observed(new Date(flagAt + FLAG_UNSETTLED_HOLD_MS - 1)).deps);
    expect(inside).toMatchObject({ result: null, finished: false });
    expect((await bridge(g.fixtureId)).status, "the empty case: still live").toBe("live");
    const at = new Date(flagAt + FLAG_UNSETTLED_HOLD_MS);
    const held = await reconcile(g.fixtureId, "clock_zero", observed(at).deps);
    expect(held).toMatchObject({ result: { wrote: "needs_organiser", reason: "clock_flag_unsettled" }, finished: false });
    const r = await bridge(g.fixtureId);
    expect([r.status, r.needs_reason]).toEqual(["needs_organiser", "clock_flag_unsettled"]);
    // The evidence: the side, when its clock ran out, the read that still said `started`, and how long after.
    expect(r.last_error).toContain(`white's clock ran out at ${new Date(flagAt).toISOString()}`);
    expect(r.last_error).toContain(`on the read at ${at.toISOString()}`);
    expect(r.last_error).toContain(`${FLAG_UNSETTLED_HOLD_MS / 1000} s later`);
    expect(await resultsOf(g.fixtureId), "never a flag of ours").toEqual([]);
  });

  it("a SEQUENCE: held, read again (still held, once), then Lichess flags it at last — the result replaces the hold", async () => {
    const { g, flagAt } = await caughtUp();
    unsettled(g);
    await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + 90_000)).deps);
    expect((await bridge(g.fixtureId)).needs_reason, "premise: held").toBe("clock_flag_unsettled");
    const again = await reconcile(g.fixtureId, "clock_zero", observed(new Date(flagAt + 120_000)).deps);
    expect(again, "a held board is still read (RECONCILED_WHILE_HELD)").toMatchObject({ result: { wrote: "needs_organiser", reason: "clock_flag_unsettled" } });
    let n = 0;
    lichess.onStream = () => ok(n++ === 0 ? gameFull(g, EXPIRED_1, { moves: [...LINE] }) : thenPushed(gameFull(g, EXPIRED_1, { moves: [...LINE] }), EXPIRED_2));
    // D20 (a): a held board's settling read is the organiser's or the room's, never the 5-minute sweep's (next describe).
    const settled = await reconcile(g.fixtureId, "organiser", observed(new Date(flagAt + 150_000)).deps);
    // T12 writes the result over a mid-game hold; the held row is closed by its one authority, the sweep's first job
    // (bridge-close.ts) — reconcile finishes only ready/live rows (controller carry).
    expect(settled).toMatchObject({ result: { wrote: "decided" }, finished: false });
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner), "Lichess's own flag, Black wins").toEqual([g.black.entrantId]);
    expect(await fixtureStatus(g.fixtureId)).toBe("decided");
    expect(await closeBridgeIfUnplayable(g.fixtureId, new Date(flagAt + 151_000)), "the sweep's first job closes it").toBe(true);
    const r = await bridge(g.fixtureId);
    expect([r.status, r.needs_reason]).toEqual(["finished", null]);
  });

  it("a read that ADOPTED plies at the zero waits for the next read — the row's clock was an earlier move's", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_1));
    const out = await reconcile(g.fixtureId, "clock_zero", observed(later(10 * 60_000)).deps);
    expect(out).toMatchObject({ adopted: LINE.length - 1, result: null });
    expect((await bridge(g.fixtureId)).status).toBe("live");
  });

  // D20 (review I1, spec 2026-10-15-chess-per-board-timers-design.md §6.1 (a)): a board ALREADY held
  // clock_flag_unsettled is still at zero at Lichess, so a settling read on it costs ~9 s on EVERY 5-minute pass until
  // the organiser acts. The sweep reads it with no hold; the organiser and the room's own clock-zero reports carry it.
  // Every other trigger still settles it. Swept over the triggers, counted.
  it("D20 (a): a board held clock_flag_unsettled is read by the SWEEP with no settling read, and takes no slot; every other trigger settles it — counted", async () => {
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      lichess.reset();
      const { g, flagAt } = await caughtUp();
      unsettled(g);
      await reconcile(g.fixtureId, "clock_zero", observed(new Date(flagAt + FLAG_UNSETTLED_HOLD_MS)).deps);
      expect((await bridge(g.fixtureId)).needs_reason, `${trigger}: premise: held`).toBe("clock_flag_unsettled");
      lichess.calls.length = 0;
      let asked = 0;
      const { deps, settles } = observed(new Date(flagAt + 2 * FLAG_UNSETTLED_HOLD_MS), { settle: () => (asked++, true) });
      const out = await reconcile(g.fixtureId, trigger, deps);
      const bySweep = trigger === "sweep";
      expect([asked, [...settles], streams().length], trigger).toEqual(bySweep ? [0, [], 1] : [1, [FLAG_SETTLE_HOLD_MS], 2]);
      expect(out, `${trigger}: the board stays held`).toMatchObject({ result: { wrote: "needs_organiser", reason: "clock_flag_unsettled" }, finished: false });
      expect((await bridge(g.fixtureId)).needs_reason, trigger).toBe("clock_flag_unsettled");
      checked++;
    }
    expect(checked, "anti-vacuity: triggers").toBe(RECONCILE_TRIGGERS.length);
  });

  it("D20 (a), the pair: a board held for ANOTHER reason (provider_error) at zero is still settled by the sweep — the exception is the flag hold alone", async () => {
    const { g, flagAt } = await caughtUp();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "provider_error", detail: "test: held for the organiser" });
    let n = 0;
    lichess.onStream = () => ok(n++ === 0 ? gameFull(g, EXPIRED_1, { moves: [...LINE] }) : thenPushed(gameFull(g, EXPIRED_1, { moves: [...LINE] }), EXPIRED_2));
    const { deps, settles } = observed(new Date(flagAt + 2 * FLAG_UNSETTLED_HOLD_MS));
    const out = await reconcile(g.fixtureId, "sweep", deps);
    expect([...settles], "one settling read").toEqual([FLAG_SETTLE_HOLD_MS]);
    expect(out).toMatchObject({ result: { wrote: "decided" } });
  });

  // D20 (b): the sweep caps settling reads per pass through the `settle` seam. A read the cap refuses was never given
  // the chance to settle, so it is never evidence that Lichess did not: no clock_flag_unsettled hold, however late.
  it("D20 (b): `settle` says no — no settling read, the first read applied, and NOT held however far past the bound; the pair says yes", async () => {
    const { g, flagAt } = await caughtUp();
    unsettled(g);
    lichess.calls.length = 0;
    const at = new Date(flagAt + 2 * FLAG_UNSETTLED_HOLD_MS);
    let asked = 0;
    const no = observed(at, { settle: () => (asked++, false) });
    const out = await reconcile(g.fixtureId, "sweep", no.deps);
    expect([asked, [...no.settles], streams().length], "asked once, refused: one first-line read").toEqual([1, [], 1]);
    expect(out).toMatchObject({ source: "stream", result: null, finished: false });
    const r = await bridge(g.fixtureId);
    expect([r.status, r.needs_reason], "never held on a read that could not settle").toEqual(["live", null]);
    lichess.calls.length = 0;
    const yes = observed(at, { settle: () => (asked++, true) });
    const held = await reconcile(g.fixtureId, "sweep", yes.deps);
    expect([asked, [...yes.settles], streams().length], "allowed: one settling read").toEqual([2, [FLAG_SETTLE_HOLD_MS], 2]);
    expect(held).toMatchObject({ result: { wrote: "needs_organiser", reason: "clock_flag_unsettled" } });
  });

  // D20 review I1: a settling read that could not be MADE (a 429, a 5xx, both tokens refused: `none`) leaves Lichess
  // un-asked. Treated as "Lichess still said started" it would place clock_flag_unsettled — and D20 (a) means the sweep
  // never reads a held row's settle again, so a throttle during the one 9 s hold turned a self-healing board into one that
  // waits for a human, with evidence ("Lichess still reported started") that was never gathered.
  it("D20 (review I1): a settling read that could not be MADE (429, 503, both tokens refused) is no evidence — at the bound and far past it, on two triggers, nothing is held; the next sweep makes the held read, and a read that WAS made past the bound holds — counted", async () => {
    const FAILS: [string, () => Reply, number][] = [
      ["429 (stops every call: one try)", () => status(429), 1],
      ["503 (both tokens tried)", () => status(503), 2],
      ["401 (both tokens refused)", () => status(401), 2],
    ];
    let checked = 0;
    for (const [why, fail, tries] of FAILS) {
      for (const afterFlag of [FLAG_UNSETTLED_HOLD_MS, 5 * FLAG_UNSETTLED_HOLD_MS]) {
        for (const trigger of ["sweep", "clock_zero"] as const) {
          const label = `${why} @ flag+${afterFlag / 1000}s on ${trigger}`;
          lichess.reset();
          const { g, flagAt } = await caughtUp();
          let n = 0;
          lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : fail());
          lichess.calls.length = 0;
          const failed = observed(new Date(flagAt + afterFlag));
          const out = await reconcile(g.fixtureId, trigger, failed.deps);
          expect([...failed.settles], `${label}: the settling read was tried`).toEqual(Array<number>(tries).fill(FLAG_SETTLE_HOLD_MS));
          expect(out, label).toMatchObject({ source: "stream", result: null, finished: false });
          const r = await bridge(g.fixtureId);
          expect([r.status, r.needs_reason], `${label}: Lichess was never asked, so nothing is held`).toEqual(["live", null]);
          expect(await resultsOf(g.fixtureId), `${label}: never a flag of ours`).toEqual([]);
          // Lichess recovers: the NEXT SWEEP makes the settling read (the row is not held, so exception (a) does not
          // skip it) — and a read that was made, still `started` past the bound, is evidence: held, with it.
          unsettled(g);
          lichess.calls.length = 0;
          const next = observed(new Date(flagAt + afterFlag + 60_000));
          const held = await reconcile(g.fixtureId, "sweep", next.deps);
          expect([...next.settles], `${label}: the next sweep makes the held read`).toEqual([FLAG_SETTLE_HOLD_MS]);
          expect(held, label).toMatchObject({ result: { wrote: "needs_organiser", reason: "clock_flag_unsettled" } });
          expect((await bridge(g.fixtureId)).needs_reason, label).toBe("clock_flag_unsettled");
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: failure × time × trigger").toBe(FAILS.length * 2 * 2);
  });

  // D20 re-review n1: the first line is readable, the settling read never is (Lichess throttles or refuses the long
  // stream while the short one answers). I1 rightly places no unsettled-flag hold on that — Lichess was never asked —
  // but then nothing surfaced at all: the sweep's no-truth count resets on every non-null read, so the board sat live
  // and silent for an hour or more. A board whose flag fell FLAG_UNASKED_HOLD_MS ago and could not be asked about is
  // the organiser's to look at, said honestly: provider_error, "could not ask Lichess", never "Lichess still said started".
  it("D20 (re-review n1): a settling read that cannot be made, 15 min after the flag, holds provider_error with honest evidence — 1 ms before, nothing; on both triggers, three failure modes (counted)", async () => {
    expect(FLAG_UNASKED_HOLD_MS, "the ruling's 15 minutes, typed").toBe(15 * 60_000);
    const FAILS: [string, () => Reply][] = [
      ["429", () => status(429)],
      ["503", () => status(503)],
      ["401 (both tokens)", () => status(401)],
    ];
    let checked = 0;
    for (const [why, fail] of FAILS) {
      for (const trigger of ["sweep", "clock_zero"] as const) {
        const label = `${why} on ${trigger}`;
        lichess.reset();
        const { g, flagAt } = await caughtUp();
        let n = 0;
        lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : fail());
        // The first line answers, the settling read never does: from here on, every read of this board.
        const readAt = async (ms: number) => {
          n = 0;
          return reconcile(g.fixtureId, trigger, observed(new Date(flagAt + ms)).deps);
        };
        const before = await readAt(FLAG_UNASKED_HOLD_MS - 1);
        expect(before, `${label}: 1 ms short of the bound`).toMatchObject({ result: null, finished: false });
        const early = await bridge(g.fixtureId);
        expect([early.status, early.needs_reason], `${label}: the empty case — still live, nothing said`).toEqual(["live", null]);
        const at = await readAt(FLAG_UNASKED_HOLD_MS);
        expect(at, `${label}: at the bound`).toMatchObject({ result: { wrote: "needs_organiser", reason: "provider_error" }, finished: false });
        const held = await bridge(g.fixtureId);
        expect([held.status, held.needs_reason], label).toEqual(["needs_organiser", "provider_error"]);
        expect(held.last_error, `${label}: says what happened, in minutes`).toMatch(/could not ask Lichess/i);
        expect(held.last_error, `${label}: 15 min`).toContain("15 min");
        expect(held.last_error, `${label}: names the game`).toContain(g.gameId);
        expect(held.last_error, `${label}: never claims Lichess said started`).not.toMatch(/still reported/i);
        expect(await resultsOf(g.fixtureId), `${label}: never a flag of ours`).toEqual([]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: failure x trigger").toBe(FAILS.length * 2);
  });

  it("D20 (re-review n1): the pair — a settling read the caller's cap SKIPPED is never held on, however old the flag: Lichess was neither asked nor unreachable (the next pass asks)", async () => {
    const { g, flagAt } = await caughtUp();
    let checked = 0;
    for (const ms of [FLAG_UNASKED_HOLD_MS, FLAG_UNASKED_HOLD_MS + 3_600_000]) {
      lichess.onStream = () => ok(gameFull(g, EXPIRED_1, { moves: [...LINE] }));
      const before = lichess.calls.length;
      const out = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + ms), { settle: () => false }).deps);
      expect(out, `${ms} ms after the flag, cap spent`).toMatchObject({ result: null, finished: false });
      expect(lichess.calls.length - before, "only the first line was read").toBe(1);
      const r = await bridge(g.fixtureId);
      expect([r.status, r.needs_reason], `${ms} ms`).toEqual(["live", null]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("D20 (re-review n1): after the unasked hold, a read that gets through and finds Lichess still `started` leaves the FIRST diagnosis standing (result.ts: the first diagnosis stands); one that finds the flag settled writes Lichess's result over it", async () => {
    const { g, flagAt } = await caughtUp();
    let n = 0;
    lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : status(503));
    await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS)).deps);
    expect((await bridge(g.fixtureId)).needs_reason, "premise: held, unasked").toBe("provider_error");
    // Lichess answers now, still `started`: a made read, past the unsettled bound. The hold is the organiser's either way;
    // the row keeps the diagnosis it has.
    unsettled(g);
    const asked = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 60_000)).deps);
    expect(asked, "the stored reason is answered").toMatchObject({ result: { wrote: "needs_organiser", reason: "provider_error" } });
    expect((await bridge(g.fixtureId)).needs_reason).toBe("provider_error");
    // And now Lichess has flagged White: the held read carries the final state, T12 writes it over the hold.
    n = 0;
    lichess.onStream = () => ok(n++ === 0 ? gameFull(g, EXPIRED_1, { moves: [...LINE] }) : thenPushed(gameFull(g, EXPIRED_1, { moves: [...LINE] }), EXPIRED_2));
    const settled = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 120_000)).deps);
    expect(settled).toMatchObject({ result: { wrote: "decided" } });
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner), "Lichess's own flag, Black wins").toEqual([g.black.entrantId]);
    expect(await fixtureStatus(g.fixtureId)).toBe("decided");
  });

  // D20 re-review 2, n2: the unasked hold is placed through holdForOrganiser("provider_error"), and on a row already held
  // for a SEAT reason result.ts's review-N2 branch answers that with "freeze both seats and overwrite last_error" — right
  // for a ledger reconcile has just called untrustworthy, wrong for "a read could not be made": Black's valid seat was
  // frozen and the evidence of the refusal (last_error) lost. A row already held is the organiser's; nothing new is said.
  it("D20 (re-review 2, n2): a board already held for a SEAT reason (token_revoked, account_changed) is untouched by an unaskable read 15 min after the flag — reason, seat, last_error all as they were — counted", async () => {
    const REASONS = ["token_revoked", "account_changed"] as const;
    const SEATS = ["white", "black", "both"] as const;
    let checked = 0;
    for (const reason of REASONS) {
      for (const seat of SEATS) {
        for (const trigger of ["sweep", "clock_zero"] as const) {
          const label = `${reason} (${seat}) on ${trigger}`;
          lichess.reset();
          const { g, flagAt } = await caughtUp();
          await holdForOrganiser({ fixtureId: g.fixtureId, reason, seat, detail: `test: the ${seat} seat was refused` });
          const before = await bridge(g.fixtureId);
          const seatBefore = (await rowOf(g.fixtureId)).revoked_seat;
          expect([before.status, before.needs_reason, seatBefore], `${label}: premise — held for the seat`).toEqual(["needs_organiser", reason, seat]);
          let n = 0;
          lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : status(503));
          const out = await reconcile(g.fixtureId, trigger, observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 60_000)).deps);
          expect(n, `${label}: premise — the first line answered and the settling read was tried and failed`).toBeGreaterThan(1);
          expect(out, `${label}: nothing new is held`).toMatchObject({ result: null, finished: false });
          const after = await bridge(g.fixtureId);
          expect([after.status, after.needs_reason, (await rowOf(g.fixtureId)).revoked_seat], `${label}: reason and seat stand`).toEqual([
            "needs_organiser",
            reason,
            seat,
          ]);
          expect(after.last_error, `${label}: the seat's own evidence stands`).toBe(before.last_error);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: reason x seat x trigger").toBe(REASONS.length * SEATS.length * 2);
  });

  // D20-fix-3b: the reconcile-level check above reads the row as it was when the reconcile began; the settling read then
  // holds the stream ~9 s, and a seat hold can land in that window (a move's 401, a re-link). The hold call must not
  // widen or overwrite it: the check is the hold's own write (result.ts `ifNotHeld`), under the row lock.
  it("D20-fix-3b: a SEAT hold that lands DURING the settling read is not widened or overwritten by the unasked hold that follows it — reason, seat, last_error as the seat hold left them (both seats, both reasons — counted)", async () => {
    const CASES = [
      { reason: "token_revoked", seat: "white" },
      { reason: "token_revoked", seat: "black" },
      { reason: "account_changed", seat: "white" },
      { reason: "account_changed", seat: "black" },
    ] as const;
    let checked = 0;
    for (const c of CASES) {
      const label = `${c.reason} (${c.seat}) lands mid-read`;
      lichess.reset();
      const { g, flagAt } = await caughtUp();
      expect((await bridge(g.fixtureId)).status, `${label}: premise — the reconcile begins on a LIVE row (the guard above cannot see this hold)`).toBe("live");
      let n = 0;
      let landed = false;
      lichess.onStream = async () => {
        if (n++ === 0) return ok(gameFull(g, EXPIRED_1, { moves: [...LINE] }));
        if (!landed) {
          landed = true;
          await holdForOrganiser({ fixtureId: g.fixtureId, reason: c.reason, seat: c.seat, detail: `test: the ${c.seat} seat landed mid-read` });
        }
        return status(503);
      };
      const out = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 60_000)).deps);
      expect(landed, `${label}: premise — the seat hold landed inside the settling read`).toBe(true);
      expect(out, `${label}: answers the stored reason`).toMatchObject({ result: { wrote: "needs_organiser", reason: c.reason } });
      const after = await bridge(g.fixtureId);
      expect([after.status, after.needs_reason, (await rowOf(g.fixtureId)).revoked_seat], `${label}: reason and seat stand`).toEqual([
        "needs_organiser",
        c.reason,
        c.seat,
      ]);
      expect(after.last_error, `${label}: the seat's own evidence stands`).toBe(`test: the ${c.seat} seat landed mid-read`);
      checked++;
    }
    expect(checked, "anti-vacuity: reason x seat").toBe(CASES.length);
  });

  it("D20 (re-review 2, n2), the pair: the same unaskable read on a row that is NOT held still places the provider_error hold — the guard is the held status alone", async () => {
    const { g, flagAt } = await caughtUp();
    let n = 0;
    lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : status(503));
    const out = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 60_000)).deps);
    expect(out).toMatchObject({ result: { wrote: "needs_organiser", reason: "provider_error" } });
    expect((await bridge(g.fixtureId)).last_error).toMatch(/could not ask Lichess/i);
  });

  // D20 re-review 2, n3: the hold's words are the organiser's page. A row held "could not ask Lichess" whose later read
  // DID get through and found the game still `started` past the bound has better evidence than the stale sentence; the
  // reason (the first diagnosis) stands, the words are brought up to date.
  it("D20 (re-review 2, n3): a later read that gets through and finds Lichess still `started` refreshes last_error to the clock-unsettled evidence and keeps the reason; one the bound has not yet reached leaves the words as they were", async () => {
    const { g, flagAt } = await caughtUp();
    let n = 0;
    lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1, { moves: [...LINE] })) : status(503));
    await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS)).deps);
    const first = await bridge(g.fixtureId);
    expect([first.status, first.needs_reason], "premise: held, unasked").toEqual(["needs_organiser", "provider_error"]);
    expect(first.last_error, "premise: the unasked words").toMatch(/could not ask Lichess/i);
    // Pair first: a read that was made but is short of the unsettled bound (a raised bound) is no new evidence.
    unsettled(g);
    const quiet = await reconcile(
      g.fixtureId,
      "sweep",
      observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 60_000), { flagUnsettledAfterMs: Number.POSITIVE_INFINITY }).deps,
    );
    expect(quiet, "the stored reason answers").toMatchObject({ result: null });
    expect((await bridge(g.fixtureId)).last_error, "no evidence at this bound: the words stand").toBe(first.last_error);
    // Then past the bound.
    const asked = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + FLAG_UNASKED_HOLD_MS + 120_000)).deps);
    expect(asked, "the stored reason is answered").toMatchObject({ result: { wrote: "needs_organiser", reason: "provider_error" } });
    const now = await bridge(g.fixtureId);
    expect([now.status, now.needs_reason], "the first diagnosis stands").toEqual(["needs_organiser", "provider_error"]);
    expect(now.last_error, "the evidence is the read that WAS made").toMatch(/still reported "started"/);
    expect(now.last_error, "no longer says Lichess could not be asked").not.toMatch(/could not ask Lichess/i);
    expect(now.last_error, "names the game").toContain(g.gameId);
  });

  it("D20 (re-review 2, n3), the pair: a SEAT hold's last_error is never refreshed by the flag evidence — only provider_error's words are stale-able", async () => {
    const { g, flagAt } = await caughtUp();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked", seat: "white", detail: "test: white's seat was refused" });
    unsettled(g);
    const out = await reconcile(g.fixtureId, "sweep", observed(new Date(flagAt + 2 * FLAG_UNSETTLED_HOLD_MS)).deps);
    expect(out).toMatchObject({ result: { wrote: "needs_organiser", reason: "token_revoked" } });
    const r = await bridge(g.fixtureId);
    expect([r.needs_reason, r.last_error]).toEqual(["token_revoked", "test: white's seat was refused"]);
  });

  it("D20 (b): `settle` is asked ONLY for a mover at zero — time on the clock, the zero on the waiting side, a flag already settled never spend a slot (counted)", async () => {
    const cases: [string, (g: Game) => string][] = [
      ["mid-game (the mid recording)", (g) => gameFull(g, MID)],
      ["Black at 0, White to move", (g) => gameFull(g, MID, { btime: 0 })],
      ["already settled (expired-2)", (g) => gameFull(g, EXPIRED_2)],
    ];
    let asked = 0;
    let checked = 0;
    for (const [why, line] of cases) {
      lichess.reset();
      const g = await liveGame();
      serveStream(line(g));
      const { deps, settles } = observed(READ, { settle: () => (asked++, true) });
      await reconcile(g.fixtureId, "sweep", deps);
      expect([asked, [...settles]], why).toEqual([0, []]);
      checked++;
    }
    expect(checked, "anti-vacuity: cases").toBe(cases.length);
  });
});

// ---------------------------------------------------------------------------
// A final status: T12 writes, reconcile closes — or leaves the hold.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — a game end is written once and closes the bridge", () => {
  it("a final status T12 writes: the result once, the bridge finished, the room told", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    const { deps, sent } = observed();
    const out = await reconcile(g.fixtureId, "game_end", deps);
    expect(out).toMatchObject({ source: "stream", result: { wrote: "decided" }, finished: true });
    expect(out!.snapshot).toMatchObject({ gameId: g.gameId, status: "outoftime", winner: "black", movesSan: SAN });
    expect((await resultsOf(g.fixtureId)).length).toBe(1);
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "finished", finished_at: READ, needs_reason: null });
    expect(sent.map((b) => [b.status, b.drawOfferBy])).toEqual([["outoftime", null]]);
  });

  it("a game end that changes NOTHING on the row still tells the room the game is over", async () => {
    // The recorded pair read on two triggers at one instant: read 1 already
    // brought the row to Lichess's clocks, so read 2's end changes no column.
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_1));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const before = await rowOf(g.fixtureId);
    serveStream(gameFull(g, EXPIRED_2));
    const { deps, sent } = observed();
    expect(await reconcile(g.fixtureId, "game_end", deps)).toMatchObject({ adopted: 0, finished: true });
    const after = await rowOf(g.fixtureId);
    expect([after.moves_uci, after.white_ms, after.black_ms, after.last_move_at], "premise: nothing but the close changed")
      .toEqual([before.moves_uci, before.white_ms, before.black_ms, before.last_move_at]);
    expect(sent.map((b) => b.status)).toEqual(["outoftime"]);
  });

  it("the recorded flag pair read the measured 3 s apart: the stored clocks are Lichess's — none runs on a game that is over", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_1));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    serveStream(gameFull(g, EXPIRED_2));
    await reconcile(g.fixtureId, "game_end", observed(later(3_000)).deps); // the recorded reads' 3 s apart
    const r = await rowOf(g.fixtureId);
    expect(r.status, "premise: settled").toBe("finished");
    expect([r.white_ms, r.black_ms]).toEqual([EXPIRED_2.state.wtime, EXPIRED_2.state.btime]);
  });

  it("an offer T10 records while a FINAL read is in flight goes when the bridge closes (review M2)", async () => {
    // The stale read's write loses its CAS to the offer; the close clears it.
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    serveStream(gameFull(g, EXPIRED_2));
    const out = await reconcile(g.fixtureId, "game_end", {
      ...observed().deps,
      readStream: async (a) => {
        await offerBy(g, "black");
        return wiredReadGameStream(a);
      },
    });
    expect(out, "premise: the stale read wrote no ply").toMatchObject({ adopted: 0, finished: true });
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.draw_offer_by, r.black_draw_offer_ply]).toEqual(["finished", null, 4]);
  });

  it("a reconcile AFTER finished reads nothing, writes nothing, keeps the first finished_at — every trigger", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    await reconcile(g.fixtureId, "game_end", observed().deps);
    const row = await rowOf(g.fixtureId);
    const events = await eventsOf(g.fixtureId);
    lichess.reset();
    serveStream(gameFull(g, EXPIRED_2));
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      expect(await reconcile(g.fixtureId, trigger, observed(later(60_000)).deps), trigger).toBeNull();
      checked++;
    }
    expect(checked).toBe(RECONCILE_TRIGGERS.length);
    expect(lichess.calls).toEqual([]);
    expect(await rowOf(g.fixtureId)).toEqual(row);
    expect(await eventsOf(g.fixtureId)).toEqual(events);
  });

  it("three CONCURRENT reconciles of one game end: one result, one finish", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    const outs = await Promise.all(
      (["sweep", "game_end", "organiser"] as const).map((t) => reconcile(g.fixtureId, t, observed().deps)),
    );
    expect((await resultsOf(g.fixtureId)).length, "one result").toBe(1);
    expect(outs.filter((o) => o?.finished).length, "one call closed the bridge").toBe(1);
    expect((await rowOf(g.fixtureId)).status).toBe("finished");
  });

  it("T12's fold race (FOLD_STATUS_MISMATCH) is asked ONCE more; a second refusal, or any other error, is raised", async () => {
    // Staged deterministically: the concurrent case above reaches this race
    // only when the scheduler interleaves it.
    const fold = () => new HttpError(500, "fixture reads in_play but its fold is in phase done", "FOLD_STATUS_MISMATCH");
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    let once = 0;
    const out = await reconcile(g.fixtureId, "game_end", {
      ...observed().deps,
      writeResult: async () => {
        if (once++ === 0) throw fold();
        return { wrote: "decided" };
      },
    });
    expect([once, out?.result, out?.finished]).toEqual([2, { wrote: "decided" }, true]);

    const h = await liveGame();
    serveStream(gameFull(h, EXPIRED_2));
    let twice = 0;
    await expect(
      reconcile(h.fixtureId, "game_end", { ...observed().deps, writeResult: async () => { twice++; throw fold(); } }),
    ).rejects.toMatchObject({ code: "FOLD_STATUS_MISMATCH" });
    expect(twice).toBe(2);
    expect((await rowOf(h.fixtureId)).status, "never finished on a refusal").toBe("live");

    const k = await liveGame();
    serveStream(gameFull(k, EXPIRED_2));
    let other = 0;
    await expect(
      reconcile(k.fixtureId, "game_end", {
        ...observed().deps,
        writeResult: async () => { other++; throw new HttpError(500, "boom", "SOMETHING_ELSE"); },
      }),
    ).rejects.toMatchObject({ code: "SOMETHING_ELSE" });
    expect(other).toBe(1);
  });

  it("which of T12's answers close the bridge — every ResultWrite kind, counted", async () => {
    // The controller's carries: a written result closes (decided, draw,
    // forfeit), `none` closes, and a hold never does (aborted is T12's
    // `aborted` hold; needs_organiser covers tiebreak_owed and the rest).
    const TABLE = [
      { answer: { wrote: "decided" }, closes: true },
      { answer: { wrote: "draw" }, closes: true },
      { answer: { wrote: "forfeit" }, closes: true },
      { answer: { wrote: "none" }, closes: true },
      { answer: { wrote: "aborted" }, closes: false },
      { answer: { wrote: "needs_organiser", reason: "tiebreak_owed" }, closes: false },
    ] as const;
    let checked = 0;
    for (const { answer, closes } of TABLE) {
      const g = await liveGame();
      serveStream(gameFull(g, EXPIRED_2));
      const out = await reconcile(g.fixtureId, "game_end", { ...observed().deps, writeResult: async () => answer });
      expect(out?.finished, answer.wrote).toBe(closes);
      expect((await rowOf(g.fixtureId)).status, answer.wrote).toBe(closes ? "finished" : "live");
      checked++;
    }
    expect(checked).toBe(TABLE.length);
  });

  it("a move T10 appends WHILE the read is in flight stands: the stale read writes nothing", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1) }));
    const { deps, sent } = observed();
    await reconcile(g.fixtureId, "rejected_move", {
      ...deps,
      readStream: async (a) => {
        await play(g, LINE.slice(1, 2)); // T10's append lands mid-read
        return wiredReadGameStream(a);
      },
    });
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 2));
    expect(sent).toEqual([]);
  });

  it("an offer T10 records WHILE the read is in flight stands: the stale read writes nothing", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4) }));
    await reconcile(g.fixtureId, "sweep", {
      ...observed(SWEEP_AT).deps,
      readStream: async (a) => {
        await act(
          { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "draw", accept: true } },
          { now: SWEEP_AT, accessToken: async (u) => `tok-${u}`, publish: async () => {}, offerOrAcceptDraw: async () => ({ ok: true }) },
        );
        return wiredReadGameStream(a);
      },
    });
    expect((await rowOf(g.fixtureId)).draw_offer_by).toBe("black");
  });

  it("a bridge CLOSED while the read is in flight (a withdrawal, closed by another reconcile) is not written or broadcast", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    const { deps, sent } = observed();
    const out = await reconcile(g.fixtureId, "sweep", {
      ...deps,
      readStream: async (a) => {
        await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
        await reconcile(g.fixtureId, "organiser", observed().deps);
        return wiredReadGameStream(a);
      },
    });
    expect(out?.adopted).toBe(0);
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.moves_uci]).toEqual(["finished", LINE.slice(0, 1)]);
    expect(sent).toEqual([]);
  });

  it("a final status T12 answers `none` for (a level result already on the pad) STILL finishes the bridge", async () => {
    const g = await readyGame({ kind: "knockout" });
    const auth = await mintOrgOwnerAuth(g.orgId);
    await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, g.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: null } });
    expect(await fixtureStatus(g.fixtureId), "premise: playable, its tie-break pending").toBe("in_play");
    const events = await eventsOf(g.fixtureId);
    serveStream(gameFull(g, EXPIRED_2));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out).toMatchObject({ result: { wrote: "none" }, finished: true });
    expect(await eventsOf(g.fixtureId)).toEqual(events);
    expect((await rowOf(g.fixtureId)).status).toBe("finished");
  });

  it("a drawn game in a bracket: T12 holds tiebreak_owed — the bridge is NEVER finished, and not read again", async () => {
    // `draw`, no winner: lila's agreed draw (Drawer.scala; source).
    const g = await readyGame({ kind: "knockout" });
    serveStream(gameFull(g, MID, { status: "draw" }));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out).toMatchObject({ result: { wrote: "needs_organiser", reason: "tiebreak_owed" }, finished: false });
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.needs_reason, r.finished_at]).toEqual(["needs_organiser", "tiebreak_owed", null]);
    lichess.reset();
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(lichess.calls, "the organiser's now").toEqual([]);
  });

  it("an aborted game: T12 holds `aborted` — never finished", async () => {
    // M9: an early resign lands as `aborted` with no winner.
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "aborted" }));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out).toMatchObject({ result: { wrote: "aborted" }, finished: false });
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "aborted", finished_at: null });
  });

  it("a row held mid-game (token_revoked) KEEPS its reason when the game's result is written", async () => {
    const g = await liveGame();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    serveStream(gameFull(g, EXPIRED_2));
    const out = await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(out).toMatchObject({ result: { wrote: "decided" }, finished: false });
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", finished_at: null });
    expect((await resultsOf(g.fixtureId)).length).toBe(1);
  });

  it("final re-review P11 (1): a board held account_changed is read like a token_revoked one — its game's real end lands the same result, or the same final hold — counted", async () => {
    // The ruling: account_changed is not terminal; "a held board whose Lichess game ends still lands its result path or
    // hold, matching how token_revoked behaves". Each ending runs on BOTH reasons and must answer alike.
    const ENDS: [string, (g: Game) => void, object][] = [
      ["White out of time", (g) => serveStream(gameFull(g, EXPIRED_2)), { result: { wrote: "decided" }, finished: false }],
      ["an abort after White's first move", (g) => serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "aborted" })), { result: { wrote: "aborted" }, finished: false }],
    ];
    let checked = 0;
    for (const [label, end, wrote] of ENDS) {
      const answers: unknown[] = [];
      for (const reason of ["token_revoked", "account_changed"] as const) {
        const g = await liveGame();
        await holdForOrganiser({ fixtureId: g.fixtureId, reason, seat: "white" });
        lichess.reset();
        end(g);
        const out = await reconcile(g.fixtureId, "sweep", observed().deps);
        expect(streams().length, `${label} ${reason}: the game was read`).toBe(1);
        expect(out, `${label} ${reason}`).toMatchObject(wrote);
        const row = await rowOf(g.fixtureId);
        answers.push([(await resultsOf(g.fixtureId)).length, row.status, row.needs_reason === reason ? "kept" : row.needs_reason, row.finished_at]);
        checked++;
      }
      expect(answers[1], `${label}: account_changed answers as token_revoked does`).toEqual(answers[0]);
    }
    expect(checked).toBe(ENDS.length * 2);
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1, ruling I1: the GAME's end is on file whatever T12 then
// writes. `finished_at` is stamped only when the bridge closes, so a held
// ending (a tie-break owed, an abort, a mid-game hold whose game ended) would
// otherwise have no end at all, and the sweep's camera evidence would run on
// to the room's end.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — the game's end is recorded at the FIRST terminal read, held or not (T13 I1)", () => {
  const overOf = async (fixtureId: string) =>
    (await sql<{ game_over_at: Date | null }[]>`
      select game_over_at from fixture_external_play where fixture_id = ${fixtureId}`)[0]!.game_over_at;

  type Ending = { label: string; make: () => Promise<Game>; read: (g: Game) => void; trigger: "game_end" | "sweep"; wrote: object };
  const ENDINGS: Ending[] = [
    { label: "a result that FINISHES the bridge", make: () => liveGame(), read: (g) => serveStream(gameFull(g, EXPIRED_2)),
      trigger: "game_end", wrote: { result: { wrote: "decided" }, finished: true } },
    { label: "a bracket draw HELD tiebreak_owed", make: () => liveGame({ kind: "knockout" }),
      read: (g) => serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "draw" })),
      trigger: "game_end", wrote: { result: { wrote: "needs_organiser", reason: "tiebreak_owed" }, finished: false } },
    { label: "an abort after White's first move, HELD aborted", make: () => liveGame(),
      read: (g) => serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "aborted" })),
      trigger: "game_end", wrote: { result: { wrote: "aborted" }, finished: false } },
    { label: "a game HELD mid-game (token_revoked) that then ended", make: async () => {
        const g = await liveGame();
        await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
        return g;
      }, read: (g) => serveStream(gameFull(g, EXPIRED_2)),
      trigger: "sweep", wrote: { result: { wrote: "decided" }, finished: false } },
    { label: "a DIVERGED line that has ended", make: async () => {
        const g = await readyGame();
        await play(g, LINE.slice(0, 3));
        return g;
      }, read: (g) => serveStream(gameFull(g, EXPIRED_2, { moves: LINE.slice(0, 2) })),
      trigger: "game_end", wrote: { result: { wrote: "decided" }, finished: true } },
    { label: "a terminal EXPORT (no stream opens)", make: () => liveGame(), read: (g) => {
        lichess.onStream = () => status(503);
        lichess.onExport = () => ok(exported(g, "export-expired.json"));
      }, trigger: "sweep", wrote: { source: "export", result: { wrote: "decided" }, finished: true } },
  ];

  it("every terminal ending stamps game_over_at with the READ's time — the held ones too (counted)", async () => {
    let checked = 0;
    for (const e of ENDINGS) {
      const g = await e.make();
      expect(await overOf(g.fixtureId), `${e.label}: premise, no end before the read`).toBeNull();
      lichess.reset();
      e.read(g);
      expect(await reconcile(g.fixtureId, e.trigger, observed(READ).deps), e.label).toMatchObject(e.wrote);
      expect(await overOf(g.fixtureId), e.label).toEqual(READ);
      checked++;
    }
    expect(checked).toBe(ENDINGS.length);
  });

  it("a LATER terminal read never moves it: the first read that saw the game over is its end", async () => {
    // `unknownFinish` (a real Lichess status) goes to the organiser as
    // provider_error — a hold reconcile still reads, so a second terminal
    // read of the same game is reachable.
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "unknownFinish" }));
    await reconcile(g.fixtureId, "game_end", observed(READ).deps);
    expect(await overOf(g.fixtureId), "premise").toEqual(READ);
    const held = await rowOf(g.fixtureId);
    expect([held.status, held.needs_reason], "premise: held, and still read").toEqual(["needs_organiser", "provider_error"]);
    lichess.reset();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), status: "unknownFinish" }));
    await reconcile(g.fixtureId, "sweep", observed(later(3_600_000)).deps);
    expect(lichess.calls.length, "premise: the second read happened").toBeGreaterThan(0);
    expect(await overOf(g.fixtureId)).toEqual(READ);
  });

  it("a read of a game still RUNNING records no end — on a ready, a live and a held row (counted)", async () => {
    let checked = 0;
    for (const make of [() => readyGame(), () => liveGame(), async () => {
      const g = await liveGame();
      await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
      return g;
    }]) {
      const g = await make();
      lichess.reset();
      serveStream(gameFull(g, MID));
      await reconcile(g.fixtureId, "sweep", observed(READ).deps);
      expect(lichess.calls.length, "premise: read").toBeGreaterThan(0);
      expect(await overOf(g.fixtureId)).toBeNull();
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1, ruling I4: T10 records the move it is submitting before
// Lichess hears it. A read landing between Lichess's 200 and T10's append
// adopts that move as OURS — on every trigger, not only rejected_move — and
// nothing else: a different move at that ply, or a move at another ply, is
// still out-of-band play.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — the move T10 is submitting is ours, never out-of-band (T13 I4)", () => {
  type Pending = { pending_move_ply: number | null; pending_move_uci: string | null };
  const pendingOf = async (fixtureId: string): Promise<Pending> =>
    (await sql<Pending[]>`select pending_move_ply, pending_move_uci from fixture_external_play where fixture_id = ${fixtureId}`)[0]!;
  const NO_PENDING: Pending = { pending_move_ply: null, pending_move_uci: null };
  /** T10's REAL act for Black at ply 1, Lichess answering `answer` — and
   *  running `meanwhile` where Lichess has the move and its 200 is on the
   *  way back. The read T10 defers after a refusal is not under test here. */
  const blackSubmits = (g: Game, uci: string, answer: BoardCall, meanwhile: () => Promise<void> = async () => {}) =>
    act(
      { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci } },
      {
        now: new Date(MOVED.getTime() + 1_000), accessToken: async (u) => `tok-${u}`, publish: async () => {},
        submitMove: async () => { await meanwhile(); return answer; },
        reconcile: async () => null,
      },
    );
  const outOfBand = async (fixtureId: string) => (await flagsOf(fixtureId)).filter((f) => f.kind === "out_of_band_play");

  it("a read landing between Lichess's 200 and T10's append adopts the move with NO flag — every trigger (counted)", async () => {
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      const g = await liveGame();
      let out: Awaited<ReturnType<typeof reconcile>> = null;
      const played = await blackSubmits(g, LINE[1]!, { ok: true }, async () => {
        serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
        out = await reconcile(g.fixtureId, trigger, observed().deps);
      });
      expect(out, `${trigger}: premise, the read adopted the move`).toMatchObject({ adopted: 1 });
      expect(played, `${trigger}: T10's append found its move on file`).toEqual({ ok: true, applied: false });
      expect(await outOfBand(g.fixtureId), trigger).toEqual([]);
      expect((await rowOf(g.fixtureId)).moves_uci, trigger).toEqual(LINE.slice(0, 2));
      expect(await pendingOf(g.fixtureId), `${trigger}: the adoption took it off file`).toEqual(NO_PENDING);
      checked++;
    }
    expect(checked).toBe(RECONCILE_TRIGGERS.length);
  });

  it("a DIFFERENT move at that ply is still out-of-band play — flagged", async () => {
    const g = await liveGame();
    const other = "d7d5";
    expect(other, "premise: not the submitted move").not.toBe(LINE[1]);
    await blackSubmits(g, LINE[1]!, { ok: false, code: "not_your_turn_or_over", raw: "400" }, async () => {
      serveStream(gameFull(g, MID, { moves: [LINE[0]!, other] }));
      await reconcile(g.fixtureId, "sweep", observed().deps);
    });
    expect((await outOfBand(g.fixtureId)).map((f) => f.note)).toEqual([expect.stringContaining(`ply 2 (${other})`)]);
  });

  it("a submission that FAILED (a 5xx Lichess never played) never whitewashes a later, different move — nor one at another ply", async () => {
    const g = await liveGame();
    await blackSubmits(g, LINE[1]!, { ok: false, code: "unavailable", raw: "502" });
    expect(await pendingOf(g.fixtureId), "premise: the 5xx'd move is on file").toEqual({ pending_move_ply: 1, pending_move_uci: LINE[1] });
    // At lichess.org Black plays d7d5 instead, and White answers.
    serveStream(gameFull(g, MID, { moves: [LINE[0]!, "d7d5", "g1f3"] }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    expect((await outOfBand(g.fixtureId)).map((f) => f.note)).toEqual([expect.stringContaining("plies 2-3 (d7d5 g1f3)")]);
  });

  it("…and a 5xx Lichess DID play is adopted with no flag on the next read of any kind — and taken off file", async () => {
    const g = await liveGame();
    await blackSubmits(g, LINE[1]!, { ok: false, code: "unavailable", raw: "502" });
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 3) }));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out).toMatchObject({ adopted: 2 });
    // Ours excused; White's third ply was not sent through Seazn.
    expect((await outOfBand(g.fixtureId)).map((f) => f.note)).toEqual([expect.stringContaining(`ply 3 (${LINE[2]})`)]);
    expect(await pendingOf(g.fixtureId)).toEqual(NO_PENDING);
  });

  it("the EXPORT path excuses it too: a terminal export adopting the submitted ply flags only the plies after it", async () => {
    const g = await liveGame();
    await blackSubmits(g, LINE[1]!, { ok: false, code: "unavailable", raw: "502" });
    lichess.onStream = () => status(503);
    lichess.onExport = () => ok(exported(g, "export-expired.json"));
    const out = await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(out).toMatchObject({ source: "export", adopted: LINE.length - 1 });
    expect((await outOfBand(g.fixtureId)).map((f) => f.note)).toEqual([expect.stringContaining(`plies 3-${LINE.length} `)]);
  });

  it("a submission recorded AFTER the read loaded the row still excuses its move — judged by the submission on file AFTER Lichess was read, not as loaded (staged in each read: stream, export)", async () => {
    let checked = 0;
    for (const path of ["stream", "export"] as const) {
      const g = await liveGame();
      let staged = 0;
      // T10 records Black's move (its 5xx leaves it on file) while Lichess is
      // being read: the row this read loaded had no submission.
      const stage = async () => {
        if (staged++ === 0) await blackSubmits(g, LINE[1]!, { ok: false, code: "unavailable", raw: "502" });
      };
      const deps: ReconcileDeps = { ...observed().deps };
      if (path === "stream") {
        serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
        deps.readStream = async (a) => { await stage(); return wiredReadGameStream(a); };
      } else {
        lichess.onStream = () => status(503);
        lichess.onExport = () => ok(exported(g, "export-expired.json"));
        deps.exportGame = async (id) => { await stage(); return wiredExportGame(id); };
      }
      const out = await reconcile(g.fixtureId, "sweep", deps);
      expect(staged, `${path}: premise, staged inside the read`).toBeGreaterThan(0);
      expect(out, path).toMatchObject({ adopted: path === "stream" ? 1 : LINE.length - 1 });
      const notes = (await outOfBand(g.fixtureId)).map((f) => f.note);
      expect(notes, `${path}: Black's own move is never out-of-band`)
        .toEqual(path === "stream" ? [] : [expect.stringContaining(`plies 3-${LINE.length} `)]);
      expect(await pendingOf(g.fixtureId), `${path}: spent`).toEqual(NO_PENDING);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a read that adopts NO move (the clocks moved, not the line) keeps the submission — the next read still excuses it", async () => {
    const g = await liveGame();
    await blackSubmits(g, LINE[1]!, { ok: false, code: "unavailable", raw: "502" });
    // Lichess has not applied it yet: the same line, the clocks moved.
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1), wtime: 123_000, btime: 234_000 }));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ adopted: 0 });
    expect((await rowOf(g.fixtureId)).white_ms, "premise: the read WROTE (its clocks)").toBe(123_000);
    expect(await pendingOf(g.fixtureId), "kept: its ply is still the next").toEqual({ pending_move_ply: 1, pending_move_uci: LINE[1] });
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ adopted: 1 });
    expect(await outOfBand(g.fixtureId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The organiser decided first: close the bridge, read nothing, write nothing.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — a fixture no longer playable closes its bridge with no read and no result", () => {
  type Settled = "withdrawn" | "voided" | "decided_by_hand" | "needs_decision";
  async function settled(how: Settled): Promise<Game> {
    if (how === "withdrawn") {
      const g = await liveGame();
      await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
      return g;
    }
    if (how === "needs_decision") {
      const g = await readyGame({ kind: "knockout", legacyCfg: true });
      const auth = await mintOrgOwnerAuth(g.orgId);
      await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(auth, g.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: null } });
      return g;
    }
    const g = await readyGame();
    const auth = await mintOrgOwnerAuth(g.orgId);
    if (how === "voided") {
      await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.abandon", payload: { reason: "voided by the organiser" } });
    } else {
      await scoreEvent(auth, g.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(auth, g.fixtureId, { expected_seq: 1, type: "boardgame.result", payload: { winner: g.white.entrantId } });
    }
    return g;
  }
  const SETTLED: readonly Settled[] = ["withdrawn", "voided", "decided_by_hand", "needs_decision"];

  it("withdrawn, voided, decided by hand, needs_decision: bridge finished, zero reads, nothing written — counted", async () => {
    let checked = 0;
    for (const how of SETTLED) {
      const g = await settled(how);
      const fx = await fixtureStatus(g.fixtureId);
      expect(["scheduled", "in_play"], `${how}: premise — not playable (${fx})`).not.toContain(fx);
      expect(["ready", "live"], `${how}: premise — the bridge is open`).toContain((await rowOf(g.fixtureId)).status);
      const events = await eventsOf(g.fixtureId);
      lichess.reset();
      serveStream(gameFull(g, EXPIRED_2));
      expect(await reconcile(g.fixtureId, "organiser", observed().deps), how).toBeNull();
      expect(lichess.calls, how).toEqual([]);
      expect(await rowOf(g.fixtureId), how).toMatchObject({ status: "finished", finished_at: READ, needs_reason: null });
      expect(await eventsOf(g.fixtureId), how).toEqual(events);
      // A second reconcile keeps the first finished_at.
      await reconcile(g.fixtureId, "sweep", observed(later(60_000)).deps);
      expect((await rowOf(g.fixtureId)).finished_at, how).toEqual(READ);
      checked++;
    }
    expect(checked).toBe(SETTLED.length);
  });

  it("a fixture still playable but no longer served online (online play switched off) is left as it stands", async () => {
    const g = await liveGame();
    // Standing for the organiser's settings save.
    await sql`update divisions set config = jsonb_set(config, '{onlinePlay}', '"off"') where id = ${g.divisionId}`;
    const before = await rowOf(g.fixtureId);
    serveStream(gameFull(g, MID));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(lichess.calls).toEqual([]);
    expect(await rowOf(g.fixtureId)).toEqual(before);
  });

  it("a withdrawn board's standing offer goes with its closed bridge (review M2)", async () => {
    const g = await readyGame();
    await play(g, LINE.slice(0, 3));
    await offerBy(g, "black");
    await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.draw_offer_by, r.black_draw_offer_ply]).toEqual(["finished", null, 3]);
  });

  it("a HELD row on a withdrawn fixture closes too (T16 fix round 1, I1) — the queue lists playable fixtures only, so it would be orphaned", async () => {
    // Before I1 this row was left `needs_organiser`: out of the queue (queue.ts filters unplayable fixtures),
    // "needs the organiser" on the public page, and polled there for ever. Now it closes, with no Lichess read,
    // no hold reason and no seat — and NO finished_at: the close is not the game's end (the camera judgment
    // reads finished_at as that end; a held game's is game_over_at or the clock's bound).
    const g = await liveGame();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked", seat: "black" });
    expect(await rowOf(g.fixtureId), "premise: held").toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked" });
    await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "finished", needs_reason: null, revoked_seat: null, finished_at: null });
    expect(lichess.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which bridge rows are read at all: trigger × status, and every held reason.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — trigger × bridge status, and the held reasons", () => {
  type State = "pending" | "ready" | "live" | "finished" | "held_mid_game";
  async function inState(state: State): Promise<Game> {
    if (state === "pending") {
      // T9's real producer, its create throttled (429, M3 — lila refuses
      // before it acts): the claim is released and the row stays pending.
      const s = await seed();
      __resetCreationQueue();
      board.createChallengeToUser.mockResolvedValue({ ok: false, code: "rate_limited", raw: "" });
      await createGameIfReady(s.fixtureId, { now: CREATED, publish: async () => {} });
      const [r] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(r?.status, "premise: T9 left the row pending").toBe("pending");
      return { ...s, gameId: "none", white: s.home, black: s.away };
    }
    if (state === "ready") return readyGame();
    const g = await liveGame();
    if (state === "finished") {
      serveStream(gameFull(g, EXPIRED_2));
      await reconcile(g.fixtureId, "game_end", observed().deps);
      expect((await rowOf(g.fixtureId)).status, "premise").toBe("finished");
    }
    if (state === "held_mid_game") await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    return g;
  }
  // Reads each state owes: none before a game exists or after it closed.
  const READS: Record<State, number> = { pending: 0, ready: 1, live: 1, finished: 0, held_mid_game: 1 };

  it("every trigger on every bridge status reads exactly what the status owes — counted", async () => {
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS) {
      for (const state of Object.keys(READS) as State[]) {
        const g = await inState(state);
        lichess.reset();
        serveStream(gameFull(g, MID));
        const before = await rowOf(g.fixtureId);
        const out = await reconcile(g.fixtureId, trigger, observed().deps);
        const label = `${trigger} × ${state}`;
        expect(streams().length, label).toBe(READS[state]);
        expect(exports().length, label).toBe(0);
        const after = await rowOf(g.fixtureId);
        if (READS[state] === 0) {
          expect(out, label).toBeNull();
          expect(after, label).toEqual(before);
        } else {
          expect(after.moves_uci, label).toEqual(LINE);
          expect([after.status, after.needs_reason], label).toEqual(
            state === "held_mid_game" ? ["needs_organiser", "token_revoked"] : ["live", null],
          );
        }
        checked++;
      }
    }
    expect(checked).toBe(RECONCILE_TRIGGERS.length * Object.keys(READS).length);
  });

  it("a held row is read only for a MID-GAME diagnosis; every other reason is the organiser's — counted from NEEDS_REASONS", async () => {
    // T12 (result.ts): token_revoked and provider_error are the mid-game
    // diagnoses a final snapshot replaces; every other reason ends the game
    // or never began it.
    // Final re-review P11 (1): account_changed joins them — a re-link moves no game at Lichess.
    // T17B fix 2, D11: clock_flag_unsettled too — Lichess may still flag it, or a player resign; its end is read.
    const MID_GAME = new Set(["token_revoked", "provider_error", "account_changed", "clock_flag_unsettled"]);
    let read = 0;
    let skipped = 0;
    for (const reason of NEEDS_REASONS) {
      const g = await liveGame();
      // Standing for each reason's writer (T13 no-shows, T9's unknown create,
      // T12's holds): the CHECK pairs the status with its reason.
      await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = ${reason} where fixture_id = ${g.fixtureId}`;
      lichess.reset();
      serveStream(gameFull(g, MID));
      await reconcile(g.fixtureId, "sweep", observed().deps);
      if (MID_GAME.has(reason)) {
        expect(streams().length, reason).toBe(1);
        read++;
      } else {
        expect(lichess.calls, reason).toEqual([]);
        expect((await rowOf(g.fixtureId)).moves_uci, reason).toEqual(LINE.slice(0, 1));
        skipped++;
      }
    }
    expect(read).toBe(MID_GAME.size);
    expect(skipped).toBe(NEEDS_REASONS.length - MID_GAME.size);
  });
});

// ---------------------------------------------------------------------------
// Tokens: whose stream opens, and the export as a terminal-only fallback.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — tokens and the export fallback", () => {
  /** Standing for a legacy identity-only link (no grant to open a stream). */
  async function noGrant(p: Player) {
    await sql`update user_external_accounts set access_token_enc = null, consented_at = null where user_id = ${p.userId} and provider = 'lichess'`;
  }
  /** A sealed token our key cannot open (an operator's key fault). */
  async function unopenable(p: Player) {
    await sql`update user_external_accounts set access_token_enc = ${Buffer.from("not a sealed token")} where user_id = ${p.userId} and provider = 'lichess'`;
  }

  it("White's token refused (401): Black's opens the stream; the game is held token_revoked", async () => {
    const g = await liveGame();
    lichess.onStream = (c) => (c.token === tokenOf(g.white) ? status(401) : ok(gameFull(g, MID)));
    const out = await reconcile(g.fixtureId, "rejected_move", observed().deps);
    expect(streams().map((c) => c.token)).toEqual([tokenOf(g.white), tokenOf(g.black)]);
    expect(out).toMatchObject({ source: "stream", result: { wrote: "needs_organiser", reason: "token_revoked" } });
    expect(await rowOf(g.fixtureId)).toMatchObject({
      status: "needs_organiser",
      needs_reason: "token_revoked",
      moves_uci: LINE,
      // Ruling M7: only White's seat is frozen; Black plays on.
      revoked_seat: "white",
    });
  });

  it("both refused, export mid-game: nothing trusted — held token_revoked, the ledger untouched", async () => {
    const g = await liveGame();
    lichess.onStream = () => status(401);
    lichess.onExport = () => ok(exported(g, "export-mid.json"));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(exports().length).toBe(1);
    expect(await rowOf(g.fixtureId)).toMatchObject({
      status: "needs_organiser",
      needs_reason: "token_revoked",
      moves_uci: LINE.slice(0, 1),
      revoked_seat: "both",
    });
  });

  it("only Black's token refused (White has no grant to open a stream): the hold freezes Black alone (ruling M7)", async () => {
    const g = await liveGame();
    await noGrant(g.white);
    lichess.onStream = () => status(401);
    lichess.onExport = () => ok(exported(g, "export-mid.json"));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(streams().map((c) => c.token), "premise: only Black's stream was opened").toEqual([tokenOf(g.black)]);
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "black" });
  });

  it("no grant on either side, export TERMINAL: settles from the export, extends forward, never reads its clocks", async () => {
    const g = await liveGame();
    await noGrant(g.white);
    await noGrant(g.black);
    const before = await rowOf(g.fixtureId);
    lichess.onExport = () => ok(exported(g, "export-expired.json"));
    const { deps, sent } = observed();
    const out = await reconcile(g.fixtureId, "sweep", deps);
    expect(streams(), "no token, no stream").toEqual([]);
    expect(out).toMatchObject({ source: "export", result: { wrote: "decided" }, finished: true, adopted: LINE.length - 1 });
    const r = await rowOf(g.fixtureId);
    expect(r.moves_uci).toEqual(LINE);
    expect([r.white_ms, r.black_ms], "M11: the export's clocks are never used").toEqual([before.white_ms, before.black_ms]);
    expect(r.status).toBe("finished");
    expect(sent.map((b) => b.status)).toEqual(["outoftime"]);
  });

  it("D11 (c): an export that adds no plies broadcasts the running clock counted down to the read — never as at the move — floored at 0", async () => {
    const cases = [
      { why: "10 s after the move", after: 10_000 },
      { why: "long past the flag", after: 60 * 60_000 },
    ];
    let checked = 0;
    for (const c of cases) {
      const g = await readyGame();
      await play(g, LINE);
      await noGrant(g.white);
      await noGrant(g.black);
      const before = await rowOf(g.fixtureId);
      expect([before.move_count % 2, before.white_ms !== null, before.last_move_at !== null], "premise: White to move, clocks on file").toEqual([0, true, true]);
      lichess.onExport = () => ok(exported(g, "export-expired.json"));
      const { deps, sent } = observed(new Date(before.last_move_at!.getTime() + c.after));
      const out = await reconcile(g.fixtureId, "sweep", deps);
      expect(out, c.why).toMatchObject({ source: "export", adopted: 0, finished: true });
      // V454: each clock is as at `last_move_at`; White's has been running since. Black's waits, as stored.
      expect(sent.map((b) => [b.whiteMs, b.blackMs]), c.why).toEqual([[Math.max(0, before.white_ms! - c.after), before.black_ms]]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("an export BEHIND the ledger (M16) is ignored mid-game, and never rewinds a finished one", async () => {
    const g = await readyGame();
    await play(g, LINE);
    await noGrant(g.white);
    await noGrant(g.black);
    const before = await rowOf(g.fixtureId);
    lichess.onExport = () => ok(exported(g, "export-mid.json")); // recorded: 5 plies, started
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(await rowOf(g.fixtureId)).toEqual(before);
    // Synthetic: the expired export truncated to 5 plies — a stalled read of a
    // finished game.
    lichess.onExport = () => ok(exported(g, "export-expired.json", { moves: SAN.slice(0, 5) }));
    const out = await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(out).toMatchObject({ source: "export", adopted: 0, finished: true });
    expect((await rowOf(g.fixtureId)).moves_uci, "a short export is a truncated read, not a rewind").toEqual(LINE);
  });

  it("a terminal export LONGER than ours that does not extend it never overwrites accepted moves; its result is still written", async () => {
    const g = await liveGame(); // ours: e2e4
    await noGrant(g.white);
    await noGrant(g.black);
    // Synthetic: the recorded expired export opening with a move that is not ours.
    lichess.onExport = () => ok(exported(g, "export-expired.json", { moves: ["d4", "e5", "Nf3"] }));
    const out = await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(out).toMatchObject({ source: "export", adopted: 0, result: { wrote: "decided" }, finished: true });
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 1));
  });

  it("a game the export ends has no standing offer — finished, and held alike (review M2) — counted", async () => {
    let checked = 0;
    for (const c of [
      { kind: undefined, over: {}, want: "finished" },
      // lila's `draw`, no winner, in a bracket: T12 holds tiebreak_owed.
      { kind: "knockout", over: { status: "draw", winner: null }, want: "needs_organiser" },
    ] as const) {
      const g = await readyGame({ kind: c.kind });
      await play(g, LINE.slice(0, 3));
      await offerBy(g, "black");
      await noGrant(g.white);
      await noGrant(g.black);
      lichess.onExport = () => ok(exported(g, "export-expired.json", c.over));
      expect(await reconcile(g.fixtureId, "sweep", observed().deps), c.want).toMatchObject({ source: "export" });
      const r = await rowOf(g.fixtureId);
      expect([r.status, r.draw_offer_by, r.black_draw_offer_ply], c.want).toEqual([c.want, null, 3]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("429 does not swallow a token our key cannot open: White unopenable, Black's stream 429 — LICHESS_TOKEN_UNAVAILABLE (review M1)", async () => {
    const g = await liveGame();
    await unopenable(g.white);
    lichess.onStream = () => status(429);
    await expect(reconcile(g.fixtureId, "sweep", observed().deps)).rejects.toMatchObject({ status: 503, code: "LICHESS_TOKEN_UNAVAILABLE" });
    expect([streams().length, exports().length], "the 429 still stops every call").toEqual([1, 0]);
  });

  it("a token our key cannot open is NEVER swallowed: with nothing else to trust, LICHESS_TOKEN_UNAVAILABLE is raised", async () => {
    const g = await liveGame();
    await unopenable(g.white);
    await unopenable(g.black);
    lichess.onExport = () => ok(exported(g, "export-mid.json"));
    await expect(reconcile(g.fixtureId, "sweep", observed().deps)).rejects.toMatchObject({ status: 503, code: "LICHESS_TOKEN_UNAVAILABLE" });
    expect([streams().length, exports().length]).toEqual([0, 1]);
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 1));
  });

  it("…a terminal export still settles the game; one unopenable seat leaves the other's stream", async () => {
    const g = await liveGame();
    await unopenable(g.white);
    await unopenable(g.black);
    lichess.onExport = () => ok(exported(g, "export-expired.json"));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ source: "export", finished: true });
    const h = await liveGame();
    await unopenable(h.white);
    lichess.reset();
    serveStream(gameFull(h, MID));
    expect(await reconcile(h.fixtureId, "sweep", observed().deps)).toMatchObject({ source: "stream" });
    expect(streams().map((c) => c.token)).toEqual([tokenOf(h.black)]);
  });

  it("a seat whose player re-linked ANOTHER Lichess account is not this game's player: never its token", async () => {
    const g = await liveGame();
    // Standing for upsertLichessLink re-linking White to a new account.
    await sql`update user_external_accounts set external_user_id = ${`relinked-${randomUUID().slice(0, 8)}`} where user_id = ${g.white.userId} and provider = 'lichess'`;
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    expect(streams().map((c) => c.token)).toEqual([tokenOf(g.black)]);
  });

  it("a terminal export of ANOTHER game is not trusted", async () => {
    const g = await liveGame();
    await noGrant(g.white);
    await noGrant(g.black);
    const before = await rowOf(g.fixtureId);
    lichess.onExport = () => ok(exported(g, "export-expired.json").replace(`"id":"${g.gameId}"`, '"id":"OtherGame"'));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(await rowOf(g.fixtureId)).toEqual(before);
    expect(await resultsOf(g.fixtureId)).toEqual([]);
  });

  it("429 stops every call: no second seat, no export, nothing written", async () => {
    const g = await liveGame();
    const before = await rowOf(g.fixtureId);
    lichess.onStream = () => status(429);
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(lichess.calls.length).toBe(1);
    expect(await rowOf(g.fixtureId)).toEqual(before);
  });

  it("no token reaches a log line — counted over every line logged", async () => {
    const spies = (["info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(log, m));
    const g = await liveGame();
    lichess.onStream = (c) => (c.token === tokenOf(g.white) ? status(401) : status(503));
    lichess.onExport = () => ok(exported(g, "export-mid.json"));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const h = await liveGame();
    await unopenable(h.white);
    await unopenable(h.black);
    lichess.onExport = () => ok(exported(h, "export-mid.json"));
    await reconcile(h.fixtureId, "sweep", observed().deps).catch(() => undefined);
    const lines = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)));
    expect(lines.length, "anti-vacuity: the refusals were logged").toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain("lio_seed_");
  });
});

// ---------------------------------------------------------------------------
// The property: interleaved triggers × Lichess snapshots, one game per run.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// T11 fix round 1 — I5: plies reconcile ADOPTS were played at Lichess without
// us (our server is the only mover). Controller ruling: a fair-play flag in
// V451's table, never a sanction; evidence = the plies + whether the camera
// was Required; one flag per adoption, never a duplicate on a re-read.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — I5: adopted plies raise ONE out_of_band_play flag", () => {
  it("a stream read that adopts plies writes one open flag naming them; a re-read of the same line writes none", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ adopted: LINE.length - 1 });
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length, "one adoption, one flag").toBe(1);
    expect(flags[0]).toMatchObject({ kind: "out_of_band_play", org_id: g.orgId, person_id: null, closed_at: null, resolved_by: null });
    // The evidence: the plies by number, the moves themselves (the recording's,
    // not ours), and the camera policy (V451 default: off).
    expect(flags[0]!.note).toContain(`plies 2-${LINE.length}`);
    expect(flags[0]!.note).toContain(LINE.slice(1).join(" "));
    expect(flags[0]!.note).toContain("camera not required (policy off)");
    // A second and a third read of the same line adopt nothing.
    for (const at of [later(1_000), later(60_000)]) {
      expect(await reconcile(g.fixtureId, "sweep", observed(at).deps)).toMatchObject({ adopted: 0 });
    }
    expect((await flagsOf(g.fixtureId)).length, "never a duplicate on a re-read").toBe(1);
    expect(await resultsOf(g.fixtureId), "never a sanction: no result, no forfeit").toEqual([]);
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "live", needs_reason: null });
  });

  it("T15: the arbiter panel's loader reads the flag this producer wrote — the plies it names", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const view = await loadArbiterRound(await mintOrgOwnerAuth(g.orgId), g.divisionId);
    const flags = view!.boards.find((b) => b.fixtureId === g.fixtureId)!.flags;
    // Expected from the recorded line: ply 1 was ours (T10's act), and every
    // later ply of the line was adopted from Lichess.
    expect(flags).toEqual([
      expect.objectContaining({ kind: "out_of_band_play", plies: { from: 2, to: LINE.length } }),
    ]);
  });

  it("T15: the arbiter's 'Resync from Lichess' (resyncExternalPlay) answers what THIS reconcile did — a read, the plies adopted; a second press adopts nothing", async () => {
    const g = await readyGame();
    serveStream(gameFull(g, MID));
    const auth = await mintOrgOwnerAuth(g.orgId);
    expect(await resyncExternalPlay(auth, g.fixtureId, observed().deps)).toEqual({ read: true, adopted: LINE.length, finished: false });
    expect(await resyncExternalPlay(auth, g.fixtureId, observed(later(1_000)).deps)).toEqual({ read: true, adopted: 0, finished: false });
    expect(streams().map((x) => x.gameId), "each press is one read").toEqual([g.gameId, g.gameId]);
  });

  // T16 (controller ruling B, AGENTS.md class 13): "Let the game go on" closes
  // the flags the organiser saw. Evidence already judged must not come back —
  // and evidence that is NEW after the close must not be swallowed by it.
  it("T16: after 'Let the game go on', a re-read of the judged line raises NOTHING; a later adoption raises a NEW open flag", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 3) }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const owner = await mintOrgOwnerAuth(g.orgId);
    const shown = (await loadArbiterRound(owner, g.divisionId))!.boards.find((b) => b.fixtureId === g.fixtureId)!.flags;
    expect(shown.map((f) => f.kind), "premise: the producer's flag, as the panel shows it").toEqual(["out_of_band_play"]);
    // T16: the same flag on the division's fixtures tab — the queue's Flagged list and the run sheet's chip.
    const flaggedIds = async () =>
      (await listFlaggedExternalPlay(owner, g.divisionId)).boards.filter((b) => b.fixtureId === g.fixtureId).flatMap((b) => b.flags.map((f) => f.id));
    const offSeazn = async () => (await listRunSheetOnlinePlay(owner, g.divisionId))[g.fixtureId]?.offSeaznFlagCount;
    expect(await flaggedIds(), "the queue's Flagged list").toEqual(shown.map((f) => f.id));
    expect(await offSeazn(), "the run sheet's off-Seazn chip").toBe(1);
    expect(await closeExternalPlayFlags(owner, g.fixtureId, shown.map((f) => f.id))).toEqual({ closed: 1, stillOpen: 0 });
    expect(await flaggedIds(), "closed: off the Flagged list").toEqual([]);
    expect(await offSeazn(), "closed: no chip").toBe(0);
    expect((await flagsOf(g.fixtureId))[0], "the audit: who closed it, and when").toMatchObject({
      resolved_by: owner.userId,
      closed_at: expect.any(Date),
    });

    // The judged evidence, read again — twice: nothing new is raised.
    for (const at of [later(1_000), later(30_000)]) {
      expect(await reconcile(g.fixtureId, "sweep", observed(at).deps)).toMatchObject({ adopted: 0 });
    }
    expect((await flagsOf(g.fixtureId)).map((f) => f.closed_at === null), "the judged flag stays closed, no new one").toEqual([false]);

    // NEW evidence after the close: plies played off Seazn since.
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed(later(60_000)).deps);
    const flags = await flagsOf(g.fixtureId);
    expect(flags.map((f) => f.closed_at === null), "closed, then a new OPEN flag").toEqual([false, true]);
    expect(flags[1]!.note).toContain(`plies 4-${LINE.length}`);
    expect(flags[1]).toMatchObject({ resolved_by: null });
    const [newest] = await sql<{ id: string }[]>`
      select id from fixture_play_flags where fixture_id = ${g.fixtureId} and closed_at is null`;
    const after = (await loadArbiterRound(owner, g.divisionId))!.boards.find((b) => b.fixtureId === g.fixtureId)!.flags;
    expect(after.map((f) => f.id), "the panel shows the new evidence only").toEqual([newest!.id]);
    expect(await flaggedIds(), "and the Flagged list shows it again").toEqual([newest!.id]);
    expect(await offSeazn(), "and the chip is back").toBe(1);
  });

  it("each LATER adoption is its own flag, naming only its own plies", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 3) }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    serveStream(gameFull(g, MID));
    await reconcile(g.fixtureId, "sweep", observed(later(1_000)).deps);
    const notes = (await flagsOf(g.fixtureId)).map((f) => f.note);
    expect(notes.length).toBe(2);
    expect(notes[0]).toContain(`plies 2-3 (${LINE.slice(1, 3).join(" ")})`);
    expect(notes[1]).toContain(`plies 4-${LINE.length} (${LINE.slice(3).join(" ")})`);
  });

  it("the evidence says whether the camera was Required — each policy, at the stage, counted", async () => {
    let checked = 0;
    for (const policy of ["off", "optional", "required"] as const) {
      const g = await liveGame();
      await sql`update stages set camera_policy = ${policy} where id = ${g.stageId}`;
      serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
      await reconcile(g.fixtureId, "sweep", observed().deps);
      const [flag] = await flagsOf(g.fixtureId);
      expect(flag!.note, policy).toContain(`ply 2 (${LINE[1]})`);
      expect(flag!.note, policy).toContain(policy === "required" ? "camera required" : `camera not required (policy ${policy})`);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("no plies adopted ⇒ no flag: our own moves read back, a clock-only change, a diverged line, a shorter read — counted", async () => {
    const cases: [string, (g: Game) => Promise<void>][] = [
      ["T10 played them all", async (g) => { await play(g, LINE.slice(1)); serveStream(gameFull(g, MID)); }],
      ["clock-only change", async (g) => { await play(g, LINE.slice(1)); serveStream(gameFull(g, MID, { wtime: 1_000 })); }],
      ["diverged", async (g) => { serveStream(gameFull(g, MID, { moves: ["d2d4", "d7d5"] })); }],
      ["shorter (a stalled read)", async (g) => { await play(g, LINE.slice(1, 3)); serveStream(gameFull(g, MID, { moves: LINE.slice(0, 1) })); }],
    ];
    let checked = 0;
    for (const [name, arrange] of cases) {
      const g = await liveGame();
      await arrange(g);
      expect(await reconcile(g.fixtureId, "sweep", observed().deps), name).toMatchObject({ adopted: 0 });
      expect(await flagsOf(g.fixtureId), name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("an export that extends ours raises the flag too (no grant on either side)", async () => {
    const g = await liveGame();
    for (const p of [g.white, g.black]) {
      await sql`update user_external_accounts set access_token_enc = null, consented_at = null where user_id = ${p.userId} and provider = 'lichess'`;
    }
    lichess.onExport = () => ok(exported(g, "export-expired.json"));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ source: "export", adopted: LINE.length - 1 });
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length).toBe(1);
    expect(flags[0]!.note).toContain(`plies 2-${LINE.length} (${LINE.slice(1).join(" ")})`);
  });

  it("two EXPORT reads of the same adoption before either writes: one wins the ledger, ONE flag (staged, ×3)", async () => {
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      const g = await liveGame();
      for (const p of [g.white, g.black]) {
        await sql`update user_external_accounts set access_token_enc = null, consented_at = null where user_id = ${p.userId} and provider = 'lichess'`;
      }
      lichess.onExport = () => ok(exported(g, "export-expired.json"));
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((r) => (release = r));
      const exportGame: ReconcileDeps["exportGame"] = async (id) => {
        if (++arrived === 2) release();
        await bothRead;
        return wiredExportGame(id);
      };
      const outs = await Promise.all([0, 1].map(() => reconcile(g.fixtureId, "sweep", { ...observed().deps, exportGame })));
      expect(arrived, "the stage fired: both read").toBe(2);
      expect(outs.map((o) => o?.adopted).sort(), "one adopted, the other lost its CAS").toEqual([0, LINE.length - 1]);
      expect((await flagsOf(g.fixtureId)).length, `run ${run}`).toBe(1);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("two reconciles that READ the same adoption before either writes: one wins the ledger, ONE flag (staged, ×3)", async () => {
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      const g = await liveGame();
      serveStream(gameFull(g, MID));
      // Both reads are held at Lichess until both have arrived: each then
      // writes against the SAME stale row, and the CAS picks one.
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((r) => (release = r));
      const readStream: ReconcileDeps["readStream"] = async (a) => {
        if (++arrived === 2) release();
        await bothRead;
        return wiredReadGameStream(a);
      };
      const outs = await Promise.all([0, 1].map(() => reconcile(g.fixtureId, "sweep", { ...observed().deps, readStream })));
      expect(arrived, "the stage fired: both read").toBe(2);
      expect(outs.map((o) => o?.adopted).sort(), "one adopted, the other lost its CAS").toEqual([0, LINE.length - 1]);
      expect((await flagsOf(g.fixtureId)).length, `run ${run}`).toBe(1);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T11 fix round 1 — I4: spec §3.5's first trigger, "on a move Lichess
// rejects", produced by T10's REAL play path and consumed by the real
// reconcile over the real wire. Nothing here injects `reconcile`.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — I4: a move Lichess rejects is reconciled from T10's play path", () => {
  /** What T10 deferred past its answer (review N3), collected so a case can
   *  await it; the real default (`deferred`) has its own cases below. */
  let tasks: Promise<unknown>[] = [];
  beforeEach(() => {
    tasks = [];
  });
  const settled = () => Promise.all(tasks);
  const submitAnswering = (answer: BoardCall) => ({
    now: new Date(MOVED.getTime() + 60_000),
    accessToken: async (u: string) => `tok-${u}`,
    publish: async () => {},
    submitMove: async () => answer,
    defer: (task: () => Promise<void>) => {
      tasks.push(task());
    },
  });
  /** Black (to move on our ledger at ply 1) submits `uci`; Lichess answers `answer`. */
  const blackSubmits = (g: Game, uci: string, answer: BoardCall) =>
    act({ fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci } }, submitAnswering(answer));
  const FIVE_XX: BoardCall = { ok: false, code: "unavailable", raw: "502 Bad Gateway" };

  it("Lichess has moved on without us: the rejected move reads the stream ONCE and adopts (and flags) what was played", async () => {
    const g = await liveGame();
    // At Lichess the game is at ply 8 (played at lichess.org); our ledger has
    // one ply, so per US it is Black's turn — Lichess says otherwise (M6 400).
    serveStream(gameFull(g, MID));
    const out = await act(
      { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci: LINE[1]! } },
      submitAnswering({ ok: false, code: "not_your_turn_or_over", raw: "400 Not your turn, or game already over" }),
    );
    expect(out, "the player's answer is still the refusal").toEqual({ ok: false, reconcile: true, reason: "not_your_turn_or_over" });
    await settled();
    expect(streams().length, "one read").toBe(1);
    expect(await rowOf(g.fixtureId)).toMatchObject({ moves_uci: LINE, move_count: LINE.length, status: "live" });
    const flags = await flagsOf(g.fixtureId);
    expect(flags.map((f) => f.kind)).toEqual(["out_of_band_play"]);
    // Ply 2 IS the move Black sent (a twin tab's, or an earlier timed-out
    // call's): ours, never evidence (review N1). The rest are not.
    expect(flags[0]!.note).toContain(`plies 3-${LINE.length} (${LINE.slice(2).join(" ")})`);
  });

  it("a 5xx that DID play our move: adopted as OURS — no out-of-band flag (review N1)", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
    expect(await blackSubmits(g, LINE[1]!, FIVE_XX)).toEqual({ ok: false, reconcile: true, reason: "unavailable" });
    await settled();
    expect(streams().length).toBe(1);
    expect((await rowOf(g.fixtureId)).moves_uci, "adopted").toEqual(LINE.slice(0, 2));
    expect(await flagsOf(g.fixtureId), "our own move is never a fair-play flag").toEqual([]);
  });

  it("a DIFFERENT move at the ply we sent is out-of-band: adopted and flagged", async () => {
    const g = await liveGame();
    const theirs = "c7c5";
    expect(theirs, "premise: not the move Black sent").not.toBe(LINE[1]);
    serveStream(gameFull(g, MID, { moves: [LINE[0]!, theirs] }));
    await blackSubmits(g, LINE[1]!, FIVE_XX);
    await settled();
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual([LINE[0], theirs]);
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length).toBe(1);
    expect(flags[0]!.note).toContain(`ply 2 (${theirs})`);
  });

  it("our move AND plies beyond it: only the plies beyond are flagged", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4) }));
    await blackSubmits(g, LINE[1]!, FIVE_XX);
    await settled();
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 4));
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length).toBe(1);
    expect(flags[0]!.note).toContain(`plies 3-4 (${LINE.slice(2, 4).join(" ")})`);
    expect(flags[0]!.note, "ply 2 is ours").not.toMatch(/plies 2-|ply 2 /);
  });

  it("the EXPORT path (no stream opens: Lichess 503s both) knows our move too: only the plies beyond it are flagged", async () => {
    const g = await liveGame();
    // Not "no grant": T10 itself refuses a seat without one, before Lichess.
    lichess.onStream = () => status(503);
    lichess.onExport = () => ok(exported(g, "export-expired.json"));
    await blackSubmits(g, LINE[1]!, FIVE_XX);
    await settled();
    expect(exports().length, "premise: the export was the read").toBe(1);
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE);
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length).toBe(1);
    expect(flags[0]!.note).toContain(`plies 3-${LINE.length} (${LINE.slice(2).join(" ")})`);
  });

  it("the EXPORT path adopting ONLY our move writes no flag", async () => {
    const g = await liveGame();
    lichess.onStream = () => status(503);
    lichess.onExport = () => ok(exported(g, "export-expired.json", { moves: SAN.slice(0, 2) }));
    await blackSubmits(g, LINE[1]!, FIVE_XX);
    await settled();
    expect(exports().length, "premise: the export was the read").toBe(1);
    expect((await rowOf(g.fixtureId)).moves_uci, "adopted").toEqual(LINE.slice(0, 2));
    expect(await flagsOf(g.fixtureId)).toEqual([]);
  });

  it("a submission at ANOTHER ply than the first adopted one excuses nothing (the ply is part of the match)", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
    // The same string, claimed at ply 0 (White's, already on file): not the
    // move at the ply being adopted, so ply 2 is evidence.
    await reconcile(g.fixtureId, "rejected_move", observed().deps, { ply: 0, uci: LINE[1]! });
    const flags = await flagsOf(g.fixtureId);
    expect(flags.length).toBe(1);
    expect(flags[0]!.note).toContain(`ply 2 (${LINE[1]})`);
  });

  it("a submission names a REJECTED move only: any other trigger carrying one is refused by name before a read — counted", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    let checked = 0;
    for (const t of RECONCILE_TRIGGERS.filter((x) => x !== "rejected_move")) {
      await expect(reconcile(g.fixtureId, t, observed().deps, { ply: 1, uci: LINE[1]! }), t).rejects.toMatchObject({
        code: "SUBMITTED_WITHOUT_REJECTED_MOVE",
      });
      checked++;
    }
    expect(checked).toBe(RECONCILE_TRIGGERS.length - 1);
    expect(lichess.calls).toEqual([]);
  });

  it("no read when nothing Lichess refused: an accepted move, our own turn refusal, an absorbed duplicate — nor on a 429 — counted", async () => {
    const cases: [string, (g: Game) => Promise<unknown>][] = [
      ["accepted", (g) => play(g, LINE.slice(1, 2))],
      ["out of turn, refused HERE", (g) =>
        act({ fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "move", uci: "d2d4" } }, submitAnswering({ ok: true }))],
      ["absorbed duplicate", (g) =>
        act({ fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "move", uci: LINE[0]! } }, submitAnswering({ ok: true }))],
      ["rate limited", (g) =>
        act({ fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci: LINE[1]! } },
          submitAnswering({ ok: false, code: "rate_limited", raw: "429" }))],
    ];
    let checked = 0;
    for (const [name, arrange] of cases) {
      const g = await liveGame();
      serveStream(gameFull(g, MID));
      await arrange(g);
      expect(tasks, `${name}: nothing deferred`).toEqual([]);
      expect(lichess.calls, name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("a reconcile that cannot run leaves the player's answer as it was and logs the CODE — never a token", async () => {
    const g = await liveGame();
    // Both sealed tokens unreadable by our key: reconcile raises 503
    // LICHESS_TOKEN_UNAVAILABLE (never swallowed by reconcile itself).
    for (const p of [g.white, g.black]) {
      await sql`update user_external_accounts set access_token_enc = ${Buffer.from("not a sealed token")} where user_id = ${p.userId} and provider = 'lichess'`;
    }
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    try {
      const out = await act(
        { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci: LINE[1]! } },
        submitAnswering({ ok: false, code: "not_your_turn_or_over", raw: "400" }),
      );
      expect(out).toEqual({ ok: false, reconcile: true, reason: "not_your_turn_or_over" });
      await settled();
      const logged = errors.mock.calls.filter((c) => String(c[1]).includes("rejected move"));
      expect(logged.length).toBe(1);
      expect(logged[0]![0]).toMatchObject({ fixtureId: g.fixtureId, code: "LICHESS_TOKEN_UNAVAILABLE" });
      expect(JSON.stringify(errors.mock.calls), "no token in any log line").not.toMatch(/lio_seed_|tok-/);
    } finally {
      errors.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T11 fix round 2 — N3: a player's refused move is answered without waiting
// on Lichess. The rejected_move reconcile is DEFERRED through the repo's
// `deferred` (Next's after() in a request scope); nothing here injects it.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — N3: the refused move's answer never waits on Lichess reads", () => {
  const refusedBy5xx = {
    now: new Date(MOVED.getTime() + 60_000),
    accessToken: async (u: string) => `tok-${u}`,
    publish: async () => {},
    submitMove: async (): Promise<BoardCall> => ({ ok: false, code: "unavailable", raw: "timeout" }),
  };
  const REFUSED = { ok: false, reconcile: true, reason: "unavailable" };

  it("every Lichess read held open: the answer comes back first; the reconcile finishes after (×3)", async () => {
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      const g = await liveGame();
      serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let readsHeld = 0;
      const serve = lichess.serve;
      lichess.serve = async (url, init) => {
        readsHeld++;
        await held;
        return serve(url, init);
      };
      try {
        const answer = act({ fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci: LINE[1]! } }, refusedBy5xx);
        const first = await Promise.race([answer, new Promise((r) => setTimeout(() => r("GATED ON A READ"), 2_000))]);
        expect(first, `run ${run}: answered while every read is held`).toEqual(REFUSED);
        // The reconcile is under way, and stuck at Lichess — not finished.
        await vi.waitFor(() => expect(readsHeld).toBeGreaterThan(0), { timeout: 5_000 });
        expect((await rowOf(g.fixtureId)).moves_uci, "nothing adopted while the read is held").toEqual(LINE.slice(0, 1));
        release();
        await vi.waitFor(async () => expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 2)), { timeout: 10_000 });
      } finally {
        release();
        lichess.serve = serve;
      }
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("inside a request scope it is handed to after(): no Lichess read happens before the response", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 2) }));
    let registered: (() => unknown) | undefined;
    vi.mocked(after).mockImplementationOnce((task) => {
      registered = task as () => unknown;
    });
    const out = await act({ fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "move", uci: LINE[1]! } }, refusedBy5xx);
    expect(out).toEqual(REFUSED);
    expect(typeof registered, "registered with after()").toBe("function");
    expect(lichess.calls, "nothing read before the response").toEqual([]);
    await registered!();
    expect(streams().length, "the read runs in the after-window").toBe(1);
    expect((await rowOf(g.fixtureId)).moves_uci).toEqual(LINE.slice(0, 2));
  });
});

// ---------------------------------------------------------------------------
// T11 fix round 1 — M7: the innocent seat plays on under a token_revoked hold
// and can win on the clock; reconcile writes the end over the hold.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — M7: the seat whose token works plays on and can win on the clock", () => {
  it("a divergence read on a token_revoked row freezes BOTH seats and keeps its diagnosis (review N2)", async () => {
    const g = await liveGame();
    const refused = await act(
      { fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "resign" } },
      { accessToken: async (u) => `tok-${u}`, publish: async () => {}, resignGame: async () => ({ ok: false, code: "unauthorized", raw: "401" }) },
    );
    expect(refused).toEqual({ ok: false, reconcile: true, reason: "unauthorized" });
    await play(g, LINE.slice(1, 2));
    // Lichess's line no longer extends ours (a takeback, foreign moves).
    serveStream(gameFull(g, MID, { moves: ["d2d4", "d7d5"] }));
    await reconcile(g.fixtureId, "sweep", observed().deps);
    const r = await rowOf(g.fixtureId);
    expect(r, "the first diagnosis stands; the freeze widens").toMatchObject({
      status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "both", moves_uci: LINE.slice(0, 2),
    });
    expect(r.last_error, "the divergence is what the organiser reads").toContain("does not extend ours");
    // Black, the seat that was playing on, now acts on nothing.
    let checked = 0;
    for (const action of [{ kind: "move", uci: "g1f3" }, { kind: "draw", accept: true }] as const) {
      const who = action.kind === "move" ? g.white : g.black;
      await expect(
        act({ fixtureId: g.fixtureId, personId: who.personId, action }, { accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }), offerOrAcceptDraw: async () => ({ ok: true }) }),
        action.kind,
      ).rejects.toMatchObject({ status: 404 });
      checked++;
    }
    expect(checked).toBe(2);
    expect((await rowOf(g.fixtureId)).moves_uci, "nothing appended onto a line reconcile distrusts").toEqual(LINE.slice(0, 2));
  });

  it("White's 401 freezes White; Black moves through T10; Lichess flags White ⇒ Black wins, the revoke still shows", async () => {
    const g = await liveGame();
    // White is off-turn at ply 1; White's resign is refused 401 by T10's act.
    const refused = await act(
      { fixtureId: g.fixtureId, personId: g.white.personId, action: { kind: "resign" } },
      { accessToken: async (u) => `tok-${u}`, publish: async () => {}, resignGame: async () => ({ ok: false, code: "unauthorized", raw: "401" }) },
    );
    expect(refused).toEqual({ ok: false, reconcile: true, reason: "unauthorized" });
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "white" });
    await play(g, LINE.slice(1, 2));
    expect((await rowOf(g.fixtureId)).moves_uci, "the innocent seat's move is recorded on the held row").toEqual(LINE.slice(0, 2));
    // EXPIRED_2: White ran out of time, Black wins (the recording).
    serveStream(gameFull(g, EXPIRED_2));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toMatchObject({ result: { wrote: "decided" } });
    expect(EXPIRED_2.state.winner, "premise: the recording's winner").toBe("black");
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner), "Black, whose token works, wins on the clock").toEqual([g.black.entrantId]);
    expect(await rowOf(g.fixtureId), "the organiser queue still shows the revoke").toMatchObject({
      status: "needs_organiser",
      needs_reason: "token_revoked",
      revoked_seat: "white",
    });
  });
});

describe.runIf(HAS_DB)("reconcile — property: any interleaving of triggers and Lichess reads", () => {
  // Lichess's truth only moves forward in time: its line grows (by T10 or
  // out of band), then one end freezes it. Each step may first ACT through
  // T10's real `act` (a move, a draw offer) or withdraw an entrant, then
  // advances that truth out of band, then reconciles on a trigger through one
  // of three read paths (review M6: the alphabet is no longer reconcile-only).
  // The model below is the SPEC's (§3.5, the controller's carries, T12's
  // rulebook for a league, lila's draw rules as T10 transcribes them), never
  // reconcile's — and the model owns the offer and the closed state:
  //   - the stream, when a seat opens it, is the truth; the ledger becomes its
  //     line (it never shortens — Lichess's never does here);
  //   - when no seat opens it, the export counts only for a final status;
  //   - clock_zero on a `started` line with the mover's clock at 0 reads
  //     exactly once more (the re-read sees the same truth here);
  //   - a final status closes the bridge, once — except `aborted`, which
  //     T12 holds; a closed or held-final row is never read again;
  //   - a withdrawn entrant closes the bridge on the next reconcile with no
  //     read and no result; a closed, held or withdrawn board takes no T10 act;
  //   - offers, lila's (Drawer.scala, as T10 transcribes it): one standing
  //     offer at most; a yes from the opponent of a standing offer IS the draw;
  //     an offer needs ply >= 2 and no own offer in the last 20 plies; a move
  //     declines the opponent's offer. T10 applies the same rules to ITS row.
  //     A stream read takes Lichess's offer (a new one at the read's ply); an
  //     end, a withdrawal close and a terminal export clear it; plies stay.
  type End = "outoftime" | "resign" | "draw" | "aborted";
  type Mode = "stream" | "white_down" | "export";
  type Act = "none" | "move" | "offer_white" | "offer_black" | "withdraw";
  type Step = { act: Act; advance: number; end: End | null; trigger: ReconcileTrigger; mode: Mode; flagDue: boolean };
  // lila's draw rules (Drawer.scala), the rulebook here — T10's play suite pins
  // its own constants against the same source.
  const LILA_DRAW_MIN_PLY = 2;
  const LILA_REOFFER_PLIES = 20;
  const stepArb: fc.Arbitrary<Step> = fc.record({
    act: fc.oneof(
      { arbitrary: fc.constant<Act>("none"), weight: 6 },
      { arbitrary: fc.constant<Act>("move"), weight: 3 },
      { arbitrary: fc.constantFrom<Act>("offer_white", "offer_black"), weight: 2 },
      { arbitrary: fc.constant<Act>("withdraw"), weight: 1 },
    ),
    advance: fc.integer({ min: 0, max: 3 }),
    end: fc.oneof(
      { arbitrary: fc.constant(null), weight: 5 },
      { arbitrary: fc.constantFrom<End>("outoftime", "resign", "draw", "aborted"), weight: 1 },
    ),
    trigger: fc.constantFrom(...RECONCILE_TRIGGERS),
    mode: fc.constantFrom<Mode>("stream", "white_down", "export"),
    flagDue: fc.boolean(),
  });
  const s = (o: Partial<Step> & Pick<Step, "trigger" | "mode">): Step => ({ act: "none", advance: 0, end: null, flagDue: false, ...o });
  // Each path's forced prefix ENDS with the step that makes its claim.
  const PATHS = {
    stream_settles: [s({ advance: 3, trigger: "sweep", mode: "stream" }), s({ advance: 2, end: "resign", trigger: "game_end", mode: "stream" })],
    flag_reread: [s({ advance: 4, trigger: "clock_zero", mode: "white_down", flagDue: true })],
    export_settles: [s({ advance: 2, end: "outoftime", trigger: "sweep", mode: "export" })],
    export_ignored_then_aborted: [
      s({ advance: 5, trigger: "organiser", mode: "export" }),
      s({ end: "aborted", trigger: "rejected_move", mode: "white_down" }),
    ],
    // T10 plays the move Lichess is waiting for; the read adopts nothing.
    t10_move_read_back: [s({ act: "move", trigger: "sweep", mode: "stream" })],
    // White offers at ply 2 through T10; Black then moves out of band (which
    // declines it at Lichess); the read clears the offer, keeping its ply.
    offer_declined_by_a_move: [
      s({ advance: 2, trigger: "sweep", mode: "stream" }),
      s({ act: "offer_white", trigger: "organiser", mode: "stream" }),
      s({ advance: 2, trigger: "sweep", mode: "white_down" }),
    ],
    // Our row is behind (an untrusted mid-game export): T10 records nothing
    // at ply 0, Lichess holds the offer at ply 3, and the read adopts it.
    offer_adopted_from_the_read: [
      s({ advance: 3, trigger: "sweep", mode: "export" }),
      s({ act: "offer_white", trigger: "organiser", mode: "stream" }),
    ],
    // Black's yes to White's standing offer IS the draw at Lichess.
    offer_accepted_is_the_draw: [
      s({ advance: 2, trigger: "sweep", mode: "stream" }),
      s({ act: "offer_white", trigger: "sweep", mode: "stream" }),
      s({ act: "offer_black", trigger: "game_end", mode: "stream" }),
    ],
    // A withdrawal closes the board unread; T10 then refuses a move.
    withdrawn_closes_unread: [
      s({ advance: 1, trigger: "sweep", mode: "stream" }),
      s({ act: "withdraw", trigger: "organiser", mode: "stream" }),
      s({ act: "move", trigger: "sweep", mode: "stream" }),
    ],
  } as const;
  type PathName = keyof typeof PATHS;
  const PATH_NAMES = Object.keys(PATHS) as PathName[];
  const K = 4; // runs per path
  const counters = {
    steps: 0, adopted: 0, reread: 0, export_ignored: 0, settled_stream: 0, settled_export: 0,
    held_final: 0, silent_after_close: 0, white_down: 0,
    t10_moves: 0, t10_offers_recorded: 0, t10_offers_lichess_only: 0, t10_refused_closed: 0,
    offer_cleared_by_read: 0, offer_adopted_by_read: 0, accepted_draw: 0, withdrawn_closed: 0,
  };
  // Reported, not required: what a random suffix happened to reach.
  const incidental = { t10_move_out_of_sync: 0, t10_offer_noop: 0 };
  const claims = Object.fromEntries(PATH_NAMES.map((p) => [p, 0])) as Record<PathName, number>;

  it("holds the model on every step — counted per path, K runs each", async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 0, maxLength: 4 }), async (suffix) => {
        const path = PATH_NAMES[run % PATH_NAMES.length]!;
        run++;
        const steps = [...PATHS[path], ...suffix];
        const g = await readyGame();
        const truth = {
          ply: 0, end: null as End | null, offer: null as Colour | null,
          lastOffer: { white: null as number | null, black: null as number | null },
        };
        const model = {
          ledger: 0, closed: false, heldFinal: false, resulted: false, withdrawn: false,
          offer: null as Colour | null, offerPly: { white: null as number | null, black: null as number | null },
        };
        let finishedAt: Date | null = null;
        for (const [i, step] of steps.entries()) {
          const at = new Date(READ.getTime() + i * 10_000);
          const label0 = `${path} step ${i} ${JSON.stringify(step)}`;
          const shut = model.closed || model.heldFinal || model.withdrawn;
          // 1. THE ACT, through T10's real `act` (Lichess answering 200).
          let actClaim = false;
          if (step.act === "withdraw") {
            if (!shut) {
              await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
              model.withdrawn = true;
            }
          } else if (step.act !== "none") {
            const who: Colour = step.act === "move" ? (model.ledger % 2 === 0 ? "white" : "black") : step.act === "offer_white" ? "white" : "black";
            const action = step.act === "move" ? { kind: "move" as const, uci: LINE[model.ledger] ?? "e2e4" } : { kind: "draw" as const, accept: true };
            const doAct = () => act(
              { fixtureId: g.fixtureId, personId: g[who].personId, action },
              {
                now: new Date(at.getTime() - 5_000),
                accessToken: async (u) => `tok-${u}`,
                publish: async () => {},
                submitMove: async () => ({ ok: true }),
                offerOrAcceptDraw: async () => ({ ok: true }),
              },
            );
            if (shut) {
              await expect(doAct(), `${label0}: a closed, held or withdrawn board takes no act`).rejects.toMatchObject({ status: 404 });
              counters.t10_refused_closed++;
              actClaim = true;
            } else {
              // Guard, not comment: an ended truth is read the step it ends,
              // so an open board here is always a running game at Lichess.
              expect(truth.end, `${label0}: model — an open board's game is running`).toBeNull();
              if (step.act === "move") {
                if (truth.ply === model.ledger && model.ledger < LINE.length) {
                  expect(await doAct(), `${label0}: T10 move`).toEqual({ ok: true, applied: true });
                  if (truth.offer === (who === "white" ? "black" : "white")) truth.offer = null;
                  if (model.offer === (who === "white" ? "black" : "white")) model.offer = null;
                  truth.ply++;
                  model.ledger++;
                  counters.t10_moves++;
                  actClaim = true;
                } else {
                  // Lichess has moved on (or the line is spent): not this
                  // model's to play — the I4 suite drives that refusal.
                  incidental.t10_move_out_of_sync++;
                }
              } else {
                expect(await doAct(), `${label0}: T10 offer`).toEqual({ ok: true, applied: true });
                const other: Colour = who === "white" ? "black" : "white";
                // lila first: the opponent's standing offer makes this yes the draw.
                if (truth.offer === other) {
                  truth.end = "draw";
                  truth.offer = null;
                  counters.accepted_draw++;
                  actClaim = true;
                } else if (
                  truth.offer === null && truth.ply >= LILA_DRAW_MIN_PLY &&
                  (truth.lastOffer[who] === null || truth.lastOffer[who]! < truth.ply - LILA_REOFFER_PLIES)
                ) {
                  truth.offer = who;
                  truth.lastOffer[who] = truth.ply;
                }
                // …then T10's row, by the same rules against ITS ledger.
                if (
                  model.offer === null && model.ledger >= LILA_DRAW_MIN_PLY &&
                  (model.offerPly[who] === null || model.offerPly[who]! < model.ledger - LILA_REOFFER_PLIES)
                ) {
                  model.offer = who;
                  model.offerPly[who] = model.ledger;
                  counters.t10_offers_recorded++;
                  actClaim = true;
                } else if (truth.offer === who && truth.lastOffer[who] === truth.ply) {
                  counters.t10_offers_lichess_only++;
                  actClaim = true;
                } else {
                  incidental.t10_offer_noop++;
                }
              }
            }
          }
          // 2. Lichess's truth moves on out of band; a move declines the
          //    opponent's standing offer.
          if (truth.end === null) {
            const to = Math.min(LINE.length, truth.ply + step.advance);
            for (let p = truth.ply; p < to; p++) {
              const mover: Colour = p % 2 === 0 ? "white" : "black";
              if (truth.offer !== null && truth.offer !== mover) truth.offer = null;
            }
            truth.ply = to;
            truth.end = step.end;
          }
          const moverIsWhite = truth.ply % 2 === 0;
          const zero = truth.end === null && step.flagDue;
          const winner: Colour = moverIsWhite ? "black" : "white";
          const line = gameFull(g, MID, {
            moves: LINE.slice(0, truth.ply),
            ...(truth.end === null ? {} : { status: truth.end }),
            ...(truth.end === "outoftime" || truth.end === "resign" ? { winner } : {}),
            ...(zero ? (moverIsWhite ? { wtime: 0 } : { btime: 0 }) : {}),
            ...(truth.end === null && truth.offer === "white" ? { wdraw: true as const } : {}),
            ...(truth.end === null && truth.offer === "black" ? { bdraw: true as const } : {}),
          });
          lichess.reset();
          lichess.onStream = (c) =>
            step.mode === "export" || (step.mode === "white_down" && c.token === tokenOf(g.white)) ? status(503) : ok(line);
          lichess.onExport = () =>
            ok(truth.end === null
              ? exported(g, "export-mid.json", { moves: SAN.slice(0, Math.max(0, truth.ply - 3)), status: "started", winner: null })
              : exported(g, "export-expired.json", {
                  moves: SAN.slice(0, truth.ply),
                  status: truth.end,
                  winner: truth.end === "outoftime" || truth.end === "resign" ? winner : null,
                }));
          // D11: the unsettled-flag hold is its own suite's (its bound pinned there); here every read path runs.
          const { deps, settles } = observed(at, { flagUnsettledAfterMs: Number.POSITIVE_INFINITY });
          const out = await reconcile(g.fixtureId, step.trigger, deps);
          counters.steps++;
          const label = `${path} step ${i} ${JSON.stringify(step)} truth=${JSON.stringify(truth)}`;

          if (model.closed || model.heldFinal) {
            expect(lichess.calls, `${label}: a closed board is never read`).toEqual([]);
            expect(out, label).toBeNull();
            counters.silent_after_close++;
          } else if (model.withdrawn) {
            // The fixture is no longer playable: closed with no read, no result.
            expect(lichess.calls, `${label}: a withdrawn board is closed unread`).toEqual([]);
            expect(out, label).toBeNull();
            model.closed = true;
            model.offer = null;
            counters.withdrawn_closed++;
          } else {
            const perRead = step.mode === "stream" ? 1 : 2;
            // D11: a zero clock is read once more, on a held stream, whatever the trigger.
            const reread = step.mode !== "export" && zero ? 1 : 0;
            expect(streams().length, `${label}: stream reads`).toBe(perRead * (1 + reread));
            expect(exports().length, `${label}: export reads`).toBe(step.mode === "export" ? 1 : 0);
            expect([...settles], label).toEqual(reread ? Array<number>(perRead).fill(FLAG_SETTLE_HOLD_MS) : []);
            if (reread) counters.reread++;
            if (step.mode === "white_down") counters.white_down++;
            const trusted = step.mode !== "export" || truth.end !== null;
            if (trusted) {
              if (truth.ply > model.ledger) counters.adopted++;
              model.ledger = Math.max(model.ledger, truth.ply);
              if (truth.end !== null) {
                model.offer = null;
              } else if (truth.offer === null) {
                if (model.offer !== null) counters.offer_cleared_by_read++;
                model.offer = null;
              } else if (truth.offer !== model.offer && truth.ply >= LILA_DRAW_MIN_PLY) {
                model.offer = truth.offer;
                model.offerPly[truth.offer] = truth.ply;
                counters.offer_adopted_by_read++;
              }
              if (truth.end === "aborted") {
                model.heldFinal = true;
                counters.held_final++;
              } else if (truth.end !== null) {
                model.closed = true;
                model.resulted = true;
                if (step.mode === "export") counters.settled_export++;
                else counters.settled_stream++;
              }
            } else {
              counters.export_ignored++;
              expect(out, `${label}: a mid-game export is not trusted`).toBeNull();
            }
          }

          const r = await rowOf(g.fixtureId);
          expect(r.moves_uci, `${label}: ledger`).toEqual(LINE.slice(0, model.ledger));
          expect(r.move_count, label).toBe(model.ledger);
          expect([r.draw_offer_by, r.white_draw_offer_ply, r.black_draw_offer_ply], `${label}: the offer`).toEqual([
            model.offer, model.offerPly.white, model.offerPly.black,
          ]);
          const want = model.closed ? "finished" : model.heldFinal ? "needs_organiser" : model.ledger > 0 ? "live" : "ready";
          expect(r.status, `${label}: status`).toBe(want);
          if (model.heldFinal) expect(r.needs_reason, label).toBe("aborted");
          if (model.closed) {
            finishedAt ??= r.finished_at;
            expect(r.finished_at, `${label}: finished once, first stamp kept`).toEqual(finishedAt);
          } else {
            expect(r.finished_at, label).toBeNull();
          }
          expect((await resultsOf(g.fixtureId)).length, `${label}: results`).toBe(model.resulted ? 1 : 0);

          // The forced prefix's last step is the path's claim.
          if (i === PATHS[path].length - 1) {
            const claimed: Record<PathName, () => boolean> = {
              stream_settles: () => model.closed && step.mode === "stream",
              flag_reread: () => settles.length > 0,
              export_settles: () => model.closed && step.mode === "export",
              export_ignored_then_aborted: () => model.heldFinal,
              t10_move_read_back: () => actClaim && model.ledger === 1 && out?.adopted === 0,
              offer_declined_by_a_move: () => model.offer === null && model.offerPly.white === 2 && r.move_count === 4,
              offer_adopted_from_the_read: () => model.offer === "white" && model.offerPly.white === 3 && actClaim,
              offer_accepted_is_the_draw: () => actClaim && model.closed && model.resulted && truth.end === "draw",
              withdrawn_closes_unread: () => actClaim && model.closed && !model.resulted,
            };
            if (claimed[path]()) claims[path]++;
          }
        }
      }),
      { numRuns: K * PATH_NAMES.length, endOnFailure: true },
    );
    expect(run).toBe(K * PATH_NAMES.length);
    console.info("reconcile property counters", JSON.stringify({ counters, incidental, claims }));
    for (const p of PATH_NAMES) expect(claims[p], `every ${p} run made its claim`).toBe(K);
    for (const [name, n] of Object.entries(counters)) expect(n, `path counter ${name}`).toBeGreaterThan(0);
  });
});

// T16 fix round 3, N4 (controller ruling (b)). A board whose online game ended and whose result the organiser then
// voided on the pad: the fixture is open again, the bridge stays finished — the bridge cannot reopen a game Lichess
// ended (Gap 3). The online settle is not the tool for it: the server answers ONLINE_GAME_OVER, pointing to the
// scoring pad, never "already has its result" (it has none), and the arbiter panel offers no settle. Reached through
// the real producers: reconcile reads the recorded game end, T12 writes the result, the pad's void undoes it.
describe.runIf(HAS_DB)("an online game over, its result voided on the pad (N4)", () => {
  const refusalOf = (p: Promise<unknown>) =>
    p.then(
      (ok) => ({ ok }),
      (err: unknown) => (err instanceof HttpError ? { refused: [err.status, err.code] } : Promise.reject(err)),
    );

  it("settling is refused ONLINE_GAME_OVER and writes nothing; the panel offers no settle — before the void it is ALREADY_RESOLVED", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    const { deps } = observed();
    expect(await reconcile(g.fixtureId, "game_end", deps), "premise: the game end wrote the result").toMatchObject({
      result: { wrote: "decided" },
      finished: true,
    });
    const organiser = { orgId: g.orgId, via: "session", userId: g.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    const panelBoard = async () => (await loadArbiterRound(organiser, g.divisionId))!.boards.find((b) => b.fixtureId === g.fixtureId)!;

    // Before the void: the board has its result — the other answer, and no settle either.
    expect(await refusalOf(resolveExternalPlay(organiser, g.fixtureId, "home_wins"))).toEqual({ refused: [409, "ALREADY_RESOLVED"] });
    expect(offersSettle(await panelBoard()), "a decided board offers no settle").toBe(false);

    // The organiser voids the result on the pad (the pad's own write).
    const [res] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${g.fixtureId} and type = 'boardgame.result'`;
    const [{ last }] = await sql<{ last: number }[]>`select max(seq)::int as last from score_events where fixture_id = ${g.fixtureId}`;
    await scoreEvent(organiser, g.fixtureId, { expected_seq: last, type: "core.void", payload: { event_id: res!.id } });
    expect(await fixtureStatus(g.fixtureId), "premise: the void opened the fixture again").toBe("in_play");
    expect((await rowOf(g.fixtureId)).status, "premise: the bridge stays finished").toBe("finished");
    const [{ n: before }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${g.fixtureId}`;

    // Every way to settle gets the same true answer, and none writes.
    let refused = 0;
    for (const kind of RESOLVE_KINDS) {
      expect(await refusalOf(resolveExternalPlay(organiser, g.fixtureId, kind)), kind).toEqual({ refused: [409, "ONLINE_GAME_OVER"] });
      refused++;
    }
    expect(refused, "anti-vacuity: every settle kind asked").toBe(RESOLVE_KINDS.length);
    const [{ n: after }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${g.fixtureId}`;
    expect(after, "nothing written").toBe(before);
    expect((await rowOf(g.fixtureId)).status).toBe("finished");

    // The panel, from the same loader the page uses: no settle offered on it.
    const b = await panelBoard();
    expect([b.state.kind, b.canSettle, b.playable], "the panel reads the online game as over").toEqual(["result", false, false]);
    expect(offersSettle(b), "the panel offers no settle the server refuses").toBe(false);
  });
});


// T17B fix 2 (D8b), measured on stg: after the checkmate both cameras kept publishing until the sweep's teardown six
// minutes later (job 3, every 5 min). Ruling: the server ends the meeting best-effort, WITHOUT blocking, when the
// result is recorded — the game end read from Lichess, and the organiser's settle — and the sweep stays the backstop.
// The meeting is a real one: minted, kicked and deactivated at the e2e RealtimeKit fixture server.
describe.runIf(HAS_DB)("the result ends the camera room — after the answer, never failing it (T17B fix 2, D8b)", () => {
  let fx: RealtimeKitFixtureServer;
  beforeAll(async () => {
    fx = await startRealtimeKitFixtureServer(0);
  });
  afterAll(async () => {
    await fx.close();
  });
  beforeEach(() => {
    fx.reset();
    for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The tail work a call hands to `defer`, held until the test runs it — so "after the answer" is observable. */
  function heldTail() {
    const queued: (() => Promise<unknown>)[] = [];
    return { defer: (task: () => Promise<unknown>) => void queued.push(task), queued, run: () => Promise.all(queued.splice(0).map((t) => t())) };
  }
  async function endedAt(fixtureId: string): Promise<Date | null> {
    const [row] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`;
    return row?.ended_at ?? null;
  }
  const meetingCalls = (meetingId: string) => fx.calls.filter((c) => c.path.includes(`/meetings/${meetingId}`)).map((c) => `${c.method} ${c.path.slice(c.path.indexOf("/meetings/"))}`);
  const organiserOf = (g: Game) => ({ orgId: g.orgId, via: "session", userId: g.ownerUserId, role: "owner", keyId: null }) as AuthCtx;

  it("the empty case: a game end with no camera room on file ends nothing and calls nobody — the result still lands", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    const tail = heldTail();
    expect(await reconcile(g.fixtureId, "game_end", { ...observed().deps, room: { defer: tail.defer } })).toMatchObject({ result: { wrote: "decided" }, finished: true });
    await tail.run();
    expect(fx.calls, "no vendor call").toEqual([]);
  });

  it("the game's end at Lichess ends the room AFTER the answer: kicked, INACTIVE, ended_at stamped — once", async () => {
    const g = await liveGame();
    const { meetingId } = await ensureMeeting(g.fixtureId, "home");
    serveStream(gameFull(g, EXPIRED_2));
    const tail = heldTail();
    const out = await reconcile(g.fixtureId, "game_end", { ...observed().deps, room: { defer: tail.defer } });
    expect(out, "the result is the answer").toMatchObject({ result: { wrote: "decided" }, finished: true });
    // Not yet: the answer never waited on the vendor.
    expect([fx.meetingStatus(meetingId), await endedAt(g.fixtureId)], "the answer came first").toEqual(["ACTIVE", null]);
    expect(tail.queued.length, "one tail task").toBe(1);
    await tail.run();
    expect(fx.meetingStatus(meetingId)).toBe("INACTIVE");
    expect(await endedAt(g.fixtureId)).not.toBeNull();
    expect(meetingCalls(meetingId).filter((c) => c.startsWith("POST") && c.endsWith("/kick-all")), "everyone kicked").toHaveLength(1);
    // A second read of the ended game ends nothing more.
    serveStream(gameFull(g, EXPIRED_2));
    expect(await reconcile(g.fixtureId, "game_end", { ...observed(later(60_000)).deps, room: { defer: tail.defer } })).toBeNull();
    await tail.run();
    expect(meetingCalls(meetingId).filter((c) => c.endsWith("/kick-all"))).toHaveLength(1);
  });

  it("a vendor outage never fails the result: the result is written, the tail settles quietly, and the room is left for the sweep (ended_at still null)", async () => {
    const g = await liveGame();
    const { meetingId } = await ensureMeeting(g.fixtureId, "home");
    serveStream(gameFull(g, EXPIRED_2));
    fx.setUnavailable(true);
    const warn = vi.spyOn(log, "warn");
    const tail = heldTail();
    expect(await reconcile(g.fixtureId, "game_end", { ...observed().deps, room: { defer: tail.defer } })).toMatchObject({ result: { wrote: "decided" }, finished: true });
    await expect(tail.run(), "the tail never rejects").resolves.toBeDefined();
    expect(await endedAt(g.fixtureId), "the sweep's job 3 picks it up: ended_at is null").toBeNull();
    expect(warn.mock.calls.some(([o]) => (o as { meetingId?: string }).meetingId === meetingId), "logged, with the meeting").toBe(true);
    fx.setUnavailable(false);
    expect(fx.meetingStatus(meetingId)).toBe("ACTIVE");
    warn.mockRestore();
  });

  it("D21: the call budget spent never fails the result either: the teardown is deferred, no request is made, the room is left unended for the sweep", async () => {
    const g = await liveGame();
    const { meetingId } = await ensureMeeting(g.fixtureId, "home");
    const asked = fx.calls.length;
    const tail = heldTail();
    endRoomAtResult(g.fixtureId, { defer: tail.defer, endMeeting: async () => { throw new RealtimeKitDeferred("test: budget spent"); } });
    await sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${g.fixtureId}`;
    await expect(tail.run(), "the tail never rejects").resolves.toBeDefined();
    expect(await endedAt(g.fixtureId), "left for the sweep's job 3").toBeNull();
    expect(fx.calls.length - asked, "the stub made no request").toBe(0);
    expect(fx.meetingStatus(meetingId)).toBe("ACTIVE");
  });

  it("the guard: a room whose game is still on (bridge live, fixture playable) is never ended — and the positive pair, a finished bridge, is", async () => {
    const g = await liveGame();
    const { meetingId } = await ensureMeeting(g.fixtureId, "home");
    const tail = heldTail();
    endRoomAtResult(g.fixtureId, { defer: tail.defer });
    await tail.run();
    expect([fx.meetingStatus(meetingId), await endedAt(g.fixtureId)], "a live game keeps its room").toEqual(["ACTIVE", null]);
    expect(meetingCalls(meetingId).filter((c) => c.endsWith("/kick-all")), "nobody kicked").toHaveLength(0);
    await sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${g.fixtureId}`;
    endRoomAtResult(g.fixtureId, { defer: tail.defer });
    await tail.run();
    expect(fx.meetingStatus(meetingId)).toBe("INACTIVE");
    // Ended once is ended: a second call (another reader of the same end) asks the vendor nothing — RealtimeKit's
    // limit is account-wide.
    const asked = fx.calls.length;
    endRoomAtResult(g.fixtureId, { defer: tail.defer });
    await tail.run();
    expect(fx.calls.length, "no vendor call for a room already ended").toBe(asked);
  });

  it("D16: a game with a room PER PLAYER ends both at the result, each in its own try - a room the vendor refuses stays unended for the sweep and the other still ends", async () => {
    const g = await liveGame();
    const home = await ensureMeeting(g.fixtureId, "home");
    const away = await ensureMeeting(g.fixtureId, "away");
    expect(home.meetingId, "premise: two rooms").not.toBe(away.meetingId);
    await sql`update fixture_external_play set status = 'finished', finished_at = now() where fixture_id = ${g.fixtureId}`;
    const state = async () =>
      (await sql<{ side: string; ended_at: Date | null }[]>`select side, ended_at from fixture_video_meetings where fixture_id = ${g.fixtureId} order by side`).map(
        (r) => [r.side, r.ended_at !== null],
      );

    const asked: string[] = [];
    const tail = heldTail();
    endRoomAtResult(g.fixtureId, {
      defer: tail.defer,
      endMeeting: async (id) => {
        asked.push(id);
        if (id === home.meetingId) throw new Error("test: the vendor refused home's room");
        return endMeeting(id);
      },
    });
    await expect(tail.run(), "the tail never rejects").resolves.toBeDefined();
    expect(asked.sort(), "both rooms were tried - the first one's refusal did not stop the second").toEqual([away.meetingId, home.meetingId].sort());
    expect(await state(), "away ended, home left for the sweep").toEqual([["away", true], ["home", false]]);
    expect([fx.meetingStatus(home.meetingId), fx.meetingStatus(away.meetingId)]).toEqual(["ACTIVE", "INACTIVE"]);

    // The next reader of the same end asks only about the room still unended, and then both are ended.
    asked.length = 0;
    endRoomAtResult(g.fixtureId, {
      defer: tail.defer,
      endMeeting: async (id) => {
        asked.push(id);
        return endMeeting(id);
      },
    });
    await tail.run();
    expect(asked, "only the unended room is asked").toEqual([home.meetingId]);
    expect(await state()).toEqual([["away", true], ["home", true]]);
    expect([fx.meetingStatus(home.meetingId), fx.meetingStatus(away.meetingId)]).toEqual(["INACTIVE", "INACTIVE"]);
  });

  it("the organiser's settle ends the room too — after the answer", async () => {
    const g = await liveGame();
    const { meetingId } = await ensureMeeting(g.fixtureId, "home");
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "provider_error", detail: "test: held for the organiser" });
    const tail = heldTail();
    expect(await resolveExternalPlay(organiserOf(g), g.fixtureId, "home_wins", { room: { defer: tail.defer }, defer: () => {} })).toEqual({ status: "finished" });
    expect(fx.meetingStatus(meetingId), "not before the answer").toBe("ACTIVE");
    await tail.run();
    expect(fx.meetingStatus(meetingId)).toBe("INACTIVE");
    expect(await endedAt(g.fixtureId)).not.toBeNull();
  });
});
