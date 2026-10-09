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
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { createGameIfReady } from "../external-play/create-game";
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

beforeEach(() => {
  vi.clearAllMocks();
  // The queue is per-process state (budgets, holds, the serial tail): every
  // case starts from an empty one, or the per-IP budget leaks across cases.
  __resetCreationQueue();
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: "gm-1" });
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
