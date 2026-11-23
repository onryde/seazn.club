// The strays a closed board leaves at Lichess (lual review m6, the "older problem"; the recovery-clock / strays task,
// 2026-11-23). A create that may have reached Lichess (T9's sent marker) is recovered only by T9's next claimant, and a
// fixture no longer playable is never claimed: when a withdrawal or a void closes the board, the challenges matching its
// create stay open for Black to accept - those a recovery was about to cancel when the close took its claim, and those no
// recovery ever looked at. The sweep's `close_strays` job (sweep/close-strays.ts, create-game cancelClosedBoardStrays) is
// the one place that cancels them: once, with White's token, one request at a time.
//
// Every board is built by the REAL producers: the dead sender is T9's real create (its accept never answers), the
// withdrawal is the real cascade, the close is the real bridge-close, and the cleanup runs inside the REAL sweep pass.
// Lichess is a stub Board API module that records every call; RealtimeKit is never reached (the seat is stubbed, as in
// the create-game suite).
//
// Single-sport by construction: online play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`), so no
// create - and so no marker and no stray - exists for any other sport.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { MINT_CLAIM_STALE_MS } from "@/server/external-play/window";

const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

// T8's seat would call RealtimeKit: "both seated". Partial, so T8's REAL playable predicate stays in force.
const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
vi.mock("../external-play/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/preflight")>()),
  seatPlayer: preflight.seatPlayer,
}));

import { createGameIfReady } from "../external-play/create-game";
import { closeBridgeIfUnplayable } from "../external-play/bridge-close";
import { isPlayableFixtureStatus } from "../external-play/preflight";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { sweepExternalPlay, type SweepReport } from "../external-play/sweep";
import { withdrawEntrantCascade } from "../withdrawal";
import { NO_PRUNE, NO_WINDOW, seedOnlineChessFixture } from "./_external-play-seed";

const DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: freshId() });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
  preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
});

/** fixture_external_play_challenge_idx is UNIQUE across the accumulated test database: a fresh id per use. */
const freshId = () => `st-${randomUUID().slice(0, 12)}`;
const CLOCK = { base: 300, increment: 3 } as const;

/** A round-1 board whose round opened 5 minutes ago (real time), so a create NOW is inside its window. */
async function seed() {
  const opened = new Date(Date.now() - 5 * 60_000);
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    clock: CLOCK,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** An outgoing challenge exactly as our create sends it: White (the seed's home) challenging Black, unrated, standard, the
 *  board's clock, White's colour (the create-game suite's `ourChallenge`). */
const ourChallenge = (id: string, s: Seeded) => ({
  id, challengerId: s.home.lichessId, destUserId: s.away.lichessId, status: "created", rated: false, variantKey: "standard",
  timeControl: { type: "clock", limit: CLOCK.base, increment: CLOCK.increment }, color: "white",
});
const whiteToken = (s: Seeded) => `lio_seed_${s.home.lichessId}`;

/** The dead sender: T9's REAL create, `ageMs` ago on the wall clock, whose challenge reached Lichess and whose process died
 *  before it recorded it (the accept never answers). Leaves the marker and the claim, nothing recorded. */
async function deadSender(s: Seeded, sentId: string, ageMs = 60_000): Promise<Date> {
  const at = new Date(Date.now() - ageMs);
  board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: sentId });
  board.acceptChallenge.mockRejectedValueOnce(new Error("the process died after the send"));
  await expect(createGameIfReady(s.fixtureId, { now: at, clock: () => at })).rejects.toThrow("the process died");
  const row = await bridgeRow(s.fixtureId);
  expect(row, "premise: sent, nothing recorded").toMatchObject({ status: "pending", challenge_id: null });
  expect(row?.create_sent_at?.getTime(), "premise: the marker is the send").toBe(at.getTime());
  vi.clearAllMocks();
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  return at;
}

async function bridgeRow(fixtureId: string) {
  const [row] = await sql<{ status: string; challenge_id: string | null; create_sent_at: Date | null; strays_closed_at: Date | null }[]>`
    select status, challenge_id, create_sent_at, strays_closed_at from fixture_external_play where fixture_id = ${fixtureId}`;
  return row;
}

const withdraw = async (s: Seeded) => {
  await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
  const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
  expect(fx?.status, "premise: the withdrawal left the board unplayable").not.toMatch(/^(scheduled|in_play)$/);
};

/** One REAL sweep pass, scoped to `orgIds`, at `at` (default: past every live claim the test made). Reconcile and the
 *  meeting teardown are not this suite's subject. */
async function pass(orgIds: string[], at = new Date(Date.now() + MINT_CLAIM_STALE_MS + 1_000)): Promise<SweepReport> {
  const r = await sweepExternalPlay({
    ...NO_PRUNE,
    ...NO_WINDOW,
    now: at,
    orgIds,
    serialise: false,
    reconcile: async () => null,
    endMeeting: async () => {},
  });
  expect(r.failures, "no job failed").toEqual([]);
  return r;
}

const cancelsOf = (id: string) =>
  board.cancelChallenge.mock.calls.filter((c) => (c[0] as { challengeId: string }).challengeId === id);

describe.skipIf(!DB)("close_strays — a closed board's challenges at Lichess are cancelled once", () => {
  it("WITHDRAWN mid-recovery: the close takes the recovery's claim, and the sweep cancels the stray it was about to - once, with White's token; a second pass asks Lichess nothing", async () => {
    const s = await seed();
    await deadSender(s, freshId());
    const stray = freshId();
    // Listed 60 s after the send: past any instant our own send could still be listed, so the recovery calls it a stray.
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(stray, s)] });
    // The withdrawal lands while the recovery is between its two lookups, and the sweep's job 0 closes the bridge.
    board.listOngoingGames.mockImplementationOnce(async () => {
      await withdraw(s);
      expect(await closeBridgeIfUnplayable(s.fixtureId, new Date()), "premise: the close landed").toBe(true);
      return { ok: true, games: [], complete: true };
    });
    expect(await createGameIfReady(s.fixtureId), "the recovery lost its claim to the close").toEqual({ created: false, reason: "not_ready" });
    expect(board.cancelChallenge, "premise (review m6): the recovery left the stray").not.toHaveBeenCalled();
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ status: "finished", challenge_id: null, strays_closed_at: null });

    // While the recovery's claim is still live, its calls may still be in flight: the sweep waits.
    board.listOutgoingChallenges.mockClear();
    const early = await pass([s.orgId], new Date());
    expect(board.listOutgoingChallenges, "a live claim: not asked yet").not.toHaveBeenCalled();
    expect(early.straysCancelled).toBe(0);

    const first = await pass([s.orgId]);
    expect(board.listOutgoingChallenges, "one listing, with White's token").toHaveBeenCalledTimes(1);
    expect(board.listOutgoingChallenges).toHaveBeenCalledWith(whiteToken(s));
    expect(cancelsOf(stray), "the stray, cancelled once").toHaveLength(1);
    expect(board.cancelChallenge).toHaveBeenCalledWith({ token: whiteToken(s), challengeId: stray });
    expect(board.cancelChallenge, "nothing else cancelled").toHaveBeenCalledTimes(1);
    expect(first.straysCancelled).toBe(1);
    const row = await bridgeRow(s.fixtureId);
    expect(row?.strays_closed_at, "done, stamped").not.toBeNull();
    expect(row?.create_sent_at, "the marker is kept: a game MAY still exist").not.toBeNull();

    vi.clearAllMocks();
    const second = await pass([s.orgId], new Date(Date.now() + 10 * 60_000));
    expect(board.listOutgoingChallenges, "a second pass: no listing").not.toHaveBeenCalled();
    expect(board.cancelChallenge, "a second pass: no cancel").not.toHaveBeenCalled();
    expect(second.straysCancelled).toBe(0);
  });

  it("WITHDRAWN before any recovery: the pass closes the bridge and cancels every challenge matching the create - the dead sender's own, if still listed, and a stray - each once", async () => {
    const s = await seed();
    const own = freshId();
    await deadSender(s, own);
    await withdraw(s);
    const stray = freshId();
    const otherOpponent = { ...ourChallenge(freshId(), s), destUserId: `x-${randomUUID().slice(0, 8)}` };
    const otherClock = { ...ourChallenge(freshId(), s), timeControl: { type: "clock", limit: 600, increment: 0 } };
    board.listOutgoingChallenges.mockResolvedValue({
      ok: true,
      challenges: [ourChallenge(own, s), ourChallenge(stray, s), otherOpponent, otherClock, { ...ourChallenge(freshId(), s), status: "canceled" }],
    });
    const r = await pass([s.orgId], new Date());
    expect(r.bridgesClosed, "job 0 closed the bridge in the same pass").toBe(1);
    expect(board.cancelChallenge.mock.calls.map((c) => (c[0] as { challengeId: string }).challengeId).sort(), "ours and the stray only").toEqual([own, stray].sort());
    expect(cancelsOf(own)).toHaveLength(1);
    expect(cancelsOf(stray)).toHaveLength(1);
    expect(r.straysCancelled).toBe(2);
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at).not.toBeNull();

    vi.clearAllMocks();
    await pass([s.orgId]);
    expect(board.listOutgoingChallenges).not.toHaveBeenCalled();
    expect(board.cancelChallenge).not.toHaveBeenCalled();
  });

  it("VOIDED or settled any other way - every fixture status that is not playable - closes and cancels the same way, once each", async () => {
    const unplayable = FIXTURE_STATUSES.filter((st) => !isPlayableFixtureStatus(st));
    expect(unplayable.length, "anti-vacuity: statuses to sweep").toBeGreaterThan(0);
    let checked = 0;
    for (const status of unplayable) {
      vi.clearAllMocks();
      board.cancelChallenge.mockResolvedValue({ ok: true });
      const s = await seed();
      await deadSender(s, freshId());
      // LABELLED SQL: the fixture status a void (cancelled), a pad result, a settle or a hold leaves.
      await sql`update fixtures set status = ${status} where id = ${s.fixtureId}`;
      const stray = freshId();
      board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(stray, s)] });
      const r = await pass([s.orgId], new Date());
      expect(cancelsOf(stray), `${status}: cancelled once`).toHaveLength(1);
      expect(r.straysCancelled, status).toBe(1);
      expect((await bridgeRow(s.fixtureId))?.strays_closed_at, `${status}: stamped`).not.toBeNull();
      checked += 1;
    }
    expect(checked).toBe(unplayable.length);
  });

  it("a PEER fixture's challenge is never touched: beside a same-pair create in flight nothing is cancelled (and it waits); once the peer records its game, that one is spared and ours cancelled", async () => {
    const s = await seed();
    // The same two players on another board of the stage (a double round robin), still playable.
    const [peer] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${s.stageId}, ${s.divisionId}, ${s.orgId}, 2, 1, ${`cs-${randomUUID().slice(0, 8)}`}, 'scheduled',
              ${s.home.entrantId}, ${s.away.entrantId}, now() + interval '10 minutes')
      returning id`;
    await deadSender(s, freshId());
    // LABELLED SQL: ours voided (a cancelled fixture) - a withdrawal would take the peer with it, as the same entrants play it.
    await sql`update fixtures set status = 'cancelled' where id = ${s.fixtureId}`;
    // LABELLED SQL: the peer's create in flight - pending, sent a moment ago, nothing recorded.
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
      values (${peer!.id}, ${s.orgId}, now(), now(), now())`;
    const peersChallenge = freshId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(peersChallenge, s)] });
    await pass([s.orgId], new Date());
    expect(board.listOutgoingChallenges, "premise: the cleanup looked").toHaveBeenCalledTimes(1);
    expect(board.cancelChallenge, "a match beside a peer in flight may be the peer's: untouched").not.toHaveBeenCalled();
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at, "not done: it waits for the peer").toBeNull();

    // The peer records its game (the marker cleared, as both recording writes do); our stray is listed beside it.
    await sql`
      update fixture_external_play set status = 'ready', challenge_id = ${peersChallenge}, mint_claimed_at = null, create_sent_at = null
       where fixture_id = ${peer!.id}`;
    const ours = freshId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(peersChallenge, s), ourChallenge(ours, s)] });
    vi.clearAllMocks();
    board.cancelChallenge.mockResolvedValue({ ok: true });
    const r = await pass([s.orgId], new Date());
    expect(cancelsOf(peersChallenge), "the peer's recorded game: never cancelled").toHaveLength(0);
    expect(cancelsOf(ours), "ours: cancelled once").toHaveLength(1);
    expect(r.straysCancelled).toBe(1);
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at).not.toBeNull();
  });

  it("a 429 is retried on a later pass - from the listing and from a cancel - and the challenge lila refused to cancel is cancelled on the retry, never twice once it is done", async () => {
    const s = await seed();
    await deadSender(s, freshId());
    await withdraw(s);
    const stray = freshId();
    const listed = { ok: true, challenges: [ourChallenge(stray, s)] };

    board.listOutgoingChallenges.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await pass([s.orgId], new Date());
    expect(board.listOutgoingChallenges, "pass 1: the listing was asked").toHaveBeenCalledTimes(1);
    expect(board.cancelChallenge, "pass 1: a refused listing cancels nothing").not.toHaveBeenCalled();
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at, "pass 1: owed").toBeNull();

    board.listOutgoingChallenges.mockResolvedValue(listed);
    board.cancelChallenge.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await pass([s.orgId], new Date());
    expect(cancelsOf(stray), "pass 2: asked once, lila refused before acting").toHaveLength(1);
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at, "pass 2: still owed").toBeNull();

    const third = await pass([s.orgId], new Date());
    expect(cancelsOf(stray), "pass 3: the retry").toHaveLength(2);
    expect(third.straysCancelled).toBe(1);
    expect((await bridgeRow(s.fixtureId))?.strays_closed_at, "pass 3: done").not.toBeNull();

    await pass([s.orgId]);
    expect(cancelsOf(stray), "pass 4: nothing more").toHaveLength(2);
    expect(board.listOutgoingChallenges, "pass 4: no listing").toHaveBeenCalledTimes(3);
  });

  it("White's token refused - at the listing or at a cancel - or no token at all counts as done: stamped, never asked again", async () => {
    let checked = 0;
    const cases: Array<[string, (s: Seeded, stray: string) => Promise<void>, number]> = [
      ["the listing refused", async () => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unauthorized", raw: "No such token" });
      }, 0],
      ["a cancel refused", async (s, stray) => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(stray, s), ourChallenge(freshId(), s)] });
        board.cancelChallenge.mockResolvedValue({ ok: false, code: "unauthorized", raw: "No such token" });
      }, 1],
      ["no stored token (White unlinked)", async (s, stray) => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(stray, s)] });
        await sql`delete from user_external_accounts where user_id = ${s.home.userId} and provider = 'lichess'`;
      }, 0],
    ];
    for (const [label, arrange, cancelCalls] of cases) {
      const s = await seed();
      await deadSender(s, freshId());
      await withdraw(s);
      const stray = freshId();
      await arrange(s, stray);
      await pass([s.orgId], new Date());
      expect(board.cancelChallenge, `${label}: cancels asked`).toHaveBeenCalledTimes(cancelCalls);
      expect((await bridgeRow(s.fixtureId))?.strays_closed_at, `${label}: done`).not.toBeNull();
      vi.clearAllMocks();
      await pass([s.orgId]);
      expect(board.listOutgoingChallenges, `${label}: never asked again`).not.toHaveBeenCalled();
      expect(board.cancelChallenge, `${label}: never asked again`).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("the empty cases ask Lichess nothing: a closed board with no marker, a closed board whose game was recorded, and a LIVE board with a marker", async () => {
    const cases: Array<[string, (s: Seeded) => Promise<void>]> = [
      ["closed, nothing ever sent", async (s) => {
        await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis) values (${s.fixtureId}, ${s.orgId}, now())`;
        await withdraw(s);
      }],
      ["closed, the game recorded", async (s) => {
        // LABELLED SQL: a ready game (the marker cleared by the recording write) under a board then withdrawn.
        await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
                  values (${s.fixtureId}, ${s.orgId}, now(), 'ready', ${freshId()})`;
        await withdraw(s);
      }],
      ["live, a create sent (still T9's to recover)", async (s) => {
        await deadSender(s, freshId());
      }],
    ];
    const orgs: string[] = [];
    const ids: string[] = [];
    for (const [, arrange] of cases) {
      const s = await seed();
      await arrange(s);
      orgs.push(s.orgId);
      ids.push(s.fixtureId);
    }
    vi.clearAllMocks();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
    const r = await pass(orgs, new Date());
    expect(board.listOutgoingChallenges, "no cleanup listing").not.toHaveBeenCalled();
    expect(board.cancelChallenge).not.toHaveBeenCalled();
    expect(r.straysCancelled).toBe(0);
    for (const [i, [label]] of cases.entries()) {
      expect((await bridgeRow(ids[i]!))?.strays_closed_at, `${label}: nothing to stamp`).toBeNull();
    }
    expect(ids.length, "anti-vacuity: three boards").toBe(3);
  });
});
