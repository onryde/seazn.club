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
import fc from "fast-check";
import { readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, foldMatch } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { makeEnvelope } from "@seazn/engine/testkit";
import type { CameraPolicy } from "@/lib/camera-policy";
import type { BoardCall } from "@/server/external-play/types";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { CREATION_429_HOLD_MS, __resetCreationQueue, __setCreationQueueDeps } from "@/server/external-play/creation-queue";
import { addParticipant, endMeeting, ensureMeeting, removeParticipant } from "@/server/external-play/video/realtimekit";
import { closeGuardFault, openGuardFault } from "@/server/external-play/video/guard-faults";
import { GUARD_FAULT_FLAG_SECONDS, GUARD_FAULT_FLAG_STAMPS, MATCH_OFF_MIN_MS } from "@/server/external-play/video/match-camera-off";
import { RECOVER_BACKOFF_MS, RECOVER_MAX_ATTEMPTS } from "@/components/public-site/match-room/camera-session";
import { DEADLINE_AFTER_MS, MINT_CLAIM_STALE_MS, roomPhase, windowFor } from "@/server/external-play/window";
import { SHIP1_TIME_CONTROLS, isBoardApiPlayable, type TimeControl } from "@/server/external-play/time-controls";
import { getFixtureState } from "../fixtures";
import { stampFixtureCheckIn } from "../me";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { patchDivision } from "../divisions";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { joinAsArbiter, loadArbiterRound, type ArbiterVideo } from "../external-play/arbiter";
import { closeExternalPlayFlags } from "../external-play/flags";
import { createGameIfReady } from "../external-play/create-game";
import { isPlayableFixtureStatus } from "../external-play/preflight";
import { openRound } from "../external-play/open-round";
import { act } from "../external-play/play";
import { reconcile } from "../external-play/reconcile";
import { ensureBridgeRow, loadOnlinePlayFixture } from "../external-play/guard";
import { organiserOverrideVideo } from "../external-play/preflight";
import {
  ARBITER_PARTICIPANT_TTL_MS,
  CAMERA_EVIDENCE_AFTER_MS,
  CAMERA_EVIDENCE_GIVE_UP_MS,
  SWEEP_CADENCE_MS,
  SWEEP_MOVE_BUDGET,
  SWEEP_NO_TRUTH_HOLD_AFTER,
  NO_SHOW_REFUSALS_BEFORE_HOLD,
  expectedEndAt,
  playableWindow,
  sweepExternalPlay,
  type SweepDeps,
  type SweepReport,
} from "../external-play/sweep";
import { seedOnlineChessFixture, seedPlayer, type SeedOnlineChessFixtureResult } from "./_external-play-seed";

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
  type Script = (c: { gameId: string }) => Answer;
  const refused = (what: string): Answer => ({ status: 503, body: `no ${what} scripted` });
  const state = {
    calls: [] as { kind: "stream" | "export" | "other"; gameId: string }[],
    onStream: ((): Answer => refused("stream")) as Script,
    onExport: ((): Answer => refused("export")) as Script,
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
//
// Job 5 (C1) also needs a camera WORLD: the participants T8's seat adds (the
// seat's active session answers LIVE with every one of them present), and,
// after the match, the meeting's SESSIONS with their participant rows and
// peer events, and each peer's report — the measured shapes (adapter tests).
// `sessionsFail` answers GET /sessions with a 503 that many times.
type FakeSession = {
  id: string;
  meetingId: string;
  status: "LIVE" | "ENDED";
  started_at: string;
  ended_at: string | null;
  rows: { id: string; user_id: string; left_at: string | null; peer_events: { event_name: string; peer_id: string }[] }[];
};
const rtk = vi.hoisted(() => {
  const state = {
    calls: [] as { method: string; path: string }[],
    patchFails: 0,
    sessionsFail: 0,
    /** Answer the arbiter removal's DELETE with a 503 that many times. */
    removeFails: 0,
    participants: new Map<string, string[]>(),
    sessions: [] as FakeSession[],
    reports: new Map<string, () => unknown>(),
    reset() {
      state.calls = [];
      state.patchFails = 0;
      state.sessionsFail = 0;
      state.removeFails = 0;
      state.participants = new Map();
      state.sessions = [];
      state.reports = new Map();
    },
    async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const u = new URL(String(input));
      const path = u.pathname.replace(/^.*\/realtime\/kit\/[^/]+/, "");
      const method = init?.method ?? "GET";
      state.calls.push({ method, path });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const ok = (data: unknown) => json(200, { success: true, data });
      if (method === "POST" && path === "/meetings") {
        const id = `mtg-${crypto.randomUUID()}`;
        state.participants.set(id, []);
        return json(201, { success: true, data: { id } });
      }
      const added = /^\/meetings\/([^/]+)\/participants$/.exec(path);
      if (method === "POST" && added) {
        const id = `part-${crypto.randomUUID()}`;
        state.participants.get(decodeURIComponent(added[1]!))?.push(id);
        return json(201, { success: true, data: { id, token: `rtk-tok-${id}` } });
      }
      if (method === "POST" && /^\/meetings\/[^/]+\/participants\/[^/]+\/token$/.test(path)) {
        return ok({ token: `rtk-tok-${crypto.randomUUID()}` });
      }
      const active = /^\/meetings\/([^/]+)\/active-session$/.exec(path);
      if (method === "GET" && active) return ok({ id: `seat-${active[1]}`, status: "LIVE" });
      const seat = /^\/sessions\/seat-([^/]+)\/participants$/.exec(path);
      if (method === "GET" && seat) {
        const ids = state.participants.get(decodeURIComponent(seat[1]!)) ?? [];
        return ok({ participants: ids.map((id) => ({ id: `row-${id}`, user_id: id, left_at: null })) });
      }
      if (method === "GET" && path === "/sessions") {
        if (state.sessionsFail > 0) {
          state.sessionsFail--;
          return json(503, { success: false });
        }
        const m = u.searchParams.get("associated_id");
        const rows = state.sessions
          .filter((x) => x.meetingId === m)
          .map((x) => ({
            id: x.id, associated_id: x.meetingId, status: x.status, started_at: x.started_at,
            ...(x.ended_at === null ? {} : { ended_at: x.ended_at }),
          }));
        // The OpenAPI envelope: `paging.total_count` beside `data` (review M5).
        return json(200, { success: true, data: { sessions: rows }, paging: { total_count: rows.length, start_offset: 0, end_offset: rows.length } });
      }
      const report = /^\/sessions\/peer-report\/([^/]+)$/.exec(path);
      if (method === "GET" && report) {
        const r = state.reports.get(decodeURIComponent(report[1]!));
        if (!r) return json(404, { success: false, error: { code: 404, message: "No peer event exists" } });
        return ok(r());
      }
      const rows = /^\/sessions\/([^/]+)\/participants$/.exec(path);
      if (method === "GET" && rows) {
        const x = state.sessions.find((y) => y.id === decodeURIComponent(rows[1]!));
        if (!x) return json(404, { success: false, error: { code: 404, message: "no such session" } });
        return ok({ participants: x.rows });
      }
      // The arbiter's removal (I2): kick the one participant, then DELETE it.
      if (method === "POST" && path.endsWith("/active-session/kick")) {
        return ok({ action: "kick", kicked_participants_count: 1 });
      }
      const gone = /^\/meetings\/([^/]+)\/participants\/([^/]+)$/.exec(path);
      if (method === "DELETE" && gone) {
        if (state.removeFails > 0) {
          state.removeFails--;
          return json(503, { success: false });
        }
        const list = state.participants.get(decodeURIComponent(gone[1]!)) ?? [];
        const id = decodeURIComponent(gone[2]!);
        if (!list.includes(id)) return json(404, { success: false, error: { code: 404, message: "Participant not found" } });
        state.participants.set(decodeURIComponent(gone[1]!), list.filter((x) => x !== id));
        return ok({ id });
      }
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
/** Every board's division clock (5+3, a ship-1 control): the stored shape. */
const SEED_CLOCK = { base: 300, increment: 3 } as const;
type Board = SeedOnlineChessFixtureResult & {
  opened: Date;
  /** `min` minutes after the organiser opened the round. */
  at: (min: number) => Date;
};

/** A round-1 league board whose round the organiser opened a minute ago
 *  through T19's REAL action. The TIMETABLE says three hours from now, so a
 *  sweep that anchored on `scheduled_at` would see a different window. */
async function openedBoard(
  o: { checkedIn: readonly Side[]; kind?: string; openedMinutesAgo?: number; cameraPolicy?: CameraPolicy } = {
    checkedIn: [],
  },
): Promise<Board> {
  const opened = new Date(Date.now() - (o.openedMinutesAgo ?? 1) * 60_000);
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 3 * 60 * 60_000),
    linked: true,
    clock: SEED_CLOCK,
    ...(o.cameraPolicy ? { cameraPolicy: o.cameraPolicy } : {}),
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
  (
    await sql<{ payload: { by: string; reason: string } }[]>`
      select payload from score_events where fixture_id = ${fixtureId} and type = 'core.forfeit' order by seq`
  ).map((r) => r.payload);
/** The bridge row's status and hold reason; null when the board has none. */
const bridgeOf = async (fixtureId: string) => {
  const [r] = await sql<{ status: string; needs_reason: string | null }[]>`
    select status, needs_reason from fixture_external_play where fixture_id = ${fixtureId}`;
  return r ?? null;
};
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
      // C2's pair: one side present is the no-show path, never not_started.
      expect(report.heldForOrganiser, `${absent} absent: no hold`).toBe(0);
      expect((await bridgeOf(b.fixtureId))?.needs_reason ?? null, `${absent} absent`).not.toBe("not_started");
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

  it("BOTH present at the deadline with no game is NOT a no-show: it is HELD `not_started` for the organiser, once (C2)", async () => {
    // Controller ruling C2 (spec §3.2, §9's deadlineReason): a silent stuck
    // board blocks the next round, so it must reach the organiser's queue.
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const report = await sweep(b, { now: b.at(45) });
    expect(report.scanned, "the board was looked at").toBeGreaterThanOrEqual(1);
    expect(report.noShows).toBe(0);
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(report.reconciled, "no game on file: nothing for reconcile to read").toBe(0);
    expect(report.heldForOrganiser).toBe(1);
    expect(report.failures).toEqual([]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
    expect((await fixtureRow(b.fixtureId)).status, "the board is the organiser's, not settled").toBe("scheduled");
    // The second pass: the organiser's already — nothing re-held, nothing forfeited.
    const again = await sweep(b, { now: b.at(50) });
    expect(again.heldForOrganiser).toBe(0);
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
  });

  it("C2 at the edge: both present a millisecond BEFORE the deadline is nobody's yet; AT it, held", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const { deadline } = playableWindow(b.opened);
    const early = await sweep(b, { now: new Date(deadline.getTime() - 1) });
    expect(early.heldForOrganiser).toBe(0);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "pending", needs_reason: null });
    const at = await sweep(b, { now: deadline });
    expect(at.heldForOrganiser).toBe(1);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
  });

  it("C2 with NO bridge row (paired after the open): the row is minted, then held not_started", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await sql`delete from fixture_external_play where fixture_id = ${b.fixtureId}`;
    const report = await sweep(b, { now: b.at(45) });
    expect(report.failures).toEqual([]);
    expect(report.heldForOrganiser).toBe(1);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
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
      const before = (await bridgeOf(b.fixtureId))!.status;
      const report = await sweep(b, { now: b.at(240) });
      expect(forfeitsAttempted(b.fixtureId), make.name).toEqual([]);
      // C2's pair: a game on file is never not_started, however late.
      expect(report.heldForOrganiser, make.name).toBe(0);
      expect(await bridgeOf(b.fixtureId), make.name).toEqual({ status: before, needs_reason: null });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a possibly-sent create (T9's create_sent_at marker) is never ruled a no-show — past T+20 it is the organiser's (I3)", async () => {
    const b = await openedBoard({ checkedIn: [] });
    // Stands for T9's createAtDequeue: the marker it writes before the HTTP
    // call, whose outcome is unknown (T9 I2) — a game may exist.
    await sql`update fixture_external_play set create_sent_at = ${b.at(19)} where fixture_id = ${b.fixtureId}`;
    await sweep(b, { now: b.at(45) });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "create_outcome_unknown" });
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
// T13 fix round 1 — M3: a forfeit the engine keeps refusing reaches the
// organiser; a forfeit already in the ledger is never asked for again.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("M3 — a refused no-show reaches the organiser; a written one is never re-asked", () => {
  /** The same refusal at scoreEvent's door for this board (labelled: an
   *  engine refusal the sweep cannot know in advance). */
  const refuseWith = (b: Board, code: () => string) => {
    scoring.refuse = (id, input) => (id === b.fixtureId && input.type === "core.forfeit" ? new EngineError(code() as never, "injected") : null);
  };
  /** Passes 5 minutes apart from T+25. */
  const passes = async (b: Board, n: number, from = 0) => {
    const out: SweepReport[] = [];
    for (let i = 0; i < n; i++) out.push(await sweep(b, { now: b.at(25 + 5 * (from + i)) }));
    return out;
  };

  it("the SAME refusal three passes running holds the board for the organiser as the no-show it is — counted once; then nothing is asked", async () => {
    // The seed pairs home as White: only home came, so Black is the no-show.
    const b = await openedBoard({ checkedIn: ["home"] });
    refuseWith(b, () => "INVALID_EVENT");
    const [p1, p2, p3] = await passes(b, 3);
    expect([p1!.failures, p2!.failures], "the first two are failures, as before")
      .toEqual([[{ job: "no_show", fixtureId: b.fixtureId, code: "INVALID_EVENT" }], [{ job: "no_show", fixtureId: b.fixtureId, code: "INVALID_EVENT" }]]);
    expect([p1!.heldForOrganiser, p2!.heldForOrganiser]).toEqual([0, 0]);
    expect(p3!.failures, "the third is handled").toEqual([]);
    expect([p3!.heldForOrganiser, p3!.noShows]).toEqual([1, 0]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "no_show_black" });
    expect((await fixtureRow(b.fixtureId)).status, "the board stays open for the organiser").toBe("scheduled");
    const attempted = forfeitsAttempted(b.fixtureId).length;
    expect(attempted).toBe(3);
    const [p4] = await passes(b, 1, 3);
    expect([p4!.heldForOrganiser, p4!.noShows, p4!.failures]).toEqual([0, 0, []]);
    expect(forfeitsAttempted(b.fixtureId).length, "held: never asked again").toBe(attempted);
  });

  it("…both absent is no_show_both; and with Black on home (a pairing card) the colour is the RECORDED one", async () => {
    const both = await openedBoard({ checkedIn: [] });
    refuseWith(both, () => "INVALID_EVENT");
    await passes(both, 3);
    expect(await bridgeOf(both.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "no_show_both" });
    const b = await openedBoard({ checkedIn: ["home"] });
    const auth = await mintOrgOwnerAuth(b.orgId);
    const st = await getFixtureState(auth, b.fixtureId);
    await scoreEvent(auth, b.fixtureId, { expected_seq: st.last_seq, type: "boardgame.pairing", payload: { white: b.away.entrantId } });
    refuseWith(b, () => "INVALID_EVENT");
    await passes(b, 3);
    expect(await bridgeOf(b.fixtureId), "away is White and away stayed away").toEqual({ status: "needs_organiser", needs_reason: "no_show_white" });
  });

  it("a DIFFERENT refusal restarts the count: X, Y, X, X is not held; the fifth X is", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    const codes = ["INVALID_EVENT", "INVALID_PAYLOAD", "INVALID_EVENT", "INVALID_EVENT", "INVALID_EVENT"];
    let n = 0;
    refuseWith(b, () => codes[Math.min(n++, codes.length - 1)]!);
    const reports = await passes(b, 5);
    expect(reports.map((r) => r.heldForOrganiser)).toEqual([0, 0, 0, 0, 1]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "no_show_black" });
  });

  it("a double walkover with no next match is still held at ONCE as double_walkover_blocked — never counted as a refusal", async () => {
    const b = await openedBoard({ checkedIn: [], kind: "knockout" });
    refuseWith(b, () => "DOUBLE_WALKOVER_NO_NEXT_MATCH");
    const [p1] = await passes(b, 1);
    expect([p1!.heldForOrganiser, p1!.failures]).toEqual([1, []]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "double_walkover_blocked" });
  });

  it("a board whose ledger already holds the sweep's no-show is never asked again — a forfeit the organiser VOIDED stays voided", async () => {
    const b = await openedBoard({ checkedIn: ["home"] });
    const auth = await mintOrgOwnerAuth(b.orgId);
    // Stands for the sweep's own forfeit (its key), then the organiser's undo.
    // Today's engine refuses a forfeit before a start (WRONG_PHASE), so the
    // board is started first; W2b admits the sweep's at once.
    let seq = (await getFixtureState(auth, b.fixtureId)).last_seq;
    await scoreEvent(auth, b.fixtureId, { expected_seq: seq++, type: "core.start", payload: {} });
    await scoreEvent(auth, b.fixtureId, {
      expected_seq: seq++, type: "core.forfeit", payload: { by: b.away.entrantId, reason: "walkover" },
      idempotency_key: `extplay-noshow:${b.fixtureId}`,
    });
    const [forfeit] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${b.fixtureId} and idempotency_key = ${`extplay-noshow:${b.fixtureId}`}`;
    await scoreEvent(auth, b.fixtureId, { expected_seq: seq++, type: "core.void", payload: { event_id: forfeit!.id } });
    expect(isPlayableFixtureStatus((await fixtureRow(b.fixtureId)).status), "premise: the void reopened the board").toBe(true);
    scoring.calls = [];
    const [p1, p2] = await passes(b, 2);
    expect(forfeitsAttempted(b.fixtureId), "never asked again").toEqual([]);
    expect([p1!.noShows, p2!.noShows, p1!.failures, p2!.failures]).toEqual([0, 0, [], []]);
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1 — I3 and M1: a game that IS, or MAY BE, on file. One
// predicate for job 1 (never a no-show) and job 3 (keep the room): a game on
// file; a LIVE mint claim (T9 in flight — its create may land past T+20); or
// T9's sent marker while T9 can still recover it (before T+20). Past T+20 a
// sent marker under a stale claim is nobody's — T9 refuses before its claim —
// so the sweep holds it create_outcome_unknown, and its room comes down.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("I3 + M1 — a create that is, or may be, on file", () => {
  /** T9's REAL create at `min`, dying between its sent marker and its record
   *  (the Board API call throws: a deploy restart mid-call). */
  async function crashedCreate(b: Board, now: Date): Promise<void> {
    board.createChallengeToUser.mockRejectedValueOnce(new Error("the process died mid-call"));
    board.acceptChallenge.mockResolvedValueOnce({ ok: true });
    await createGameIfReady(b.fixtureId, { now, publish: async () => {} }).catch(() => null);
    board.acceptChallenge.mockReset();
    const [r] = await sql<{ status: string; challenge_id: string | null; create_sent_at: Date | null }[]>`
      select status, challenge_id, create_sent_at from fixture_external_play where fixture_id = ${b.fixtureId}`;
    expect([r!.status, r!.challenge_id, r!.create_sent_at !== null], "premise: T9's marker, no game recorded").toEqual(["pending", null, true]);
  }
  const roomEnded = async (fixtureId: string) =>
    (await sql<{ ended_at: Date | null }[]>`select ended_at from fixture_video_meetings where fixture_id = ${fixtureId}`)[0]!.ended_at !== null;

  it("a create SENT and never recorded, its claim stale past T+20: held create_outcome_unknown — never a no-show — and its room comes down; once", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await ensureMeeting(b.fixtureId, RTK);
    await crashedCreate(b, b.at(19));
    // The reviewer's probe P3: T9 itself cannot recover it past T+20.
    expect(await createGameIfReady(b.fixtureId, { now: b.at(21), publish: async () => {} }), "premise: T9 refuses past T+20")
      .toEqual({ created: false, reason: "not_ready" });
    const r = await sweep(b, { now: b.at(25), endMeeting: (id) => endMeeting(id, RTK) });
    expect(r.failures).toEqual([]);
    expect([r.heldForOrganiser, r.meetingsEnded, r.noShows]).toEqual([1, 1, 0]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "create_outcome_unknown" });
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(await roomEnded(b.fixtureId)).toBe(true);
    const again = await sweep(b, { now: b.at(45), endMeeting: (id) => endMeeting(id, RTK) });
    expect([again.heldForOrganiser, again.meetingsEnded, again.noShows, again.failures]).toEqual([0, 0, 0, []]);
  });

  it("BEFORE T+20 a sent marker under a stale claim is T9's to recover: nothing held, the room stays", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await ensureMeeting(b.fixtureId, RTK);
    await crashedCreate(b, b.at(15));
    const r = await sweep(b, { now: b.at(19), endMeeting: (id) => endMeeting(id, RTK) });
    expect([r.heldForOrganiser, r.meetingsEnded, r.noShows]).toEqual([0, 0, 0]);
    expect(await bridgeOf(b.fixtureId)).toMatchObject({ status: "pending" });
    expect(await roomEnded(b.fixtureId)).toBe(false);
  });

  it("M1 (probe P5): a claim taken a second before T+20, no marker yet — job 1 waits AND job 3 keeps the room; once stale, both rule", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await ensureMeeting(b.fixtureId, RTK);
    const { deadline } = playableWindow(b.opened);
    // Stands for T9's claim (taken before its marker), live at T+20.
    await sql`update fixture_external_play set mint_claimed_at = ${new Date(deadline.getTime() - 1_000)} where fixture_id = ${b.fixtureId}`;
    const at = await sweep(b, { now: deadline, endMeeting: (id) => endMeeting(id, RTK) });
    expect([at.heldForOrganiser, at.meetingsEnded, at.noShows], "in flight: nobody rules").toEqual([0, 0, 0]);
    expect(await roomEnded(b.fixtureId)).toBe(false);
    // The claim goes stale with nothing sent: both came, no game — not_started (C2).
    const stale = await sweep(b, { now: new Date(deadline.getTime() + MINT_CLAIM_STALE_MS), endMeeting: (id) => endMeeting(id, RTK) });
    expect([stale.heldForOrganiser, stale.meetingsEnded]).toEqual([1, 1]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
  });

  it("…and a sent marker under a LIVE claim past T+20 (T9 still in flight) is not held until the claim goes stale", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await ensureMeeting(b.fixtureId, RTK);
    const { deadline } = playableWindow(b.opened);
    // Stands for T9 mid-call: its marker and its renewed claim, a second before T+20.
    const sent = new Date(deadline.getTime() - 1_000);
    await sql`update fixture_external_play set create_sent_at = ${sent}, mint_claimed_at = ${sent} where fixture_id = ${b.fixtureId}`;
    const live = await sweep(b, { now: new Date(deadline.getTime() + 10_000), endMeeting: (id) => endMeeting(id, RTK) });
    expect([live.heldForOrganiser, live.meetingsEnded, live.noShows]).toEqual([0, 0, 0]);
    // T9's own staleness: a claim is stale once OLDER than MINT_CLAIM_STALE_MS.
    const edge = await sweep(b, { now: new Date(sent.getTime() + MINT_CLAIM_STALE_MS), endMeeting: (id) => endMeeting(id, RTK) });
    expect([edge.heldForOrganiser, edge.meetingsEnded], "exactly the stale age: still live").toEqual([0, 0]);
    const stale = await sweep(b, { now: new Date(sent.getTime() + MINT_CLAIM_STALE_MS + 1), endMeeting: (id) => endMeeting(id, RTK) });
    expect([stale.heldForOrganiser, stale.meetingsEnded, stale.noShows]).toEqual([1, 1, 0]);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "create_outcome_unknown" });
  });

  it("a T9 write landing between the sweep's read and its hold wins — a READY game, or a 429 that proved nothing exists, is never held create_outcome_unknown (staged on the bridge row's lock) — x3 each", async () => {
    // T9's two writes that can still land on a stale claim's row
    // (create-game.ts): its record, and a release after Lichess's 429.
    const WRITES = {
      record: (gameId: string, b: Board) => sql`set status = 'ready', challenge_id = ${gameId}, white_side = 'home',
                   white_lichess_id = ${b.home.lichessId}, black_lichess_id = ${b.away.lichessId},
                   mint_claimed_at = null, create_sent_at = null`,
      released_429: () => sql`set mint_claimed_at = null, create_sent_at = null, last_error = 'create:rate_limited: 429'`,
    } as const;
    const AFTER = { record: { status: "ready", needs_reason: null }, released_429: { status: "pending", needs_reason: null } } as const;
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      const write = i % 2 === 0 ? "record" : "released_429";
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      const { deadline } = playableWindow(b.opened);
      // Stands for a slow T9: marker sent, claim gone stale, its record late.
      const sent = new Date(deadline.getTime() - 60_000);
      await sql`update fixture_external_play set create_sent_at = ${sent}, mint_claimed_at = ${sent} where fixture_id = ${b.fixtureId}`;
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let signalHeld!: (pid: number) => void;
      const held = new Promise<number>((resolve) => (signalHeld = resolve));
      const gameId = `gm-${randomUUID().slice(0, 12)}`;
      const holder = sql.begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`select fixture_id from fixture_external_play where fixture_id = ${b.fixtureId} for update`;
        signalHeld(pid);
        await released;
        await tx`update fixture_external_play ${WRITES[write](gameId, b)} where fixture_id = ${b.fixtureId}`;
      });
      const holderPid = await held;
      const pass = sweep(b, { now: new Date(deadline.getTime() + 5 * 60_000) });
      const until = Date.now() + 30_000;
      for (;;) {
        const [{ n }] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))`;
        if (n >= 1) break;
        if (Date.now() > until) throw new Error("premise: the sweep's hold never waited on the row");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await holder;
      const r = await pass;
      expect(r.failures, `${write} run ${i}`).toEqual([]);
      expect(r.heldForOrganiser, `${write} run ${i}: nothing held`).toBe(0);
      expect(await bridgeOf(b.fixtureId), `${write} run ${i}: T9's write stands`).toEqual(AFTER[write]);
      checked++;
    }
    expect(checked).toBe(6);
  }, 180_000);
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

  it("C2: a create Lichess throttled until past the deadline — both present, no game — goes to the organiser as not_started", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await throttled(b, 19);
    const { tried, createGame } = recordingCreate();
    const report = await sweep(b, { now: b.at(45), createGameIfReady: createGame });
    expect(tried, "past T+20: not retried").toEqual([]);
    expect(report.heldForOrganiser).toBe(1);
    expect(await bridgeOf(b.fixtureId)).toEqual({ status: "needs_organiser", needs_reason: "not_started" });
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
function gameFull(
  b: Board, gameId: string, base: GameFullJson,
  over: { moves?: readonly string[]; status?: string; winner?: "white" | "black" } = {},
): string {
  const j = JSON.parse(JSON.stringify(base)) as GameFullJson;
  j.id = gameId;
  j.white.id = j.white.name = b.home.lichessId; // the seed pairs home as White
  j.black.id = j.black.name = b.away.lichessId;
  if (over.moves !== undefined) j.state.moves = over.moves.join(" ");
  if (over.status !== undefined) {
    j.state.status = over.status;
    delete j.state.winner;
    if (over.winner !== undefined) j.state.winner = over.winner;
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

  it("a possibly-sent create (T9's create_sent_at) is a game that may exist while T9 can recover it: its meeting stays", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await meetingFor(b);
    // Stands for T9's createAtDequeue marker before its HTTP call (T9 I2).
    await sql`update fixture_external_play set create_sent_at = ${b.at(15)} where fixture_id = ${b.fixtureId}`;
    const { ended, end } = recordingEnd();
    await sweep(b, { now: b.at(19), endMeeting: end });
    expect(ended, "before T+20 T9's next caller recovers it").toEqual([]);
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

// ---------------------------------------------------------------------------
// Job 4 — the reconcile sweep (the abandoned-board sweep, spec §3.5 / §4).
// ---------------------------------------------------------------------------

/** M13's increment multiplier, RECOVERED from the playability predicate by
 *  probing it — never copied out of time-controls.ts. The predicate is
 *  `limit + B × increment >= FLOOR`: the smallest limit it accepts at +0 is
 *  the floor, at +1 it is floor − B. */
function recoveredMoveBudget(): number {
  const smallestAccepted = (increment: number): number => {
    for (let limit = 0; limit <= 3600; limit++) {
      if (isBoardApiPlayable({ key: "probe", limitSeconds: limit, incrementSeconds: increment })) return limit;
    }
    throw new Error(`isBoardApiPlayable accepts no control under an hour at +${increment}`);
  };
  const floor = smallestAccepted(0);
  expect(floor, "a real floor, not zero").toBeGreaterThan(0);
  return floor - smallestAccepted(1);
}

describe("expectedEndAt — the budget moves with the time control", () => {
  it("SWEEP_MOVE_BUDGET is the multiplier isBoardApiPlayable itself uses, recovered by probing it", () => {
    const recovered = recoveredMoveBudget();
    expect(recovered, "the increment multiplier the predicate uses").toBeGreaterThan(0);
    expect(SWEEP_MOVE_BUDGET).toBe(recovered);
  });

  it("allows BOTH clocks to run out: never before 2 × the limit — every ship-1 control", () => {
    let checked = 0;
    const t0 = new Date("2026-10-09T10:00:00.000Z");
    for (const tc of SHIP1_TIME_CONTROLS) {
      const span = expectedEndAt(t0, tc).getTime() - t0.getTime();
      expect(span, tc.key).toBeGreaterThanOrEqual(2 * tc.limitSeconds * 1000);
      // Both players' full budget: the limit plus B moves of increment, each.
      expect(span, `${tc.key}: 2 × (limit + B × increment)`).toBe(
        2 * (tc.limitSeconds + recoveredMoveBudget() * tc.incrementSeconds) * 1000,
      );
      checked++;
    }
    expect(checked, "ship-1 time controls checked").toBe(SHIP1_TIME_CONTROLS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an increment lengthens the budget, and a slower control outlasts a faster one", () => {
    const t0 = new Date("2026-10-09T10:00:00.000Z");
    const by = (key: string): TimeControl => {
      const tc = SHIP1_TIME_CONTROLS.find((c) => c.key === key);
      if (!tc) throw new Error(`ship-1 list has no ${key}`);
      return tc;
    };
    expect(expectedEndAt(t0, by("3+2")).getTime(), "the increment must count").toBeGreaterThan(expectedEndAt(t0, by("3+0")).getTime());
    expect(expectedEndAt(t0, by("15+10")).getTime()).toBeGreaterThan(expectedEndAt(t0, by("10+5")).getTime());
    expect(expectedEndAt(t0, by("5+0")).getTime()).toBeGreaterThan(expectedEndAt(t0, by("3+0")).getTime());
  });

  it("the cadence is the spec's 5-minute cron (§4), and a board is held after a SMALL number of empty reads", () => {
    expect(SWEEP_CADENCE_MS).toBe(5 * 60_000);
    expect(SWEEP_NO_TRUTH_HOLD_AFTER).toBeGreaterThanOrEqual(2);
    expect(SWEEP_NO_TRUTH_HOLD_AFTER).toBeLessThanOrEqual(5);
  });
});

describe.runIf(HAS_DB)("job 4 — reconcile the boards nobody is watching", () => {
  type BridgeFacts = {
    status: string;
    needs_reason: string | null;
    last_error: string | null;
    challenge_id: string | null;
    move_count: number;
    sweep_no_truth_reads: number;
    last_polled_at: Date | null;
  };
  const bridge = async (b: Board): Promise<BridgeFacts> => {
    const [r] = await sql<BridgeFacts[]>`
      select status, needs_reason, last_error, challenge_id, move_count, sweep_no_truth_reads, last_polled_at
        from fixture_external_play where fixture_id = ${b.fixtureId}`;
    return r!;
  };
  /** Lichess requests made for this game (stream reads and exports). */
  const readsOf = (gameId: string) => lichess.calls.filter((c) => c.gameId === gameId).length;
  const flagsOf = async (b: Board) =>
    sql<{ note: string | null }[]>`select note from fixture_play_flags where fixture_id = ${b.fixtureId} and kind = 'out_of_band_play' order by opened_at`;
  /** When the game can be over at the latest: both clocks run out with B
   *  moves of increment each — from the RULEBOOK (the seed's clock and the
   *  recovered multiplier), never from expectedEndAt. */
  const endOf = (startedAt: Date) =>
    new Date(startedAt.getTime() + 2 * (SEED_CLOCK.base + recoveredMoveBudget() * SEED_CLOCK.increment) * 1000);

  it("a LIVE game is read at every tick while it runs: the moves made at Lichess are adopted and flagged MID-game", async () => {
    // Addendum (T11): the sweep is the main detector of out-of-band play —
    // the cadence must make that real, so nothing waits for an expected end.
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b); // e2e4 through T10 at minute 6
    expect(endOf(b.at(6)).getTime(), "premise: both ticks are before the game could have ended").toBeGreaterThan(b.at(13).getTime());
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5"] }));
    const first = await sweep(b, { now: b.at(8) });
    expect(first.reconciled).toBe(1);
    expect((await bridge(b)).move_count).toBe(2);
    expect(await flagsOf(b), "Black's reply was made at Lichess, not here").toHaveLength(1);
    // The next tick reads again.
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5", "g1f3"] }));
    const second = await sweep(b, { now: new Date(b.at(8).getTime() + SWEEP_CADENCE_MS) });
    expect(second.reconciled).toBe(1);
    expect((await bridge(b)).move_count).toBe(3);
    expect(await flagsOf(b)).toHaveLength(2);
  });

  it("a pass that OVERLAPS the last one (under half a tick later) does not read the board again", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4"] }));
    expect((await sweep(b, { now: b.at(8) })).reconciled).toBe(1);
    const reads = readsOf(gameId);
    const overlap = await sweep(b, { now: new Date(b.at(8).getTime() + SWEEP_CADENCE_MS / 2 - 1) });
    expect(overlap.reconciled).toBe(0);
    expect(readsOf(gameId)).toBe(reads);
    expect((await sweep(b, { now: new Date(b.at(8).getTime() + SWEEP_CADENCE_MS / 2) })).reconciled, "half a tick on: due").toBe(1);
  });

  it("a READY game Lichess aborted at ply 0 is reconciled FIRST: an `aborted` hold, never a no-show", async () => {
    // T10 ruling: a game resigned or aborted at ply 0 stays 'ready' on our
    // side until reconcile — and an aborted game is not a no-show.
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await readyGame(b);
    serveStream(gameFull(b, gameId, MID, { moves: [], status: "aborted" }));
    const r = await sweep(b, { now: b.at(45) });
    expect(r.reconciled).toBe(1);
    expect(r.noShows).toBe(0);
    expect(forfeitsAttempted(b.fixtureId)).toEqual([]);
    expect(await bridge(b)).toMatchObject({ status: "needs_organiser", needs_reason: "aborted" });
    expect(r.heldForOrganiser, "the hold this pass placed").toBe(1);
  });

  it("a FINISHED game is never read again — and its meeting comes down in the SAME pass that finished it", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const { meetingId } = await ensureMeeting(b.fixtureId, RTK);
    const gameId = await liveGame(b);
    serveStream(gameFull(b, gameId, ENDED));
    const ended: string[] = [];
    const end: NonNullable<SweepDeps["endMeeting"]> = async (m) => {
      ended.push(m);
      await endMeeting(m, RTK);
    };
    const first = await sweep(b, { now: b.at(10), endMeeting: end });
    expect(first.reconciled).toBe(1);
    expect((await bridge(b)).status).toBe("finished");
    expect(first.meetingsEnded, "job 3 runs after job 4").toBe(1);
    expect(ended).toEqual([meetingId]);
    const reads = readsOf(gameId);
    const later = await sweep(b, { now: b.at(40), endMeeting: end });
    expect(later.reconciled).toBe(0);
    expect(readsOf(gameId)).toBe(reads);
  });

  it("a board WITHDRAWN mid-game: the sweep's reconcile closes its bridge with no Lichess read", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(b.orgId), b.away.entrantId);
    const r = await sweep(b, { now: b.at(10) });
    expect(r.reconciled).toBe(1);
    expect((await bridge(b)).status).toBe("finished");
    expect(readsOf(gameId)).toBe(0);
  });

  it("M3: a hold T9 placed when the ACCEPT failed is never read; a hold placed MID-game is", async () => {
    // T11 review M3: T9 holds token_revoked / provider_error at create time
    // with the challenge recorded — the two mid-game reasons reconcile reads.
    // Read every tick, an unaccepted challenge would be re-read forever.
    let checked = 0;
    for (const code of ["unauthorized", "unavailable"] as const) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      const gameId = `gm-${randomUUID().slice(0, 12)}`;
      board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: gameId });
      board.acceptChallenge.mockResolvedValueOnce({ ok: false, code, raw: `accept refused (${code})` });
      expect(await createGameIfReady(b.fixtureId, { now: b.at(5), publish: async () => {} })).toMatchObject({ created: false });
      const row = await bridge(b);
      expect(row, `premise: T9 held it with the challenge (${code})`).toMatchObject({ status: "needs_organiser", challenge_id: gameId });
      expect(row.needs_reason, `premise: a reason reconcile reads mid-game (${code})`).toMatch(/^(token_revoked|provider_error)$/);
      expect(row.last_error).toMatch(/^accept:/);
      const r = await sweep(b, { now: b.at(10) });
      expect(r.reconciled, code).toBe(0);
      expect(readsOf(gameId), code).toBe(0);
      checked++;
    }
    expect(checked, "T9 accept-failure holds checked").toBe(2);

    // The pair: a line that does not extend ours, held provider_error by
    // T11 MID-game, IS read on the next tick.
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    serveStream(gameFull(b, gameId, MID, { moves: ["d2d4"] }));
    await sweep(b, { now: b.at(8) });
    expect(await bridge(b), "premise: T11 held it mid-game").toMatchObject({ status: "needs_organiser", needs_reason: "provider_error" });
    const reads = readsOf(gameId);
    const r = await sweep(b, { now: new Date(b.at(8).getTime() + SWEEP_CADENCE_MS) });
    expect(r.reconciled).toBe(1);
    expect(readsOf(gameId)).toBeGreaterThan(reads);
  });

  it(`M4: past the expected end, ${SWEEP_NO_TRUTH_HOLD_AFTER} consecutive reads that tell nothing — backing off between them — hold provider_error`, async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b); // started at minute 6
    const end = endOf(b.at(6));
    // Lichess answers nothing (the fake's default: every stream and export 503).
    // BEFORE the end, every tick reads, and an empty read is not counted.
    let t = b.at(8);
    let before = 0;
    while (t.getTime() < end.getTime()) {
      expect((await sweep(b, { now: t })).reconciled, `tick ${t.toISOString()}`).toBe(1);
      expect((await bridge(b)).sweep_no_truth_reads).toBe(0);
      before++;
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(before, "ticks before the expected end").toBeGreaterThan(0);
    // Past it: read, count, and back off — doubling from one tick.
    let held = 0;
    let readsCounted = 0;
    let skipped = 0;
    for (let tick = 0; tick < 40 && held === 0; tick++) {
      const r = await sweep(b, { now: t });
      const row = await bridge(b);
      if (r.reconciled === 1) {
        readsCounted++;
        expect(row.sweep_no_truth_reads, `read ${readsCounted}`).toBe(readsCounted);
        held = r.heldForOrganiser;
      } else {
        skipped++;
      }
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(readsCounted, "consecutive empty reads before the hold").toBe(SWEEP_NO_TRUTH_HOLD_AFTER);
    expect(held, "the pass that held it says so").toBe(1);
    expect(skipped, "the back-off skipped at least one tick").toBeGreaterThan(0);
    const row = await bridge(b);
    expect(row).toMatchObject({ status: "needs_organiser", needs_reason: "provider_error" });
    expect(row.last_error).toContain(gameId);
    expect(forfeitsAttempted(b.fixtureId), "never a no-show").toEqual([]);
  });

  it("M4: an empty read AT the expected end is not past it; the next one is", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await liveGame(b);
    const end = endOf(b.at(6));
    expect((await sweep(b, { now: end })).reconciled).toBe(1);
    expect((await bridge(b)).sweep_no_truth_reads, "at the end: not counted").toBe(0);
    expect((await sweep(b, { now: new Date(end.getTime() + SWEEP_CADENCE_MS) })).reconciled).toBe(1);
    expect((await bridge(b)).sweep_no_truth_reads).toBe(1);
  });

  it("M4: a read that brings the truth resets the count — the board is not held on stale empties", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    let t = new Date(endOf(b.at(6)).getTime() + 60_000);
    expect((await sweep(b, { now: t })).reconciled).toBe(1);
    expect((await bridge(b)).sweep_no_truth_reads).toBe(1);
    // Lichess answers: the game still runs (a long think).
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4"] }));
    t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    expect((await sweep(b, { now: t })).reconciled).toBe(1);
    expect((await bridge(b)).sweep_no_truth_reads, "truth resets it").toBe(0);
    lichess.reset();
    t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    expect((await sweep(b, { now: t })).reconciled).toBe(1);
    expect(await bridge(b)).toMatchObject({ status: "live", sweep_no_truth_reads: 1 });
  });

  it("M4: a board the sweep held is still read — backed off — and the game's result settles it when Lichess answers", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    let t = new Date(endOf(b.at(6)).getTime() + 60_000);
    for (let i = 0; i < 40 && (await bridge(b)).status !== "needs_organiser"; i++) {
      await sweep(b, { now: t });
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(await bridge(b), "premise: held by the sweep").toMatchObject({ needs_reason: "provider_error" });
    // Empty reads go on being counted on the held row — and it is not held
    // again: once is the organiser's queue.
    let heldAgain = 0;
    let readsAfter = 0;
    for (let i = 0; i < 12; i++) {
      const r = await sweep(b, { now: t });
      heldAgain += r.heldForOrganiser;
      readsAfter += r.reconciled;
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(readsAfter, "still read, backed off: fewer reads than ticks").toBeGreaterThan(0);
    expect(readsAfter).toBeLessThan(12);
    expect(heldAgain).toBe(0);
    expect((await bridge(b)).sweep_no_truth_reads).toBe(SWEEP_NO_TRUTH_HOLD_AFTER + readsAfter);
    serveStream(gameFull(b, gameId, ENDED));
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) {
      await sweep(b, { now: t });
      settled = (await fixtureRow(b.fixtureId)).outcome !== null;
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(settled, "Lichess's result was written").toBe(true);
    const reads = readsOf(gameId);
    const later = await sweep(b, { now: new Date(t.getTime() + 24 * 60 * 60_000) });
    expect(readsOf(gameId), "a settled fixture's held row is the organiser's: never read again").toBe(reads);
    expect(later.reconciled, "…nor handed to reconcile at all").toBe(0);
  });

  it("C3: a board T11 held MID-game is read on the SAME back-off as empty reads — never every tick — even while Lichess answers; its result still settles it", async () => {
    // Controller ruling C3 (2026-10-11): a held row is not re-read every tick.
    // The rulebook: one tick after the last read, doubling per read that left
    // the hold standing, capped at an hour; half a tick of cron jitter.
    const reReadAfterMin = (n: number) => Math.min(5 * 2 ** Math.max(0, n - 1), 60);
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    // A line that does not extend ours: T11 holds provider_error, mid-game
    // (long before any expected end), and Lichess goes on answering it.
    serveStream(gameFull(b, gameId, MID, { moves: ["d2d4"] }));
    await sweep(b, { now: b.at(8) });
    expect(await bridge(b), "premise: T11 held it mid-game").toMatchObject({ status: "needs_organiser", needs_reason: "provider_error" });
    expect(b.at(8).getTime(), "premise: before the expected end").toBeLessThan(endOf(b.at(6)).getTime());
    let lastRead = 8;
    let n = 0;
    const got: number[] = [];
    const want: number[] = [];
    let checked = 0;
    for (let minute = 13; minute <= 8 + 120; minute += 5) {
      const due = minute - lastRead >= reReadAfterMin(n) - 2.5;
      want.push(due ? 1 : 0);
      if (due) {
        lastRead = minute;
        n++;
      }
      const r = await sweep(b, { now: b.at(minute) });
      got.push(r.reconciled);
      expect(r.heldForOrganiser, `minute ${minute}: never held again`).toBe(0);
      checked++;
    }
    expect(checked, "ticks checked").toBe(24);
    expect(got, "reads per tick: backed off like empty reads").toEqual(want);
    expect(want.filter((x) => x === 0).length, "the schedule skips ticks (anti-vacuity)").toBeGreaterThan(10);
    expect(await bridge(b)).toMatchObject({ status: "needs_organiser", needs_reason: "provider_error", sweep_no_truth_reads: n });
    // The game's end still settles it, at the next due read.
    serveStream(gameFull(b, gameId, ENDED));
    let t = b.at(8 + 120);
    let settled = false;
    for (let i = 0; i < 30 && !settled; i++) {
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
      await sweep(b, { now: t });
      settled = (await fixtureRow(b.fixtureId)).outcome !== null;
    }
    expect(settled, "Lichess's result was written").toBe(true);
  });

  it("two passes at the SAME instant read a board ONCE (staged on the bridge row's lock)", async () => {
    // Both passes read the candidates before either claims; the claim is a
    // compare-and-set on last_polled_at, so the second finds it moved.
    let checked = 0;
    for (let run = 0; run < 3; run++) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      await liveGame(b);
      const seen: string[] = [];
      const deps: SweepDeps = {
        now: b.at(8),
        reconcile: async (a) => {
          seen.push(a.fixtureId);
          return null;
        },
        // The pass lock (M8) would skip the second pass outright: off, so
        // the row claim is proven on its own.
        serialise: false,
      };
      let runs: Promise<SweepReport>[] = [];
      await sql.begin(async (tx) => {
        await tx`select 1 from fixture_external_play where fixture_id = ${b.fixtureId} for update`;
        runs = [sweep(b, deps), sweep(b, deps)];
        for (let i = 0; i < 200; i++) {
          const [w] = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock' and query ilike '%set last_polled_at%'`;
          if (w!.n >= 2) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%set last_polled_at%'`;
        expect(w!.n, `run ${run}: both claims are waiting on the row`).toBe(2);
      });
      const reports = await Promise.all(runs);
      expect(reports.map((r) => r.reconciled).sort(), `run ${run}`).toEqual([0, 1]);
      expect(seen).toEqual([b.fixtureId]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an IMPOSSIBLE row — live with no started_at — is still read, but never counted toward a hold (guard reached)", async () => {
    // T10 stamps started_at with the first move and T11 with an adopted one,
    // so production cannot write this. The sweep must not guess an end for it.
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await liveGame(b);
    await sql`update fixture_external_play set started_at = null where fixture_id = ${b.fixtureId}`; // the impossible state, by hand
    let t = b.at(240);
    for (let i = 0; i < 4; i++) {
      expect((await sweep(b, { now: t })).reconciled).toBe(1);
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(await bridge(b)).toMatchObject({ status: "live", sweep_no_truth_reads: 0 });
  });

  it("a READY game (never started) has its end measured from the round's deadline: held after the empties too", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await readyGame(b);
    const end = endOf(playableWindow(b.opened).deadline);
    expect((await sweep(b, { now: new Date(end.getTime() - 60_000) })).reconciled).toBe(1);
    expect((await bridge(b)).sweep_no_truth_reads, "before the end: not counted").toBe(0);
    let t = new Date(end.getTime() + 60_000);
    for (let i = 0; i < 40 && (await bridge(b)).status === "ready"; i++) {
      await sweep(b, { now: t });
      t = new Date(t.getTime() + SWEEP_CADENCE_MS);
    }
    expect(await bridge(b)).toMatchObject({ status: "needs_organiser", needs_reason: "provider_error", sweep_no_truth_reads: SWEEP_NO_TRUTH_HOLD_AFTER });
  });

  it("a reconcile that THROWS is a failure by code, counts as an empty read past the end, and never aborts the pass", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await liveGame(b);
    const other = await openedBoard({ checkedIn: ["home"] });
    const t = new Date(endOf(b.at(6)).getTime() + 60_000);
    const r = await sweep([b, other], {
      now: t,
      reconcile: async () => {
        throw Object.assign(new Error("token store unavailable"), { code: "LICHESS_TOKEN_UNAVAILABLE" });
      },
    });
    expect(r.failures).toContainEqual({ job: "reconcile", fixtureId: b.fixtureId, code: "LICHESS_TOKEN_UNAVAILABLE" });
    expect((await bridge(b)).sweep_no_truth_reads).toBe(1);
    expect(forfeitsAttempted(other.fixtureId), "the rest of the pass ran").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The sequence property (TEST-STRATEGY rules 1 and 10): every job, with the
// producers that change a board under it — check-ins, T9's create (and its
// 429), T10's first move, what Lichess answers, a withdrawal — interleaved
// with passes at random intervals. The MODEL is written from the rulebook
// (spec §3.2/§3.5/§3.6, the M3/M4 rulings, window.ts's and the cron's
// periods) and owns the state; every pass is checked against it: what the
// pass did (reads, retries, forfeits, holds, failures) and the row it left.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// T13 fix round 1 — M8: one pass at a time. A pass that finds another
// running does nothing and says it skipped.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("M8 — one pass at a time", () => {
  it("a pass while another runs is SKIPPED — nothing scanned, nothing asked — and says so; once the first ends, the next runs", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await liveGame(b);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let signalInside!: () => void;
    const inside = new Promise<void>((resolve) => (signalInside = resolve));
    let reads = 0;
    // The first pass parks inside its read of the board.
    const first = sweep(b, {
      now: b.at(8),
      reconcile: async () => {
        reads++;
        signalInside();
        await released;
        return null;
      },
    });
    await inside;
    const second = await sweep(b, { now: b.at(8), reconcile: async () => { reads++; return null; } });
    expect(second).toEqual({
      skipped: true, noShows: 0, mintRetries: 0, meetingsEnded: 0, reconciled: 0, heldForOrganiser: 0,
      cameraSettled: 0, cameraFlags: 0, connectionFlags: 0, arbitersRemoved: 0, scanned: 0, failures: [],
    });
    release();
    const done = await first;
    expect([done.skipped, done.reconciled, reads]).toEqual([false, 1, 1]);
    const third = await sweep(b, { now: b.at(14), reconcile: async () => { reads++; return null; } });
    expect([third.skipped, third.reconciled, reads], "the lock went with the first pass").toEqual([false, 1, 2]);
  });

  it("a pass that THROWS lets go of the lock: the next pass runs", async () => {
    const b = await openedBoard({ checkedIn: [] });
    // An org scope Postgres cannot read fails a candidate query, outside any
    // job's own catch: the pass itself throws.
    await expect(sweepExternalPlay({ now: b.at(5), orgIds: ["not-a-uuid"] })).rejects.toThrow();
    const next = await sweep(b, { now: b.at(5) });
    expect(next.skipped).toBe(false);
    expect(next.scanned, "premise: the next pass looked at the board").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1 — M7: a failure inside a job is diagnosable from the server
// log; the returned report stays code-only.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("M7 — a job's failure is logged with its message; the report carries the code only", () => {
  it("a generic Error logs its message AND stack; a named refusal its message; the report holds the code alone (counted)", async () => {
    const warns = vi.spyOn(log, "warn");
    try {
      let checked = 0;
      for (const [err, code, stack] of [
        [new TypeError("cannot read properties of undefined (reading 'moves')"), "TypeError", true],
        [new HttpError(503, "lichess key unavailable", "TOKEN_KEY_UNAVAILABLE"), "TOKEN_KEY_UNAVAILABLE", false],
      ] as const) {
        const b = await openedBoard({ checkedIn: ["home", "away"] });
        await liveGame(b);
        warns.mockClear();
        const r = await sweep(b, { now: b.at(8), reconcile: async () => { throw err; } });
        expect(r.failures, code).toEqual([{ job: "reconcile", fixtureId: b.fixtureId, code }]);
        const logged = warns.mock.calls
          .map(([o]) => o as Record<string, unknown>)
          .filter((o) => o?.fixtureId === b.fixtureId && o?.job === "reconcile");
        expect(logged, code).toHaveLength(1);
        expect(logged[0], code).toMatchObject({ code, message: err.message });
        if (stack) expect(String(logged[0]!.stack), `${code}: stack`).toContain("TypeError: cannot read properties");
        else expect(logged[0]!.stack, `${code}: a named refusal needs no stack`).toBeUndefined();
        checked++;
      }
      expect(checked).toBe(2);
    } finally {
      warns.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1 — M6: `heldForOrganiser` counts every hold a read placed,
// whoever placed it inside the read, and nothing twice.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("M6 — the report counts the holds a sweep read placed", () => {
  it("reconcile's OWN token_revoked hold (both tokens refused) is counted", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    await liveGame(b);
    lichess.onStream = () => ({ status: 401, body: "Unauthorized" });
    const r = await sweep(b, { now: b.at(8) });
    expect(r.reconciled).toBe(1);
    expect(await bridgeOf(b.fixtureId), "premise: reconcile held it itself").toEqual({ status: "needs_organiser", needs_reason: "token_revoked" });
    expect(r.heldForOrganiser).toBe(1);
  });

  it("a terminal hold REPLACING a mid-game one on a held row is counted — and a re-read that changes nothing is not", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"], kind: "knockout" });
    const gameId = await liveGame(b);
    // T10: Black's token refused mid-game — the board is held token_revoked.
    expect(await act(
      { fixtureId: b.fixtureId, personId: b.away.personId, action: { kind: "move", uci: "e7e5" } },
      { now: b.at(7), accessToken: async (u) => `tok-${u}`, publish: async () => {}, reconcile: async () => null,
        submitMove: async () => ({ ok: false, code: "unauthorized", raw: "401 Unauthorized" }) },
    )).toMatchObject({ ok: false });
    expect(await bridgeOf(b.fixtureId), "premise: held mid-game").toEqual({ status: "needs_organiser", needs_reason: "token_revoked" });
    // Still running at Lichess: the held row is read, nothing changes.
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4"], status: "started" }));
    const quiet = await sweep(b, { now: b.at(8) });
    expect([quiet.reconciled, quiet.heldForOrganiser], "a re-read that moved nothing").toEqual([1, 0]);
    // A knockout draw: the tie-break is owed — the snapshot's hold replaces the mid-game one.
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5"], status: "draw" }));
    const ended = await sweep(b, { now: b.at(8 + SWEEP_CADENCE_MS / 60_000) });
    expect(ended.reconciled).toBe(1);
    expect(await bridgeOf(b.fixtureId), "premise: replaced").toEqual({ status: "needs_organiser", needs_reason: "tiebreak_owed" });
    expect(ended.heldForOrganiser).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T13 fix round 1, ruling I4 — the reviewer's probe P1, staged: the 5-minute
// sweep reads a live game between Lichess's 200 for a Seazn move and T10's
// append. T10 put the move on file before sending it, so the sweep adopts it
// as ours: no out-of-band flag, and T10's append absorbs.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("I4 — a sweep landing between Lichess's 200 and T10's append (probe P1)", () => {
  const outOfBand = async (b: Board) =>
    sql<{ note: string | null }[]>`select note from fixture_play_flags where fixture_id = ${b.fixtureId} and kind = 'out_of_band_play' order by opened_at`;
  const ledgerOf = async (b: Board) =>
    (await sql<{ moves_uci: string[]; pending_move_ply: number | null }[]>`
      select moves_uci, pending_move_ply from fixture_external_play where fixture_id = ${b.fixtureId}`)[0]!;
  /** Black's REAL T10 move at minute 8; `atLichess` runs where Lichess holds
   *  the move and its answer is on the way back. */
  const blackPlays = (b: Board, uci: string, answer: BoardCall, atLichess: () => Promise<void>) =>
    act(
      { fixtureId: b.fixtureId, personId: b.away.personId, action: { kind: "move", uci } },
      {
        now: b.at(8), accessToken: async (u) => `tok-${u}`, publish: async () => {}, reconcile: async () => null,
        submitMove: async () => { await atLichess(); return answer; },
      },
    );

  it("our move is adopted with NO flag and T10's append absorbs — x3", async () => {
    let checked = 0;
    for (let i = 0; i < 3; i++) {
      const b = await openedBoard({ checkedIn: ["home", "away"] });
      const gameId = await liveGame(b); // e2e4 through T10 at minute 6
      let pass: SweepReport | null = null;
      const played = await blackPlays(b, "e7e5", { ok: true }, async () => {
        serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5"] }));
        pass = await sweep(b, { now: b.at(8) });
      });
      expect(pass!.reconciled, `run ${i}: premise, the sweep read the game mid-call`).toBe(1);
      expect(played, `run ${i}`).toEqual({ ok: true, applied: false });
      expect(await outOfBand(b), `run ${i}: our own move is never out-of-band`).toEqual([]);
      expect(await ledgerOf(b), `run ${i}`).toEqual({ moves_uci: ["e2e4", "e7e5"], pending_move_ply: null });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("…a DIFFERENT move at that ply in the same window is still flagged (the negative pair)", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    await blackPlays(b, "e7e5", { ok: false, code: "not_your_turn_or_over", raw: "400" }, async () => {
      serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "d7d5"] }));
      expect((await sweep(b, { now: b.at(8) })).reconciled).toBe(1);
    });
    expect((await outOfBand(b)).map((f) => f.note)).toEqual([expect.stringContaining("ply 2 (d7d5)")]);
  });

  it("…and a submission that got no answer, then a different move at Lichess on a LATER pass, is flagged — the stale one whitewashes nothing", async () => {
    const b = await openedBoard({ checkedIn: ["home", "away"] });
    const gameId = await liveGame(b);
    await blackPlays(b, "e7e5", { ok: false, code: "unavailable", raw: "timeout" }, async () => {});
    expect(await ledgerOf(b), "premise: the unanswered move is on file").toEqual({ moves_uci: ["e2e4"], pending_move_ply: 1 });
    serveStream(gameFull(b, gameId, MID, { moves: ["e2e4", "d7d5"] }));
    expect((await sweep(b, { now: b.at(12) })).reconciled).toBe(1);
    expect((await outOfBand(b)).map((f) => f.note)).toEqual([expect.stringContaining("ply 2 (d7d5)")]);
    expect(await ledgerOf(b), "the ply is filled: the stale submission is spent").toEqual({ moves_uci: ["e2e4", "d7d5"], pending_move_ply: null });
  });
});

describe.runIf(HAS_DB)("the sweep's sequence property: check-ins, creates, moves, Lichess's answers, withdrawals and passes in any order", () => {
  /** `diverged`: a line that does not extend ours — T11 holds it mid-game. */
  type Truth = "silent" | "running" | "ended" | "aborted" | "diverged";
  type CreateOutcome = "ok" | "throttled" | "acceptFails";
  type Act =
    | { kind: "checkIn"; side: Side }
    | { kind: "create"; outcome: CreateOutcome }
    | { kind: "move" }
    | { kind: "truth"; truth: Truth }
    | { kind: "withdraw" }
    // Review M3: from here on the engine refuses this board's forfeit, the
    // same way every pass (injected at scoreEvent's door — a refusal the
    // sweep cannot know in advance; today's engine gives WRONG_PHASE anyway).
    | { kind: "refuseForfeits" }
    | { kind: "sweep"; dt: number };
  type Model = {
    t: number; // minutes after the organiser opened the round
    came: Record<Side, boolean>;
    bridge: "pending" | "ready" | "live" | "finished" | "held";
    reason: string | null;
    heldBy: "create" | "sweep" | "reconcile" | null; // who placed a provider_error hold
    throttledUntil: number | null;
    ledger: string[];
    startedAt: number | null;
    truth: Truth;
    playable: boolean;
    emptyReads: number;
    lastRead: number | null;
    refusing: boolean;
    /** The same refusal of the no-show forfeit, passes running (M3). */
    refusals: number;
  };

  // The rulebook, in minutes.
  const MIN = 60_000;
  const DEADLINE = DEADLINE_AFTER_MS / MIN; // window.ts: T+20 from the open
  const TICK = SWEEP_CADENCE_MS / MIN; // spec §4: the 5-minute cron
  const SPAN = (2 * (SEED_CLOCK.base + recoveredMoveBudget() * SEED_CLOCK.increment)) / 60; // both clocks, B moves of increment
  const HOLD = CREATION_429_HOLD_MS / MIN; // T9's queue hold after a 429
  const N = SWEEP_NO_TRUTH_HOLD_AFTER;
  /** M3/M4 ruling: one tick while reads bring the truth, doubling per empty
   *  read past the end, capped at an hour; half a tick of cron jitter. */
  const reReadAfter = (n: number) => Math.min(TICK * 2 ** Math.max(0, n - 1), 12 * TICK);

  const actArb: fc.Arbitrary<Act> = fc.oneof(
    { arbitrary: fc.constantFrom<Side>("home", "away").map((side): Act => ({ kind: "checkIn", side })), weight: 2 },
    {
      arbitrary: fc.constantFrom<CreateOutcome>("ok", "throttled", "acceptFails").map((outcome): Act => ({ kind: "create", outcome })),
      weight: 2,
    },
    { arbitrary: fc.constant<Act>({ kind: "move" }), weight: 1 },
    { arbitrary: fc.constantFrom<Truth>("silent", "running", "ended", "aborted", "diverged").map((truth): Act => ({ kind: "truth", truth })), weight: 2 },
    { arbitrary: fc.constant<Act>({ kind: "withdraw" }), weight: 1 },
    { arbitrary: fc.constantFrom(0.5, 1, 3, 5, 10, 25).map((dt): Act => ({ kind: "sweep", dt })), weight: 4 },
  );

  const C = (side: Side): Act => ({ kind: "checkIn", side });
  const S = (dt: number): Act => ({ kind: "sweep", dt });
  const CREATE: Act = { kind: "create", outcome: "ok" };
  const THROTTLED: Act = { kind: "create", outcome: "throttled" };
  // Forced paths: each ENDS with the step that makes its claim, and each
  // runs K times — so every claim below is reached, and counted, K times.
  const PATHS = {
    quiet_before_deadline: [C("home"), S(5)],
    noshow_one: [C("home"), S(25)],
    noshow_both: [S(25)],
    both_came_no_game: [C("home"), C("away"), S(25)],
    retry_waits: [C("home"), C("away"), THROTTLED, S(0.5)],
    retry_lands: [C("home"), C("away"), THROTTLED, S(1)],
    retry_too_late: [C("home"), C("away"), THROTTLED, S(25)],
    accept_failed_unread: [C("home"), C("away"), { kind: "create", outcome: "acceptFails" }, { kind: "truth", truth: "ended" }, S(3)],
    aborted_ready_held: [C("home"), C("away"), CREATE, { kind: "truth", truth: "aborted" }, S(25)],
    m4_held: [C("home"), C("away"), CREATE, { kind: "move" }, S(25), S(5), S(5), S(5)],
    m4_held_read_again: [C("home"), C("away"), CREATE, { kind: "move" }, S(25), S(5), S(5), S(5), S(25)],
    m4_ready_held: [C("home"), C("away"), CREATE, S(25), S(10), S(5), S(10)],
    held_then_withdrawn: [C("home"), C("away"), CREATE, { kind: "move" }, S(25), S(5), S(5), S(5), { kind: "withdraw" }, S(25)],
    tick_jitter_read: [C("home"), C("away"), CREATE, { kind: "move" }, S(3), S(3)],
    inside_increment: [C("home"), C("away"), CREATE, { kind: "move" }, S(13)],
    at_end_not_past: [C("home"), C("away"), CREATE, { kind: "move" }, S(14)],
    ended_finishes: [C("home"), C("away"), CREATE, { kind: "move" }, { kind: "truth", truth: "ended" }, S(3)],
    withdrawn_closes_unread: [C("home"), C("away"), CREATE, { kind: "move" }, { kind: "withdraw" }, S(3)],
    truth_resets: [C("home"), C("away"), CREATE, { kind: "move" }, S(25), { kind: "truth", truth: "running" }, S(5)],
    // C3: a held row's read counts even when Lichess answers…
    held_truth_counts: [C("home"), C("away"), CREATE, { kind: "move" }, S(25), S(5), S(5), S(5), { kind: "truth", truth: "running" }, S(25)],
    // …and T11's own mid-game hold backs off the same way.
    t11_hold_backs_off: [C("home"), C("away"), CREATE, { kind: "move" }, { kind: "truth", truth: "diverged" }, S(3), S(5), S(5), S(5)],
    // M3: the same refusal NO_SHOW_REFUSALS_BEFORE_HOLD passes running.
    noshow_refused_held: [{ kind: "refuseForfeits" }, C("home"), S(25), S(5), S(5)],
  } satisfies Record<string, readonly Act[]>;
  type PathName = keyof typeof PATHS;
  const PATH_NAMES = Object.keys(PATHS) as PathName[];
  const K = 4;
  const claims = Object.fromEntries(PATH_NAMES.map((p) => [p, 0])) as Record<PathName, number>;
  const counters = {
    steps: 0, skipped_precondition: 0, passes: 0, reads: 0, backoff_skips: 0, empty_counted: 0, truth_reset: 0,
    forfeit_one: 0, forfeit_both: 0, not_started_held: 0, quiet_before_deadline: 0,
    retry_landed: 0, retry_waited: 0, retry_too_late: 0, held_by_create_unread: 0,
    aborted_held: 0, m4_held: 0, m4_held_ready: 0, held_read_again: 0, held_read_counted: 0, t11_held: 0, finished_by_truth: 0, closed_by_withdrawal: 0, creates: 0, moves: 0, withdrawals: 0,
    refused_held: 0,
  };

  type PassFacts = {
    reconciled: number; mintRetries: number; forfeitBy: string | null; held: number; noShows: number; readLichess: boolean;
    /** The refusal the forfeit met, when it is a failure this pass. */
    refusedWith: string | null;
  };

  /** One pass, as the rulebook says it goes: job 4, job 2, job 1. Mutates m. */
  function predictPass(m: Model, b: Board): PassFacts {
    const p: PassFacts = { reconciled: 0, mintRetries: 0, forfeitBy: null, held: 0, noShows: 0, readLichess: false, refusedWith: null };
    // Job 4: a game on file — ready/live on any fixture, or held for a
    // mid-game diagnosis on a fixture still playable.
    // M3: never a hold T9 placed when the accept failed — that challenge was
    // never accepted, and would be re-read every tick for ever.
    const heldMidGame = m.bridge === "held" && m.reason === "provider_error" && m.playable;
    if (heldMidGame && m.heldBy === "create") counters.held_by_create_unread++;
    const readable = m.bridge === "ready" || m.bridge === "live" || (heldMidGame && m.heldBy !== "create");
    if (readable) {
      if (m.lastRead !== null && m.t - m.lastRead < reReadAfter(m.emptyReads) - TICK / 2) {
        counters.backoff_skips++;
      } else {
        p.reconciled = 1;
        m.lastRead = m.t;
        counters.reads++;
        const end = (m.startedAt ?? DEADLINE) + SPAN;
        if (!m.playable) {
          m.bridge = "finished"; // closed with no read, nothing written
          counters.closed_by_withdrawal++;
        } else if (m.bridge === "held") {
          // Ruling C3: every read of a held row counts toward its back-off,
          // whatever Lichess says and whatever the expected end; never a new
          // hold. The game's end is still written.
          p.readLichess = true;
          m.emptyReads++;
          counters.held_read_counted++;
          if (m.emptyReads > N) counters.held_read_again++;
          if (m.truth === "ended") {
            m.playable = false;
            counters.finished_by_truth++;
          }
        } else if (m.truth === "silent") {
          p.readLichess = true;
          if (m.t > end) {
            m.emptyReads++;
            counters.empty_counted++;
            if (m.emptyReads >= N) {
              if (m.startedAt === null) counters.m4_held_ready++;
              m.bridge = "held";
              m.reason = "provider_error";
              m.heldBy = "sweep";
              p.held = 1;
              counters.m4_held++;
            }
          }
        } else {
          p.readLichess = true;
          if (m.emptyReads > 0) counters.truth_reset++;
          m.emptyReads = 0;
          if (m.truth === "ended") {
            m.playable = false; // T12 wrote Lichess's result
            m.bridge = "finished"; // a held row never reaches here (C3's branch above)
            counters.finished_by_truth++;
          } else if (m.truth === "aborted") {
            m.bridge = "held";
            m.reason = "aborted";
            p.held = 1;
            counters.aborted_held++;
          } else if (m.truth === "diverged") {
            // T11 (C2a): a line that does not extend ours is held, never rewound.
            m.bridge = "held";
            m.reason = "provider_error";
            m.heldBy = "reconcile";
            p.held = 1;
            counters.t11_held++;
          }
        }
      }
    }
    // Job 2: a create Lichess throttled, retried once its hold is over and
    // only inside the window.
    if (m.bridge === "pending" && m.throttledUntil !== null && m.playable && m.t >= DEADLINE) {
      counters.retry_too_late++;
    }
    if (m.bridge === "pending" && m.throttledUntil !== null && m.playable && m.t < DEADLINE) {
      if (m.t >= m.throttledUntil) {
        p.mintRetries = 1;
        m.bridge = "ready";
        m.throttledUntil = null;
        counters.retry_landed++;
      } else {
        counters.retry_waited++;
      }
    }
    // Job 1: no game on file at the deadline, someone absent.
    if (m.bridge === "pending" && m.playable && m.t < DEADLINE && !(m.came.home && m.came.away)) {
      counters.quiet_before_deadline++;
    }
    if (m.bridge === "pending" && m.playable && m.t >= DEADLINE) {
      if (m.came.home && m.came.away) {
        // Ruling C2: both came, no game — the organiser's, as not_started.
        m.bridge = "held";
        m.reason = "not_started";
        p.held = 1;
        counters.not_started_held++;
      } else {
        p.forfeitBy = !m.came.home && !m.came.away ? "both" : !m.came.home ? b.home.entrantId : b.away.entrantId;
        if (p.forfeitBy === "both") counters.forfeit_both++;
        else counters.forfeit_one++;
        if (W2B && !m.refusing) {
          p.noShows = 1;
          m.playable = false; // forfeited
        } else {
          // Review M3: a failure, until the same refusal has come back
          // NO_SHOW_REFUSALS_BEFORE_HOLD passes running — then the organiser's,
          // as the no-show it is (the seed pairs home as White).
          m.refusals++;
          if (m.refusals < NO_SHOW_REFUSALS_BEFORE_HOLD) {
            p.refusedWith = m.refusing ? "INVALID_EVENT" : "WRONG_PHASE";
          } else {
            m.bridge = "held";
            m.reason = p.forfeitBy === "both" ? "no_show_both" : p.forfeitBy === b.home.entrantId ? "no_show_white" : "no_show_black";
            p.held = 1;
            counters.refused_held++;
          }
        }
      }
    }
    return p;
  }

  function claimHolds(path: PathName, m: Model, last: PassFacts | null, b: Board): boolean {
    switch (path) {
      case "quiet_before_deadline": return last !== null && last.forfeitBy === null && m.t < DEADLINE && !m.came.away;
      case "noshow_one": return last?.forfeitBy === b.away.entrantId;
      case "noshow_both": return last?.forfeitBy === "both";
      case "noshow_refused_held": return last?.held === 1 && m.reason === "no_show_black" && last.refusedWith === null;
      case "both_came_no_game": return last !== null && last.forfeitBy === null && last.held === 1 && m.reason === "not_started" && m.t >= DEADLINE;
      case "retry_waits": return last?.mintRetries === 0 && m.bridge === "pending" && m.throttledUntil !== null;
      case "retry_lands": return last?.mintRetries === 1 && m.bridge === "ready";
      case "retry_too_late": return last?.mintRetries === 0 && m.throttledUntil !== null && m.reason === "not_started" && m.t >= DEADLINE;
      case "accept_failed_unread": return last?.reconciled === 0 && m.bridge === "held" && m.heldBy === "create" && m.truth === "ended";
      case "aborted_ready_held": return last?.held === 1 && m.reason === "aborted";
      case "m4_held": return last?.held === 1 && m.reason === "provider_error";
      case "m4_held_read_again": return last?.reconciled === 1 && last.held === 0 && m.bridge === "held" && m.emptyReads === N + 1;
      case "m4_ready_held": return last?.held === 1 && m.heldBy === "sweep" && m.startedAt === null;
      case "held_then_withdrawn": return last?.reconciled === 0 && m.bridge === "held" && !m.playable;
      // Three minutes after a read: inside half a tick of the cadence, so read.
      case "tick_jitter_read": return last?.reconciled === 1 && m.lastRead === m.t && m.emptyReads === 0;
      // Past both base clocks, but not past the increments the game earned.
      case "inside_increment": {
        const s0 = m.startedAt ?? Number.NaN;
        return last?.reconciled === 1 && m.emptyReads === 0 && m.t > s0 + (2 * SEED_CLOCK.base) / 60 && m.t < s0 + SPAN;
      }
      case "held_truth_counts": return last?.reconciled === 1 && last.readLichess && m.bridge === "held" && m.emptyReads === N + 1;
      case "t11_hold_backs_off": return last?.reconciled === 0 && m.bridge === "held" && m.heldBy === "reconcile" && m.emptyReads === 2;
      case "at_end_not_past": return last?.reconciled === 1 && m.emptyReads === 0 && m.t === (m.startedAt ?? Number.NaN) + SPAN;
      case "ended_finishes": return last?.reconciled === 1 && m.bridge === "finished" && !m.playable;
      case "withdrawn_closes_unread": return last?.reconciled === 1 && !last.readLichess && m.bridge === "finished";
      case "truth_resets": return last?.reconciled === 1 && last.readLichess && m.emptyReads === 0;
    }
  }

  it("holds the model on every pass — counted per path, K runs each", { timeout: 600_000 }, async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(actArb, { minLength: 0, maxLength: 8 }), async (suffix) => {
        const path = PATH_NAMES[run % PATH_NAMES.length]!;
        run++;
        __resetCreationQueue();
        const b = await openedBoard({ checkedIn: [] });
        const m: Model = {
          t: 2, came: { home: false, away: false }, bridge: "pending", reason: null, heldBy: null, throttledUntil: null,
          ledger: [], startedAt: null, truth: "silent", playable: true, emptyReads: 0, lastRead: null,
          refusing: false, refusals: 0,
        };
        const queueAt = () => __setCreationQueueDeps({ now: () => b.at(m.t).getTime() });
        let next429 = false;
        board.createChallengeToUser.mockImplementation(async () => {
          if (next429) {
            next429 = false;
            return { ok: false, code: "rate_limited", raw: "Too many requests. Try again later." };
          }
          return { ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` };
        });
        let nextAcceptFails = false;
        board.acceptChallenge.mockImplementation(async () => {
          if (nextAcceptFails) {
            nextAcceptFails = false;
            return { ok: false, code: "unavailable", raw: "Lichess is unavailable" };
          }
          return { ok: true };
        });
        lichess.onStream = (c) => {
          if (m.truth === "silent") return { status: 503, body: "Lichess said nothing" };
          if (m.truth === "running") return { status: 200, body: gameFull(b, c.gameId, MID, { moves: m.ledger, status: "started" }) };
          if (m.truth === "aborted") return { status: 200, body: gameFull(b, c.gameId, MID, { moves: [], status: "aborted" }) };
          if (m.truth === "diverged") return { status: 200, body: gameFull(b, c.gameId, MID, { moves: ["d2d4"], status: "started" }) };
          return { status: 200, body: gameFull(b, c.gameId, ENDED) };
        };

        const steps: readonly Act[] = [...PATHS[path], ...suffix];
        let last: PassFacts | null = null;
        for (const [i, step] of steps.entries()) {
          const label = `${path} run ${run} step ${i} ${JSON.stringify(step)} @${m.t}`;
          counters.steps++;
          if (step.kind === "checkIn") {
            await stampFixtureCheckIn(b[step.side].personId, b.fixtureId, b.orgId);
            m.came[step.side] = true;
          } else if (step.kind === "create") {
            if (!(m.came.home && m.came.away && m.bridge === "pending" && m.throttledUntil === null && m.playable && m.t < DEADLINE)) {
              counters.skipped_precondition++;
              continue;
            }
            queueAt();
            next429 = step.outcome === "throttled";
            nextAcceptFails = step.outcome === "acceptFails";
            const out = await createGameIfReady(b.fixtureId, { now: b.at(m.t), publish: async () => {} });
            if (step.outcome === "throttled") {
              expect(out, label).toEqual({ created: false, reason: "provider_error" });
              m.throttledUntil = m.t + HOLD;
            } else if (step.outcome === "acceptFails") {
              // T9: the challenge exists at Lichess, so it is recorded and held.
              expect(out, label).toMatchObject({ created: false });
              m.bridge = "held";
              m.reason = "provider_error"; // T9's needsReasonFor("unavailable")
              m.heldBy = "create";
            } else {
              expect(out, label).toMatchObject({ created: true });
              m.bridge = "ready";
            }
            counters.creates++;
          } else if (step.kind === "move") {
            if (!(m.bridge === "ready" && m.ledger.length === 0 && m.playable && (m.truth === "silent" || m.truth === "running"))) {
              counters.skipped_precondition++;
              continue;
            }
            const out = await act(
              { fixtureId: b.fixtureId, personId: b.home.personId, action: { kind: "move", uci: "e2e4" } },
              { now: b.at(m.t), accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: async () => ({ ok: true }) },
            );
            expect(out, label).toEqual({ ok: true, applied: true });
            m.ledger = ["e2e4"];
            m.bridge = "live";
            m.startedAt = m.t;
            counters.moves++;
          } else if (step.kind === "truth") {
            const gameOnFile = m.bridge === "ready" || m.bridge === "live" || m.bridge === "held";
            const over = m.truth === "ended" || m.truth === "aborted";
            // An abort at ply 0 is a READY board's (a held board's abort is
            // not modelled); a diverging line needs a ledger to diverge from.
            if (
              !gameOnFile ||
              over ||
              (step.truth === "aborted" && (m.ledger.length > 0 || m.bridge === "held")) ||
              (step.truth === "diverged" && m.ledger.length === 0)
            ) {
              counters.skipped_precondition++;
              continue;
            }
            m.truth = step.truth;
          } else if (step.kind === "refuseForfeits") {
            m.refusing = true;
            scoring.refuse = (id, input) =>
              id === b.fixtureId && input.type === "core.forfeit" ? new EngineError("INVALID_EVENT", "injected: the same refusal") : null;
          } else if (step.kind === "withdraw") {
            if (!m.playable) {
              counters.skipped_precondition++;
              continue;
            }
            await withdrawEntrantCascade(await mintOrgOwnerAuth(b.orgId), b.away.entrantId);
            expect(isPlayableFixtureStatus((await fixtureRow(b.fixtureId)).status), `${label}: premise — a withdrawal settles the board`).toBe(false);
            m.playable = false;
            counters.withdrawals++;
          } else {
            m.t += step.dt;
            queueAt();
            const forfeitsBefore = forfeitsAttempted(b.fixtureId).length;
            const lichessBefore = lichess.calls.length;
            const report = await sweep(b, { now: b.at(m.t) });
            const p = predictPass(m, b);
            p.readLichess = p.readLichess && lichess.calls.length > lichessBefore;
            counters.passes++;
            expect(
              { reconciled: report.reconciled, mintRetries: report.mintRetries, noShows: report.noShows, held: report.heldForOrganiser },
              `${label}: the pass`,
            ).toEqual({ reconciled: p.reconciled, mintRetries: p.mintRetries, noShows: p.noShows, held: p.held });
            const attempts = forfeitsAttempted(b.fixtureId).slice(forfeitsBefore);
            expect(attempts.map((a) => (a.input.payload as { by: string }).by), `${label}: forfeits`).toEqual(p.forfeitBy === null ? [] : [p.forfeitBy]);
            expect(report.failures, `${label}: failures`).toEqual(
              p.refusedWith !== null ? [{ job: "no_show", fixtureId: b.fixtureId, code: p.refusedWith }] : [],
            );
            if (p.reconciled === 1 && !m.playable && m.bridge === "finished" && !p.readLichess) {
              expect(lichess.calls.length, `${label}: closed unread`).toBe(lichessBefore);
            }
            const [row] = await sql<{ status: string; needs_reason: string | null; sweep_no_truth_reads: number }[]>`
              select status, needs_reason, sweep_no_truth_reads from fixture_external_play where fixture_id = ${b.fixtureId}`;
            const status = m.bridge === "held" ? "needs_organiser" : m.bridge;
            expect(row, `${label}: the row`).toEqual({ status, needs_reason: m.bridge === "held" ? m.reason : null, sweep_no_truth_reads: m.emptyReads });
            expect(isPlayableFixtureStatus((await fixtureRow(b.fixtureId)).status), `${label}: playable`).toBe(m.playable);
            last = p;
          }
          if (i === PATHS[path].length - 1) {
            expect(claimHolds(path, m, last, b), `${label}: the path's claim`).toBe(true);
            claims[path]++;
          }
        }
      }),
      { numRuns: PATH_NAMES.length * K },
    );
    // Anti-vacuity: every path's claim reached K times, and the model's
    // branches all exercised.
    expect(claims, "claims per path").toEqual(Object.fromEntries(PATH_NAMES.map((p) => [p, K])));
    for (const [name, n] of Object.entries(counters)) {
      if (name === "skipped_precondition") continue;
      expect(n, `counter ${name}`).toBeGreaterThan(0);
    }
    // fd 1 directly: the JSON reporter drops console output.
    writeSync(1, `sweep property: ${JSON.stringify({ runs: run, claims, counters })}\n`);
  });
});

// ---------------------------------------------------------------------------
// Job 5 — the camera evidence after the match (controller ruling C1;
// design §5.2: "fetched once, at least 2 minutes after the player leaves or
// the match ends, retrying until left_at is set and duration > 0").
// RealtimeKit is the fake world above, through the REAL adapter; never live.
// ---------------------------------------------------------------------------
describe.runIf(HAS_DB)("job 5 — the camera evidence after the match (C1)", () => {
  type Match = {
    b: Board;
    meetingId: string;
    part: Record<Side, string>;
    /** The match window as the DB holds it: the first move, and the GAME's
     *  end (ruling I1) — the bridge's close, else the first read that saw the
     *  game over (as a JS Date reads them: milliseconds, what the sweep
     *  computes on). */
    startedAt: number;
    overAt: number;
    /** The ROOM's end, minutes after the game's: every ending here is torn
     *  down at a later sweep, as production does. */
    endedAt: number;
    /** The room's end rounded UP to the millisecond: `ended_at` is stamped
     *  by the DB's now(), which carries microseconds a JS Date drops, so a
     *  clock of `endedAt + 2 min` would sit a few microseconds BEFORE the
     *  rule's boundary. */
    endedCeil: number;
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const SAMPLE_MS = 7_000; // the spike's measured cadence

  /** How a match ENDS, each through the producers production uses — and in
   *  every one the room comes down at a LATER sweep than the game's end:
   *  - `tiebreak` (the default): a knockout draw read by T11, held
   *    tiebreak_owed by T12; the organiser settles it; the sweep tears down;
   *  - `aborted`: Lichess aborts after White's first move, held `aborted`;
   *    the organiser settles; the sweep tears down;
   *  - `finished`: a league draw T12 writes and T11 finishes the bridge; the
   *    sweep tears down at its next tick;
   *  - `held_then_ended`: Black's token refused mid-game (T10's 401 → a
   *    token_revoked hold); the game then ends at Lichess and T11 reads it
   *    (T12 writes the result; the hold keeps its reason); torn down;
   *  - `settled_while_held`: the same hold, but the organiser settles the
   *    board by hand and NO read ever sees the game's end — only the clock
   *    bounds it (last move + the side to move's time). */
  type Ending = "tiebreak" | "aborted" | "finished" | "held_then_ended" | "settled_while_held";
  const OVER_MIN = 16;

  /** A board played under `policy` through the REAL producers: both players
   *  check in; T9's create seats both through T8's REAL seat (the global
   *  fetch is the RealtimeKit fake for the create only — T8 passes no deps);
   *  T10's first move starts it at T+6 (unless `start: false`); it ENDS at
   *  T+16 as `ending` says; a sweep at T+19 tears the room down through T7's
   *  REAL endMeeting. Opened 19 minutes ago so every stamp is in the PAST of
   *  the DB's own clock that stamps the room's end. */
  async function playedMatch(
    o: { policy?: CameraPolicy; start?: boolean; ending?: Ending; override?: boolean; openedMinutesAgo?: number } = {},
  ): Promise<Match> {
    const ending: Ending = o.ending ?? "tiebreak";
    const b = await openedBoard({
      checkedIn: ["home", "away"], openedMinutesAgo: o.openedMinutesAgo ?? 19, cameraPolicy: o.policy ?? "required",
      ...(ending === "tiebreak" ? { kind: "knockout" } : {}),
    });
    let gameId: string;
    vi.stubGlobal("fetch", RTK.fetch);
    try {
      gameId = o.start === false ? await readyGame(b, 5) : await liveGame(b, 6);
    } finally {
      vi.unstubAllGlobals();
    }
    // D11: RealtimeKit down mid-match, the organiser proceeds without video.
    if (o.override) await organiserOverrideVideo({ fixtureId: b.fixtureId, actorUserId: b.ownerUserId, note: "RealtimeKit down" });
    const move = async (side: Side, uci: string, min: number, submit: () => Promise<BoardCall> = async () => ({ ok: true })) =>
      act(
        { fixtureId: b.fixtureId, personId: b[side].personId, action: { kind: "move", uci } },
        // The read T10 defers after a refusal is T11's, covered there.
        { now: b.at(min), accessToken: async (u) => `tok-${u}`, publish: async () => {}, submitMove: submit, reconcile: async () => null },
      );
    const blackMoves = (submit?: () => Promise<BoardCall>) => move("away", "e7e5", 7, submit);
    const UNAUTHORIZED = async (): Promise<BoardCall> => ({ ok: false, code: "unauthorized", raw: "401 Unauthorized" });
    /** The organiser decides the board by hand: a bracket's owed tie-break
     *  is SETTLED (core.settle); any other board gets its result typed in
     *  (boardgame.result, after core.start if nothing started the fold). */
    const settleByHand = async () => {
      const auth = await mintOrgOwnerAuth(b.orgId);
      const st = await getFixtureState(auth, b.fixtureId);
      let seq = st.last_seq;
      if (ending === "tiebreak" && o.start !== false) {
        await scoreEvent(auth, b.fixtureId, { expected_seq: seq, type: "core.settle", payload: { winner: b.home.entrantId, method: "lot" } });
        return;
      }
      // No event yet (a null fold) is phase "pre", as T12 reads it.
      if (((st.state as { phase?: string } | null)?.phase ?? "pre") === "pre") {
        await scoreEvent(auth, b.fixtureId, { expected_seq: seq, type: "core.start", payload: {} });
        seq++;
      }
      await scoreEvent(auth, b.fixtureId, { expected_seq: seq, type: "boardgame.result", payload: { winner: b.home.entrantId } });
    };
    const read = async (line: string, wrote: object) => {
      serveStream(line);
      expect(await reconcile(b.fixtureId, "game_end", { now: b.at(OVER_MIN) }), `premise: ${ending}`).toMatchObject(wrote);
      lichess.reset();
    };
    if (o.start === false) {
      // No first move: Lichess aborts at ply 0 — T12's `aborted`.
      await read(gameFull(b, gameId, MID, { moves: [], status: "aborted" }), { result: { wrote: "aborted" } });
      await settleByHand();
    } else if (ending === "tiebreak") {
      expect(await blackMoves(async () => ({ ok: true })), "premise: T10 played Black's reply").toEqual({ ok: true, applied: true });
      await read(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5"], status: "draw" }), {
        result: { wrote: "needs_organiser", reason: "tiebreak_owed" }, finished: false,
      });
      await settleByHand();
    } else if (ending === "aborted") {
      await read(gameFull(b, gameId, MID, { moves: ["e2e4"], status: "aborted" }), { result: { wrote: "aborted" }, finished: false });
      await settleByHand();
    } else if (ending === "finished") {
      expect(await blackMoves(async () => ({ ok: true })), "premise: T10 played Black's reply").toEqual({ ok: true, applied: true });
      await read(gameFull(b, gameId, MID, { moves: ["e2e4", "e7e5"], status: "draw" }), { result: { wrote: "draw" }, finished: true });
    } else if (ending === "held_then_ended") {
      expect(await blackMoves(UNAUTHORIZED), "premise: Lichess refused Black's token").toMatchObject({ ok: false });
      expect(await bridgeOf(b.fixtureId), "premise: held mid-game").toEqual({ status: "needs_organiser", needs_reason: "token_revoked" });
      await read(gameFull(b, gameId, MID, { moves: ["e2e4"], status: "resign", winner: "white" }), {
        result: { wrote: "decided" }, finished: false,
      });
    } else {
      // Three plies, so the two clocks DIFFER (the first two cost nothing,
      // scalachess Clock.step; White's third pays its minute): the side to
      // move is Black, whose 401 then holds the board.
      expect(await blackMoves(), "premise: T10 played Black's reply").toEqual({ ok: true, applied: true });
      expect(await move("home", "g1f3", 8), "premise: T10 played White's second move").toEqual({ ok: true, applied: true });
      expect(await move("away", "d7d5", 9, UNAUTHORIZED), "premise: Lichess refused Black's token").toMatchObject({ ok: false });
      expect(await bridgeOf(b.fixtureId), "premise: held mid-game").toEqual({ status: "needs_organiser", needs_reason: "token_revoked" });
      await settleByHand();
    }
    // On the real clock, so the room this pass ends is not yet 2 minutes old.
    const torn = await sweep(b, { now: new Date(), endMeeting: (id) => endMeeting(id, RTK) });
    expect(torn.meetingsEnded, `premise: ${ending} — the sweep tore the room down`).toBe(1);
    const [m] = await sql<{ meeting_id: string }[]>`
      select meeting_id from fixture_video_meetings where fixture_id = ${b.fixtureId}`;
    expect(m, "premise: T8's seat opened the room").toBeDefined();
    const parts = await sql<{ person_id: string; participant_id: string }[]>`
      select person_id, participant_id from fixture_video_participants
       where fixture_id = ${b.fixtureId} and preset = 'player'`;
    const of = (side: Side) => parts.find((p) => p.person_id === b[side].personId)?.participant_id;
    const part = { home: of("home"), away: of("away") };
    expect(part.home && part.away, "premise: T8 gave each player a camera participant").toBeTruthy();
    const [t] = await sql<{ started_at: Date | null; over_at: Date | null; ended_at: Date; ended_ceil: number }[]>`
      select ep.started_at, coalesce(ep.finished_at, ep.game_over_at) as over_at, vm.ended_at,
             ceil(extract(epoch from vm.ended_at) * 1000)::float8 as ended_ceil
        from fixture_video_meetings vm
        join fixture_external_play ep on ep.fixture_id = vm.fixture_id
       where vm.fixture_id = ${b.fixtureId}`;
    expect(t!.ended_at, "premise: T7 ended the room").not.toBeNull();
    if (o.start !== false) {
      expect(t!.started_at, "premise: T10 started the game").toEqual(b.at(6));
      const over = ending === "settled_while_held" ? null : b.at(OVER_MIN);
      expect(t!.over_at, `premise: ${ending} — the game's end on file`).toEqual(over);
      // Players leave at the game's end; the room ends minutes later (a
      // board settled by hand has its own premise, in its test).
      if (over !== null) expect(t!.ended_at.getTime() - over.getTime(), "premise: the room outlived the game").toBeGreaterThan(60_000);
    }
    rtk.calls = [];
    return {
      b,
      meetingId: m!.meeting_id,
      part: part as Record<Side, string>,
      startedAt: t!.started_at?.getTime() ?? Number.NaN,
      overAt: t!.over_at?.getTime() ?? Number.NaN,
      endedAt: t!.ended_at.getTime(),
      endedCeil: Number(t!.ended_ceil),
    };
  }

  /** A session of the match's meeting, `from`/`to` in ms. */
  function session(m: Match, from: number, to: number | null, status: "LIVE" | "ENDED" = "ENDED"): FakeSession {
    const x: FakeSession = {
      id: `sess-${randomUUID().slice(0, 8)}`, meetingId: m.meetingId, status,
      started_at: iso(from), ended_at: to === null ? null : iso(to), rows: [],
    };
    rtk.sessions.push(x);
    return x;
  }

  /** One camera connection (a PEER) of `side` in `x`, on from `joined` to
   *  `left` except over `gaps` (absolute ms), sampled every 7 s. `ready` is
   *  read at every fetch: false is a report not final yet (left_at null,
   *  duration 0 — the measured frozen snapshot). Returns its samples. */
  function connect(
    m: Match, x: FakeSession, side: Side,
    o: { joined: number; left: number; gaps?: [number, number][]; events?: [string, number][]; ready?: { now: boolean } },
  ): number[] {
    const peer = `peer-${randomUUID().slice(0, 8)}`;
    const samples: number[] = [];
    for (let t = o.joined; t <= o.left; t += SAMPLE_MS) {
      if (!(o.gaps ?? []).some(([a, b]) => t > a && t < b)) samples.push(t);
    }
    let row = x.rows.find((r) => r.user_id === m.part[side]);
    if (!row) {
      row = { id: `row-${randomUUID().slice(0, 8)}`, user_id: m.part[side], left_at: iso(o.left), peer_events: [] };
      x.rows.push(row);
    }
    row.peer_events.push({ event_name: "PEER_JOINING", peer_id: peer }, { event_name: "PEER_LEAVING", peer_id: peer });
    const ready = o.ready ?? { now: true };
    rtk.reports.set(peer, () => ({
      participant: {
        joined_at: iso(o.joined),
        left_at: ready.now ? iso(o.left) : null,
        duration: ready.now ? (o.left - o.joined) / 60_000 : 0,
        peer_report: {
          metadata: { events: (o.events ?? []).map(([name, at]) => ({ name, timestamp: iso(at) })) },
          quality: { video_producer: (ready.now ? samples : samples.slice(0, 1)).map((t) => ({ timestamp: iso(t), frames_encoded: 140 })) },
        },
      },
    }));
    return samples;
  }

  /** Both players on camera from before the first move to the room's end. */
  function bothOnThroughout(m: Match, x = session(m, m.startedAt - 120_000, m.endedAt)) {
    for (const side of ["home", "away"] as const) connect(m, x, side, { joined: m.startedAt - 90_000, left: m.endedAt });
    return x;
  }

  const flagsOf = (fixtureId: string) =>
    sql<{ kind: string; person_id: string | null; note: string | null; closed_at: Date | null }[]>`
      select kind, person_id, note, closed_at from fixture_play_flags where fixture_id = ${fixtureId} order by opened_at, id`;
  const settledAt = async (fixtureId: string) =>
    (await sql<{ camera_evidence_at: Date | null }[]>`
      select camera_evidence_at from fixture_video_meetings where fixture_id = ${fixtureId}`)[0]!.camera_evidence_at;
  const cameraFailures = (r: SweepReport) => r.failures.filter((f) => f.job === "camera_evidence");
  const rtkReads = () => rtk.calls.filter((c) => c.method === "GET" && c.path.startsWith("/sessions"));
  /** `ms` after the room ended — the sweep's clock. */
  const after = (m: Match, ms: number) => new Date(m.endedCeil + ms);
  const pass = (m: Match, now: Date) => sweep(m.b, { now, endMeeting: (id) => endMeeting(id, RTK), realtimeKit: RTK });

  it("the rulebook's timing: at least 2 minutes after the room ends; a day to give up", () => {
    expect(CAMERA_EVIDENCE_AFTER_MS, "spec §5.2: at least 2 minutes").toBe(2 * 60_000);
    expect(CAMERA_EVIDENCE_GIVE_UP_MS).toBe(24 * 60 * 60_000);
  });

  // Ruling I1: the window ends at the GAME's end — never at the room's, which
  // in every production ending below comes down minutes later.
  it("players gone at the GAME's end, the room torn down minutes later: NO flag — every read-ended production ending (counted)", { timeout: 120_000 }, async () => {
    let checked = 0;
    for (const ending of ["tiebreak", "aborted", "finished", "held_then_ended"] as const) {
      const m = await playedMatch({ ending });
      const x = session(m, m.startedAt - 120_000, m.overAt + 30_000);
      for (const side of ["home", "away"] as const) connect(m, x, side, { joined: m.startedAt - 90_000, left: m.overAt + 30_000 });
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(cameraFailures(r), ending).toEqual([]);
      expect([r.cameraSettled, r.cameraFlags], ending).toEqual([1, 0]);
      expect((await flagsOf(m.b.fixtureId)).filter((f) => f.kind === "camera_lost"), ending).toEqual([]);
      expect(rtkReads().filter((c) => c.path.startsWith("/sessions/peer-report/")).length, `${ending}: both cameras read`).toBe(2);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("…and the camera off in the game's LAST minute is still the match's: flagged up to the game's end, not beyond", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.overAt + 30_000);
    const left = m.overAt - 60_000;
    connect(m, x, "home", { joined: m.startedAt - 90_000, left });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.overAt + 30_000 });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(r.cameraFlags).toBe(1);
    const [f] = await flagsOf(m.b.fixtureId);
    expect(f!.person_id).toBe(m.b.home.personId);
    // From home's leave (its report's left_at) to the GAME's end (T11's draw read at T+16).
    expect(f!.note).toContain(`camera off 60 s of ${Math.round((m.overAt - m.startedAt) / 1000)} s`);
    expect(f!.note).toContain(`${iso(left)} to ${iso(m.overAt)}`);
  });

  it("settled by hand while held, NO read ever saw the end: the clock bounds it — the last move plus the side to move's time", async () => {
    const m = await playedMatch({ ending: "settled_while_held" });
    // The rulebook's bound: after White's g1f3 at T+8 it is Black's move, and
    // Black's clock has never run (its one move was ply 1, before the clocks
    // start — scalachess Clock.step), so it holds the division's whole base.
    const clockEnd = m.b.at(8).getTime() + SEED_CLOCK.base * 1000;
    expect(m.endedAt - clockEnd, "premise: the room outlived the clock's bound").toBeGreaterThan(60_000);
    const x = session(m, m.startedAt - 120_000, clockEnd + 30_000);
    const left = clockEnd - 60_000;
    connect(m, x, "home", { joined: m.startedAt - 90_000, left });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: clockEnd + 30_000 });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(r.cameraFlags, "home left a minute early; away stayed to the bound").toBe(1);
    const [f] = await flagsOf(m.b.fixtureId);
    expect(f!.person_id).toBe(m.b.home.personId);
    expect(f!.note).toContain(`camera off 60 s of ${Math.round((clockEnd - m.startedAt) / 1000)} s`);
    expect(f!.note).toContain(`${iso(left)} to ${iso(clockEnd)}`);
  });

  it("the room torn down BEFORE the clock's bound (settled by hand at once): the window stops at the room's end — a closed room has no cameras", async () => {
    // Opened 11 minutes ago: the four moves are past, the room ends now —
    // before Black's clock could have run out (T+8 + the whole base = T+13).
    const m = await playedMatch({ ending: "settled_while_held", openedMinutesAgo: 11 });
    const clockEnd = m.b.at(8).getTime() + SEED_CLOCK.base * 1000;
    expect(clockEnd - m.endedAt, "premise: the room ended before the clock's bound").toBeGreaterThan(60_000);
    bothOnThroughout(m);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 0]);
    expect(rtkReads().filter((c) => c.path.startsWith("/sessions/peer-report/")).length, "both cameras read").toBe(2);
  });

  it("NO end on file at all — an impossible row (guard reached by SQL): nothing read; a day on, settled with no flag, and SAID so", async () => {
    const m = await playedMatch({ ending: "settled_while_held" });
    bothOnThroughout(m);
    // Stands for a row no producer writes: a started game with no last move.
    await sql`update fixture_external_play set last_move_at = null where fixture_id = ${m.b.fixtureId}`;
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([r.cameraSettled, cameraFailures(r)]).toEqual([0, []]);
    expect(rtkReads(), "no window, no read").toEqual([]);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    const late = await pass(m, new Date(m.endedAt + CAMERA_EVIDENCE_GIVE_UP_MS + 1));
    expect(cameraFailures(late)).toEqual([{ job: "camera_evidence", fixtureId: m.b.fixtureId, code: "CAMERA_EVIDENCE_UNREAD" }]);
    expect(late.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("camera on throughout: settled, NO flag — and every report was read (counted)", async () => {
    const m = await playedMatch();
    bothOnThroughout(m);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(r.cameraSettled).toBe(1);
    expect(r.cameraFlags).toBe(0);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    expect(await settledAt(m.b.fixtureId)).not.toBeNull();
    // Anti-vacuity: the session list, one participant list per player, one report per peer.
    expect(rtkReads().map((c) => c.path.replace(/sess-[0-9a-f]{8}/, "*").replace(/peer-[0-9a-f]{8}/, "*"))).toEqual([
      "/sessions", "/sessions/*/participants", "/sessions/peer-report/*", "/sessions/*/participants", "/sessions/peer-report/*",
    ]);
  });

  it("the camera OFF mid-match: one camera_lost flag for THAT player, the interval in its note; never a sanction", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    const gap: [number, number] = [m.startedAt + 200_000, m.startedAt + 400_000];
    const samples = connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [gap] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    const before = await fixtureRow(m.b.fixtureId);
    const bridge = await bridgeOf(m.b.fixtureId);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(r.cameraFlags).toBe(1);
    // Expected from the scenario: the off interval brackets the gap by the
    // last sample before it and the first after it (spec §5.2).
    const from = Math.max(...samples.filter((t) => t <= gap[0]));
    const to = Math.min(...samples.filter((t) => t >= gap[1]));
    const flags = await flagsOf(m.b.fixtureId);
    expect(flags.map((f) => [f.kind, f.person_id, f.closed_at])).toEqual([["camera_lost", m.b.home.personId, null]]);
    expect(flags[0]!.note).toContain(`camera off ${Math.round((to - from) / 1000)} s of ${Math.round((m.overAt - m.startedAt) / 1000)} s`);
    expect(flags[0]!.note).toContain(`${iso(from)} to ${iso(to)}`);
    expect(flags[0]!.note).toContain("camera required");
    // T15: the arbiter panel's loader reads THIS producer's note back — the
    // same numbers, expected from the scenario, never from the parser.
    const panel = await loadArbiterRound(await mintOrgOwnerAuth(m.b.orgId), m.b.divisionId);
    const shown = panel!.boards.find((x) => x.fixtureId === m.b.fixtureId)!.flags;
    expect(shown.map((f) => f.kind)).toEqual(["camera_lost"]);
    expect(shown[0]).toMatchObject({
      report: {
        offSeconds: Math.round((to - from) / 1000),
        windowSeconds: Math.round((m.overAt - m.startedAt) / 1000),
        intervals: [{ from: iso(from), to: iso(to) }],
        sessions: 1,
      },
    });
    // D10: the organiser decides — nothing about the match moved.
    expect(await fixtureRow(m.b.fixtureId)).toEqual(before);
    expect(await bridgeOf(m.b.fixtureId)).toEqual(bridge);
  });

  // T16 (controller ruling B, AGENTS.md class 13): "Let the game go on"
  // closes what the organiser saw. A flag closed DURING the match must not
  // swallow the camera judgment that only comes after it — and a camera flag
  // the organiser has closed is already-judged evidence: a later pass over the
  // same room raises nothing (V436's one settle per room).
  it("T16: a flag closed mid-match does not stop the camera judgment; the judged camera flag, once closed, is never raised again", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    const owner = await mintOrgOwnerAuth(m.b.orgId);
    // Earlier evidence on the board, reviewed and let go on mid-match (a
    // stand-in row: reconcile's producer is driven in its own suite).
    const [earlier] = await sql<{ id: string }[]>`
      insert into fixture_play_flags (fixture_id, org_id, kind, note)
      values (${m.b.fixtureId}, ${m.b.orgId}, 'out_of_band_play', 'plies 3-4 (e7e5 g1f3); camera required')
      returning id`;
    expect(await closeExternalPlayFlags(owner, m.b.fixtureId, [earlier!.id])).toEqual({ closed: 1, stillOpen: 0 });

    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(r.cameraFlags, "NEW evidence after a close is raised").toBe(1);
    const shown = (await loadArbiterRound(owner, m.b.divisionId))!.boards.find((x) => x.fixtureId === m.b.fixtureId)!.flags;
    expect(shown.map((f) => f.kind), "the panel shows the new camera flag only").toEqual(["camera_lost"]);

    expect(await closeExternalPlayFlags(owner, m.b.fixtureId, shown.map((f) => f.id))).toEqual({ closed: 1, stillOpen: 0 });
    const again = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + 10 * 60_000));
    expect(cameraFailures(again)).toEqual([]);
    expect([again.cameraSettled, again.cameraFlags], "already judged: nothing re-raised").toEqual([0, 0]);
    expect((await flagsOf(m.b.fixtureId)).map((f) => [f.kind, f.closed_at === null])).toEqual([
      ["out_of_band_play", false],
      ["camera_lost", false],
    ]);
  });

  it("a RELOAD (two peers in one session) is one camera, not a loss", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    const mid = m.startedAt + 300_000;
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: mid });
    connect(m, x, "home", { joined: mid + 5_000, left: m.endedAt });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    expect(x.rows.find((r) => r.user_id === m.part.home)!.peer_events.length, "premise: two peers").toBe(4);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(r.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    expect(rtkReads().filter((c) => c.path.startsWith("/sessions/peer-report/")).length, "every peer read").toBe(3);
  });

  it("a REJOIN (two sessions) is one camera, not a loss — and a second session is read", async () => {
    const m = await playedMatch();
    const mid = m.startedAt + 300_000;
    const s1 = session(m, m.startedAt - 120_000, mid);
    const s2 = session(m, mid + 3_000, m.endedAt);
    for (const side of ["home", "away"] as const) {
      connect(m, s1, side, { joined: m.startedAt - 90_000, left: mid });
      connect(m, s2, side, { joined: mid + 3_000, left: m.endedAt });
    }
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    expect(rtkReads().filter((c) => c.path.startsWith("/sessions/peer-report/")).length, "4 peers over 2 sessions").toBe(4);
  });

  it("a rejoin that left the match UNCOVERED is a loss, from the leave to the return", async () => {
    const m = await playedMatch();
    const mid = m.startedAt + 300_000;
    const s1 = session(m, m.startedAt - 120_000, mid);
    const s2 = session(m, mid + 60_000, m.endedAt);
    connect(m, s1, "home", { joined: m.startedAt - 90_000, left: mid });
    connect(m, s2, "home", { joined: mid + 60_000, left: m.endedAt });
    connect(m, s1, "away", { joined: m.startedAt - 90_000, left: mid });
    connect(m, s2, "away", { joined: mid + 60_000, left: m.endedAt });
    await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    const flags = await flagsOf(m.b.fixtureId);
    expect(flags.map((f) => f.person_id).sort()).toEqual([m.b.home.personId, m.b.away.personId].sort());
    for (const f of flags) expect(f.note).toContain(`${iso(mid)} to ${iso(mid + 60_000)}`);
  });

  // T14 re-review 3, I-1 (controller ruling 2026-10-12): OUR safeguard left
  // the meeting (it could not refuse a remote stream) and re-joined. The gap
  // it stamped is Seazn's, never the player's: no camera_lost for it. The
  // stamps go through the writers the room's camera-fault endpoint uses.
  describe("our guard's faults (I-1): the stamped gap is never the player's", () => {
    /** home's camera: on to `leave`, back at `back`; away on throughout. */
    async function gapMatch(gapMs: number) {
      const m = await playedMatch();
      const leave = m.startedAt + 300_000;
      const back = leave + gapMs;
      const x = session(m, m.startedAt - 120_000, m.endedAt);
      connect(m, x, "home", { joined: m.startedAt - 90_000, left: leave });
      connect(m, x, "home", { joined: back, left: m.endedAt });
      connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
      return { m, leave, back };
    }
    const seat = (m: Match, side: Side) => ({ fixtureId: m.b.fixtureId, personId: m.b[side].personId });

    it("the positive pair: a 60 s gap with NO stamp is a camera_lost flag; the same gap stamped as our fault is none", async () => {
      expect(60_000, "premise: the gap is past the 15 s threshold").toBeGreaterThan(15_000);
      const plain = await gapMatch(60_000);
      const r0 = await pass(plain.m, after(plain.m, CAMERA_EVIDENCE_AFTER_MS));
      expect([r0.cameraSettled, r0.cameraFlags], "no stamp: the player's").toEqual([1, 1]);
      const [f] = await flagsOf(plain.m.b.fixtureId);
      expect([f!.kind, f!.person_id]).toEqual(["camera_lost", plain.m.b.home.personId]);
      expect(f!.note).toContain(`${iso(plain.leave)} to ${iso(plain.back)}`);

      const ours = await gapMatch(60_000);
      expect((await openGuardFault(sql, { ...seat(ours.m, "home"), at: new Date(ours.leave) })).outcome, "premise: opened").toBe("opened");
      expect(await closeGuardFault(sql, { ...seat(ours.m, "home"), at: new Date(ours.back) }), "premise: closed").toBe(true);
      const r1 = await pass(ours.m, after(ours.m, CAMERA_EVIDENCE_AFTER_MS));
      expect(cameraFailures(r1)).toEqual([]);
      expect([r1.cameraSettled, r1.cameraFlags], "stamped: ours").toEqual([1, 0]);
      expect(await flagsOf(ours.m.b.fixtureId)).toEqual([]);
    });

    it("only the stamped part is excused: a fault that ended early leaves the rest of the gap the player's", async () => {
      const { m, leave, back } = await gapMatch(90_000);
      await openGuardFault(sql, { ...seat(m, "home"), at: new Date(leave) });
      await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(leave + 20_000) });
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(r.cameraFlags).toBe(1);
      const [f] = await flagsOf(m.b.fixtureId);
      expect(f!.person_id).toBe(m.b.home.personId);
      expect(f!.note).toContain(`camera off 70 s`);
      expect(f!.note).toContain(`${iso(leave + 20_000)} to ${iso(back)}`);
    });

    it("a fault still OPEN (the re-join never landed) excuses to the match's end — and, that long, is TOLD; the OTHER player's stamp excuses nobody else", async () => {
      // home's camera never came back: the stamp is open.
      const m = await playedMatch();
      const leave = m.startedAt + 300_000;
      expect(m.overAt - leave, "premise: the open stamp runs past the told threshold").toBeGreaterThan(GUARD_FAULT_FLAG_SECONDS * 1000);
      const x = session(m, m.startedAt - 120_000, m.endedAt);
      connect(m, x, "home", { joined: m.startedAt - 90_000, left: leave });
      connect(m, x, "away", { joined: m.startedAt - 90_000, left: leave });
      await openGuardFault(sql, { ...seat(m, "home"), at: new Date(leave) });
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect([r.cameraFlags, r.connectionFlags], "away left too, with no stamp of their own; home's stamp is told").toEqual([1, 1]);
      const flags = await flagsOf(m.b.fixtureId);
      expect(flags.map((f) => [f.kind, f.person_id]).sort()).toEqual(
        [["camera_connection_problems", m.b.home.personId], ["camera_lost", m.b.away.personId]].sort(),
      );
    });

    // T14 fix round 6, I-2: the camera GIVES UP (RECOVER_MAX_ATTEMPTS failed
    // re-joins) and tells the player to reload. The give-up sends no end —
    // camera-session.test.ts proves it — so the stamp stays open until the
    // reload's re-seat closes it (claimRoomSeat → closeGuardFault, proven in
    // external-play-room.test.ts). Each case below has its pair: the stamp
    // closed AT the give-up, as fix round 5 did, accuses the player.
    describe("the give-up keeps the stamp open (fix round 6, I-2)", () => {
      const giveUpMs = Array.from({ length: RECOVER_MAX_ATTEMPTS }, (_, i): number => RECOVER_BACKOFF_MS[Math.min(i, RECOVER_BACKOFF_MS.length - 1)]!).reduce((a, b) => a + b, 0);

      it("give up, then 2 minutes with NO reload, then the match ends: never camera_lost, and the organiser is told — the pair: closed at the give-up, the 2 minutes are camera_lost", async () => {
        async function gaveUp(closeAtGiveUp: boolean) {
          const m = await playedMatch();
          const leave = m.overAt - giveUpMs - 120_000;
          expect(leave, "premise: the fault starts inside the match").toBeGreaterThan(m.startedAt);
          const x = session(m, m.startedAt - 120_000, m.endedAt);
          connect(m, x, "home", { joined: m.startedAt - 90_000, left: leave });
          connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
          expect((await openGuardFault(sql, { ...seat(m, "home"), at: new Date(leave) })).outcome, "premise: opened").toBe("opened");
          if (closeAtGiveUp) await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(leave + giveUpMs) });
          return { m, leave };
        }
        const open = await gaveUp(false);
        expect(open.m.overAt - open.leave, "premise: the open stamp runs past the told threshold").toBeGreaterThan(GUARD_FAULT_FLAG_SECONDS * 1000);
        const r = await pass(open.m, after(open.m, CAMERA_EVIDENCE_AFTER_MS));
        expect(cameraFailures(r)).toEqual([]);
        expect([r.cameraSettled, r.cameraFlags, r.connectionFlags]).toEqual([1, 0, 1]);
        expect((await flagsOf(open.m.b.fixtureId)).map((f) => [f.kind, f.person_id])).toEqual([["camera_connection_problems", open.m.b.home.personId]]);

        const closed = await gaveUp(true);
        const r0 = await pass(closed.m, after(closed.m, CAMERA_EVIDENCE_AFTER_MS));
        expect(r0.cameraFlags, "closed at the give-up: the 2 minutes are the player's").toBe(1);
        const lost = (await flagsOf(closed.m.b.fixtureId)).find((f) => f.kind === "camera_lost");
        expect(lost?.person_id).toBe(closed.m.b.home.personId);
        expect(lost?.note).toContain(`${iso(closed.leave + giveUpMs)} to ${iso(closed.m.overAt)}`);
      });

      it("give up, then reload 30 s later: the re-seat closes the stamp, the camera is back a join later — never camera_lost; the pair: closed at the give-up, the reload is camera_lost", async () => {
        const joinMs = MATCH_OFF_MIN_MS / 3;
        async function reloaded(closeAtGiveUp: boolean) {
          const m = await playedMatch();
          const leave = m.startedAt + 120_000;
          const reseat = leave + giveUpMs + 30_000;
          const back = reseat + joinMs;
          expect(back, "premise: back inside the match").toBeLessThan(m.overAt);
          const x = session(m, m.startedAt - 120_000, m.endedAt);
          connect(m, x, "home", { joined: m.startedAt - 90_000, left: leave });
          connect(m, x, "home", { joined: back, left: m.endedAt });
          connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
          await openGuardFault(sql, { ...seat(m, "home"), at: new Date(leave) });
          if (closeAtGiveUp) await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(leave + giveUpMs) });
          // The reload's claim: a no-op when the give-up already closed it.
          expect(await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(reseat) }), "premise: the re-seat closes only an open stamp").toBe(!closeAtGiveUp);
          return { m, leave, reseat, back };
        }
        const open = await reloaded(false);
        expect((open.reseat - open.leave) / 1000, "premise: the stamped total is past the told threshold").toBeGreaterThan(GUARD_FAULT_FLAG_SECONDS);
        const r = await pass(open.m, after(open.m, CAMERA_EVIDENCE_AFTER_MS));
        expect(cameraFailures(r)).toEqual([]);
        expect([r.cameraSettled, r.cameraFlags, r.connectionFlags], "ours: excused, and told").toEqual([1, 0, 1]);

        const closed = await reloaded(true);
        const r0 = await pass(closed.m, after(closed.m, CAMERA_EVIDENCE_AFTER_MS));
        expect(r0.cameraFlags, "closed at the give-up: the reload is the player's").toBe(1);
        const lost = (await flagsOf(closed.m.b.fixtureId)).find((f) => f.kind === "camera_lost");
        expect(lost?.note).toContain(`${iso(closed.leave + giveUpMs)} to ${iso(closed.back)}`);
      });
    });

    // T14 fix round 5, ruling 1: a stamp excuses, it never HIDES. Every case
    // is built from the thresholds' own constants.
    describe("a stamp never hides: past a threshold the organiser is told, neutrally (fix round 5)", () => {
      /** home leaves and re-joins at each `[offsetMs, lenMs]` (from the first
       *  move); away on throughout. `stamped` puts OUR stamp on each gap. */
      async function gapsMatch(gaps: readonly [number, number][], stamped: boolean) {
        const m = await playedMatch();
        const x = session(m, m.startedAt - 120_000, m.endedAt);
        let joined = m.startedAt - 90_000;
        for (const [off, len] of gaps) {
          connect(m, x, "home", { joined, left: m.startedAt + off });
          joined = m.startedAt + off + len;
        }
        connect(m, x, "home", { joined, left: m.endedAt });
        connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
        if (stamped) {
          for (const [off, len] of gaps) {
            expect((await openGuardFault(sql, { ...seat(m, "home"), at: new Date(m.startedAt + off) })).outcome, "premise: opened").toBe("opened");
            expect(await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(m.startedAt + off + len) }), "premise: closed").toBe(true);
          }
        }
        const last = gaps.at(-1);
        if (last) expect(m.startedAt + last[0] + last[1], "premise: every gap inside the match").toBeLessThan(m.overAt);
        return m;
      }
      const kinds = async (m: Match) => (await flagsOf(m.b.fixtureId)).map((f) => [f.kind, f.person_id]);

      it("AT both thresholds (the limit of stamps, the limit of seconds between them): excused and NOT told — the pair: unstamped, the same gaps are camera_lost", async () => {
        const each = (GUARD_FAULT_FLAG_SECONDS / GUARD_FAULT_FLAG_STAMPS) * 1000;
        expect(each, "premise: each gap alone is past the 15 s camera-off threshold").toBeGreaterThan(15_000);
        const gaps = Array.from({ length: GUARD_FAULT_FLAG_STAMPS }, (_, i): [number, number] => [60_000 + i * 90_000, each]);
        const ours = await gapsMatch(gaps, true);
        const r = await pass(ours, after(ours, CAMERA_EVIDENCE_AFTER_MS));
        expect(cameraFailures(r)).toEqual([]);
        expect([r.cameraSettled, r.cameraFlags, r.connectionFlags]).toEqual([1, 0, 0]);
        expect(await kinds(ours)).toEqual([]);

        const plain = await gapsMatch(gaps, false);
        const r0 = await pass(plain, after(plain, CAMERA_EVIDENCE_AFTER_MS));
        expect([r0.cameraFlags, r0.connectionFlags], "no stamp: the player's").toEqual([1, 0]);
        expect(await kinds(plain)).toEqual([["camera_lost", plain.b.home.personId]]);
      });

      it("past the SECONDS (one stamped gap, one second over): the neutral flag with its total, and never camera_lost", async () => {
        const len = (GUARD_FAULT_FLAG_SECONDS + 1) * 1000;
        const m = await gapsMatch([[120_000, len]], true);
        const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
        expect(cameraFailures(r)).toEqual([]);
        expect([r.cameraSettled, r.cameraFlags, r.connectionFlags]).toEqual([1, 0, 1]);
        const flags = await flagsOf(m.b.fixtureId);
        expect(flags.map((f) => [f.kind, f.person_id, f.closed_at])).toEqual([["camera_connection_problems", m.b.home.personId, null]]);
        expect(flags[0]!.note, "the stamped total leads the note (T16 renders it as {duration})").toMatch(
          new RegExp(`^${GUARD_FAULT_FLAG_SECONDS + 1} s `),
        );
        expect(flags[0]!.note).toContain(`1 stamp`);
        expect(flags[0]!.note).toContain(`${iso(m.startedAt + 120_000)} to ${iso(m.startedAt + 120_000 + len)}`);
        expect(flags[0]!.note, "neutral: never the camera-off wording").not.toMatch(/camera off/);
      });

      it("past the COUNT (one stamp more than the limit, each short): the neutral flag, never camera_lost", async () => {
        const gaps = Array.from({ length: GUARD_FAULT_FLAG_STAMPS + 1 }, (_, i): [number, number] => [60_000 + i * 60_000, 16_000]);
        expect(16 * gaps.length, "premise: under the seconds limit — only the count tells").toBeLessThanOrEqual(GUARD_FAULT_FLAG_SECONDS + 10);
        const m = await gapsMatch(gaps, true);
        const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
        expect([r.cameraFlags, r.connectionFlags]).toEqual([0, 1]);
        expect(await kinds(m)).toEqual([["camera_connection_problems", m.b.home.personId]]);
        expect((await flagsOf(m.b.fixtureId))[0]!.note).toContain(`${GUARD_FAULT_FLAG_STAMPS + 1} stamps`);
      });

      it("told AND accused are independent: many stamps plus an UNSTAMPED gap is both flags; a re-run writes neither again", async () => {
        const gaps = Array.from({ length: GUARD_FAULT_FLAG_STAMPS + 1 }, (_, i): [number, number] => [60_000 + i * 60_000, 16_000]);
        const m = await gapsMatch([...gaps, [400_000, 30_000]], false);
        for (const [off, len] of gaps) {
          await openGuardFault(sql, { ...seat(m, "home"), at: new Date(m.startedAt + off) });
          await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(m.startedAt + off + len) });
        }
        const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
        expect([r.cameraFlags, r.connectionFlags]).toEqual([1, 1]);
        const flags = await flagsOf(m.b.fixtureId);
        const lost = flags.find((f) => f.kind === "camera_lost");
        expect(lost?.note, "only the unstamped gap is the player's").toContain(`camera off 30 s`);
        expect(flags.map((f) => f.kind).sort()).toEqual(["camera_connection_problems", "camera_lost"]);
        const again = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + SWEEP_CADENCE_MS));
        expect([again.cameraSettled, again.cameraFlags, again.connectionFlags]).toEqual([0, 0, 0]);
        expect(await flagsOf(m.b.fixtureId)).toHaveLength(2);
      });

      it("stamps OUTSIDE the match are not counted: four after the game's end tell nobody", async () => {
        const m = await playedMatch();
        bothOnThroughout(m);
        expect(m.endedAt - m.overAt, "premise: room outlives the game by enough for four stamps").toBeGreaterThan(40_000);
        for (let i = 0; i <= GUARD_FAULT_FLAG_STAMPS; i += 1) {
          const at0 = m.overAt + 5_000 + i * 8_000;
          await openGuardFault(sql, { ...seat(m, "home"), at: new Date(at0) });
          await closeGuardFault(sql, { ...seat(m, "home"), at: new Date(at0 + 2_000) });
        }
        const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
        expect([r.cameraSettled, r.cameraFlags, r.connectionFlags]).toEqual([1, 0, 0]);
      });
    });

    it("a fault opened AFTER the game's end and never closed is outside the match: settled as before, nothing thrown", async () => {
      const m = await playedMatch();
      bothOnThroughout(m);
      expect(m.endedAt - m.overAt, "premise: the room outlived the game").toBeGreaterThan(60_000);
      await openGuardFault(sql, { ...seat(m, "home"), at: new Date(m.overAt + 30_000) });
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(cameraFailures(r)).toEqual([]);
      expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 0]);
    });

    // T15 fix round 1, I1: the arbiter panel shows the connection time from
    // the guard's own stamps, over the SAME window job 5 judged — the
    // reviewer's probe case, where the two used to differ: a held game
    // settled by hand (no read saw its end: the clock bounds it) and a stamp
    // never closed (it runs to the window's end).
    it("I1: the panel and job 5 agree — a held game settled by hand, an OPEN stamp: the same seconds, the same stamps", async () => {
      const m = await playedMatch({ ending: "settled_while_held" });
      // The rulebook's bound (see the clock-bound test above): Black to move
      // after T+8, holding the division's whole base.
      const clockEnd = m.b.at(8).getTime() + SEED_CLOCK.base * 1000;
      expect(m.endedAt - clockEnd, "premise: the room outlived the clock's bound by more than a minute").toBeGreaterThan(60_000);
      const leave = clockEnd - 120_000;
      expect(leave, "premise: the stamp opens inside the match").toBeGreaterThan(m.startedAt);
      const x = session(m, m.startedAt - 120_000, clockEnd + 30_000);
      connect(m, x, "home", { joined: m.startedAt - 90_000, left: leave });
      connect(m, x, "away", { joined: m.startedAt - 90_000, left: clockEnd + 30_000 });
      expect((await openGuardFault(sql, { ...seat(m, "home"), at: new Date(leave) })).outcome, "premise: opened, never closed").toBe("opened");
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(cameraFailures(r)).toEqual([]);
      expect([r.cameraSettled, r.cameraFlags, r.connectionFlags], "ours: excused, and told").toEqual([1, 0, 1]);
      // Expected from the scenario: the open stamp runs from the leave to the
      // clock's bound — never to the room's later end.
      const seconds = Math.round((clockEnd - leave) / 1000);
      const [written] = await flagsOf(m.b.fixtureId);
      expect(written!.note, "job 5's own number").toMatch(new RegExp(`^${seconds} s stamped`));
      const panel = await loadArbiterRound(await mintOrgOwnerAuth(m.b.orgId), m.b.divisionId);
      const shown = panel!.boards.find((x) => x.fixtureId === m.b.fixtureId)!.flags;
      expect(shown, "the panel's number").toEqual([expect.objectContaining({ kind: "camera_connection_problems", seconds, stamps: 1 })]);
    });
  });

  it("a report NOT READY yet: nothing stored; the next pass, once final, settles it (the retry)", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    const ready = { now: false };
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]], ready });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    const first = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(first)).toEqual([]);
    expect(first.cameraSettled).toBe(0);
    expect(await settledAt(m.b.fixtureId), "not settled: the report is not final").toBeNull();
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    expect(rtkReads().some((c) => c.path.startsWith("/sessions/peer-report/")), "premise: the report WAS read").toBe(true);
    ready.now = true;
    const second = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + SWEEP_CADENCE_MS));
    expect(second.cameraSettled).toBe(1);
    expect((await flagsOf(m.b.fixtureId)).map((f) => f.person_id)).toEqual([m.b.home.personId]);
  });

  it("a session still LIVE is not ready either: nothing stored, retried", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, null, "LIVE");
    for (const side of ["home", "away"] as const) connect(m, x, side, { joined: m.startedAt - 90_000, left: m.endedAt });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(r.cameraSettled).toBe(0);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
  });

  it("a re-run writes NO second flag and reads nothing", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect((await flagsOf(m.b.fixtureId)).length, "premise: flagged once").toBe(1);
    rtk.calls = [];
    const again = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + SWEEP_CADENCE_MS));
    expect(again.cameraSettled).toBe(0);
    expect(again.cameraFlags).toBe(0);
    expect(rtkReads()).toEqual([]);
    expect((await flagsOf(m.b.fixtureId)).length).toBe(1);
  });

  it("two passes RACING the settle write one flag between them (staged on the meeting row) — x3", async () => {
    let checked = 0;
    for (let i = 0; i < 3; i++) {
      const m = await playedMatch();
      const x = session(m, m.startedAt - 120_000, m.endedAt);
      connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]] });
      connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let signalHeld!: (pid: number) => void;
      const held = new Promise<number>((resolve) => (signalHeld = resolve));
      const holder = sql.begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`select fixture_id from fixture_video_meetings where fixture_id = ${m.b.fixtureId} for update`;
        signalHeld(pid);
        await released;
      });
      const holderPid = await held;
      const now = after(m, CAMERA_EVIDENCE_AFTER_MS);
      // The pass lock (M8) off, so the settle's own claim is proven alone.
      const overlapping = () => sweep(m.b, { now, endMeeting: (id) => endMeeting(id, RTK), realtimeKit: RTK, serialise: false });
      const a = overlapping();
      const b = overlapping();
      // Both settles parked: the first behind the holder, the second behind
      // the first (a row lock's second waiter is blocked by the tuple lock's
      // holder, not by the transaction holding the row).
      const deadline = Date.now() + 30_000;
      for (;;) {
        const [{ n }] = await sql<{ n: number }[]>`
          with recursive behind(pid) as (
            select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
            union
            select a.pid from pg_stat_activity a join behind b on b.pid = any(pg_blocking_pids(a.pid))
          ) select count(*)::int as n from behind`;
        if (n >= 2) break;
        if (Date.now() > deadline) throw new Error(`premise: only ${n} settle(s) parked behind the holder`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await holder;
      const [ra, rb] = await Promise.all([a, b]);
      expect([...cameraFailures(ra), ...cameraFailures(rb)]).toEqual([]);
      expect(ra.cameraSettled + rb.cameraSettled, "exactly one pass settled").toBe(1);
      expect((await flagsOf(m.b.fixtureId)).length, "one flag").toBe(1);
      checked++;
    }
    expect(checked).toBe(3);
  }, 180_000);

  it("under 2 minutes after the room ended nothing is read; AT 2 minutes it is", async () => {
    const m = await playedMatch();
    bothOnThroughout(m);
    const early = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS - 1));
    expect(early.cameraSettled).toBe(0);
    expect(rtkReads()).toEqual([]);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    const at = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(at.cameraSettled).toBe(1);
  });

  // Review M4: the policy IN FORCE for the match — never the current one. D9
  // lets an organiser relax the requirement after a round opened (audited in
  // competition_events, the same transaction as the write), and a downgrade
  // after the match must not erase the evidence of a match played under
  // Required.
  /** The organiser relaxes the division through the REAL PATCH (D9 gate +
   *  audit row). */
  const relax = async (m: Match, to: CameraPolicy) => {
    await patchDivision(await mintOrgOwnerAuth(m.b.orgId), m.b.divisionId, { camera_policy: to });
  };
  const policyChanges = (m: Match) =>
    sql<{ id: string; created_at: Date }[]>`
      select id, created_at from competition_events
       where type = 'chess.camera_policy_changed' and payload->>'divisionId' = ${m.b.divisionId}
       order by created_at, id`;
  /** A home camera gap in the match, away on throughout. */
  const homeGap = (m: Match) => {
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
  };

  it("nothing is stored, and RealtimeKit never asked, when the policy IN FORCE at the match was not Required — relaxed before its first move, or optional all along (counted)", async () => {
    let checked = 0;
    for (const relaxTo of ["off", "optional"] as const) {
      const m = await playedMatch();
      homeGap(m);
      await relax(m, relaxTo);
      const changes = await policyChanges(m);
      expect(changes, `${relaxTo}: premise, the PATCH audited the change`).toHaveLength(1);
      // The match's clock runs 19 minutes in the past (playedMatch) while the
      // DB stamps the audit row now: moved to a minute before the first move,
      // it stands for a change the organiser made then.
      await sql`update competition_events set created_at = ${new Date(m.startedAt - 60_000)} where id = ${changes[0]!.id}`;
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(r.cameraFlags, relaxTo).toBe(0);
      expect(await flagsOf(m.b.fixtureId), relaxTo).toEqual([]);
      expect(rtkReads(), `${relaxTo}: no read`).toEqual([]);
      expect(await settledAt(m.b.fixtureId), `${relaxTo}: settled, so never re-read`).not.toBeNull();
      checked++;
    }
    // …and a board that was OPTIONAL all along (T8 seats it with a camera too).
    const m = await playedMatch({ policy: "optional" });
    bothOnThroughout(m);
    await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(rtkReads()).toEqual([]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    checked++;
    expect(checked).toBe(3);
  });

  it("M4: relaxed AFTER the match (a legal D9 downgrade): the match was played under Required, so it is still evidenced (counted)", async () => {
    let checked = 0;
    for (const relaxTo of ["off", "optional"] as const) {
      const m = await playedMatch();
      homeGap(m);
      await relax(m, relaxTo);
      const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
      expect(cameraFailures(r), relaxTo).toEqual([]);
      expect([r.cameraSettled, r.cameraFlags], relaxTo).toEqual([1, 1]);
      expect((await flagsOf(m.b.fixtureId)).map((f) => [f.kind, f.person_id]), relaxTo).toEqual([["camera_lost", m.b.home.personId]]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("M4: two downgrades after the match — the EARLIEST says what was in force, never the latest", async () => {
    const m = await playedMatch();
    homeGap(m);
    await relax(m, "optional");
    await relax(m, "off");
    const changes = await policyChanges(m);
    expect(changes, "premise: two audited changes").toHaveLength(2);
    // The second in TIME is inserted first in id order too often to trust:
    // pin the order on the sort key itself — the later change an hour later.
    await sql`update competition_events set created_at = created_at + interval '1 hour' where id = ${changes[1]!.id}`;
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 1]);
  });

  it("M4: a stage's OWN policy wins over any division change (the stage has no writer: set as data)", async () => {
    const m = await playedMatch();
    homeGap(m);
    // Stands for a stage policy present in the data — no product path writes one.
    await sql`update stages set camera_policy = 'optional' where id = ${m.b.stageId}`;
    await relax(m, "off"); // a division change after the match: beside the point
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 0]);
    expect(rtkReads(), "the stage says optional: nothing to read").toEqual([]);
  });

  /** Stands for a row a future writer left in a shape this reader does not
   *  know (no writer today leaves one: divisions.ts writes a resolved policy).
   *  Stamped by the DB's now(), so AFTER the match began. */
  async function corruptAudit(m: Match): Promise<void> {
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${m.b.divisionId}`;
    await sql`
      insert into competition_events (competition_id, type, payload, created_at)
      values (${competition_id}, 'chess.camera_policy_changed',
              ${sql.json({ divisionId: m.b.divisionId, effectiveFrom: "sometimes", effectiveTo: "off" })}, now())`;
  }

  it("M4: an audit row whose policy cannot be read is never guessed — a failure, nothing settled, read again next pass", async () => {
    const m = await playedMatch();
    homeGap(m);
    await corruptAudit(m);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r).map((f) => f.code)).toEqual(["CAMERA_POLICY_AUDIT_UNREADABLE"]);
    expect(r.cameraSettled).toBe(0);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  // Re-review N2: an unreadable audit row is one more not-ready answer, with
  // the same day's give-up — never a failure every pass for ever, never a
  // flag. One board's bad row is that board's alone: the pass goes on.
  it("N2: an unreadable policy audit gives up with the rest — AT the day a failure, nothing settled; past it settled with NO flag and SAID so; another match in the same pass completes", async () => {
    const bad = await playedMatch();
    homeGap(bad);
    await corruptAudit(bad);
    const good = await playedMatch();
    homeGap(good);
    // On the millisecond clock the sweep judges with (`ended_at` as a Date).
    const day = (ms: number) =>
      sweep([bad.b, good.b], {
        now: new Date(bad.endedAt + CAMERA_EVIDENCE_GIVE_UP_MS + ms), endMeeting: (id) => endMeeting(id, RTK), realtimeKit: RTK,
      });
    const atDay = await day(0);
    expect(cameraFailures(atDay), "AT the day: still a failure, read again").toEqual([
      { job: "camera_evidence", fixtureId: bad.b.fixtureId, code: "CAMERA_POLICY_AUDIT_UNREADABLE" },
    ]);
    expect(await settledAt(bad.b.fixtureId)).toBeNull();
    expect([atDay.cameraSettled, atDay.cameraFlags], "the other match settles, flagged, in the same pass").toEqual([1, 1]);
    expect(await settledAt(good.b.fixtureId), "premise: it was the good match that settled").not.toBeNull();
    expect((await flagsOf(good.b.fixtureId)).filter((f) => f.kind === "camera_lost")).toHaveLength(1);

    const late = await day(1);
    expect(cameraFailures(late)).toEqual([{ job: "camera_evidence", fixtureId: bad.b.fixtureId, code: "CAMERA_EVIDENCE_UNREAD" }]);
    expect([late.cameraSettled, late.cameraFlags]).toEqual([1, 0]);
    expect(await settledAt(bad.b.fixtureId)).not.toBeNull();
    expect(await flagsOf(bad.b.fixtureId), "never a flag on a policy nobody can read").toEqual([]);

    const again = await day(SWEEP_CADENCE_MS);
    expect([cameraFailures(again), again.cameraSettled], "settled: no failure for ever").toEqual([[], 0]);
  });

  // Review M2: "the players" are the guard's — each side's ONE member with a
  // user account (loadSides) — never every entrant member.
  /** Roster data as registration can leave it (SQL stands in for it): a
   *  member on `side`'s entrant, with a user account or without. */
  async function addMember(m: Match, side: Side, withUser: boolean): Promise<string> {
    const entrantId = (await sql<{ id: string }[]>`
      select ${side === "home" ? sql`home_entrant_id` : sql`away_entrant_id`} as id from fixtures where id = ${m.b.fixtureId}`)[0]!.id;
    const personId = withUser
      ? (await seedPlayer(m.b.orgId, "Second member", `extra-${randomUUID().slice(0, 6)}`, false)).personId
      : (await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${m.b.orgId}, 'Club volunteer') returning id`)[0]!.id;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${personId}, ${m.b.orgId})`;
    return personId;
  }

  it("M2: an entrant member with no user account is not a player — both on camera all match is NO flag", async () => {
    const m = await playedMatch();
    const extra = await addMember(m, "home", false);
    bothOnThroughout(m);
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 0]);
    expect((await flagsOf(m.b.fixtureId)).filter((f) => f.person_id === extra)).toEqual([]);
  });

  it("M2: a side the guard cannot name ONE player for (two members with accounts) is judged for nobody; the other side still is", async () => {
    const m = await playedMatch();
    const second = await addMember(m, "home", true);
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    const gaps: [number, number][] = [[m.startedAt + 200_000, m.startedAt + 400_000]];
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt, gaps });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    const flagged = (await flagsOf(m.b.fixtureId)).filter((f) => f.kind === "camera_lost").map((f) => f.person_id);
    expect(flagged, "away only: home's player is ambiguous").toEqual([m.b.away.personId]);
    expect(flagged).not.toContain(second);
  });

  // T15 fix round 1, M1 (an owner call): an override ends the video that
  // was expected — it never erases the evidence from BEFORE the press. Job 5
  // judges [first move, the press]. organiserOverrideVideo (the real writer,
  // through `override: true`) stamps the DB's now(), which in this fixture's
  // compressed timeline lies after the game; each test moves that stamp to
  // the minute the organiser pressed.
  it("M1: an organiser's video override (D11) is judged UP TO the press — off before it is camera_lost, off after it is not", async () => {
    const m = await playedMatch({ override: true });
    const press = m.startedAt + 300_000;
    expect(press + 200_000, "premise: the second gap is inside the game, after the press").toBeLessThan(m.overAt);
    await sql`update fixture_external_play set video_override_at = ${new Date(press)} where fixture_id = ${m.b.fixtureId}`;
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 100_000, m.startedAt + 200_000]] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[press + 100_000, press + 200_000]] });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([]);
    expect([r.cameraSettled, r.cameraFlags]).toEqual([1, 1]);
    const flags = await flagsOf(m.b.fixtureId);
    expect(flags.map((f) => [f.kind, f.person_id]), "home's gap was before the press; away's after it").toEqual([["camera_lost", m.b.home.personId]]);
    expect(flags[0]!.note).toContain(`of ${Math.round((press - m.startedAt) / 1000)} s in the match`);
  });

  it("M1: the press BEFORE the first move — no video was expected at any point: settled, nothing read, nothing stored", async () => {
    const m = await playedMatch({ override: true });
    await sql`update fixture_external_play set video_override_at = ${new Date(m.startedAt - 60_000)} where fixture_id = ${m.b.fixtureId}`;
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]] });
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(rtkReads()).toEqual([]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    expect(r.cameraSettled).toBe(1);
  });

  it("a game that never STARTED has no match to evidence: settled, nothing read", async () => {
    const m = await playedMatch({ start: false });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(rtkReads()).toEqual([]);
    expect(r.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("only the MATCH counts: the camera off before the first move is not a loss", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 300_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 280_000, left: m.endedAt, gaps: [[m.startedAt - 250_000, m.startedAt - 10_000]] });
    connect(m, x, "away", { joined: m.startedAt - 280_000, left: m.endedAt });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(r.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  // Ruling I2: an unreadable answer is never the negative one. T8 seated
  // both players only on a LIVE video publisher, so a list that shows a
  // seated player nowhere contradicts our own record — not ready, retried.
  it("an EMPTY session list is NOT 'camera off': nothing stored, retried; a day on, settled with NO flag and SAID so", async () => {
    const m = await playedMatch();
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(rtkReads().map((c) => c.path), "premise: the list was read, and was empty").toEqual(["/sessions"]);
    expect([r.cameraSettled, r.cameraFlags, cameraFailures(r)]).toEqual([0, 0, []]);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    const late = await pass(m, new Date(m.endedAt + CAMERA_EVIDENCE_GIVE_UP_MS + 1));
    expect(cameraFailures(late)).toEqual([{ job: "camera_evidence", fixtureId: m.b.fixtureId, code: "CAMERA_EVIDENCE_UNREAD" }]);
    expect(late.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("…an empty list is no evidence about ANYONE — players with no camera participant included (the per-player guard cannot see this)", async () => {
    const m = await playedMatch();
    // Stands for seats with no camera row (the guard test below explains it):
    // with nobody seated, only the list's own emptiness can say "not ready".
    await sql`delete from fixture_video_participants where fixture_id = ${m.b.fixtureId}`;
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([r.cameraSettled, r.cameraFlags, cameraFailures(r)]).toEqual([0, 0, []]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("sessions that never overlap the MATCH are an empty list too: not ready", async () => {
    const m = await playedMatch();
    const pre = session(m, m.startedAt - 600_000, m.startedAt - 300_000);
    for (const side of ["home", "away"] as const) connect(m, pre, side, { joined: m.startedAt - 590_000, left: m.startedAt - 300_000 });
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([r.cameraSettled, r.cameraFlags, cameraFailures(r)]).toEqual([0, 0, []]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("a SEATED player no session shows (zero camera connections) is not ready — never 'off for the whole match'; once listed, settled", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt });
    const first = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect([first.cameraSettled, first.cameraFlags, cameraFailures(first)]).toEqual([0, 0, []]);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    // The list catches up: away's camera, on all match.
    connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt });
    const next = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + SWEEP_CADENCE_MS));
    expect([next.cameraSettled, next.cameraFlags]).toEqual([1, 0]);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("a player with no camera PARTICIPANT at all is still evidenced: off for the whole match", async () => {
    // Stands for a seat that never registered a camera — T8 cannot seat a
    // Required player without one, so this is the guard: a player missing
    // from the camera rows is never silently "fine".
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt });
    await sql`delete from fixture_video_participants where fixture_id = ${m.b.fixtureId} and participant_id = ${m.part.away}`;
    await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    const flags = await flagsOf(m.b.fixtureId);
    expect(flags.map((f) => f.person_id)).toEqual([m.b.away.personId]);
    expect(flags[0]!.note).toContain(`${iso(m.startedAt)} to ${iso(m.overAt)}`);
  });

  it("a session that ENDED before the first move is not the match: never read", async () => {
    const m = await playedMatch();
    // The preflight room: everyone left before the game began…
    const pre = session(m, m.startedAt - 600_000, m.startedAt - 300_000);
    for (const side of ["home", "away"] as const) connect(m, pre, side, { joined: m.startedAt - 590_000, left: m.startedAt - 300_000, ready: { now: false } });
    // …and the match's own session.
    const x = bothOnThroughout(m, session(m, m.startedAt - 120_000, m.endedAt));
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(r.cameraSettled, "a stale report outside the match never holds the evidence up").toBe(1);
    expect(rtkReads().some((c) => c.path.includes(pre.id)), "the pre-match session is not read").toBe(false);
    expect(rtkReads().some((c) => c.path.includes(x.id)), "premise: the match's session is").toBe(true);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
  });

  it("the sequence property: passes at any time, reports turning final, an outage — one settle, the flag the truth owes, never a read after it (model) — counted per path, K runs each", { timeout: 600_000 }, async () => {
    type Act = { kind: "pass"; dtMs: number } | { kind: "ready"; side: Side } | { kind: "outage" };
    const HOUR = 3_600_000;
    const P = (dtMs: number): Act => ({ kind: "pass", dtMs });
    const R = (side: Side): Act => ({ kind: "ready", side });
    const OUTAGE: Act = { kind: "outage" };
    const actArb: fc.Arbitrary<Act> = fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom(30_000, CAMERA_EVIDENCE_AFTER_MS, SWEEP_CADENCE_MS, 6 * HOUR, 20 * HOUR).map(P) },
      { weight: 2, arbitrary: fc.constantFrom<Side>("home", "away").map(R) },
      { weight: 1, arbitrary: fc.constant(OUTAGE) },
    );
    // Each prefix ENDS with its claim; each runs K times, then a random suffix.
    const PATHS = {
      early_nothing_read: [R("home"), R("away"), P(CAMERA_EVIDENCE_AFTER_MS - 1)],
      not_ready_waits: [R("away"), P(CAMERA_EVIDENCE_AFTER_MS)],
      ready_flags_the_off_player: [R("home"), R("away"), P(CAMERA_EVIDENCE_AFTER_MS)],
      outage_retried: [R("home"), R("away"), OUTAGE, P(CAMERA_EVIDENCE_AFTER_MS)],
      given_up_unread: [P(20 * HOUR), P(6 * HOUR)],
      settled_never_reread: [R("home"), R("away"), P(CAMERA_EVIDENCE_AFTER_MS), P(SWEEP_CADENCE_MS)],
    } satisfies Record<string, Act[]>;
    type PathName = keyof typeof PATHS;
    const PATH_NAMES = Object.keys(PATHS) as PathName[];
    const K = 3;
    const claims = Object.fromEntries(PATH_NAMES.map((p) => [p, 0])) as Record<PathName, number>;
    const counters = { passes: 0, early: 0, not_ready: 0, flagged: 0, outage_failed: 0, unread: 0, settled_skip: 0, readies: 0 };
    type Facts = { reads: boolean; settledNow: 0 | 1; flags: number; failure: string | null };
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(actArb, { minLength: 0, maxLength: 6 }), async (suffix) => {
        const path = PATH_NAMES[run % PATH_NAMES.length]!;
        run++;
        // A run's unconsumed outage (one scripted after its settle) must not
        // leak into the next run: the fake's state is per-test, runs are not.
        rtk.sessionsFail = 0;
        const m = await playedMatch();
        const x = session(m, m.startedAt - 120_000, m.endedAt);
        const ready: Record<Side, { now: boolean }> = { home: { now: false }, away: { now: false } };
        // The truth: home's camera was off 200 s mid-match; away's never.
        connect(m, x, "home", { joined: m.startedAt - 90_000, left: m.endedAt, gaps: [[m.startedAt + 200_000, m.startedAt + 400_000]], ready: ready.home });
        connect(m, x, "away", { joined: m.startedAt - 90_000, left: m.endedAt, ready: ready.away });
        const jm = { t: 0, settled: null as null | "flag" | "unread", outage: false };
        let last: Facts | null = null;
        const acts = [...PATHS[path], ...suffix];
        for (let i = 0; i < acts.length; i++) {
          const a = acts[i]!;
          const label = `${path} #${run} step ${i} ${JSON.stringify(a)}`;
          if (a.kind === "ready") {
            ready[a.side].now = true;
            counters.readies++;
          } else if (a.kind === "outage") {
            rtk.sessionsFail = 1;
            jm.outage = true;
          } else {
            jm.t += a.dtMs;
            counters.passes++;
            const givenUp = m.endedCeil + jm.t - m.endedAt > CAMERA_EVIDENCE_GIVE_UP_MS;
            const f: Facts = { reads: false, settledNow: 0, flags: 0, failure: null };
            if (jm.settled !== null) counters.settled_skip++;
            else if (jm.t < CAMERA_EVIDENCE_AFTER_MS) counters.early++;
            else {
              f.reads = true;
              if (jm.outage) {
                jm.outage = false;
                if (givenUp) {
                  jm.settled = "unread"; f.settledNow = 1; f.failure = "CAMERA_EVIDENCE_UNREAD"; counters.unread++;
                } else {
                  f.failure = "unavailable"; counters.outage_failed++;
                }
              } else if (ready.home.now && ready.away.now) {
                jm.settled = "flag"; f.settledNow = 1; f.flags = 1; counters.flagged++;
              } else if (givenUp) {
                jm.settled = "unread"; f.settledNow = 1; f.failure = "CAMERA_EVIDENCE_UNREAD"; counters.unread++;
              } else counters.not_ready++;
            }
            rtk.calls = [];
            const report = await pass(m, new Date(m.endedCeil + jm.t));
            expect(rtkReads().length > 0, `${label}: read RealtimeKit`).toBe(f.reads);
            expect({ settled: report.cameraSettled, flags: report.cameraFlags }, `${label}: report`).toEqual({ settled: f.settledNow, flags: f.flags });
            expect(cameraFailures(report).map((x) => x.code), `${label}: failures`).toEqual(f.failure === null ? [] : [f.failure]);
            expect((await settledAt(m.b.fixtureId)) !== null, `${label}: settled`).toBe(jm.settled !== null);
            expect((await flagsOf(m.b.fixtureId)).map((x) => [x.kind, x.person_id]), `${label}: flags`).toEqual(
              jm.settled === "flag" ? [["camera_lost", m.b.home.personId]] : [],
            );
            last = f;
          }
          if (i === PATHS[path].length - 1) {
            const ok = (() => {
              switch (path) {
                case "early_nothing_read": return last !== null && !last.reads && jm.settled === null;
                case "not_ready_waits": return last?.reads === true && last.settledNow === 0 && last.failure === null && jm.settled === null;
                case "ready_flags_the_off_player": return last?.settledNow === 1 && jm.settled === "flag";
                case "outage_retried": return last?.failure === "unavailable" && jm.settled === null;
                case "given_up_unread": return last?.failure === "CAMERA_EVIDENCE_UNREAD" && jm.settled === "unread";
                case "settled_never_reread": return last?.reads === false && jm.settled === "flag";
              }
            })();
            expect(ok, `${label}: the path's claim`).toBe(true);
            claims[path]++;
          }
        }
      }),
      { numRuns: PATH_NAMES.length * K },
    );
    expect(claims, "claims per path").toEqual(Object.fromEntries(PATH_NAMES.map((p) => [p, K])));
    for (const [name, n] of Object.entries(counters)) expect(n, `counter ${name}`).toBeGreaterThan(0);
    writeSync(1, `camera property: ${JSON.stringify({ runs: run, claims, counters })}\n`);
  });

  it("RealtimeKit down: a failure, nothing stored, read again next pass", async () => {
    const m = await playedMatch();
    bothOnThroughout(m);
    rtk.sessionsFail = 1;
    const r = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS));
    expect(cameraFailures(r)).toEqual([{ job: "camera_evidence", fixtureId: m.b.fixtureId, code: "unavailable" }]);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    const next = await pass(m, after(m, CAMERA_EVIDENCE_AFTER_MS + SWEEP_CADENCE_MS));
    expect(cameraFailures(next)).toEqual([]);
    expect(next.cameraSettled).toBe(1);
  });

  it("evidence never ready after a day: settled with no flag, and SAID so (no endless re-read)", async () => {
    const m = await playedMatch();
    const x = session(m, m.startedAt - 120_000, m.endedAt);
    for (const side of ["home", "away"] as const) {
      connect(m, x, side, { joined: m.startedAt - 90_000, left: m.endedAt, ready: { now: false } });
    }
    // On the millisecond clock the sweep judges with (`ended_at` as a Date).
    const before = await pass(m, new Date(m.endedAt + CAMERA_EVIDENCE_GIVE_UP_MS));
    expect(before.cameraSettled, "AT the day: still retrying").toBe(0);
    expect(await settledAt(m.b.fixtureId)).toBeNull();
    const late = await pass(m, new Date(m.endedAt + CAMERA_EVIDENCE_GIVE_UP_MS + 1));
    expect(cameraFailures(late)).toEqual([{ job: "camera_evidence", fixtureId: m.b.fixtureId, code: "CAMERA_EVIDENCE_UNREAD" }]);
    expect(late.cameraSettled).toBe(1);
    expect(await flagsOf(m.b.fixtureId)).toEqual([]);
    rtk.calls = [];
    await pass(m, after(m, CAMERA_EVIDENCE_GIVE_UP_MS + SWEEP_CADENCE_MS));
    expect(rtkReads(), "settled: never read again").toEqual([]);
  });
});

describe.runIf(HAS_DB)("job 6 — the arbiter watches the server removes (I2)", () => {
  /** The panel's REAL join, its RealtimeKit calls through the adapter over
   *  this file's fake fetch. */
  const VIDEO: ArbiterVideo = {
    ensureMeeting: (fixtureId) => ensureMeeting(fixtureId, RTK),
    addParticipant: (a) => addParticipant(a, RTK),
    removeParticipant: (a) => removeParticipant(a, RTK),
  };
  /** A live game (T9 + T10, so the room is kept by teardown) watched by a
   *  second admin of the club through the real join. */
  async function watched(): Promise<{ b: Board; userId: string; participantId: string; meetingId: string; createdAt: number }> {
    const b = await openedBoard({ checkedIn: ["home", "away"], cameraPolicy: "optional" });
    await liveGame(b);
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${`arb-${randomUUID().slice(0, 8)}@t.local`}, 'Arbiter', true, 'en') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${u!.id}, 'admin')`;
    const out = await joinAsArbiter(
      { orgId: b.orgId, via: "session", userId: u!.id, role: "admin", keyId: null },
      b.fixtureId,
      { video: VIDEO },
    );
    const [row] = await sql<{ created_at: Date; meeting_id: string }[]>`
      select vp.created_at, m.meeting_id from fixture_video_participants vp
        join fixture_video_meetings m on m.fixture_id = vp.fixture_id
       where vp.participant_id = ${out.participantId}`;
    rtk.calls = [];
    return { b, userId: u!.id, participantId: out.participantId, meetingId: row!.meeting_id, createdAt: row!.created_at.getTime() };
  }
  /** No Lichess read (the game stays live, so the room stays up); RealtimeKit is the fake. */
  const quiet: Pick<SweepDeps, "reconcile" | "realtimeKit"> = { reconcile: async () => null, realtimeKit: RTK };
  const removedAt = async (participantId: string) => {
    const [r] = await sql<{ removed_at: Date | null }[]>`
      select removed_at from fixture_video_participants where participant_id = ${participantId}`;
    return r!.removed_at;
  };
  const removals = () => rtk.calls.filter((c) => c.path.endsWith("/active-session/kick") || c.method === "DELETE");

  it("the empty case first: no watch — nothing removed, nothing called; a watch in use by an organiser is kept", async () => {
    const bare = await openedBoard({ checkedIn: ["home", "away"], cameraPolicy: "optional" });
    await liveGame(bare);
    rtk.calls = [];
    const none = await sweep(bare, { now: bare.at(8), ...quiet });
    expect([none.arbitersRemoved, removals()]).toEqual([0, []]);
    const w = await watched();
    const kept = await sweep(w.b, { now: new Date(w.createdAt + 60_000), ...quiet });
    expect(kept.arbitersRemoved).toBe(0);
    expect(kept.failures).toEqual([]);
    expect(removals()).toEqual([]);
    expect(await removedAt(w.participantId)).toBeNull();
  });

  it("every reason the watch must end is removed at the vendor and stamped — one board each, counted; a second pass changes nothing", async () => {
    const REASONS: [string, (w: Awaited<ReturnType<typeof watched>>) => Promise<void>][] = [
      ["demoted to viewer", async (w) => void (await sql`update org_members set role = 'viewer' where org_id = ${w.b.orgId} and user_id = ${w.userId}`)],
      ["left the club", async (w) => void (await sql`delete from org_members where org_id = ${w.b.orgId} and user_id = ${w.userId}`)],
      ["account deleted (M5: the watch keeps no user)", async (w) => void (await sql`delete from users where id = ${w.userId}`)],
      [
        "now plays on the board (a check-in under a person linked to them)",
        async (w) => {
          const [p] = await sql<{ id: string }[]>`
            insert into persons (org_id, full_name, user_id) values (${w.b.orgId}, 'Late sub', ${w.userId}) returning id`;
          await stampFixtureCheckIn(p!.id, w.b.fixtureId, w.b.orgId);
        },
      ],
    ];
    let checked = 0;
    for (const [why, change] of REASONS) {
      const w = await watched();
      await change(w);
      const pass = new Date(w.createdAt + 60_000);
      const r = await sweep(w.b, { now: pass, ...quiet });
      expect([r.arbitersRemoved, r.failures], why).toEqual([1, []]);
      expect(removals(), why).toEqual([
        { method: "POST", path: `/meetings/${w.meetingId}/active-session/kick` },
        { method: "DELETE", path: `/meetings/${w.meetingId}/participants/${w.participantId}` },
      ]);
      expect((await removedAt(w.participantId))?.getTime(), why).toBe(pass.getTime());
      rtk.calls = [];
      const again = await sweep(w.b, { now: new Date(pass.getTime() + 5 * 60_000), ...quiet });
      expect([again.arbitersRemoved, removals()], `${why}: again`).toEqual([0, []]);
      checked++;
    }
    expect(checked, "anti-vacuity: every reason").toBe(REASONS.length);
  });

  it("the TTL: kept one millisecond before ARBITER_PARTICIPANT_TTL_MS, removed at it", async () => {
    expect(ARBITER_PARTICIPANT_TTL_MS, "the brief's 3 hours").toBe(3 * 60 * 60 * 1000);
    const w = await watched();
    const before = await sweep(w.b, { now: new Date(w.createdAt + ARBITER_PARTICIPANT_TTL_MS - 1), ...quiet });
    expect([before.arbitersRemoved, removals()]).toEqual([0, []]);
    const at = await sweep(w.b, { now: new Date(w.createdAt + ARBITER_PARTICIPANT_TTL_MS), ...quiet });
    expect(at.arbitersRemoved).toBe(1);
    expect(removals().map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(await removedAt(w.participantId)).not.toBeNull();
  });

  it("a vendor failure is reported by code and the watch stays OPEN; the next pass removes it", async () => {
    const w = await watched();
    await sql`update org_members set role = 'viewer' where org_id = ${w.b.orgId} and user_id = ${w.userId}`;
    rtk.removeFails = 1;
    const failed = await sweep(w.b, { now: new Date(w.createdAt + 60_000), ...quiet });
    expect(failed.arbitersRemoved).toBe(0);
    expect(failed.failures).toEqual([{ job: "arbiter_revoke", fixtureId: w.b.fixtureId, code: "unavailable" }]);
    expect(await removedAt(w.participantId)).toBeNull();
    const retried = await sweep(w.b, { now: new Date(w.createdAt + 6 * 60_000), ...quiet });
    expect([retried.arbitersRemoved, retried.failures]).toEqual([1, []]);
    expect(await removedAt(w.participantId)).not.toBeNull();
  });

  it("a watch whose room already ended (no stamp on file) is stamped with no vendor call — INACTIVE keeps every token out", async () => {
    // Still an admin, a minute old, not seated: the ended room is the ONLY reason.
    const w = await watched();
    await sql`update fixture_video_meetings set ended_at = now() where meeting_id = ${w.meetingId}`;
    const r = await sweep(w.b, { now: new Date(w.createdAt + 60_000), ...quiet });
    expect([r.arbitersRemoved, removals()]).toEqual([1, []]);
    expect(await removedAt(w.participantId)).not.toBeNull();
  });

  it("SEQUENCE: a teardown in the same pass ends the watch with the room — the job then has nothing to remove", async () => {
    // No game on file: past T+20 the room comes down (job 3) before job 6 runs.
    const b = await openedBoard({ checkedIn: ["home"], cameraPolicy: "optional" });
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, locale)
      values (${`arb-${randomUUID().slice(0, 8)}@t.local`}, 'Arbiter', true, 'en') returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${u!.id}, 'admin')`;
    const out = await joinAsArbiter({ orgId: b.orgId, via: "session", userId: u!.id, role: "admin", keyId: null }, b.fixtureId, { video: VIDEO });
    await sql`update org_members set role = 'viewer' where org_id = ${b.orgId} and user_id = ${u!.id}`;
    rtk.calls = [];
    const r = await sweep(b, { now: b.at(45), endMeeting: (m) => endMeeting(m, RTK), ...quiet });
    expect(r.meetingsEnded, "premise: the room came down in this pass").toBe(1);
    expect([r.arbitersRemoved, removals()]).toEqual([0, []]);
    const [row] = await sql<{ removed_at: Date | null; ended_at: Date | null }[]>`
      select vp.removed_at, m.ended_at from fixture_video_participants vp
        join fixture_video_meetings m on m.fixture_id = vp.fixture_id
       where vp.participant_id = ${out.participantId}`;
    expect(row!.removed_at?.getTime(), "the watch ended with the room").toBe(row!.ended_at?.getTime());
  });
});

describe("the sweep's own hold reasons have organiser copy in all four locales (C2, I3)", () => {
  it("each locale carries its own sentence per reason, distinct from the generic and no-show labels — counted", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../dictionaries");
    const LOCALES = ["en", "es", "fr", "nl"] as const;
    const KEYS = ["externalPlay.reason.notStarted", "externalPlay.reason.createOutcomeUnknown"] as const;
    const read = (l: string) => JSON.parse(readFileSync(join(dir, l, "ui.json"), "utf8")) as Record<string, string>;
    const en = read("en");
    let checked = 0;
    for (const key of KEYS) {
      for (const l of LOCALES) {
        const d = read(l);
        const text = d[key];
        expect(text, `${key} ${l}: present`).toBeTruthy();
        expect(text, `${key} ${l}: not the generic label`).not.toBe(d["externalPlay.reason.generic"]);
        expect(text, `${key} ${l}: not the no-show label (both players came)`).not.toBe(d["externalPlay.reason.noShow"]);
        for (const other of KEYS) if (other !== key) expect(text, `${key} ${l}: not ${other}`).not.toBe(d[other]);
        if (l !== "en") expect(text, `${key} ${l}: translated, not English`).not.toBe(en[key]);
        checked++;
      }
    }
    expect(checked, "key × locale checked").toBe(KEYS.length * LOCALES.length);
  });
});
