// T17B fix 2, D21-fix-4 (review I2) - the per-seat ask limit, wired into the match room's seat claim and camera door.
//
// seat-ask-limit.test.ts pins the MECHANISM and the NUMBERS. This file pins the WIRING, through the real usecases, the real
// seat and the real adapter against the e2e RealtimeKit fixture vendor, counting the requests the FIXTURE saw - never the
// usecase's own idea of what it asked:
//   - the (limit+1)th ask is a 429 and the vendor sees NOTHING more (the limit sits before every vendor call);
//   - a refused ask does nothing else either: no check-in stamped, no lobby published, no game asked for;
//   - it is per seat: the opponent, on the same board, is unaffected (the positive pair of every refusal);
//   - a stranger is the room's 404 and spends no row (identity first - the limiter is no oracle and no write for anyone
//     the room would not answer);
//   - the limit is on BOTH doors, and independently.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by
// the guard before the seat is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { SEAT_ASK_LIMIT, SEAT_ASK_WINDOW_S } from "../../external-play/seat-ask-limit";
import { claimRoomSeat, requestRoomCamera, type RoomDeps } from "../external-play/room";
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
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Policy = "required" | "optional";
async function seed(cameraPolicy: Policy) {
  const opened = new Date(Date.now() - 5 * 60_000);
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    cameraPolicy,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
const home = (s: Seeded) => ({ kind: "session" as const, userId: s.home.userId });
const away = (s: Seeded) => ({ kind: "session" as const, userId: s.away.userId });

/** The side effects a seat claim has beyond the seat: spies, so a refused ask can be shown to have done none of them. */
function spies() {
  return {
    publish: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ created: false, reason: "not_ready" }) as never),
    offered: vi.fn(async () => true),
  } satisfies RoomDeps;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected the ask to be refused, and it was answered");
}
const rows = async (s: Seeded, route: "seat" | "camera") =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_seat_asks where fixture_id = ${s.fixtureId} and route = ${route}`)[0]!.n;
const checkIns = async (s: Seeded) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_availability where fixture_id = ${s.fixtureId} and checked_in_at is not null`)[0]!.n;

describe.skipIf(!DB)("the seat claim is limited per seat (REQUIRED board: a claim reaches the vendor)", () => {
  it("the (limit+1)th claim is a 429 with a Retry-After inside the window, and the vendor sees NOTHING more from it", async () => {
    const s = await seed("required");
    for (let i = 0; i < SEAT_ASK_LIMIT.seat; i += 1) await claimRoomSeat(home(s), s.fixtureId, spies());
    const spent = fx.calls.length;
    expect(spent, "anti-vacuity: the claims before the limit DID reach the vendor (a meeting, a participant, then reads)").toBeGreaterThan(SEAT_ASK_LIMIT.seat);

    const d = spies();
    const refused = await refusal(claimRoomSeat(home(s), s.fixtureId, d));
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers?.["Retry-After"]);
    expect(retryAfter, "Retry-After is whole seconds inside the window").toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(SEAT_ASK_WINDOW_S);
    expect(fx.calls.length, "the refused claim made no vendor request").toBe(spent);
    // Nothing else of the claim ran either: the lobby was not published, the game not asked for, "is online chess on" not read.
    expect([d.publish, d.create, d.offered].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("per seat: the opponent on the SAME board is still answered, and the vendor hears from them (the positive pair)", async () => {
    const s = await seed("required");
    for (let i = 0; i <= SEAT_ASK_LIMIT.seat; i += 1) await claimRoomSeat(home(s), s.fixtureId, spies()).catch(() => undefined);
    await refusal(claimRoomSeat(home(s), s.fixtureId, spies()));
    const before = fx.calls.length;
    const got = await claimRoomSeat(away(s), s.fixtureId, spies());
    expect(got.seat, "the opponent's claim is answered, not refused").not.toBeNull();
    expect(fx.calls.length, "and it reached the vendor").toBeGreaterThan(before);
  });

  it("the window reopens: an ask a full window later is answered again (the limiter is not a ban)", async () => {
    const s = await seed("required");
    const t0 = new Date();
    for (let i = 0; i < SEAT_ASK_LIMIT.seat; i += 1) await claimRoomSeat(home(s), s.fixtureId, { ...spies(), now: t0 });
    await refusal(claimRoomSeat(home(s), s.fixtureId, { ...spies(), now: t0 }));
    const later = new Date(t0.getTime() + SEAT_ASK_WINDOW_S * 1_000);
    const got = await claimRoomSeat(home(s), s.fixtureId, { ...spies(), now: later });
    expect(got.seat, "answered").not.toBeNull();
  });

  it("a STRANGER is the room's 404 and leaves no row - the limiter runs after identity, so it is no oracle and no write for them", async () => {
    const s = await seed("required");
    const stranger = await seed("required");
    for (let i = 0; i < SEAT_ASK_LIMIT.seat + 5; i += 1) {
      expect((await refusal(claimRoomSeat(home(stranger), s.fixtureId, spies()))).status, `ask ${i + 1}`).toBe(404);
    }
    expect(await rows(s, "seat")).toBe(0);
    expect(fx.calls.length).toBe(0);
  });
});

describe.skipIf(!DB)("the camera door is limited per seat, on its own count (OPTIONAL board: an ask hands a token)", () => {
  it("the (limit+1)th ask is a 429 and the vendor sees NOTHING more; no check-in was ever stamped by the door", async () => {
    const s = await seed("optional");
    for (let i = 0; i < SEAT_ASK_LIMIT.camera; i += 1) {
      const got = await requestRoomCamera(home(s), s.fixtureId, {});
      expect(got.participant?.participantId, `ask ${i + 1} hands the caller's token`).toBeTruthy();
    }
    const spent = fx.calls.length;
    expect(spent, "anti-vacuity: the asks before the limit reached the vendor").toBeGreaterThanOrEqual(SEAT_ASK_LIMIT.camera);

    const refused = await refusal(requestRoomCamera(home(s), s.fixtureId, {}));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers?.["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect(fx.calls.length, "the refused ask made no vendor request").toBe(spent);
    expect(await checkIns(s), "the door never stamps a check-in").toBe(0);
  });

  it("the two doors count separately: a full seat bucket leaves the camera door open, and the other way round (the positive pairs)", async () => {
    const s = await seed("optional");
    for (let i = 0; i < SEAT_ASK_LIMIT.seat; i += 1) await claimRoomSeat(home(s), s.fixtureId, spies());
    await refusal(claimRoomSeat(home(s), s.fixtureId, spies()));
    expect((await requestRoomCamera(home(s), s.fixtureId, {})).participant, "the camera door is not spent by the seat's asks").not.toBeNull();

    const t = await seed("optional");
    for (let i = 0; i < SEAT_ASK_LIMIT.camera; i += 1) await requestRoomCamera(home(t), t.fixtureId, {});
    await refusal(requestRoomCamera(home(t), t.fixtureId, {}));
    expect((await claimRoomSeat(home(t), t.fixtureId, spies())).seat, "the seat door is not spent by the camera's asks").not.toBeNull();
  });

  it("per seat: the opponent's camera ask is answered while the first player's is refused", async () => {
    const s = await seed("optional");
    for (let i = 0; i < SEAT_ASK_LIMIT.camera; i += 1) await requestRoomCamera(home(s), s.fixtureId, {});
    await refusal(requestRoomCamera(home(s), s.fixtureId, {}));
    expect((await requestRoomCamera(away(s), s.fixtureId, {})).participant).not.toBeNull();
  });

  it("a STRANGER is the room's 404 and leaves no row", async () => {
    const s = await seed("optional");
    const stranger = await seed("optional");
    for (let i = 0; i < SEAT_ASK_LIMIT.camera + 3; i += 1) {
      expect((await refusal(requestRoomCamera(home(stranger), s.fixtureId, {}))).status, `ask ${i + 1}`).toBe(404);
    }
    expect(await rows(s, "camera")).toBe(0);
    expect(fx.calls.length).toBe(0);
  });
});
