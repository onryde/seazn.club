// T17B fix 2, D21-fix-4 (review I2) - the per-seat ask limit on the match room's seat and camera doors.
//
// WHY IT EXISTS. Every seat claim and every camera-token ask costs the platform's RealtimeKit budget (video/budget.ts: one
// bucket for the whole account, refilled at two calls a second). A signed-in player with a hand-rolled client could ask at
// twenty requests a second and keep the bucket empty, so every club's check-in answered `camera_starting` and the sweep's
// retries found no token. lib/rate-limit.ts is Redis-only and INERT wherever Redis is not configured, so this limit lives
// in Postgres, like the budget it protects.
//
// WHAT IS PINNED, and where each number comes from:
//   - the MECHANISM (this file's first block): the (limit+1)th ask in a window is a 429 with a Retry-After that is the
//     window's true remaining seconds; the limit is per fixture, per person and per route; a refused ask does not extend the
//     window; the window reopens at exactly its length; concurrent asks cannot pass more than the limit between them.
//   - the NUMBERS (the second block): the limit must sit ABOVE the most the room itself legitimately sends, or the limiter
//     would refuse the product's own check-in. That worst case is DERIVED here from the room's declarations
//     (room-snapshot.ts CAMERA_EVIDENCE_MAX_POLLS / cameraEvidenceDelayMs / SEAT_RETRIES / SEAT_RETRY_MS, use-room.ts
//     cameraRetryDelayMs) - never typed into the test - and replayed against the real limiter on the real schedule.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by
// the guard before a seat is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  CAMERA_EVIDENCE_MAX_POLLS,
  LINE_POLL_MIN_MS,
  LINE_POLL_MS,
  SEAT_RETRIES,
  SEAT_RETRY_MS,
  cameraEvidenceDelayMs,
} from "@/components/public-site/match-room/room-snapshot";
import { cameraRetryDelayMs, linePollDelayMs } from "@/components/public-site/match-room/use-room";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { SEAT_ASK_LIMIT, SEAT_ASK_ROUTES, SEAT_ASK_WINDOW_S, takeSeatAsk, type SeatAskRoute } from "../seat-ask-limit";

const DB = !!process.env.DATABASE_URL;
const WINDOW_MS = SEAT_ASK_WINDOW_S * 1_000;

type Seeded = Awaited<ReturnType<typeof seedOnlineChessFixture>>;
let s: Seeded;
let other: Seeded;
beforeAll(async () => {
  if (!DB) return;
  const opened = new Date(Date.now() - 5 * 60_000);
  const seed = () =>
    seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: opened, linked: true, roundOpenedAt: opened });
  s = await seed();
  other = await seed();
});
afterAll(async () => {
  if (DB) await sql.end();
});
beforeEach(async () => {
  if (!DB) return;
  await sql`delete from fixture_seat_asks where fixture_id = any(${[s.fixtureId, other.fixtureId]}::uuid[])`;
});

const homeAsk = (route: SeatAskRoute) => ({ fixtureId: s.fixtureId, personId: s.home.personId, route });
const T0 = new Date("2026-10-15T10:00:00.000Z");
const at = (ms: number) => ({ at: new Date(T0.getTime() + ms) });

/** What the limiter answers: undefined for an ask let through, the HttpError for a refused one. */
async function outcome(ask: ReturnType<typeof homeAsk>, ms: number): Promise<HttpError | undefined> {
  try {
    await takeSeatAsk(ask, at(ms));
    return undefined;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
}

describe.skipIf(!DB)("takeSeatAsk - the mechanism", () => {
  it("the declared routes are exactly the three doors, each with a limit (anti-vacuity: the sweeps below look at all of them)", () => {
    expect([...SEAT_ASK_ROUTES].sort()).toEqual(["camera", "line", "seat"]);
    for (const route of SEAT_ASK_ROUTES) expect(SEAT_ASK_LIMIT[route], route).toBeGreaterThan(0);
  });

  it.each(SEAT_ASK_ROUTES)("%s: the first `limit` asks pass and the (limit+1)th is a 429 RATE_LIMITED", async (route) => {
    const limit = SEAT_ASK_LIMIT[route];
    let passed = 0;
    for (let i = 0; i < limit; i += 1) {
      expect(await outcome(homeAsk(route), i * 10), `ask ${i + 1} of ${limit}`).toBeUndefined();
      passed += 1;
    }
    expect(passed, "anti-vacuity: the limit's worth of asks went through").toBe(limit);
    const refused = await outcome(homeAsk(route), limit * 10);
    expect(refused, "the (limit+1)th").toBeInstanceOf(HttpError);
    expect(refused!.status).toBe(429);
    // The error carries no code of its own: the envelope maps the status to RATE_LIMITED, as the Redis limiter's does.
    expect(refused!.code).toBeUndefined();
    // And it stays refused for the rest of the window (not a one-off).
    expect((await outcome(homeAsk(route), limit * 10 + 1))?.status).toBe(429);
  });

  it("Retry-After is the window's TRUE remaining whole seconds, rounded up, never 0 while any time remains", async () => {
    const limit = SEAT_ASK_LIMIT.seat;
    for (let i = 0; i < limit; i += 1) await takeSeatAsk(homeAsk("seat"), at(0));
    // 5 s into the window: 55 s remain.
    expect((await outcome(homeAsk("seat"), 5_000))?.headers).toEqual({ "Retry-After": String(SEAT_ASK_WINDOW_S - 5) });
    // 1 ms before it reopens: 1 ms remains - one second, never 0 (a 0 makes a client hammer).
    expect((await outcome(homeAsk("seat"), WINDOW_MS - 1))?.headers).toEqual({ "Retry-After": "1" });
  });

  it("the window REOPENS at exactly its length: refused 1 ms before, admitted at it, and the new window counts again from 1", async () => {
    const limit = SEAT_ASK_LIMIT.seat;
    for (let i = 0; i < limit; i += 1) await takeSeatAsk(homeAsk("seat"), at(0));
    expect((await outcome(homeAsk("seat"), WINDOW_MS - 1))?.status, "1 ms before the window ends").toBe(429);
    expect(await outcome(homeAsk("seat"), WINDOW_MS), "at the window's end").toBeUndefined();
    // The new window began at WINDOW_MS with that ask counted: `limit - 1` more pass, then the next is refused.
    for (let i = 1; i < limit; i += 1) expect(await outcome(homeAsk("seat"), WINDOW_MS + i), `ask ${i + 1} of the new window`).toBeUndefined();
    expect((await outcome(homeAsk("seat"), WINDOW_MS + limit))?.status, "the new window is full too").toBe(429);
  });

  it("a REFUSED ask does not extend the window: hammering inside it cannot keep a seat shut past its end", async () => {
    const limit = SEAT_ASK_LIMIT.camera;
    for (let i = 0; i < limit; i += 1) await takeSeatAsk(homeAsk("camera"), at(0));
    let refused = 0;
    for (let ms = 1_000; ms < WINDOW_MS; ms += 1_000) {
      expect((await outcome(homeAsk("camera"), ms))?.status, `at ${ms} ms`).toBe(429);
      refused += 1;
    }
    expect(refused, "anti-vacuity: refusals were made all through the window").toBe(SEAT_ASK_WINDOW_S - 1);
    expect(await outcome(homeAsk("camera"), WINDOW_MS), "the window still ended on time").toBeUndefined();
  });

  it("the limit is per PERSON, per FIXTURE and per ROUTE: filling one bucket spends none of the others (the positive pairs)", async () => {
    const limit = SEAT_ASK_LIMIT.seat;
    for (let i = 0; i < limit; i += 1) await takeSeatAsk(homeAsk("seat"), at(0));
    expect((await outcome(homeAsk("seat"), 1))?.status, "premise: the home player's seat bucket is full").toBe(429);
    // The opponent in the SAME fixture.
    expect(await outcome({ fixtureId: s.fixtureId, personId: s.away.personId, route: "seat" }, 1), "another person").toBeUndefined();
    // The same person's OTHER door.
    expect(await outcome(homeAsk("camera"), 1), "another route").toBeUndefined();
    // Another fixture (its own players; a player on two boards in two rounds has a bucket per board).
    expect(await outcome({ fixtureId: other.fixtureId, personId: other.home.personId, route: "seat" }, 1), "another fixture").toBeUndefined();
  });

  it("concurrent asks - two machines, a second tab - cannot pass more than `limit` between them", async () => {
    const limit = SEAT_ASK_LIMIT.seat;
    const extra = 7;
    const results = await Promise.all(Array.from({ length: limit + extra }, () => outcome(homeAsk("seat"), 0)));
    expect(results.filter((r) => r === undefined).length, "admitted").toBe(limit);
    expect(results.filter((r) => r?.status === 429).length, "refused").toBe(extra);
    const [row] = await sql<{ asks: number }[]>`
      select asks from fixture_seat_asks where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId} and route = 'seat'`;
    expect(row!.asks, "one row, every ask counted").toBe(limit + extra);
  });

  it("a clock that steps BACK inside the window counts the ask (the strict direction), never resets the window", async () => {
    const limit = SEAT_ASK_LIMIT.seat;
    for (let i = 0; i < limit; i += 1) await takeSeatAsk(homeAsk("seat"), at(30_000));
    // An ask stamped 20 s EARLIER than the window's start (a machine clock behind): refused, not a new window - and its
    // Retry-After is never longer than the window itself (the arithmetic alone would say 80 s).
    const refused = await outcome(homeAsk("seat"), 10_000);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers?.["Retry-After"])).toBe(SEAT_ASK_WINDOW_S);
  });

  it("a deleted fixture takes its rows with it (the lifecycle is the fixture's)", async () => {
    const dying = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(Date.now() - 5 * 60_000),
      linked: true,
      roundOpenedAt: new Date(Date.now() - 5 * 60_000),
    });
    await takeSeatAsk({ fixtureId: dying.fixtureId, personId: dying.home.personId, route: "seat" });
    const count = async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from fixture_seat_asks where fixture_id = ${dying.fixtureId}`)[0]!.n;
    expect(await count(), "premise: the ask left a row").toBe(1);
    await sql`delete from fixtures where id = ${dying.fixtureId}`;
    expect(await count()).toBe(0);
  });

  it("an ask by someone who is not a person on file is refused by the schema, not counted (FK)", async () => {
    await expect(takeSeatAsk({ fixtureId: s.fixtureId, personId: randomUUID(), route: "seat" })).rejects.toMatchObject({ code: "23503" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The numbers. The limit must be at least what the product's own screen sends, and not more than that by a margin that
// makes the limit decoration. Everything on the left of an `expect` below is computed from the room's declarations.

/** Offsets (ms from the press) of every seat claim ONE device's check-in screen can make over one attempt, worst case:
 *  the press itself; then each `camera_starting` re-ask on the back-off (room-shell.tsx: after `polls` re-asks the wait is
 *  cameraEvidenceDelayMs(polls + 1), at most CAMERA_EVIDENCE_MAX_POLLS of them); then, once the answer is a refusal for want
 *  of a camera and the camera is up, SEAT_RETRIES re-claims SEAT_RETRY_MS apart; then the one re-claim a retired meeting
 *  earns (room-shell.tsx `retiredKey`). Requests are taken as instantaneous - the closest packing there is. */
function seatClaimsOfOneDevice(): number[] {
  const offsets = [0];
  let t = 0;
  for (let polls = 1; polls <= CAMERA_EVIDENCE_MAX_POLLS; polls += 1) {
    t += cameraEvidenceDelayMs(polls);
    offsets.push(t);
  }
  for (let retry = 1; retry <= SEAT_RETRIES; retry += 1) {
    t += SEAT_RETRY_MS;
    offsets.push(t);
  }
  offsets.push(t);
  return offsets;
}

/** Offsets of the camera-token asks of ONE device's tile retry over `spanMs` (use-room.ts: the wait before the `attempt`-th
 *  ask is cameraRetryDelayMs(attempt)). */
function cameraAsksOfOneDevice(spanMs: number): number[] {
  const offsets: number[] = [];
  let t = 0;
  for (let attempt = 0; ; attempt += 1) {
    t += cameraRetryDelayMs(attempt);
    if (t > spanMs) return offsets;
    offsets.push(t);
  }
}

/** The most asks of a schedule that fall in any window of `windowMs` (the window opening at one of them: the densest). */
function densest(offsets: number[], windowMs: number): number {
  return Math.max(...offsets.map((from) => offsets.filter((o) => o >= from && o < from + windowMs).length));
}

/** Two devices (a phone and a laptop, or a second tab - external-play-preflight.test.ts drives "SECOND TAB") each running
 *  the whole schedule. The limit is sized for this many at once. */
const DEVICES = 2;

describe.skipIf(!DB)("the limits sit at the room's own worst case (derived, then replayed against the real limiter)", () => {
  it("seat: DEVICES x one full check-in attempt from the room's own bounds - and nothing the room does is refused", async () => {
    const one = seatClaimsOfOneDevice();
    expect(one.length, "anti-vacuity: a real attempt (the press, the re-asks, the re-claims, the retired-meeting one)").toBe(
      1 + CAMERA_EVIDENCE_MAX_POLLS + SEAT_RETRIES + 1,
    );
    const both = Array.from({ length: DEVICES }, () => one).flat().sort((a, b) => a - b);
    expect(densest(both, WINDOW_MS), "the worst case sits inside ONE window (else the window would hide it)").toBe(both.length);
    expect(SEAT_ASK_LIMIT.seat, "the limit is that worst case: raise the room's bounds and this must move with them").toBe(both.length);

    let admitted = 0;
    for (const ms of both) {
      expect(await outcome(homeAsk("seat"), ms), `a claim the room sends at +${ms} ms`).toBeUndefined();
      admitted += 1;
    }
    expect(admitted, "anti-vacuity: every claim the room can send was replayed").toBe(both.length);
    expect((await outcome(homeAsk("seat"), both.at(-1)!))?.status, "and ONE more is refused: the limit is tight, not decoration").toBe(429);
  });

  it("camera: DEVICES x the densest minute of the tile retry's back-off - and a whole retry run (4 minutes) is never refused", async () => {
    const span = 4 * 60_000;
    const one = cameraAsksOfOneDevice(span);
    expect(one.length, "anti-vacuity: the ladder reached its cap inside the span").toBeGreaterThan(6);
    const perDevice = densest(one, WINDOW_MS);
    expect(SEAT_ASK_LIMIT.camera, "the limit is DEVICES x the densest minute of the ladder").toBe(DEVICES * perDevice);

    const both = Array.from({ length: DEVICES }, () => one).flat().sort((a, b) => a - b);
    let admitted = 0;
    for (const ms of both) {
      expect(await outcome(homeAsk("camera"), ms), `an ask the room sends at +${ms} ms`).toBeUndefined();
      admitted += 1;
    }
    expect(admitted, "anti-vacuity: every ask of both devices was replayed").toBe(both.length);
  });
});

// Capacity test 22 (spec §5.7.9): the `line` door's limit comes from the poll FLOOR, and the client cannot go under it.
describe.skipIf(!DB)("the line door (spec 5.7.9): the limit is derived from LINE_POLL_MIN_MS, and the client never polls faster than it", () => {
  /** One device's claims over `spanMs` on a server answering `pollMs`: the first claim, then one per linePollDelayMs, and
   *  `visible` extra claims at the given offsets (the page coming back into view claims at once). */
  function lineClaimsOfOneDevice(pollMs: unknown, spanMs: number, visible: number[]): number[] {
    const offsets = [0, ...visible];
    for (let t = linePollDelayMs(pollMs); t < spanMs; t += linePollDelayMs(pollMs)) offsets.push(t);
    return offsets.sort((a, b) => a - b);
  }

  it("the client clamps what the server sends: pollMs of 1, 0, -5, NaN, absent and 1,999 never poll faster than the floor; an honest 3,000 is kept", () => {
    let checked = 0;
    for (const hostile of [1, 0, -5, Number.NaN, undefined, null, "2", 1_999]) {
      expect(linePollDelayMs(hostile), `server pollMs ${String(hostile)}`).toBeGreaterThanOrEqual(LINE_POLL_MIN_MS);
      checked += 1;
    }
    // An absent, zero, negative or non-numeric pollMs counts as the near cadence; a number under the floor is the floor.
    for (const absent of [0, -5, Number.NaN, undefined, null, "2"]) expect(linePollDelayMs(absent), String(absent)).toBe(LINE_POLL_MS);
    expect(linePollDelayMs(1)).toBe(LINE_POLL_MIN_MS);
    expect(linePollDelayMs(1_999)).toBe(LINE_POLL_MIN_MS);
    expect(linePollDelayMs(LINE_POLL_MS)).toBe(LINE_POLL_MS);
    expect(linePollDelayMs(7_000), "slower is the server's to ask for").toBe(7_000);
    expect(checked, "cases checked").toBe(8);
  });

  it("the limit: DEVICES x (the polls at the floor over one window + the first claim + one on visibilitychange) - and the product's fastest schedule is never refused", async () => {
    const perDevice = lineClaimsOfOneDevice(1, WINDOW_MS, [WINDOW_MS / 2]);
    const both = Array.from({ length: DEVICES }, () => perDevice).flat().sort((a, b) => a - b);
    expect(densest(both, WINDOW_MS), "the whole schedule sits inside ONE window").toBe(both.length);
    expect(perDevice.length, "anti-vacuity: a real minute of polling").toBeGreaterThan(WINDOW_MS / LINE_POLL_MIN_MS);
    expect(SEAT_ASK_LIMIT.line, "the limit is DEVICES x (a window of floor-cadence polls + 2)").toBe(DEVICES * (Math.ceil(WINDOW_MS / LINE_POLL_MIN_MS) + 2));
    expect(SEAT_ASK_LIMIT.line, "and sits above the schedule it must carry").toBeGreaterThanOrEqual(both.length);
    let admitted = 0;
    for (const ms of both) {
      expect(await outcome(homeAsk("line"), ms), `a line claim the room sends at +${ms} ms`).toBeUndefined();
      admitted += 1;
    }
    expect(admitted, "anti-vacuity: every claim was replayed").toBe(both.length);
    // Tight, not decoration: the limit's worth, then ONE more.
    for (let i = both.length; i < SEAT_ASK_LIMIT.line; i += 1) expect(await outcome(homeAsk("line"), WINDOW_MS - 1)).toBeUndefined();
    expect((await outcome(homeAsk("line"), WINDOW_MS - 1))?.status).toBe(429);
  });

  it("the line door is its own bucket: a full line bucket leaves the seat door open (the positive pair), and the seat limit still stands at 20", async () => {
    for (let i = 0; i < SEAT_ASK_LIMIT.line; i += 1) await takeSeatAsk(homeAsk("line"), at(0));
    expect((await outcome(homeAsk("line"), 1))?.status, "premise: the line bucket is full").toBe(429);
    expect(await outcome(homeAsk("seat"), 1), "the seat door").toBeUndefined();
    expect(SEAT_ASK_LIMIT.seat, "the owner's D21-fix-4 number is unchanged").toBe(20);
  });
});
