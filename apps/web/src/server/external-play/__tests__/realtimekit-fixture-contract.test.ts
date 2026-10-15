// Task 17 (spec §8.5, §10) — the RealtimeKit fixture server is the e2e
// stand-in for Cloudflare RealtimeKit's REST API. Its routes are the ones
// video/realtimekit.ts ACTUALLY calls (the brief's list was stale — Task 7
// carry), and every call below goes through that REAL adapter, pointed at the
// stub by REALTIMEKIT_BASE_URL, so a shape the stub serves that the adapter
// cannot read fails here, not in a browser.
//
// THE design rule (realtimekit-fixture-server.ts header): a live publisher is
// set by exactly ONE thing, the in-process `setLivePublisher()`, and by
// nothing that arrives over HTTP. The POC seated a player on a client-sent
// `cameraOk` boolean; the forged-claim property below sends every route every
// shape of that claim and asserts no seat follows.
//
// Expected values come from the measured evidence
// (docs/superpowers/specs/evidence/2026-10-09-chess-spikes/rtk-*.log, the
// recorded peer report) and the adapter's documented contract — never from
// the stub. Anti-vacuity: sweeps count what they checked and fail on zero.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIMEKIT_FIXTURE_ENV,
  REALTIMEKIT_FIXTURE_PORT,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import {
  PEER_REPORT_SAMPLE_CADENCE_MS,
  RealtimeKitError,
  addParticipant,
  fetchVideoOffCoverage,
  listMeetingSessions,
  listPeerIds,
  refreshParticipantToken,
  removeParticipant,
  seatCameraEvidence,
} from "../video/realtimekit";

/** The seat's camera reading, by state alone. */
const cameraOf = async (a: { meetingId: string; participantId: string }) => (await seatCameraEvidence(a)).state;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
});
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const EVIDENCE = join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "docs", "superpowers", "specs", "evidence", "2026-10-09-chess-spikes");

/** A meeting as ensureMeeting makes one — POST /meetings — without the DB row
 *  (ensureMeeting's own suite owns that half). */
async function meeting(): Promise<string> {
  const res = await fetch(`${fx.url}${fx.kitPath}/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "seazn-fixture-contract" }),
  });
  const body = (await res.json()) as { success: boolean; data: { id: string } };
  expect(body.success).toBe(true);
  return body.data.id;
}

describe("realtimekit fixture server — the adapter's contract", () => {
  it("empty case: a fresh stub has served nothing and has nobody live", () => {
    expect(fx.calls).toEqual([]);
    expect(fx.liveParticipantIds()).toEqual([]);
  });

  it("listens on the fixed port the CI env names, unless a test asks for an ephemeral one", () => {
    expect(REALTIMEKIT_FIXTURE_PORT).toBe(4322);
    expect(fx.port).not.toBe(REALTIMEKIT_FIXTURE_PORT);
  });

  it("serves only the configured account/app and API token: the wrong token is unauthorized, the wrong app a gateway no-route (never 'not found')", async () => {
    const id = await meeting();
    vi.stubEnv("REALTIMEKIT_API_TOKEN", "not-the-fixture-token");
    await expect(addParticipant({ meetingId: id, subject: "p1", preset: "player" })).rejects.toMatchObject({ code: "unauthorized" });
    vi.stubEnv("REALTIMEKIT_API_TOKEN", REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN);
    vi.stubEnv("REALTIMEKIT_APP_ID", "some-other-app");
    // Cloudflare's gateway 7003 is an answer the adapter must NOT read as
    // "no session" (realtimekit.ts isActiveSessionAbsent).
    await expect(seatCameraEvidence({ meetingId: id, participantId: "p1" })).rejects.toMatchObject({ code: "unavailable", status: 404 });
  });

  it("addParticipant names the subject and the env's preset; a refresh mints a DIFFERENT token for the SAME participant (rtk-token-regen.log)", async () => {
    const id = await meeting();
    const a = await addParticipant({ meetingId: id, subject: "person-1", preset: "player" });
    const rec = fx.participant(a.participantId);
    expect(rec).toMatchObject({ meetingId: id, subject: "person-1", preset: REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_PLAYER_PRESET });
    const arb = await addParticipant({ meetingId: id, subject: "user-9", preset: "arbiter" });
    expect(fx.participant(arb.participantId)?.preset).toBe(REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_ARBITER_PRESET);
    const again = await refreshParticipantToken({ meetingId: id, participantId: a.participantId });
    expect(again.participantId).toBe(a.participantId);
    expect(again.authToken).not.toBe(a.authToken);
    expect(fx.participantFor("person-1")?.id).toBe(a.participantId);
  });

  it("T17B D3, measured: add-participant is IDEMPOTENT on the custom id within a meeting — the SAME participant, a fresh token; another custom id or another meeting is a new one; a deleted one's custom id mints anew", async () => {
    const id = await meeting();
    const a = await addParticipant({ meetingId: id, subject: "user-1", preset: "arbiter" });
    const again = await addParticipant({ meetingId: id, subject: "user-1", preset: "arbiter" });
    expect(again.participantId, "the vendor's answer to a repeated custom id").toBe(a.participantId);
    expect(again.authToken).not.toBe(a.authToken);
    const other = await addParticipant({ meetingId: id, subject: "user-2", preset: "arbiter" });
    expect(other.participantId).not.toBe(a.participantId);
    const elsewhere = await addParticipant({ meetingId: await meeting(), subject: "user-1", preset: "arbiter" });
    expect(elsewhere.participantId, "per meeting").not.toBe(a.participantId);
    await removeParticipant({ meetingId: id, participantId: a.participantId });
    const fresh = await addParticipant({ meetingId: id, subject: "user-1", preset: "arbiter" });
    expect(fresh.participantId, "a deleted participant is never handed back").not.toBe(a.participantId);
  });

  it("presence: no session is 'not live' (RealtimeKit's 404 body), setLivePublisher makes THIS participant live with the honest camera, and leaving ends it", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    const them = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    expect(await cameraOf({ meetingId: id, participantId: me.participantId }), "before anyone joins").toBe("absent");
    fx.setLivePublisher(them.participantId, true);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId }), "the OTHER player's presence is not mine").toBe("absent");
    fx.setLivePublisher(me.participantId, true);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId }), "a join's default is the measured camera-ON peer").toBe("on");
    fx.setLivePublisher(me.participantId, false);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId }), "a row with left_at set is not live").toBe("absent");
    // The server ASKED: the seat gate's three reads are on the record.
    const asked = fx.calls.filter((c) => c.method === "GET").map((c) => c.route);
    expect(asked).toContain("GET /meetings/:id/active-session");
    expect(asked).toContain("GET /sessions/:id/participants");
    expect(asked).toContain("GET /sessions/peer-report/:peer");
  });

  it("MEASURED (T17B): a reload in a live session is a new PEER under the SAME row, and the seat judges the newer peer", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    const them = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    fx.setLivePublisher(them.participantId, true); // keeps the session LIVE through my reload
    fx.setLivePublisher(me.participantId, true, { camera: "denied" });
    const first = fx.currentPeer(me.participantId);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("blocked");
    fx.setLivePublisher(me.participantId, false); // the tab closes
    fx.setLivePublisher(me.participantId, true); // the reload: camera allowed this time
    const second = fx.currentPeer(me.participantId);
    expect(second, "a new peer").not.toBe(first);
    const sid = fx.sessions(id).at(-1)!.id;
    expect(fx.sessions(id), "one session throughout").toHaveLength(1);
    expect(await listPeerIds(sid, me.participantId), "both peers, first-seen order, under one row").toEqual([first, second]);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId }), "the old DENIED peer left; the newer one is judged").toBe("on");
  });

  it("a rejoin after everyone left is a NEW session: both sessions are listed, each with its own peer", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    const s1 = fx.sessions(id).at(-1)!;
    fx.setLivePublisher(me.participantId, false); // the only one in it: the session ENDS
    fx.setLivePublisher(me.participantId, true);
    const sessions = await listMeetingSessions(id);
    expect(sessions.map((s) => s.status)).toEqual(["ENDED", "LIVE"]);
    expect(sessions[0]!.endedAt).not.toBeNull();
    expect(sessions[1]!.endedAt).toBeNull();
    const peers1 = await listPeerIds(s1.id, me.participantId);
    expect(peers1).toHaveLength(1);
    const peers2 = await listPeerIds(sessions[1]!.id, me.participantId);
    expect(peers2).toHaveLength(1);
    expect(peers2[0]).not.toBe(peers1[0]);
  });

  it("removeParticipant kicks then deletes; a removed participant can never be made live again, and a repeat removal is quiet", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "arb", preset: "arbiter" });
    fx.setLivePublisher(me.participantId, true);
    await removeParticipant({ meetingId: id, participantId: me.participantId });
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("absent");
    expect(fx.participant(me.participantId)?.deleted).toBe(true);
    expect(() => fx.setLivePublisher(me.participantId, true)).toThrow(/removed/);
    await expect(refreshParticipantToken({ meetingId: id, participantId: me.participantId })).rejects.toMatchObject({ code: "not_found" });
    await expect(removeParticipant({ meetingId: id, participantId: me.participantId })).resolves.toBeUndefined();
  });

  it("the peer report: a recorded body is served verbatim and read whole (rtk-peer-report.log: 51 samples, final); an unknown peer is RealtimeKit's not-found", async () => {
    const recorded = JSON.parse(readFileSync(join(EVIDENCE, "peer-report-recorded.json"), "utf8")) as { data: unknown };
    fx.servePeerReport("peer-recorded", recorded.data);
    const cov = await fetchVideoOffCoverage("peer-recorded");
    expect(cov.incomplete).toBe(false);
    expect(cov.sampleCount, "rtk-peer-report.log: FINAL n=51 samples").toBe(51);
    await expect(fetchVideoOffCoverage("peer-nobody")).rejects.toMatchObject({ code: "not_found" });
  });

  it("SEQUENCE: a peer's report FINALISES only when the fixture is told reports are final AND the peer has left (D22: the sweep's evidence read can settle) - and reset puts it back", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    const peer = fx.currentPeer(me.participantId)!;
    const coverage = () => fetchVideoOffCoverage(peer);
    // Default: never final, whether or not the peer has left (the shape every earlier walkthrough was written against).
    expect(await coverage(), "in the room, default").toMatchObject({ incomplete: true, reason: "not_left" });
    fx.setLivePublisher(me.participantId, false);
    expect(await coverage(), "left, default").toMatchObject({ incomplete: true, reason: "not_finalised" });
    // Told reports are final: still not final while the peer is in the room; final once it has left.
    fx.setReportsFinal(true);
    const again = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    fx.setLivePublisher(again.participantId, true);
    const livePeer = fx.currentPeer(again.participantId)!;
    expect(await fetchVideoOffCoverage(livePeer), "in the room, reports final").toMatchObject({ incomplete: true, reason: "not_left" });
    expect(await coverage(), "left, reports final").toMatchObject({ incomplete: false });
    fx.setLivePublisher(again.participantId, false);
    expect(await fetchVideoOffCoverage(livePeer), "left, reports final (the second peer)").toMatchObject({ incomplete: false });
    fx.reset();
    const id2 = await meeting();
    const third = await addParticipant({ meetingId: id2, subject: "white", preset: "player" });
    fx.setLivePublisher(third.participantId, true);
    const p3 = fx.currentPeer(third.participantId)!;
    fx.setLivePublisher(third.participantId, false);
    expect(await fetchVideoOffCoverage(p3), "after reset: never final again").toMatchObject({ incomplete: true, reason: "not_finalised" });
  });

  it("SEQUENCE: a FINAL report shows a camera that was on as on for the whole stay (a sample every cadence), and one that was off or refused as off for all of it (D22: an honest camera is not settled as camera_lost)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
      fx.setReportsFinal(true);
      const stay = 100_000;
      let checked = 0;
      for (const camera of ["on", "off", "denied", "pending"] as const) {
        const id = await meeting();
        const me = await addParticipant({ meetingId: id, subject: `white-${camera}`, preset: "player" });
        fx.setLivePublisher(me.participantId, true, { camera });
        const peer = fx.currentPeer(me.participantId)!;
        vi.advanceTimersByTime(stay);
        fx.setLivePublisher(me.participantId, false);
        const cov = await fetchVideoOffCoverage(peer);
        if (cov.incomplete) throw new Error(`${camera}: the report did not finalise`);
        if (camera === "on") {
          expect(cov.sampleCount, "a sample every cadence across the stay").toBe(Math.floor(stay / PEER_REPORT_SAMPLE_CADENCE_MS));
          expect([cov.offSeconds, cov.offIntervals], "camera on: not a second off").toEqual([0, []]);
        } else {
          expect(cov.sampleCount, `${camera}: no video was produced`).toBe(0);
          expect(cov.offSeconds, `${camera}: off for the whole stay`).toBe(stay / 1_000);
        }
        checked += 1;
        vi.advanceTimersByTime(1_000);
      }
      expect(checked, "anti-vacuity").toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an outage (D11) answers every route 503, the adapter throws `unavailable` — never a quiet 'not live' — and it recovers", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    fx.setUnavailable(true);
    let checked = 0;
    for (const call of [
      () => seatCameraEvidence({ meetingId: id, participantId: me.participantId }),
      () => addParticipant({ meetingId: id, subject: "x", preset: "player" }),
      () => refreshParticipantToken({ meetingId: id, participantId: me.participantId }),
      () => listMeetingSessions(id),
    ]) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RealtimeKitError);
      expect(err).toMatchObject({ code: "unavailable", status: 503 });
      checked++;
    }
    expect(checked).toBe(4);
    fx.setUnavailable(false);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("on");
  });

  it("an unexpected route names itself", async () => {
    const res = await fetch(`${fx.url}${fx.kitPath}/livestreams`, {
      headers: { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { message: "fixture: unhandled GET /livestreams" } });
  });
});

// ─── The seat's camera (T17B fix 2, D2) ──────────────────────────────────────
//
// Presence proved only "joined": a player whose browser DENIED the camera was
// seated live. The seat now reads the CURRENT peer's report. Expected states
// come from the measured live reports (evidence t17b-peer-reports-live.json)
// and the ruling — never from the adapter.
type LiveReports = { peers: Record<"denied" | "on", { video_producer_samples: number; data: unknown }> };
const LIVE = JSON.parse(readFileSync(join(EVIDENCE, "t17b-peer-reports-live.json"), "utf8")) as LiveReports;

describe("the seat's camera: the current peer's own report, read through the real adapter", () => {
  it("the MEASURED live reports: the DENIED peer reads blocked, the allowed peer reads on — and the 'on' verdict never needed a producer sample", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    const peer = fx.currentPeer(me.participantId)!;
    let checked = 0;
    for (const [name, want] of [["denied", "blocked"], ["on", "on"]] as const) {
      fx.servePeerReport(peer, LIVE.peers[name].data);
      expect(await cameraOf({ meetingId: id, participantId: me.participantId }), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(2);
    expect(LIVE.peers.denied.video_producer_samples, "premise: the denied peer published nothing").toBe(0);
    // The recorded body carries NO quality block at all: the verdict is the events'.
    expect(JSON.stringify(LIVE.peers.on.data)).not.toContain("video_producer");
  });

  it("every camera a join can show, swept, each with its state (zero checked fails)", async () => {
    // From the ruling: ACCEPTED + latest video_on seats; DENIED is blocked; ACCEPTED then video_off is off; no
    // evidence yet — an empty report, or none at all (RealtimeKit's not-found) — is starting.
    const cases = [
      { camera: "on", want: "on" },
      { camera: "denied", want: "blocked" },
      { camera: "off", want: "off" },
      { camera: "pending", want: "starting" },
      { camera: "none", want: "starting" },
    ] as const;
    let checked = 0;
    const seen = new Set<string>();
    for (const c of cases) {
      fx.reset();
      const id = await meeting();
      const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
      fx.setLivePublisher(me.participantId, true, { camera: c.camera });
      const got = await seatCameraEvidence({ meetingId: id, participantId: me.participantId });
      expect(got.state, c.camera).toBe(c.want);
      // `since` is the peer's own join, for the seat's wait (absent carries none).
      expect("since" in got && got.since.getTime(), `${c.camera}: since`).toBeGreaterThan(0);
      seen.add(got.state);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(seen.size, "four distinct states").toBe(4);
  });

  it("SEQUENCE: the latest video_on/video_off wins — a camera turned off mid-session reads off, turned back on reads on", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("on");
    fx.setPeerCamera(me.participantId, "video_off");
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("off");
    fx.setPeerCamera(me.participantId, "video_on");
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("on");
  });

  it("SEQUENCE: a report that was PENDING arrives later on the SAME peer - starting, then each camera the report can show, and no second peer is made (D22)", async () => {
    let checked = 0;
    for (const arrives of ["on", "denied", "off"] as const) {
      fx.reset();
      const id = await meeting();
      const me = await addParticipant({ meetingId: id, subject: `white-${arrives}`, preset: "player" });
      fx.setLivePublisher(me.participantId, true, { camera: "pending" });
      const peer = fx.currentPeer(me.participantId);
      expect(await cameraOf({ meetingId: id, participantId: me.participantId }), `${arrives}: no report yet`).toBe("starting");
      fx.reportCamera(me.participantId, arrives);
      // measured shapes (T17B): an accepted camera reads on, a refused one blocked, one turned off reads off.
      const expected = { on: "on", denied: "blocked", off: "off" }[arrives];
      expect(await cameraOf({ meetingId: id, participantId: me.participantId }), `${arrives}: the report arrived`).toBe(expected);
      expect(fx.currentPeer(me.participantId), `${arrives}: the same peer, not a reload`).toBe(peer);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(3);
    const lone = await meeting();
    const nobody = await addParticipant({ meetingId: lone, subject: "nobody", preset: "player" });
    expect(() => fx.reportCamera(nobody.participantId, "on"), "no connected peer: refused, like setPeerCamera").toThrow(/no connected peer/);
  });

  it("an old peer that LEFT is never judged: an allowed camera that left, beside a newer DENIED one, reads blocked", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    const them = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    fx.setLivePublisher(them.participantId, true);
    fx.setLivePublisher(me.participantId, true); // camera on
    fx.setLivePublisher(me.participantId, false);
    fx.setLivePublisher(me.participantId, true, { camera: "denied" }); // the reload denied it
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("blocked");
  });

  it("a peer-report OUTAGE is `unreadable` — never on, never absent — carrying the outage and the peer's join", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    // Only the report fails: presence still answers.
    fx.setPeerReportsUnavailable(true);
    const down = await seatCameraEvidence({ meetingId: id, participantId: me.participantId });
    expect(down.state).toBe("unreadable");
    expect(down.state === "unreadable" && down.error).toMatchObject({ code: "unavailable", status: 503 });
    fx.setPeerReportsUnavailable(false);
    // A 200 whose body cannot be read is the same: an answer we cannot read is an outage.
    fx.servePeerReport(fx.currentPeer(me.participantId)!, "not an object");
    const unreadable = await seatCameraEvidence({ meetingId: id, participantId: me.participantId });
    expect(unreadable.state).toBe("unreadable");
    expect(unreadable.state === "unreadable" && unreadable.error).toBeInstanceOf(RealtimeKitError);
  });
});

// ─── The forged claim (§8.5, §10) ────────────────────────────────────────────
//
// Any sequence of HTTP requests — every route, every method, bodies, query
// strings and headers carrying every spelling of "my camera is on" — leaves
// nobody live. The positive control at the end proves the same participant
// CAN go live, by the one in-process call.
const CLAIMS = [
  { live: true }, { publishing: true }, { cameraOk: true }, { video: true }, { status: "LIVE" },
  { media: { video: { publishing: true } } }, { left_at: null }, { user_id: "PID" }, { joined: true },
];
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const PATHS = [
  "/meetings", "/meetings/MID", "/meetings/MID/participants", "/meetings/MID/participants/PID",
  "/meetings/MID/participants/PID/token", "/meetings/MID/active-session", "/meetings/MID/active-session/kick",
  "/meetings/MID/active-session/kick-all", "/sessions", "/sessions/SID/participants", "/sessions/peer-report/PEER",
  "/meetings/MID/participants/PID/live", "/meetings/MID/active-session/participants", "/sessions/SID/participants/PID",
];

describe("property: no HTTP request can make a participant live, or turn a camera on", () => {
  it("a forged claim on any route, in any order, never seats and never turns a DENIED camera on; the in-process call does", async () => {
    let requests = 0;
    let camerasChecked = 0;
    const routesHit = new Set<string>();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            method: fc.constantFrom(...METHODS),
            path: fc.constantFrom(...PATHS),
            claim: fc.constantFrom(...CLAIMS),
            where: fc.constantFrom("body", "query", "header"),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (reqs) => {
          fx.reset();
          const id = await meeting();
          const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
          const other = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
          // A LIVE session exists (the opponent is in it), so the forged
          // claim targets the one thing that would seat: a row for `me`. The
          // opponent's browser DENIED the camera (D2): PEER is their peer, so
          // the forged claims also target the report that would seat them.
          fx.setLivePublisher(other.participantId, true, { camera: "denied" });
          const sid = fx.sessions(id).at(-1)!.id;
          const peer = fx.currentPeer(other.participantId)!;
          for (const r of reqs) {
            const path = r.path.replace("MID", id).replace("PID", me.participantId).replace("SID", sid).replace("PEER", peer);
            const claim = JSON.parse(JSON.stringify(r.claim).replace("PID", me.participantId)) as Record<string, unknown>;
            const qs = r.where === "query" ? `?${new URLSearchParams(Object.entries(claim).map(([k, v]) => [k, JSON.stringify(v)])).toString()}` : "";
            const headers: Record<string, string> = {
              Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`,
              "Content-Type": "application/json",
            };
            if (r.where === "header") for (const [k, v] of Object.entries(claim)) headers[`x-${k.toLowerCase()}`] = JSON.stringify(v);
            const withBody = r.method !== "GET" && r.method !== "DELETE";
            await fetch(`${fx.url}${fx.kitPath}${path}${qs}`, {
              method: r.method,
              headers,
              body: withBody ? JSON.stringify(r.where === "body" ? { custom_participant_id: "white", ...claim } : {}) : undefined,
            });
            requests++;
            routesHit.add(`${r.method} ${r.path}`);
          }
          expect(fx.liveParticipantIds(), "an HTTP request made a participant live").not.toContain(me.participantId);
          // The kick routes may legitimately END the opponent's presence; they
          // can never CREATE ours.
          if (!fx.participant(me.participantId)?.deleted) {
            expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("absent");
          }
          // A kick may END the opponent's presence; nothing turns their camera on.
          if (!fx.participant(other.participantId)?.deleted) {
            expect(await cameraOf({ meetingId: id, participantId: other.participantId }), "an HTTP request turned a denied camera on").not.toBe("on");
            camerasChecked++;
          }
        },
      ),
      { numRuns: 80 },
    );
    expect(requests, "zero forged requests sent is a FAILURE").toBeGreaterThan(0);
    expect(camerasChecked, "the denied camera was read after the forged requests").toBeGreaterThan(0);
    expect(routesHit.size, "the property reached most route x method cells").toBeGreaterThan(PATHS.length);

    // Positive control: the same setup, the one in-process call, and the seat follows.
    fx.reset();
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    expect(await cameraOf({ meetingId: id, participantId: me.participantId })).toBe("on");
  });
});
