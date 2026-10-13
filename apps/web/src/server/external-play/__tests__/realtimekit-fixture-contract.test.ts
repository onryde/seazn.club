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
  RealtimeKitError,
  addParticipant,
  fetchVideoOffCoverage,
  hasLiveVideoPublisher,
  listMeetingSessions,
  listPeerIds,
  refreshParticipantToken,
  removeParticipant,
} from "../video/realtimekit";

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
    await expect(hasLiveVideoPublisher({ meetingId: id, participantId: "p1" })).rejects.toMatchObject({ code: "unavailable", status: 404 });
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

  it("presence: no session is 'not live' (RealtimeKit's 404 body), setLivePublisher makes THIS participant live, and leaving ends it", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    const them = await addParticipant({ meetingId: id, subject: "black", preset: "player" });
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId }), "before anyone joins").toBe(false);
    fx.setLivePublisher(them.participantId, true);
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId }), "the OTHER player's presence is not mine").toBe(false);
    fx.setLivePublisher(me.participantId, true);
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId })).toBe(true);
    fx.setLivePublisher(me.participantId, false);
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId }), "a row with left_at set is not live").toBe(false);
    // The server ASKED: the seat gate's two reads are on the record.
    const asked = fx.calls.filter((c) => c.method === "GET").map((c) => c.route);
    expect(asked).toContain("GET /meetings/:id/active-session");
    expect(asked).toContain("GET /sessions/:id/participants");
  });

  it("a reload is a new row for the same participant: both peers are listed, first-seen order; a rejoin after everyone left is a NEW session", async () => {
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
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId })).toBe(false);
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

  it("an outage (D11) answers every route 503, the adapter throws `unavailable` — never a quiet 'not live' — and it recovers", async () => {
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    fx.setUnavailable(true);
    let checked = 0;
    for (const call of [
      () => hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId }),
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
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId })).toBe(true);
  });

  it("an unexpected route names itself", async () => {
    const res = await fetch(`${fx.url}${fx.kitPath}/livestreams`, {
      headers: { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: { message: "fixture: unhandled GET /livestreams" } });
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

describe("property: no HTTP request can make a participant live", () => {
  it("a forged claim on any route, in any order, never seats; the in-process call does", async () => {
    let requests = 0;
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
          // claim targets the one thing that would seat: a row for `me`.
          fx.setLivePublisher(other.participantId, true);
          const sid = fx.sessions(id).at(-1)!.id;
          for (const r of reqs) {
            const path = r.path.replace("MID", id).replace("PID", me.participantId).replace("SID", sid).replace("PEER", "peer-x");
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
            expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId })).toBe(false);
          }
        },
      ),
      { numRuns: 80 },
    );
    expect(requests, "zero forged requests sent is a FAILURE").toBeGreaterThan(0);
    expect(routesHit.size, "the property reached most route x method cells").toBeGreaterThan(PATHS.length);

    // Positive control: the same setup, the one in-process call, and the seat follows.
    fx.reset();
    const id = await meeting();
    const me = await addParticipant({ meetingId: id, subject: "white", preset: "player" });
    fx.setLivePublisher(me.participantId, true);
    expect(await hasLiveVideoPublisher({ meetingId: id, participantId: me.participantId })).toBe(true);
  });
});
