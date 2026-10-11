// T9 — claim-then-call creation. Review Focus 5 lives here: an entrant with
// no person behind it is never offered as an online match, and says so,
// rather than failing at creation.
//
// Single-sport by construction: online play exists only for `boardgame`
// (guard.ts's `d.sport_key = 'boardgame'`), so the one other-sport case below
// is the guard's refusal, not a second creation path.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import {
  CREATION_429_HOLD_MS,
  __resetCreationQueue,
  __setCreationQueueDeps,
  enqueueCreation,
} from "@/server/external-play/creation-queue";
import { LICHESS_TIMEOUT_MS, MINT_CLAIM_STALE_MS, windowFor } from "@/server/external-play/window";
import { log } from "@/server/logger";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { PLAY_SCOPES, getLichessLink } from "../external-accounts";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady, type CreateOutcome } from "../external-play/create-game";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOnlineChessFixture } from "./_external-play-seed";

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

// The Lichess Board API is module-mocked rather than fetch-stubbed: T9
// consumes T3's module functions directly, so the module boundary IS the
// seam. The mock's own implementation can touch the database, which is how
// the mid-flight takeover case below is driven without a test-only hook in
// production code.
const board = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  // Fix round 1 (I2 + Minor b): the stale-marker recovery's two lookups and
  // the stray-game cancel. Defaults are "both lookups succeed, nothing
  // found" and "cancel ok"; a token without challenge:read gets a 403 from
  // the first (board-api.test.ts, measured), which a case below pins.
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  // Fix round 2 (N1): the export read that verifies an ongoing-game candidate.
  // Default: unavailable — every case that offers a candidate says what its
  // export answers, so nothing is adopted by a default.
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => board);

// T8's seat: the real one would call RealtimeKit. Default is "both seated".
// Partial: `isPlayableFixtureStatus` stays T8's REAL predicate — T9 reuses it
// when a create leaves the queue, and a stub here would test the stub.
const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
vi.mock("../external-play/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/preflight")>()),
  seatPlayer: preflight.seatPlayer,
}));

// T4's REAL queue, observed: every enqueue is recorded and then passed
// straight through, so the throttle, the serial tail and the in-flight dedupe
// all run for real, and a test can tell when a create is WAITING in the queue
// (the only way to drive "withdrawn while queued" without a production hook).
const queue = vi.hoisted(() => ({ enqueued: [] as { key: string; challenger: string }[] }));
vi.mock("@/server/external-play/creation-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/creation-queue")>();
  return {
    ...actual,
    enqueueCreation: <T>(req: { key: string; challenger: string }, job: () => Promise<T>) => {
      queue.enqueued.push(req);
      return actual.enqueueCreation(req, job);
    },
  };
});

/** A fresh Lichess game id per case: fixture_external_play_challenge_idx is
 *  UNIQUE across the whole (accumulated) test database, so a literal id
 *  recorded by one case would collide with the next. */
let GM = "";
const freshGameId = () => `gm-${randomUUID().slice(0, 12)}`;

beforeEach(() => {
  vi.clearAllMocks();
  // The queue is per-process state (budgets, holds, the serial tail): every
  // case starts from an empty one, or the per-IP budget leaks across cases.
  __resetCreationQueue();
  queue.enqueued.length = 0;
  GM = freshGameId();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
  board.acceptChallenge.mockResolvedValue({ ok: true });
  board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
  board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
  board.cancelChallenge.mockResolvedValue({ ok: true });
  board.exportGameMeta.mockResolvedValue({ ok: false, code: "unavailable", raw: "unexpected export" });
  preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
});

afterAll(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** 5+3 is in SHIP1_TIME_CONTROLS; `base` is seconds (see the seed helper's
 *  own default of 900/10, and mapBoardgameClockToLichess). */
const seed = (over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: 300, increment: 3 },
    ...over,
  });

const noHttp = () => {
  expect(board.createChallengeToUser, "no Lichess call may happen").not.toHaveBeenCalled();
  expect(board.acceptChallenge).not.toHaveBeenCalled();
};

describe.skipIf(!process.env.DATABASE_URL)("Review Focus 5 — there is no person to seat", () => {
  it("an entrant whose only member is MERGED ⇒ no_person, and nothing is called", async () => {
    const s = await seed();
    // loadSide LEFT-joins `persons … and p.merged_into is null` (guard.ts:245),
    // so a tombstoned sole member nulls personId while displayName survives.
    await sql`
      update persons set merged_into = ${s.away.personId} where id = ${s.home.personId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "no_person",
    });
    noHttp();
  });

  it("an entrant with no members at all ⇒ no_person", async () => {
    const s = await seed();
    await sql`delete from entrant_members where entrant_id = ${s.home.entrantId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "no_person",
    });
    noHttp();
  });

  it("the AWAY side is checked too: an away entrant with no members ⇒ no_person", async () => {
    // Both cases above empty HOME; without this one, a gate that reads only
    // home.personId passes the file (mutant C2, run 2026-10-09).
    const s = await seed();
    await sql`delete from entrant_members where entrant_id = ${s.away.entrantId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "no_person",
    });
    noHttp();
  });

  it("a BYE row ⇒ no_person, even though the guard refuses it before any side is loaded", async () => {
    const s = await seed();
    await sql`
      update fixtures
         set away_entrant_id = null,
             away_slot_label = ${sql.json({ key: "bracket.slot.bye" } as never)}
       where id = ${s.fixtureId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "no_person",
    });
    noHttp();
  });

  it("empty case: a fixture id that does not exist ⇒ not_ready, NOT no_person", async () => {
    // The differential that stops no_person becoming the catch-all for every
    // guard refusal. Without it, "classify the null" can be implemented as
    // "always say no_person" and every test above still passes.
    expect(await createGameIfReady(randomUUID(), { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("another sport: a non-boardgame fixture with both entrants ⇒ not_ready, not no_person", async () => {
    const { seedOrg, seedFutureDivision } = await import("./_seed");
    const { auth } = await seedOrg();
    const { fixtures } = await seedFutureDivision(auth);
    const fixture = fixtures[0];
    if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
    const [premise] = await sql<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixture.id}`;
    expect(premise?.home && premise?.away, "premise: both entrants present").toBeTruthy();
    expect(await createGameIfReady(fixture.id, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("online play off ⇒ not_ready, not no_person", async () => {
    const s = await seed({ onlinePlay: "off" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });
});

/** T2 stores scopes and a consent stamp; the seed links with both set. These
 *  helpers break one requirement at a time so each guard is individually
 *  killable. */
async function clearConsent(userId: string) {
  // V433's consent/token CHECK forbids a stored token without a consent stamp,
  // so an identity-only (legacy) row is modelled the way one really looks: no
  // stamp AND no token.
  await sql`
    update user_external_accounts set consented_at = null, access_token_enc = null
     where user_id = ${userId}`;
}
async function narrowScopes(userId: string, scopes: string[]) {
  await sql`
    update user_external_accounts set scopes = ${sql.array(scopes)} where user_id = ${userId}`;
}
/** PRE-GATE legacy data: createDivision now refuses an online clock outside
 *  the catalogue (T6), so a division carrying one can only be a row saved
 *  before that gate existed. Written by SQL after a valid create, to model it. */
async function legacyClock(divisionId: string, clock: { base: number; increment?: number; delay?: number }) {
  await sql`
    update divisions set config = jsonb_set(config, '{clock}', ${sql.json(clock as never)})
     where id = ${divisionId}`;
}

describe.skipIf(!process.env.DATABASE_URL)("readiness", () => {
  it("D12: a paired-but-UNOPENED round creates nothing", async () => {
    // Fixtures exist because Swiss paired them; nothing has been sent. This
    // is the state that used to be indistinguishable from "window open" when
    // the anchor was the timetable.
    const s = await seed({ roundOpenedAt: undefined });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("D12: a past scheduled time with no open stamp still creates nothing", async () => {
    const s = await seed({ roundOpenedAt: undefined });
    expect(
      await createGameIfReady(s.fixtureId, { now: new Date(T.getTime() + 5 * 60_000) }),
    ).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("past T+20 of the open stamp ⇒ not_ready", async () => {
    const { DEADLINE_AFTER_MS } = await import("@/server/external-play/window");
    const s = await seed();
    expect(
      await createGameIfReady(s.fixtureId, { now: new Date(OPENED.getTime() + DEADLINE_AFTER_MS + 1) }),
    ).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  // Fix round 2 (controller ruling): the grant refusals are NAMED, never a
  // bare not_ready — T14's re-link screen is drawn on these two reasons.
  it("a player who has not re-consented ⇒ lichess_reconsent_required", async () => {
    // Spec §3.1: players linked under the identity-only flow must see the
    // re-consent screen before their first online fixture.
    const s = await seed();
    await clearConsent(s.home.userId);
    expect(await getLichessLink(s.home.userId).then((l) => l?.consentedAt), "premise").toBeNull();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "lichess_reconsent_required",
    });
    noHttp();
  });

  it("a player with no Lichess link at all ⇒ lichess_link_required", async () => {
    const s = await seed();
    await sql`delete from user_external_accounts where user_id = ${s.away.userId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "lichess_link_required",
    });
    noHttp();
  });

  it("a player missing board:play ⇒ lichess_reconsent_required (separately from consent)", async () => {
    const s = await seed();
    await narrowScopes(s.away.userId, ["challenge:write"]);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "lichess_reconsent_required",
    });
    noHttp();
  });

  it("a player missing challenge:write ⇒ lichess_reconsent_required", async () => {
    const s = await seed();
    await narrowScopes(s.home.userId, ["board:play"]);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "lichess_reconsent_required",
    });
    noHttp();
  });

  it("a player holding the PRE-AMENDMENT grant (board:play + challenge:write, no challenge:read) ⇒ lichess_reconsent_required", async () => {
    // Spec §3.1 amended 2026-10-10: without challenge:read the crash-recovery
    // lookup is a measured 403, so such a link must re-consent before a game
    // is made for it. Typed: it is what the earlier consent screen granted.
    const s = await seed();
    await narrowScopes(s.home.userId, ["board:play", "challenge:write"]);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "lichess_reconsent_required",
    });
    noHttp();
  });

  it("sweeps every required scope on BOTH sides, dropping one at a time, and reports the count", async () => {
    // Derived from T2's PLAY_SCOPES — the one authority for "the grant that
    // is enough to play" — never a list typed in here. The premise line pins
    // it to spec §3.1's three scopes, so a shrunken PLAY_SCOPES fails loudly.
    const required = [...PLAY_SCOPES];
    expect([...required].sort(), "premise: spec §3.1 asks for exactly these").toEqual([
      "board:play",
      "challenge:read",
      "challenge:write",
    ]);
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      for (const dropped of required) {
        const s = await seed();
        await narrowScopes(s[side].userId, required.filter((x) => x !== dropped));
        const got = await createGameIfReady(s.fixtureId, { now: NOW });
        expect(got, `${side} without ${dropped}`).toEqual({ created: false, reason: "lichess_reconsent_required" });
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every required scope, on each side").toBe(required.length * 2);
    noHttp();
  });

  it("a seat refused on the GRANT keeps its name (fix round 2) — swept over both reasons; any other refusal stays not_ready", async () => {
    let checked = 0;
    for (const reason of ["lichess_link_required", "lichess_reconsent_required"] as const) {
      const s = await seed();
      // Our own gate passed (the seed's grant is full); the seat, a moment
      // later, says the grant is gone — e.g. an unlink between the two reads.
      preflight.seatPlayer.mockResolvedValueOnce({ seated: true, participant: null })
        .mockResolvedValueOnce({ seated: false, reason });
      expect(await createGameIfReady(s.fixtureId, { now: NOW }), reason).toEqual({ created: false, reason });
      checked += 1;
    }
    expect(checked).toBe(2);
    noHttp();
  });

  it("a refused SEAT ⇒ not_ready, and no Lichess call (the creation half of Review Focus 3)", async () => {
    const s = await seed({ cameraPolicy: "required" });
    preflight.seatPlayer.mockResolvedValue({ seated: false, reason: "camera_lost", participant: {} });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("BOTH seats are checked, not just the first — each with the caller's clock", async () => {
    const s = await seed({ cameraPolicy: "required" });
    preflight.seatPlayer.mockImplementation(async (a: { personId: string }) =>
      a.personId === s.away.personId
        ? { seated: false, reason: "camera_required", participant: {} }
        : { seated: true, participant: null },
    );
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    // Each seat is re-verified against THIS call's clock: the seat's window
    // check and creation's must read the same instant (T8 re-entry, D12).
    expect(preflight.seatPlayer).toHaveBeenCalledTimes(2);
    expect(preflight.seatPlayer).toHaveBeenCalledWith(
      { fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW });
    expect(preflight.seatPlayer).toHaveBeenCalledWith(
      { fixtureId: s.fixtureId, personId: s.away.personId }, { now: NOW });
    noHttp();
  });

  it("a board withdrawn BEFORE the queue (league expunge ⇒ abandoned) ⇒ not_ready, no seat asked", async () => {
    // MEASURED (T8, 2026-10-09): guard.ts still LOADS an abandoned board, so
    // creation must refuse it itself — through T8's isPlayableFixtureStatus.
    const s = await seed();
    const out = await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
    expect(out.policy, "premise: the league expunge path ran").toBe("expunge");
    expect(fx?.status, "premise: the board is abandoned").toBe("abandoned");
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    expect(preflight.seatPlayer).not.toHaveBeenCalled();
    noHttp();
  });

  it("a clock outside the ship-1 list ⇒ unplayable, and no call is made (M12)", async () => {
    // 1+0 is the dangerous case the whole time-control rule exists for:
    // Lichess ACCEPTS the challenge and then refuses every move on it.
    const s = await seed();
    await legacyClock(s.divisionId, { base: 60, increment: 0 });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "unplayable",
    });
    noHttp();
  });

  it("sweeps the whole ship-1 list and confirms each one is accepted here, at its own clock", async () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const s = await seed({ clock: { base: tc.limitSeconds, increment: tc.incrementSeconds } });
      const got = await createGameIfReady(s.fixtureId, { now: NOW });
      expect(got, `${tc.key} must be creatable`).toEqual({ created: true, gameId: GM });
      const sent = board.createChallengeToUser.mock.calls[0]?.[0] as {
        limitSeconds: number; incrementSeconds: number;
      };
      expect([sent.limitSeconds, sent.incrementSeconds], `${tc.key} is sent as itself`).toEqual([
        tc.limitSeconds,
        tc.incrementSeconds,
      ]);
      checked += 1;
      vi.clearAllMocks();
      __resetCreationQueue();
      GM = freshGameId();
      board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
      board.acceptChallenge.mockResolvedValue({ ok: true });
      preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
    }
    // Derived from T5's own catalogue, never a number typed in here: adding
    // a time control moves this test with it.
    expect(checked, "anti-vacuity: every catalogue entry").toBe(SHIP1_TIME_CONTROLS.length);
    expect(SHIP1_TIME_CONTROLS.length, "premise: the catalogue is not empty").toBeGreaterThan(0);
  });
});

type BridgeSnapshot = {
  status: string;
  challenge_id: string | null;
  white_side: string | null;
  white_lichess_id: string | null;
  black_lichess_id: string | null;
  mint_claimed_at: Date | null;
  expires_at: Date | null;
  needs_reason: string | null;
  last_error: string | null;
};
async function bridge(fixtureId: string): Promise<BridgeSnapshot | undefined> {
  const [row] = await sql<BridgeSnapshot[]>`
    select status, challenge_id, white_side, white_lichess_id, black_lichess_id,
           mint_claimed_at, expires_at, needs_reason, last_error
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return row;
}

/** Holds the REAL queue's serial tail until released, so a create behind it
 *  is genuinely WAITING in the queue. Its challenger is unique, so it never
 *  shares a budget with a player. */
function blockQueue() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = enqueueCreation(
    { key: `blocker-${randomUUID()}`, challenger: `blocker-${randomUUID().slice(0, 8)}` },
    () => gate,
  );
  return {
    release: async () => {
      open();
      await done;
    },
  };
}
async function waitUntilQueued(fixtureId: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!queue.enqueued.some((r) => r.key === fixtureId)) throw new Error("not queued yet");
    },
    { timeout: 15_000, interval: 20 },
  );
}

describe.skipIf(!process.env.DATABASE_URL)("creation", () => {
  it("White's token challenges Black's username, and Black's token accepts", async () => {
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    const challenge = board.createChallengeToUser.mock.calls[0]?.[0] as {
      whiteToken: string; blackUsername: string; limitSeconds: number; incrementSeconds: number;
    };
    // No pairing card recorded ⇒ White is home (Swiss's own default,
    // guard.ts whiteSideOf).
    expect(challenge.blackUsername).toBe(s.away.lichessId);
    // 5+3 is what the division stores (the seed's clock above).
    expect(challenge.limitSeconds).toBe(300);
    expect(challenge.incrementSeconds).toBe(3);
    // The seed seals `lio_seed_<lichessId>` for each player (_external-play-
    // seed.ts): the token sent is the one OPENED for White, not a stand-in.
    expect(challenge.whiteToken).toBe(`lio_seed_${s.home.lichessId}`);
    expect(board.acceptChallenge).toHaveBeenCalledTimes(1);
    const accept = board.acceptChallenge.mock.calls[0]?.[0] as { blackToken: string; challengeId: string };
    expect(accept.challengeId).toBe(GM);
    expect(accept.blackToken).toBe(`lio_seed_${s.away.lichessId}`);
  });

  it("records the bridge row: ready, the challenge id, the colour, both ids, the OPEN deadline, no claim left", async () => {
    const s = await seed();
    await createGameIfReady(s.fixtureId, { now: NOW });
    const row = await bridge(s.fixtureId);
    expect(row?.status).toBe("ready");
    expect(row?.challenge_id).toBe(GM);
    expect(row?.white_side).toBe("home");
    expect(row?.white_lichess_id).toBe(s.home.lichessId);
    expect(row?.black_lichess_id).toBe(s.away.lichessId);
    // D12: T+20 of the organiser's OPEN, never of the timetable (T is ten
    // minutes later than OPENED here, so the two deadlines differ).
    expect(row?.expires_at?.toISOString()).toBe(windowFor(OPENED).deadline.toISOString());
    expect(windowFor(OPENED).deadline.getTime(), "premise: the anchors differ").not.toBe(
      windowFor(T).deadline.getTime(),
    );
    expect(row?.mint_claimed_at, "the claim is released on success").toBeNull();
    expect(row?.last_error).toBeNull();
  });

  it("colour is READ from the pairing, not assigned: a card making home Black swaps both sides", async () => {
    const s = await seed();
    await appendEvent(s.orgId, s.fixtureId, 0, {
      type: "boardgame.pairing",
      payload: { white: s.away.entrantId },
    });
    await createGameIfReady(s.fixtureId, { now: NOW });
    const challenge = board.createChallengeToUser.mock.calls[0]?.[0] as { blackUsername: string; whiteToken: string };
    // The differential case: an implementation that always challenges from
    // home answers s.away.lichessId here, which is the opposite.
    expect(challenge.blackUsername).toBe(s.home.lichessId);
    expect(challenge.whiteToken).toBe(`lio_seed_${s.away.lichessId}`);
    const row = await bridge(s.fixtureId);
    expect(row?.white_side).toBe("away");
    expect(row?.white_lichess_id).toBe(s.away.lichessId);
    expect(row?.black_lichess_id).toBe(s.home.lichessId);
    // White's account is the throttle's challenger: lila's per-challenger
    // budget is the CREATOR's.
    expect(queue.enqueued.filter((r) => r.key === s.fixtureId)).toEqual([
      { key: s.fixtureId, challenger: s.away.lichessId },
    ]);
  });

  it("sequence: a SECOND call answers already and makes no second challenge", async () => {
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(board.createChallengeToUser, "exactly one challenge for one fixture").toHaveBeenCalledTimes(1);
  });

  it("sequence: two CONCURRENT creates for one fixture make exactly one challenge — only the claim winner answers created and publishes", async () => {
    // Fix round 1, Minor a: the queue's in-flight dedupe hands the follower the
    // leader's result; the follower did not create the game, so it answers
    // `already` and does not publish a second time.
    const s = await seed();
    const publish = vi.fn(async () => undefined);
    const results = await Promise.all([
      createGameIfReady(s.fixtureId, { now: NOW, publish }),
      createGameIfReady(s.fixtureId, { now: NOW, publish }),
    ]);
    expect(board.createChallengeToUser, "exactly one challenge").toHaveBeenCalledTimes(1);
    // Which caller enqueues first (and so leads) is a race between their
    // pre-queue reads, so the pair is compared as a multiset.
    const key = (r: CreateOutcome) => JSON.stringify(r);
    expect(results.map(key).sort()).toEqual(
      [{ created: true, gameId: GM }, { created: false, reason: "already" }].map((r) => key(r as CreateOutcome)).sort(),
    );
    expect(publish, "one game, one publish").toHaveBeenCalledTimes(1);
    expect((await bridge(s.fixtureId))?.challenge_id).toBe(GM);
  });

  it("another process holding a FRESH claim wins: nothing is called here", async () => {
    // The in-process queue dedupes by fixture, so a second process is the
    // case the claim UPDATE exists for. Its in-flight claim is a row.
    const s = await seed();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${new Date(NOW.getTime() - MINT_CLAIM_STALE_MS + 1_000)})`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("a STALE claim that never SENT (crashed before the create) is taken over without a human, and nothing is looked up", async () => {
    // No create_sent_at: the minter died between its claim and its send, so
    // nothing can exist at Lichess and the takeover is safe.
    const s = await seed();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${new Date(NOW.getTime() - MINT_CLAIM_STALE_MS - 1)})`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(board.listOutgoingChallenges, "no marker, no lookup").not.toHaveBeenCalled();
    expect(board.listOngoingGames).not.toHaveBeenCalled();
  });

  it("a STALE claim that carries the SENT marker is never retaken blind: both lookups run BEFORE any create (I2, flipped)", async () => {
    // The minter died after Lichess answered 2xx and before our commit — the
    // purest outcome_unknown there is. Until fix round 1 this case re-created
    // with no lookup.
    const s = await seed();
    const stale = new Date(NOW.getTime() - MINT_CLAIM_STALE_MS - 1);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${stale}, ${stale})`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    const whiteToken = `lio_seed_${s.home.lichessId}`;
    expect(board.listOutgoingChallenges).toHaveBeenCalledWith(whiteToken);
    expect(board.listOngoingGames).toHaveBeenCalledWith(whiteToken);
    const create = board.createChallengeToUser.mock.invocationCallOrder[0]!;
    expect(board.listOutgoingChallenges.mock.invocationCallOrder[0]!, "lookup A before the create").toBeLessThan(create);
    expect(board.listOngoingGames.mock.invocationCallOrder[0]!, "lookup B before the create").toBeLessThan(create);
  });

  it("the lobby is published once, on success only", async () => {
    const s = await seed();
    const publish = vi.fn(async () => undefined);
    await createGameIfReady(s.fixtureId, { now: NOW, publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(s.fixtureId);
    publish.mockClear();
    await createGameIfReady(s.fixtureId, { now: NOW, publish });
    expect(publish, "an 'already' must not re-publish").not.toHaveBeenCalled();
    const failing = await seed();
    board.createChallengeToUser.mockResolvedValue({ ok: false, code: "outcome_unknown", raw: "" });
    await createGameIfReady(failing.fixtureId, { now: NOW, publish });
    expect(publish, "a failed create must not publish").not.toHaveBeenCalled();
  });

  it("a 429 ⇒ provider_error, the claim is released, retryAt recorded, and the retry waits out the hold", async () => {
    let queueNow = Date.parse("2026-10-01T12:05:00.000Z");
    __setCreationQueueDeps({ now: () => queueNow });
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.status, "still pending, so the sweep can try again").toBe("pending");
    expect(row?.mint_claimed_at, "a held claim would lock the fixture for 30s of nothing").toBeNull();
    expect(row?.last_error).toContain("rate_limited");
    // retryAt comes from T4's hold, derived from its own constant.
    expect(row?.last_error).toContain(`retry_at=${new Date(queueNow + CREATION_429_HOLD_MS).toISOString()}`);

    // Inside the hold, the retry is refused by the queue — NOT sent.
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    expect(board.createChallengeToUser, "the hold fired: nothing sent inside it").toHaveBeenCalledTimes(1);

    // Past the hold, the retry really does retry.
    queueNow += CREATION_429_HOLD_MS + 1;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(2);
  });

  it("a 429 STORM: one White held, every retry refused unsent, another White unaffected, then exactly one game", async () => {
    let queueNow = Date.parse("2026-10-01T12:05:00.000Z");
    __setCreationQueueDeps({ now: () => queueNow });
    const held = await seed();
    const other = await seed();
    const otherGame = freshGameId();
    board.createChallengeToUser.mockImplementation(async (a: { blackUsername: string }) =>
      a.blackUsername === held.away.lichessId
        ? { ok: false, code: "rate_limited", raw: "Too many requests. Try again later." }
        : { ok: true, challengeId: otherGame },
    );
    let storm = 0;
    for (let i = 0; i < 5; i += 1) {
      expect(await createGameIfReady(held.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "provider_error",
      });
      storm += 1;
    }
    expect(storm, "anti-vacuity: the storm ran").toBe(5);
    const sentForHeld = () =>
      board.createChallengeToUser.mock.calls.filter(([a]) => (a as { blackUsername: string }).blackUsername === held.away.lichessId).length;
    expect(sentForHeld(), "one 429 sent; the other four refused by the hold").toBe(1);
    expect((await bridge(held.fixtureId))?.mint_claimed_at).toBeNull();
    // Another challenger is not held by this one's 429.
    expect(await createGameIfReady(other.fixtureId, { now: NOW })).toEqual({ created: true, gameId: otherGame });

    queueNow += CREATION_429_HOLD_MS + 1;
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
    expect(await createGameIfReady(held.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(await createGameIfReady(held.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(sentForHeld(), "exactly one more create after the hold, then none").toBe(2);
  });

  it("a TIMEOUT (outcome_unknown) holds the fixture for an organiser; the retry creates nothing", async () => {
    // A challenge MAY exist at Lichess. Releasing the claim would let the
    // retry make a second game for the board.
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.status).toBe("needs_organiser");
    expect(row?.needs_reason).toBe("provider_error");
    expect(row?.last_error).toContain("outcome_unknown");
    expect(row?.challenge_id, "there is no id to record").toBeNull();
    // The provider would now accept a create — and none is made.
    preflight.seatPlayer.mockClear();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser, "no duplicate game after a timeout").toHaveBeenCalledTimes(1);
    expect(preflight.seatPlayer, "a held board does not re-open the seats").not.toHaveBeenCalled();
    expect(queue.enqueued.filter((r) => r.key === s.fixtureId), "nor queue again").toHaveLength(1);
  });

  it("an UNCLASSIFIED 400 on create is held like a timeout (lila may have inserted, then .rescue'd)", async () => {
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({
      ok: false, code: "unavailable", raw: '{"error":"Something unexpected"}',
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    expect((await bridge(s.fixtureId))?.status).toBe("needs_organiser");
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
  });

  it("White's token REJECTED at create ⇒ token_revoked (spec §3.6), not a provider fault", async () => {
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "unauthorized", raw: "No such token" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.status).toBe("needs_organiser");
    expect(row?.needs_reason).toBe("token_revoked");
    expect(row?.challenge_id).toBeNull();
    expect(board.acceptChallenge).not.toHaveBeenCalled();
  });

  it("an ACCEPT failure records the challenge id and holds the fixture for an organiser", async () => {
    // The challenge exists at Lichess. Forgetting it would let a retry mint
    // a SECOND game for the same board, which is exactly what the unique
    // index on challenge_id exists to make impossible.
    const s = await seed();
    board.acceptChallenge.mockResolvedValue({ ok: false, code: "unavailable", raw: "Bad gateway" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.challenge_id).toBe(GM);
    expect(row?.status).toBe("needs_organiser");
    expect(row?.needs_reason).toBe("provider_error");
    expect(row?.white_side).toBe("home");
    expect(row?.white_lichess_id).toBe(s.home.lichessId);
    expect(row?.black_lichess_id).toBe(s.away.lichessId);
    expect(row?.mint_claimed_at).toBeNull();
    // A retry must not create anything.
    board.createChallengeToUser.mockClear();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
  });

  it("Black's token REJECTED at accept ⇒ token_revoked, the game still recorded", async () => {
    const s = await seed();
    board.acceptChallenge.mockResolvedValue({ ok: false, code: "unauthorized", raw: "No such token" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.needs_reason).toBe("token_revoked");
    expect(row?.challenge_id).toBe(GM);
  });

  it("Black's token UNAVAILABLE (stored, cannot be opened) ⇒ 503 propagates, nothing created, claim released", async () => {
    const s = await seed();
    // A ciphertext the key cannot open: getLichessAccessToken's
    // `decrypt_failed` path, which throws 503 LICHESS_TOKEN_UNAVAILABLE.
    await sql`
      update user_external_accounts set access_token_enc = ${Buffer.from("not-a-sealed-token")}
       where user_id = ${s.away.userId}`;
    await expect(createGameIfReady(s.fixtureId, { now: NOW })).rejects.toMatchObject({
      status: 503,
      code: "LICHESS_TOKEN_UNAVAILABLE",
    });
    noHttp();
    const row = await bridge(s.fixtureId);
    expect(row?.status).toBe("pending");
    expect(row?.mint_claimed_at, "released, so the fixture is not locked").toBeNull();
    expect(row?.last_error).toBe("token_unavailable");
    // Once the token can be opened again, the retry creates.
    const { upsertLichessLink } = await import("../external-accounts");
    await upsertLichessLink(s.away.userId, {
      externalUserId: s.away.lichessId,
      username: s.away.lichessId,
      scopes: [...PLAY_SCOPES],
      token: `lio_seed_${s.away.lichessId}`,
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
  });

  it("a failed create never touches ANOTHER claimant's claim (release and hold are both conditional on our own)", async () => {
    // A takeover lands during the call, then our call fails. Releasing or
    // holding by fixture alone would clear the new claimant's in-flight work.
    let checked = 0;
    for (const failure of [
      { ok: false, code: "rate_limited", raw: "Too many requests" },
      { ok: false, code: "outcome_unknown", raw: "" },
    ]) {
      __resetCreationQueue();
      const s = await seed();
      const theirs = new Date(NOW.getTime() + 1_000);
      board.createChallengeToUser.mockImplementationOnce(async () => {
        await sql`update fixture_external_play set mint_claimed_at = ${theirs} where fixture_id = ${s.fixtureId}`;
        return failure;
      });
      await createGameIfReady(s.fixtureId, { now: NOW });
      const row = await bridge(s.fixtureId);
      expect(row?.mint_claimed_at?.toISOString(), `${failure.code}: their claim stands`).toBe(theirs.toISOString());
      expect(row?.status, `${failure.code}: still theirs to finish`).toBe("pending");
      checked += 1;
    }
    expect(checked, "anti-vacuity: the release path and the hold path").toBe(2);
  });

  it("a throttled call never overwrites another claimant's in-flight record", async () => {
    const queueNow = Date.parse("2026-10-01T12:05:00.000Z");
    __setCreationQueueDeps({ now: () => queueNow });
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await createGameIfReady(s.fixtureId, { now: NOW }); // White is now held for a minute
    // Another process has since claimed the board and is mid-create.
    await sql`update fixture_external_play set mint_claimed_at = ${NOW}, last_error = 'theirs'
               where fixture_id = ${s.fixtureId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "provider_error",
    });
    expect((await bridge(s.fixtureId))?.last_error).toBe("theirs");
    // The refusal came from the queue's hold (the clock has not moved), so
    // nothing was sent.
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
  });

  it("RE-LINKED to a different Lichess account while queued ⇒ not_ready, nothing sent to the old one", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    const { upsertLichessLink } = await import("../external-accounts");
    const relinked = `b-${randomUUID().slice(0, 8)}`;
    await upsertLichessLink(s.away.userId, {
      externalUserId: relinked,
      username: relinked,
      scopes: [...PLAY_SCOPES],
      token: `lio_seed_${relinked}`,
    });
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("a takeover mid-flight is refused rather than stomping the new claimant", async () => {
    // The one case a plain `status = 'pending'` guard on the ready commit
    // misses: status never leaves 'pending' during a takeover, only
    // mint_claimed_at changes. Driven by having the MOCK bump the stamp
    // during the call — the real race, no production hook.
    const s = await seed();
    const stomp = freshGameId();
    board.createChallengeToUser.mockImplementation(async () => {
      await sql`
        update fixture_external_play set mint_claimed_at = ${new Date(NOW.getTime() + 1_000)}
         where fixture_id = ${s.fixtureId}`;
      return { ok: true, challengeId: stomp };
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    const row = await bridge(s.fixtureId);
    expect(row?.challenge_id, "the loser's challenge is NOT recorded").toBeNull();
    expect(row?.status).toBe("pending");
    // Minor b: the stray game this call made is closed at Lichess, with
    // White's token (the challenger's), best-effort.
    expect(board.cancelChallenge).toHaveBeenCalledTimes(1);
    expect(board.cancelChallenge).toHaveBeenCalledWith({ token: `lio_seed_${s.home.lichessId}`, challengeId: stomp });
  });

  it("creation goes through the throttle queue, keyed per fixture, White as the challenger", async () => {
    const s = await seed();
    await createGameIfReady(s.fixtureId, { now: NOW });
    expect(queue.enqueued).toEqual([{ key: s.fixtureId, challenger: s.home.lichessId }]);
  });

  it("the claim SURVIVES the queue wait: none is held while a create waits", async () => {
    // Controller ruling: a claim stamped before the wait could age past
    // MINT_CLAIM_STALE_MS behind a long queue and hand a second claimant the
    // same board. So none is taken until the create leaves the queue.
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    const whileQueued = await bridge(s.fixtureId);
    expect(whileQueued?.mint_claimed_at ?? null, "no claim to go stale while queued").toBeNull();
    noHttp();
    await blocker.release();
    expect(await pending).toEqual({ created: true, gameId: GM });
  });

  it("WITHDRAWN while queued ⇒ not_ready, and no game is created on the abandoned board", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    await withdrawEntrantCascade(await mintOrgOwnerAuth(s.orgId), s.away.entrantId);
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
    expect(fx?.status, "premise: withdrawn while queued").toBe("abandoned");
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("RE-PAIRED while queued (the sides swapped) ⇒ not_ready, nothing created", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    await sql`
      update fixtures set home_entrant_id = ${s.away.entrantId}, away_entrant_id = ${s.home.entrantId}
       where id = ${s.fixtureId}`;
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("RE-PAIRED while queued to a different ENTRANT holding the same player ⇒ not_ready, nothing created", async () => {
    // The swap case above is also caught by the Lichess-id re-check; this one
    // is not — the two accounts are unchanged, only the fixture's entrant is
    // another row (mutant Mi survived without it, run 2026-10-09). A game
    // recorded against the old pairing would score the wrong entrant.
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    const [copy] = await sql<{ id: string }[]>`
      insert into entrants
      select (jsonb_populate_record(null::entrants, to_jsonb(e) || jsonb_build_object('id', gen_random_uuid()))).*
        from entrants e where e.id = ${s.away.entrantId}
      returning id`;
    await sql`insert into entrant_members (entrant_id, person_id) values (${copy!.id}, ${s.away.personId})`;
    await sql`update fixtures set away_entrant_id = ${copy!.id} where id = ${s.fixtureId}`;
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("COLOURS re-allocated while queued (a pairing card) ⇒ not_ready, nothing created", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    await appendEvent(s.orgId, s.fixtureId, 0, {
      type: "boardgame.pairing",
      payload: { white: s.away.entrantId },
    });
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("RESCHEDULED while queued ⇒ not_ready, nothing created", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    await sql`update fixtures set scheduled_at = ${new Date(T.getTime() + 60 * 60_000)} where id = ${s.fixtureId}`;
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
  });

  it("created by ANOTHER process while queued ⇒ already, and no second game", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    const theirs = freshGameId();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id,
                                         white_side, white_lichess_id, black_lichess_id)
      values (${s.fixtureId}, ${s.orgId}, ${T}, 'ready', ${theirs}, 'home', ${s.home.lichessId}, ${s.away.lichessId})`;
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "already" });
    noHttp();
    expect((await bridge(s.fixtureId))?.challenge_id).toBe(theirs);
  });

  it("a player DOWNGRADED to identity-only while queued (no token left) ⇒ not_ready, claim released", async () => {
    const s = await seed();
    const blocker = blockQueue();
    const pending = createGameIfReady(s.fixtureId, { now: NOW });
    await waitUntilQueued(s.fixtureId);
    await clearConsent(s.away.userId);
    await blocker.release();
    expect(await pending).toEqual({ created: false, reason: "not_ready" });
    noHttp();
    const row = await bridge(s.fixtureId);
    expect(row?.mint_claimed_at).toBeNull();
    expect(row?.last_error).toBe("no_stored_token");
  });

  it("a create that WAITED past T+20 in the queue creates nothing (the deadline is read at dequeue)", async () => {
    // Production path: no injected clock. Only Date is faked (after the
    // seed, so setup runs on the real clock); timers and I/O stay real.
    const s = await seed();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const blocker = blockQueue();
      const pending = createGameIfReady(s.fixtureId);
      await waitUntilQueued(s.fixtureId);
      vi.setSystemTime(new Date(windowFor(OPENED).deadline.getTime() + 1_000));
      await blocker.release();
      expect(await pending).toEqual({ created: false, reason: "not_ready" });
      noHttp();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sequence: the SECOND player (Black) arriving first creates nothing; White's arrival creates White's challenge", async () => {
    const s = await seed();
    const arrived = new Set<string>([s.away.personId]);
    preflight.seatPlayer.mockImplementation(async (a: { personId: string }) =>
      arrived.has(a.personId)
        ? { seated: true, participant: null }
        : { seated: false, reason: "camera_required", participant: {} },
    );
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    noHttp();
    arrived.add(s.home.personId);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    const challenge = board.createChallengeToUser.mock.calls[0]?.[0] as { whiteToken: string; blackUsername: string };
    expect(challenge.whiteToken, "White creates, whoever arrived first").toBe(`lio_seed_${s.home.lichessId}`);
    expect(challenge.blackUsername).toBe(s.away.lichessId);
  });

  it("T8 re-entry: a player seated on a game THIS created is let back in at T+40 (real seat, real game)", async () => {
    // The real producer feeding the real consumer: T8's seatPlayer (policy
    // off, so no RealtimeKit) seats both for creation, and at T+40 its
    // re-entry reads the bridge row this task wrote.
    const real = await vi.importActual<typeof import("../external-play/preflight")>("../external-play/preflight");
    preflight.seatPlayer.mockImplementation(real.seatPlayer);
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    const T40 = new Date(OPENED.getTime() + 40 * 60_000);
    let checked = 0;
    for (const personId of [s.home.personId, s.away.personId]) {
      expect(await real.seatPlayer({ fixtureId: s.fixtureId, personId }, { now: T40 })).toEqual({
        seated: true,
        participant: null,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: both players").toBe(2);
    // The differential: the same seat at T+40 on a board with NO game.
    const bare = await seed();
    expect(
      await real.seatPlayer({ fixtureId: bare.fixtureId, personId: bare.home.personId }, { now: T40 }),
    ).toEqual({ seated: false, reason: "window_closed" });
  });

  it("enumerates every CreateOutcome reason and reports the count", async () => {
    // A Record over the declared union: a new reason fails to COMPILE until a
    // case for it exists here, and the runtime set must match it.
    type Reason = Extract<CreateOutcome, { created: false }>["reason"];
    const produced = new Set<Reason>();
    const builders: Record<Reason, () => Promise<void>> = {
      not_ready: async () => {
        const s = await seed({ roundOpenedAt: undefined });
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      already: async () => {
        const s = await seed();
        await createGameIfReady(s.fixtureId, { now: NOW });
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      unplayable: async () => {
        const s = await seed();
        await legacyClock(s.divisionId, { base: 60, increment: 0 });
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      provider_error: async () => {
        const s = await seed();
        board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "unavailable", raw: "x" });
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      no_person: async () => {
        const s = await seed();
        await sql`delete from entrant_members where entrant_id = ${s.home.entrantId}`;
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      // Fix round 2: the play grant's two named refusals.
      lichess_link_required: async () => {
        const s = await seed();
        await sql`delete from user_external_accounts where user_id = ${s.away.userId}`;
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      lichess_reconsent_required: async () => {
        const s = await seed();
        await clearConsent(s.home.userId);
        const r = await createGameIfReady(s.fixtureId, { now: NOW });
        if (!r.created) produced.add(r.reason);
      },
      // T20: the club not offered online chess. The override off and no PostHog in the test env — the flag's own
      // fallback (off) answers, through the real evaluator. Restored before the next case.
      online_chess_disabled: async () => {
        const s = await seed();
        vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
        forgetOnlineChessFlagCache();
        try {
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
        } finally {
          vi.unstubAllEnvs();
          forgetOnlineChessFlagCache();
        }
      },
    };
    const declared = Object.keys(builders) as Reason[];
    for (const reason of declared) {
      GM = freshGameId();
      board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
      await builders[reason]();
    }
    expect([...produced].sort(), "every declared reason is reachable").toEqual([...declared].sort());
    expect(produced.size, "anti-vacuity: eight reasons, eight cases").toBe(8);
  });
});

// Fix round 1, I1 (controller ruling 2026-10-10): a bridge row that carries a
// challenge_id is NEVER stale, whatever its status, and a reschedule resets
// only a `pending` row with no challenge. D12 anchors the window on the
// round's open, so a moved timetable cannot un-create a game. Each case below
// was reproduced by the reviewer's probe as a SECOND create (2 upstream calls).
describe.skipIf(!process.env.DATABASE_URL)("I1 — a reschedule never makes a second game", () => {
  const reschedule = async (fixtureId: string, minutes: number) => {
    await sql`update fixtures set scheduled_at = ${new Date(T.getTime() + minutes * 60_000)} where id = ${fixtureId}`;
  };

  it("a reschedule AFTER a ready create: the second call is already, one create, A's id kept", async () => {
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    const a = GM;
    await reschedule(s.fixtureId, 2);
    GM = freshGameId(); // what a second create WOULD be answered with
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(board.createChallengeToUser, "exactly one create for one board").toHaveBeenCalledTimes(1);
    const row = await bridge(s.fixtureId);
    expect(row?.status).toBe("ready");
    expect(row?.challenge_id, "A's id still recorded").toBe(a);
  });

  it("a reschedule after an ACCEPT failure that recorded the challenge: one create, A's id kept, still held", async () => {
    const s = await seed();
    board.acceptChallenge.mockResolvedValueOnce({ ok: false, code: "unavailable", raw: "x" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    const a = GM;
    await reschedule(s.fixtureId, 2);
    GM = freshGameId();
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    const row = await bridge(s.fixtureId);
    expect(row?.status, "the organiser's hold survives the reschedule").toBe("needs_organiser");
    expect(row?.challenge_id).toBe(a);
  });

  it("a reschedule after an outcome_unknown hold (no id to record): one create, still held", async () => {
    const s = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    await reschedule(s.fixtureId, 2);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser, "a held unknown outcome is never re-created").toHaveBeenCalledTimes(1);
    expect((await bridge(s.fixtureId))?.status).toBe("needs_organiser");
  });

  it("a challenge-less PENDING row still resets: it is rebased onto the new time and created", async () => {
    const s = await seed();
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, last_error)
      values (${s.fixtureId}, ${s.orgId}, ${oldBasis}, 'create:rate_limited (challenger) retry_at=unknown')`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    const [row] = await sql<{ scheduled_at_basis: Date; challenge_id: string | null }[]>`
      select scheduled_at_basis, challenge_id from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(row?.scheduled_at_basis.getTime(), "rebased onto the fixture's current time").toBe(T.getTime());
    expect(row?.challenge_id).toBe(GM);
  });

  it("a reschedule never clears ANOTHER process's in-flight claim on a pending row", async () => {
    // Another process claimed and is mid-create; the board's time then moved.
    // Clearing its claim would let this call create a second game beside it.
    const s = await seed();
    const oldBasis = new Date(T.getTime() - 60 * 60_000);
    const theirs = new Date(NOW.getTime() - 1_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at)
      values (${s.fixtureId}, ${s.orgId}, ${oldBasis}, ${theirs})`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    noHttp();
    expect((await bridge(s.fixtureId))?.mint_claimed_at?.getTime(), "their claim intact").toBe(theirs.getTime());
  });

  it("T8 re-entry still holds on a RESCHEDULED ready game (real seat, real game)", async () => {
    const real = await vi.importActual<typeof import("../external-play/preflight")>("../external-play/preflight");
    preflight.seatPlayer.mockImplementation(real.seatPlayer);
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    await reschedule(s.fixtureId, 15);
    const T40 = new Date(OPENED.getTime() + 40 * 60_000);
    let checked = 0;
    for (const personId of [s.home.personId, s.away.personId]) {
      expect(await real.seatPlayer({ fixtureId: s.fixtureId, personId }, { now: T40 })).toEqual({
        seated: true,
        participant: null,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: both players").toBe(2);
  });
});

// Fix round 1, I2 (controller ruling 2026-10-10): a durable "create sent"
// marker is written as its own committed statement BEFORE the challenge HTTP
// call. A claim (stale, or re-armed) that carries it is never created blind:
// White's outgoing challenges to Black and White's ongoing games against
// Black are looked up first. Found ⇒ adopt (record, then accept or proceed as
// if created); BOTH lookups succeed and find nothing ⇒ re-create; ANY lookup
// fails ⇒ needs_organiser / create_outcome_unknown, never a re-create.
describe.skipIf(!process.env.DATABASE_URL)("I2 — a create that may have reached Lichess is looked up, never re-sent blind", () => {
  type MarkerRow = { status: string; challenge_id: string | null; needs_reason: string | null;
    mint_claimed_at: Date | null; create_sent_at: Date | null; last_error: string | null };
  const marker = async (fixtureId: string): Promise<MarkerRow | undefined> =>
    (await sql<MarkerRow[]>`
      select status, challenge_id, needs_reason, mint_claimed_at, create_sent_at, last_error
        from fixture_external_play where fixture_id = ${fixtureId}`)[0];
  /** A minter that claimed, SENT, and died before its commit. Returns the
   *  marker's instant — the send. */
  const crashedAfterSend = async (s: Awaited<ReturnType<typeof seed>>): Promise<Date> => {
    const stale = new Date(NOW.getTime() - MINT_CLAIM_STALE_MS - 1);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${stale}, ${stale})`;
    return stale;
  };
  const playing = (gameId: string, opponentId: string, color: "white" | "black" = "white") =>
    ({ gameId, color, opponentId });
  /** N1 (fix round 2) — what OUR create makes, from the inputs: the seed's
   *  stored clock (5+3, `seed` above), unrated, standard (board-api's create
   *  body), and — the controller's ruling — created within
   *  [create_sent_at − 60 s, now]. */
  const OUR_CLOCK = { limit: 300, increment: 3 } as const;
  const SKEW_MS = 60_000;
  type Meta = {
    gameId: string; rated: boolean | null; variant: string | null;
    clockInitialSeconds: number | null; clockIncrementSeconds: number | null; createdAtMs: number | null;
  };
  const ourMeta = (gameId: string, sentAt: Date, over: Partial<Meta> = {}): Meta => ({
    gameId, rated: false, variant: "standard",
    clockInitialSeconds: OUR_CLOCK.limit, clockIncrementSeconds: OUR_CLOCK.increment,
    createdAtMs: sentAt.getTime() + 500, ...over,
  });
  /** Each candidate's export, by id; an id not listed is a failed read. */
  const exportsAnswer = (metas: Record<string, Meta | "fail">) =>
    board.exportGameMeta.mockImplementation(async (id: string) => {
      const m = metas[id];
      return m === undefined || m === "fail"
        ? { ok: false, code: "unavailable", raw: `export ${id} failed` }
        : { ok: true, meta: m };
    });
  /** An outgoing challenge exactly as ours is sent, unless overridden. */
  const ourChallenge = (id: string, destUserId: string | null, over: Record<string, unknown> = {}) => ({
    id, destUserId, status: "created", rated: false, variantKey: "standard",
    timeControl: { type: "clock", limit: OUR_CLOCK.limit, increment: OUR_CLOCK.increment }, color: "white",
    ...over,
  });

  it("premise: every claim segment (two Lichess calls) fits inside the stale window, by the declared constants", () => {
    // The lookups run in parallel (one timeout), and the marker write renews
    // the claim, so no stretch of a claim's life spans more than two calls.
    expect(2 * LICHESS_TIMEOUT_MS).toBeLessThan(MINT_CLAIM_STALE_MS);
  });

  it("the marker is committed BEFORE the create is sent, on this call's claim; the ready commit clears it", async () => {
    const s = await seed();
    let seenAtSend: MarkerRow | undefined;
    board.createChallengeToUser.mockImplementation(async () => {
      seenAtSend = await marker(s.fixtureId); // a separate statement: it sees only COMMITTED state
      return { ok: true, challengeId: GM };
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(seenAtSend?.create_sent_at, "durable before the HTTP call").not.toBeNull();
    expect(seenAtSend?.mint_claimed_at?.getTime(), "written on this call's claim").toBe(seenAtSend?.create_sent_at?.getTime());
    const after = await marker(s.fixtureId);
    expect(after?.create_sent_at, "a recorded game is a known outcome").toBeNull();
    expect(after?.challenge_id).toBe(GM);
  });

  it("FOUND among White's ongoing games (accepted before the crash) and VERIFIED by its export ⇒ adopted: recorded and ready, no create, no accept", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const theirs = freshGameId();
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
    exportsAnswer({ [theirs]: ourMeta(theirs, sent) });
    const publish = vi.fn(async () => undefined);
    expect(await createGameIfReady(s.fixtureId, { now: NOW, publish })).toEqual({ created: true, gameId: theirs });
    expect(board.createChallengeToUser, "never re-sent").not.toHaveBeenCalled();
    expect(board.acceptChallenge, "already accepted at Lichess").not.toHaveBeenCalled();
    const row = await bridge(s.fixtureId);
    expect(row).toMatchObject({ status: "ready", challenge_id: theirs, white_side: "home",
      white_lichess_id: s.home.lichessId, black_lichess_id: s.away.lichessId, mint_claimed_at: null });
    expect((await marker(s.fixtureId))?.create_sent_at).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(board.exportGameMeta).toHaveBeenCalledWith(theirs);
  });

  it("N1: an OPEN challenge matching every field ChallengeJson carries is HELD, never adopted — ChallengeJson has no createdAt, so it cannot be bound to the marker", async () => {
    // lila modules/challenge/src/main/JsonView.scala (c91f1d09d) and the
    // lichess-org/api ChallengeJson both omit createdAt; the ruling's time
    // bound cannot be checked, and an unverifiable candidate holds.
    const s = await seed();
    await crashedAfterSend(s);
    const theirs = freshGameId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(theirs, s.away.lichessId)] });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    const row = await marker(s.fixtureId);
    expect(row).toMatchObject({ status: "needs_organiser", needs_reason: "create_outcome_unknown", challenge_id: null });
    expect(row?.last_error).toContain(`unverified: ${theirs}`);
    expect(row?.create_sent_at, "the outcome is still unknown").not.toBeNull();
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
    expect(board.acceptChallenge, "never accepted on a guess").not.toHaveBeenCalled();
    expect(board.cancelChallenge).not.toHaveBeenCalled();
  });

  it("BOTH lookups succeed and find nothing of ours ⇒ re-created — the filters are swept: other opponents, the wrong colour, closed challenges, another fixture's game", async () => {
    const s = await seed();
    await crashedAfterSend(s);
    const elsewhere = await seed();
    const recordedElsewhere = freshGameId();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id)
      values (${elsewhere.fixtureId}, ${elsewhere.orgId}, ${T}, 'ready', ${recordedElsewhere})`;
    const black = s.away.lichessId;
    const noise = {
      challenges: [
        ourChallenge(freshGameId(), "someone-else"),
        ourChallenge(freshGameId(), null), // an open challenge
        ourChallenge(freshGameId(), black, { status: "canceled" }),
        ourChallenge(freshGameId(), black, { status: "declined" }),
        ourChallenge(recordedElsewhere, black),
      ],
      games: [
        playing(freshGameId(), "someone-else"),
        playing(freshGameId(), black, "black"), // White plays black in it: not our game
        { gameId: freshGameId(), color: "white" as const, opponentId: null }, // anonymous / AI
        playing(recordedElsewhere, black),
      ],
    };
    board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: noise.challenges });
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: noise.games });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
    expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
    expect(noise.challenges.length + noise.games.length, "anti-vacuity: nine non-matches offered").toBe(9);
    expect(board.exportGameMeta, "no candidate survived to be verified").not.toHaveBeenCalled();
  });

  it("the match is case-blind on Black's Lichess id (lila ids are lowercase; ours may not be)", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const theirs = freshGameId();
    exportsAnswer({ [theirs]: ourMeta(theirs, sent) });
    board.listOngoingGames.mockResolvedValue({
      ok: true, complete: true, games: [playing(theirs, s.away.lichessId.toUpperCase())],
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: theirs });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
  });

  it("ANY lookup failing ⇒ needs_organiser / create_outcome_unknown, never a re-create — swept and counted (the first is the measured 403 a grant without challenge:read gets)", async () => {
    const cases: { name: string; arrange: () => void }[] = [
      { name: "lookup A refused: Missing scope challenge:read (measured)", arrange: () =>
        board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unauthorized", raw: '{"error":"Missing scope: challenge:read"}' }) },
      { name: "lookup A unreadable", arrange: () =>
        board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unavailable", raw: "<html>" }) },
      { name: "lookup B timed out", arrange: () =>
        board.listOngoingGames.mockResolvedValue({ ok: false, code: "unavailable", raw: "" }) },
      { name: "lookup B a full page (absence unproven)", arrange: () =>
        board.listOngoingGames.mockResolvedValue({ ok: true, complete: false, games: [] }) },
      { name: "both failed", arrange: () => {
        board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unavailable", raw: "" });
        board.listOngoingGames.mockResolvedValue({ ok: false, code: "unavailable", raw: "" });
      } },
    ];
    let checked = 0;
    for (const c of cases) {
      board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [] });
      board.listOngoingGames.mockResolvedValue({ ok: true, games: [], complete: true });
      board.createChallengeToUser.mockClear();
      c.arrange();
      const s = await seed();
      await crashedAfterSend(s);
      expect(await createGameIfReady(s.fixtureId, { now: NOW }), c.name).toEqual({ created: false, reason: "provider_error" });
      expect(board.createChallengeToUser, c.name).not.toHaveBeenCalled();
      const row = await marker(s.fixtureId);
      expect(row, c.name).toMatchObject({ status: "needs_organiser", needs_reason: "create_outcome_unknown",
        challenge_id: null, mint_claimed_at: null });
      expect(row?.create_sent_at, `${c.name}: the unknown outcome stays marked`).not.toBeNull();
      // And a retry does not re-create either: the hold is a status.
      expect(await createGameIfReady(s.fixtureId, { now: NOW }), c.name).toEqual({ created: false, reason: "not_ready" });
      expect(board.createChallengeToUser, c.name).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked, "anti-vacuity: five ways a lookup fails").toBe(5);
  });

  it("TWO candidates that BOTH verify as ours ⇒ ambiguous: held as create_outcome_unknown, nothing adopted, nothing cancelled", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const [a, b] = [freshGameId(), freshGameId()];
    exportsAnswer({ [a]: ourMeta(a, sent), [b]: ourMeta(b, sent, { createdAtMs: sent.getTime() + 900 }) });
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true,
      games: [playing(a, s.away.lichessId), playing(b, s.away.lichessId)] });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    expect(await marker(s.fixtureId)).toMatchObject({ status: "needs_organiser", needs_reason: "create_outcome_unknown", challenge_id: null });
    expect((await marker(s.fixtureId))?.last_error).toContain("ambiguous");
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
    expect(board.cancelChallenge, "a guess is never closed either").not.toHaveBeenCalled();
  });

  it("a challenge listed in BOTH lookups (accepted between the two reads) is one candidate, adopted as a game", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const theirs = freshGameId();
    board.listOutgoingChallenges.mockResolvedValue({ ok: true,
      challenges: [ourChallenge(theirs, s.away.lichessId, { status: "accepted" })] });
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
    exportsAnswer({ [theirs]: ourMeta(theirs, sent) });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: theirs });
    expect(board.acceptChallenge, "a game needs no accept").not.toHaveBeenCalled();
    expect(board.exportGameMeta, "verified once, by its export").toHaveBeenCalledTimes(1);
  });

  it("a RE-ARMED row (pending, no claim, the marker still set) is looked up too", async () => {
    // e.g. an organiser's resolve putting a held unknown-outcome row back to
    // pending (T16): the marker is what remembers a create went out.
    const s = await seed();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, create_sent_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${new Date(NOW.getTime() - 3_600_000)})`;
    board.listOutgoingChallenges.mockResolvedValue({ ok: false, code: "unauthorized", raw: "x" });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
  });

  it("a claim LOST during the lookups sends nothing: the marker write is conditional on this call's claim", async () => {
    const s = await seed();
    await crashedAfterSend(s);
    board.listOngoingGames.mockImplementation(async () => {
      await sql`update fixture_external_play set mint_claimed_at = ${new Date(NOW.getTime() + 1_000)} where fixture_id = ${s.fixtureId}`;
      return { ok: true, complete: true, games: [] };
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser, "a lost claim never sends").not.toHaveBeenCalled();
  });

  it("an ADOPTED game whose commit loses the claim is left alone — never cancelled; it is the new claimant's to find", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const theirs = freshGameId();
    exportsAnswer({ [theirs]: ourMeta(theirs, sent) });
    board.listOngoingGames.mockImplementation(async () => {
      await sql`update fixture_external_play set mint_claimed_at = ${new Date(NOW.getTime() + 1_000)} where fixture_id = ${s.fixtureId}`;
      return { ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] };
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.cancelChallenge, "this call did not make it").not.toHaveBeenCalled();
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
  });

  // ─── N1 (fix round 2): adopt only what is provably OUR create ─────────────

  /** One call that must NOT adopt: it re-creates (both lookups succeeded and
   *  nothing verified as ours). A fresh create id per call. */
  const expectRecreated = async (fixtureId: string, label: string) => {
    GM = freshGameId();
    board.createChallengeToUser.mockClear();
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
    expect(await createGameIfReady(fixtureId, { now: NOW }), label).toEqual({ created: true, gameId: GM });
    expect(board.createChallengeToUser, `${label}: re-created`).toHaveBeenCalledTimes(1);
    expect((await marker(fixtureId))?.challenge_id, `${label}: our new game recorded`).toBe(GM);
  };
  /** One call that must HOLD: create_outcome_unknown, nothing sent, marker kept. */
  const expectHeld = async (fixtureId: string, label: string, why: string) => {
    board.createChallengeToUser.mockClear();
    expect(await createGameIfReady(fixtureId, { now: NOW }), label).toEqual({ created: false, reason: "provider_error" });
    const row = await marker(fixtureId);
    expect(row, label).toMatchObject({ status: "needs_organiser", needs_reason: "create_outcome_unknown", challenge_id: null });
    expect(row?.last_error, label).toContain(why);
    expect(row?.create_sent_at, `${label}: marker kept`).not.toBeNull();
    expect(board.createChallengeToUser, `${label}: never re-sent`).not.toHaveBeenCalled();
  };

  it("the reviewer's probe: ONE unrelated ongoing game against Black (a correspondence game started days before the marker) is not adopted ⇒ re-created", async () => {
    // A fresh id: the probe's literal "unrelatedCorr1" is recorded in a shared
    // test DB by the probe itself, and a recorded id is excluded before export.
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const corr = `corr-${randomUUID().slice(0, 8)}`;
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(corr, s.away.lichessId)] });
    exportsAnswer({ [corr]: ourMeta(corr, sent, {
      clockInitialSeconds: null, clockIncrementSeconds: null, createdAtMs: sent.getTime() - 3 * 86_400_000,
    }) });
    await expectRecreated(s.fixtureId, "unrelated correspondence game");
    expect(board.exportGameMeta, "it was verified, not skipped").toHaveBeenCalledWith(corr);
  });

  it("an ongoing candidate differing from ours in ONE field only is not adopted ⇒ re-created — swept and counted", async () => {
    const cases: Array<[string, (sent: Date) => Partial<Meta>]> = [
      ["rated", () => ({ rated: true })],
      ["another variant", () => ({ variant: "chess960" })],
      ["another initial clock (seconds)", () => ({ clockInitialSeconds: OUR_CLOCK.limit * 2 })],
      ["another increment", () => ({ clockIncrementSeconds: OUR_CLOCK.increment + 1 })],
      ["created before the marker's skew", (sent) => ({ createdAtMs: sent.getTime() - SKEW_MS - 1 })],
      // Fix round 3 (R2-1): a createdAt AFTER now is no longer "not ours" —
      // lila's clock may run ahead of ours; see the symmetric-window tests.
    ];
    let checked = 0;
    for (const [name, over] of cases) {
      const s = await seed();
      const sent = await crashedAfterSend(s);
      const theirs = freshGameId();
      board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
      exportsAnswer({ [theirs]: ourMeta(theirs, sent, over(sent)) });
      await expectRecreated(s.fixtureId, name);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every field the ruling names").toBe(5);
  });

  // Fix round 3 (R2-1, controller ruling): the window is SYMMETRIC —
  // [create_sent_at − 60 s, now + 60 s] — because lila's clock can run ahead
  // of ours, and calling our own game "not ours" would create it twice.
  it("the time bound is inclusive at both ends: created at create_sent_at − 60 s, at now, at now + 30 s and at now + 60 s is ours", async () => {
    let checked = 0;
    for (const [name, at] of [
      ["the lower skew edge", (sent: Date) => sent.getTime() - SKEW_MS],
      ["now", () => NOW.getTime()],
      ["now + 30 s (lila's clock ahead)", () => NOW.getTime() + 30_000],
      ["the upper skew edge, now + 60 s", () => NOW.getTime() + SKEW_MS],
    ] as const) {
      const s = await seed();
      const sent = await crashedAfterSend(s);
      const theirs = freshGameId();
      board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
      exportsAnswer({ [theirs]: ourMeta(theirs, sent, { createdAtMs: at(sent) }) });
      expect(await createGameIfReady(s.fixtureId, { now: NOW }), name).toEqual({ created: true, gameId: theirs });
      expect(board.createChallengeToUser, `${name}: never re-sent`).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("a game created BEYOND now + 60 s is HELD, never re-created — a clock that far off cannot tell ours from not — swept and counted", async () => {
    let checked = 0;
    for (const [name, ms] of [["now + 90 s", 90_000], ["just past the edge", SKEW_MS + 1]] as const) {
      const s = await seed();
      const sent = await crashedAfterSend(s);
      const theirs = freshGameId();
      board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
      exportsAnswer({ [theirs]: ourMeta(theirs, sent, { createdAtMs: NOW.getTime() + ms }) });
      await expectHeld(s.fixtureId, name, `unverified: ${theirs}`);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("…but a candidate that is provably NOT ours on another fact is excluded even when its createdAt is past the window", async () => {
    const s = await seed();
    const sent = await crashedAfterSend(s);
    const theirs = freshGameId();
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
    exportsAnswer({ [theirs]: ourMeta(theirs, sent, { createdAtMs: NOW.getTime() + 90_000, rated: true }) });
    await expectRecreated(s.fixtureId, "rated, from the future");
  });

  it("an ongoing candidate with ANY fact its export cannot give ⇒ held, never adopted, never re-created — swept and counted", async () => {
    const missing: Array<keyof Omit<Meta, "gameId">> = ["rated", "variant", "clockInitialSeconds", "clockIncrementSeconds", "createdAtMs"];
    let checked = 0;
    for (const field of missing) {
      const s = await seed();
      const sent = await crashedAfterSend(s);
      const theirs = freshGameId();
      board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
      exportsAnswer({ [theirs]: ourMeta(theirs, sent, { [field]: null }) });
      await expectHeld(s.fixtureId, `${field} missing`, `unverified: ${theirs}`);
      checked += 1;
    }
    expect(checked).toBe(missing.length);
    expect(checked, "anti-vacuity: the five facts").toBe(5);
  });

  it("an export that FAILS ⇒ held (the candidate may be ours); a refusal is not 'not ours'", async () => {
    const s = await seed();
    await crashedAfterSend(s);
    const theirs = freshGameId();
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true, games: [playing(theirs, s.away.lichessId)] });
    exportsAnswer({ [theirs]: "fail" });
    await expectHeld(s.fixtureId, "export failed", `unverified: ${theirs}`);
    expect(board.acceptChallenge).not.toHaveBeenCalled();
  });

  it("one verified match beside one UNVERIFIABLE candidate ⇒ held; beside one that is provably NOT ours ⇒ adopted", async () => {
    const held = await seed();
    const sentH = await crashedAfterSend(held);
    const [ours, unknown] = [freshGameId(), freshGameId()];
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true,
      games: [playing(ours, held.away.lichessId), playing(unknown, held.away.lichessId)] });
    exportsAnswer({ [ours]: ourMeta(ours, sentH), [unknown]: "fail" });
    await expectHeld(held.fixtureId, "one unverifiable", `unverified: ${unknown}`);

    const adopted = await seed();
    const sentA = await crashedAfterSend(adopted);
    const [mine, rated] = [freshGameId(), freshGameId()];
    board.listOngoingGames.mockResolvedValue({ ok: true, complete: true,
      games: [playing(mine, adopted.away.lichessId), playing(rated, adopted.away.lichessId)] });
    exportsAnswer({ [mine]: ourMeta(mine, sentA), [rated]: ourMeta(rated, sentA, { rated: true }) });
    expect(await createGameIfReady(adopted.fixtureId, { now: NOW })).toEqual({ created: true, gameId: mine });
  });

  it("an OPEN challenge differing from ours in ONE of its own fields is not ours ⇒ re-created — swept and counted", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["rated", { rated: true }],
      ["another variant", { variantKey: "chess960" }],
      ["another limit", { timeControl: { type: "clock", limit: OUR_CLOCK.limit * 2, increment: OUR_CLOCK.increment } }],
      ["another increment", { timeControl: { type: "clock", limit: OUR_CLOCK.limit, increment: OUR_CLOCK.increment + 1 } }],
      ["a correspondence challenge", { timeControl: { type: "correspondence", limit: null, increment: null } }],
      ["White asked for black", { color: "black" }],
      ["White asked for a random colour", { color: "random" }],
    ];
    let checked = 0;
    for (const [name, over] of cases) {
      const s = await seed();
      await crashedAfterSend(s);
      board.listOutgoingChallenges.mockResolvedValue({ ok: true, challenges: [ourChallenge(freshGameId(), s.away.lichessId, over)] });
      await expectRecreated(s.fixtureId, name);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every field the challenge carries").toBe(7);
    expect(board.exportGameMeta, "a challenge is judged on its own fields").not.toHaveBeenCalled();
  });

  it("the marker write RENEWS the claim to the send instant (production clock): lookups cannot age it out", async () => {
    // Only Date is faked, after the seed; the call takes no `now`.
    const s = await seed();
    await crashedAfterSend(s);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const LOOKUP_MS = 15_000;
      board.listOngoingGames.mockImplementation(async () => {
        vi.setSystemTime(new Date(NOW.getTime() + LOOKUP_MS)); // the lookups took 15s
        return { ok: true, complete: true, games: [] };
      });
      let claimAtSend: Date | null | undefined;
      board.createChallengeToUser.mockImplementation(async () => {
        claimAtSend = (await marker(s.fixtureId))?.mint_claimed_at;
        return { ok: true, challengeId: GM };
      });
      expect(await createGameIfReady(s.fixtureId)).toEqual({ created: true, gameId: GM });
      expect(claimAtSend?.getTime(), "renewed to the send, not the claim").toBe(NOW.getTime() + LOOKUP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marker lifecycle: a 429 clears it (lila refused before acting); an outcome_unknown keeps it; a recorded accept failure clears it", async () => {
    const r429 = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "rate_limited", raw: "Too many requests" });
    await createGameIfReady(r429.fixtureId, { now: NOW });
    expect(await marker(r429.fixtureId)).toMatchObject({ status: "pending", mint_claimed_at: null, create_sent_at: null });

    const unknown = await seed();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: false, code: "outcome_unknown", raw: "" });
    await createGameIfReady(unknown.fixtureId, { now: NOW });
    const u = await marker(unknown.fixtureId);
    expect(u?.status).toBe("needs_organiser");
    expect(u?.create_sent_at, "the outcome is still unknown").not.toBeNull();

    const acc = await seed();
    GM = freshGameId();
    board.createChallengeToUser.mockResolvedValueOnce({ ok: true, challengeId: GM });
    board.acceptChallenge.mockResolvedValueOnce({ ok: false, code: "unavailable", raw: "x" });
    await createGameIfReady(acc.fixtureId, { now: NOW });
    expect(await marker(acc.fixtureId)).toMatchObject({ status: "needs_organiser", challenge_id: GM, create_sent_at: null });
  });
});

// Fix round 1, Minor b: a game this call made but could not record is closed
// at Lichess, best-effort, with White's token; the ids are logged, never a
// token.
describe.skipIf(!process.env.DATABASE_URL)("Minor b — a stray game is cancelled, best-effort", () => {
  const stompDuring = (fixtureId: string, at: "create" | "accept", id: string) => {
    const bump = async () => {
      await sql`
        update fixture_external_play set mint_claimed_at = ${new Date(NOW.getTime() + 1_000)}
         where fixture_id = ${fixtureId}`;
    };
    if (at === "create") {
      board.createChallengeToUser.mockImplementation(async () => {
        await bump();
        return { ok: true, challengeId: id };
      });
    } else {
      board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: id });
      board.acceptChallenge.mockImplementation(async () => {
        await bump();
        return { ok: false, code: "unavailable", raw: "x" };
      });
    }
  };

  it("both stray paths cancel with White's token and log the ids — never a token — swept and counted", async () => {
    const errors = vi.spyOn(log, "error");
    const warns = vi.spyOn(log, "warn");
    const infos = vi.spyOn(log, "info");
    try {
      let checked = 0;
      for (const at of ["create", "accept"] as const) {
        errors.mockClear(); warns.mockClear(); infos.mockClear();
        board.cancelChallenge.mockClear();
        const s = await seed();
        const stray = freshGameId();
        stompDuring(s.fixtureId, at, stray);
        expect(await createGameIfReady(s.fixtureId, { now: NOW }), at).toEqual({ created: false, reason: "not_ready" });
        const whiteToken = `lio_seed_${s.home.lichessId}`;
        expect(board.cancelChallenge, at).toHaveBeenCalledWith({ token: whiteToken, challengeId: stray });
        const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls, ...infos.mock.calls]);
        expect(logged, `${at}: the ids are logged`).toContain(stray);
        expect(logged, `${at}: the ids are logged`).toContain(s.fixtureId);
        expect(logged, `${at}: never a token`).not.toContain(whiteToken);
        expect(logged, `${at}: never a token`).not.toContain(`lio_seed_${s.away.lichessId}`);
        checked += 1;
      }
      expect(checked).toBe(2);
    } finally {
      errors.mockRestore(); warns.mockRestore(); infos.mockRestore();
    }
  });

  it("a cancel that FAILS is logged, never thrown; the caller's answer is unchanged", async () => {
    const errors = vi.spyOn(log, "error");
    try {
      const s = await seed();
      const stray = freshGameId();
      stompDuring(s.fixtureId, "create", stray);
      board.cancelChallenge.mockResolvedValue({ ok: false, code: "unavailable", raw: "boom" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
      expect(JSON.stringify(errors.mock.calls)).toContain(stray);
    } finally {
      errors.mockRestore();
    }
  });

  it("a stray some OTHER claimant has since recorded is not cancelled (it is that fixture's game now)", async () => {
    const s = await seed();
    const stray = freshGameId();
    board.createChallengeToUser.mockImplementation(async () => {
      // The takeover claimant adopted this very game and committed it.
      await sql`
        update fixture_external_play
           set mint_claimed_at = null, status = 'ready', challenge_id = ${stray}
         where fixture_id = ${s.fixtureId}`;
      return { ok: true, challengeId: stray };
    });
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.cancelChallenge, "never close a recorded game").not.toHaveBeenCalled();
    expect((await bridge(s.fixtureId))?.challenge_id).toBe(stray);
  });
});
