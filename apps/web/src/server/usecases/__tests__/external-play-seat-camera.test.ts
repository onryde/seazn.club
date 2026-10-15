// T17B fix 2, D2 — "camera required" was not enforced. Measured live on stg (build a7134be67): a player whose
// browser DENIED the camera pressed "Try again", was answered `seated: true`, and a Lichess game was created
// (JTcfKXow). The seat asked only "joined, not left" — the preset enforces nothing.
//
// The seat now reads the CURRENT peer's own RealtimeKit report: seated only on `media_permission` VIDEO ACCEPTED
// with the latest on/off event `video_on`; DENIED is `camera_blocked`; no evidence yet is `camera_starting` until
// CAMERA_EVIDENCE_DEADLINE_MS after the peer joined, then the camera refusal; a peer-report outage is waited out the
// same way, then `video_unavailable`.
//
// Driven end to end through the REAL seat and the REAL adapter against the e2e RealtimeKit fixture server
// (e2e/realtimekit-fixture-server.ts), whose peer reports are the measured live shapes. Expected answers are the
// ruling's, never read from the code.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay), and every other sport is
// refused by the guard before the seat is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { captureError } from "@/lib/sentry";
import { sql } from "@/lib/db";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type FixtureCamera,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { CAMERA_EVIDENCE_DEADLINE_MS } from "@/components/public-site/match-room/room-snapshot";
import { seatPlayer, type SeatResult } from "../external-play/preflight";
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
  vi.mocked(captureError).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The fixture server stamps peers on the REAL clock, so the round is opened on it too: five minutes ago, well
 *  inside the window (T−10 … T+20 of the open) for every `now` below. */
async function seed() {
  const opened = new Date(Date.now() - 5 * 60_000);
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    cameraPolicy: "required",
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const claim = (s: Seeded, now = new Date()) => seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now });
const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);

/** The first claim mints the participant and hands back its token; the browser joins with it (a new PEER whose
 *  report shows `camera`). Returns the participant id and the instants around the join, which bound the peer's
 *  PEER_JOINING stamp — the anchor the seat's wait runs from. */
async function joinWith(s: Seeded, camera: FixtureCamera): Promise<{ pid: string; before: number; after: number }> {
  const first = await claim(s);
  expect(reasonOf(first), "premise: nobody has joined yet").toBe("camera_required");
  const pid = "participant" in first && first.participant ? first.participant.participantId : null;
  expect(pid, "premise: the refusal carries the caller's own token").not.toBeNull();
  const before = Date.now();
  fx.setLivePublisher(pid!, true, { camera });
  const after = Date.now();
  return { pid: pid!, before, after };
}

async function stamped(s: Seeded): Promise<Date | null> {
  const [row] = await sql<{ last_publisher_seen_at: Date | null }[]>`
    select last_publisher_seen_at from fixture_video_participants
     where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId} and preset = 'player'`;
  return row?.last_publisher_seen_at ?? null;
}

describe.skipIf(!DB)("the seat reads the current peer's camera (T17B fix 2, D2)", () => {
  it("empty case: a player who never joined is camera_required — and carries their own token to join with", async () => {
    const s = await seed();
    const got = await claim(s);
    expect(reasonOf(got)).toBe("camera_required");
    expect("participant" in got && got.participant?.authToken).toBeTruthy();
  });

  it("the defect: a browser that DENIED the camera is camera_blocked — never seated, never stamped — and keeps its token", async () => {
    const s = await seed();
    const { pid } = await joinWith(s, "denied");
    const got = await claim(s);
    expect(reasonOf(got)).toBe("camera_blocked");
    expect("participant" in got && got.participant?.participantId, "the camera stays joined: the token rides along").toBe(pid);
    expect(await stamped(s)).toBeNull();
    // Waiting does not cure it: DENIED is not "not yet".
    expect(reasonOf(await claim(s, new Date(Date.now() + CAMERA_EVIDENCE_DEADLINE_MS * 2)))).toBe("camera_blocked");
  });

  it("ACCEPTED with video_on and NO producer samples SEATS (the samples arrive late — measured), and the pass is stamped", async () => {
    const s = await seed();
    await joinWith(s, "on");
    const now = new Date();
    const got = await claim(s, now);
    expect(reasonOf(got)).toBe("seated");
    expect((await stamped(s))?.toISOString()).toBe(now.toISOString());
  });

  it("ACCEPTED then video_off is never seated: camera_required for a player who never passed, camera_lost for one who had", async () => {
    const never = await seed();
    await joinWith(never, "off");
    expect(reasonOf(await claim(never))).toBe("camera_required");

    // SEQUENCE: seated, then the camera goes off, then back on.
    const had = await seed();
    const { pid } = await joinWith(had, "on");
    expect(reasonOf(await claim(had))).toBe("seated");
    fx.setPeerCamera(pid, "video_off");
    expect(reasonOf(await claim(had)), "a player who HAD passed is told it dropped").toBe("camera_lost");
    fx.setPeerCamera(pid, "video_on");
    expect(reasonOf(await claim(had)), "and is seated again once it is back").toBe("seated");
  });

  it("an old peer that LEFT is never judged: a DENIED tab reloaded with the camera allowed is seated — and the reverse is blocked", async () => {
    const s = await seed();
    const { pid } = await joinWith(s, "denied");
    expect(reasonOf(await claim(s))).toBe("camera_blocked");
    fx.setLivePublisher(pid, false); // the reload closes the old tab …
    fx.setLivePublisher(pid, true, { camera: "on" }); // … and the new one allows the camera
    expect(reasonOf(await claim(s)), "judged on the newer peer").toBe("seated");

    const r = await seed();
    const rev = await joinWith(r, "on");
    expect(reasonOf(await claim(r))).toBe("seated");
    fx.setLivePublisher(rev.pid, false);
    fx.setLivePublisher(rev.pid, true, { camera: "denied" });
    expect(reasonOf(await claim(r)), "the newer peer denied it").toBe("camera_blocked");
  });

  it("no evidence yet is camera_starting until the deadline from the peer's OWN join, then the camera refusal — swept over both kinds of 'not yet'", async () => {
    let checked = 0;
    for (const camera of ["pending", "none"] as const) {
      const s = await seed();
      const { before, after } = await joinWith(s, camera);
      // The PEER_JOINING stamp lies in [before, after]: these two instants are inside and past the wait, whatever it is.
      const inside = await claim(s, new Date(before + CAMERA_EVIDENCE_DEADLINE_MS - 1));
      expect(reasonOf(inside), `${camera}: inside the wait`).toBe("camera_starting");
      expect("participant" in inside && inside.participant?.authToken, `${camera}: starting keeps the token`).toBeTruthy();
      expect(reasonOf(await claim(s, new Date(after + CAMERA_EVIDENCE_DEADLINE_MS))), `${camera}: past it`).toBe("camera_required");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a peer-report OUTAGE never seats: camera_starting inside the wait (nothing reported), then video_unavailable (reported once)", async () => {
    const s = await seed();
    const { before, after } = await joinWith(s, "on");
    fx.setPeerReportsUnavailable(true);
    // D21: a read of a starting camera is cached for the back-off, so the two claims are a simulated clock APART (the
    // cache itself is external-play-seat-budget.test.ts's): the first is the moment of the join, the second the deadline.
    expect(reasonOf(await claim(s, new Date(before)))).toBe("camera_starting");
    expect(vi.mocked(captureError), "a wait is not an outage yet").not.toHaveBeenCalled();
    expect(reasonOf(await claim(s, new Date(after + CAMERA_EVIDENCE_DEADLINE_MS)))).toBe("video_unavailable");
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    expect(await stamped(s)).toBeNull();
    // The vendor recovers: the same camera seats.
    fx.setPeerReportsUnavailable(false);
    expect(reasonOf(await claim(s))).toBe("seated");
  });

  it("a peer whose join the vendor stamps AHEAD of our clock is still waiting, never seated and never refused", async () => {
    const s = await seed();
    const { before } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, new Date(before - 60_000)))).toBe("camera_starting");
  });

  it("sweep: every camera a join can show answers its own reason — counted, every reason reached", async () => {
    const cases: { camera: FixtureCamera; want: string }[] = [
      { camera: "on", want: "seated" },
      { camera: "denied", want: "camera_blocked" },
      { camera: "off", want: "camera_required" },
      { camera: "pending", want: "camera_starting" },
      { camera: "none", want: "camera_starting" },
    ];
    let checked = 0;
    const seen = new Set<string>();
    for (const c of cases) {
      const s = await seed();
      await joinWith(s, c.camera);
      const got = reasonOf(await claim(s));
      expect(got, c.camera).toBe(c.want);
      seen.add(got);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(seen.size).toBe(4);
  });
});
