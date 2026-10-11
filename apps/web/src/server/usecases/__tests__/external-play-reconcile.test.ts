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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { readGameStream as wiredReadGameStream } from "@/server/external-play/lichess/board-api";
import { NEEDS_REASONS, type BoardCall } from "@/server/external-play/types";
import { log } from "@/server/logger";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady } from "../external-play/create-game";
import { act } from "../external-play/play";
import {
  FLAG_REREAD_MS,
  RECONCILE_TRIGGERS,
  reconcile,
  uciFromSan,
  type ReconcileDeps,
  type ReconcileTrigger,
} from "../external-play/reconcile";
import { holdForOrganiser } from "../external-play/result";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture } from "./_external-play-seed";

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
    onStream: (c: { gameId: string; token: string | null }) => Answer;
    onExport: (c: { gameId: string }) => Answer;
    reset(): void;
    serve(url: string, init?: RequestInit): Promise<Response>;
  };
  const refused = (what: string): Answer => ({ status: 503, body: `no ${what} scripted` });
  const state: Wire = {
    calls: [],
    onStream: () => refused("stream"),
    onExport: () => refused("export"),
    reset() {
      state.calls = [];
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
        const r = state.onStream(c);
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
vi.mock("@/server/external-play/lichess/board-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/external-play/lichess/board-api")>();
  const wired = real.createBoardApi({
    baseUrl: "https://lichess.test",
    fetch: ((input: string | URL | Request, init?: RequestInit) => lichess.serve(String(input), init)) as typeof fetch,
  });
  return { ...real, ...board, readGameStream: wired.readGameStream, exportGame: wired.exportGame };
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
  wdraw: true; bdraw: true; gameId: string; whiteId: string | null;
}>;
function gameFull(g: Game, base: GameFullJson, over: LineOver = {}): string {
  const j = JSON.parse(JSON.stringify(base)) as GameFullJson;
  j.id = over.gameId ?? g.gameId;
  if (over.whiteId === null) delete (j.white as Partial<GameFullJson["white"]>).id;
  else j.white.id = j.white.name = over.whiteId ?? g.white.lichessId;
  j.black.id = j.black.name = g.black.lichessId;
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
    const cfg = resolveFixtureCfg(null, row!.dcfg, { kind: "league", config: row!.scfg }, boardgame);
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
  last_error: string | null;
};
async function rowOf(fixtureId: string): Promise<Row> {
  const [r] = await sql<Row[]>`
    select status, needs_reason, moves_uci, move_count, started_at, finished_at, last_move_at,
           white_ms, black_ms, clock_increment_s, draw_offer_by, white_draw_offer_ply, black_draw_offer_ply, last_error
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return r!;
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

/** Deps a case observes: the clock, the room, the flag re-read's sleep. */
function observed(now: Date = READ) {
  const sent: RoomBroadcast[] = [];
  const sleeps: number[] = [];
  const deps: ReconcileDeps = {
    now,
    publish: async (_id, body) => { sent.push(body); },
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { deps, sent, sleeps };
}
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
describe("RECONCILE_TRIGGERS — spec §3.5's five, a value a sweep can enumerate", () => {
  it("is exactly the spec's five triggers, each once", () => {
    // Spec §3.5: "on a move Lichess rejects, on a local clock reaching zero,
    // on game end, when the organiser opens the fixture, and by the sweep".
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

  it("the flag re-read waits the MEASURED gap between the recorded reads, not a guess", () => {
    // README timeline: read 1 `started` at 10:13:17Z, read 2 `outoftime` at
    // 10:13:20Z — the controller's ruling: 3 s, not the spec's 2 s.
    const readme = fixtureText("README.md");
    const at = (label: string) => {
      const m = new RegExp(`(\\d\\d:\\d\\d:\\d\\d)Z ${label}`).exec(readme);
      expect(m, `README names ${label}`).not.toBeNull();
      return Date.parse(`2026-10-11T${m![1]}Z`);
    };
    expect(FLAG_REREAD_MS).toBe(at("EXPIRED read 2") - at("EXPIRED read 1"));
    expect(FLAG_REREAD_MS).not.toBe(2_000);
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

  it("a standing offer read from the stream is adopted at Lichess's ply, cleared when gone, its ply kept", async () => {
    // lila writes bdraw only while Black's offer stands (BotJsonView; source).
    const g = await readyGame();
    await play(g, LINE.slice(0, 4));
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4), bdraw: true }));
    const offered = observed(new Date());
    await reconcile(g.fixtureId, "sweep", offered.deps);
    let r = await rowOf(g.fixtureId);
    expect([r.draw_offer_by, r.black_draw_offer_ply, r.white_draw_offer_ply]).toEqual(["black", 4, null]);
    expect(offered.sent.map((b) => b.drawOfferBy)).toEqual(["black"]);
    serveStream(gameFull(g, MID, { moves: LINE.slice(0, 4) }));
    await reconcile(g.fixtureId, "sweep", observed(new Date()).deps);
    r = await rowOf(g.fixtureId);
    expect([r.draw_offer_by, r.black_draw_offer_ply], "the re-offer rule still reads the ply").toEqual([null, 4]);
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

  it("an offer read before ply 2 is not adopted (lila registers none; V436 refuses one)", async () => {
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
    await reconcile(g.fixtureId, "sweep", observed(new Date()).deps);
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

  it("a game whose players are not the ones on file is held provider_error; nothing is adopted or written", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2, { whiteId: "someone-else" }));
    const out = await reconcile(g.fixtureId, "game_end", observed().deps);
    expect(out!.result).toEqual({ wrote: "needs_organiser", reason: "provider_error" });
    const r = await rowOf(g.fixtureId);
    expect(r.moves_uci).toEqual(LINE.slice(0, 1));
    expect(await resultsOf(g.fixtureId)).toEqual([]);
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
// clock_zero: a read settles the flag, visible on the NEXT read (measured).
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("reconcile — clock_zero re-reads ONCE, after the measured 3 s", () => {
  it("the recorded pair: `started` with White at 0, then `outoftime` (Black) on the re-read", async () => {
    const g = await liveGame();
    let n = 0;
    lichess.onStream = () => ok(gameFull(g, n++ === 0 ? EXPIRED_1 : EXPIRED_2));
    const { deps, sleeps, sent } = observed();
    const out = await reconcile(g.fixtureId, "clock_zero", deps);
    expect(sleeps).toEqual([FLAG_REREAD_MS]);
    expect(streams().length).toBe(2);
    expect(out).toMatchObject({ source: "stream", result: { wrote: "decided" }, finished: true, adopted: LINE.length - 1 });
    expect((await resultsOf(g.fixtureId)).map((e) => e.payload.winner), "the winner Lichess reported").toEqual([g.black.entrantId]);
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.finished_at]).toEqual(["finished", READ]);
    expect(sent.map((b) => b.status)).toEqual(["outoftime"]);
  });

  it("still `started` after the re-read: returns, leaves it to the sweep — no flag of ours", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_1));
    const { deps, sleeps } = observed();
    const out = await reconcile(g.fixtureId, "clock_zero", deps);
    expect(sleeps, "one re-read, never a loop").toEqual([FLAG_REREAD_MS]);
    expect(streams().length).toBe(2);
    expect(out).toMatchObject({ result: null, finished: false });
    const r = await rowOf(g.fixtureId);
    expect([r.status, r.finished_at, r.white_ms]).toEqual(["live", null, 0]);
    expect(await resultsOf(g.fixtureId)).toEqual([]);
  });

  it("the same zero-clock line on every OTHER trigger is read once — counted", async () => {
    let checked = 0;
    for (const trigger of RECONCILE_TRIGGERS.filter((t) => t !== "clock_zero")) {
      lichess.reset();
      const g = await liveGame();
      serveStream(gameFull(g, EXPIRED_1));
      const { deps, sleeps } = observed();
      await reconcile(g.fixtureId, trigger, deps);
      expect([sleeps, streams().length], trigger).toEqual([[], 1]);
      checked++;
    }
    expect(checked).toBe(RECONCILE_TRIGGERS.length - 1);
  });

  it("clock_zero on a clock that is NOT at zero (the mid recording) does not wait", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID));
    const { deps, sleeps } = observed();
    await reconcile(g.fixtureId, "clock_zero", deps);
    expect([sleeps, streams().length]).toEqual([[], 1]);
  });

  it("…nor when the zero is the WAITING side's (Black at 0, White to move)", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, MID, { btime: 0 }));
    const { deps, sleeps } = observed();
    await reconcile(g.fixtureId, "clock_zero", deps);
    expect(sleeps).toEqual([]);
  });

  it("clock_zero on a flag Lichess has ALREADY settled (expired-2) settles it at once — no wait", async () => {
    const g = await liveGame();
    serveStream(gameFull(g, EXPIRED_2));
    const { deps, sleeps } = observed();
    expect(await reconcile(g.fixtureId, "clock_zero", deps)).toMatchObject({ finished: true });
    expect([sleeps, streams().length]).toEqual([[], 1]);
  });

  it("a re-read that cannot be made keeps the first read", async () => {
    const g = await liveGame();
    let n = 0;
    lichess.onStream = () => (n++ === 0 ? ok(gameFull(g, EXPIRED_1)) : status(503));
    const { deps, sleeps } = observed();
    const out = await reconcile(g.fixtureId, "clock_zero", deps);
    expect(sleeps).toEqual([FLAG_REREAD_MS]);
    expect(out).toMatchObject({ source: "stream", adopted: LINE.length - 1, finished: false });
    expect((await rowOf(g.fixtureId)).move_count).toBe(LINE.length);
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
      ...observed(new Date()).deps,
      readStream: async (a) => {
        await act(
          { fixtureId: g.fixtureId, personId: g.black.personId, action: { kind: "draw", accept: true } },
          { now: new Date(), accessToken: async (u) => `tok-${u}`, publish: async () => {}, offerOrAcceptDraw: async () => ({ ok: true }) },
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

  it("a HELD row on a withdrawn fixture stays in the organiser's queue", async () => {
    const g = await liveGame();
    await holdForOrganiser({ fixtureId: g.fixtureId, reason: "token_revoked" });
    await withdrawEntrantCascade(await mintOrgOwnerAuth(g.orgId), g.black.entrantId);
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", finished_at: null });
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
    const MID_GAME = new Set(["token_revoked", "provider_error"]);
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
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", moves_uci: LINE });
  });

  it("both refused, export mid-game: nothing trusted — held token_revoked, the ledger untouched", async () => {
    const g = await liveGame();
    lichess.onStream = () => status(401);
    lichess.onExport = () => ok(exported(g, "export-mid.json"));
    expect(await reconcile(g.fixtureId, "sweep", observed().deps)).toBeNull();
    expect(exports().length).toBe(1);
    expect(await rowOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "token_revoked", moves_uci: LINE.slice(0, 1) });
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
describe.runIf(HAS_DB)("reconcile — property: any interleaving of triggers and Lichess reads", () => {
  // Lichess's truth only moves forward in time: its line grows (by T10 or
  // out of band), then one end freezes it. Each step advances that truth,
  // then reconciles on a trigger through one of three read paths. The model
  // below is the SPEC's (§3.5, the controller's carries, T12's rulebook for a
  // league), never reconcile's:
  //   - the stream, when a seat opens it, is the truth; the ledger becomes its
  //     line (it never shortens — Lichess's never does here);
  //   - when no seat opens it, the export counts only for a final status;
  //   - clock_zero on a `started` line with the mover's clock at 0 reads
  //     exactly once more (the re-read sees the same truth here);
  //   - a final status closes the bridge, once — except `aborted`, which
  //     T12 holds; a closed or held-final row is never read again.
  type End = "outoftime" | "resign" | "draw" | "aborted";
  type Mode = "stream" | "white_down" | "export";
  type Step = { advance: number; end: End | null; trigger: ReconcileTrigger; mode: Mode; flagDue: boolean };
  const stepArb: fc.Arbitrary<Step> = fc.record({
    advance: fc.integer({ min: 0, max: 3 }),
    end: fc.oneof(
      { arbitrary: fc.constant(null), weight: 5 },
      { arbitrary: fc.constantFrom<End>("outoftime", "resign", "draw", "aborted"), weight: 1 },
    ),
    trigger: fc.constantFrom(...RECONCILE_TRIGGERS),
    mode: fc.constantFrom<Mode>("stream", "white_down", "export"),
    flagDue: fc.boolean(),
  });
  const s = (o: Partial<Step> & Pick<Step, "trigger" | "mode">): Step => ({ advance: 0, end: null, flagDue: false, ...o });
  // Each path's forced prefix ENDS with the step that makes its claim.
  const PATHS = {
    stream_settles: [s({ advance: 3, trigger: "sweep", mode: "stream" }), s({ advance: 2, end: "resign", trigger: "game_end", mode: "stream" })],
    flag_reread: [s({ advance: 4, trigger: "clock_zero", mode: "white_down", flagDue: true })],
    export_settles: [s({ advance: 2, end: "outoftime", trigger: "sweep", mode: "export" })],
    export_ignored_then_aborted: [
      s({ advance: 5, trigger: "organiser", mode: "export" }),
      s({ end: "aborted", trigger: "rejected_move", mode: "white_down" }),
    ],
  } as const;
  type PathName = keyof typeof PATHS;
  const PATH_NAMES = Object.keys(PATHS) as PathName[];
  const K = 4; // runs per path
  const counters = {
    steps: 0, adopted: 0, reread: 0, export_ignored: 0, settled_stream: 0, settled_export: 0,
    held_final: 0, silent_after_close: 0, white_down: 0,
  };
  const claims: Record<PathName, number> = { stream_settles: 0, flag_reread: 0, export_settles: 0, export_ignored_then_aborted: 0 };

  it("holds the model on every step — counted per path, K runs each", { timeout: 600_000 }, async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 0, maxLength: 4 }), async (suffix) => {
        const path = PATH_NAMES[run % PATH_NAMES.length]!;
        run++;
        const steps = [...PATHS[path], ...suffix];
        const g = await readyGame();
        const truth = { ply: 0, end: null as End | null };
        const model = { ledger: 0, closed: false, heldFinal: false, resulted: false };
        let finishedAt: Date | null = null;
        for (const [i, step] of steps.entries()) {
          if (truth.end === null) {
            truth.ply = Math.min(LINE.length, truth.ply + step.advance);
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
          const at = new Date(READ.getTime() + i * 10_000);
          const { deps, sleeps } = observed(at);
          const out = await reconcile(g.fixtureId, step.trigger, deps);
          counters.steps++;
          const label = `${path} step ${i} ${JSON.stringify(step)} truth=${JSON.stringify(truth)}`;

          if (model.closed || model.heldFinal) {
            expect(lichess.calls, `${label}: a closed board is never read`).toEqual([]);
            expect(out, label).toBeNull();
            counters.silent_after_close++;
          } else {
            const perRead = step.mode === "stream" ? 1 : 2;
            const reread = step.mode !== "export" && step.trigger === "clock_zero" && zero ? 1 : 0;
            expect(streams().length, `${label}: stream reads`).toBe(perRead * (1 + reread));
            expect(exports().length, `${label}: export reads`).toBe(step.mode === "export" ? 1 : 0);
            expect(sleeps, label).toEqual(reread ? [FLAG_REREAD_MS] : []);
            if (reread) counters.reread++;
            if (step.mode === "white_down") counters.white_down++;
            const trusted = step.mode !== "export" || truth.end !== null;
            if (trusted) {
              if (truth.ply > model.ledger) counters.adopted++;
              model.ledger = Math.max(model.ledger, truth.ply);
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
            const made =
              path === "stream_settles" ? model.closed && step.mode === "stream"
              : path === "flag_reread" ? sleeps.length === 1
              : path === "export_settles" ? model.closed && step.mode === "export"
              : model.heldFinal;
            if (made) claims[path]++;
          }
        }
      }),
      { numRuns: K * PATH_NAMES.length, endOnFailure: true },
    );
    expect(run).toBe(K * PATH_NAMES.length);
    console.info("reconcile property counters", JSON.stringify({ counters, claims }));
    for (const p of PATH_NAMES) expect(claims[p], `every ${p} run made its claim`).toBe(K);
    for (const [name, n] of Object.entries(counters)) expect(n, `path counter ${name}`).toBeGreaterThan(0);
  });
});
