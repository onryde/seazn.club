// Check-in capacity plan 1, Task 6 (spec §6.2): the webhook receiver usecase - verify the signature, parse, record the delivery id,
// apply presence. The route (Task 7) only wraps it.
//
// Expected values come from the vendor's own shapes (spec §6.2 bodies) and, for the real-producer test, from the FIXTURE's own
// record read back over HTTP (its peer events and sessions), never from the receiver's output. Every sweep reports what it checked
// and zero checked fails (TEST-STRATEGY.md). Single-sport reason: the receiver is keyed by meeting, never by sport; the seeded
// board is a chess board because that is the only product that holds RealtimeKit meetings.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { REALTIMEKIT_FIXTURE_ENV, startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../../../../../e2e/realtimekit-fixture-server";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture } from "../../../usecases/__tests__/_external-play-seed";
import { applyPresenceEvent } from "../presence";
import { forgetWebhookKey } from "../webhook-signature";
import { receiveRealtimeKitWebhook as receive, type WebhookDeps } from "../webhook";

const DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-11-17T10:00:00.000Z");

const pair = () => {
  const k = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pem: k.publicKey.export({ type: "spki", format: "pem" }).toString(), priv: k.privateKey };
};
const keys = pair();
const oldKeys = pair();
const signedWith = (priv: typeof keys.priv, body: string | Uint8Array) => sign("RSA-SHA256", typeof body === "string" ? Buffer.from(body, "utf8") : body, priv).toString("base64");
const signed = (body: string | Uint8Array) => signedWith(keys.priv, body);
const publicKey: NonNullable<WebhookDeps["publicKey"]> = async () => ({ key: keys.pem, fetched: true });

const uuidsMade: string[] = [];
const meetingsMade: string[] = [];

type Delivery = { rawBody: string; signature: string; uuid: string };
const body = (o: { event: string; meetingId: string; peerId?: string; custom?: string; sessionId?: string; at?: Date; extra?: Record<string, unknown> }) =>
  JSON.stringify({
    event: o.event,
    meeting: { id: o.meetingId, sessionId: o.sessionId ?? "sess-1", status: o.event === "meeting.ended" ? "ENDED" : "LIVE", ...(o.event === "meeting.ended" ? { endedAt: (o.at ?? T0).toISOString() } : {}) },
    ...(o.event === "meeting.ended"
      ? {}
      : {
          participant: {
            peerId: o.peerId ?? "peer-1",
            customParticipantId: o.custom ?? "person-x",
            presetName: "p",
            joinedAt: (o.at ?? T0).toISOString(),
            ...(o.event === "meeting.participantLeft" ? { leftAt: new Date((o.at ?? T0).getTime() + 5_000).toISOString() } : {}),
          },
        }),
    ...(o.extra ?? {}),
  });
const delivery = (rawBody: string, uuid: string = randomUUID()): Delivery => {
  uuidsMade.push(uuid);
  return { rawBody, signature: signed(rawBody), uuid };
};

let seeded: { fixtureId: string; orgId: string; personId: string; meetingId: string };

const deliveryCount = async (uuid?: string) => {
  // No uuid: the rows THIS file's deliveries made (never the table's total: another DB suite, the route's, writes deliveries concurrently).
  const [r] = uuid === undefined
    ? uuidsMade.length === 0 ? [{ n: 0 }] : await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`
    : await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_webhook_deliveries where rtk_uuid = ${uuid}`;
  return r!.n;
};
const presenceRows = (meetingId: string) =>
  sql<{ peer_id: string; session_id: string | null; joined_at: Date | null; left_at: Date | null; left_by: string | null; source: string }[]>`
    select peer_id, session_id, joined_at, left_at, left_by, source from fixture_video_presence where meeting_id = ${meetingId} order by peer_id`;
const endedRows = (meetingId: string) =>
  sql<{ session_id: string; ended_at: Date }[]>`select session_id, ended_at from realtimekit_ended_sessions where meeting_id = ${meetingId} order by session_id`;
const state = async (meetingId: string) => ({ presence: await presenceRows(meetingId), ended: await endedRows(meetingId), deliveries: await deliveryCount() });

const joined = (o: { meetingId?: string; uuid?: string; peerId?: string } = {}) =>
  delivery(body({ event: "meeting.participantJoined", meetingId: o.meetingId ?? seeded.meetingId, peerId: o.peerId, custom: seeded.personId }), o.uuid);

// ONE seeded board for the file (a seed is the slow part); each test gets a FRESH meeting on it (and its player's participant row, which
// hangs off the meeting row), so no test sees another's rows.
let board: { fixtureId: string; orgId: string; personId: string } | null = null;
async function freshMeeting(meetingId?: string): Promise<string> {
  const b = board!;
  await sql`delete from fixture_video_participants where fixture_id = ${b.fixtureId} and side = 'home'`;
  await sql`delete from fixture_video_meetings where fixture_id = ${b.fixtureId} and side = 'home'`;
  const id = await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side: "home" }, meetingId === undefined ? {} : { meetingId });
  await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: b.personId });
  meetingsMade.push(id);
  return id;
}
beforeEach(async () => {
  if (!DB) return;
  forgetWebhookKey();
  if (board === null) {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: false, scheduledAt: new Date(Date.now() + 3_600_000), linked: true });
    board = { fixtureId: s.fixtureId, orgId: s.orgId, personId: s.home.personId };
  }
  seeded = { ...board, meetingId: await freshMeeting() };
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  if (DB) {
    if (uuidsMade.length > 0) await sql`delete from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`;
    if (meetingsMade.length > 0) {
      await sql`delete from video_rooms_to_end where meeting_id in ${sql(meetingsMade)}`; // parked by freshMeeting's delete
      await sql`delete from fixture_video_presence where meeting_id in ${sql(meetingsMade)}`;
      await sql`delete from realtimekit_ended_sessions where meeting_id in ${sql(meetingsMade)}`;
    }
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});

describe.skipIf(!DB)("receiveRealtimeKitWebhook", () => {
  it("applies a signed joined event and records the delivery", async () => {
    const w = joined();
    expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "applied" });
    const rows = await presenceRows(seeded.meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ peer_id: "peer-1", session_id: "sess-1", left_at: null, left_by: null, source: "webhook" });
    expect(rows[0]!.joined_at).toEqual(T0);
    expect(await deliveryCount(w.uuid)).toBe(1);
    const [d] = await sql<{ event: string }[]>`select event from realtimekit_webhook_deliveries where rtk_uuid = ${w.uuid}`;
    expect(d!.event).toBe("meeting.participantJoined");
  });

  it("a repeat of the same rtk-uuid is a 200 duplicate and changes no row", async () => {
    const w = joined();
    await receive(w, { publicKey });
    const before = await state(seeded.meetingId);
    expect(before.presence).toHaveLength(1);
    expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "duplicate" });
    expect(await state(seeded.meetingId)).toEqual(before);
  });

  it("two concurrent deliveries of the same rtk-uuid: exactly one applies, one is a duplicate, one presence row", async () => {
    const w = joined();
    const outcomes = await Promise.all([receive(w, { publicKey }), receive(w, { publicKey })]);
    expect(outcomes.map((o) => (o.status === 200 ? o.outcome : o.status)).sort()).toEqual(["applied", "duplicate"]);
    expect(await presenceRows(seeded.meetingId)).toHaveLength(1);
    expect(await deliveryCount(w.uuid)).toBe(1);
  });

  it("no signature, no uuid, a bad signature: 401 and nothing written", async () => {
    const good = joined();
    const before = await state(seeded.meetingId);
    const calls = vi.fn(publicKey);
    expect(await receive({ rawBody: good.rawBody, signature: null, uuid: good.uuid }, { publicKey: calls })).toEqual({ status: 401, reason: "no_signature" });
    expect(await receive({ rawBody: good.rawBody, signature: good.signature, uuid: null }, { publicKey: calls })).toEqual({ status: 401, reason: "no_uuid" });
    // the header checks cost no key fetch
    expect(calls).not.toHaveBeenCalled();
    expect(await receive({ rawBody: good.rawBody, signature: signedWith(oldKeys.priv, good.rawBody), uuid: good.uuid }, { publicKey })).toEqual({ status: 401, reason: "signature" });
    // a tampered body under a genuine signature
    expect(await receive({ rawBody: good.rawBody.replace("peer-1", "peer-9"), signature: good.signature, uuid: good.uuid }, { publicKey })).toEqual({ status: 401, reason: "signature" });
    expect(await state(seeded.meetingId)).toEqual(before);
    expect(await deliveryCount(good.uuid)).toBe(0);
  });

  it("a signature that fails against a key fetched for THIS request is 401 at once, with no forced second ask (m4)", async () => {
    const good = joined();
    const stub = vi.fn<NonNullable<WebhookDeps["publicKey"]>>(async () => ({ key: oldKeys.pem, fetched: true }));
    expect(await receive(good, { publicKey: stub })).toEqual({ status: 401, reason: "signature" });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith({});
    expect(await deliveryCount(good.uuid)).toBe(0);
  });

  it("a rotated key: the first verification fails, one forced refetch returns the new key, and the event applies", async () => {
    const w = joined();
    const stub = vi.fn<NonNullable<WebhookDeps["publicKey"]>>(async (o) => (o.force ? { key: keys.pem, fetched: true } : { key: oldKeys.pem, fetched: false }));
    expect(await receive(w, { publicKey: stub })).toEqual({ status: 200, outcome: "applied" });
    expect(stub.mock.calls.map((c) => c[0].force === true)).toEqual([false, true]);
    expect(await deliveryCount(w.uuid)).toBe(1);
  });

  it("still failing after a FRESH forced refetch is 401", async () => {
    const w = joined();
    const before = await state(seeded.meetingId);
    const stub = vi.fn<NonNullable<WebhookDeps["publicKey"]>>(async (o) => ({ key: oldKeys.pem, fetched: !!o.force }));
    expect(await receive(w, { publicKey: stub })).toEqual({ status: 401, reason: "signature" });
    expect(stub.mock.calls.map((c) => c[0].force === true)).toEqual([false, true]);
    expect(await state(seeded.meetingId)).toEqual(before);
  });

  it("a forced refetch the floor suppressed (fetched: false) is 503 key_unavailable, nothing written, and the same delivery retried after the floor applies", async () => {
    const w = joined();
    const before = await state(seeded.meetingId);
    const floored = vi.fn<NonNullable<WebhookDeps["publicKey"]>>(async () => ({ key: oldKeys.pem, fetched: false }));
    expect(await receive(w, { publicKey: floored })).toEqual({ status: 503, reason: "key_unavailable" });
    expect(floored).toHaveBeenCalledTimes(2);
    expect(await deliveryCount(w.uuid)).toBe(0);
    expect(await state(seeded.meetingId)).toEqual(before);
    const afterFloor = vi.fn<NonNullable<WebhookDeps["publicKey"]>>(async (o) => (o.force ? { key: keys.pem, fetched: true } : { key: oldKeys.pem, fetched: false }));
    expect(await receive(w, { publicKey: afterFloor })).toEqual({ status: 200, outcome: "applied" });
    expect(await deliveryCount(w.uuid)).toBe(1);
  });

  it("a key lookup that throws (no key ever fetched, a malformed base, any error) is 503, never a throw, at either ask", async () => {
    const w = joined();
    const before = await state(seeded.meetingId);
    const never = async () => {
      throw new Error("no key");
    };
    expect(await receive(w, { publicKey: never })).toEqual({ status: 503, reason: "key_unavailable" });
    // the first ask answers (cached, stale), the forced one throws
    const forcedThrows = async (o: { force?: boolean }) => {
      if (o.force) throw new Error("fetch down");
      return { key: oldKeys.pem, fetched: false };
    };
    expect(await receive(w, { publicKey: forcedThrows })).toEqual({ status: 503, reason: "key_unavailable" });
    expect(await state(seeded.meetingId)).toEqual(before);
  });

  it("a forced refetch that JOINED another request's fetch (fetched: false) but brought the right key still verifies", async () => {
    const w = joined();
    const stub = async (o: { force?: boolean }) => (o.force ? { key: keys.pem, fetched: false } : { key: oldKeys.pem, fetched: false });
    expect(await receive(w, { publicKey: stub })).toEqual({ status: 200, outcome: "applied" });
  });

  it("a signed event for a meeting we do not hold is 200 ignored and writes NOTHING: no delivery row, no presence row", async () => {
    const foreign = `m-foreign-${randomUUID().slice(0, 8)}`;
    meetingsMade.push(foreign);
    const w = joined({ meetingId: foreign });
    const before = await deliveryCount();
    const info = vi.spyOn(log, "info");
    expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "ignored" });
    expect(await deliveryCount(w.uuid)).toBe(0);
    expect(await deliveryCount()).toBe(before);
    expect(await presenceRows(foreign)).toHaveLength(0);
    expect(await endedRows(foreign)).toHaveLength(0);
    // the log line names the meeting id and nothing else
    const line = info.mock.calls.find((c) => String(c[1]).includes("realtimekit-webhook: foreign meeting"));
    expect(line?.[0]).toEqual({ meetingId: foreign });
    info.mockRestore();
    // a foreign ENDED too (an ended-session row is a write)
    const ended = delivery(body({ event: "meeting.ended", meetingId: foreign }));
    expect(await receive(ended, { publicKey })).toEqual({ status: 200, outcome: "ignored" });
    expect(await endedRows(foreign)).toHaveLength(0);
    expect(await deliveryCount(ended.uuid)).toBe(0);
  });

  it("a meeting known only through its presence rows (the parked room ended and its parking row deleted) still takes meeting.ended", async () => {
    await receive(joined(), { publicKey });
    expect(await presenceRows(seeded.meetingId)).toHaveLength(1);
    // the meeting row goes, and its delete PARKS the room (V460's trigger); the sweep then ended it and deleted the parking row: only the
    // presence row's board still names the meeting
    await sql`delete from fixture_video_meetings where meeting_id = ${seeded.meetingId}`;
    expect((await sql`delete from video_rooms_to_end where meeting_id = ${seeded.meetingId} returning meeting_id`).length, "premise: the delete parked the room").toBe(1);
    const end = delivery(body({ event: "meeting.ended", meetingId: seeded.meetingId, at: new Date(T0.getTime() + 60_000) }));
    expect(await receive(end, { publicKey })).toEqual({ status: 200, outcome: "applied" });
    const [row] = await presenceRows(seeded.meetingId);
    expect(row).toMatchObject({ left_by: "ended" });
    expect(row!.left_at).toEqual(new Date(T0.getTime() + 60_000));
    expect(await deliveryCount(end.uuid)).toBe(1);
  });

  it("an unparseable body is 400 and nothing written", async () => {
    const before = await state(seeded.meetingId);
    let checked = 0;
    for (const raw of ["not json", JSON.stringify({ x: 1 }), body({ event: "meeting.participantJoined", meetingId: seeded.meetingId }).replace(/"joinedAt":"[^"]*"/, '"joinedAt":"12"')]) {
      const u = randomUUID();
      uuidsMade.push(u);
      expect(await receive({ rawBody: raw, signature: signed(raw), uuid: u }, { publicKey }), raw).toEqual({ status: 400, reason: "unparseable" });
      expect(await deliveryCount(u)).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(await state(seeded.meetingId)).toEqual(before);
  });

  it("an event the receiver does not apply is 200 ignored and writes nothing, not even its delivery row (we subscribe to three events only; no third party may make the route insert)", async () => {
    const w = delivery(JSON.stringify({ event: "meeting.started", meeting: { id: seeded.meetingId, sessionId: "sess-1" } }));
    const before = await state(seeded.meetingId);
    expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "ignored" });
    expect(await deliveryCount(w.uuid)).toBe(0);
    expect(await state(seeded.meetingId)).toEqual(before);
  });

  it("a storage failure throws and leaves NO delivery row, so the vendor's retry with the same uuid applies", async () => {
    const w = joined();
    await expect(
      receive(w, {
        publicKey,
        apply: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
    expect(await deliveryCount(w.uuid)).toBe(0);
    expect(await presenceRows(seeded.meetingId)).toHaveLength(0);
    expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "applied" });
    expect(await deliveryCount(w.uuid)).toBe(1);
  });

  it("passes the held board it gated on to apply, and the receipt time as the injected clock", async () => {
    const w = joined();
    const apply = vi.fn<NonNullable<WebhookDeps["apply"]>>((db, ev, at, held) => applyPresenceEvent(db, ev, at, held));
    const now = new Date("2026-11-17T12:34:56.000Z");
    expect(await receive(w, { publicKey, apply, now })).toEqual({ status: 200, outcome: "applied" });
    expect(apply).toHaveBeenCalledTimes(1);
    const [, ev, at, held] = apply.mock.calls[0]!;
    expect(ev.kind).toBe("joined");
    expect(at).toEqual(now);
    expect(held).toEqual({ fixtureId: seeded.fixtureId, side: "home" });
    const [r] = await sql<{ received_at: Date }[]>`select received_at from fixture_video_presence where meeting_id = ${seeded.meetingId}`;
    expect(r!.received_at).toEqual(now);
  });

  it("verifies the RAW BYTES: a body carrying an invalid UTF-8 byte (which a decode and re-encode would change) applies when signed over its bytes (I2)", async () => {
    const text = body({ event: "meeting.participantJoined", meetingId: seeded.meetingId, custom: seeded.personId, extra: { note: "@@" } });
    const bytes = new Uint8Array(Buffer.from(text, "utf8"));
    const at = Buffer.from(text, "utf8").indexOf("@@");
    bytes[at] = 0xff;
    bytes[at + 1] = 0xfe;
    const u = randomUUID();
    uuidsMade.push(u);
    // the decoded-and-re-encoded form is a different byte string (this is what a `req.text()` receiver would sign over)
    const reencoded = Buffer.from(Buffer.from(bytes).toString("utf8"), "utf8");
    expect(Buffer.compare(Buffer.from(bytes), reencoded)).not.toBe(0);
    expect(await receive({ rawBody: bytes, signature: signed(bytes), uuid: u }, { publicKey })).toEqual({ status: 200, outcome: "applied" });
    expect(await presenceRows(seeded.meetingId)).toHaveLength(1);
    // and a signature made over the decoded text does NOT verify the bytes
    const u2 = randomUUID();
    uuidsMade.push(u2);
    expect(await receive({ rawBody: bytes, signature: signed(reencoded), uuid: u2 }, { publicKey })).toEqual({ status: 401, reason: "signature" });
  });
});

// AGENTS.md failure class 1: the seam is proven only through its REAL producer. The fixture vendor emits signed webhooks for a
// join, a leave and the session's end, and its deliverer IS the receiver (no HTTP in between, no hand-built body); the key is the
// fixture's own served key, fetched through the real key cache.
describe.skipIf(!DB)("receiveRealtimeKitWebhook driven by the fixture vendor (real producer)", () => {
  let fx: RealtimeKitFixtureServer;
  const receipts: { uuid: string; receipt: Awaited<ReturnType<typeof receive>> }[] = [];
  beforeAll(async () => {
    fx = await startRealtimeKitFixtureServer(0, {
      webhooks: async (w) => {
        const receipt = await receive({ rawBody: w.body, signature: w.signature, uuid: w.uuid });
        receipts.push({ uuid: w.uuid, receipt });
        if (receipt.status !== 200) throw new Error(`receiver answered ${receipt.status}`);
      },
    });
  });
  afterAll(() => fx.close());

  const AUTH = { Authorization: `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, "Content-Type": "application/json" };
  const kit = (path: string, init: RequestInit = {}) => fetch(`${fx.url}${fx.kitPath}${path}`, { ...init, headers: AUTH });

  it("a join, a leave and the end drive the real rows: the fixture's own stamps, session and delivery ids", async () => {
    await fx.reset();
    receipts.length = 0;
    // the key is fetched from the fixture's own origin through the real cache
    vi.stubEnv("REALTIMEKIT_BASE_URL", `${fx.url}/client/v4`);

    const meetingId = ((await (await kit("/meetings", { method: "POST", body: JSON.stringify({ title: "seazn-t6" }) })).json()) as { data: { id: string } }).data.id;
    // the file's board, its meeting row re-pointed at the fixture's own meeting id (the one the fixture's webhooks will name)
    await freshMeeting(meetingId);
    const participantId = ((await (
      await kit(`/meetings/${meetingId}/participants`, {
        method: "POST",
        body: JSON.stringify({ custom_participant_id: seeded.personId, preset_name: REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_PLAYER_PRESET }),
      })
    ).json()) as { data: { id: string } }).data.id;

    fx.setLivePublisher(participantId, true);
    const peerId = fx.currentPeer(participantId)!;
    fx.setLivePublisher(participantId, false);
    await fx.webhooksSettled();
    expect(fx.lastWebhookError()).toBeUndefined();

    // what the fixture itself recorded, read back over HTTP
    const session = fx.sessions(meetingId).at(-1)!;
    const sessions = ((await (await kit(`/sessions?associated_id=${meetingId}`)).json()) as { data: { sessions: { id: string; ended_at: string }[] } }).data.sessions;
    const endedAt = sessions.find((x) => x.id === session.id)!.ended_at;
    const parts = ((await (await kit(`/sessions/${session.id}/participants?include_peer_events=true`)).json()) as {
      data: { participants: { peer_events: { event_name: string; peer_id: string; created_at: string }[] }[] };
    }).data.participants;
    const events = parts.flatMap((p) => p.peer_events).filter((e) => e.peer_id === peerId);
    const joiningAt = events.find((e) => e.event_name === "PEER_JOINING")!.created_at;
    const leavingAt = events.find((e) => e.event_name === "PEER_LEAVING")!.created_at;

    // every webhook was delivered and accepted, and there were three of them (join, leave, end)
    expect(fx.webhooks.length).toBe(3);
    expect(receipts.map((r) => r.receipt.status)).toEqual(fx.webhooks.map(() => 200));
    expect(receipts.map((r) => (r.receipt.status === 200 ? r.receipt.outcome : null))).toEqual(fx.webhooks.map(() => "applied"));

    const rows = await presenceRows(meetingId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.peer_id).toBe(peerId);
    expect(row.session_id).toBe(session.id);
    expect(row.joined_at).toEqual(new Date(joiningAt));
    expect(row.left_at).toEqual(new Date(leavingAt));
    expect(row.left_by).toBe("left");
    expect(row.source).toBe("webhook");
    const ended = await endedRows(meetingId);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.session_id).toBe(session.id);
    expect(ended[0]!.ended_at).toEqual(new Date(endedAt));

    // the deliveries ledger holds exactly the fixture's uuids (arrival order is never asserted: deliveries are concurrent)
    const mine = fx.webhooks.map((w) => w.uuid);
    uuidsMade.push(...mine);
    const recorded = await sql<{ rtk_uuid: string }[]>`select rtk_uuid from realtimekit_webhook_deliveries where rtk_uuid in ${sql(mine)}`;
    expect(mine.length).toBeGreaterThan(0);
    expect(recorded.map((r) => r.rtk_uuid).sort()).toEqual([...mine].sort());
  });
});
