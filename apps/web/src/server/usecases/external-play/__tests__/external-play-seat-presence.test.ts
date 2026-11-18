// Check-in capacity plan 2, Task 6 - the one-read proof at the seat (spec 2026-11-05 §6.3; owner rulings R4 and 2026-11-17).
//
// With EXTERNAL_PLAY_PRESENCE_PROOF=1 the seat's camera read is ONE peer-report call for the peer the presence table names (plan 1's
// webhook rows), not the three-call session read. The browser's own camera report only SCHEDULES (it skips the 1.5 s first-read wait,
// and it starts the counted fallback's clock); it never seats anyone. A peer the vendor says has LEFT (a lost leave webhook) is never
// judged on its last camera events: the claim takes the departed-peer fallback and the player is seated only on a peer found there.
//
// Driven end to end: the REAL seat, the REAL adapter and the fixture vendor in process (e2e/realtimekit-fixture-server.ts) whose
// webhooks are delivered straight to the REAL receiver (plan 1 Task 9's wiring), so presence is written by the producer production
// has. Vendor calls are counted at the FIXTURE (`fx.calls`), never from the code under test; expected answers are the rulings'.
//
// CLOCKS: the fixture stamps joins on the wall clock, so a presence row's `received_at` is real; the claims run on a synthetic `now`
// (deps.now) built from the instants under test. A first-live stamp, a token stamp and a read row's trust window are all on `now`.
//
// Anti-vacuity (TEST-STRATEGY.md): every sweep reports how many items it checked and zero is a failure. Chess-only (single-sport
// reason: online play is `onlinePlay = 'lichess'` on `boardgame`; no other sport holds a RealtimeKit meeting).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { CAMERA_EVIDENCE_DEADLINE_MS } from "@/components/public-site/match-room/room-snapshot";
import {
  RETIRED_PAIR,
  addParticipant,
  currentBudgetKey,
  endMeeting,
  ensureMeeting,
  peerReportCamera,
  refreshParticipantToken,
  seatCameraEvidence,
} from "@/server/external-play/video/realtimekit";
import { applyPresenceEvent, currentPresence } from "@/server/external-play/video/presence";
import { receiveRealtimeKitWebhook } from "@/server/external-play/video/webhook";
import type { RealtimeKitEvent } from "@/server/external-play/video/webhook-event";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type FixtureCamera,
  type RealtimeKitFixtureServer,
} from "../../../../../e2e/realtimekit-fixture-server";
import { openRound } from "../open-round";
import { reportOwnCamera } from "../camera-report";
import {
  FIRST_READ_AFTER_JOIN_MS,
  PRESENCE_FALLBACK_MS,
  SEAT_RECHECK_TRUST_MS,
  presenceFallbackCount,
  seatPlayer,
  seatReadCalls,
  stayMintOf,
  type PreflightDeps,
  type SeatResult,
} from "../preflight";
import { clearBucket, seedBoard, setBucket, type Board, type Side } from "../../__tests__/_external-play-line";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture, seedOnlineChessRound } from "../../__tests__/_external-play-seed";

const DB = !!process.env.DATABASE_URL;
const SEC = 1_000;
const MIN = 60_000;

// An outage the seat absorbs is reported to Sentry (reportOutage): nothing is sent from a test.
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

// The invite mail seam of the one test that re-opens a round (_invite-mail.ts): the invite is rendered, queued and sent after commit
// through the outbox's network seam, replaced here. `fail` names recipients the provider refuses (so nobody is bound to the open).
const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});

let fx: RealtimeKitFixtureServer;
let bucketKey: string | null = null;
const uuidsMade: string[] = [];
const fixturesMade: string[] = [];

beforeAll(async () => {
  if (!DB) return;
  // In-process delivery straight to the REAL receiver: a non-200 receipt rejects, so the fixture records it as failed.
  fx = await startRealtimeKitFixtureServer(0, {
    webhooks: async (w) => {
      const r = await receiveRealtimeKitWebhook({ rawBody: w.body, signature: w.signature, uuid: w.uuid }, { publicKey: async () => ({ key: fx.publicKeyPem, fetched: true }) });
      if (r.status !== 200) throw new Error(`receiver answered ${r.status}`);
    },
  });
});

beforeEach(async () => {
  if (!DB) return;
  await fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
  // The bucket the check-in line orders claims by is keyed by this base: fund it so nothing is held.
  bucketKey = currentBudgetKey();
  if (bucketKey === null) throw new Error("RealtimeKit is not configured after the env stubs");
  // This file owns its bucket (the key is its fixture's port): a stay an earlier test left must not make the line ACTIVE for this one.
  await sql`delete from fixture_seat_line where budget_key = ${bucketKey}`;
  await setBucket(bucketKey, 100_000, new Date(Date.now() + 3_600_000));
  mail.sent.length = 0;
  mail.fail.clear();
});

afterEach(async () => {
  if (!DB) return;
  await fx.webhooksSettled();
  uuidsMade.push(...fx.webhooks.map((w) => w.uuid));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (!DB) return;
  await fx.close();
  if (bucketKey !== null) await clearBucket(bucketKey);
  if (uuidsMade.length > 0) await sql`delete from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`;
  if (fixturesMade.length > 0) {
    await sql`delete from realtimekit_ended_sessions where meeting_id in (select meeting_id from fixture_video_presence where fixture_id in ${sql(fixturesMade)})`;
    await sql`delete from fixture_video_presence where fixture_id in ${sql(fixturesMade)}`;
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);
const tokenOf = (r: SeatResult) => ("participant" in r ? r.participant : null) ?? null;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

const ROUTE = {
  peerReport: "GET /sessions/peer-report/:peer",
  activeSession: "GET /meetings/:id/active-session",
  participants: "GET /sessions/:id/participants",
  token: "POST /meetings/:id/participants/:pid/token",
  addParticipant: "POST /meetings/:id/participants",
  createMeeting: "POST /meetings",
} as const;
const countSince = (mark: number, route: string) => fx.calls.slice(mark).filter((c) => c.route === route).length;
/** The three READ routes a camera verdict can spend, as `[peer report, active session, session participants]`. */
const readsSince = (mark: number) => [countSince(mark, ROUTE.peerReport), countSince(mark, ROUTE.activeSession), countSince(mark, ROUTE.participants)];
const noReads = [0, 0, 0];

type Arrival = { b: Board; side: Side; personId: string; pid: string; meetingId: string };
const who = (a: Arrival) => ({ meetingId: a.meetingId, participantId: a.pid, customParticipantId: a.personId });

/** A required-camera board's player through the seat's own door: the first claim (mints the participant, answers the way in with the
 *  token), then the browser joins with it (`join`), its join webhook delivered unless `fx.setWebhooksDown(true)` was set first. */
async function arrive(o: { camera?: FixtureCamera; join?: boolean; at?: Date; board?: Board; side?: Side } = {}): Promise<Arrival> {
  const b = o.board ?? (await seedBoard());
  fixturesMade.push(b.fixtureId);
  const side = o.side ?? "home";
  const personId = b[side].personId;
  const first = await seatPlayer({ fixtureId: b.fixtureId, personId }, { now: o.at ?? new Date() });
  expect(reasonOf(first), "premise: the first claim mints the participant and answers the way in").toBe("camera_required");
  const pid = tokenOf(first)?.participantId;
  expect(pid, "premise: the refusal carries the caller's own token").toBeTruthy();
  const [m] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${b.fixtureId} and side = ${side}`;
  if (o.join !== false) {
    fx.setLivePublisher(pid!, true, o.camera === undefined ? undefined : { camera: o.camera });
    await fx.webhooksSettled();
  }
  return { b, side, personId, pid: pid!, meetingId: m!.meeting_id };
}

/** The player's next claim, on `now`, from the browser that holds the participant's token (unless `held` says otherwise). */
const claim = (a: Arrival, now: Date, over: { held?: string | null; recheck?: boolean; video?: PreflightDeps["video"] } = {}) =>
  seatPlayer(
    { fixtureId: a.b.fixtureId, personId: a.personId, heldParticipantId: over.held === undefined ? a.pid : over.held, ...(over.recheck ? { recheck: true } : {}) },
    { now, ...(over.video ? { video: over.video } : {}) },
  );

/** The page's camera report (the player's own browser), on `now`. */
const report = (a: Arrival, state: "live" | "off", now: Date, heartbeat = false) =>
  reportOwnCamera({ kind: "session", userId: a.b[a.side].userId }, a.b.fixtureId, { state, heartbeat }, { now, publish: async () => {} });

/** The instant a presence row's `since` is: the vendor's join, bounded by our own receipt (finding 13). */
async function sinceOf(a: Arrival): Promise<Date> {
  const p = await currentPresence(sql, who(a));
  if (!p) throw new Error("premise: the player has no presence on file");
  return new Date(Math.min(p.joinedAt.getTime(), p.receivedAt.getTime()));
}

type ParticipantRow = {
  token_issued_at: Date | null;
  presence_fallback_from: Date | null;
  camera_live_first_at: Date | null;
  last_publisher_seen_at: Date | null;
  seat_reads: number;
  seat_read_state: string | null;
  seat_read_since: Date | null;
};
const rowOf = async (pid: string) =>
  (
    await sql<ParticipantRow[]>`
      select token_issued_at, presence_fallback_from, camera_live_first_at, last_publisher_seen_at, seat_reads, seat_read_state, seat_read_since
        from fixture_video_participants where participant_id = ${pid}`
  )[0]!;

const warnings = () => vi.spyOn(log, "warn").mockImplementation(() => undefined);
const seatWarnings = (spy: ReturnType<typeof warnings>) =>
  spy.mock.calls.filter((c) => typeof c[1] === "string" && (c[1] as string).startsWith("seat:")).map((c) => c[0] as { kind?: string; fixtureId?: string; meetingId?: string });

const joinedEv = (o: { meetingId: string; peerId: string; custom: string; joinedAt: Date }): RealtimeKitEvent => ({
  kind: "joined",
  event: "meeting.participantJoined",
  meetingId: o.meetingId,
  sessionId: "sess-injected",
  peerId: o.peerId,
  customParticipantId: o.custom,
  joinedAt: o.joinedAt,
});
const leftEv = (o: { meetingId: string; peerId: string; custom: string; joinedAt: Date; leftAt: Date }): RealtimeKitEvent => ({
  kind: "left",
  event: "meeting.participantLeft",
  meetingId: o.meetingId,
  sessionId: "sess-injected",
  peerId: o.peerId,
  customParticipantId: o.custom,
  joinedAt: o.joinedAt,
  leftAt: o.leftAt,
});

/** The real adapter as the seat's `video` seam, with `over` replacing parts of it. */
const realVideo = (over: Partial<NonNullable<PreflightDeps["video"]>> = {}): NonNullable<PreflightDeps["video"]> => ({
  ensureMeeting,
  addParticipant,
  seatCameraEvidence,
  peerReportCamera,
  refreshParticipantToken,
  ...over,
});

// ─── The one-read proof ──────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("the one-read proof", () => {
  it("the numbers are the rulings': 1.5 s, 10 s, and one call a read with the flag on (three off)", () => {
    expect(FIRST_READ_AFTER_JOIN_MS).toBe(1_500);
    expect(PRESENCE_FALLBACK_MS).toBe(10_000);
    expect(seatReadCalls(), "flag on").toBe(1);
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    expect(seatReadCalls(), "flag unset").toBe(3);
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "true");
    expect(seatReadCalls(), "only the exact value 1 turns it on").toBe(3);
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "0");
    expect(seatReadCalls(), "0 is off").toBe(3);
  });

  it("a joined player with the camera on is seated after ONE vendor read (the peer report), no session reads, and the seat's token", async () => {
    const a = await arrive();
    const since = await sinceOf(a);
    const fallbacks = presenceFallbackCount();
    const mark = fx.calls.length;
    const now = at(since, FIRST_READ_AFTER_JOIN_MS);
    const r = await claim(a, now);
    expect(reasonOf(r)).toBe("seated");
    expect(readsSince(mark), "[peer report, active session, session participants]").toEqual([1, 0, 0]);
    expect(countSince(mark, ROUTE.token), "the seated answer hands the caller's token").toBe(1);
    expect(tokenOf(r)?.participantId).toBe(a.pid);
    expect(presenceFallbackCount() - fallbacks, "no fallback").toBe(0);
    expect((await rowOf(a.pid)).last_publisher_seen_at?.getTime(), "the seat stamps the pass").toBe(now.getTime());
  });

  it("two claims racing on a joined player make ONE peer-report read between them (the read slot), and the loser answers from the cache", async () => {
    const a = await arrive();
    const since = await sinceOf(a);
    const mark = fx.calls.length;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = 0;
    // The winner's read is held until the loser has answered: the loser cannot run after the winner finished and find the slot free.
    const video = realVideo({
      peerReportCamera: async (id, deps) => {
        reading++;
        await gate;
        return peerReportCamera(id, deps);
      },
    });
    const now = at(since, FIRST_READ_AFTER_JOIN_MS);
    const p1 = claim(a, now, { video });
    const p2 = claim(a, now, { video });
    const first = await Promise.race([p1, p2]);
    expect(reasonOf(first), "the first to answer is the one refused the read slot").toBe("camera_starting");
    expect(reading, "exactly one claim is reading").toBe(1);
    release();
    const both = await Promise.all([p1, p2]);
    expect(both.map(reasonOf).sort()).toEqual(["camera_starting", "seated"]);
    expect(readsSince(mark), "one peer-report call in all").toEqual([1, 0, 0]);
  });

  it("no presence yet, browser silent: camera_required with ZERO read calls (the answer still hands the token)", async () => {
    const a = await arrive({ join: false });
    const fallbacks = presenceFallbackCount();
    const mark = fx.calls.length;
    const r = await claim(a, new Date());
    expect(reasonOf(r)).toBe("camera_required");
    expect(readsSince(mark)).toEqual(noReads);
    expect(tokenOf(r)?.participantId, "a refused camera carries the token").toBe(a.pid);
    expect(presenceFallbackCount() - fallbacks).toBe(0);
    // and again, ten seconds later and a minute later: still no browser word, still no read
    for (const ms of [11 * SEC, 61 * SEC]) {
      expect(reasonOf(await claim(a, at(new Date(), ms)))).toBe("camera_required");
    }
    expect(readsSince(mark), "three claims, no read").toEqual(noReads);
    expect(presenceFallbackCount() - fallbacks).toBe(0);
  });

  it("a participant whose token_issued_at is null (a row from before V531), the browser reporting live for 30 s: camera_required with ZERO read calls and no fallback; the answer carries a token and stamps it. With the stamp present the same report DOES run the clock", async () => {
    const a = await arrive({ join: false });
    await sql`update fixture_video_participants set token_issued_at = null where participant_id = ${a.pid}`;
    const T0 = new Date();
    await report(a, "live", T0);
    await report(a, "live", at(T0, 15 * SEC), true);
    const fallbacks = presenceFallbackCount();
    const mark = fx.calls.length;
    const now = at(T0, 30 * SEC);
    const r = await claim(a, now);
    expect(reasonOf(r)).toBe("camera_required");
    expect(readsSince(mark), "no read, no fallback").toEqual(noReads);
    expect(presenceFallbackCount() - fallbacks).toBe(0);
    expect(countSince(mark, ROUTE.token), "the answer hands a refreshed token").toBe(1);
    expect(tokenOf(r)?.participantId).toBe(a.pid);
    expect((await rowOf(a.pid)).token_issued_at?.getTime(), "and stamps it").toBe(now.getTime());
    // the positive pair: the stamp is now on file, so the very same report starts the clock - from the token, not from the first live
    const early = await claim(a, at(now, 5 * SEC));
    expect(reasonOf(early), "5 s after the token").toBe("camera_starting");
    expect(readsSince(mark)).toEqual(noReads);
    const late = await claim(a, at(now, PRESENCE_FALLBACK_MS));
    expect(reasonOf(late), "10 s after the token the fallback ran, found nobody in the room").toBe("camera_required");
    expect(presenceFallbackCount() - fallbacks, "and counted").toBe(1);
  });

  it("presence younger than 1.5 s and no live report: camera_starting with zero calls; 1.5 s later the read is made. A live report skips the wait", async () => {
    const a = await arrive();
    const since = await sinceOf(a);
    const mark = fx.calls.length;
    const early = await claim(a, at(since, FIRST_READ_AFTER_JOIN_MS - 1));
    expect(reasonOf(early), "one ms inside the wait").toBe("camera_starting");
    expect(tokenOf(early), "a browser that holds the token is handed none").toBeNull();
    expect(readsSince(mark), "no call").toEqual(noReads);
    expect(countSince(mark, ROUTE.token)).toBe(0);
    const ready = await claim(a, at(since, FIRST_READ_AFTER_JOIN_MS));
    expect(reasonOf(ready), "at 1.5 s").toBe("seated");
    expect(readsSince(mark)).toEqual([1, 0, 0]);

    // the browser's own live report means the camera is running: the wait is skipped, and the verdict is still the vendor's
    const b = await arrive();
    const sinceB = await sinceOf(b);
    await report(b, "live", sinceB);
    const markB = fx.calls.length;
    const skipped = await claim(b, at(sinceB, 100));
    expect(reasonOf(skipped), "100 ms after the join, with a live report").toBe("seated");
    expect(readsSince(markB), "one read").toEqual([1, 0, 0]);
    // the negative of that: a live report with the camera OFF at the vendor is still camera_required (the report schedules, never seats)
    const c = await arrive({ camera: "off" });
    const sinceC = await sinceOf(c);
    await report(c, "live", sinceC);
    expect(reasonOf(await claim(c, at(sinceC, 100))), "the browser says live, the vendor says off: the vendor decides").toBe("camera_required");
  });

  it("a joined_at in the FUTURE (the vendor's clock ahead) with received_at = our now: camera_starting, no read, until 1.5 s have passed on OUR clock", async () => {
    fx.setWebhooksDown(true); // the row below is the only presence; the fixture would otherwise deliver its own
    const a = await arrive();
    const peer = fx.currentPeer(a.pid)!;
    const received = new Date();
    await applyPresenceEvent(sql, joinedEv({ meetingId: a.meetingId, peerId: peer, custom: a.personId, joinedAt: at(received, MIN) }), received);
    expect((await currentPresence(sql, who(a)))?.joinedAt.getTime(), "premise: the vendor says it joined a minute from now").toBe(at(received, MIN).getTime());
    const mark = fx.calls.length;
    for (const ms of [0, 500, FIRST_READ_AFTER_JOIN_MS - 1]) {
      expect(reasonOf(await claim(a, at(received, ms))), `+${ms} ms`).toBe("camera_starting");
    }
    expect(readsSince(mark), "no read while our own clock says it just joined").toEqual(noReads);
    expect(reasonOf(await claim(a, at(received, FIRST_READ_AFTER_JOIN_MS)))).toBe("seated");
    expect(readsSince(mark)).toEqual([1, 0, 0]);
  });

  it("the camera off at the vendor: camera_required / camera_lost from one call; denied: camera_blocked from one call", async () => {
    let checked = 0;
    const off = await arrive({ camera: "off" });
    const sinceOff = await sinceOf(off);
    let mark = fx.calls.length;
    expect(reasonOf(await claim(off, at(sinceOff, FIRST_READ_AFTER_JOIN_MS)))).toBe("camera_required");
    expect(readsSince(mark)).toEqual([1, 0, 0]);
    checked++;

    const denied = await arrive({ camera: "denied" });
    const sinceDenied = await sinceOf(denied);
    mark = fx.calls.length;
    expect(reasonOf(await claim(denied, at(sinceDenied, FIRST_READ_AFTER_JOIN_MS)))).toBe("camera_blocked");
    expect(readsSince(mark)).toEqual([1, 0, 0]);
    checked++;

    // had passed, then the camera went off: lost, not required
    const lost = await arrive();
    const sinceLost = await sinceOf(lost);
    expect(reasonOf(await claim(lost, at(sinceLost, FIRST_READ_AFTER_JOIN_MS)))).toBe("seated");
    fx.setPeerCamera(lost.pid, "video_off");
    mark = fx.calls.length;
    expect(reasonOf(await claim(lost, at(sinceLost, 3 * SEC)))).toBe("camera_lost");
    expect(readsSince(mark)).toEqual([1, 0, 0]);
    checked++;
    expect(checked, "anti-vacuity: three answers").toBe(3);
  });

  it("a report the vendor has not produced yet (none) is camera_starting from the peer's join, then camera_required past the deadline; an unreadable one is waited out, then the outage", async () => {
    const none = await arrive({ camera: "none" });
    const sinceNone = await sinceOf(none);
    expect(reasonOf(await claim(none, at(sinceNone, FIRST_READ_AFTER_JOIN_MS)))).toBe("camera_starting");
    expect(reasonOf(await claim(none, at(sinceNone, CAMERA_EVIDENCE_DEADLINE_MS + 1)))).toBe("camera_required");

    const down = await arrive();
    const sinceDown = await sinceOf(down);
    fx.setPeerReportsUnavailable(true);
    expect(reasonOf(await claim(down, at(sinceDown, FIRST_READ_AFTER_JOIN_MS)))).toBe("camera_starting");
    expect(reasonOf(await claim(down, at(sinceDown, CAMERA_EVIDENCE_DEADLINE_MS + 1))), "past the deadline an unreadable report is an outage, never a seat").toBe("video_unavailable");
  });

  describe("the no-presence fallback (webhooks down)", () => {
    it("token handed, browser reports live: T0+9 s camera_starting with zero calls; T0+10 s the three-call read seats the player; counter +1, a READ presence row, the log line", async () => {
      fx.setWebhooksDown(true);
      const spy = warnings();
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;

      const early = await claim(a, at(T0, 9 * SEC));
      expect(reasonOf(early)).toBe("camera_starting");
      expect(readsSince(mark), "nine seconds in: no call").toEqual(noReads);
      expect(presenceFallbackCount() - fallbacks).toBe(0);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "the clock started at the first live report").toBe(T0.getTime());

      const now = at(T0, PRESENCE_FALLBACK_MS);
      const r = await claim(a, now);
      expect(reasonOf(r), "ten seconds in: the fallback read finds the peer and its camera").toBe("seated");
      expect(readsSince(mark), "the three-call session read").toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks, "counted").toBe(1);
      const row = await currentPresence(sql, { ...who(a), now });
      expect(row, "the peer it found is on file").toMatchObject({ peerId: fx.currentPeer(a.pid), source: "read" });
      expect(seatWarnings(spy), "one warning, of the no-presence kind, naming the board and the room").toEqual([{ meetingId: a.meetingId, fixtureId: a.b.fixtureId, kind: "no_presence" }]);
    });

    it("the fallback clock starts at the FIRST live report, not the latest heartbeat: token at T0-1 s, live at T0, a live heartbeat at T0+30 s, a claim at T0+31 s falls back", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      await report(a, "live", at(T0, 30 * SEC), true);
      const stored = await rowOf(a.pid);
      expect({ first: stored.camera_live_first_at?.getTime() }, "premise: the writer kept the first receipt through the heartbeat").toEqual({ first: T0.getTime() });
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      const r = await claim(a, at(T0, 31 * SEC));
      expect(reasonOf(r), "read from the latest heartbeat (1 s old) this would be camera_starting").toBe("seated");
      expect(readsSince(mark)).toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks).toBe(1);
    });

    it("a reload mid-check-in restarts the 10 s: the new page is handed a token (camera_starting, no read), and its next claims run the clock from THAT token's stamp", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;

      // the page reloads at T0+6 s: it holds no token, so its first claim is answered with one
      const reload = at(T0, 6 * SEC);
      const first = await claim(a, reload, { held: null });
      expect(reasonOf(first)).toBe("camera_starting");
      expect(tokenOf(first)?.participantId, "the new page is handed the token").toBe(a.pid);
      expect(readsSince(mark), "no read for a page that cannot be in the room yet").toEqual(noReads);
      expect((await rowOf(a.pid)).token_issued_at?.getTime(), "stamped").toBe(reload.getTime());

      // 12 s after the FIRST live report, but 6 s after the token this page holds: still waiting
      expect(reasonOf(await claim(a, at(T0, 12 * SEC)))).toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "the clock is the token's stamp, not the first live report").toBe(reload.getTime());
      expect(presenceFallbackCount() - fallbacks).toBe(0);
      // and 10 s after the token it falls back
      expect(reasonOf(await claim(a, at(reload, PRESENCE_FALLBACK_MS)))).toBe("seated");
      expect(readsSince(mark)).toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks).toBe(1);
    });

    it("a fresh live report with a NULL camera_live_first_at (a seat already live at the V531 deploy): the clock starts at now - camera_starting, zero calls - and the fallback only 10 s later", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -30 * SEC) });
      await report(a, "live", at(T0, -20 * SEC));
      await sql`update fixture_video_participants set camera_live_first_at = null where participant_id = ${a.pid}`;
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      expect(reasonOf(await claim(a, T0)), "no stamp to start from: a run starting now").toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime()).toBe(T0.getTime());
      expect(reasonOf(await claim(a, at(T0, PRESENCE_FALLBACK_MS - 1)))).toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect(reasonOf(await claim(a, at(T0, PRESENCE_FALLBACK_MS)))).toBe("seated");
      expect(presenceFallbackCount() - fallbacks).toBe(1);
    });

    it("two claims racing at T0+10 s: ONE fallback read between them (three calls at the fixture, counter 1); the loser answers from the cache", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;

      // The winner's read is HELD until the loser has answered, so the loser cannot run after the winner finished (which would read as
      // "the slot was free again" and make a second read).
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reading = 0;
      const video = realVideo({
        seatCameraEvidence: async (x) => {
          reading++;
          await gate;
          return seatCameraEvidence(x);
        },
      });
      const now = at(T0, PRESENCE_FALLBACK_MS);
      const p1 = claim(a, now, { video });
      const p2 = claim(a, now, { video });
      const first = await Promise.race([p1.then((r) => ({ n: 1, r })), p2.then((r) => ({ n: 2, r }))]);
      expect(reasonOf(first.r), "the first to answer is the one that was refused the read slot").toBe("camera_starting");
      expect(reading, "exactly one claim is reading").toBe(1);
      release();
      const both = await Promise.all([p1, p2]);
      expect(both.map(reasonOf).sort(), "one seated, one answered from the cache").toEqual(["camera_starting", "seated"]);
      expect(reading, "one session read in all").toBe(1);
      expect(readsSince(mark), "three calls at the fixture").toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks, "one fallback").toBe(1);
    });

    it("presence arriving clears the fallback clock, and the next silent stretch starts from the browser's NEW live run (a real off -> on through the report writer)", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      expect(reasonOf(await claim(a, at(T0, 5 * SEC)))).toBe("camera_starting");
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "premise: a clock is running").toBe(T0.getTime());

      // The join webhook finally lands: presence is on file, the clock is cleared, and the one read seats
      const peer = fx.currentPeer(a.pid)!;
      const joined = new Date();
      await applyPresenceEvent(sql, joinedEv({ meetingId: a.meetingId, peerId: peer, custom: a.personId, joinedAt: joined }), joined);
      expect(reasonOf(await claim(a, at(T0, 8 * SEC)))).toBe("seated");
      expect((await rowOf(a.pid)).presence_fallback_from, "cleared by the presence claim").toBeNull();

      // The peer leaves (the leave webhook lands); the page's camera goes off and comes back on: the REAL writer drops the first-live stamp
      // on the off and stamps the new run on the live
      await applyPresenceEvent(sql, leftEv({ meetingId: a.meetingId, peerId: peer, custom: a.personId, joinedAt: joined, leftAt: new Date() }), new Date());
      await report(a, "off", at(T0, 20 * SEC));
      const reLive = at(T0, 24 * SEC);
      await report(a, "live", reLive);
      expect((await rowOf(a.pid)).camera_live_first_at?.getTime(), "premise: the writer stamped the NEW run").toBe(reLive.getTime());
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      const later = at(T0, 25 * SEC); // 25 s after the old clock started: it would fall back at once if it had been kept
      expect(reasonOf(await claim(a, later)), "a new silent stretch starts its own 10 s, from the new live run").toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect(presenceFallbackCount() - fallbacks).toBe(0);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "the new clock is the new run's first receipt").toBe(reLive.getTime());
    });

    it("presence clears the clock even when the report names no first-live receipt to restart from (a live row from before V531, whose stamp is NULL): the next stretch starts at its own claim", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      expect(reasonOf(await claim(a, at(T0, 5 * SEC)))).toBe("camera_starting");
      const peer = fx.currentPeer(a.pid)!;
      const joined = new Date();
      await applyPresenceEvent(sql, joinedEv({ meetingId: a.meetingId, peerId: peer, custom: a.personId, joinedAt: joined }), joined);
      expect(reasonOf(await claim(a, at(T0, 8 * SEC)))).toBe("seated");
      await applyPresenceEvent(sql, leftEv({ meetingId: a.meetingId, peerId: peer, custom: a.personId, joinedAt: joined, leftAt: new Date() }), new Date());
      // The writer cannot make this shape any more (every live receipt stamps), so it is written by hand: it is what a row live at the V531
      // deploy looks like until its next report.
      await sql`update fixture_video_participants set camera_live_first_at = null where participant_id = ${a.pid}`;
      const later = at(T0, 25 * SEC);
      const mark = fx.calls.length;
      expect(reasonOf(await claim(a, later)), "a kept clock would fall back at once").toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "the new clock").toBe(later.getTime());
    });

    it("an off -> on BETWEEN two claims restarts the clock: the new run's first receipt is in the clock, a live heartbeat after it moves nothing, and the fallback fires 10 s after the NEW run", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      expect(reasonOf(await claim(a, at(T0, 5 * SEC)))).toBe("camera_starting");
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime(), "premise: the first run's clock is stored").toBe(T0.getTime());
      // No claim sees the camera off: the writer's stamp is the only thing that knows
      await report(a, "off", at(T0, 6 * SEC));
      const second = at(T0, 20 * SEC);
      await report(a, "live", second);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      expect(reasonOf(await claim(a, at(T0, 21 * SEC))), "21 s after the FIRST run, 1 s after the new one").toBe("camera_starting");
      expect(readsSince(mark), "no call: the stored clock was moved forward to the new run").toEqual(noReads);
      expect((await rowOf(a.pid)).presence_fallback_from?.getTime()).toBe(second.getTime());
      // A heartbeat of the new run moves nothing
      await report(a, "live", at(T0, 25 * SEC), true);
      expect((await rowOf(a.pid)).camera_live_first_at?.getTime(), "premise: the heartbeat kept the run's first receipt").toBe(second.getTime());
      expect(reasonOf(await claim(a, at(T0, 29 * SEC))), "9 s after the new run, however fresh the heartbeat").toBe("camera_starting");
      expect(readsSince(mark)).toEqual(noReads);
      expect(reasonOf(await claim(a, at(second, PRESENCE_FALLBACK_MS))), "10 s after the new run: the fallback").toBe("seated");
      expect(readsSince(mark)).toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks).toBe(1);
    });

    it("a camera that is not reported live clears the clock and never falls back, however long the page has held a token", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const a = await arrive({ at: at(T0, -SEC) });
      await report(a, "live", T0);
      expect(reasonOf(await claim(a, at(T0, 5 * SEC)))).toBe("camera_starting");
      expect((await rowOf(a.pid)).presence_fallback_from, "premise: running").not.toBeNull();
      await report(a, "off", at(T0, 6 * SEC));
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      expect(reasonOf(await claim(a, at(T0, 20 * SEC))), "the browser says off: nobody can be publishing").toBe("camera_required");
      expect(readsSince(mark)).toEqual(noReads);
      expect((await rowOf(a.pid)).presence_fallback_from, "cleared").toBeNull();
      expect(presenceFallbackCount() - fallbacks).toBe(0);
    });
  });

  describe("the T9 re-verify on the no-presence branch (webhooks down)", () => {
    it("create-game's re-verify of a player the FALLBACK seated, once the read row has expired: no presence, the clock long elapsed - it judges as the holder would (one three-call read, counted, seated), and hands no token", async () => {
      fx.setWebhooksDown(true);
      const T0 = new Date();
      const board = await seedBoard();
      const p1 = await arrive({ board, side: "home", at: at(T0, -SEC) });
      const p2 = await arrive({ board, side: "away", at: at(T0, -SEC) });
      await report(p1, "live", T0);
      await report(p2, "live", at(T0, 12 * SEC));
      // P1 is seated by the fallback at T0+10 s; P2 seats a little later by its own
      expect(reasonOf(await claim(p1, at(T0, PRESENCE_FALLBACK_MS))), "premise: P1 seated by the fallback").toBe("seated");
      const p2Seated = at(T0, 12 * SEC + PRESENCE_FALLBACK_MS);
      expect(reasonOf(await claim(p2, p2Seated)), "premise: P2 seated by the fallback").toBe("seated");

      // The game is created now: its re-verify asks about P1 with no browser behind it (no held participant)
      const verifyAt = p2Seated;
      expect(await currentPresence(sql, { ...who(p1), now: verifyAt }), "premise: P1's read row has expired (no presence)").toBeNull();
      const stored = await rowOf(p1.pid);
      expect(verifyAt.getTime() - stored.last_publisher_seen_at!.getTime(), "premise: outside SEAT_RECHECK_TRUST_MS, so the pass is not trusted").toBeGreaterThan(SEAT_RECHECK_TRUST_MS);
      expect(verifyAt.getTime() - stored.presence_fallback_from!.getTime(), "premise: the clock has long elapsed").toBeGreaterThan(PRESENCE_FALLBACK_MS);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      const verified = await claim(p1, verifyAt, { recheck: true, held: null });
      expect(reasonOf(verified), "a recheck has no browser: it judges as the holder would, so it reads and is seated").toBe("seated");
      expect(readsSince(mark), "the three-call read").toEqual([1, 1, 1]);
      expect(presenceFallbackCount() - fallbacks, "counted").toBe(1);
      expect(countSince(mark, ROUTE.token), "and no token").toBe(0);
      expect(tokenOf(verified)).toBeNull();
    });
  });

  describe("a reload with webhooks UP (finding 6)", () => {
    it("a live camera seated through presence, then the page reloads (old peer left, the old tab's live report still fresh): the new page's first claim does NOT fall back; once it joins ONE peer-report read seats it", async () => {
      const a = await arrive();
      const since = await sinceOf(a);
      await report(a, "live", since);
      await report(a, "live", at(since, 15 * SEC), true);
      expect(reasonOf(await claim(a, at(since, FIRST_READ_AFTER_JOIN_MS)))).toBe("seated");

      // The reload: the old peer leaves (its leave webhook is delivered), the old tab's live report is 10 s old
      fx.setLivePublisher(a.pid, false);
      await fx.webhooksSettled();
      expect(await currentPresence(sql, who(a)), "premise: no peer is on file").toBeNull();
      const R = at(since, 25 * SEC);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;

      // The new page has no token: its first claim is answered with one, and reads nothing (the literal 10 s clock, 25 s after the first
      // live report, would have read the session here)
      const first = await claim(a, R, { held: null });
      expect(reasonOf(first)).toBe("camera_starting");
      expect(tokenOf(first)?.participantId).toBe(a.pid);
      expect(readsSince(mark), "no fallback before the page has joined").toEqual(noReads);
      expect(presenceFallbackCount() - fallbacks).toBe(0);

      // The new page joins (a new session: the old one ended with its last peer) and its join webhook is delivered
      fx.setLivePublisher(a.pid, true);
      await fx.webhooksSettled();
      expect((await currentPresence(sql, who(a)))?.peerId, "premise: the new peer is on file").toBe(fx.currentPeer(a.pid));
      const seat = await claim(a, at(R, 2 * SEC));
      expect(reasonOf(seat)).toBe("seated");
      expect(readsSince(mark), "ONE peer-report read, no session read since the reload").toEqual([1, 0, 0]);
      expect(countSince(mark, ROUTE.token), "the first claim's token and the seat's").toBe(2);
      expect(presenceFallbackCount() - fallbacks).toBe(0);
    });
  });

  describe("a departed peer: the leave webhook was LOST (owner ruling R4)", () => {
    it("a peer that left with its participantLeft lost: the claim reads the report, sees left_at, takes the departed-peer fallback, and the player is NOT seated (camera_lost); counter +1, kind departed_peer", async () => {
      const a = await arrive();
      const since = await sinceOf(a);
      const seatedAt = at(since, FIRST_READ_AFTER_JOIN_MS);
      expect(reasonOf(await claim(a, seatedAt)), "premise: seated through the webhook row").toBe("seated");
      const passedAt = (await rowOf(a.pid)).last_publisher_seen_at;
      fx.setWebhooksDown(true);
      fx.setLivePublisher(a.pid, false); // the peer leaves; the vendor's report now carries left_at, and nobody tells us
      expect((await currentPresence(sql, who(a)))?.peerId, "premise: the webhook row is still the newest open one").toBeTruthy();
      const spy = warnings();
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      const r = await claim(a, at(seatedAt, 3 * SEC));
      expect(reasonOf(r), "the departed peer's last camera events (on) are never judged").toBe("camera_lost");
      expect(readsSince(mark), "the report (left), then the session read finds nobody").toEqual([1, 1, 0]);
      expect(presenceFallbackCount() - fallbacks).toBe(1);
      expect(seatWarnings(spy), "the warning names the kind").toEqual([{ meetingId: a.meetingId, fixtureId: a.b.fixtureId, kind: "departed_peer" }]);
      expect((await rowOf(a.pid)).last_publisher_seen_at?.getTime(), "no new pass was stamped").toBe(passedAt?.getTime());
    });

    it("R4 + the reload: the player came back on a NEW peer whose join webhook was also lost: the fallback finds the new peer, records it (source 'read'), and seats from that read", async () => {
      const a = await arrive();
      const since = await sinceOf(a);
      const seatedAt = at(since, FIRST_READ_AFTER_JOIN_MS);
      expect(reasonOf(await claim(a, seatedAt))).toBe("seated");
      const oldPeer = fx.currentPeer(a.pid)!;
      fx.setWebhooksDown(true);
      fx.setLivePublisher(a.pid, false);
      fx.setLivePublisher(a.pid, true); // a new session, a new row, a new peer - and no webhook for either
      const newPeer = fx.currentPeer(a.pid)!;
      expect(newPeer, "premise: a different peer").not.toBe(oldPeer);
      const fallbacks = presenceFallbackCount();
      const mark = fx.calls.length;
      const now = at(seatedAt, 3 * SEC);
      expect(reasonOf(await claim(a, now))).toBe("seated");
      expect(readsSince(mark), "peer report (old: left), active session, participants, peer report (new: on)").toEqual([2, 1, 1]);
      expect(presenceFallbackCount() - fallbacks).toBe(1);
      expect(await currentPresence(sql, { ...who(a), now }), "the new peer is on file as a read").toMatchObject({ peerId: newPeer, source: "read" });
    });

    it("plan 1 finding 3, the fallback-then-leave sequence: a fallback seats the player (a read row), the peer then leaves with its leave lost, and the next claim is NOT seated - inside the read row's 10 s AND after it", async () => {
      let checked = 0;
      for (const afterTrust of [false, true]) {
        fx.setWebhooksDown(true);
        const T0 = new Date();
        const a = await arrive({ at: at(T0, -SEC) });
        await report(a, "live", T0);
        const fallbacks = presenceFallbackCount();
        const fell = at(T0, PRESENCE_FALLBACK_MS);
        expect(reasonOf(await claim(a, fell)), `premise: the fallback seats (afterTrust ${afterTrust})`).toBe("seated");
        expect(presenceFallbackCount() - fallbacks).toBe(1);
        fx.setLivePublisher(a.pid, false); // the peer leaves; the leave webhook is lost (webhooks are down)
        const mark = fx.calls.length;
        // inside the read row's trust window (3 s after it was written) or after it (the row's hint is spent: no presence)
        const now = afterTrust ? at(fell, 10 * SEC) : at(fell, 3 * SEC);
        const r = await claim(a, now);
        expect(reasonOf(r), `not seated (afterTrust ${afterTrust})`).toBe("camera_lost");
        expect(presenceFallbackCount() - fallbacks, `a second counted fallback (afterTrust ${afterTrust})`).toBe(2);
        expect(readsSince(mark)[2], "and the fallback never found a peer to read").toBe(0);
        checked++;
        fx.setWebhooksDown(false);
      }
      expect(checked, "anti-vacuity: both windows").toBe(2);
    });

    it("a budget that refuses the departed-peer fallback's session read is camera_starting and is NOT counted as a fallback (no request was made)", async () => {
      const a = await arrive();
      const since = await sinceOf(a);
      expect(reasonOf(await claim(a, at(since, FIRST_READ_AFTER_JOIN_MS)))).toBe("seated");
      fx.setWebhooksDown(true);
      fx.setLivePublisher(a.pid, false);
      const fallbacks = presenceFallbackCount();
      const video = realVideo({ seatCameraEvidence: (x) => seatCameraEvidence(x, { budget: async () => false }) });
      const mark = fx.calls.length;
      const r = await claim(a, at(since, 4 * SEC), { video });
      expect(reasonOf(r)).toBe("camera_starting");
      expect(countSince(mark, ROUTE.activeSession), "the session read was never requested").toBe(0);
      expect(presenceFallbackCount() - fallbacks, "not counted").toBe(0);
      // and a refused ONE read is camera_starting too, with no read made and nothing counted
      fx.setWebhooksDown(false);
      const b = await arrive();
      const sinceB = await sinceOf(b);
      const refused = realVideo({ peerReportCamera: (id) => peerReportCamera(id, { budget: async () => false }) });
      const markB = fx.calls.length;
      expect(reasonOf(await claim(b, at(sinceB, FIRST_READ_AFTER_JOIN_MS), { video: refused }))).toBe("camera_starting");
      expect(readsSince(markB)).toEqual(noReads);
    });
  });

  it("the T9 re-verify (recheck) costs one call outside SEAT_RECHECK_TRUST_MS, none inside it - and hands no token either way", async () => {
    const a = await arrive();
    const since = await sinceOf(a);
    const passedAt = at(since, FIRST_READ_AFTER_JOIN_MS);
    expect(reasonOf(await claim(a, passedAt))).toBe("seated");
    let mark = fx.calls.length;
    const inside = await claim(a, at(passedAt, SEAT_RECHECK_TRUST_MS - SEC), { recheck: true });
    expect(reasonOf(inside)).toBe("seated");
    expect(fx.calls.length - mark, "no vendor call at all inside the trust window").toBe(0);
    mark = fx.calls.length;
    const outside = await claim(a, at(passedAt, SEAT_RECHECK_TRUST_MS + SEC), { recheck: true });
    expect(reasonOf(outside)).toBe("seated");
    expect(readsSince(mark), "one peer-report read").toEqual([1, 0, 0]);
    expect(countSince(mark, ROUTE.token), "and no token").toBe(0);
    expect(tokenOf(outside)).toBeNull();
  });

  it("flag unset: today's three reads, the presence table untouched", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    const a = await arrive();
    await fx.webhooksSettled();
    const fallbacks = presenceFallbackCount();
    const mark = fx.calls.length;
    const r = await claim(a, new Date());
    expect(reasonOf(r)).toBe("seated");
    expect(readsSince(mark), "[peer report, active session, session participants]: the session read").toEqual([1, 1, 1]);
    expect(presenceFallbackCount() - fallbacks, "no proof, no fallback").toBe(0);
    const [rows] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_video_presence where meeting_id = ${a.meetingId} and source = 'read'`;
    expect(rows!.n, "nothing written to presence by a flag-off seat").toBe(0);
  });
});

// ─── The re-open keeps a room and its participant: no stale proof carries into the new window (batch-3 review m2) ──────────────

describe.skipIf(!DB)("a re-open that KEEPS a room resets its participants' per-window proof", () => {
  /** A participant's per-window proof columns, and the browser's own report beside them, as the SQL sees them. */
  const proofOf = async (pid: string) =>
    (
      await sql<(ParticipantRow & { camera_reported: string | null; camera_reported_at: Date | null })[]>`
        select token_issued_at, presence_fallback_from, camera_live_first_at, last_publisher_seen_at, seat_reads, seat_read_state, seat_read_since,
               camera_reported, camera_reported_at
          from fixture_video_participants where participant_id = ${pid}`
    )[0]!;

  it("SEQUENCE: claim -> seated -> re-open (the room is KEPT) -> claim again with the kept participant: nothing of the earlier window's proof stands (no recheck pass, camera_required not camera_lost, no clock, no read cache)", async () => {
    stubOutboxEnv();
    const r = await seedOnlineChessRound({ fixtures: 2, cameraPolicy: "required" });
    const [b, game] = r.boards;
    fixturesMade.push(b!.fixtureId, game!.fixtureId);
    const end = (id: string) => endMeeting(id);
    // The first open sends nothing (every send refused), so nobody is bound to it and the second open re-stamps the window.
    mail.fail.add(b!.home.email).add(b!.away.email).add(game!.home.email).add(game!.away.email);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: end })).toMatchObject({ opened: true, invited: 0 });

    // Window one: both of board one's players claim, join and are seated through presence; the home page reports live
    const boardOf = (x: NonNullable<typeof b>): Board => ({ fixtureId: x.fixtureId, orgId: r.orgId, home: x.home, away: x.away }) as unknown as Board;
    const home = await arrive({ board: boardOf(b!), side: "home" });
    const away = await arrive({ board: boardOf(b!), side: "away" });
    for (const p of [home, away]) {
      const since = await sinceOf(p);
      expect(reasonOf(await claim(p, at(since, FIRST_READ_AFTER_JOIN_MS))), `premise: ${p.side} seated in window one`).toBe("seated");
    }
    // A second board in the round whose room a GAME stands behind: spared by the re-open, so it must be left exactly as it was
    const g = await arrive({ board: boardOf(game!) });
    await sql`insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, challenge_id) values (${g.b.fixtureId}, ${r.orgId}, now(), ${"lichess-game-" + randomUUID().slice(0, 6)})
              on conflict (fixture_id) do update set challenge_id = excluded.challenge_id`;
    // What a long window leaves on a participant, written by hand (the seat's columns the re-open owes a reset, and the page's, which it does not). HOME keeps seat_reads = 0 so a
    // stale pass would be TRUSTED by a re-verify (the behavioural witness below); AWAY carries an outstanding read cache.
    const heavy = (pid: string, reads: number) => sql`
      update fixture_video_participants
         set seat_reads = ${reads}, seat_read_at = ${reads > 0 ? sql`now()` : null}, seat_read_state = ${reads > 0 ? "starting" : null}, seat_read_since = ${reads > 0 ? sql`now()` : null},
             camera_reported = 'live', camera_reported_at = now(), camera_live_first_at = now() - interval '5 minutes',
             presence_fallback_from = now() - interval '5 minutes', last_publisher_seen_at = now()
       where participant_id = ${pid}`;
    await heavy(home.pid, 0);
    await heavy(away.pid, 3);
    await heavy(g.pid, 3);
    const beforeHome = await proofOf(home.pid);
    const beforeAway = await proofOf(away.pid);
    const gameBefore = await proofOf(g.pid);
    expect(beforeHome.last_publisher_seen_at, "premise: the pass is on file").not.toBeNull();
    expect(beforeAway.seat_reads, "premise: a read cache is outstanding").toBe(3);
    mail.fail.clear();

    // The re-open: nobody was invited, so the window restarts. The current pairing's rooms are KEPT, and so are their participants.
    const mark = fx.calls.length;
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: end })).toMatchObject({ opened: true });
    const audit = await sql<{ type: string }[]>`
      select type from competition_events where competition_id = ${r.competitionId} and type like 'external_play.round_%' order by created_at, id`;
    expect(audit.map((x) => x.type), "premise: the second open was a RE-OPEN").toEqual(["external_play.round_opened", "external_play.round_reopened"]);
    const [kept] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${home.b.fixtureId} and side = 'home'`;
    expect(kept?.meeting_id, "the room was KEPT").toBe(home.meetingId);
    expect(countSince(mark, ROUTE.createMeeting), "and nothing was made").toBe(0);

    // Each kept participant carries nothing of window one's PROOF; the report and the token are the page's, not the window's
    const cleared = { last_publisher_seen_at: null, seat_reads: 0, seat_read_state: null, seat_read_since: null, presence_fallback_from: null };
    const proofColumns = (x: Awaited<ReturnType<typeof proofOf>>) => ({
      last_publisher_seen_at: x.last_publisher_seen_at,
      seat_reads: x.seat_reads,
      seat_read_state: x.seat_read_state,
      seat_read_since: x.seat_read_since,
      presence_fallback_from: x.presence_fallback_from,
    });
    let reset = 0;
    for (const [label, pid, was] of [["home", home.pid, beforeHome], ["away", away.pid, beforeAway]] as const) {
      const after = await proofOf(pid);
      expect(proofColumns(after), `${label}: per-window state reset`).toEqual(cleared);
      expect(after.token_issued_at?.getTime(), `${label}: the page's token is still the page's`).toBe(was.token_issued_at?.getTime());
      expect(
        { state: after.camera_reported, at: after.camera_reported_at?.getTime(), firstLive: after.camera_live_first_at?.getTime() },
        `${label}: the browser's own report (and since when) is not a window's proof`,
      ).toEqual({ state: was.camera_reported, at: was.camera_reported_at?.getTime(), firstLive: was.camera_live_first_at?.getTime() });
      reset++;
    }
    expect(reset, "anti-vacuity: both kept participants").toBe(2);
    // A room kept for a GAME is not reset: a re-open never reaches a board a game stands behind
    expect(await proofOf(g.pid), "the game board's participant is left exactly as it was").toEqual(gameBefore);

    // Window two, behaviour. The camera has since gone off at the vendor. Nothing carried over means a re-verify inside the old pass's 10 s is
    // read afresh (not trusted), and a player's claim is camera_required, never the camera_lost an earlier pass would have made it.
    fx.setPeerCamera(home.pid, "video_off");
    const recheck = await claim(home, new Date(), { recheck: true });
    expect(reasonOf(recheck), "the earlier window's pass is NOT trusted by the re-verify").toBe("camera_required");
    const next = await claim(home, new Date());
    expect(reasonOf(next), "never `camera_lost`: this window has no earlier pass").toBe("camera_required");
  });

  it("SEQUENCE on the NO-presence branch (webhooks down): the re-open keeps the page's columns (first-live stamp, token stamp, a live report), so the new window's first claim finds the fallback clock already elapsed - it cannot SEAT on them: one counted fallback read judges the camera as it is now, and a second claim reads nothing more", async () => {
    fx.setWebhooksDown(true);
    stubOutboxEnv();
    const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "required" });
    const b = r.boards[0]!;
    fixturesMade.push(b.fixtureId);
    const end = (id: string) => endMeeting(id);
    mail.fail.add(b.home.email).add(b.away.email);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: end })).toMatchObject({ opened: true, invited: 0 });

    // Window one: the join webhook is lost, so the fallback seats the player 10 s after the browser's first live report
    const T0 = new Date();
    const board: Board = { fixtureId: b.fixtureId, orgId: r.orgId, home: b.home, away: b.away } as unknown as Board;
    const home = await arrive({ board, side: "home", at: at(T0, -SEC) });
    await report(home, "live", T0);
    expect(reasonOf(await claim(home, at(T0, PRESENCE_FALLBACK_MS))), "premise: seated by the fallback in window one").toBe("seated");
    mail.fail.clear();

    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: end })).toMatchObject({ opened: true });
    const [kept] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${home.b.fixtureId} and side = 'home'`;
    expect(kept?.meeting_id, "premise: the room was KEPT by the re-open").toBe(home.meetingId);
    const stored = await rowOf(home.pid);
    expect(
      { pass: stored.last_publisher_seen_at, reads: stored.seat_reads, clock: stored.presence_fallback_from },
      "premise: the seat's own per-window state was reset",
    ).toEqual({ pass: null, reads: 0, clock: null });
    expect(stored.camera_live_first_at?.getTime(), "premise: the page's first-live stamp from window one is KEPT").toBe(T0.getTime());
    expect(stored.token_issued_at, "premise: and so is its token stamp").not.toBeNull();

    // Window two: the camera died between the windows. Nothing at the vendor shows it on; the kept stamps say the clock started long ago.
    fx.setPeerCamera(home.pid, "video_off");
    const t = at(T0, 30 * SEC);
    expect(await currentPresence(sql, { ...who(home), now: t }), "premise: window one's read row has expired - no presence").toBeNull();
    const fallbacks = presenceFallbackCount();
    const mark = fx.calls.length;
    const first = await claim(home, t);
    expect(reasonOf(first), "the kept stamps cannot seat: the vendor's own read says the camera is off, and this window has no earlier pass").toBe("camera_required");
    expect(readsSince(mark), "ONE three-call read").toEqual([1, 1, 1]);
    expect(presenceFallbackCount() - fallbacks, "one counted fallback").toBe(1);
    const second = await claim(home, at(t, SEC));
    expect(reasonOf(second), "and still not seated").not.toBe("seated");
    expect([countSince(mark, ROUTE.activeSession), countSince(mark, ROUTE.participants)], "no second session read").toEqual([1, 1]);
    expect(presenceFallbackCount() - fallbacks, "nothing more counted").toBe(1);

    // Positive pair: the camera comes back on, and the very same kept stamps seat it - from the vendor's read, not from the stamps
    fx.setPeerCamera(home.pid, "video_on");
    const back = await claim(home, at(t, 12 * SEC));
    expect(reasonOf(back), "the vendor's read of the camera now").toBe("seated");
    expect(presenceFallbackCount() - fallbacks, "one more counted fallback, and no more").toBe(2);
  });
});

// ─── stayMintOf ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("stayMintOf", () => {
  async function board(): Promise<Board> {
    const b = await seedBoard();
    fixturesMade.push(b.fixtureId);
    return b;
  }
  const stampRoom = (fixtureId: string, side: Side, stamp: "unadopted" | "retired") =>
    stamp === "unadopted"
      ? sql`update fixture_video_meetings set home_entrant_id = null, away_entrant_id = null where fixture_id = ${fixtureId} and side = ${side}`
      : sql`update fixture_video_meetings set home_entrant_id = ${RETIRED_PAIR}, away_entrant_id = ${RETIRED_PAIR} where fixture_id = ${fixtureId} and side = ${side}`;
  const ask = (b: Board, side: Side) => ({ fixtureId: b.fixtureId, side, personId: b[side].personId });

  it("each kind from the rows on file, counted (7): room x2, none x2, all x3 - including the pre-mint pass's own unadopted room, made by the REAL producer on a since-paired board", async () => {
    let checked = 0;
    const seen = new Set<string>();
    const expectKind = async (label: string, b: Board, side: Side, want: "none" | "room" | "all") => {
      expect(await stayMintOf(sql, ask(b, side)), label).toBe(want);
      seen.add(want);
      checked++;
    };

    // room: the pre-mint pass's own room - made by ensureMeeting(unpaired: allow) on a placeholder board, which is then paired
    const placeholder = await board();
    await sql`update fixtures set home_entrant_id = null, away_entrant_id = null where id = ${placeholder.fixtureId}`;
    const made = await ensureMeeting(placeholder.fixtureId, "home", {}, { unpaired: "allow" });
    const [stamps] = await sql<{ h: string | null; a: string | null }[]>`select home_entrant_id as h, away_entrant_id as a from fixture_video_meetings where meeting_id = ${made.meetingId}`;
    expect(stamps, "premise: the real producer wrote an UNADOPTED room").toEqual({ h: null, a: null });
    await sql`update fixtures set home_entrant_id = ${placeholder.home.entrantId}, away_entrant_id = ${placeholder.away.entrantId} where id = ${placeholder.fixtureId}`;
    await expectKind("room: the job's own unadopted room, the board paired since, no participant (the normal round)", placeholder, "home", "room");

    // room: a current room, no participant
    const current = await board();
    await putVideoMeeting({ fixtureId: current.fixtureId, orgId: current.orgId, side: "home" });
    await expectKind("room: a room of the current pairing, no participant", current, "home", "room");

    // none: an adopted room and a participant an earlier claim made
    const mine = await board();
    await putVideoMeeting({ fixtureId: mine.fixtureId, orgId: mine.orgId, side: "home" });
    await putVideoParticipant({ fixtureId: mine.fixtureId, side: "home", personId: mine.home.personId });
    await expectKind("none: a room of the current pairing and the player's participant", mine, "home", "none");

    // none: an unadopted room and a participant
    const unadoptedMine = await board();
    await putVideoMeeting({ fixtureId: unadoptedMine.fixtureId, orgId: unadoptedMine.orgId, side: "home" });
    await stampRoom(unadoptedMine.fixtureId, "home", "unadopted");
    await putVideoParticipant({ fixtureId: unadoptedMine.fixtureId, side: "home", personId: unadoptedMine.home.personId });
    await expectKind("none: an unadopted room and the player's participant", unadoptedMine, "home", "none");

    // all: nothing on file
    await expectKind("all: no row", await board(), "home", "all");

    // all: a room stamped for an EARLIER pairing, the participant on it
    const earlier = await board();
    await putVideoMeeting({ fixtureId: earlier.fixtureId, orgId: earlier.orgId, side: "home" });
    await putVideoParticipant({ fixtureId: earlier.fixtureId, side: "home", personId: earlier.home.personId });
    await stampRoom(earlier.fixtureId, "home", "retired");
    await expectKind("all: a room stamped for an earlier pairing, with the participant on it", earlier, "home", "all");

    // all: an ENDED room of the current pairing
    const ended = await board();
    await putVideoMeeting({ fixtureId: ended.fixtureId, orgId: ended.orgId, side: "home" }, { endedAt: new Date() });
    await expectKind("all: an ended room of the current pairing", ended, "home", "all");

    expect(checked, "anti-vacuity: seven rows").toBe(7);
    expect(seen, "all three kinds are in the table").toEqual(new Set(["none", "room", "all"]));
  });

  it("it is read by (fixture, side) and by person: the OTHER side's room and another player's participant do not count", async () => {
    const b = await board();
    await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side: "home" });
    await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side: "away" });
    await putVideoParticipant({ fixtureId: b.fixtureId, side: "away", personId: b.away.personId });
    expect(await stayMintOf(sql, ask(b, "home")), "the home player's room has nobody of theirs on it").toBe("room");
    expect(await stayMintOf(sql, ask(b, "away"))).toBe("none");
    expect(await stayMintOf(sql, { fixtureId: b.fixtureId, side: "home", personId: b.away.personId }), "the away player's participant is on the AWAY room, not this one").toBe("room");
  });

  it("it is the PLAYER participant that counts: the same person's ARBITER participant on the side's room does not make the claim a \"none\" (and their player participant, added after it, does)", async () => {
    const b = await board();
    await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side: "home" });
    await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: b.home.personId, preset: "arbiter" });
    expect(await stayMintOf(sql, ask(b, "home")), "an arbiter row of the same person is not a player's participant: the claim still owes one").toBe("room");
    await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: b.home.personId, preset: "player" });
    expect(await stayMintOf(sql, ask(b, "home")), "positive pair: the player's own participant is there now").toBe("none");
  });
});

// ─── The token stamp ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("the token stamp", () => {
  it("every token handed stamps token_issued_at (the minted one, a refresh, issuePlayerToken); a camera_starting answer to a browser that already holds the token stamps nothing; a recheck hands none (count 5)", async () => {
    let checked = 0;
    // 1. the minted token (the first claim of a required seat)
    const T1 = new Date();
    const a = await arrive({ join: false, at: T1 });
    expect((await rowOf(a.pid)).token_issued_at?.getTime(), "the minted token").toBe(T1.getTime());
    checked++;

    // 2. a refresh: a refused camera to a holder is handed the token again
    const T2 = at(T1, 5 * SEC);
    const refused = await claim(a, T2);
    expect(reasonOf(refused)).toBe("camera_required");
    expect(tokenOf(refused)?.participantId).toBe(a.pid);
    expect((await rowOf(a.pid)).token_issued_at?.getTime(), "the refreshed token").toBe(T2.getTime());
    checked++;

    // 3. issuePlayerToken: an OPTIONAL camera's seat is handed the token on its own path (it yields to an ACTIVE line, so this file's bucket
    // is emptied of the stays the claims above left)
    await sql`delete from fixture_seat_line where budget_key = ${bucketKey}`;
    const optional = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date(Date.now() + 600_000),
      linked: true,
      roundOpenedAt: new Date(Date.now() - 5 * MIN),
      cameraPolicy: "optional",
    });
    fixturesMade.push(optional.fixtureId);
    const T3 = new Date();
    const seat = await seatPlayer({ fixtureId: optional.fixtureId, personId: optional.home.personId }, { now: T3 });
    expect(seat, "premise: the optional seat is seated with a token").toMatchObject({ seated: true });
    const optionalPid = tokenOf(seat)?.participantId;
    expect(optionalPid, "premise: it carries the participant's token").toBeTruthy();
    expect((await rowOf(optionalPid!)).token_issued_at?.getTime(), "issuePlayerToken's token").toBe(T3.getTime());
    checked++;

    // 4. a camera_starting answer to the browser that already holds the token: no token handed, nothing stamped
    const b = await arrive();
    const stampBefore = (await rowOf(b.pid)).token_issued_at!.getTime();
    const since = await sinceOf(b);
    const waiting = await claim(b, at(since, FIRST_READ_AFTER_JOIN_MS - 1));
    expect(reasonOf(waiting)).toBe("camera_starting");
    expect(tokenOf(waiting)).toBeNull();
    expect((await rowOf(b.pid)).token_issued_at?.getTime(), "nothing handed, nothing stamped").toBe(stampBefore);
    checked++;

    // 5. a recheck hands no token and stamps nothing
    expect(reasonOf(await claim(b, at(since, FIRST_READ_AFTER_JOIN_MS)))).toBe("seated");
    const stamped = (await rowOf(b.pid)).token_issued_at!.getTime();
    const re = await claim(b, at(since, FIRST_READ_AFTER_JOIN_MS + 2 * SEC), { recheck: true });
    expect(reasonOf(re)).toBe("seated");
    expect(tokenOf(re)).toBeNull();
    expect((await rowOf(b.pid)).token_issued_at?.getTime(), "a recheck stamps nothing").toBe(stamped);
    checked++;
    expect(checked, "anti-vacuity").toBe(5);
  });
});
