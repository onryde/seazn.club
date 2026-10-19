// T17B fix 2, D21-fix-4 (review I1 + I2) - the seat and camera routes' WIRE, through the real route handlers, the real
// seat, the real adapter and the e2e RealtimeKit fixture vendor (counting what the FIXTURE saw).
//
// I1. `heldParticipantId` is the field that stops a seat claim answered `camera_starting` from spending a vendor request on
// a token the browser already holds (D21-fix-3 F1: 75% of a thirty-board round's calls were those refreshes). It travels
// browser -> claimSeat (room-api.ts) -> THIS route's body -> claimRoomSeat -> seatPlayer. The usecase and the builder were
// each tested; the HOPS between them were not, so a refactor sending `null` at either end left everything green and the
// starvation back. use-room-held-participant.test.tsx pins the browser's hop, and the e2e (match-room.spec.ts) pins what
// the real browser puts on the wire. This file pins the route's: the body field reaches the seat.
//
// I2. Over the per-seat limit a route answers 429 RATE_LIMITED with a Retry-After header, and the vendor hears nothing.
// (The mechanism and the numbers are seat-ask-limit.test.ts's; the usecase wiring is external-play-seat-ask-limit.test.ts's.)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { SEAT_ASK_LIMIT, SEAT_ASK_WINDOW_S } from "@/server/external-play/seat-ask-limit";
import { POST as roomPost } from "@/app/api/v1/fixtures/[id]/external-play/room/route";
import { POST as cameraPost } from "@/app/api/v1/fixtures/[id]/external-play/room/camera/route";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../../../../../../e2e/realtimekit-fixture-server";

const HAS_DB = !!process.env.DATABASE_URL;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (fixtureId: string, tail: string, t: string) =>
  `https://test.local/api/v1/fixtures/${fixtureId}/external-play/room${tail}?t=${encodeURIComponent(t)}`;
type Envelope = {
  ok: boolean;
  data?: { seat?: { seated: boolean; reason?: string; participant: { participantId: string; authToken: string } | null } | null; participant?: unknown };
  error?: { code?: string };
};
async function read(res: Response) {
  return { status: res.status, headers: res.headers, body: (await res.json()) as Envelope };
}
/** `body` undefined sends NO body at all (a browser that holds no token sends none - room-api.ts claimSeat). */
const post = (u: string, body?: unknown) =>
  new Request(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// Real clock: the check-in is stamped at the claim's own now (the real clock here, no `now` is injected).
const OPENED = new Date(Date.now() - 2 * 60_000);
async function seed(cameraPolicy: "required" | "optional") {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: OPENED,
    roundOpenedAt: OPENED,
    linked: true,
    cameraPolicy,
  });
  const [open] = await sql<{ id: string; opened_at: Date }[]>`
    select id, opened_at from stage_round_opens where stage_id = ${s.stageId} and round_no = 1`;
  const tokenFor = (personId: string) =>
    mintMatchRoomToken({ fixtureId: s.fixtureId, personId, roundOpenId: open!.id, roundOpenedAt: open!.opened_at.toISOString() });
  return { ...s, tokenFor };
}

const calledRoute = (route: string) => fx.calls.filter((c) => c.route === route).length;
const tokenRefreshes = () => calledRoute("POST /meetings/:id/participants/:pid/token");

describe.skipIf(!HAS_DB)("I1 - POST …/room: the body's heldParticipantId reaches the seat (REQUIRED board, real adapter)", () => {
  /** A required board whose home player has taken the seat once and JOINED the meeting, the camera's own report not in yet:
   *  the state in which a poll is answered `camera_starting`. */
  async function joinedAndStarting() {
    const s = await seed("required");
    const t = await s.tokenFor(s.home.personId);
    const first = await read(await roomPost(post(url(s.fixtureId, "", t)), ctx(s.fixtureId)));
    expect(first.status).toBe(200);
    expect(first.body.data!.seat, "premise: the first visit is refused for want of a camera, and is handed its token").toMatchObject({
      seated: false,
      reason: "camera_required",
    });
    const pid = first.body.data!.seat!.participant!.participantId;
    fx.setLivePublisher(pid, true, { camera: "pending" });
    return { s, t, pid };
  }
  const claim = async (s: { fixtureId: string }, t: string, body?: unknown) =>
    read(await roomPost(post(url(s.fixtureId, "", t), body), ctx(s.fixtureId)));

  it("a claim that names the participant it holds is answered camera_starting with NO token, and the vendor saw ZERO token refreshes for it", async () => {
    const { s, t, pid } = await joinedAndStarting();
    const before = tokenRefreshes();
    const got = await claim(s, t, { heldParticipantId: pid });
    expect(got.status).toBe(200);
    expect(got.body.data!.seat, "camera_starting, and no token handed to a browser that already holds it").toEqual({
      seated: false,
      reason: "camera_starting",
      participant: null,
    });
    expect(tokenRefreshes() - before, "no vendor request was spent on a token the browser holds").toBe(0);
  });

  it("the pairs: NO body (a reload holds nothing), a null id, and another participant's id are each handed the token - one refresh each", async () => {
    const { s, t, pid } = await joinedAndStarting();
    let checked = 0;
    for (const body of [undefined, { heldParticipantId: null }, { heldParticipantId: `pt-${randomUUID()}` }, {}]) {
      const before = tokenRefreshes();
      const got = await claim(s, t, body);
      expect(got.body.data!.seat, `body ${JSON.stringify(body)}: still camera_starting`).toMatchObject({ seated: false, reason: "camera_starting" });
      expect(got.body.data!.seat!.participant?.participantId, `body ${JSON.stringify(body)}: handed the caller's own token`).toBe(pid);
      expect(tokenRefreshes() - before, `body ${JSON.stringify(body)}: one refresh`).toBe(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: the four shapes of 'holds none'").toBe(4);
  });

  it("the route refuses a body it does not know (strict) - a typo in the field name is a 400, not a silent 'holds none'", async () => {
    const { s, t, pid } = await joinedAndStarting();
    const got = await claim(s, t, { heldParticipant: pid });
    expect(got.status).toBe(400);
  });
});

describe.skipIf(!HAS_DB)("I2 - over the per-seat limit a route answers 429 RATE_LIMITED + Retry-After, and the vendor hears nothing", () => {
  it("POST …/room (required board): the (limit+1)th claim", async () => {
    const s = await seed("required");
    const t = await s.tokenFor(s.home.personId);
    for (let i = 0; i < SEAT_ASK_LIMIT.seat; i += 1) {
      expect((await read(await roomPost(post(url(s.fixtureId, "", t)), ctx(s.fixtureId)))).status, `claim ${i + 1}`).toBe(200);
    }
    const spent = fx.calls.length;
    expect(spent, "anti-vacuity: the claims before the limit reached the vendor").toBeGreaterThan(0);
    const refused = await read(await roomPost(post(url(s.fixtureId, "", t)), ctx(s.fixtureId)));
    expect([refused.status, refused.body.error?.code]).toEqual([429, "RATE_LIMITED"]);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(SEAT_ASK_WINDOW_S);
    expect(fx.calls.length, "the refused claim reached no vendor").toBe(spent);
    // The opponent, same board, same route: answered (the limit is per seat).
    const away = await s.tokenFor(s.away.personId);
    expect((await read(await roomPost(post(url(s.fixtureId, "", away)), ctx(s.fixtureId)))).status).toBe(200);
  });

  it("POST …/room/camera (optional board): the (limit+1)th ask", async () => {
    const s = await seed("optional");
    const t = await s.tokenFor(s.home.personId);
    for (let i = 0; i < SEAT_ASK_LIMIT.camera; i += 1) {
      expect((await read(await cameraPost(post(url(s.fixtureId, "/camera", t)), ctx(s.fixtureId)))).status, `ask ${i + 1}`).toBe(200);
    }
    const spent = fx.calls.length;
    expect(spent, "anti-vacuity: the asks before the limit reached the vendor").toBeGreaterThan(0);
    const refused = await read(await cameraPost(post(url(s.fixtureId, "/camera", t)), ctx(s.fixtureId)));
    expect([refused.status, refused.body.error?.code]).toEqual([429, "RATE_LIMITED"]);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(SEAT_ASK_WINDOW_S);
    expect(fx.calls.length, "the refused ask reached no vendor").toBe(spent);
  });
});

describe.skipIf(!HAS_DB)("m2 - the camera route can answer 409 VIDEO_MEETING_ENDED, and the published document says what the routes can answer", () => {
  type Op = { responses: Record<string, unknown> };
  const operation = (path: string): Op => {
    const op = (buildOpenApiDocument().paths as Record<string, { post?: Op }>)[`/api/v1/fixtures/{id}/external-play/room${path}`]?.post;
    if (!op) throw new Error(`POST …/room${path} is not in the document`);
    return op;
  };

  it("an ask for a board whose meeting has ENDED is a 409 VIDEO_MEETING_ENDED (the real route, the real adapter's refusal)", async () => {
    const s = await seed("optional");
    const t = await s.tokenFor(s.home.personId);
    const first = await read(await cameraPost(post(url(s.fixtureId, "/camera", t)), ctx(s.fixtureId)));
    expect(first.status, "premise: an ask on a live meeting is answered (and made the meeting)").toBe(200);
    const ended = await sql`update fixture_video_meetings set ended_at = now() where fixture_id = ${s.fixtureId} and ended_at is null`;
    expect(ended.count, "premise: there was a live meeting to end").toBe(1);
    const got = await read(await cameraPost(post(url(s.fixtureId, "/camera", t)), ctx(s.fixtureId)));
    expect([got.status, got.body.error?.code]).toEqual([409, "VIDEO_MEETING_ENDED"]);
  });

  it("the document lists every status the two doors are shown to answer here: the camera door 409 and 429, the seat door 429", () => {
    expect(Object.keys(operation("/camera").responses), "camera").toEqual(expect.arrayContaining(["401", "404", "409", "429"]));
    expect(Object.keys(operation("").responses), "seat").toEqual(expect.arrayContaining(["400", "401", "404", "409", "429"]));
  });
});
