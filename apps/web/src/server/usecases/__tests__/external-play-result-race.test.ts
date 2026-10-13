// T12's result writer when two callers race (T11 review I1/I2, controller
// ruling C1, fix round 1). `attempt` reads three times with no lock — the
// replay check, the fixture, the fold — while the winner of a race commits
// its keyed result, the fold and the fixture's derived status in ONE
// transaction (append-event). A loser whose reads straddle that commit used to
// answer `none` for a decided game, raise 500 FOLD_STATUS_MISMATCH, or — for a
// bracket draw — answer `none`, which reconcile reads as "close the bridge":
// the tiebreak_owed hold was lost and the board sat finished with its
// tie-break owed and nobody told.
//
// Each window is STAGED, deterministically: a pass-through mock of the two
// reads (guard `loadOnlinePlayFixture`, fixtures `getFixtureState`) pauses the
// named caller at that read while the other caller runs. Callers are told
// apart by an AsyncLocalStorage lane, and every stage asserts that it FIRED,
// so a moved read cannot leave a case green without its race.
//
// Starting every call at the same instant never reproduced the race (review
// probe: 0 of 35 runs), so the sweep at the end STAGGERS the starts and
// reports how many runs it made.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { createBoardApi } from "@/server/external-play/lichess/board-api";
import type { BoardCall, GameSnapshot } from "@/server/external-play/types";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady } from "../external-play/create-game";
import { act } from "../external-play/play";
import { reconcile, type ReconcileDeps, type ReconcileOutcome } from "../external-play/reconcile";
import { resolveExternalPlay } from "../external-play/resolve";
import { writeResultFrom, type ResultWrite } from "../external-play/result";
import { scoreEvent } from "../scoring";
import { seedOnlineChessFixture } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

// T9's creation and T10's play consume the Board API: module-mocked at its
// boundary, every default REFUSING. `createBoardApi` stays real, so the one
// Lichess line reconcile reads below goes through the real parser.
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
vi.mock("@/server/external-play/lichess/board-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/external-play/lichess/board-api")>()),
  ...board,
}));

// The two reads a loser's window sits between, passed through unchanged
// unless a case stages a pause there.
const gate = vi.hoisted(() => ({
  load: null as null | (() => Promise<void>),
  state: null as null | (() => Promise<void>),
}));
vi.mock("../external-play/guard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../external-play/guard")>();
  return {
    ...real,
    loadOnlinePlayFixture: async (fixtureId: string) => {
      await gate.load?.();
      return real.loadOnlinePlayFixture(fixtureId);
    },
  };
});
vi.mock("../fixtures", async (importOriginal) => {
  const real = await importOriginal<typeof import("../fixtures")>();
  return {
    ...real,
    getFixtureState: async (...a: Parameters<typeof real.getFixtureState>) => {
      await gate.state?.();
      return real.getFixtureState(...a);
    },
  };
});

const lane = new AsyncLocalStorage<string>();
const inLane = <T>(who: string, run: () => Promise<T>): Promise<T> => lane.run(who, run);

/** Pause `who` at its `nth` call of `point` and run `meanwhile` to the end
 *  first. The probe says whether the pause happened. */
function stage(point: "load" | "state", who: string, nth: number, meanwhile: () => Promise<unknown>) {
  const probe = { fired: false };
  let seen = 0;
  gate[point] = async () => {
    if (lane.getStore() !== who || ++seen !== nth) return;
    probe.fired = true;
    await meanwhile();
  };
  return probe;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  gate.load = null;
  gate.state = null;
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue(UNEXPECTED);
  board.submitMove.mockResolvedValue(UNEXPECTED);
  board.resignGame.mockResolvedValue(UNEXPECTED);
  board.offerOrAcceptDraw.mockResolvedValue(UNEXPECTED);
  board.abortGame.mockResolvedValue(UNEXPECTED);
  board.readGameStream.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected stream read" });
  board.exportGame.mockResolvedValue(null);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const CREATED = new Date("2026-10-01T12:05:00.000Z");
const MOVED = new Date("2026-10-01T12:11:00.000Z");
const READ = new Date("2026-10-01T12:20:00.000Z");

type Player = { entrantId: string; personId: string; lichessId: string };
type Game = Awaited<ReturnType<typeof seedOnlineChessFixture>> & { gameId: string; white: Player; black: Player };

/** T9's real producer, then T10's real `act` for White's first move (home =
 *  White). `kind` is set before any event, as a bracket stage's organiser
 *  builds it (the fixture's cfg freezes at its first event). */
async function liveGame(kind?: string): Promise<Game> {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: 300, increment: 3 },
  });
  if (kind) await sql`update stages set kind = ${kind} where id = ${s.stageId}`;
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: gameId });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  expect(await createGameIfReady(s.fixtureId, { now: CREATED, publish: async () => {} }), "premise: T9 created the game").toEqual({ created: true, gameId });
  const moved = await act(
    { fixtureId: s.fixtureId, personId: s.home.personId, action: { kind: "move", uci: "e2e4" } },
    { now: MOVED, accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }) },
  );
  expect(moved, "premise: T10 accepted the first move").toEqual({ ok: true, applied: true });
  return { ...s, gameId, white: s.home, black: s.away };
}

const decided = (g: Game): GameSnapshot =>
  ({ gameId: g.gameId, status: "mate", winner: "white", movesSan: ["e4"], whiteMs: 1, blackMs: 1, increment: 0 }) as GameSnapshot;
const drawn = (g: Game): GameSnapshot => ({ ...decided(g), status: "draw", winner: null }) as GameSnapshot;

async function bridgeOf(fixtureId: string) {
  const [r] = await sql<{ status: string; needs_reason: string | null; finished_at: Date | null }[]>`
    select status, needs_reason, finished_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return r!;
}
async function fixtureStatus(fixtureId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`select status from fixtures where id = ${fixtureId}`;
  return r!.status;
}
async function results(fixtureId: string) {
  return sql<{ payload: { winner: string | null }; idempotency_key: string | null }[]>`
    select payload, idempotency_key from score_events where fixture_id = ${fixtureId} and type = 'boardgame.result'`;
}

/** The organiser's own hand entry on the pad, keyless — the other writer a
 *  Lichess result can race. */
async function handResult(g: Game, winner: string | null): Promise<void> {
  const auth = await mintOrgOwnerAuth(g.orgId);
  const [st] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${g.fixtureId}`;
  let seq = st!.n;
  if (seq === 0) await scoreEvent(auth, g.fixtureId, { expected_seq: seq++, type: "core.start", payload: {} });
  await scoreEvent(auth, g.fixtureId, { expected_seq: seq, type: "boardgame.result", payload: { winner } });
}

const TIEBREAK_HELD: ResultWrite = { wrote: "needs_organiser", reason: "tiebreak_owed" };

describe.runIf(HAS_DB)("writeResultFrom — the winner commits inside the loser's reads (staged, one per window)", () => {
  it("between the replay check and the fixture read: a decided game answers `decided`, never `none`", async () => {
    const g = await liveGame();
    const s = decided(g);
    let first: ResultWrite | undefined;
    const probe = stage("load", "loser", 1, async () => { first = await inLane("winner", () => writeResultFrom(s, g.fixtureId)); });
    const loser = await inLane("loser", () => writeResultFrom(s, g.fixtureId));
    expect(probe.fired, "premise: the loser paused at its fixture read").toBe(true);
    expect(first).toEqual({ wrote: "decided" });
    expect(loser, "a repeat call answers what the first one did").toEqual({ wrote: "decided" });
    expect(await results(g.fixtureId)).toHaveLength(1);
    expect(await fixtureStatus(g.fixtureId)).toBe("decided");
  });

  it("between the fixture read and the fold read: a decided game answers `decided` — no 500 FOLD_STATUS_MISMATCH", async () => {
    const g = await liveGame();
    const s = decided(g);
    let first: ResultWrite | undefined;
    const probe = stage("state", "loser", 1, async () => { first = await inLane("winner", () => writeResultFrom(s, g.fixtureId)); });
    const loser = await inLane("loser", () => writeResultFrom(s, g.fixtureId));
    expect(probe.fired, "premise: the loser paused at its fold read, holding a stale in_play").toBe(true);
    expect(first).toEqual({ wrote: "decided" });
    expect(loser).toEqual({ wrote: "decided" });
    expect(await results(g.fixtureId)).toHaveLength(1);
  });

  it("a bracket draw between the fixture read and the fold read: the loser lands the tiebreak_owed hold, never `none`", async () => {
    const g = await liveGame("knockout");
    const s = drawn(g);
    let first: ResultWrite | undefined;
    const probe = stage("state", "loser", 1, async () => { first = await inLane("winner", () => writeResultFrom(s, g.fixtureId)); });
    const loser = await inLane("loser", () => writeResultFrom(s, g.fixtureId));
    expect(probe.fired, "premise: staged").toBe(true);
    expect(first).toEqual(TIEBREAK_HELD);
    // `none` would tell reconcile to close the bridge over the owed tie-break.
    expect(loser).toEqual(TIEBREAK_HELD);
    expect(await bridgeOf(g.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "tiebreak_owed" });
    expect(await fixtureStatus(g.fixtureId), "the tie-break is still owed").toBe("in_play");
    expect(await results(g.fixtureId)).toHaveLength(1);
  });

  it("an organiser's keyless hand result between the fixture read and the fold read: nothing written, nothing raised", async () => {
    // The key is absent — settled elsewhere — and the fixture no longer
    // playable: `none`, as for any fixture an organiser decided.
    const g = await liveGame();
    const probe = stage("state", "loser", 1, () => inLane("organiser", () => handResult(g, g.black.entrantId)));
    const loser = await inLane("loser", () => writeResultFrom(decided(g), g.fixtureId));
    expect(probe.fired, "premise: staged").toBe(true);
    expect(loser).toEqual({ wrote: "none" });
    const rs = await results(g.fixtureId);
    expect(rs.map((r) => [r.payload.winner, r.idempotency_key]), "the organiser's entry stands alone").toEqual([[g.black.entrantId, null]]);
    expect(await fixtureStatus(g.fixtureId)).toBe("decided");
  });

  it("the winner's result, then a finalize, before the loser's fixture read: the loser answers `decided`", async () => {
    // loadOnlinePlayFixture leaves a finalized fixture out (guard.ts), so the
    // loser sees no fixture at all — yet its result IS on the ledger.
    const g = await liveGame();
    const s = decided(g);
    const probe = stage("load", "loser", 1, () =>
      inLane("winner", async () => {
        await writeResultFrom(s, g.fixtureId);
        const [st] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${g.fixtureId}`;
        await scoreEvent(await mintOrgOwnerAuth(g.orgId), g.fixtureId, { expected_seq: st!.n, type: "core.finalize", payload: {} });
      }),
    );
    const loser = await inLane("loser", () => writeResultFrom(s, g.fixtureId));
    expect(probe.fired, "premise: staged").toBe(true);
    expect(await fixtureStatus(g.fixtureId), "premise: finalized").toBe("finalized");
    expect(loser).toEqual({ wrote: "decided" });
    expect(await results(g.fixtureId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reconcile on top: a bracket draw, two reconciles (both players' game_end).
// ---------------------------------------------------------------------------
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../external-play/__fixtures__/lichess");
/** The recorded mid-game line (gamefull-mid-white.ndjson, 8 plies from
 *  e2e4), re-addressed to our game and players; status `draw` is the one
 *  synthetic field (lila's `draw` status, no winner). Read through the REAL
 *  client. */
function drawRead(g: Game): ReconcileDeps["readStream"] {
  const j = JSON.parse(readFileSync(join(FIX, "gamefull-mid-white.ndjson"), "utf8").split("\n")[0]!) as {
    id: string; white: { id: string; name: string }; black: { id: string; name: string }; state: { status: string; winner?: string };
  };
  j.id = g.gameId;
  j.white.id = j.white.name = g.white.lichessId;
  j.black.id = j.black.name = g.black.lichessId;
  j.state.status = "draw";
  delete j.state.winner;
  const line = `${JSON.stringify(j)}\n`;
  const api = createBoardApi({ baseUrl: "https://lichess.test", fetch: (async () => new Response(line)) as typeof fetch });
  return (a) => api.readGameStream(a);
}
const reconcileDeps = (g: Game): ReconcileDeps => ({ now: READ, readStream: drawRead(g), publish: async () => {} });

describe.runIf(HAS_DB)("reconcile — a bracket draw's hold survives two racing game_end reconciles (I2, staged)", () => {
  it("the loser reads the fold after the winner's draw but before its hold: the bridge stays held, never finished", async () => {
    // The review's losing order: the loser's replay check BEFORE the winner's
    // commit, its fold read after it, and its close of the bridge before the
    // winner's hold lands (the hold then found `finished` and gave up).
    const g = await liveGame("knockout");
    const deps = reconcileDeps(g);
    let winner: Promise<ReconcileOutcome | null> | undefined;
    let releaseWinner!: () => void;
    const winnerMayHold = new Promise<void>((r) => { releaseWinner = r; });
    let winnerAtHold!: () => void;
    const winnerReachedHold = new Promise<void>((r) => { winnerAtHold = r; });
    let loserLoads = 0;
    let winnerStates = 0;
    const fired = { loser: false, winner: false };
    // The loser's 2nd fixture read is T12's (its 1st is reconcile's own).
    gate.load = async () => {
      if (lane.getStore() !== "loser" || ++loserLoads !== 2) return;
      fired.loser = true;
      winner = inLane("winner", () => reconcile(g.fixtureId, "game_end", deps));
      await winnerReachedHold;
    };
    // The winner's 2nd fold read is afterDraw's — after its draw committed,
    // before its hold.
    gate.state = async () => {
      if (lane.getStore() !== "winner" || ++winnerStates !== 2) return;
      fired.winner = true;
      winnerAtHold();
      await winnerMayHold;
    };
    const loser = await inLane("loser", () => reconcile(g.fixtureId, "game_end", deps));
    releaseWinner();
    const first = await winner!;
    expect(fired, "premise: both pauses happened, in the losing order").toEqual({ loser: true, winner: true });
    expect(loser?.result).toEqual(TIEBREAK_HELD);
    expect(first?.result).toEqual(TIEBREAK_HELD);
    expect([loser?.finished, first?.finished], "neither closed the bridge").toEqual([false, false]);
    expect(await bridgeOf(g.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "tiebreak_owed", finished_at: null });
    expect(await fixtureStatus(g.fixtureId)).toBe("in_play");
    expect(await results(g.fixtureId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The sweep: real concurrency, starts staggered across the window the review
// probe found (0–70 ms), counted.
// ---------------------------------------------------------------------------
const STAGGERS_MS = [0, 2, 5, 9, 14, 21, 30, 45, 70] as const;
const REPS = 2;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Three callers, the 2nd `s` ms after the 1st and the 3rd `s` after that. */
const staggered = <T>(s: number, call: () => Promise<T>) =>
  Promise.allSettled([0, 1, 2].map(async (i) => { await delay(i * s); return call(); }));

describe.runIf(HAS_DB)("the staggered concurrent sweep — counted", () => {
  it("a decided league game: three staggered writeResultFrom calls — no rejection, every answer `decided`, one result", { timeout: 240_000 }, async () => {
    let runs = 0;
    for (const s of STAGGERS_MS) {
      for (let rep = 0; rep < REPS; rep++) {
        const g = await liveGame();
        const settled = await staggered(s, () => writeResultFrom(decided(g), g.fixtureId));
        const label = `stagger ${s} ms, rep ${rep}`;
        expect(settled.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason)), label).toEqual([]);
        expect(settled.map((x) => (x as PromiseFulfilledResult<ResultWrite>).value), label).toEqual(Array(3).fill({ wrote: "decided" }));
        expect(await results(g.fixtureId), label).toHaveLength(1);
        runs++;
      }
    }
    expect(runs, "anti-vacuity: every stagger ran").toBe(STAGGERS_MS.length * REPS);
  });

  it("a bracket draw: three staggered reconciles — the bridge ends needs_organiser/tiebreak_owed on every run, never finished", { timeout: 240_000 }, async () => {
    let runs = 0;
    for (const s of STAGGERS_MS) {
      for (let rep = 0; rep < REPS; rep++) {
        const g = await liveGame("knockout");
        const deps = reconcileDeps(g);
        const settled = await staggered(s, () => reconcile(g.fixtureId, "game_end", deps));
        const label = `stagger ${s} ms, rep ${rep}`;
        expect(settled.filter((x) => x.status === "rejected").map((x) => String((x as PromiseRejectedResult).reason)), label).toEqual([]);
        expect(await bridgeOf(g.fixtureId), label).toEqual({ status: "needs_organiser", needs_reason: "tiebreak_owed", finished_at: null });
        expect(await fixtureStatus(g.fixtureId), label).toBe("in_play");
        expect(await results(g.fixtureId), label).toHaveLength(1);
        runs++;
      }
    }
    expect(runs, "anti-vacuity: every stagger ran").toBe(STAGGERS_MS.length * REPS);
  });
});

// T16 fix round 2, N2: the organiser's settle (resolve.ts) has the same window — its board read, then its fold read.
// Another writer settling the board in between leaves a fold past play beside a status read as playable: the board
// changed under the organiser. Told BOARD_CHANGED ("reload to see it"), nothing of the late settle written — while a
// settle that READS the board settled is told ALREADY_RESOLVED ("already has its result"), the sequence's next call.
describe.runIf(HAS_DB)("resolveExternalPlay — another organiser settles between the board read and the fold read (staged)", () => {
  const refusalOf = (p: Promise<unknown>) =>
    p.then(
      (ok) => ({ ok }),
      (err: unknown) => (err instanceof HttpError ? { refused: [err.status, err.code] } : Promise.reject(err)),
    );

  it("the late settle is told BOARD_CHANGED and writes nothing; a settle after it is told ALREADY_RESOLVED", async () => {
    const g = await liveGame();
    const organiser = { orgId: g.orgId, via: "session", userId: g.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    let first: unknown;
    const probe = stage("state", "late", 1, async () => {
      first = await inLane("first", () => resolveExternalPlay(organiser, g.fixtureId, "home_wins"));
    });
    const late = await inLane("late", () => refusalOf(resolveExternalPlay(organiser, g.fixtureId, "away_wins")));
    expect(probe.fired, "premise: the late settle paused at its fold read, holding a playable board").toBe(true);
    expect(first).toEqual({ status: "finished" });
    expect(late, "the board changed under the organiser").toEqual({ refused: [409, "BOARD_CHANGED"] });
    expect((await results(g.fixtureId)).map((r) => r.payload.winner), "the first decision stands alone").toEqual([g.home.entrantId]);
    expect(await fixtureStatus(g.fixtureId)).toBe("decided");
    // The next press reads the board settled: that is "already has its result", not a change mid-settle.
    expect(await refusalOf(resolveExternalPlay(organiser, g.fixtureId, "draw"))).toEqual({ refused: [409, "ALREADY_RESOLVED"] });
    expect(await results(g.fixtureId)).toHaveLength(1);
  });
});
