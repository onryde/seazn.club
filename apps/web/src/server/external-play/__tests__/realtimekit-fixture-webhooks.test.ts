// Check-in capacity plan 1, Task 1 (spec §6.2) — the RealtimeKit fixture vendor emits SIGNED presence webhooks, the way
// Cloudflare does, so the receiver (a later task) is driven by a real producer and never by a hand-built body.
//
// THE design rule of the fixture is unchanged: presence is set by the in-process `setLivePublisher` alone, and by nothing
// that arrives over HTTP; a webhook is therefore emitted only from that seam and from the routes that END presence.
//
// Expected values come from the fixture's own record (its participants, its peer events as it serves them over HTTP) and
// from the spec's body shapes, never from the emitter's output. Anti-vacuity: every sweep reports what it checked.
import { createServer, type Server } from "node:http";
import { verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIMEKIT_FIXTURE_ENV,
  httpWebhookDeliver,
  startRealtimeKitFixtureServer,
  type FixtureWebhook,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";

let fx: RealtimeKitFixtureServer;
const got: FixtureWebhook[] = [];
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0, {
    webhooks: async (w) => {
      got.push(w);
    },
  });
});
beforeEach(async () => {
  await fx.reset();
  got.length = 0;
});
afterAll(() => fx.close());

const AUTH = { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" };
const kit = (server: RealtimeKitFixtureServer, path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${server.kitPath}${path}`, { ...init, headers: AUTH });
let n = 0;

/** A meeting and a participant in it, over HTTP as the adapter mints them (`meeting()` of the contract test). */
async function mint(server: RealtimeKitFixtureServer = fx, meetingId?: string): Promise<{ meetingId: string; participantId: string }> {
  let id = meetingId;
  if (!id) {
    const m = (await (await kit(server, "/meetings", { method: "POST", body: JSON.stringify({ title: "seazn-webhook-test" }) })).json()) as { data: { id: string } };
    id = m.data.id;
  }
  const p = (await (
    await kit(server, `/meetings/${id}/participants`, {
      method: "POST",
      body: JSON.stringify({ custom_participant_id: `person-${++n}`, preset_name: REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_PLAYER_PRESET }),
    })
  ).json()) as { data: { id: string } };
  return { meetingId: id, participantId: p.data.id };
}

type Parsed = {
  event: string;
  meeting: { id: string; sessionId: string; status: string; endedAt?: string };
  participant?: { peerId: string; customParticipantId: string; presetName: string; joinedAt: string; leftAt?: string };
};
const parse = (w: FixtureWebhook) => JSON.parse(w.body) as Parsed;
const events = () => got.map((w) => parse(w).event);

describe("realtimekit fixture webhooks", () => {
  it("empty case: a fresh fixture has emitted nothing and has no outcomes", () => {
    expect(fx.webhooks).toEqual([]);
    expect(fx.webhookOutcomes.size).toBe(0);
    expect(got).toEqual([]);
  });

  it("a join emits one participantJoined that verifies against the served key and names the fixture's own peer", async () => {
    const { meetingId, participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    await fx.webhooksSettled();
    expect(got).toHaveLength(1);
    const w = got[0]!;
    const body = parse(w);
    expect(body.event).toBe("meeting.participantJoined");
    expect(w.event).toBe("meeting.participantJoined");
    expect(body.meeting.id).toBe(meetingId);
    expect(body.meeting.status).toBe("LIVE");
    expect(body.participant!.peerId).toBe(fx.currentPeer(participantId));
    expect(body.participant!.customParticipantId).toBe(fx.participant(participantId)!.subject);
    expect(verify("RSA-SHA256", Buffer.from(w.body), fx.publicKeyPem, Buffer.from(w.signature, "base64"))).toBe(true);
    const served = (await (await fetch(`${fx.url}/.well-known/webhooks.json`)).json()) as { success: boolean; data: { publicKey: string } };
    expect(served.success).toBe(true);
    expect(served.data.publicKey).toBe(fx.publicKeyPem);
    expect(fx.webhooks).toEqual(got);
    expect(fx.webhookOutcomes.get(w.uuid)).toBe("delivered");
  });

  it("every webhook carries a distinct uuid", async () => {
    const a = await mint();
    const b = await mint(fx, a.meetingId);
    fx.setLivePublisher(a.participantId, true);
    fx.setLivePublisher(b.participantId, true);
    fx.setLivePublisher(a.participantId, false);
    await fx.webhooksSettled();
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(new Set(got.map((w) => w.uuid)).size).toBe(got.length);
  });

  it("a leave emits participantLeft for the same peer with leftAt no earlier than joinedAt; the last leave ends the session", async () => {
    const { meetingId, participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    const peer = fx.currentPeer(participantId);
    fx.setLivePublisher(participantId, false);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"]);
    const [joined, left, ended] = got.map(parse) as [Parsed, Parsed, Parsed];
    expect(joined.participant!.peerId).toBe(peer);
    expect(left.participant!.peerId).toBe(joined.participant!.peerId);
    expect(left.participant!.joinedAt).toBe(joined.participant!.joinedAt);
    expect(Date.parse(left.participant!.leftAt!)).toBeGreaterThanOrEqual(Date.parse(joined.participant!.joinedAt));
    expect(left.meeting.id).toBe(meetingId);
    expect(ended.meeting.id).toBe(meetingId);
    expect(ended.meeting.status).toBe("ENDED");
    expect(typeof ended.meeting.endedAt).toBe("string");
    expect(ended.meeting.sessionId).toBe(joined.meeting.sessionId);
    expect(ended.participant).toBeUndefined();
    expect(fx.currentPeer(participantId)).toBeNull();
    expect(fx.sessions(meetingId).map((s) => s.status)).toEqual(["ENDED"]);
  });

  it("a leave while another participant is still in the session emits no meeting.ended", async () => {
    const a = await mint();
    const b = await mint(fx, a.meetingId);
    fx.setLivePublisher(a.participantId, true);
    fx.setLivePublisher(b.participantId, true);
    fx.setLivePublisher(a.participantId, false);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantJoined", "meeting.participantLeft"]);
    fx.setLivePublisher(b.participantId, false);
    await fx.webhooksSettled();
    expect(events().slice(3)).toEqual(["meeting.participantLeft", "meeting.ended"]);
  });

  it("leaving a participant that is not live emits nothing (the empty leave)", async () => {
    const { participantId } = await mint();
    fx.setLivePublisher(participantId, false);
    await fx.webhooksSettled();
    expect(fx.webhooks).toEqual([]);
  });

  it("a reload (setLivePublisher true twice) emits two joins for two distinct peers, each dated by its OWN PEER_JOINING", async () => {
    const { meetingId, participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    const first = fx.currentPeer(participantId);
    await new Promise((r) => setTimeout(r, 15)); // distinct ms, so a row-dated joinedAt cannot tie with the peer's own
    fx.setLivePublisher(participantId, true);
    const second = fx.currentPeer(participantId);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantJoined"]);
    const [a, b] = got.map(parse) as [Parsed, Parsed];
    expect(a.participant!.peerId).toBe(first);
    expect(b.participant!.peerId).toBe(second);
    expect(a.participant!.peerId).not.toBe(b.participant!.peerId);
    // the fixture's own record, served over HTTP: each peer's PEER_JOINING created_at
    const sessionId = fx.sessions(meetingId)[0]!.id;
    const served = (await (await kit(fx, `/sessions/${sessionId}/participants?include_peer_events=true`)).json()) as {
      data: { participants: { peer_events: { event_name: string; peer_id: string; created_at: string }[] }[] };
    };
    const joinings = served.data.participants.flatMap((r) => r.peer_events).filter((e) => e.event_name === "PEER_JOINING");
    expect(joinings).toHaveLength(2);
    const joinedAtOf = (peer: string) => joinings.find((e) => e.peer_id === peer)!.created_at;
    expect(a.participant!.joinedAt).toBe(joinedAtOf(first!));
    expect(b.participant!.joinedAt).toBe(joinedAtOf(second!));
    expect(Date.parse(b.participant!.joinedAt)).toBeGreaterThan(Date.parse(a.participant!.joinedAt));
    expect(got.some((w) => parse(w).event === "meeting.participantLeft")).toBe(false);
  });

  it("a reload then a leave emits participantLeft for BOTH peers (each with its own joinedAt), then meeting.ended", async () => {
    const { participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    await new Promise((r) => setTimeout(r, 15));
    fx.setLivePublisher(participantId, true);
    fx.setLivePublisher(participantId, false);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantJoined", "meeting.participantLeft", "meeting.participantLeft", "meeting.ended"]);
    const [j1, j2, l1, l2] = got.map(parse) as [Parsed, Parsed, Parsed, Parsed];
    for (const j of [j1, j2]) {
      const l = [l1, l2].find((x) => x.participant!.peerId === j.participant!.peerId);
      expect(l, `a leave for peer ${j.participant!.peerId}`).toBeDefined();
      expect(l!.participant!.joinedAt).toBe(j.participant!.joinedAt);
    }
  });

  it("kick-all emits one participantLeft per live peer, then meeting.ended", async () => {
    const a = await mint();
    const b = await mint(fx, a.meetingId);
    fx.setLivePublisher(a.participantId, true);
    fx.setLivePublisher(b.participantId, true);
    const res = await kit(fx, `/meetings/${a.meetingId}/active-session/kick-all`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantJoined", "meeting.participantLeft", "meeting.participantLeft", "meeting.ended"]);
    const parsed = got.map(parse);
    const joinedPeers = parsed.slice(0, 2).map((x) => x.participant!.peerId).sort();
    const leftPeers = parsed.slice(2, 4).map((x) => x.participant!.peerId).sort();
    expect(joinedPeers).toHaveLength(2);
    expect(leftPeers).toEqual(joinedPeers);
  });

  it("kick of one participant emits that peer's leave and no meeting.ended while another stays", async () => {
    const a = await mint();
    const b = await mint(fx, a.meetingId);
    fx.setLivePublisher(a.participantId, true);
    fx.setLivePublisher(b.participantId, true);
    const peerA = fx.currentPeer(a.participantId);
    const res = await kit(fx, `/meetings/${a.meetingId}/active-session/kick`, { method: "POST", body: JSON.stringify({ participant_ids: [a.participantId] }) });
    expect(res.status).toBe(200);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantJoined", "meeting.participantLeft"]);
    expect(parse(got[2]!).participant!.peerId).toBe(peerA);
  });

  it("DELETE of a participant emits its leave", async () => {
    const { meetingId, participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    const peer = fx.currentPeer(participantId);
    const res = await kit(fx, `/meetings/${meetingId}/participants/${participantId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await fx.webhooksSettled();
    expect(events()).toEqual(["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"]);
    expect(parse(got[1]!).participant!.peerId).toBe(peer);
  });

  it("a rejoin after the session ended is a new session: a second joined, then a second ended, each for its own session", async () => {
    const { participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    fx.setLivePublisher(participantId, false);
    fx.setLivePublisher(participantId, true);
    fx.setLivePublisher(participantId, false);
    await fx.webhooksSettled();
    expect(events()).toEqual([
      "meeting.participantJoined", "meeting.participantLeft", "meeting.ended",
      "meeting.participantJoined", "meeting.participantLeft", "meeting.ended",
    ]);
    const sessions = got.map((w) => parse(w).meeting.sessionId);
    expect(sessions[0]).not.toBe(sessions[3]);
    expect(new Set(sessions.slice(0, 3)).size).toBe(1);
    expect(new Set(sessions.slice(3)).size).toBe(1);
  });

  it("webhooks down: emitted and logged, never delivered; reset clears the flag, the log and the outcomes", async () => {
    fx.setWebhooksDown(true);
    const { participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    await fx.webhooksSettled();
    expect(got).toHaveLength(0);
    expect(fx.webhooks).toHaveLength(1);
    expect(fx.webhookOutcomes.get(fx.webhooks[0]!.uuid)).toBe("down");
    await fx.reset();
    expect(fx.webhooks).toHaveLength(0);
    expect(fx.webhookOutcomes.size).toBe(0);
    const again = await mint();
    fx.setLivePublisher(again.participantId, true);
    await fx.webhooksSettled();
    expect(got, "reset cleared the down flag").toHaveLength(1);
  });

  it("a fixture started without a deliverer logs webhooks and records them as never delivered", async () => {
    const fx3 = await startRealtimeKitFixtureServer(0);
    try {
      const { participantId } = await mint(fx3);
      fx3.setLivePublisher(participantId, true);
      await fx3.webhooksSettled();
      expect(fx3.webhooks).toHaveLength(1);
      expect(fx3.webhookOutcomes.get(fx3.webhooks[0]!.uuid)).toBe("down");
    } finally {
      await fx3.close();
    }
  });

  it("reset awaits an in-flight delivery, so it never lands in the next test's receiver or outcomes", async () => {
    const landed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fx4 = await startRealtimeKitFixtureServer(0, {
      webhooks: async (w) => {
        await gate;
        landed.push(w.uuid);
      },
    });
    try {
      const { participantId } = await mint(fx4);
      fx4.setLivePublisher(participantId, true);
      expect(fx4.webhookOutcomes.get(fx4.webhooks[0]!.uuid)).toBe("pending");
      let resetDone = false;
      const resetting = fx4.reset().then(() => (resetDone = true));
      expect(fx4.webhooks, "reset clears synchronously").toHaveLength(0);
      await new Promise((r) => setTimeout(r, 20));
      expect(resetDone, "reset is still waiting for the in-flight delivery").toBe(false);
      release();
      await resetting;
      expect(landed).toHaveLength(1);
      expect(fx4.webhookOutcomes.size, "a late settle does not write into the cleared outcomes").toBe(0);
    } finally {
      release();
      await fx4.close();
    }
  });

  it("a delivery that REJECTS after a reset never leaks into the next test's lastWebhookError (batch-1 T1 M2)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fx5 = await startRealtimeKitFixtureServer(0, {
      webhooks: async () => {
        await gate;
        throw new Error("receiver down after the reset");
      },
    });
    try {
      const { participantId } = await mint(fx5);
      fx5.setLivePublisher(participantId, true);
      expect(fx5.webhookOutcomes.get(fx5.webhooks[0]!.uuid), "premise: in flight").toBe("pending");
      const resetting = fx5.reset();
      release();
      await resetting;
      expect(fx5.lastWebhookError(), "the rejection belongs to the reset generation").toBeUndefined();
      expect(fx5.webhookOutcomes.size).toBe(0);
      // the pair: a rejection in the CURRENT generation is still recorded
      const { participantId: again } = await mint(fx5);
      fx5.setLivePublisher(again, true);
      await fx5.webhooksSettled();
      expect((fx5.lastWebhookError() as Error).message).toBe("receiver down after the reset");
    } finally {
      release();
      await fx5.close();
    }
  });

  it("joinedAt is strictly increasing: two setLivePublisher calls in ONE millisecond stamp distinct, ordered instants (batch-1 m1)", async () => {
    const { participantId: a } = await mint();
    const { participantId: b } = await mint();
    // Freeze Date only (the HTTP mint above already ran on real time), so both joins read the same millisecond.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      const frozen = Date.now();
      fx.setLivePublisher(a, true);
      fx.setLivePublisher(b, true);
      fx.setLivePublisher(a, true); // a reload: a third join, same millisecond
      expect(Date.now(), "premise: the clock did not move").toBe(frozen);
      // a clock set BACK (the contract tests stage stays at a past instant) is followed, not held at the last stamp
      vi.setSystemTime(new Date(frozen - 3_600_000));
      fx.setLivePublisher(b, true);
    } finally {
      vi.useRealTimers();
    }
    await fx.webhooksSettled();
    const joins = got.map(parse).filter((w) => w.event === "meeting.participantJoined").map((w) => Date.parse(w.participant!.joinedAt));
    expect(joins, "four joins emitted").toHaveLength(4);
    for (let i = 1; i < 3; i++) expect(joins[i]!, `join ${i} after join ${i - 1}`).toBeGreaterThan(joins[i - 1]!);
    expect(joins[3], "after the clock was set back an hour").toBe(joins[0]! - 3_600_000);
  });

  it("a delivery that rejects is recorded as failed and never escapes: webhooksSettled resolves, no unhandled rejection", async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    const fx2 = await startRealtimeKitFixtureServer(0, {
      webhooks: async () => {
        throw new Error("receiver down");
      },
    });
    try {
      const { participantId } = await mint(fx2);
      fx2.setLivePublisher(participantId, true);
      await expect(fx2.webhooksSettled()).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 25)); // an unhandled rejection surfaces on a later tick
      expect(fx2.webhooks).toHaveLength(1);
      expect(fx2.webhookOutcomes.get(fx2.webhooks[0]!.uuid)).toBe("failed");
      expect((fx2.lastWebhookError() as Error).message).toBe("receiver down");
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await fx2.close();
    }
  });

  it("the key document is served during a vendor outage and without a bearer, and never lands in `calls`", async () => {
    fx.setUnavailable(true);
    try {
      const res = await fetch(`${fx.url}/.well-known/webhooks.json`);
      expect(res.status).toBe(200);
      expect(fx.calls.some((c) => c.path.includes("well-known"))).toBe(false);
      expect(fx.calls).toEqual([]);
    } finally {
      fx.setUnavailable(false);
    }
  });

  it("a tampered body does not verify", async () => {
    const { participantId } = await mint();
    fx.setLivePublisher(participantId, true);
    await fx.webhooksSettled();
    const w = got[0]!;
    expect(verify("RSA-SHA256", Buffer.from(w.body), fx.publicKeyPem, Buffer.from(w.signature, "base64"))).toBe(true);
    expect(verify("RSA-SHA256", Buffer.from(w.body + " "), fx.publicKeyPem, Buffer.from(w.signature, "base64"))).toBe(false);
  });

  it("a fixture's key is its own: another start's key does not verify this one's webhook", async () => {
    const other = await startRealtimeKitFixtureServer(0);
    try {
      expect(other.publicKeyPem).not.toBe(fx.publicKeyPem);
      const { participantId } = await mint();
      fx.setLivePublisher(participantId, true);
      await fx.webhooksSettled();
      const w = got[0]!;
      expect(verify("RSA-SHA256", Buffer.from(w.body), other.publicKeyPem, Buffer.from(w.signature, "base64"))).toBe(false);
    } finally {
      await other.close();
    }
  });

  it("no HTTP request emits a webhook: only the in-process seam does (anti-vacuity: every route is hit)", async () => {
    const { meetingId, participantId } = await mint();
    const claims = JSON.stringify({ live: true, cameraOk: true, joined: true, event: "meeting.participantJoined", participant_ids: [participantId] });
    const sessionId = "ses-none";
    const hits: [string, RequestInit][] = [
      ["/meetings", { method: "POST", body: claims }],
      [`/meetings/${meetingId}`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE", live: true }) }],
      [`/meetings/${meetingId}/participants`, { method: "POST", body: JSON.stringify({ custom_participant_id: "person-x", preset_name: "p", live: true, cameraOk: true }) }],
      [`/meetings/${meetingId}/participants/${participantId}/token`, { method: "POST", body: claims }],
      [`/meetings/${meetingId}/active-session`, { method: "GET" }],
      [`/meetings/${meetingId}/active-session/kick`, { method: "POST", body: claims }],
      [`/meetings/${meetingId}/active-session/kick-all`, { method: "POST", body: claims }],
      ["/sessions/peer-report/peer-none", { method: "GET" }],
      [`/sessions/${sessionId}/participants?include_peer_events=true`, { method: "GET" }],
      [`/sessions?associated_id=${meetingId}`, { method: "GET" }],
      [`/meetings/${meetingId}/participants/${participantId}`, { method: "DELETE" }],
      ["/somewhere-else", { method: "POST", body: claims }],
    ];
    for (const [path, init] of hits) await kit(fx, path, init);
    await fx.webhooksSettled();
    const routes = new Set(fx.calls.map((c) => c.route).filter((r) => r !== "unhandled"));
    expect(routes.size, "the sweep reached at least 10 distinct routes").toBeGreaterThanOrEqual(10);
    expect(fx.calls.length).toBeGreaterThanOrEqual(hits.length);
    expect(fx.webhooks).toEqual([]);
    expect(got).toEqual([]);
  });
});

describe("httpWebhookDeliver", () => {
  it("posts the body with rtk-signature and rtk-uuid, retries a 500 twice more, and drops a 401 without retry", async () => {
    type Seen = { headers: Record<string, string | string[] | undefined>; body: string };
    const seen: Seen[] = [];
    const answers: number[] = [500, 500, 200, 401];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(answers.shift() ?? 500).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
      const deliver = httpWebhookDeliver(url);
      const first: FixtureWebhook = { uuid: "u-1", event: "meeting.participantJoined", body: '{"event":"meeting.participantJoined"}', signature: "c2ln", at: 1 };
      await expect(deliver(first)).resolves.toBeUndefined();
      expect(seen, "a 500, a 500, then the 200").toHaveLength(3);
      for (const s of seen) {
        expect(s.body).toBe(first.body);
        expect(s.headers["rtk-signature"]).toBe("c2ln");
        expect(s.headers["rtk-uuid"]).toBe("u-1");
        expect(s.headers["content-type"]).toBe("application/json");
      }
      const second: FixtureWebhook = { ...first, uuid: "u-2" };
      await expect(deliver(second)).rejects.toThrow(/401/);
      expect(seen, "a 401 is not retried").toHaveLength(4);
      expect(seen[3]!.headers["rtk-uuid"]).toBe("u-2");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("gives up after three attempts on a persistent 5xx, rejecting with the last status; a network error is retried too", async () => {
    let calls = 0;
    const w: FixtureWebhook = { uuid: "u-3", event: "meeting.ended", body: "{}", signature: "c2ln", at: 1 };
    const always500 = httpWebhookDeliver("http://hook.invalid/", (async () => {
      calls++;
      return new Response("{}", { status: 503 });
    }) as typeof fetch);
    await expect(always500(w)).rejects.toThrow(/503/);
    expect(calls).toBe(3);

    let tries = 0;
    const flaky = httpWebhookDeliver("http://hook.invalid/", (async () => {
      if (++tries < 3) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await expect(flaky(w)).resolves.toBeUndefined();
    expect(tries).toBe(3);

    const dead = httpWebhookDeliver("http://hook.invalid/", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(dead(w)).rejects.toThrow("fetch failed");
  });
});
