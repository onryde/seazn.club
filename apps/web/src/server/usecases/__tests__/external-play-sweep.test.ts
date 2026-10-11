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
import { EngineError, foldMatch } from "@seazn/engine/core";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { makeEnvelope } from "@seazn/engine/testkit";
import { sql } from "@/lib/db";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { DEADLINE_AFTER_MS, roomPhase, windowFor } from "@/server/external-play/window";
import { stampFixtureCheckIn } from "../me";
import { openRound } from "../external-play/open-round";
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
  refuse: null as null | ((fixtureId: string, input: { type: string; payload: unknown }) => Error | null),
}));
vi.mock("@/server/usecases/scoring", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/scoring")>();
  return {
    ...real,
    scoreEvent: async (...args: Parameters<typeof real.scoreEvent>) => {
      const [auth, fixtureId, input] = args;
      scoring.calls.push({ fixtureId, input: input as ScoreCall["input"], auth: auth as ScoreCall["auth"] });
      const refused = scoring.refuse?.(fixtureId, input as { type: string; payload: unknown }) ?? null;
      if (refused) throw refused;
      return real.scoreEvent(...args);
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  lichess.reset();
  scoring.calls = [];
  scoring.refuse = null;
  // Realtime pushes go nowhere: publishRoomBroadcast / the lobby push return
  // at once without these two.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
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
async function openedBoard(o: { checkedIn: readonly Side[]; kind?: string } = { checkedIn: [] }): Promise<Board> {
  const opened = new Date(Date.now() - 60_000);
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
