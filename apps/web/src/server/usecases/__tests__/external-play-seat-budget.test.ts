// T17B fix 2, D21 (review I2) — the seat gate inside RealtimeKit's budget.
//
// The vendor allows 1,200 REST calls per five minutes for the WHOLE account and refuses every call, for every club, for
// five minutes past it. A claim for a starting camera costs the vendor four calls (a token refresh, the live session, its
// participants, the peer report), and the room used to make one every second. Two guards, both driven here through the
// REAL seat and the REAL adapter against the e2e RealtimeKit fixture server (e2e/realtimekit-fixture-server.ts), counting
// the calls the FIXTURE saw — never the seat's own idea of what it asked:
//
//   1. the per-participant evidence cache (V446): a read of a starting camera is allowed only on the back-off schedule
//      (1, 2, 4, 8 s — the ruling's table, typed below from the ruling, never read back from the code under test); a claim
//      between reads is answered from what the last read found, re-judged against the claim's own clock, with no vendor
//      call; anything DEFINITE (on, off, blocked, absent) is never cached;
//   2. the platform call budget (video/budget.ts): over budget a request is deferred, and a deferral at ANY of a claim's
//      seven requests is `camera_starting` — never "no camera", never an outage, never a Sentry error — and the next claim
//      says the truth.
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
import { CAMERA_EVIDENCE_DEADLINE_MS } from "@/components/public-site/match-room/room-snapshot";
import { seatPlayer, type PreflightDeps, type SeatResult } from "../external-play/preflight";
import { RealtimeKitDeferred, addParticipant, ensureMeeting, refreshParticipantToken, seatCameraEvidence } from "@/server/external-play/video/realtimekit";
import { RTK_BUDGET_WINDOW_MS, RTK_CALLS_PER_WINDOW, RTK_VENDOR_LIMIT_PER_WINDOW, takeRealtimeKitCall } from "@/server/external-play/video/budget";
import { cameraEvidenceDelayMs, CAMERA_EVIDENCE_MAX_POLLS } from "@/components/public-site/match-room/room-snapshot";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
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

/** The ruling's back-off table (controller, 2026-10-15): the wait after the first, second, third read … held at the last. */
const RULING_BACKOFF_S = [1, 2, 4, 8];
/** When the READS fall, simulated from the ruling alone: a claim at second t reads iff t is at least the previous read's
 *  second plus the wait for the reads so far. D21-fix (review I1) adds the one rule the schedule cannot have alone: once
 *  the peer's deadline has passed (`deadlineS` from its join, which these tests make second 0), a STARTING camera's verdict
 *  is never the basis of an answer, so the wait shrinks to the first step - `afterDeadline: false` for a verdict the rule
 *  does not apply to (an unreadable report). */
function ruledReads(claimSeconds: number[], opts: { afterDeadline: boolean } = { afterDeadline: true }): number[] {
  const deadlineS = CAMERA_EVIDENCE_DEADLINE_MS / 1_000;
  const reads: number[] = [];
  let last = -Infinity;
  for (const t of claimSeconds) {
    const wait = opts.afterDeadline && t >= deadlineS ? RULING_BACKOFF_S[0]! : RULING_BACKOFF_S[Math.min(reads.length, RULING_BACKOFF_S.length) - 1]!;
    if (reads.length > 0 && t < last + wait) continue;
    reads.push(t);
    last = t;
  }
  return reads;
}

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
type Side = "home" | "away";

/** `held`: the participant id the caller's browser holds a token for (D21-fix-3, F1) - the room sends it with every claim. */
const claim = (s: Seeded, now = new Date(), side: Side = "home", video?: PreflightDeps["video"], held: string | null = null) =>
  seatPlayer({ fixtureId: s.fixtureId, personId: s[side].personId, heldParticipantId: held }, { now, ...(video ? { video } : {}) });
const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);
const tokenOf = (r: SeatResult) => ("participant" in r ? r.participant : null);

/** The first claim mints the participant and hands back its token; the browser joins with it (a new PEER whose report
 *  shows `camera`). Returns the participant id and the real instant after the join (its PEER_JOINING stamp is at or before
 *  it, so a simulated `now` of after + t is never less than t past the join). */
async function joinWith(s: Seeded, camera: FixtureCamera, side: Side = "home"): Promise<{ pid: string; after: number }> {
  const first = await claim(s, new Date(), side);
  expect(reasonOf(first), "premise: nobody has joined yet").toBe("camera_required");
  const pid = tokenOf(first)?.participantId;
  expect(pid, "premise: the refusal carries the caller's own token").toBeTruthy();
  fx.setLivePublisher(pid!, true, { camera });
  return { pid: pid!, after: Date.now() };
}

const calledRoute = (route: string) => fx.calls.filter((c) => c.route === route).length;
/** One READ of a participant's camera begins with the live-session request — and only a read makes it. */
const evidenceReads = () => calledRoute("GET /meetings/:id/active-session");
const tokenRefreshes = () => calledRoute("POST /meetings/:id/participants/:pid/token");

async function cacheRow(s: Seeded, side: Side = "home") {
  const [row] = await sql<{ reads: number; at: Date | null; state: string | null; since: Date | null }[]>`
    select seat_reads as reads, seat_read_at as at, seat_read_state as state, seat_read_since as since
      from fixture_video_participants where fixture_id = ${s.fixtureId} and person_id = ${s[side].personId} and preset = 'player'`;
  return row!;
}

describe.skipIf(!DB)("the evidence cache: a starting camera is read on the back-off schedule, not on every claim (D21)", () => {
  it("THE HAMMER: a claim every second for 30 s on a camera that never reports reads the vendor on the ruling's schedule inside the deadline, and at most once a second after it — and answers the same either side of a read", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    const before = { reads: evidenceReads(), refreshes: tokenRefreshes() };
    const seconds = Array.from({ length: 31 }, (_, t) => t);
    const answers: string[] = [];
    // The browser joined with the token its first claim was handed, and sends that participant's id with every claim.
    for (const t of seconds) answers.push(reasonOf(await claim(s, new Date(after + t * 1_000), "home", undefined, pid)));
    const reads = evidenceReads() - before.reads;
    const deadlineS = CAMERA_EVIDENCE_DEADLINE_MS / 1_000;
    const want = ruledReads(seconds);
    expect(want.filter((t) => t < deadlineS), "premise: inside the deadline the ruling's schedule is 0, 1, 3, 7").toEqual([0, 1, 3, 7]);
    expect(want.filter((t) => t >= deadlineS), "premise: past it every claim reads (a refusal is a fresh answer), at most once a second").toEqual(
      seconds.filter((t) => t >= deadlineS),
    );
    expect(reads, "evidence reads the FIXTURE saw").toBe(want.length);
    // The differential the cache exists for, where it applies: the 15 claims inside the deadline made 4 reads, not 15.
    const insideDeadline = want.filter((t) => t < deadlineS).length;
    expect(insideDeadline, "…against the 15 a once-a-second poll would have made inside the deadline").toBeLessThan(deadlineS / 3);
    // D21-fix-3 (F1): a browser that already holds the token its camera joined with is handed none while the camera is still
    // starting - the 15 claims inside the wait cost reads (the schedule above) and not one token refresh. The refusal past
    // the deadline carries a token (the way in for a retry), so those claims - and only those - cost one each.
    expect(
      tokenRefreshes() - before.refreshes,
      "a claim answered camera_starting costs no token for a browser that holds one; the refusals past the wait cost one each",
    ).toBe(seconds.filter((t) => t >= deadlineS).length);
    // Answers: starting inside the wait, the camera refusal past it - on a cached claim exactly as on a read (no flapping).
    expect(answers).toEqual(seconds.map((t) => (t < deadlineS ? "camera_starting" : "camera_required")));
  });

  it("the cache lives in the participant's row: the reads so far, when, and what the last one found", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "pending");
    expect(await cacheRow(s), "premise: the first claim saw nobody, so nothing is cached").toMatchObject({ reads: 0, at: null, state: null, since: null });
    await claim(s, new Date(after));
    const row = await cacheRow(s);
    expect(row.reads).toBe(1);
    expect(row.at?.getTime()).toBe(after);
    expect(row.state).toBe("starting");
    expect(row.since, "the peer's own join time, which the deadline runs from").not.toBeNull();
    expect(row.since!.getTime()).toBeLessThanOrEqual(after);
  });

  it("DEFINITE verdicts are never cached: on, off, blocked and absent re-read at once — twice in a row, counted per camera", async () => {
    const cases: { camera: FixtureCamera | "never_joined"; want: string }[] = [
      { camera: "on", want: "seated" },
      { camera: "off", want: "camera_required" },
      { camera: "denied", want: "camera_blocked" },
      { camera: "never_joined", want: "camera_required" },
    ];
    let checked = 0;
    for (const c of cases) {
      const s = await seed();
      if (c.camera !== "never_joined") await joinWith(s, c.camera);
      else expect(reasonOf(await claim(s))).toBe("camera_required"); // mints the participant; nobody joins
      const now = new Date();
      const reads0 = evidenceReads();
      const a = await claim(s, now);
      const b = await claim(s, now); // the SAME instant: a cache would answer this one without asking
      expect([reasonOf(a), reasonOf(b)], c.camera).toEqual([c.want, c.want]);
      expect(evidenceReads() - reads0, `${c.camera}: both claims read`).toBe(2);
      expect(await cacheRow(s), `${c.camera}: nothing cached`).toMatchObject({ reads: 0, at: null, state: null, since: null });
      checked += 1;
    }
    expect(checked, "anti-vacuity: every definite verdict").toBe(cases.length);
  });

  it("SEQUENCE: starting (cached), then the camera comes up — the NEXT read on the schedule seats it, and a seat is never cached after", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, new Date(after)))).toBe("camera_starting");
    const reads1 = evidenceReads();
    expect(reasonOf(await claim(s, new Date(after + 400))), "inside the first wait: answered from the cache").toBe("camera_starting");
    expect(evidenceReads(), "…with no vendor read").toBe(reads1);
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "on" }); // a reload with the camera allowed
    expect(reasonOf(await claim(s, new Date(after + 999))), "one millisecond short of the wait: still the cache").toBe("camera_starting");
    expect(reasonOf(await claim(s, new Date(after + 1_000))), "the wait is over: read, and seated").toBe("seated");
    expect(await cacheRow(s)).toMatchObject({ reads: 0, at: null, state: null, since: null });
    const reads2 = evidenceReads();
    expect(reasonOf(await claim(s, new Date(after + 1_001))), "seated is re-verified at once (T9's freshness check)").toBe("seated");
    expect(evidenceReads() - reads2).toBe(1);
  });

  it("SEQUENCE: seated, the camera goes off — camera_lost on the very next claim (a pass is never answered from the cache), and back on, seated", async () => {
    const s = await seed();
    const { pid, after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after)))).toBe("seated");
    fx.setPeerCamera(pid, "video_off");
    expect(reasonOf(await claim(s, new Date(after + 1)))).toBe("camera_lost");
    fx.setPeerCamera(pid, "video_on");
    expect(reasonOf(await claim(s, new Date(after + 2)))).toBe("seated");
  });

  it("each participant has their own cache: one player's starting camera never delays the other's first read", async () => {
    const s = await seed();
    const home = await joinWith(s, "pending", "home");
    const away = await joinWith(s, "on", "away");
    const now = new Date(Math.max(home.after, away.after));
    expect(reasonOf(await claim(s, now, "home"))).toBe("camera_starting");
    const reads = evidenceReads();
    expect(reasonOf(await claim(s, now, "away")), "away reads straight away").toBe("seated");
    expect(evidenceReads() - reads).toBe(1);
  });

  it("CONCURRENT claims for one starting camera at one instant make exactly ONE vendor read between them", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "pending");
    const reads0 = evidenceReads();
    const now = new Date(after);
    const answers = await Promise.all(Array.from({ length: 8 }, () => claim(s, now)));
    expect(answers.map(reasonOf)).toEqual(Array(8).fill("camera_starting"));
    expect(evidenceReads() - reads0, "eight claims, one read").toBe(1);
    expect((await cacheRow(s)).reads).toBe(1);
  });

  it("a stamp from the FUTURE (another machine's fast clock, or a clock stepped back) never blocks a read — the cache is bounded by the wait, not by the stamp", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "pending");
    await claim(s, new Date(after + 60_000)); // stamped a minute ahead
    const reads0 = evidenceReads();
    await claim(s, new Date(after)); // …and a claim whose clock is behind it
    expect(evidenceReads() - reads0, "read, not stuck behind the future stamp").toBe(1);
  });

  it("a peer-report OUTAGE is cached too: one read per step, video_unavailable past the deadline on every claim, and Sentry told once per READ — not per claim", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "on");
    fx.setPeerReportsUnavailable(true);
    const seconds = Array.from({ length: 31 }, (_, t) => t);
    const reads0 = evidenceReads();
    const answers: string[] = [];
    for (const t of seconds) answers.push(reasonOf(await claim(s, new Date(after + t * 1_000))));
    const deadlineS = CAMERA_EVIDENCE_DEADLINE_MS / 1_000;
    expect(answers).toEqual(seconds.map((t) => (t < deadlineS ? "camera_starting" : "video_unavailable")));
    const reads = ruledReads(seconds, { afterDeadline: false }); // an unreadable report is cached to the last step, by design
    expect(evidenceReads() - reads0).toBe(reads.length);
    const pastDeadlineReads = reads.filter((t) => t >= deadlineS).length;
    expect(pastDeadlineReads, "premise: two reads fall past the deadline (15 s, 23 s)").toBe(2);
    expect(vi.mocked(captureError), "an outage is reported once per read that finds it").toHaveBeenCalledTimes(pastDeadlineReads);
    expect((await sql`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId} and last_publisher_seen_at is not null`).length, "never stamped").toBe(0);
    fx.setPeerReportsUnavailable(false);
    expect(reasonOf(await claim(s, new Date(after + 31_000))), "the vendor recovers: the same camera seats").toBe("seated");
  });

  // The tests below run on ONE clock. The fixture stamps a peer's join with `new Date()`, so a deadline that has to have
  // PASSED (15 s) needs the clock to move; faking Date alone (not the timers the sockets and the database use) puts the
  // fixture's stamps and the seat's `now` on the same line, and nothing is stamped in the "future".
  async function onOneClock(): Promise<{ T: number; at: (s: number) => Date }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    const T = Date.now();
    vi.setSystemTime(T);
    return {
      T,
      at: (sec) => {
        vi.setSystemTime(T + sec * 1_000);
        return new Date(T + sec * 1_000);
      },
    };
  }

  it("D21-fix I1, THE PRODUCTION SEQUENCE: the camera never reported, a read past the deadline refuses - and a camera that comes up (a reload with it allowed) one second later seats on the NEXT claim", async () => {
    const { at } = await onOneClock();
    const s = await seed();
    const { pid } = await joinWith(s, "pending");
    const answers: string[] = [];
    for (const t of [0, 1, 3, 7, 15]) answers.push(reasonOf(await claim(s, at(t))));
    expect(answers, "premise: starting on the ruling's reads, then the camera refusal at 15 s").toEqual([
      "camera_starting",
      "camera_starting",
      "camera_starting",
      "camera_starting",
      "camera_required",
    ]);
    expect((await cacheRow(s)).reads, "premise: five reads so far, so the old schedule's next read was 8 s away (at 23 s)").toBe(5);
    at(16);
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "on" }); // the player allowed the camera and reloaded: a NEW peer, camera on
    const reads0 = evidenceReads();
    expect(reasonOf(await claim(s, at(17))), "the next claim seats").toBe("seated");
    expect(evidenceReads() - reads0, "…from a FRESH read, never from the refused peer's cache").toBe(1);
  });

  it("D21-fix I1: a reload that is still starting is judged by its OWN deadline, and its reads run the schedule again from the first step - not the old peer's eight-second wait", async () => {
    const { T, at } = await onOneClock();
    const s = await seed();
    const { pid } = await joinWith(s, "pending");
    for (const t of [0, 1, 3, 7, 15]) await claim(s, at(t));
    at(16);
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "pending" }); // a new peer at 16 s, nothing reported yet
    const reads0 = evidenceReads();
    const claims = [17, 18, 19, 20, 21, 22, 23, 24];
    const answers: string[] = [];
    for (const t of claims) answers.push(reasonOf(await claim(s, at(t))));
    expect(answers, "never the OLD peer's refusal: the new peer's own 15 s have barely begun").toEqual(Array(claims.length).fill("camera_starting"));
    // The reads fall as the schedule says for the NEW peer, counted from its first read at 17 s: 17, 18, 20, 24.
    const fromFirst = ruledReads(claims.map((t) => t - 17), { afterDeadline: false });
    expect(fromFirst, "premise: the ruling's schedule from the new peer's first read").toEqual([0, 1, 3, 7]);
    expect(evidenceReads() - reads0).toBe(fromFirst.length);
    expect((await cacheRow(s)).since!.getTime(), "the cache now remembers the NEW peer's join (16 s)").toBe(T + 16_000);
  });

  it("D21-fix I1: a refused player pressing Check in again reads AT MOST once a second past the deadline - two presses in the same second are one read", async () => {
    const { at } = await onOneClock();
    const s = await seed();
    await joinWith(s, "pending");
    for (const t of [0, 1, 3, 7, 15]) await claim(s, at(t));
    const reads0 = evidenceReads();
    const first = at(20);
    expect(reasonOf(await claim(s, first))).toBe("camera_required");
    expect(reasonOf(await claim(s, new Date(first.getTime() + 999))), "999 ms later: still the same read").toBe("camera_required");
    expect(evidenceReads() - reads0, "two presses, one read").toBe(1);
    expect(reasonOf(await claim(s, new Date(first.getTime() + 1_000))), "a second later: a fresh read").toBe("camera_required");
    expect(evidenceReads() - reads0).toBe(2);
  });

  it("a reload is a new peer: the cached verdict is replaced by the NEW peer's - judged from its own join, so its deadline starts afresh", async () => {
    const { T, at } = await onOneClock();
    const s = await seed();
    const { pid } = await joinWith(s, "pending");
    expect(reasonOf(await claim(s, at(0)))).toBe("camera_starting");
    expect(reasonOf(await claim(s, at(20))), "premise: past the first peer's deadline - a read says so").toBe("camera_required");
    at(21);
    fx.setLivePublisher(pid, false);
    fx.setLivePublisher(pid, true, { camera: "pending" }); // the reload: a new peer, nothing reported yet
    // On one clock, with no claim stamped ahead of another: this claim is allowed to read because the OLD peer's deadline
    // has passed (not because of a future stamp), finds the new peer half a second into ITS wait - starting.
    expect(reasonOf(await claim(s, at(21.5)))).toBe("camera_starting");
    expect((await cacheRow(s)).since!.getTime(), "the cache now remembers the NEW peer's join").toBe(T + 21_000);
  });

  it("D21-fix m5: a claim refused its read whose participant row is GONE (the board was re-paired, its meeting retired) is VIDEO_MEETING_REPLACED - not `camera_starting` for ever", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "pending");
    // The retire lands between the claim finding its participant and the claim for the read: a transaction holds the row,
    // the claim's UPDATE queues behind it (waited for, not slept for), and the transaction deletes the row and commits.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const retire = sql.begin(async (tx) => {
      await tx`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId} and preset = 'player' for update`;
      locked();
      await hold;
      await tx`delete from fixture_video_participants where fixture_id = ${s.fixtureId}`;
    });
    await isLocked;
    const outcome = claim(s, new Date(after)).then(
      (r) => ({ r }),
      (e: unknown) => ({ e }),
    );
    await vi.waitFor(async () => {
      const [w] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where wait_event_type = 'Lock' and pid <> pg_backend_pid() and query like '%set seat_read_at%'`;
      expect(w?.n, "premise: the claim's read slot is queued behind the retire").toBeGreaterThan(0);
    });
    release();
    await retire;
    expect(await outcome).toMatchObject({ e: { code: "VIDEO_MEETING_REPLACED" } });
    expect(await sql`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId}`, "premise: the row really is gone").toHaveLength(0);
  });
});

// ─── The call budget: a deferral at every request of a claim ──────────────────────────────────────────────────────
type Video = NonNullable<PreflightDeps["video"]>;
/** The real adapter, every request of which asks `budget` first. */
function metered(budget: () => Promise<boolean>): Video {
  return {
    ensureMeeting: (id) => ensureMeeting(id, { budget }),
    addParticipant: (a) => addParticipant(a, { budget }),
    seatCameraEvidence: (a) => seatCameraEvidence(a, { budget }),
    refreshParticipantToken: (a) => refreshParticipantToken(a, { budget }),
  };
}
/** A budget that refuses exactly the n-th request it is asked about (1-based) and grants every other. */
function refusingRequest(n: number): { budget: () => Promise<boolean>; asked: () => number } {
  let asked = 0;
  return {
    budget: async () => ++asked !== n,
    asked: () => asked,
  };
}
const grantAll = metered(async () => true);

describe.skipIf(!DB)("a deferral is `camera_starting`: at EVERY request of a claim, never `no camera`, never an outage (D21)", () => {
  // D21-fix-3 (F1): a fresh board's first claim makes TWO requests - create the meeting, add the participant - and no read
  // (a participant this very claim made cannot have been joined: nobody had its token), so a refusal of either leaves the
  // caller no token. A claim after the join asks the cache first and the vendor only when it may: the live session, its
  // participants, the peer report - and the token LAST, only once the verdict is in. A browser that holds no token (a
  // reload) is therefore handed none by a claim the budget cut short.
  const FIRST_CLAIM = [
    { n: 1, what: "create the meeting", token: false },
    { n: 2, what: "add the participant", token: false },
  ];
  const LATER_CLAIM = [
    { n: 1, what: "read the live session", token: false, verdictMade: false },
    { n: 2, what: "read the session participants", token: false, verdictMade: false },
    { n: 3, what: "read the peer report", token: false, verdictMade: false },
    { n: 4, what: "refresh the token (after the verdict)", token: false, verdictMade: true },
  ];

  it("a FIRST claim's whole cost is two requests - the meeting and the participant - and it reads nothing, whatever the camera (D21-fix-3, F1)", async () => {
    const s = await seed();
    const gate = refusingRequest(Number.MAX_SAFE_INTEGER);
    const got = await claim(s, new Date(), "home", metered(gate.budget));
    expect(reasonOf(got)).toBe("camera_required");
    expect(tokenOf(got)?.participantId, "the way in is handed").toBeTruthy();
    expect(gate.asked(), "create the meeting + add the participant").toBe(2);
    expect(evidenceReads(), "no read of the live session").toBe(0);
  });

  it("sweep, the FIRST claim: a refusal of each of its two requests answers camera_starting with no token (none was minted), and the retry says the truth", async () => {
    let checked = 0;
    for (const step of FIRST_CLAIM) {
      const s = await seed();
      const gate = refusingRequest(step.n);
      const got = await claim(s, new Date(), "home", metered(gate.budget));
      expect(reasonOf(got), `refused: ${step.what}`).toBe("camera_starting");
      expect(!!tokenOf(got), `refused: ${step.what} — token`).toBe(step.token);
      expect(gate.asked(), `refused: ${step.what} — the claim stopped at the refusal`).toBe(step.n);
      expect(vi.mocked(captureError), `${step.what}: a deferral is not an outage`).not.toHaveBeenCalled();
      // The retry, budget back, is the first claim it would have been: nobody has joined, so the camera is required.
      const retry = await claim(s, new Date(Date.now() + 1_500), "home", grantAll);
      expect(reasonOf(retry), `${step.what}: retried`).toBe("camera_required");
      expect(tokenOf(retry)?.participantId, `${step.what}: the retry carries a token to join with`).toBeTruthy();
      checked += 1;
    }
    expect(checked, "anti-vacuity: every request of the first claim").toBe(FIRST_CLAIM.length);
  });

  it("sweep, a LATER claim (a browser holding no token): a refusal of each of its four requests answers camera_starting with no token - counted in the log, once - and the retry seats the player", async () => {
    // D22: the load test counts the platform's deferrals from this line (a deferral is otherwise invisible: the request
    // is never made, the player is told "starting"), so a claim the budget refused leaves exactly one, and a granted one none.
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const deferrals = () => info.mock.calls.filter((c) => /RealtimeKit call budget spent; the seat answered camera_starting/.test(String(c[1]))).length;
    let checked = 0;
    for (const step of LATER_CLAIM) {
      const s = await seed();
      const { after } = await joinWith(s, "on");
      const before = deferrals();
      const gate = refusingRequest(step.n);
      const got = await claim(s, new Date(after), "home", metered(gate.budget));
      expect(deferrals() - before, `refused: ${step.what} - logged once`).toBe(1);
      expect(reasonOf(got), `refused: ${step.what}`).toBe("camera_starting");
      expect(!!tokenOf(got), `refused: ${step.what} — token`).toBe(step.token);
      expect(gate.asked()).toBe(step.n);
      expect(vi.mocked(captureError), `${step.what}: not an outage`).not.toHaveBeenCalled();
      // A refused READ finds nothing, so stamps nothing. The refused token (n=4) comes after a read that did find the camera on:
      // that pass is on file - a verdict the budget cost nobody - and the retry seats on a read of its own all the same.
      expect(
        await sql`select 1 from fixture_video_participants where fixture_id = ${s.fixtureId} and last_publisher_seen_at is not null`,
        `${step.what}: stamped exactly when the verdict was made`,
      ).toHaveLength(step.verdictMade ? 1 : 0);
      const retry = await claim(s, new Date(after + 1_000), "home", grantAll);
      expect(reasonOf(retry), `${step.what}: the camera was on all along`).toBe("seated");
      expect(deferrals() - before, `${step.what}: the granted retry logged nothing more`).toBe(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every request of a later claim").toBe(LATER_CLAIM.length);
  });

  it("a refused request makes NO vendor call: the fixture saw only the requests before it", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "on");
    const seen = fx.calls.length;
    await claim(s, new Date(after), "home", metered(refusingRequest(2).budget)); // session read granted, participants read refused
    expect(fx.calls.length - seen, "one request made (the session read), the refused one not").toBe(1);
  });

  it("a deferral is never `camera_required` / `camera_lost` / `video_unavailable`, even for a player who HAD passed and past every deadline", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "on");
    expect(reasonOf(await claim(s, new Date(after)))).toBe("seated"); // a pass on file
    const got = await claim(s, new Date(after + 10 * CAMERA_EVIDENCE_DEADLINE_MS), "home", metered(async () => false));
    expect(reasonOf(got)).toBe("camera_starting");
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("a refused read does not cache a verdict it never made: the claim after the wait reads the vendor", async () => {
    const s = await seed();
    const { after } = await joinWith(s, "on");
    await claim(s, new Date(after), "home", metered(refusingRequest(2).budget));
    const reads0 = evidenceReads();
    expect(reasonOf(await claim(s, new Date(after + 1_000), "home", grantAll))).toBe("seated");
    expect(evidenceReads() - reads0).toBe(1);
  });

  it("OPTIONAL cameras never block a seat on a deferral: seated with no tile (like an outage, but nobody is told it is one)", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const tileLost = () => info.mock.calls.filter((c) => /optional camera seated with no tile/.test(String(c[1]))).length;
    let checked = 0;
    for (const n of [1, 2]) {
      const s = await seed("optional");
      const got = await claim(s, new Date(), "home", metered(refusingRequest(n).budget));
      expect(got, `request ${n} refused`).toEqual({ seated: true, participant: null, cameraRetry: true });
      expect(vi.mocked(captureError), `request ${n}: a deferral is not an outage`).not.toHaveBeenCalled();
      // D21-fix m2: the lost tile is counted in the log. (D21-fix-3: and the seat says so - `cameraRetry` - so the room asks again.)
      expect(tileLost(), `request ${n}: the lost tile is logged, once`).toBe(checked + 1);
      checked += 1;
    }
    // The pair: granted, an optional seat carries its token - and logs nothing.
    const s = await seed("optional");
    expect(tokenOf(await claim(s, new Date(), "home", grantAll))?.participantId).toBeTruthy();
    expect(tileLost(), "a granted optional seat loses no tile").toBe(2);
    expect(checked).toBe(2);
  });

  it("the deferral is the adapter's RealtimeKitDeferred — the seat turns it into an answer; nothing else escapes", async () => {
    const s = await seed();
    await expect(ensureMeeting(s.fixtureId, { budget: async () => false })).rejects.toBeInstanceOf(RealtimeKitDeferred);
    await expect(claim(s, new Date(), "home", metered(async () => false))).resolves.toMatchObject({ seated: false, reason: "camera_starting" });
  });
});

// ─── Thirty boards ───────────────────────────────────────────────────────────────────────────────────────────────
// The scenario the budget exists for: a club's round opens and thirty boards — sixty players — check in. Driven through the
// REAL seat and adapter against the fixture vendor, with a REAL database bucket on a SIMULATED clock (the bucket's `at`
// seam), so five minutes of check-in take seconds. Every player is a small model of the room: claim, join when handed a
// token, re-ask on the room's own schedule, press the check-in button again when its polls run out.
describe.skipIf(!DB)("thirty boards check in: the vendor's account limit is never reached (D21)", () => {
  const BOARDS = 30;
  type Player = {
    s: Seeded;
    side: Side;
    pid: string | null;
    joined: boolean;
    polls: number;
    nextAt: number; // simulated ms
    seated: boolean;
    claims: number;
  };

  async function run(arrivalMs: (i: number) => number, opts: { horizonMs: number }) {
    const key = `test|thirty|${randomUUID()}`;
    const base = Date.now(); // the boards were opened five minutes before it (seed)
    let simNow = base;
    const grants: number[] = []; // simulated ms of every request the bucket let through
    let refusals = 0;
    const budget = async () => {
      const ok = await takeRealtimeKitCall(key, { at: new Date(simNow) });
      if (ok) grants.push(simNow);
      else refusals += 1;
      return ok;
    };
    const video = metered(budget);
    const boards: Seeded[] = [];
    for (let i = 0; i < BOARDS; i += 1) boards.push(await seed());
    const players: Player[] = boards.flatMap((s, b) =>
      (["home", "away"] as const).map((side, k) => ({
        s, side, pid: null, joined: false, polls: 0, seated: false, claims: 0,
        nextAt: base + arrivalMs(b * 2 + k),
      })),
    );
    const reasons = new Map<string, number>();
    const STEP = 250;
    try {
      for (let t = base; t <= base + opts.horizonMs && players.some((p) => !p.seated); t += STEP) {
        simNow = t;
        for (const p of players) {
          if (p.seated || p.nextAt > t) continue;
          // The room's server clock for this claim is the simulated one; the fixture stamps peers on the REAL clock, so the
          // seat's wait (judged from the peer's join) is only ever shorter than real — never a spurious deadline.
          // Like the real room: the id of the participant whose token the browser holds goes with every claim (D21-fix-3).
          const got = await seatPlayer(
            { fixtureId: p.s.fixtureId, personId: p.s[p.side].personId, heldParticipantId: p.pid },
            { now: new Date(t - 0), video },
          );
          p.claims += 1;
          const reason = reasonOf(got);
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          const token = tokenOf(got);
          if (token && p.pid === null) p.pid = token.participantId;
          if (reason === "seated") {
            p.seated = true;
          } else if (reason === "camera_required" && token) {
            // Handed a token: join with the camera on, and the room's own presence retry re-asks 1.5 s later.
            if (!p.joined) {
              fx.setLivePublisher(token.participantId, true, { camera: "on" });
              p.joined = true;
            }
            p.nextAt = t + 1_500;
          } else if (reason === "camera_starting") {
            // The room re-asks on the schedule; its polls run out, and the player presses the check-in button again.
            p.polls += 1;
            if (p.polls >= CAMERA_EVIDENCE_MAX_POLLS) {
              p.polls = 0;
              p.nextAt = t + cameraEvidenceDelayMs(1);
            } else p.nextAt = t + cameraEvidenceDelayMs(p.polls);
          } else {
            p.nextAt = t + 1_500;
          }
        }
      }
    } finally {
      /* the DB bucket row is the test's own key */
      await sql`delete from realtimekit_call_budget where key = ${key}`;
    }
    // The busiest closed five minutes the vendor saw, from the requests the bucket let through (it is the vendor's meter).
    let worst = 0;
    for (let lo = 0, hi = 0; lo < grants.length; lo += 1) {
      while (hi < grants.length && grants[hi]! <= grants[lo]! + RTK_BUDGET_WINDOW_MS) hi += 1;
      worst = Math.max(worst, hi - lo);
    }
    // `D21_REPORT=<file>` appends the measurement a reviewer asks for to that file (D22 reads the same numbers off the wire).
    if (process.env.D21_REPORT) {
      const lastSeat = Math.max(...players.map((p) => p.claims));
      appendFileSync(
        process.env.D21_REPORT,
        `[D21 thirty boards] players=${players.length} seated=${players.filter((p) => p.seated).length} requests=${grants.length} refused=${refusals} ` +
          `busiest5min=${worst} (ceiling ${RTK_CALLS_PER_WINDOW}, vendor ${RTK_VENDOR_LIMIT_PER_WINDOW}) claims/player max=${lastSeat} ` +
          `reasons=${JSON.stringify(Object.fromEntries(reasons))} simSpanS=${Math.round((Math.max(...grants) - Math.min(...grants)) / 1000)}\n`,
      );
    }
    return { players, grants, refusals, worst, reasons, ends: players.map((p) => p.claims) };
  }

  it("staggered over five minutes (the realistic round): every player seated, not one request deferred, and the busiest five minutes well inside the vendor's limit", async () => {
    const r = await run((i) => i * 5_000, { horizonMs: 12 * 60_000 });
    expect(r.players.length, "anti-vacuity: sixty players").toBe(BOARDS * 2);
    expect(r.players.filter((p) => p.seated).length, "everyone seated").toBe(BOARDS * 2);
    expect(r.refusals, "the bucket never had to say no").toBe(0);
    expect(r.grants.length, "anti-vacuity: the vendor was called").toBeGreaterThan(BOARDS * 2);
    expect(r.worst, "the busiest closed five minutes, in vendor requests").toBeLessThanOrEqual(RTK_CALLS_PER_WINDOW);
    expect(r.worst).toBeLessThan(RTK_VENDOR_LIMIT_PER_WINDOW);
    expect([...r.reasons.keys()].sort(), "no claim was ever told anything but the way in").toEqual(["camera_required", "seated"]);
  }, 300_000);

  it("ALL sixty in the same second (the worst case): the vendor's limit is still never reached, nobody is told their camera or the video is at fault, and everyone gets in", async () => {
    const r = await run(() => 0, { horizonMs: 12 * 60_000 });
    expect(r.players.filter((p) => p.seated).length, "everyone seated in the end").toBe(BOARDS * 2);
    expect(r.refusals, "premise: the burst really was more than the bucket's burst — requests were deferred").toBeGreaterThan(0);
    expect(r.worst, "the busiest closed five minutes, in vendor requests").toBeLessThanOrEqual(RTK_CALLS_PER_WINDOW);
    const wrong = [...r.reasons.keys()].filter((k) => !["camera_required", "camera_starting", "seated"].includes(k));
    expect(wrong, "never camera_lost / camera_blocked / video_unavailable / anything else").toEqual([]);
    expect(r.reasons.get("camera_starting") ?? 0, "deferred claims answered `camera_starting`").toBeGreaterThan(0);
  }, 600_000);
});
