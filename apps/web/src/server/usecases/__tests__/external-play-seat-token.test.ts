// T17B fix 2, D21-fix-3 (F1) — a seat claim asks the cache FIRST and spends a token LAST.
//
// D22 measured it: of the 2,742 RealtimeKit calls a metered thirty-board round made, 2,071 (75.5%) were participant-token
// refreshes. The seat refreshed the caller's token at the top of EVERY claim — before it knew whether the claim was
// allowed a read at all, and when the answer it was about to give (`camera_starting`, from the cache) was one a browser
// that already holds its token has no use for it in. A read needs several grants in a row; a claim that spends one before
// it starts is starved by the claims that only wanted to be told "not yet". Three rules, each driven here through the REAL
// seat and the REAL adapter against the e2e RealtimeKit fixture server, counting the calls the FIXTURE saw - never the
// seat's own idea of what it asked:
//
//   1. the FIRST claim mints the participant, and reads nothing: the participant was made by this very claim, so no peer
//      can have joined it and there is no camera to read;
//   2. a claim answered `camera_starting` hands over NO token to a browser that says it holds this participant's (the
//      room sends the id it holds); a browser that holds none - a reload - or another participant's (a re-pair moved
//      the seat) is handed one, whatever the cache says: the token is the only way in;
//   3. every other answer - a seat, or a camera refusal - carries the caller's token (the room ends its camera on a
//      tokenless one), refreshed after the verdict, so a claim the budget cuts short has spent nothing on it.
//
// Single sport, deliberately: online play exists only for boardgame (supportsOnlinePlay); every other sport is refused by
// the guard before the seat is reached (external-play-preflight.test.ts, "another sport").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { captureError } from "@/lib/sentry";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type FixtureCamera,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { SEAT_RECHECK_TRUST_MS, seatPlayer, type PreflightDeps, type SeatResult } from "../external-play/preflight";
import { addParticipant, ensureMeeting, refreshParticipantToken, seatCameraEvidence } from "@/server/external-play/video/realtimekit";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function seed(cameraPolicy: "required" | "optional" = "required") {
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

/** `held`: the participant id whose token the caller's browser already holds (null: none - a first visit, or a reload). */
const claim = (s: Seeded, now = new Date(), held: string | null = null, video?: Video) =>
  seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId, heldParticipantId: held }, { now, ...(video ? { video } : {}) });
const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);
const tokenOf = (r: SeatResult) => ("participant" in r ? r.participant : null);

const calledRoute = (route: string) => fx.calls.filter((c) => c.route === route).length;
/** One READ of a participant's camera begins with the live-session request - and only a read makes it. */
const evidenceReads = () => calledRoute("GET /meetings/:id/active-session");
const tokenRefreshes = () => calledRoute("POST /meetings/:id/participants/:pid/token");

/** The first claim mints the participant and hands back its token; the browser joins with it (a new PEER whose report
 *  shows `camera`). */
async function joinWith(s: Seeded, camera: FixtureCamera): Promise<{ pid: string; after: number }> {
  const first = await claim(s);
  expect(reasonOf(first), "premise: nobody has joined yet").toBe("camera_required");
  const pid = tokenOf(first)?.participantId;
  expect(pid, "premise: the refusal carries the caller's own token").toBeTruthy();
  fx.setLivePublisher(pid!, true, { camera });
  return { pid: pid!, after: Date.now() };
}

function metered(budget: () => Promise<boolean>): Video {
  return {
    ensureMeeting: (id) => ensureMeeting(id, { budget }),
    addParticipant: (a) => addParticipant(a, { budget }),
    seatCameraEvidence: (a) => seatCameraEvidence(a, { budget }),
    refreshParticipantToken: (a) => refreshParticipantToken(a, { budget }),
  };
}
/** A budget that refuses exactly the n-th request it is asked about (1-based) and grants every other. */
function refusingRequest(n: number): () => Promise<boolean> {
  let asked = 0;
  return async () => ++asked !== n;
}

describe.skipIf(!DB)("F1 - the first claim, and the claim the cache answers (D21-fix-3)", () => {
  it("the FIRST claim mints the participant and reads NOTHING: the vendor saw a meeting and a participant, no session read, no token refresh", async () => {
    const s = await seed();
    const got = await claim(s);
    expect(reasonOf(got)).toBe("camera_required");
    expect(tokenOf(got)?.participantId, "the token that came with the mint").toBeTruthy();
    expect(fx.calls.map((c) => c.route), "the requests the FIXTURE saw, in order").toEqual(["POST /meetings", "POST /meetings/:id/participants"]);
    // A second board, so the first is not a fluke of one meeting: the other player's first claim on the SAME fixture reads nothing either.
    const before = fx.calls.length;
    const away = await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: new Date() });
    expect(reasonOf(away)).toBe("camera_required");
    expect(fx.calls.slice(before).map((c) => c.route), "the second player: one participant added, nothing read").toEqual(["POST /meetings/:id/participants"]);
  });

  it("the first claim leaves the cache EMPTY, so the claim after the join is allowed to read at once (nothing was counted against it)", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    const [row] = await sql<{ reads: number }[]>`select seat_reads as reads from fixture_video_participants where fixture_id = ${s.fixtureId} and participant_id = ${pid}`;
    expect(row!.reads).toBe(0);
    expect(reasonOf(await claim(s, new Date(after), pid)), "read at once, and seated").toBe("seated");
    expect(evidenceReads()).toBe(1);
  });

  it("a poll between reads from a browser that HOLDS its token costs the vendor nothing - not a read, not a refresh - and carries no token", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    const first = await claim(s, new Date(after), pid);
    expect(reasonOf(first), "premise: the camera has not reported - starting").toBe("camera_starting");
    expect(tokenOf(first), "the read that found it starting hands no token to a browser that holds one").toBeNull();
    expect([evidenceReads(), tokenRefreshes()], "that claim: one read, no refresh").toEqual([1, 0]);
    const seen = fx.calls.length;
    let checked = 0;
    for (const dt of [1, 100, 400, 999]) {
      const again = await claim(s, new Date(after + dt), pid);
      expect(reasonOf(again), `+${dt} ms`).toBe("camera_starting");
      expect(tokenOf(again), `+${dt} ms: nothing to hand over`).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: four cached polls").toBe(4);
    expect(fx.calls.length - seen, "requests the FIXTURE saw across the four cached polls").toBe(0);
  });

  it("a browser that holds NO token (a reload) is handed one on a cached claim: the token is the only way in, whatever the cache says", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("camera_starting");
    const reads = evidenceReads();
    const reloaded = await claim(s, new Date(after + 400), null);
    expect(reasonOf(reloaded), "still the cache's word").toBe("camera_starting");
    expect(tokenOf(reloaded)?.participantId, "…with the token a reloaded page needs to join").toBe(pid);
    expect(tokenOf(reloaded)?.authToken).toBeTruthy();
    expect(evidenceReads() - reads, "no read: the cache answered").toBe(0);
    expect(tokenRefreshes(), "one refresh, for the browser that had none").toBe(1);
  });

  it("a browser that holds ANOTHER participant's token (a re-pair moved its seat) is handed this one", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("camera_starting");
    const stale = await claim(s, new Date(after + 400), "participant-of-a-retired-meeting");
    expect(reasonOf(stale)).toBe("camera_starting");
    expect(tokenOf(stale)?.participantId).toBe(pid);
  });
});

describe.skipIf(!DB)("F1 - every other answer carries the token, refreshed after the verdict (D21-fix-3)", () => {
  it("a seat, and each camera refusal, carry the caller's token even to a browser that holds it - counted per verdict", async () => {
    const cases: { camera: FixtureCamera; want: string }[] = [
      { camera: "on", want: "seated" },
      { camera: "off", want: "camera_required" },
      { camera: "denied", want: "camera_blocked" },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed();
      const { pid, after } = await joinWith(s, c.camera);
      const refreshes0 = tokenRefreshes();
      const got = await claim(s, new Date(after), pid);
      expect(reasonOf(got), c.camera).toBe(c.want);
      expect(tokenOf(got)?.participantId, `${c.camera}: the token rides with the answer`).toBe(pid);
      expect(tokenRefreshes() - refreshes0, `${c.camera}: one refresh`).toBe(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every definite verdict").toBe(cases.length);
  });

  it("a camera refused after it HAD passed (camera_lost) carries the token too", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("seated");
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "off" });
    const lost = await claim(s, new Date(after + 1_000), pid);
    expect(reasonOf(lost)).toBe("camera_lost");
    expect(tokenOf(lost)?.participantId).toBe(pid);
  });

  it("SEQUENCE: a camera that starts and then comes up costs ONE refresh for the whole check-in (the claim that seats it), not one per claim", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("camera_starting");
    expect(reasonOf(await claim(s, new Date(after + 500), pid)), "cached").toBe("camera_starting");
    fx.reportCamera(pid, "on"); // the camera's own report, on the SAME peer
    const seated = await claim(s, new Date(after + 1_000), pid);
    expect(reasonOf(seated)).toBe("seated");
    expect(tokenOf(seated)?.participantId).toBe(pid);
    expect(evidenceReads(), "two reads: the starting one and the seating one").toBe(2);
    expect(tokenRefreshes(), "the seating claim's refresh and no other").toBe(1);
    // …and a seat is re-verified at once, with its token again (T9's old way; the room's reload re-entry).
    expect(reasonOf(await claim(s, new Date(after + 1_001), pid))).toBe("seated");
    expect(tokenRefreshes()).toBe(2);
  });

  it("a deferral at the TOKEN request - after a verdict of `on` - is `camera_starting`, never an outage, and the next claim seats", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    // A claim after the join makes its three evidence requests, then asks for the token: the fourth is refused.
    const got = await claim(s, new Date(after), pid, metered(refusingRequest(4)));
    expect(reasonOf(got)).toBe("camera_starting");
    expect(tokenOf(got), "nothing refreshed, so nothing handed").toBeNull();
    expect(tokenRefreshes(), "the refused request was never made").toBe(0);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
    expect(info.mock.calls.filter((c) => /RealtimeKit call budget spent; the seat answered camera_starting/.test(String(c[1]))), "logged once").toHaveLength(1);
    const retry = await claim(s, new Date(after + 1_000), pid);
    expect(reasonOf(retry), "the camera was on all along").toBe("seated");
    expect(tokenOf(retry)?.participantId).toBe(pid);
  });

  it("a deferral at the READ spends no token: the claim that cannot look hands over nothing and refreshes nothing", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    const got = await claim(s, new Date(after), pid, metered(refusingRequest(1)));
    expect(reasonOf(got)).toBe("camera_starting");
    expect(tokenOf(got)).toBeNull();
    expect(fx.calls.filter((c) => c.route === "POST /meetings/:id/participants/:pid/token"), "no refresh before the verdict").toHaveLength(0);
  });

  it("the optional policy is unchanged: every claim seats and carries a token", async () => {
    const s = await seed("optional");
    const first = await claim(s);
    expect(reasonOf(first)).toBe("seated");
    expect(tokenOf(first)?.participantId).toBeTruthy();
    const again = await claim(s, new Date(), tokenOf(first)!.participantId);
    expect(reasonOf(again)).toBe("seated");
    expect(tokenOf(again)?.participantId).toBe(tokenOf(first)!.participantId);
  });
});

// ─── F2: T9's re-verify (`recheck`) ───────────────────────────────────────────────────────────────────────────────────
// createGameIfReady asked the vendor about BOTH players again - a token and three reads each - immediately before it
// created the game. Under the call budget that re-verify was deferred, "not ready" was all it said, and the board was
// stranded. The re-verify's answer is read by the server alone, so it hands nobody a token, and a camera read ON a
// moment ago stands.
const recheck = (s: Seeded, now = new Date(), side: "home" | "away" = "home") =>
  seatPlayer({ fixtureId: s.fixtureId, personId: s[side].personId, recheck: true }, { now });

/** The stamp the seat wrote when it last read this player's camera ON. */
async function passStamp(s: Seeded): Promise<Date | null> {
  const [row] = await sql<{ at: Date | null }[]>`
    select last_publisher_seen_at as at from fixture_video_participants where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId} and preset = 'player'`;
  return row!.at;
}

describe.skipIf(!DB)("F2 - the re-verify before a game is created hands no token and trusts a pass read a moment ago (D21-fix-3)", () => {
  it("the ruling's bound: the trust window is at most ten seconds", () => {
    expect(SEAT_RECHECK_TRUST_MS).toBeGreaterThan(0);
    expect(SEAT_RECHECK_TRUST_MS, "the controller's ceiling for the window").toBeLessThanOrEqual(10_000);
  });

  it("a re-verify outside the window READS the camera and answers seated with NO token: the vendor sees three reads and not one token request", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid)), "premise: the player checked in").toBe("seated");
    const before = { reads: evidenceReads(), refreshes: tokenRefreshes(), added: calledRoute("POST /meetings/:id/participants") };
    const got = await recheck(s, new Date(after + SEAT_RECHECK_TRUST_MS + 1));
    expect(reasonOf(got)).toBe("seated");
    expect(tokenOf(got), "nobody joins with a re-verify's answer").toBeNull();
    expect(evidenceReads() - before.reads, "the pass is too old to stand: one read (three requests)").toBe(1);
    expect(tokenRefreshes() - before.refreshes, "and no token refreshed for it").toBe(0);
    expect(calledRoute("POST /meetings/:id/participants") - before.added, "and no participant minted").toBe(0);
  });

  it("a re-verify INSIDE the window makes no vendor call at all - at the window's edge (inclusive), and one millisecond past it reads", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("seated");
    const stamp = (await passStamp(s))!;
    expect(stamp.getTime(), "premise: the seat stamped the pass at the claim's own clock").toBe(after);
    const seen = fx.calls.length;
    for (const dt of [0, 1, 4_000, SEAT_RECHECK_TRUST_MS]) {
      const got = await recheck(s, new Date(after + dt));
      expect(reasonOf(got), `+${dt} ms`).toBe("seated");
      expect(tokenOf(got), `+${dt} ms`).toBeNull();
    }
    expect(fx.calls.length - seen, "requests the FIXTURE saw across four trusted re-verifies").toBe(0);
    expect((await passStamp(s))!.getTime(), "a trusted pass writes nothing: it can never make itself younger").toBe(after);
    expect(reasonOf(await recheck(s, new Date(after + SEAT_RECHECK_TRUST_MS + 1)))).toBe("seated");
    expect(fx.calls.length - seen, "one millisecond past the window: it reads").toBeGreaterThan(0);
  });

  it("a pass is judged on the age of the READ, not of the claim after it: a read that finds the camera on stamps afresh", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("seated");
    const late = after + 60_000;
    expect(reasonOf(await recheck(s, new Date(late))), "stale: read, and on").toBe("seated");
    expect((await passStamp(s))!.getTime(), "the read re-stamped the pass").toBe(late);
    const seen = fx.calls.length;
    expect(reasonOf(await recheck(s, new Date(late + 5_000))), "inside the NEW window").toBe("seated");
    expect(fx.calls.length - seen).toBe(0);
  });

  it("no pass on file - never read ON - is never trusted: the re-verify reads, and a camera that is not on is `camera_required`, still with no token", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "off");
    expect(await passStamp(s), "premise: nobody has passed").toBeNull();
    const reads0 = evidenceReads();
    const got = await recheck(s, new Date(after));
    expect(reasonOf(got)).toBe("camera_required");
    expect(tokenOf(got)).toBeNull();
    expect(evidenceReads() - reads0).toBe(1);
  });

  it("a restarted camera (a not-yet verdict outstanding) is not trusted even inside the window: the pass predates the restart", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("seated");
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "pending" }); // a reload: a new peer, nothing reported
    expect(reasonOf(await claim(s, new Date(after + 1_000), pid)), "premise: the player's own claim reads the new peer - starting").toBe("camera_starting");
    const got = await recheck(s, new Date(after + 2_000));
    expect(reasonOf(got), "inside the ten seconds of the old pass - and still not seated").toBe("camera_starting");
    expect(tokenOf(got)).toBeNull();
  });

  it("a re-verify of a player who NEVER joined mints nothing and reads nothing: camera_required, no participant row, no vendor call", async () => {
    const s = await seed();
    // The OTHER player checked in, so the meeting exists; this player never claimed.
    await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: new Date() });
    const seen = fx.calls.length;
    const got = await recheck(s, new Date(), "home");
    expect(reasonOf(got)).toBe("camera_required");
    expect(tokenOf(got)).toBeNull();
    expect(fx.calls.length - seen, "nothing asked of the vendor").toBe(0);
    expect(await sql`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`, "and nobody minted for them").toHaveLength(0);
  });

  it("the other player is a different participant: a trusted pass is THEIRS - the neighbour's pass never seats this one", async () => {
    const s = await seed();
    const home = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(home.after), home.pid))).toBe("seated");
    // The away player has a participant whose camera is off. Their re-verify must read, not borrow home's pass.
    const first = await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: new Date() });
    fx.setLivePublisher(tokenOf(first)!.participantId, true, { camera: "off" });
    const got = await recheck(s, new Date(home.after + 1_000), "away");
    expect(reasonOf(got)).toBe("camera_required");
  });

  it("the optional policy: a re-verify seats at once with no vendor call at all", async () => {
    const s = await seed("optional");
    const seen = fx.calls.length;
    const got = await recheck(s);
    expect(reasonOf(got)).toBe("seated");
    expect(tokenOf(got)).toBeNull();
    expect(fx.calls.length - seen).toBe(0);
  });

  it("a re-verify the budget cannot afford is `camera_starting` - not a refusal, not an outage, nothing minted - and the next one seats", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after), pid))).toBe("seated");
    const stale = new Date(after + SEAT_RECHECK_TRUST_MS + 1_000);
    const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId, recheck: true }, { now: stale, video: metered(async () => false) });
    expect(reasonOf(got)).toBe("camera_starting");
    expect(tokenOf(got)).toBeNull();
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
    expect(reasonOf(await recheck(s, new Date(stale.getTime() + 1_000))), "budget back: the camera was on all along").toBe("seated");
  });
});
