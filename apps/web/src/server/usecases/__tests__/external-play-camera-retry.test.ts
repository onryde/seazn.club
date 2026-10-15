// T17B fix 2, D21-fix-3 (owner decision) - an OPTIONAL camera seated with no token because the platform's call budget was
// spent gets its tile LATER, without a reload.
//
// Before: `seated: true` with no participant ended the room's polling, so the player had no tile for the rest of the match.
// Now the seat ANSWER says which kind of tokenless seat it is - `cameraRetry: true` on a deferral, and on nothing else - and
// a separate, token-only door (`cameraTokenForSeat`, POST …/room/camera) hands the token over when the budget allows. Driven
// through the REAL seat and the REAL adapter against the e2e RealtimeKit fixture vendor, counting the requests the FIXTURE
// saw (never the seat's own idea of what it asked), and for the budget the REAL database bucket, witnessed by its row.
//
// The tokenless seats that must NEVER be asked again: camera Off (there is no camera), an organiser's override (D11: the
// vendor may be what is broken), an outage (the vendor is down - not a budget, and retrying would hammer it). Required has
// its own door (the camera refusals carry the token). Each is a pair of the positive case and its negative.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by
// the guard before the seat is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { captureError } from "@/lib/sentry";
import { sql } from "@/lib/db";
import { budgetKey } from "@/server/external-play/video/budget";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { cameraTokenForSeat, seatPlayer, type PreflightDeps } from "../external-play/preflight";
import { claimRoomSeat, requestRoomCamera } from "../external-play/room";
import {
  addParticipant,
  ensureMeeting,
  RealtimeKitError,
  refreshParticipantToken,
  seatCameraEvidence,
} from "@/server/external-play/video/realtimekit";
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
const refill = () => sql`delete from realtimekit_call_budget where key = ${bucketKey()}`;
/** The platform's budget spent: no token, and a refill stamp in the future so no time passes into one. */
const drain = () => sql`
  insert into realtimekit_call_budget (key, tokens, refilled_at) values (${bucketKey()}, 0, now() + interval '1 hour')
  on conflict (key) do update set tokens = 0, refilled_at = now() + interval '1 hour'`;
const bucketTokens = async () =>
  (await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${bucketKey()}`)[0]?.tokens ?? null;

beforeEach(async () => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  // The fixture's host is not Cloudflare's, so it is metered only on request (realtimekit.ts cfEnvelope).
  vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
  vi.mocked(captureError).mockClear();
  if (DB) await refill();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (DB) await refill();
});

type Policy = "off" | "required" | "optional";
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
type Video = NonNullable<PreflightDeps["video"]>;

const ask = (s: Seeded) => ({ fixtureId: s.fixtureId, personId: s.home.personId });
const claim = (s: Seeded, video?: Video, now = new Date()) => seatPlayer(ask(s), { now, ...(video ? { video } : {}) });

/** The video seam over the REAL adapter, spending from `budget` (one per request). */
function metered(budget: () => Promise<boolean>): Video {
  return {
    ensureMeeting: (id, side) => ensureMeeting(id, side, { budget }),
    addParticipant: (a) => addParticipant(a, { budget }),
    seatCameraEvidence: (a) => seatCameraEvidence(a, { budget }),
    refreshParticipantToken: (a) => refreshParticipantToken(a, { budget }),
  };
}
const grantAll = async () => true;
const refuseAll = async () => false;
/** A budget that refuses exactly the n-th request it is asked about (1-based) and grants every other. */
function refusingRequest(n: number): () => Promise<boolean> {
  let asked = 0;
  return async () => ++asked !== n;
}
/** A vendor that is DOWN: every request is an outage (503), which is not a deferral. */
const down: Video = {
  ensureMeeting: async () => {
    throw new RealtimeKitError(503, "unavailable", "test outage");
  },
  addParticipant: async () => {
    throw new RealtimeKitError(503, "unavailable", "test outage");
  },
  seatCameraEvidence: async () => {
    throw new RealtimeKitError(503, "unavailable", "test outage");
  },
  refreshParticipantToken: async () => {
    throw new RealtimeKitError(503, "unavailable", "test outage");
  },
};

const calledRoute = (route: string) => fx.calls.filter((c) => c.route === route).length;
const overrideVideo = (fixtureId: string, orgId: string) =>
  sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, video_override_at)
      values (${fixtureId}, ${orgId}, now(), now())
      on conflict (fixture_id) do update set video_override_at = now()`;

describe.skipIf(!DB)("the seat says WHICH tokenless seat it is (D21-fix-3)", () => {
  it("an optional seat the budget cut short carries cameraRetry: true - at the meeting AND at the participant", async () => {
    let checked = 0;
    for (const n of [1, 2]) {
      const s = await seed("optional");
      const got = await claim(s, metered(refusingRequest(n)));
      expect(got, `request ${n} refused`).toStrictEqual({ seated: true, participant: null, cameraRetry: true });
      expect(vi.mocked(captureError), `request ${n}: a deferral is not an outage`).not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked, "anti-vacuity: both requests of a first claim").toBe(2);
  });

  it("the pair: a granted optional seat carries its token and NO flag - the key is absent, not false", async () => {
    const s = await seed("optional");
    const got = await claim(s, metered(grantAll));
    expect(got.seated && got.participant?.participantId, "a token").toBeTruthy();
    expect(Object.keys(got).sort(), "exactly seated + participant").toEqual(["participant", "seated"]);
  });

  it("never on the others: an OUTAGE under optional, Off, and an organiser's override are tokenless and FINAL", async () => {
    const outage = await seed("optional");
    const o = await claim(outage, down);
    expect(o, "an outage: seated, no tile, no flag").toStrictEqual({ seated: true, participant: null });
    expect(vi.mocked(captureError), "an outage IS reported").toHaveBeenCalledTimes(1);

    const off = await seed("off");
    const before = fx.calls.length;
    expect(await claim(off, metered(grantAll)), "camera Off").toStrictEqual({ seated: true, participant: null });

    const overridden = await seed("optional");
    await overrideVideo(overridden.fixtureId, overridden.orgId);
    expect(await claim(overridden, metered(refuseAll)), "an organiser's override, even with the budget spent").toStrictEqual({
      seated: true,
      participant: null,
    });
    expect(fx.calls.length - before, "Off and an override never reached the vendor").toBe(0);
  });

  it("T9's re-verify (recheck) never asks the vendor and never says retry: nobody joins with its answer", async () => {
    const s = await seed("optional");
    const got = await seatPlayer({ ...ask(s), recheck: true }, { now: new Date(), video: metered(refuseAll) });
    expect(got).toStrictEqual({ seated: true, participant: null });
    expect(fx.calls.length).toBe(0);
  });
});

describe.skipIf(!DB)("cameraTokenForSeat - the token-only door (D21-fix-3)", () => {
  it("Off, Required and an override are answered at once: no token, no retry, and NOT ONE vendor request", async () => {
    let checked = 0;
    for (const policy of ["off", "required"] as const) {
      const s = await seed(policy);
      expect(await cameraTokenForSeat(ask(s), { now: new Date() }), policy).toStrictEqual({ participant: null, retry: false });
      checked += 1;
    }
    const overridden = await seed("optional");
    await overrideVideo(overridden.fixtureId, overridden.orgId);
    expect(await cameraTokenForSeat(ask(overridden), { now: new Date() }), "override").toStrictEqual({ participant: null, retry: false });
    checked += 1;
    expect(checked, "anti-vacuity: three cases").toBe(3);
    expect(fx.calls.length, "no request reached the vendor").toBe(0);
    expect(await bucketTokens(), "and no token was spent").toBeNull();
  });

  it("an optional seat while the budget is SPENT is answered retry: true - the vendor is not asked, the bucket is not charged", async () => {
    const s = await seed("optional");
    await drain();
    let checked = 0;
    for (let i = 0; i < 3; i += 1) {
      expect(await cameraTokenForSeat(ask(s), { now: new Date() }), `ask ${i + 1}`).toStrictEqual({ participant: null, retry: true });
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(fx.calls.length, "a deferred call never reaches the vendor").toBe(0);
    expect(await bucketTokens(), "a refusal spends nothing").toBe(0);
  });

  it("the budget back: the token comes, retry is false - and the SPEND is what the vendor saw", async () => {
    const s = await seed("optional");
    await drain();
    expect((await cameraTokenForSeat(ask(s), { now: new Date() })).retry).toBe(true);
    await sql`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${bucketKey()}, 50, now())
              on conflict (key) do update set tokens = 50, refilled_at = now()`;
    const got = await cameraTokenForSeat(ask(s), { now: new Date() });
    expect(got.retry).toBe(false);
    expect(got.participant?.participantId, "the caller's own participant").toBeTruthy();
    expect(got.participant?.authToken).toBeTruthy();
    // The spend, taken from the fixture's own request count - never from the code under test: a meeting and a participant.
    const seen = fx.calls.length;
    expect(seen, "premise: the vendor saw requests").toBeGreaterThan(0);
    const after = (await bucketTokens())!;
    expect(50 - after, "the bucket was charged one token per request the vendor saw (+ a refill of well under one)").toBeGreaterThanOrEqual(seen - 0.5);
    expect(50 - after).toBeLessThanOrEqual(seen);
  });

  it("a SECOND ask after the token came hands one again (the token is regenerated, the participant is the same) - never 'no tile'", async () => {
    const s = await seed("optional");
    const first = await cameraTokenForSeat(ask(s), { now: new Date() });
    const second = await cameraTokenForSeat(ask(s), { now: new Date() });
    expect(first.participant?.participantId).toBeTruthy();
    expect(second.participant?.participantId, "the same participant").toBe(first.participant?.participantId);
    expect(second.retry).toBe(false);
    expect(calledRoute("POST /meetings/:id/participants"), "one participant minted for the person").toBe(1);
    expect(calledRoute("POST /meetings"), "one meeting").toBe(1);
  });

  it("the deferral lands MID-WAY (the meeting made, the participant refused): retry, then the token - one meeting, one participant", async () => {
    const s = await seed("optional");
    const first = await cameraTokenForSeat(ask(s), { now: new Date(), video: metered(refusingRequest(2)) });
    expect(first, "the meeting was made, the participant deferred").toStrictEqual({ participant: null, retry: true });
    expect(calledRoute("POST /meetings")).toBe(1);
    expect(calledRoute("POST /meetings/:id/participants")).toBe(0);
    const then = await cameraTokenForSeat(ask(s), { now: new Date(), video: metered(grantAll) });
    expect(then.participant?.participantId).toBeTruthy();
    expect(calledRoute("POST /meetings"), "the meeting already on file is not made again").toBe(1);
    expect(calledRoute("POST /meetings/:id/participants")).toBe(1);
  });

  it("an OUTAGE is final: retry false (a vendor that is down is not hammered by every tab's back-off)", async () => {
    const s = await seed("optional");
    expect(await cameraTokenForSeat(ask(s), { now: new Date(), video: down })).toStrictEqual({ participant: null, retry: false });
    expect(vi.mocked(captureError), "reported once").toHaveBeenCalledTimes(1);
  });

  it("every seat refusal stays a refusal: a stranger, an abandoned board and a closed window get no token and no retry - and no vendor request", async () => {
    const s = await seed("optional");
    const stranger = await seed("optional");
    expect(await cameraTokenForSeat({ fixtureId: s.fixtureId, personId: stranger.home.personId }, { now: new Date() }), "not a player").toStrictEqual({
      participant: null,
      retry: false,
    });
    const closed = await cameraTokenForSeat(ask(s), { now: new Date(Date.now() + 60 * 60_000) });
    expect(closed, "the window closed, the caller was never seated").toStrictEqual({ participant: null, retry: false });
    await sql`update fixtures set status = 'abandoned' where id = ${s.fixtureId}`;
    expect(await cameraTokenForSeat(ask(s), { now: new Date() }), "not playable").toStrictEqual({ participant: null, retry: false });
    expect(fx.calls.length, "no vendor request for any of them").toBe(0);
  });
});

describe.skipIf(!DB)("the room: the claim carries the flag, the camera door asks for the token and NOTHING else (D21-fix-3)", () => {
  const stubs = () => ({
    publish: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ created: false, reason: "not_ready" }) as never),
    offered: vi.fn(async () => true),
  });

  it("claimRoomSeat puts the seat's cameraRetry on the wire - only when the seat set it", async () => {
    const s = await seed("optional");
    const withFlag = vi.fn(async () => ({ seated: true as const, participant: null, cameraRetry: true as const }));
    const c = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, { ...stubs(), seat: withFlag as never });
    expect(c.seat).toStrictEqual({ seated: true, participant: null, cameraRetry: true });
    const without = vi.fn(async () => ({ seated: true as const, participant: null }));
    const d = await claimRoomSeat({ kind: "session", userId: s.home.userId }, s.fixtureId, { ...stubs(), seat: without as never });
    expect(d.seat, "no flag, no key").toStrictEqual({ seated: true, participant: null });
  });

  it("requestRoomCamera asks for the CALLER's token and stamps nothing, publishes nothing, creates nothing", async () => {
    const s = await seed("optional");
    const token = { participantId: "pt-1", authToken: "jwt-1" };
    const cameraToken = vi.fn(async () => ({ participant: token, retry: false }));
    const d = stubs();
    const now = new Date();
    const got = await requestRoomCamera({ kind: "session", userId: s.home.userId }, s.fixtureId, { ...d, now, cameraToken: cameraToken as never });
    expect(got).toStrictEqual({ participant: token, retry: false });
    expect(cameraToken).toHaveBeenCalledWith({ fixtureId: s.fixtureId, personId: s.home.personId }, { now });
    expect(d.publish).not.toHaveBeenCalled();
    expect(d.create).not.toHaveBeenCalled();
    const rows = await sql`select 1 from fixture_availability where fixture_id = ${s.fixtureId} and checked_in_at is not null`;
    expect(rows.length, "no check-in was stamped").toBe(0);
  });

  it("a stranger is the same NOT_FOUND as at every other room route - and the vendor is never asked", async () => {
    const s = await seed("optional");
    const stranger = await seed("optional");
    await expect(
      requestRoomCamera({ kind: "session", userId: stranger.home.userId }, s.fixtureId, { ...stubs() }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fx.calls.length).toBe(0);
  });

  it("SEQUENCE through the real seat: a deferred claim, a deferred ask, the budget back - the tile comes, and the player is checked in exactly once", async () => {
    const s = await seed("optional");
    const id = { kind: "session" as const, userId: s.home.userId };
    await drain();
    const d = stubs();
    const first = await claimRoomSeat(id, s.fixtureId, { ...d });
    expect(first.seat, "the real seat under a spent budget").toStrictEqual({ seated: true, participant: null, cameraRetry: true });
    expect(first.snapshot.you.checkedIn, "seated is checked in - the tile is late, the player is not").toBe(true);
    // The camera door while the budget is still spent: retry, nothing written, nothing spent.
    expect(await requestRoomCamera(id, s.fixtureId, {})).toStrictEqual({ participant: null, retry: true });
    expect(fx.calls.length).toBe(0);
    await refill();
    const tile = await requestRoomCamera(id, s.fixtureId, {});
    expect(tile.retry).toBe(false);
    expect(tile.participant?.participantId).toBeTruthy();
    const stamps = await sql`select checked_in_at from fixture_availability where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
    expect(stamps.length, "one availability row for the player").toBe(1);
    // The reload's way: a claim with no held token is handed it as ever (the seat is unchanged by the detour).
    const reload = await claimRoomSeat(id, s.fixtureId, { ...stubs() });
    expect(reload.seat?.seated && reload.seat.participant?.participantId, "a reload gets the same participant").toBe(tile.participant!.participantId);
  });
});
