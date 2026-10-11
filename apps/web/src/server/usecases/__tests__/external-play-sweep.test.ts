// The external-play sweep (chess in-page board design §3.5, §3.6, §4; rounds
// are organiser-driven per D12). FOUR jobs, every one of which happens when no
// page is open: the T+20 no-show, the mint retry for a create that hit the 429
// wall, meeting teardown, and the reconcile sweep. The T-10 notice is the
// open-round action's (T19), not the cron's.
//
// Every board is built by the REAL producers: the organiser opens the round
// through T19's `openRound` (which stamps `stage_round_opens.opened_at` and
// mints the pending bridge row), a player checks in through `me.ts`'s
// `stampFixtureCheckIn` (the stamp T8's check-in writes), T9's
// `createGameIfReady` makes the game, T10's `act` moves it to 'live', T7's
// `ensureMeeting` / `endMeeting` own the meeting row. Lichess and RealtimeKit
// are fakes at their HTTP boundary: the Board API module is mocked (its two
// reads are the REAL client wired to a fake wire), RealtimeKit is the REAL
// adapter over a fake fetch. Nothing here reaches lichess.org or Cloudflare.
//
// Time moves through the sweep's own `now`: a round opened a minute ago is
// swept "45 minutes later" by passing that instant, so every stamp the
// producers wrote is real and nothing is back-dated by SQL. Every sweep is
// scoped to the test's own orgs (`orgIds`): the shared test DB holds other
// suites' opened rounds, and an unscoped sweep would act on them.
//
// THE W2b GATE. Today's boardgame engine refuses a forfeit in phase `pre`
// (boardgame.ts `forfeit not allowed in phase "pre"`), which is exactly where
// a game that never began sits — so on today's engine the no-show forfeit is
// ATTEMPTED and refused. `W2B` below asks the ENGINE (a one-event fold), never
// the sweep: where it answers false the tests pin the attempt and the
// refusal; where it answers true they pin the ledger and the outcome. This
// branch must not merge before W2b (brief Step 20).
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts `d.sport_key = 'boardgame'`); the sweep adds no sport branch.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, foldMatch } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { makeEnvelope } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { CREATION_429_HOLD_MS, __resetCreationQueue, __setCreationQueueDeps } from "@/server/external-play/creation-queue";
import { endMeeting, ensureMeeting } from "@/server/external-play/video/realtimekit";
import { DEADLINE_AFTER_MS, MINT_CLAIM_STALE_MS, roomPhase, windowFor } from "@/server/external-play/window";
import { getFixtureState } from "../fixtures";
import { stampFixtureCheckIn } from "../me";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady } from "../external-play/create-game";
import { openRound } from "../external-play/open-round";
import { act } from "../external-play/play";
import { reconcile } from "../external-play/reconcile";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../external-play/guard";
import {
  playableWindow,
  sweepExternalPlay,
  type SweepDeps,
  type SweepReport,
} from "../external-play/sweep";
import { seedOnlineChessFixture, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Boundaries.
// ---------------------------------------------------------------------------

// The invite T19's openRound sends: recorded, never mailed.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendExternalPlayInviteEmail: vi.fn(async () => true) };
});

// T9's creation and T10's play consume the Board API: module-mocked at its
// boundary, every default REFUSING. The two reads reconcile makes are the
// REAL client wired to the fake Lichess below (the reconcile suite's shape).
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
const lichess = vi.hoisted(() => {
  type Answer = { status: number; body: string };
  const refused = (what: string): Answer => ({ status: 503, body: `no ${what} scripted` });
  const state = {
    calls: [] as { kind: "stream" | "export" | "other"; gameId: string }[],
    onStream: (_c: { gameId: string }): Answer => refused("stream"),
    onExport: (_c: { gameId: string }): Answer => refused("export"),
    reset() {
      state.calls = [];
      state.onStream = () => refused("stream");
      state.onExport = () => refused("export");
    },
    async serve(url: string): Promise<Response> {
      const u = new URL(url);
      const stream = /^\/api\/board\/game\/stream\/([^/]+)$/.exec(u.pathname);
      if (stream) {
        const c = { kind: "stream" as const, gameId: decodeURIComponent(stream[1]!) };
        state.calls.push(c);
        const r = state.onStream(c);
        return new Response(r.body, { status: r.status });
      }
      const exported = /^\/game\/export\/([^/]+)$/.exec(u.pathname);
      if (exported) {
        const c = { kind: "export" as const, gameId: decodeURIComponent(exported[1]!) };
        state.calls.push(c);
        const r = state.onExport(c);
        return new Response(r.body, { status: r.status });
      }
      state.calls.push({ kind: "other", gameId: u.pathname });
      return new Response("the sweep made an unexpected Lichess call", { status: 418 });
    },
  };
  return state;
});
vi.mock("@/server/external-play/lichess/board-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/external-play/lichess/board-api")>();
  const wired = real.createBoardApi({
    baseUrl: "https://lichess.test",
    fetch: ((input: string | URL | Request) => lichess.serve(String(input))) as typeof fetch,
  });
  return { ...real, ...board, readGameStream: wired.readGameStream, exportGame: wired.exportGame };
});

// RealtimeKit: the REAL adapter (ensureMeeting / endMeeting) over this fake
// fetch, passed through the adapter's own `deps.fetch` seam. `patchFails`
// answers the deactivate with a 500 that many times.
const rtk = vi.hoisted(() => {
  const state = {
    calls: [] as { method: string; path: string }[],
    patchFails: 0,
    reset() {
      state.calls = [];
      state.patchFails = 0;
    },
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const u = new URL(String(input));
      const path = u.pathname.replace(/^.*\/realtime\/kit\/[^/]+/, "");
      const method = init?.method ?? "GET";
      state.calls.push({ method, path });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (method === "POST" && path === "/meetings") return json(201, { success: true, data: { id: `mtg-${crypto.randomUUID()}` } });
      if (method === "POST" && path.endsWith("/active-session/kick-all")) {
        // Nobody in the room: RealtimeKit's not-found envelope (adapter tests).
        return json(404, { success: false, error: { code: 404, message: "no active session" } });
      }
      if (method === "PATCH" && path.startsWith("/meetings/")) {
        if (state.patchFails > 0) {
          state.patchFails--;
          return json(500, { success: false });
        }
        return json(200, { success: true, data: { status: "INACTIVE" } });
      }
      return json(418, { success: false, error: { code: 418, message: "unexpected RealtimeKit call" } });
    },
  };
  return state;
});
const RTK = { fetch: ((i: string | URL | Request, init?: RequestInit) => rtk.fetch(i, init)) as typeof fetch, baseUrl: "https://rtk.test/client/v4" };

// The forfeit WRITE is observed at scoreEvent's door: a spy around the REAL
// function (it still writes). On today's engine the write is refused, so the
// attempt — who, why, under whose authority — is the only thing to read.
// `refuse` stands in for a refusal today's engine cannot produce (W2b's
// DOUBLE_WALKOVER_NO_NEXT_MATCH); every use is labelled.
type ScoreCall = {
  fixtureId: string;
  input: { type: string; payload: unknown; expected_seq: number; idempotency_key?: string };
  auth: { via: string; role?: string | null; userId?: string | null };
};
const scoring = vi.hoisted(() => ({
  calls: [] as ScoreCall[],
  refuse: null as null | ((fixtureId: string, input: { type: string; payload: unknown }) => Error | null | Promise<Error | null>),
}));
vi.mock("@/server/usecases/scoring", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/scoring")>();
  return {
    ...real,
    scoreEvent: async (...args: Parameters<typeof real.scoreEvent>) => {
      const [auth, fixtureId, input] = args;
      scoring.calls.push({ fixtureId, input: input as ScoreCall["input"], auth: auth as ScoreCall["auth"] });
      const refused = (await scoring.refuse?.(fixtureId, input as { type: string; payload: unknown })) ?? null;
      if (refused) throw refused;
      return real.scoreEvent(...args);
    },
  };
});

/** Every Board API call refuses unless a test scripts it. */
const UNSCRIPTED = { ok: false, code: "unavailable", raw: "unscripted Board API call" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued once-values: a value a test scripted but never
  // reached would leak into the next test. Reset, then refuse by default.
  for (const fn of Object.values(board)) {
    fn.mockReset();
    fn.mockResolvedValue(UNSCRIPTED);
  }
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  __resetCreationQueue();
  lichess.reset();
  scoring.calls = [];
  scoring.refuse = null;
  // Realtime pushes go nowhere: publishRoomBroadcast / the lobby push return
  // at once without these two.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  // RealtimeKit configured with placeholders; every call goes to `rtk` above
  // (and an unrouted default fetch would go to rtk.test, never Cloudflare).
  rtk.reset();
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-test");
  vi.stubEnv("REALTIMEKIT_API_TOKEN", "rtk-test-token");
  vi.stubEnv("REALTIMEKIT_APP_ID", "app-test");
  vi.stubEnv("REALTIMEKIT_PLAYER_PRESET", "player-test");
  vi.stubEnv("REALTIMEKIT_ARBITER_PRESET", "arbiter-test");
  vi.stubEnv("REALTIMEKIT_BASE_URL", "https://rtk.test/client/v4");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ---------------------------------------------------------------------------
// The W2b probe: ask the ENGINE whether a walkover is admitted before a game
// begins (phase `pre`). One event, folded on a fresh boardgame state.
// ---------------------------------------------------------------------------
function engineAdmitsPreWalkover(): boolean {
  try {
    foldMatch(
      boardgame,
      boardgame.configSchema.parse({}),
      { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } },
      [makeEnvelope(1, { type: "core.forfeit", payload: { by: "H", reason: "walkover" } })],
    );
    return true;
  } catch (err) {
    if (err instanceof EngineError && err.code === "WRONG_PHASE") return false;
    throw err;
  }
}
const W2B = engineAdmitsPreWalkover();

/** Spec §3.6's table: a no-show is `core.forfeit {by, reason: "walkover"}`;
 *  both absent is `by: "both"`. The rulebook, not the sweep. */
const WALKOVER = "walkover";

// ---------------------------------------------------------------------------
// Boards, through the real producers.
// ---------------------------------------------------------------------------
type Side = "home" | "away";
type Board = SeedOnlineChessFixtureResult & {
  opened: Date;
  /** `min` minutes after the organiser opened the round. */
  at: (min: number) => Date;
};

/** A round-1 league board whose round the organiser opened a minute ago
 *  through T19's REAL action. The TIMETABLE says three hours from now, so a
 *  sweep that anchored on `scheduled_at` would see a different window. */
async function openedBoard(
  o: { checkedIn: readonly Side[]; kind?: string; openedMinutesAgo?: number } = { checkedIn: [] },
): Promise<Board> {
  const opened = new Date(Date.now() - (o.openedMinutesAgo ?? 1) * 60_000);
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 3 * 60 * 60_000),
    linked: true,
    clock: { base: 300, increment: 3 },
  });
  if (o.kind) await sql`update stages set kind = ${o.kind} where id = ${s.stageId}`;
  const res = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }, { now: opened });
  expect(res.opened, "premise: T19 opened the round").toBe(true);
  for (const side of o.checkedIn) await stampFixtureCheckIn(s[side].personId, s.fixtureId, s.orgId);
  return { ...s, opened, at: (min) => new Date(opened.getTime() + min * 60_000) };
}

async function sweep(b: Board | readonly Board[], deps: SweepDeps): Promise<SweepReport> {
  const boards = Array.isArray(b) ? (b as readonly Board[]) : [b as Board];
  return sweepExternalPlay({ ...deps, orgIds: boards.map((x) => x.orgId) });
}

const forfeitsAttempted = (fixtureId: string) =>
  scoring.calls.filter((c) => c.fixtureId === fixtureId && c.input.type === "core.forfeit");
const forfeitsWritten = async (fixtureId: string) =>
  sql<{ payload: { by: string; reason: string } }[]>`
    select payload from score_events where fixture_id = ${fixtureId} and type = 'core.forfeit' order by seq`;
const fixtureRow = async (fixtureId: string) => {
  const [r] = await sql<{ status: string; outcome: { kind?: string; winner?: string } | null }[]>`
    select status, outcome from fixtures where id = ${fixtureId}`;
  return r!;
};

// ---------------------------------------------------------------------------
// playableWindow
// ---------------------------------------------------------------------------
describe("playableWindow — anchored on the round being OPENED", () => {
  const t = new Date("2026-10-09T10:00:00.000Z");

  it("opens exactly when the organiser opened the round", () => {
    expect(playableWindow(t).opensAt.toISOString()).toBe(t.toISOString());
  });

  it("closes at the instant the match room itself closes — window.ts's own reading, not a literal", () => {
    // Gate B (2026-10-11): every merged reader — create-game, preflight, the
    // room, the invite, openRound — judges the window with
    // `roomPhase(now, roundOpenedAt)`, so the deadline is opened + T+20, not
    // opened + T-10 + T+20. The sweep's deadline is pinned to the room's own
    // predicate: one millisecond before it the room is open, at it closed.
    const { deadline } = playableWindow(t);
    expect(roomPhase(new Date(deadline.getTime() - 1), t)).toBe("open");
    expect(roomPhase(deadline, t)).toBe("closed");
    expect(deadline.getTime()).toBe(windowFor(t).deadline.getTime());
    expect(deadline.getTime() - t.getTime(), "T+20 from the open").toBe(DEADLINE_AFTER_MS);
    expect(DEADLINE_AFTER_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D12: an unopened round is unreachable.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("the sweep never touches a round the organiser has not opened", () => {
  it("a board scheduled THREE HOURS AGO whose round was never opened is not forfeited, or even tried", async () => {
    // The trap: the pre-D12 code anchored on fixtures.scheduled_at, so a stale
    // timetable would walk a whole field over for a round that never started.
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(Date.now() - 3 * 60 * 60_000),
      linked: true,
    });
    // A bridge row an entry point other than the open minted (T9's
    // ensureBridgeRow) — the row a no-show would otherwise be found by.
    const f = await loadOnlinePlayFixture(s.fixtureId);
    await ensureBridgeRow(f!);
    expect((await sql`select 1 from stage_round_opens where stage_id = ${s.stageId}`).length, "premise: never opened").toBe(0);
    const report = await sweepExternalPlay({ now: new Date(), orgIds: [s.orgId] });
    expect(report.noShows).toBe(0);
    expect(forfeitsAttempted(s.fixtureId), "not even attempted").toEqual([]);
    expect(await forfeitsWritten(s.fixtureId)).toEqual([]);
    expect((await fixtureRow(s.fixtureId)).status).toBe("scheduled");
  });

  it("the positive pair: an OPENED round past its deadline is swept, nobody having come", async () => {
    // Without it the test above passes on a sweep that never forfeits at all.
    const b = await openedBoard({ checkedIn: [] });
    const report = await sweep(b, { now: b.at(45) });
    expect(report.scanned, "the board was a candidate").toBeGreaterThanOrEqual(1);
    const tried = forfeitsAttempted(b.fixtureId);
    expect(tried.map((c) => c.input.payload)).toEqual([{ by: "both", reason: WALKOVER }]);
    if (W2B) {
      expect(report.noShows).toBe(1);
      expect((await forfeitsWritten(b.fixtureId)).length).toBe(1);
    } else {
      // Today's engine: refused in phase pre, and said so, never thrown.
      expect(report.noShows).toBe(0);
      expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: "WRONG_PHASE" }]);
      expect(await forfeitsWritten(b.fixtureId)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Games, through the real producers (T9 creates, T10 moves).
// ---------------------------------------------------------------------------
/** T9's REAL createGameIfReady at `min` minutes after the open: White's
 *  token challenges, Black's accepts (Board API module-mocked). 'ready'. */
async function readyGame(b: Board, min = 5): Promise<string> {
  const gameId = `gm-${randomUUID().slice(0, 12)}`;
  board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: gameId });
  board.acceptChallenge.mockResolvedValueOnce({ ok: true });
  expect(await createGameIfReady(b.fixtureId, { now: b.at(min), publish: async () => {} }), "premise: T9 created the game")
    .toEqual({ created: true, gameId });
  return gameId;
}

/** T10's REAL act: White (home, by the seed's pairing) plays e2e4 at
 *  `min` minutes — ready -> live, started_at stamped by T10 itself. */
async function liveGame(b: Board, min = 6): Promise<string> {
  const gameId = await readyGame(b, min - 1);
  const out = await act(
    { fixtureId: b.fixtureId, personId: b.home.personId, action: { kind: "move", uci: "e2e4" } },
    { now: b.at(min), accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }) },
  );
  expect(out, "premise: T10 accepted the first move").toEqual({ ok: true, applied: true });
  const [r] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${b.fixtureId}`;
  expect(r!.status, "premise: T10 moved the row to live").toBe("live");
  return gameId;
}

// ---------------------------------------------------------------------------
// Job 1 — the T+20 no-show.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("job 1 — the T+20 no-show (the chess forfeit no other test covers)", () => {
  // swiss-withdrawal-walkover.test.ts forfeits an unstarted board too, but it
  // is badminton, whose engine tolerates `pre`. boardgame does not until W2b,
  // and no test anywhere drives a chess pre-game forfeit: this one does.
  it("ONE player absent forfeits by THAT entrant, reason 'walkover', under the organiser's authority — each side", async () => {
    let checked = 0;
    for (const present of ["home", "away"] as const) {
      const absent: Side = present === "home" ? "away" : "home";
      const b = await openedBoard({ checkedIn: [present] });
      const report = await sweep(b, { now: b.at(45) });
      const tried = forfeitsAttempted(b.fixtureId);
      expect(tried.length, `${absent} absent: one attempt`).toBe(1);
      expect(tried[0]!.input.payload, `${absent} absent`).toEqual({ by: b[absent].entrantId, reason: WALKOVER });
      expect(tried[0]!.input.expected_seq, "a board that never began holds no event").toBe(0);
      expect(tried[0]!.input.idempotency_key).toBe(`extplay-noshow:${b.fixtureId}`);
      // W2a: core.forfeit is organiser-only — the org OWNER's session, never a player's.
      expect(tried[0]!.auth).toMatchObject({ via: "session", role: "owner", userId: b.ownerUserId });
      if (W2B) {
        expect(report.noShows).toBe(1);
        expect(await forfeitsWritten(b.fixtureId)).toEqual([{ by: b[absent].entrantId, reason: WALKOVER }]);
        const fx = await fixtureRow(b.fixtureId);
        expect(fx.status).toBe("forfeited");
        expect(fx.outcome).toMatchObject({ kind: "award", winner: b[present].entrantId, loser: b[absent].entrantId });
      } else {
        expect(report.noShows).toBe(0);
        expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: "WRONG_PHASE" }]);
        expect(await forfeitsWritten(b.fixtureId)).toEqual([]);
        expect((await fixtureRow(b.fixtureId)).status, "refused: nothing moved").toBe("scheduled");
      }
      checked++;
    }
    expect(checked, "both sides checked").toBe(2);
  });

  it("BOTH absent is a DOUBLE walkover: by 'both', and nobody advances", async () => {
    const b = await openedBoard({ checkedIn: [] });
    const report = await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId).map((c) => c.input.payload)).toEqual([{ by: "both", reason: WALKOVER }]);
    if (W2B) {
      expect(report.noShows).toBe(1);
      const fx = await fixtureRow(b.fixtureId);
      expect(fx.status).toBe("forfeited");
      expect(fx.outcome, "no winner for anyone").toEqual({ kind: "double_walkover" });
    } else {
      expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: "WRONG_PHASE" }]);
    }
  });

  it("BOTH present at the deadline with no game is NOT a no-show", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const report = await sweep(b, { now: b.at(45) });
    expect(report.scanned, "the board was looked at").toBeGreaterThanOrEqual(1);
    expect(report.noShows).toBe(0);
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
  });

  it("BEFORE the deadline nobody is ruled absent — the minute before, and the deadline itself", async () => {
    const b = await openedBoard({ checkedIn: [] });
    const { deadline } = playableWindow(b.opened);
    await sweep(b, { now: new Date(deadline.getTime() - 1) });
    expect(forfeitsAttempted(b.fixtureId), "one millisecond before T+20").toEqual([]);
    await sweep(b, { now: deadline });
    expect(forfeitsAttempted(b.fixtureId).length, "at T+20 exactly: the room has closed").toBe(1);
  });

  it("a SECOND pass does not forfeit the same board twice", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    await sweep(b, { now: b.at(45) });
    const second = await sweep(b, { now: b.at(50) });
    expect(second.noShows).toBe(0);
    if (W2B) {
      // Forfeited ⇒ no longer playable ⇒ not a candidate at all.
      expect(forfeitsAttempted(b.fixtureId).length).toBe(1);
      expect((await forfeitsWritten(b.fixtureId)).length).toBe(1);
    } else {
      // Refused ⇒ still open ⇒ asked again, under the SAME key, and refused again.
      const tried = forfeitsAttempted(b.fixtureId);
      expect(tried.length).toBe(2);
      expect(new Set(tried.map((c) => c.input.idempotency_key)).size).toBe(1);
      expect(await forfeitsWritten(b.fixtureId)).toEqual([]);
    }
  });

  it("a LATE arrival before the deadline is seated, not swallowed by an idempotency guard", async () => {
    // AGENTS.md rule 13: an `if (already) return` also swallows a legitimate
    // new arrival. The first pass runs before the deadline with one player in.
    const b = await openedBoard({ checkedIn: ["home"] });
    const first = await sweep(b, { now: b.at(15) });
    expect(first.noShows, "not past the deadline yet").toBe(0);
    await stampFixtureCheckIn(b.away.personId, b.fixtureId, b.orgId);
    await sweep(b, { now: b.at(25) });
    expect(forfeitsAttempted(b.fixtureId), "they came — no forfeit").toEqual([]);
  });

  it("the other direction: a check-in stamped AFTER the deadline does not count — still a no-show", async () => {
    // The round opened 30 minutes ago in real time, so Black's check-in,
    // stamped now, lands outside its window (checkInCounts, spec §7.2) and
    // the board is a DOUBLE walkover. Its pair is the one-absent case above,
    // where the same stamp inside the window made it Black's opponent alone.
    const b = await openedBoard({ checkedIn: ["away"], openedMinutesAgo: 30 });
    const [ci] = await sql<{ checked_in_at: Date }[]>`
      select checked_in_at from fixture_availability where fixture_id = ${b.fixtureId} and person_id = ${b.away.personId}`;
    expect(ci!.checked_in_at.getTime(), "premise: stamped past T+20").toBeGreaterThanOrEqual(playableWindow(b.opened).deadline.getTime());
    await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId).map((c) => c.input.payload)).toEqual([{ by: "both", reason: WALKOVER }]);
  });

  it("a board whose game EXISTS is never a no-show, however late — ready (never started) or live", async () => {
    // Spec §3.6: "T+20 is the deadline to be seated and have the game created
    // — not a cap on the game."
    let checked = 0;
    for (const make of [readyGame, liveGame]) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      await make(b);
      await sweep(b, { now: b.at(240) });
      expect(forfeitsAttempted(b.fixtureId), make.name).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a possibly-sent create (T9's create_sent_at marker) is never ruled a no-show", async () => {
    const b = await openedBoard({ checkedIn: [] });
    // Stands for T9's createAtDequeue: the marker it writes before the HTTP
    // call, whose outcome is unknown (T9 I2) — a game may exist.
    await sql`update fixture_external_play set create_sent_at = ${b.at(19)} where fixture_id = ${b.fixtureId}`;
    await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
  });

  it("a create IN FLIGHT (a live mint claim) is left to T9; a STALE claim is not a game", async () => {
    const live = await openedBoard({ checkedIn: [] });
    const stale = await openedBoard({ checkedIn: [] });
    const now = live.at(45);
    // Stand for T9's claim (mint_claimed_at), live and abandoned.
    await sql`update fixture_external_play set mint_claimed_at = ${new Date(now.getTime() - 1_000)} where fixture_id = ${live.fixtureId}`;
    await sql`update fixture_external_play set mint_claimed_at = ${new Date(now.getTime() - MINT_CLAIM_STALE_MS - 1_000)}
               where fixture_id = ${stale.fixtureId}`;
    await sweepExternalPlay({ now, orgIds: [live.orgId, stale.orgId] });
    expect(forfeitsAttempted(live.fixtureId), "in flight: wait").toEqual([]);
    expect(forfeitsAttempted(stale.fixtureId).length, "stale: nothing is in flight").toBe(1);
  });

  it("a pending row that names a challenge is a game on file (invite.ts's predicate), never a no-show", async () => {
    // Defence: no writer leaves a challenge on a 'pending' row today (T9
    // records one only with ready / needs_organiser), but a row that names
    // a game is a row a game may sit behind.
    const b = await openedBoard({ checkedIn: [] });
    await sql`update fixture_external_play set challenge_id = ${`gm-${randomUUID().slice(0, 12)}`} where fixture_id = ${b.fixtureId}`;
    await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
  });

  it("online play switched OFF after the open: the board went back to the table, and the guard says so", async () => {
    const b = await openedBoard({ checkedIn: [] });
    // Stands for the organiser's settings save (divisions.config.onlinePlay).
    await sql`update divisions set config = config || '{"onlinePlay":"off"}'::jsonb where id = ${b.divisionId}`;
    const report = await sweep(b, { now: b.at(45) });
    expect(report.scanned, "still a candidate by the open").toBeGreaterThanOrEqual(1);
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  it("a board held for the organiser's decision (needs_decision) is never forfeited", async () => {
    const b = await openedBoard({ checkedIn: [] });
    // Stands for W2a's held level result (V432): played, not finished.
    await sql`update fixtures set status = 'needs_decision' where id = ${b.fixtureId}`;
    const report = await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(report.failures).toEqual([]);
  });

  it("after a WITHDRAWAL the board is the withdrawal's, never the sweep's", async () => {
    const b = await openedBoard({ checkedIn: [] });
    await withdrawEntrantCascade(await mintOrgOwnerAuth(b.orgId), b.away.entrantId);
    const status = (await fixtureRow(b.fixtureId)).status;
    expect(status, "premise: a league withdrawal settles the board").not.toBe("scheduled");
    await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
  });

  it("an EMPTY org scope is a scope with nothing in it, never every org", async () => {
    const report = await sweepExternalPlay({ now: new Date(), orgIds: [] });
    expect(report).toMatchObject({ scanned: 0, noShows: 0, failures: [] });
    expect(scoring.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Job 1 — a double walkover with nowhere for "nobody advances" to go.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("job 1 — a double walkover with no next match is HELD, not thrown", () => {
  // W2b D19 refuses `by: "both"` in a bracket kind on a fixture that feeds no
  // next match (no winner/loser edge — the feed graph, never a round name):
  // EngineError DOUBLE_WALKOVER_NO_NEXT_MATCH. The board stays OPEN for the
  // organiser — a handled outcome. Today's engine refuses the pre-phase
  // forfeit first (WRONG_PHASE) and cannot produce this refusal, so the
  // today-half injects it at scoreEvent's door: the code W2b throws
  // (packages/engine errors.ts on feat/format-matrix-w2b), with a message
  // that is NOT W2b's — the routing must read the code, never the text.
  const NO_NEXT = "DOUBLE_WALKOVER_NO_NEXT_MATCH";
  const injectNoNextFor = (fixtureId: string) => {
    scoring.refuse = (id, input) =>
      id === fixtureId && input.type === "core.forfeit" && (input.payload as { by?: string }).by === "both"
        ? new EngineError(NO_NEXT as never, "injected: a message the sweep must not read")
        : null;
  };
  const bridgeOf = async (fixtureId: string) => {
    const [r] = await sql<{ status: string; needs_reason: string | null }[]>`
      select status, needs_reason from fixture_external_play where fixture_id = ${fixtureId}`;
    return r ?? null;
  };
  /** A bracket line that feeds no next match, in W2b's own terms. */
  const SHAPES = [
    { label: "a knockout final", kind: "knockout", thirdPlace: false },
    { label: "a third-place match", kind: "knockout", thirdPlace: true },
    { label: "a stepladder's last rung", kind: "stepladder", thirdPlace: false },
  ] as const;

  it("each no-next-match shape leaves the board OPEN, held double_walkover_blocked, and is counted — never a failure", async () => {
    let checked = 0;
    for (const shape of W2B ? SHAPES : SHAPES.slice(0, 1)) {
      const b = await openedBoard({ checkedIn: [], kind: shape.kind });
      if (shape.thirdPlace) await sql`update fixtures set third_place = true where id = ${b.fixtureId}`;
      if (!W2B) injectNoNextFor(b.fixtureId);
      const report = await sweep(b, { now: b.at(45) });
      expect(forfeitsAttempted(b.fixtureId).map((c) => c.input.payload), shape.label).toEqual([{ by: "both", reason: WALKOVER }]);
      expect(report.heldForOrganiser, shape.label).toBe(1);
      expect(report.noShows, shape.label).toBe(0);
      expect(report.failures, `${shape.label}: handled, not failed`).toEqual([]);
      const fx = await fixtureRow(b.fixtureId);
      expect(fx.status, `${shape.label} stays open`).toBe("scheduled");
      expect(fx.outcome).toBeNull();
      expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "double_walkover_blocked" });
      checked++;
    }
    expect(checked, "no-next-match shapes checked").toBe(W2B ? SHAPES.length : 1);
  });

  it("the pair: a double walkover that FEEDS a next match is not held (W2b writes it; today it is the pre-phase refusal)", async () => {
    const b = await openedBoard({ checkedIn: [], kind: "knockout" });
    // A next match for the winner to go to — the feed edge W2b reads.
    const [next] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      values (${b.stageId}, ${b.divisionId}, ${b.orgId}, 2, 1, ${`nx-${randomUUID().slice(0, 6)}`}, 'scheduled')
      returning id`;
    await sql`update fixtures set winner_to_fixture = ${next!.id} where id = ${b.fixtureId}`;
    const report = await sweep(b, { now: b.at(45) });
    expect(report.heldForOrganiser).toBe(0);
    expect((await bridgeOf(b.fixtureId))?.status, "not held").toBe("pending");
    if (W2B) {
      expect(report.noShows).toBe(1);
      expect(await forfeitsWritten(b.fixtureId)).toEqual([{ by: "both", reason: WALKOVER }]);
    } else {
      expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: "WRONG_PHASE" }]);
    }
  });

  it("only THAT code holds: any other refusal of a double walkover is a failure, and the board is not held", async () => {
    const b = await openedBoard({ checkedIn: [] });
    scoring.refuse = (id) => (id === b.fixtureId ? new EngineError("INVALID_EVENT", "injected: some other refusal") : null);
    const report = await sweep(b, { now: b.at(45) });
    expect(report.heldForOrganiser).toBe(0);
    expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: "INVALID_EVENT" }]);
    expect((await bridgeOf(b.fixtureId))?.status).toBe("pending");
  });

  it("THAT code on a SINGLE forfeit is not a double walkover: a failure, never a hold", async () => {
    // W2b raises it for `by: "both"` only; a single forfeit refused with it
    // would be a W2b defect, and must not be filed as double_walkover_blocked.
    const b = await openedBoard({ checkedIn: ["home"] });
    scoring.refuse = (id) => (id === b.fixtureId ? new EngineError(NO_NEXT as never, "injected") : null);
    const report = await sweep(b, { now: b.at(45) });
    expect(report.heldForOrganiser).toBe(0);
    expect(report.failures).toEqual([{ job: "no_show", fixtureId: b.fixtureId, code: NO_NEXT }]);
    expect((await bridgeOf(b.fixtureId))?.status).toBe("pending");
  });

  it("a board settled while the refused forfeit was in flight is not counted as held", async () => {
    // Staged at scoreEvent's door: the organiser cancels the board, THEN the
    // refusal lands. T12's hold answers `none` for an unplayable fixture, and
    // nothing was held, so nothing is counted.
    const b = await openedBoard({ checkedIn: [], kind: "knockout" });
    scoring.refuse = async (id, input) => {
      if (id !== b.fixtureId || input.type !== "core.forfeit") return null;
      // Stands for the organiser's cancel of this board.
      await sql`update fixtures set status = 'cancelled' where id = ${b.fixtureId}`;
      return new EngineError(NO_NEXT as never, "injected");
    };
    const report = await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId).length, "premise: the refusal landed").toBe(1);
    expect(report.heldForOrganiser).toBe(0);
    expect(report.failures).toEqual([]);
    expect((await bridgeOf(b.fixtureId))?.status, "nothing held").toBe("pending");
  });

  it("the refusal does not abort the rest of the pass", async () => {
    const blocked = await openedBoard({ checkedIn: [], kind: "knockout" });
    const ordinary = await openedBoard({ checkedIn: ["home"] });
    if (!W2B) injectNoNextFor(blocked.fixtureId);
    const report = await sweepExternalPlay({ now: blocked.at(45), orgIds: [blocked.orgId, ordinary.orgId] });
    expect(report.heldForOrganiser).toBe(1);
    expect(forfeitsAttempted(ordinary.fixtureId).map((c) => c.input.payload), "the other board still got its ruling")
      .toEqual([{ by: ordinary.away.entrantId, reason: WALKOVER }]);
  });

  it("a HELD board is the organiser's: the next pass neither re-tries nor re-holds it", async () => {
    const b = await openedBoard({ checkedIn: [], kind: "knockout" });
    if (!W2B) injectNoNextFor(b.fixtureId);
    await sweep(b, { now: b.at(45) });
    const second = await sweep(b, { now: b.at(50) });
    expect(forfeitsAttempted(b.fixtureId).length, "one attempt, ever").toBe(1);
    expect(second.heldForOrganiser).toBe(0);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "double_walkover_blocked" });
  });

  it("a board with NO bridge row (paired after the open) still holds: the row is minted first", async () => {
    const b = await openedBoard({ checkedIn: [], kind: "knockout" });
    // Stands for a board the open never attached (no row yet): T13 mints it
    // through T9's ensureBridgeRow, because T12's hold needs a row to hold.
    await sql`delete from fixture_external_play where fixture_id = ${b.fixtureId}`;
    if (!W2B) injectNoNextFor(b.fixtureId);
    const report = await sweep(b, { now: b.at(45) });
    expect(report.failures).toEqual([]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "double_walkover_blocked" });
  });
});

// ---------------------------------------------------------------------------
// Job 2 — the mint retry (M3).
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("job 2 — retry a create that lost to Lichess's 429 wall (M3)", () => {
  /** Model time for the creation queue too: it stamps `retry_at` from its
   *  own clock, so that clock is the sweep's. */
  const queueAt = (t: Date) => __setCreationQueueDeps({ now: () => t.getTime() });

  /** T9's REAL createGameIfReady meeting a Lichess 429 at `min`: the claim
   *  is released, the queue holds White for CREATION_429_HOLD_MS, and T9
   *  records `retry_at` for THIS job on a still-pending row. */
  async function throttled(b: Board, min: number): Promise<Date> {
    queueAt(b.at(min));
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests. Try again later." });
    expect(await createGameIfReady(b.fixtureId, { now: b.at(min), publish: async () => {} }), "premise: T9 was throttled")
      .toEqual({ created: false, reason: "provider_error" });
    const [r] = await sql<{ status: string; challenge_id: string | null; last_error: string | null }[]>`
      select status, challenge_id, last_error from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(r!.status).toBe("pending");
    expect(r!.challenge_id).toBeNull();
    const at = /retry_at=(\S+)$/.exec(r!.last_error ?? "")?.[1];
    expect(at, `premise: T9 recorded when to retry (${r!.last_error})`).toBeDefined();
    const retryAt = new Date(at!);
    expect(retryAt.getTime(), "premise: Lichess's hold, from the queue's own constant").toBe(b.at(min).getTime() + CREATION_429_HOLD_MS);
    return retryAt;
  }

  /** The real T9 behind a recorder, so the test can see what was retried. */
  function recordingCreate() {
    const tried: { fixtureId: string; now: Date }[] = [];
    const createGame: NonNullable<SweepDeps["createGameIfReady"]> = async (fixtureId, d) => {
      tried.push({ fixtureId, now: d.now });
      queueAt(d.now);
      return createGameIfReady(fixtureId, { now: d.now, publish: async () => {} });
    };
    return { tried, createGame };
  }
  const bridgeStatus = async (fixtureId: string) => {
    const [r] = await sql<{ status: string; challenge_id: string | null }[]>`
      select status, challenge_id from fixture_external_play where fixture_id = ${fixtureId}`;
    return r!;
  };

  it("past retry_at and inside the window, the create is retried — and lands", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const retryAt = await throttled(b, 3);
    const { tried, createGame } = recordingCreate();
    const gameId = `gm-${randomUUID().slice(0, 12)}`;
    board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: gameId });
    board.acceptChallenge.mockResolvedValueOnce({ ok: true });
    const now = new Date(retryAt.getTime() + 1_000);
    const report = await sweep(b, { now, createGameIfReady: createGame });
    expect(tried).toEqual([{ fixtureId: b.fixtureId, now }]);
    expect(report.mintRetries).toBe(1);
    expect(await bridgeStatus(b.fixtureId)).toEqual({ status: "ready", challenge_id: gameId });
  });

  it("BEFORE retry_at it waits: the hold Lichess asked for is honoured", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const retryAt = await throttled(b, 3);
    const { tried, createGame } = recordingCreate();
    const report = await sweep(b, { now: new Date(retryAt.getTime() - 1_000), createGameIfReady: createGame });
    expect(tried).toEqual([]);
    expect(report.mintRetries).toBe(0);
    const second = await sweep(b, { now: retryAt, createGameIfReady: createGame });
    expect(second.mintRetries, "at retry_at itself the hold is over").toBe(1);
  });

  it("OUTSIDE the window it is not retried: past T+20 no game can be made", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await throttled(b, 19);
    const { tried, createGame } = recordingCreate();
    await sweep(b, { now: playableWindow(b.opened).deadline, createGameIfReady: createGame });
    expect(tried, "at the deadline").toEqual([]);
    await sweep(b, { now: b.at(45), createGameIfReady: createGame });
    expect(tried, "long after").toEqual([]);
  });

  it("a board whose create LANDED since (a player's own check-in) is not retried", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await throttled(b, 3);
    queueAt(b.at(5));
    await readyGame(b, 5); // T9 again, this time through: the 429 marker is cleared with the ready commit
    const { tried, createGame } = recordingCreate();
    await sweep(b, { now: b.at(6), createGameIfReady: createGame });
    expect(tried).toEqual([]);
  });

  it("a retry that is throttled AGAIN stays pending with a fresh retry_at — never held — and the next one lands", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const first = await throttled(b, 3);
    const { tried, createGame } = recordingCreate();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests." });
    const t1 = new Date(first.getTime() + 1_000);
    await sweep(b, { now: t1, createGameIfReady: createGame });
    expect((await bridgeStatus(b.fixtureId)).status, "still pending: the next pass tries again").toBe("pending");
    const [r] = await sql<{ last_error: string }[]>`select last_error from fixture_external_play where fixture_id = ${b.fixtureId}`;
    const again = new Date(/retry_at=(\S+)$/.exec(r!.last_error)![1]!);
    expect(again.getTime(), "a NEW hold, from the retry's own 429").toBe(t1.getTime() + CREATION_429_HOLD_MS);
    const gameId = `gm-${randomUUID().slice(0, 12)}`;
    board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: gameId });
    board.acceptChallenge.mockResolvedValueOnce({ ok: true });
    await sweep(b, { now: new Date(again.getTime() + 1_000), createGameIfReady: createGame });
    expect(tried.length).toBe(2);
    expect(await bridgeStatus(b.fixtureId)).toEqual({ status: "ready", challenge_id: gameId });
  });

  it("a pending board that was never throttled is not the retry's — check-in mints it", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const { tried, createGame } = recordingCreate();
    const report = await sweep(b, { now: b.at(5), createGameIfReady: createGame });
    expect(tried).toEqual([]);
    expect(report.mintRetries).toBe(0);
  });

  it("retry_at=unknown (T9's spelling of a hold with no time) is retried at once; an unreadable time likewise", async () => {
    let checked = 0;
    for (const marker of ["create:rate_limited (lichess_429) retry_at=unknown", "create:rate_limited (lichess_429) retry_at=not-a-time"]) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      // Stands for T9's noteThrottled with a null retryAt / a mangled one.
      await sql`update fixture_external_play set last_error = ${marker} where fixture_id = ${b.fixtureId}`;
      const { tried, createGame } = recordingCreate();
      board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` });
      board.acceptChallenge.mockResolvedValueOnce({ ok: true });
      await sweep(b, { now: b.at(5), createGameIfReady: createGame });
      expect(tried.length, marker).toBe(1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a throttled board HELD since is the organiser's, never retried", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const retryAt = await throttled(b, 3);
    // Stands for any hold landing on the throttled row (T12's hold keeps an
    // earlier last_error when it is given no detail): the marker survives.
    await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'provider_error'
               where fixture_id = ${b.fixtureId}`;
    const { tried, createGame } = recordingCreate();
    const report = await sweep(b, { now: new Date(retryAt.getTime() + 1_000), createGameIfReady: createGame });
    expect(tried).toEqual([]);
    expect(report.mintRetries).toBe(0);
  });

  it("a throttled board withdrawn since is not retried", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const retryAt = await throttled(b, 3);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(b.orgId), b.away.entrantId);
    const { tried, createGame } = recordingCreate();
    await sweep(b, { now: new Date(retryAt.getTime() + 1_000), createGameIfReady: createGame });
    expect(tried).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lichess truth, from the recordings (src/server/external-play/__fixtures__/
// lichess, README) re-addressed to our game and players — ids only.
// ---------------------------------------------------------------------------
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../external-play/__fixtures__/lichess");
type GameFullJson = {
  id: string;
  white: { id: string; name: string };
  black: { id: string; name: string };
  state: { moves: string; status: string; winner?: string; wtime: number; btime: number };
};
const recorded = (name: string): GameFullJson =>
  JSON.parse(readFileSync(join(FIX, name), "utf8").split("\n")[0]!) as GameFullJson;
/** Recorded 2026-10-11: 8 plies, started. */
const MID = recorded("gamefull-mid-white.ndjson");
/** Recorded 2026-10-11: the same game, outoftime, winner black. */
const ENDED = recorded("gamefull-expired-2.ndjson");
function gameFull(b: Board, gameId: string, base: GameFullJson, over: { moves?: readonly string[]; status?: string } = {}): string {
  const j = JSON.parse(JSON.stringify(base)) as GameFullJson;
  j.id = gameId;
  j.white.id = j.white.name = b.home.lichessId; // the seed pairs home as White
  j.black.id = j.black.name = b.away.lichessId;
  if (over.moves !== undefined) j.state.moves = over.moves.join(" ");
  if (over.status !== undefined) {
    j.state.status = over.status;
    delete j.state.winner;
  }
  return `${JSON.stringify(j)}\n`;
}
const serveStream = (body: string) => {
  lichess.onStream = () => ({ status: 200, body });
};

// ---------------------------------------------------------------------------
// Job 3 — meeting teardown.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("job 3 — tear the meeting down at the result, or at T+20 when nobody played", () => {
  /** T7's REAL ensureMeeting (fake fetch): the room a first arrival opens. */
  async function meetingFor(b: Board): Promise<string> {
    const { meetingId } = await ensureMeeting(b.fixtureId, RTK);
    rtk.calls = [];
    return meetingId;
  }
  /** T7's REAL endMeeting behind a recorder. */
  function recordingEnd() {
    const ended: string[] = [];
    const end: NonNullable<SweepDeps["endMeeting"]> = async (m) => {
      ended.push(m);
      await endMeeting(m, RTK);
    };
    return { ended, end };
  }
  const endedAt = async (fixtureId: string) => {
    const [r] = await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`;
    return r?.ended_at ?? null;
  };

  it("past T+20 with no game on file, the meeting is ended ONCE: kick-all, deactivate, stamped", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    const m = await meetingFor(b);
    const { ended, end } = recordingEnd();
    const report = await sweep(b, { now: b.at(45), endMeeting: end });
    expect(ended).toEqual([m]);
    expect(report.meetingsEnded).toBe(1);
    expect(rtk.calls).toEqual([
      { method: "POST", path: `/meetings/${m}/active-session/kick-all` },
      { method: "PATCH", path: `/meetings/${m}` },
    ]);
    expect(await endedAt(b.fixtureId)).not.toBeNull();
    const second = await sweep(b, { now: b.at(50), endMeeting: end });
    expect(second.meetingsEnded, "idempotent").toBe(0);
    expect(ended).toEqual([m]);
  });

  it("BEFORE T+20 a room with no game yet stays up — somebody may still come", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    await meetingFor(b);
    const { ended, end } = recordingEnd();
    const { deadline } = playableWindow(b.opened);
    await sweep(b, { now: new Date(deadline.getTime() - 1), endMeeting: end });
    expect(ended, "one millisecond before T+20").toEqual([]);
    await sweep(b, { now: deadline, endMeeting: end });
    expect(ended.length, "at T+20 exactly the room has closed").toBe(1);
  });

  it("a possibly-sent create (T9's create_sent_at) is a game that may exist: its meeting stays", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await meetingFor(b);
    // Stands for T9's createAtDequeue marker before its HTTP call (T9 I2).
    await sql`update fixture_external_play set create_sent_at = ${b.at(19)} where fixture_id = ${b.fixtureId}`;
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(45), endMeeting: end });
    expect(ended).toEqual([]);
  });

  it("a game on file keeps its meeting past T+20 — ready (never started) or live", async () => {
    // "Nothing in our system ends a live game early" (spec §3.6): its
    // players are on camera, so the meeting stays up with it.
    let checked = 0;
    for (const make of [readyGame, liveGame]) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      await meetingFor(b);
      await make(b);
      const { ended, end } = recordingEnd();
      await sweep(b, { now: b.at(240), endMeeting: end });
      expect(ended, make.name).toEqual([]);
      expect(await endedAt(b.fixtureId), make.name).toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a FINISHED game's meeting is ended at the result, before T+20 or not", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const m = await meetingFor(b);
    const gameId = await liveGame(b);
    // T11's REAL reconcile reads the recorded ending (outoftime) and T12
    // writes the result: the bridge is 'finished'.
    serveStream(gameFull(b, gameId, ENDED));
    await reconcile(b.fixtureId, "game_end", { now: b.at(10) });
    const [r] = await sql<{ status: string }[]>`select status from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect(r!.status, "premise: T11 finished the game").toBe("finished");
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(11), endMeeting: end });
    expect(ended).toEqual([m]);
  });

  it("a game closed while the FIXTURE plays on (a level result already on the pad, its tie-break pending): ended at the result", async () => {
    // The bridge's own 'finished' is the only signal here: the fixture still
    // reads in_play (its tie-break is the organiser's) and a game IS on file,
    // so neither the settled-board rule nor the nobody-played rule sees it.
    const b = await openedBoard({ checkedIn: ["home", "away"], kind: "knockout" });
    const m = await meetingFor(b);
    const gameId = await readyGame(b);
    const auth = await mintOrgOwnerAuth(b.orgId);
    const seq = (await getFixtureState(auth, b.fixtureId)).last_seq;
    await scoreEvent(auth, b.fixtureId, { expected_seq: seq, type: "core.start", payload: {} });
    await scoreEvent(auth, b.fixtureId, { expected_seq: seq + 1, type: "boardgame.result", payload: { winner: null } });
    serveStream(gameFull(b, gameId, ENDED));
    expect(await reconcile(b.fixtureId, "game_end", { now: b.at(10) }), "premise: T11 finished the bridge, T12 wrote nothing")
      .toMatchObject({ result: { wrote: "none" }, finished: true });
    expect((await fixtureRow(b.fixtureId)).status, "premise: the fixture plays on").toBe("in_play");
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(11), endMeeting: end });
    expect(ended).toEqual([m]);
  });

  it("a board settled by a WITHDRAWAL has its meeting ended", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    const m = await meetingFor(b);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(b.orgId), b.away.entrantId);
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(5), endMeeting: end });
    expect(ended).toEqual([m]);
  });

  it("both seated but no game ever made (the create never landed) — past T+20 nothing can be played: ended", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const m = await meetingFor(b);
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(45), endMeeting: end });
    expect(ended).toEqual([m]);
  });

  it("a board with no meeting at all is not a teardown, and RealtimeKit is not called", async () => {
    const b = await openedBoard({ checkedIn: [] });
    const { ended, end } = recordingEnd();
    const report = await sweep(b, { now: b.at(45), endMeeting: end });
    expect(ended).toEqual([]);
    expect(report.meetingsEnded).toBe(0);
    expect(rtk.calls).toEqual([]);
  });

  it("a FAILED deactivate leaves the meeting unended and reported; the next pass ends it", async () => {
    const b = await openedBoard({ checkedIn: [] });
    const m = await meetingFor(b);
    const { ended, end } = recordingEnd();
    rtk.patchFails = 1;
    const first = await sweep(b, { now: b.at(45), endMeeting: end });
    expect(first.meetingsEnded).toBe(0);
    expect(first.failures.filter((f) => f.job === "teardown")).toEqual([{ job: "teardown", fixtureId: b.fixtureId, code: "unavailable" }]);
    expect(await endedAt(b.fixtureId), "still joinable upstream: not stamped").toBeNull();
    const second = await sweep(b, { now: b.at(50), endMeeting: end });
    expect(second.meetingsEnded).toBe(1);
    expect(ended).toEqual([m, m]);
    expect(await endedAt(b.fixtureId)).not.toBeNull();
  });
});
