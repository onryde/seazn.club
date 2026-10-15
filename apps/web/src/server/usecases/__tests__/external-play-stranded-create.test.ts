// T17B fix 2, D21-fix-3 (F2) - the stranded board, driven end to end through the REAL room claim, the REAL seat, the REAL
// RealtimeKit adapter (against the e2e fixture vendor, metered by the real database bucket) and the REAL sweep.
//
// D22 found it: under the platform's call budget the re-verify T9 runs immediately before it creates the game asked the
// vendor for a token and three reads per player, and the budget refused them. The refusal made the seat answer
// `camera_starting`, T9 answered "not ready", and nothing ever came back for the board: both players were checked in,
// seated, with a camera, and no game. Three rulings, each witnessed here by the sequence and not by its parts:
//
//   (a) T9's re-verify spends no token and trusts a camera read ON a moment ago (preflight SEAT_RECHECK_TRUST_MS);
//   (b) a board with both players in and no game in flight is the sweep's to create (sweep.ts, job 2, second arm);
//   (c) a deferral is not a failure of the board: it writes no last_error and takes no claim.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by
// the guard before any of this is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { budgetKey } from "@/server/external-play/video/budget";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";

// The Lichess Board API is module-mocked, as in the create-game suite: T9 consumes its functions directly.
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

import { createGameIfReady, type CreateOutcome } from "../external-play/create-game";
import { claimRoomSeat } from "../external-play/room";
import { seatPlayer, SEAT_RECHECK_TRUST_MS, type SeatResult } from "../external-play/preflight";
import { STRANDED_CREATE_AFTER_MS, __retryCandidates, sweepExternalPlay } from "../external-play/sweep";
import { stampFixtureCheckIn } from "../me";
import { seedOnlineChessFixture } from "./_external-play-seed";

const DB = !!process.env.DATABASE_URL;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end();
});

const bucketKey = () => budgetKey(fx.url, REALTIMEKIT_FIXTURE_ENV.CLOUDFLARE_ACCOUNT_ID);
/** The platform's budget spent: no token, and a refill stamp in the future so no time passes into one. */
const drain = () => sql`
  insert into realtimekit_call_budget (key, tokens, refilled_at) values (${bucketKey()}, 0, now() + interval '1 hour')
  on conflict (key) do update set tokens = 0, refilled_at = now() + interval '1 hour'`;
/** The budget back: no row is a bucket nobody has asked about, which is made full. */
const refill = () => sql`delete from realtimekit_call_budget where key = ${bucketKey()}`;
const bucketTokens = async () =>
  (await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${bucketKey()}`)[0]?.tokens ?? null;

beforeEach(async () => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  // The fixture's host is not Cloudflare's, so it is metered only on request (realtimekit.ts cfEnvelope).
  vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
  vi.clearAllMocks();
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: `gm-${randomUUID().slice(0, 12)}` });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
  await refill();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await refill();
});

async function seed() {
  const opened = new Date(Date.now() - 5 * 60_000);
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    cameraPolicy: "required",
    clock: { base: 300, increment: 3 },
  });
  // The board's bridge row, as the guard makes it on a board's first touch (guard.ts): pending, no game, no error. With it
  // on file a deferral that wrote an error (or took a claim) would show; with none, an UPDATE would find nothing to write.
  await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis) values (${s.fixtureId}, ${s.orgId}, now())`;
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type Side = "home" | "away";

const identity = (s: Seeded, side: Side) => ({ kind: "session" as const, userId: s[side].userId });
const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);

/** The row the bridge keeps for the board - or null when it has none. */
async function bridge(fixtureId: string) {
  const [row] = await sql<
    {
      status: string;
      challenge_id: string | null;
      last_error: string | null;
      mint_claimed_at: Date | null;
      create_sent_at: Date | null;
      needs_reason: string | null;
    }[]
  >`select status, challenge_id, last_error, mint_claimed_at, create_sent_at, needs_reason from fixture_external_play where fixture_id = ${fixtureId}`;
  return row ?? null;
}
const quiet = (row: Awaited<ReturnType<typeof bridge>>) =>
  row !== null && (row.status === "pending" && row.challenge_id === null && row.last_error === null && row.mint_claimed_at === null && row.create_sent_at === null);

/** The room, as a player's browser drives it: a claim, the camera joins with the token it was handed, the next claim. */
async function checkIn(s: Seeded, side: Side, deps: Parameters<typeof claimRoomSeat>[2] = {}) {
  const at = deps.now ?? new Date();
  const base = { now: at, publish: async () => {}, mintRealtime: async () => "rt-token", ...deps };
  const first = await claimRoomSeat(identity(s, side), s.fixtureId, base);
  expect(first.seat && !first.seat.seated && first.seat.reason, `${side}: premise - the first claim is the way in`).toBe("camera_required");
  const pid = first.seat && "participant" in first.seat ? first.seat.participant?.participantId : undefined;
  expect(pid, `${side}: premise - handed its own token`).toBeTruthy();
  fx.setLivePublisher(pid!, true, { camera: "on" }); // the browser joined with the camera on
  const second = await claimRoomSeat(identity(s, side), s.fixtureId, base, { heldParticipantId: pid! });
  return { pid: pid!, second };
}

const sweepNow = (s: Seeded, afterMs: number) =>
  sweepExternalPlay({
    now: new Date(Date.now() + afterMs),
    orgIds: [s.orgId],
    serialise: false,
    // The pass reads the Lichess game of a ready board and tears down ended rooms; neither is this suite's subject.
    reconcile: async () => null,
    endMeeting: async () => {},
  });

describe.skipIf(!DB)("a create the budget deferred is never stranded (D21-fix-3, F2)", () => {
  it("THE SEQUENCE: both check in, the budget is spent at the create -> no game, nothing written -> the sweep creates it, once", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const deferrals = () => info.mock.calls.filter((c) => /RealtimeKit call budget spent; the seat answered camera_starting/.test(String(c[1]))).length;
    const s = await seed();

    // Home checked in a while ago (its pass is older than the re-verify trusts), and its claim made a game that was never due.
    const home = await checkIn(s, "home");
    expect(home.second.seat?.seated, "premise: home is seated").toBe(true);
    expect(home.second.create, "premise: away has not come, so no create was asked").toBeNull();
    await sql`
      update fixture_video_participants set last_publisher_seen_at = now() - ${SEAT_RECHECK_TRUST_MS + 1_000} * interval '1 millisecond'
       where fixture_id = ${s.fixtureId} and participant_id = ${home.pid}`;

    // Away checks in; the platform's budget is spent the instant before the create's re-verify, as D22 saw at thirty boards.
    const created: CreateOutcome[] = [];
    const away = await checkIn(s, "away", {
      create: async (id: string) => {
        await drain();
        const out = await createGameIfReady(id, { now: new Date() });
        created.push(out);
        return out;
      },
    });
    expect(away.second.seat?.seated, "premise: away is seated - its own read came before the budget ran out").toBe(true);
    expect(created, "premise: the create was asked once, and could not afford home's re-verify").toEqual([{ created: false, reason: "not_ready" }]);
    expect(await bucketTokens(), "premise: the bucket really was empty").toBe(0);
    expect(deferrals(), "the deferral left its one log line").toBe(1);

    // (c) A deferral is no failure of the board: no error on file, no claim held, nothing sent to Lichess.
    const afterDeferral = await bridge(s.fixtureId);
    expect(quiet(afterDeferral), `(c) the deferral wrote nothing: ${JSON.stringify(afterDeferral)}`).toBe(true);
    expect(board.createChallengeToUser, "no game was made at Lichess").not.toHaveBeenCalled();

    // The budget is back. Inside the grace the check-in is still fresh (the room may be making the create itself): the sweep waits.
    await refill();
    const early = await sweepNow(s, STRANDED_CREATE_AFTER_MS - 5_000);
    expect(early.mintRetries, "inside the grace the sweep leaves the board to the room").toBe(0);
    expect(board.createChallengeToUser).not.toHaveBeenCalled();

    // (b) Past it, the board with both players in and no game is the sweep's: it creates the game.
    const report = await sweepNow(s, STRANDED_CREATE_AFTER_MS + 10_000);
    expect(report.failures, "the pass failed nothing").toEqual([]);
    expect(report.mintRetries, "the sweep made the create the room could not").toBe(1);
    const row = await bridge(s.fixtureId);
    expect(row, "a game is on file").toMatchObject({ status: "ready", last_error: null, needs_reason: null });
    expect(row?.challenge_id, "the Lichess game id").toBeTruthy();
    expect(board.createChallengeToUser, "exactly one challenge").toHaveBeenCalledTimes(1);
    expect(board.acceptChallenge).toHaveBeenCalledTimes(1);

    // The sequence's second call: nothing more to make, nothing made.
    const again = await sweepNow(s, STRANDED_CREATE_AFTER_MS + 40_000);
    expect(again.mintRetries, "a board with a game is not retried").toBe(0);
    expect(board.createChallengeToUser, "still exactly one challenge").toHaveBeenCalledTimes(1);
  });

  it("(a) the re-verify spends NO token and, for a pass read a moment ago, no call at all - the create goes through on an empty budget", async () => {
    const s = await seed();
    const home = await checkIn(s, "home");
    expect(home.second.seat?.seated).toBe(true);
    // Away's seating claim: its read (3) and its token (1) come first; then the budget is spent for the create.
    let bucketAtCreate: number | null = null;
    const away = await checkIn(s, "away", {
      create: async (id: string) => {
        await drain();
        bucketAtCreate = await bucketTokens();
        const calls = fx.calls.length;
        const out = await createGameIfReady(id, { now: new Date() });
        expect(fx.calls.length - calls, "the re-verify of two passes read a moment ago made no vendor call").toBe(0);
        return out;
      },
    });
    expect(bucketAtCreate, "premise: the budget was empty at the create").toBe(0);
    expect(away.second.create, "created on an empty budget: nothing to defer").toMatchObject({ created: true });
    expect(await bridge(s.fixtureId)).toMatchObject({ status: "ready" });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
  });

  it("(c) a create deferred at BOTH players writes nothing, holds nothing, and the next call - budget back, a second on - creates the game", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const deferrals = () => info.mock.calls.filter((c) => /RealtimeKit call budget spent; the seat answered camera_starting/.test(String(c[1]))).length;
    const s = await seed();
    // Both players have the way in and a camera on, but neither has ever been read (no pass on file to trust).
    const pids = new Map<Side, string>();
    for (const side of ["home", "away"] as const) {
      const first = await seatPlayer({ fixtureId: s.fixtureId, personId: s[side].personId }, { now: new Date() });
      expect(reasonOf(first), `${side}: premise - minted`).toBe("camera_required");
      const pid = "participant" in first && first.participant ? first.participant.participantId : "";
      expect(pid).toBeTruthy();
      fx.setLivePublisher(pid, true, { camera: "on" });
      pids.set(side, pid);
      await stampFixtureCheckIn(s[side].personId, s.fixtureId, s.orgId);
    }
    await drain();
    const t0 = new Date();
    const calls = fx.calls.length;
    expect(await createGameIfReady(s.fixtureId, { now: t0 }), "a re-verify the budget could not afford is 'not ready'").toEqual({ created: false, reason: "not_ready" });
    expect(fx.calls.length - calls, "a refused request is never made").toBe(0);
    expect(deferrals(), "one line per player's deferred re-verify").toBe(2);
    const row = await bridge(s.fixtureId);
    expect(quiet(row), `nothing written: ${JSON.stringify(row)}`).toBe(true);
    expect(board.createChallengeToUser).not.toHaveBeenCalled();

    await refill();
    // A second later: the read slot the deferred claim took (1 s back-off) is over.
    const again = await createGameIfReady(s.fixtureId, { now: new Date(t0.getTime() + 2_000) });
    expect(again, "the same call, budget back: the game is made").toMatchObject({ created: true });
    expect(await bridge(s.fixtureId)).toMatchObject({ status: "ready", last_error: null });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    void pids;
  });
});

// ─── The candidate set, judged by the SQL alone ──────────────────────────────────────────────────────────────────
// The second arm of job 2 is a LOOSE pre-filter in front of mintRetry's exact judgement (loadOnlinePlayFixture, checkIns): a
// superset is safe, a miss is a stranded board. So loosening a predicate - two check-ins, both sides, an online board,
// the grace - changes no OUTCOME of a pass, and a sweep-level test cannot see it: only which boards each pass looks at,
// forever, for every sport. The set is therefore asserted on its own, each predicate flipped on ONE board (candidate →
// not → candidate again), so the negative is never a board that was never a candidate to begin with.
describe.skipIf(!DB)("the stranded arm's candidate set (D21-fix-3, F2b)", () => {
  async function readyBoard() {
    const s = await seed();
    for (const side of ["home", "away"] as const) await stampFixtureCheckIn(s[side].personId, s.fixtureId, s.orgId);
    return s;
  }
  /** `ahead`: how far past the stamps the pass runs - the grace has elapsed unless it is under STRANDED_CREATE_AFTER_MS. */
  const candidatesAt = async (s: Seeded, ahead = STRANDED_CREATE_AFTER_MS + 2_000) =>
    (await __retryCandidates(new Date(Date.now() + ahead), [s.orgId])).map((c) => c.fixtureId);
  const isCandidate = async (s: Seeded, ahead?: number) => (await candidatesAt(s, ahead)).includes(s.fixtureId);

  it("a board with both players in, an old enough later check-in and no error is a candidate; each predicate, flipped, takes it out - and back", async () => {
    const s = await readyBoard();
    expect(await isCandidate(s), "premise: ready").toBe(true);
    let flipped = 0;

    // Two check-ins: one is not enough (the second player has not come).
    await sql`update fixture_availability set checked_in_at = null where fixture_id = ${s.fixtureId} and person_id = ${s.away.personId}`;
    expect(await isCandidate(s), "one check-in").toBe(false);
    await sql`update fixture_availability set checked_in_at = now() where fixture_id = ${s.fixtureId} and person_id = ${s.away.personId}`;
    expect(await isCandidate(s), "back").toBe(true);
    flipped += 1;

    // The grace: the later check-in is too young for the create the room itself is still making.
    expect(await isCandidate(s, STRANDED_CREATE_AFTER_MS - 2_000), "inside the grace").toBe(false);
    expect(await isCandidate(s, STRANDED_CREATE_AFTER_MS + 2_000), "past it").toBe(true);
    flipped += 1;

    // Both sides: an emptied side (an organiser's unpair) with the old availability rows still on file.
    const [{ away }] = await sql<{ away: string }[]>`select away_entrant_id as away from fixtures where id = ${s.fixtureId}`;
    await sql`update fixtures set away_entrant_id = null where id = ${s.fixtureId}`;
    expect(await isCandidate(s), "an empty side").toBe(false);
    await sql`update fixtures set away_entrant_id = ${away} where id = ${s.fixtureId}`;
    expect(await isCandidate(s), "back").toBe(true);
    flipped += 1;

    // An online board: a division that does not play online (another club's ordinary tournament, or a legacy one) has
    // check-ins too - the QR check-in stamps them for every sport - and must never be a candidate.
    const [{ config }] = await sql<{ config: Record<string, unknown> }[]>`
      select d.config from divisions d join fixtures f on f.division_id = d.id where f.id = ${s.fixtureId}`;
    await sql`update divisions set config = config || '{"onlinePlay":"off"}'::jsonb where id = (select division_id from fixtures where id = ${s.fixtureId})`;
    expect(await isCandidate(s), "a division not playing online").toBe(false);
    await sql`update divisions set config = ${sql.json(config as never)} where id = (select division_id from fixtures where id = ${s.fixtureId})`;
    expect(await isCandidate(s), "back").toBe(true);
    flipped += 1;

    // Another sport.
    const [{ sport }] = await sql<{ sport: string }[]>`
      select d.sport_key as sport from divisions d join fixtures f on f.division_id = d.id where f.id = ${s.fixtureId}`;
    await sql`update divisions set sport_key = 'badminton' where id = (select division_id from fixtures where id = ${s.fixtureId})`;
    expect(await isCandidate(s), "another sport").toBe(false);
    await sql`update divisions set sport_key = ${sport} where id = (select division_id from fixtures where id = ${s.fixtureId})`;
    expect(await isCandidate(s), "back").toBe(true);
    flipped += 1;

    expect(flipped, "anti-vacuity: five predicates flipped").toBe(5);
  });
});
