// What a closed board's create may have left open at Lichess (lual review m6, the "older problem"; the recovery-clock /
// strays task, 2026-11-23; fix round 1, rulings I1 and m1-m4). A create that may have reached Lichess (T9's sent marker) is
// recovered only by T9's next claimant, and a fixture no longer playable is never claimed. The sweep's `close_strays` job
// (sweep/close-strays.ts, create-game cancelClosedBoardStrays) cancels, once, with White's token and one request at a time,
// ONLY a match listed while it could still be our create - the recovery's own window after the marker (I1). A lookalike
// listed later is never cancelled, and a board reached after the window is stamped `not_listed` without a call.
//
// Every board is built by the REAL producers: the dead sender is T9's real create (its accept never answers), the
// withdrawal is the real cascade, the close is the real bridge-close, and the cleanup runs inside the REAL sweep pass, on the
// pass's injected clocks (`now` for the claim fence, `wallClock` for the listing's instant - one instant, as in production).
// Lichess is a stub Board API module that records every call; the drop of our own challenge off the REAL listing is driven
// through the real adapter and e2e/lichess-fixture-server.ts in external-play-create-recovery-fixture.test.ts.
//
// Single-sport by construction: online play exists only for `boardgame` (guard.ts `d.sport_key = 'boardgame'`), so no
// create - and so no marker and no stray - exists for any other sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { log } from "@/server/logger";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { LICHESS_TIMEOUT_MS, MINT_CLAIM_STALE_MS } from "@/server/external-play/window";

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
import { STRAYS_GIVE_UP_AFTER } from "../external-play/sweep/close-strays";
import { withdrawEntrantCascade } from "../withdrawal";
import { NO_PRUNE, NO_WINDOW, seedOnlineChessFixture } from "./_external-play-seed";

const DB = !!process.env.DATABASE_URL;

/** t17-live-lichess.md §1, MEASURED: an unaccepted challenge without keepAliveStream is gone from GET /api/challenge by
 *  +36 s. With LICHESS_TIMEOUT_MS for our send to land after the marker, a listing later than marker + WINDOW_MS cannot
 *  hold our create (L1, the recovery's window; inclusive). From the probe, never from create-game. */
const LISTED_MS = 36_000;
const WINDOW_MS = LICHESS_TIMEOUT_MS + LISTED_MS;
/** Inside the window and past the dead sender's claim (the marker is its last claim): the earliest a pass can look is
 *  marker + MINT_CLAIM_STALE_MS. */
const IN_WINDOW_MS = MINT_CLAIM_STALE_MS + 5_000;

afterAll(async () => {
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
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
  warn = vi.spyOn(log, "warn");
});
afterEach(() => {
  warn.mockRestore();
});

/** fixture_external_play_challenge_idx is UNIQUE across the accumulated test database: a fresh id per use. */
const freshId = () => `st-${randomUUID().slice(0, 12)}`;
const CLOCK = { base: 300, increment: 3 } as const;

/** A round-1 board whose round opened 5 minutes ago (real time), so a create a minute ago is inside its window. */
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
 *  before it recorded it (the accept never answers). Leaves the marker and the claim at that instant, nothing recorded. */
async function deadSender(s: Seeded, sentId: string, ageMs = 60_000, atMs?: number): Promise<number> {
  const at = new Date(atMs ?? Date.now() - ageMs);
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
  return at.getTime();
}

async function bridgeRow(fixtureId: string) {
  const [row] = await sql<
    { status: string; challenge_id: string | null; create_sent_at: Date | null; strays_closed_at: Date | null; strays_closed_reason: string | null; strays_attempts: number }[]
  >`
    select status, challenge_id, create_sent_at, strays_closed_at, strays_closed_reason, strays_attempts
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return row;
}
const reasonOf = async (fixtureId: string) => (await bridgeRow(fixtureId))?.strays_closed_reason ?? null;

const withdraw = async (s: Seeded) => {
  await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
  const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
  expect(fx?.status, "premise: the withdrawal left the board unplayable").not.toMatch(/^(scheduled|in_play)$/);
};

/** One REAL sweep pass, scoped to `orgIds`, at the instant `atMs` - its `now` (the claim fence) and its wall clock (the
 *  listing's instant) are that one instant, as they are in production. Reconcile and the teardown are not this suite's. */
async function pass(orgIds: string[], atMs: number, { failures = [] as unknown[] } = {}): Promise<SweepReport> {
  const r = await sweepExternalPlay({
    ...NO_PRUNE,
    ...NO_WINDOW,
    now: new Date(atMs),
    wallClock: () => atMs,
    orgIds,
    serialise: false,
    reconcile: async () => null,
    endMeeting: async () => {},
  });
  expect(r.failures, "the job's failures").toEqual(failures);
  return r;
}

const cancelsOf = (id: string) =>
  board.cancelChallenge.mock.calls.filter((c) => (c[0] as { challengeId: string }).challengeId === id);
const listingTokens = () => board.listOutgoingChallenges.mock.calls.map((c) => c[0] as string);
const notListedWarns = (fixtureId: string) =>
  warn.mock.calls.filter((c) => /no longer listed/.test(String(c[1])) && (c[0] as { fixtureId?: string }).fixtureId === fixtureId);

describe.skipIf(!DB)("close_strays — only what could still be our create is cancelled, once", () => {
  it("INSIDE the window (withdrawn before any recovery): every match listed is cancelled exactly once - the dead sender's own, and a lookalike it cannot be told from; other challenges untouched; a second pass asks nothing", async () => {
    const s = await seed();
    const own = freshId();
    const sent = await deadSender(s, own);
    await withdraw(s);
    const lookalike = freshId();
    const otherOpponent = { ...ourChallenge(freshId(), s), destUserId: `x-${randomUUID().slice(0, 8)}` };
    const otherClock = { ...ourChallenge(freshId(), s), timeControl: { type: "clock", limit: 600, increment: 0 } };
    board.listOutgoingChallenges.mockResolvedValue({
      ok: true,
      challenges: [ourChallenge(own, s), ourChallenge(lookalike, s), otherOpponent, otherClock, { ...ourChallenge(freshId(), s), status: "canceled" }],
    });
    const r = await pass([s.orgId], sent + IN_WINDOW_MS);
    expect(r.bridgesClosed, "job 0 closed the bridge in the same pass").toBe(1);
    expect(listingTokens(), "one listing, with White's token").toEqual([whiteToken(s)]);
    expect(board.cancelChallenge.mock.calls.map((c) => (c[0] as { challengeId: string }).challengeId).sort(), "the two matches only").toEqual([own, lookalike].sort());
    expect(cancelsOf(own)).toEqual([[{ token: whiteToken(s), challengeId: own }]]);
    expect(cancelsOf(lookalike)).toHaveLength(1);
    expect(r.straysCancelled).toBe(2);
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ strays_closed_reason: "cancelled", strays_attempts: 0 });
    expect((await bridgeRow(s.fixtureId))?.create_sent_at, "the marker is kept: a game MAY still exist").not.toBeNull();

    vi.clearAllMocks();
    await pass([s.orgId], sent + IN_WINDOW_MS + 5_000);
    expect(board.listOutgoingChallenges).not.toHaveBeenCalled();
    expect(board.cancelChallenge).not.toHaveBeenCalled();
  });

  it("PAST the window: a lookalike listed when our marker is 5 min old is NEVER cancelled - Lichess is not even asked; stamped not_listed, warned once with the age. The edge: listed AT the window's end is asked, one ms past it is not", async () => {
    const cases: Array<[string, number, boolean]> = [
      ["5 minutes after the marker", 5 * 60_000, false],
      ["one ms past the window's end", WINDOW_MS + 1, false],
      ["at the window's end (inclusive)", WINDOW_MS, true],
    ];
    let checked = 0;
    for (const [label, ageMs, asked] of cases) {
      vi.clearAllMocks();
      board.cancelChallenge.mockResolvedValue({ ok: true });
      const s = await seed();
      const sent = await deadSender(s, freshId());
      await withdraw(s);
      const lookalike = freshId();
      board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(lookalike, s)] });
      const r = await pass([s.orgId], sent + ageMs);
      expect(board.listOutgoingChallenges, `${label}: asked`).toHaveBeenCalledTimes(asked ? 1 : 0);
      expect(cancelsOf(lookalike), `${label}: cancels`).toHaveLength(asked ? 1 : 0);
      expect(r.straysCancelled, label).toBe(asked ? 1 : 0);
      expect(await reasonOf(s.fixtureId), label).toBe(asked ? "cancelled" : "not_listed");
      if (!asked) {
        expect(notListedWarns(s.fixtureId).map((c) => (c[0] as { ageMs: number }).ageMs), `${label}: warned once, with the age`).toEqual([ageMs]);
      }
      vi.clearAllMocks(); // the warn spy too: what follows counts the second pass alone
      await pass([s.orgId], sent + ageMs + 60_000);
      expect(board.listOutgoingChallenges, `${label}: never asked again`).not.toHaveBeenCalled();
      expect(notListedWarns(s.fixtureId), `${label}: never warned again`).toHaveLength(0);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("WITHDRAWN mid-recovery: the close takes the recovery's claim; the stray it was about to cancel was listed past the window - a lookalike - and the cleanup never cancels it either: stamped not_listed, no call", async () => {
    const s = await seed();
    const sent = await deadSender(s, freshId());
    const stray = freshId();
    // Listed 60 s after the send: past any instant our own send could still be listed, so the recovery calls it a stray.
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(stray, s)] });
    board.listOngoingGames.mockImplementationOnce(async () => {
      await withdraw(s);
      expect(await closeBridgeIfUnplayable(s.fixtureId, new Date()), "premise: the close landed").toBe(true);
      return { ok: true, games: [], complete: true };
    });
    expect(await createGameIfReady(s.fixtureId), "the recovery lost its claim to the close").toEqual({ created: false, reason: "not_ready" });
    expect(board.cancelChallenge, "premise (review m6): the recovery left the stray").not.toHaveBeenCalled();
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ status: "finished", challenge_id: null, strays_closed_at: null });

    // While the recovery's renewed claim is live, its calls may still be in flight: the sweep does not read the board.
    board.listOutgoingChallenges.mockClear();
    await pass([s.orgId], Date.now());
    expect(await reasonOf(s.fixtureId), "a live claim: not reached yet").toBeNull();

    const later = Date.now() + MINT_CLAIM_STALE_MS + 1_000;
    const r = await pass([s.orgId], later);
    expect(board.listOutgoingChallenges, "past the window: Lichess is not asked").not.toHaveBeenCalled();
    expect(board.cancelChallenge, "the lookalike is never cancelled").not.toHaveBeenCalled();
    expect(r.straysCancelled).toBe(0);
    expect(await reasonOf(s.fixtureId)).toBe("not_listed");
    expect(later - sent, "premise: reached past the window").toBeGreaterThan(WINDOW_MS);
  });

  it("VOIDED or settled any other way - every fixture status that is not playable - inside the window: cancelled once each", async () => {
    const unplayable = FIXTURE_STATUSES.filter((st) => !isPlayableFixtureStatus(st));
    expect(unplayable.length, "anti-vacuity: statuses to sweep").toBeGreaterThan(0);
    let checked = 0;
    for (const status of unplayable) {
      vi.clearAllMocks();
      board.cancelChallenge.mockResolvedValue({ ok: true });
      const s = await seed();
      const sent = await deadSender(s, freshId());
      // LABELLED SQL: the fixture status a void (cancelled), a pad result, a settle or a hold leaves.
      await sql`update fixtures set status = ${status} where id = ${s.fixtureId}`;
      const own = freshId();
      board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(own, s)] });
      const r = await pass([s.orgId], sent + IN_WINDOW_MS);
      expect(cancelsOf(own), `${status}: cancelled once`).toHaveLength(1);
      expect(r.straysCancelled, status).toBe(1);
      expect(await reasonOf(s.fixtureId), status).toBe("cancelled");
      checked += 1;
    }
    expect(checked).toBe(unplayable.length);
  });

  it("a PEER fixture's challenge is never touched: beside a same-pair create in flight nothing is cancelled (one failed pass); once the peer records its game, that one is spared and ours cancelled", async () => {
    const s = await seed();
    const [peer] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
      values (${s.stageId}, ${s.divisionId}, ${s.orgId}, 2, 1, ${`cs-${randomUUID().slice(0, 8)}`}, 'scheduled',
              ${s.home.entrantId}, ${s.away.entrantId}, now() + interval '10 minutes')
      returning id`;
    const sent = await deadSender(s, freshId());
    // LABELLED SQL: ours voided (a cancelled fixture) - a withdrawal would take the peer with it, as the same entrants play it.
    await sql`update fixtures set status = 'cancelled' where id = ${s.fixtureId}`;
    // LABELLED SQL: the peer's create in flight - pending, sent a moment ago, nothing recorded.
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
      values (${peer!.id}, ${s.orgId}, now(), now(), now())`;
    const peersChallenge = freshId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(peersChallenge, s)] });
    await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + 1_000);
    expect(board.listOutgoingChallenges, "premise: the cleanup looked").toHaveBeenCalledTimes(1);
    expect(board.cancelChallenge, "a match beside a peer in flight may be the peer's: untouched").not.toHaveBeenCalled();
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ strays_closed_at: null, strays_attempts: 1 });

    await sql`
      update fixture_external_play set status = 'ready', challenge_id = ${peersChallenge}, mint_claimed_at = null, create_sent_at = null
       where fixture_id = ${peer!.id}`;
    const ours = freshId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(peersChallenge, s), ourChallenge(ours, s)] });
    vi.clearAllMocks();
    board.cancelChallenge.mockResolvedValue({ ok: true });
    const r = await pass([s.orgId], sent + IN_WINDOW_MS);
    expect(cancelsOf(peersChallenge), "the peer's recorded game: never cancelled").toHaveLength(0);
    expect(cancelsOf(ours), "ours: cancelled once").toHaveLength(1);
    expect(r.straysCancelled).toBe(1);
    expect(await reasonOf(s.fixtureId)).toBe("cancelled");
  });

  it("a 429 is retried on a later pass - from the listing and from a cancel - and the challenge lila refused to cancel is cancelled on the retry, never twice once it is done", async () => {
    const s = await seed();
    const sent = await deadSender(s, freshId());
    await withdraw(s);
    const own = freshId();

    board.listOutgoingChallenges.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    const first = await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + 1_000);
    expect(board.listOutgoingChallenges, "pass 1: the listing was asked").toHaveBeenCalledTimes(1);
    expect(board.cancelChallenge, "pass 1: a refused listing cancels nothing").not.toHaveBeenCalled();
    expect(first.deferred, "pass 1: a 429 is a deferral, never a failure").toBeGreaterThanOrEqual(1);
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ strays_closed_at: null, strays_attempts: 1 });

    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(own, s)] });
    board.cancelChallenge.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + 5_000);
    expect(cancelsOf(own), "pass 2: asked once, lila refused before acting").toHaveLength(1);
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ strays_closed_at: null, strays_attempts: 2 });

    const third = await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + 10_000);
    expect(cancelsOf(own), "pass 3: the retry").toHaveLength(2);
    expect(third.straysCancelled).toBe(1);
    expect(await reasonOf(s.fixtureId), "pass 3: done").toBe("cancelled");

    await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + 14_000);
    expect(cancelsOf(own), "pass 4: nothing more").toHaveLength(2);
    expect(board.listOutgoingChallenges, "pass 4: no listing").toHaveBeenCalledTimes(3);
  });

  it("m2: a 429 stops the WHOLE job for the pass - the next board is not asked until the next pass", async () => {
    const a = await seed();
    const b = await seed();
    // Two sends one second apart (absolute instants: seeding time under load must not move the gap).
    const base = Date.now() - 60_000;
    const sentA = await deadSender(a, freshId(), 0, base);
    await deadSender(b, freshId(), 0, base + 1_000);
    await withdraw(a);
    await withdraw(b);
    board.listOutgoingChallenges.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    const first = await pass([a.orgId, b.orgId], sentA + IN_WINDOW_MS);
    expect(listingTokens(), "pass 1: the older board asked, the 429 stopped the job").toEqual([whiteToken(a)]);
    expect(first.deferred, "the rest deferred").toBeGreaterThanOrEqual(1);
    expect(await reasonOf(b.fixtureId), "b untouched").toBeNull();

    board.listOutgoingChallenges.mockClear();
    await pass([a.orgId, b.orgId], sentA + IN_WINDOW_MS + 2_000);
    // b has fewer failed passes, so it now comes first (m1's rotation).
    expect(listingTokens(), "pass 2: both asked, the fresh board first").toEqual([whiteToken(b), whiteToken(a)]);
    expect([await reasonOf(a.fixtureId), await reasonOf(b.fixtureId)]).toEqual(["not_listed", "not_listed"]);
  });

  it("m3: a 429 at a cancel stops that board's cancels at once (the second match is not asked this pass); the next pass cancels both, each once", async () => {
    const s = await seed();
    const sent = await deadSender(s, freshId());
    await withdraw(s);
    const [one, two] = [freshId(), freshId()];
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(one, s), ourChallenge(two, s)] });
    board.cancelChallenge.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await pass([s.orgId], sent + IN_WINDOW_MS);
    expect([cancelsOf(one).length, cancelsOf(two).length], "pass 1: the first asked, the second never").toEqual([1, 0]);
    expect(await reasonOf(s.fixtureId)).toBeNull();
    const r = await pass([s.orgId], sent + IN_WINDOW_MS + 3_000);
    expect([cancelsOf(one).length, cancelsOf(two).length], "pass 2: each cancelled").toEqual([2, 1]);
    expect(r.straysCancelled).toBe(2);
    expect(await reasonOf(s.fixtureId)).toBe("cancelled");
  });

  it("m3: a cancel lila answers 'already over' (M6) is nothing open to cancel - the next match is still cancelled, and the board is done, not retried", async () => {
    const s = await seed();
    const sent = await deadSender(s, freshId());
    await withdraw(s);
    const [over, open] = [freshId(), freshId()];
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(over, s), ourChallenge(open, s)] });
    board.cancelChallenge.mockResolvedValueOnce({ ok: false, code: "not_your_turn_or_over", raw: '{"error":"Not your turn, or game already over"}' });
    const r = await pass([s.orgId], sent + IN_WINDOW_MS);
    expect([cancelsOf(over).length, cancelsOf(open).length]).toEqual([1, 1]);
    expect(r.straysCancelled).toBe(1);
    expect(await bridgeRow(s.fixtureId)).toMatchObject({ strays_closed_reason: "cancelled", strays_attempts: 0 });
    vi.clearAllMocks();
    await pass([s.orgId], sent + IN_WINDOW_MS + 3_000);
    expect(board.cancelChallenge).not.toHaveBeenCalled();
  });

  it(`m1: a board that fails every pass is given up after STRAYS_GIVE_UP_AFTER (${STRAYS_GIVE_UP_AFTER}) failed passes - stamped gave_up, warned, never asked again`, async () => {
    const s = await seed();
    const sent = await deadSender(s, freshId(), 120_000);
    await withdraw(s);
    board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unavailable", raw: "502 Bad Gateway" });
    // Every pass inside the window, one ms apart: a failure here is the board's, not the clock's.
    for (let i = 1; i <= STRAYS_GIVE_UP_AFTER; i++) {
      await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + i);
      const row = await bridgeRow(s.fixtureId);
      expect(row?.strays_attempts, `pass ${i}: counted`).toBe(i);
      expect(row?.strays_closed_reason, `pass ${i}`).toBe(i < STRAYS_GIVE_UP_AFTER ? null : "gave_up");
    }
    expect(board.listOutgoingChallenges, "anti-vacuity: one listing per failed pass").toHaveBeenCalledTimes(STRAYS_GIVE_UP_AFTER);
    expect(warn.mock.calls.filter((c) => /gave up on a closed board's strays/.test(String(c[1]))), "warned once").toHaveLength(1);
    board.listOutgoingChallenges.mockClear();
    await pass([s.orgId], sent + MINT_CLAIM_STALE_MS + STRAYS_GIVE_UP_AFTER + 1);
    expect(board.listOutgoingChallenges, "given up: never asked again").not.toHaveBeenCalled();
  });

  it("White's token refused - at the listing or at a cancel - or White unlinked counts as done: stamped with its reason, never asked again", async () => {
    let checked = 0;
    const cases: Array<[string, (s: Seeded, own: string) => Promise<void>, number, string]> = [
      ["the listing refused", async () => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unauthorized", raw: "No such token" });
      }, 0, "token_refused"],
      ["a cancel refused", async (s, own) => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(own, s), ourChallenge(freshId(), s)] });
        board.cancelChallenge.mockResolvedValue({ ok: false, code: "unauthorized", raw: "No such token" });
      }, 1, "token_refused"],
      // The link row gone takes the token with it: nothing to match ours by (no White account), so `unidentifiable`.
      ["White unlinked (no link, no token)", async (s, own) => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(own, s)] });
        await sql`delete from user_external_accounts where user_id = ${s.home.userId} and provider = 'lichess'`;
      }, 0, "unidentifiable"],
    ];
    for (const [label, arrange, cancelCalls, reason] of cases) {
      const s = await seed();
      const sent = await deadSender(s, freshId());
      await withdraw(s);
      const own = freshId();
      await arrange(s, own);
      await pass([s.orgId], sent + IN_WINDOW_MS);
      expect(board.cancelChallenge, `${label}: cancels asked`).toHaveBeenCalledTimes(cancelCalls);
      expect(await reasonOf(s.fixtureId), `${label}: done`).toBe(reason);
      vi.clearAllMocks();
      await pass([s.orgId], sent + IN_WINDOW_MS + 3_000);
      expect(board.listOutgoingChallenges, `${label}: never asked again`).not.toHaveBeenCalled();
      expect(board.cancelChallenge, `${label}: never asked again`).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("the empty cases ask Lichess nothing: a closed board with no marker, a closed board whose game was recorded, and a LIVE board with a marker", async () => {
    const cases: Array<[string, (s: Seeded) => Promise<number>]> = [
      ["closed, nothing ever sent", async (s) => {
        await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis) values (${s.fixtureId}, ${s.orgId}, now())`;
        await withdraw(s);
        return Date.now();
      }],
      ["closed, the game recorded", async (s) => {
        // LABELLED SQL: a ready game (the marker cleared by the recording write) under a board then withdrawn.
        await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
                  values (${s.fixtureId}, ${s.orgId}, now(), 'ready', ${freshId()})`;
        await withdraw(s);
        return Date.now();
      }],
      ["live, a create sent (still T9's to recover)", async (s) => deadSender(s, freshId())],
    ];
    const orgs: string[] = [];
    const ids: string[] = [];
    let at = 0;
    for (const [, arrange] of cases) {
      const s = await seed();
      at = Math.max(at, await arrange(s));
      orgs.push(s.orgId);
      ids.push(s.fixtureId);
    }
    vi.clearAllMocks();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
    const r = await pass(orgs, at + IN_WINDOW_MS);
    expect(board.listOutgoingChallenges, "no cleanup listing").not.toHaveBeenCalled();
    expect(board.cancelChallenge).not.toHaveBeenCalled();
    expect(r.straysCancelled).toBe(0);
    for (const [i, [label]] of cases.entries()) {
      expect(await bridgeRow(ids[i]!), `${label}: nothing stamped`).toMatchObject({ strays_closed_at: null, strays_attempts: 0 });
    }
    expect(ids.length, "anti-vacuity: three boards").toBe(3);
  });
});
