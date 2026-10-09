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
import { MINT_CLAIM_STALE_MS, windowFor } from "@/server/external-play/window";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { PLAY_SCOPES, getLichessLink } from "../external-accounts";
import { mintOrgOwnerAuth } from "../external-play/auth";
import { createGameIfReady, type CreateOutcome } from "../external-play/create-game";
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
  // V432's consent/token CHECK forbids a stored token without a consent stamp,
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

  it("a player who has not re-consented ⇒ not_ready", async () => {
    // Spec §3.1: players linked under the identity-only flow must see the
    // re-consent screen before their first online fixture.
    const s = await seed();
    await clearConsent(s.home.userId);
    expect(await getLichessLink(s.home.userId).then((l) => l?.consentedAt), "premise").toBeNull();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("a player with no Lichess link at all ⇒ not_ready", async () => {
    const s = await seed();
    await sql`delete from user_external_accounts where user_id = ${s.away.userId}`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("a player missing board:play ⇒ not_ready (separately from consent)", async () => {
    const s = await seed();
    await narrowScopes(s.away.userId, ["challenge:write"]);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("a player missing challenge:write ⇒ not_ready", async () => {
    const s = await seed();
    await narrowScopes(s.home.userId, ["board:play"]);
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
      created: false,
      reason: "not_ready",
    });
    noHttp();
  });

  it("sweeps every required scope on BOTH sides, dropping one at a time, and reports the count", async () => {
    // Derived from T2's PLAY_SCOPES — the one authority for "the grant that
    // is enough to play" — never a list typed in here. The premise line pins
    // it to spec §3.1's two scopes, so a shrunken PLAY_SCOPES fails loudly.
    const required = [...PLAY_SCOPES];
    expect([...required].sort(), "premise: spec §3.1 asks for exactly these").toEqual([
      "board:play",
      "challenge:write",
    ]);
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      for (const dropped of required) {
        const s = await seed();
        await narrowScopes(s[side].userId, required.filter((x) => x !== dropped));
        const got = await createGameIfReady(s.fixtureId, { now: NOW });
        expect(got, `${side} without ${dropped}`).toEqual({ created: false, reason: "not_ready" });
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every required scope, on each side").toBe(required.length * 2);
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

  it("sequence: two CONCURRENT creates for one fixture make exactly one challenge", async () => {
    const s = await seed();
    const results = await Promise.all([
      createGameIfReady(s.fixtureId, { now: NOW }),
      createGameIfReady(s.fixtureId, { now: NOW }),
    ]);
    expect(board.createChallengeToUser, "exactly one challenge").toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({ created: true, gameId: GM });
    for (const r of results) {
      expect([{ created: true, gameId: GM }, { created: false, reason: "already" }]).toContainEqual(r);
    }
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

  it("a STALE claim (a crashed minter) is taken over without a human", async () => {
    const s = await seed();
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at)
      values (${s.fixtureId}, ${s.orgId}, ${T}, ${new Date(NOW.getTime() - MINT_CLAIM_STALE_MS - 1)})`;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
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
    };
    const declared = Object.keys(builders) as Reason[];
    for (const reason of declared) {
      GM = freshGameId();
      board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
      await builders[reason]();
    }
    expect([...produced].sort(), "every declared reason is reachable").toEqual([...declared].sort());
    expect(produced.size, "anti-vacuity: five reasons, five cases").toBe(5);
  });
});
