// POST /api/webhooks/realtimekit (check-in capacity plan 1, Task 7): the public route around the receiver usecase. What this file
// pins is the ROUTE: the status each receipt maps to, the bytes the signature is checked over, the 503's Retry-After, the 500 a
// throw becomes, and what a 400 may put in the log. The receiver's own decisions (key refetch, duplicate, apply) are webhook.test.ts's.
//
// The vendor's signing is done here from the contract (RSA-SHA256 over the raw body, Base64, `rtk-signature` / `rtk-uuid` headers),
// against a tiny http server that serves the key at /.well-known/webhooks.json the way the vendor's public document does; the
// route reaches it through REALTIMEKIT_BASE_URL exactly as production reaches Cloudflare's. A DB suite: the held meeting is seeded
// with Task 5's helpers (an event for a meeting we do not hold is ignored), and a foreign meeting is asserted to write nothing.
// Single-sport reason: the route is keyed by meeting, never by sport; the board is chess because only chess holds RealtimeKit meetings.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import * as receiverModule from "@/server/external-play/video/webhook";
import * as signatureModule from "@/server/external-play/video/webhook-signature";
import { putVideoMeeting, putVideoParticipant, seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";
import { POST } from "../route";

/** The repo's real pino `err` serializer (logger.ts is mocked above): what a `{ err }` log field becomes on its way to stdout and Sentry. */
const realErrSerializer = async () => {
  const actual = await vi.importActual<typeof import("@/server/logger")>("@/server/logger");
  return actual.LOGGER_OPTIONS.serializers.err;
};

const DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-11-17T10:00:00.000Z");
const URL_ = "http://x/api/webhooks/realtimekit";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signBytes = (body: Uint8Array) => sign("RSA-SHA256", body, keys.privateKey).toString("base64");

// The vendor's key document, served over real http. `mode` is what it answers; `hits` counts GETs (a refused delivery must not ask).
let keyServer: Server;
let keyServerUrl = "";
let mode: "ok" | "down" = "ok";
let hits = 0;

type Sent = { bytes: Buffer; signature: string; uuid: string };
const uuidsMade: string[] = [];
const meetingsMade: string[] = [];

const eventBody = (o: { event?: string; meetingId: string; peerId?: string; custom?: string; extra?: Record<string, unknown> }) =>
  JSON.stringify({
    event: o.event ?? "meeting.participantJoined",
    meeting: { id: o.meetingId, sessionId: "sess-1", status: "LIVE" },
    participant: { peerId: o.peerId ?? "peer-1", customParticipantId: o.custom ?? "person-x", presetName: "p", joinedAt: T0.toISOString() },
    ...(o.extra ?? {}),
  });
const delivery = (bytes: Buffer, uuid: string = randomUUID()): Sent => {
  uuidsMade.push(uuid);
  return { bytes, signature: signBytes(bytes), uuid };
};
const post = (s: { bytes: Buffer | string; signature?: string | null; uuid?: string | null }) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.signature !== null && s.signature !== undefined) headers["rtk-signature"] = s.signature;
  if (s.uuid !== null && s.uuid !== undefined) headers["rtk-uuid"] = s.uuid;
  return POST(new Request(URL_, { method: "POST", headers, body: typeof s.bytes === "string" ? s.bytes : new Uint8Array(s.bytes) }));
};
const send = (d: Sent) => post(d);

let board: { fixtureId: string; orgId: string; personId: string } | null = null;
let held = "";

const presenceCount = async (meetingId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_video_presence where meeting_id = ${meetingId}`)[0]!.n;
// The rows made under THIS file's uuids, never the table's total: webhook.test.ts (another DB suite) writes deliveries concurrently.
const deliveryCount = async () =>
  uuidsMade.length === 0 ? 0 : (await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`)[0]!.n;
const deliveryRow = async (uuid: string) =>
  sql<{ event: string }[]>`select event from realtimekit_webhook_deliveries where rtk_uuid = ${uuid}`;

beforeAll(async () => {
  keyServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/webhooks.json") {
      hits++;
      if (mode === "down") {
        res.statusCode = 500;
        res.end("down");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: { publicKey: keyPem } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => keyServer.listen(0, "127.0.0.1", r));
  keyServerUrl = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}`;
  if (DB) {
    const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: false, scheduledAt: new Date(Date.now() + 3_600_000), linked: true });
    board = { fixtureId: s.fixtureId, orgId: s.orgId, personId: s.home.personId };
  }
});

beforeEach(async () => {
  mode = "ok";
  hits = 0;
  vi.stubEnv("REALTIMEKIT_BASE_URL", keyServerUrl);
  signatureModule.forgetWebhookKey();
  for (const m of Object.values(logMock)) m.mockClear();
  if (DB) {
    // A FRESH held meeting per test (and its player's participant row, which hangs off the meeting row): no test sees another's rows.
    const b = board!;
    await sql`delete from fixture_video_participants where fixture_id = ${b.fixtureId} and side = 'home'`;
    await sql`delete from fixture_video_meetings where fixture_id = ${b.fixtureId} and side = 'home'`;
    held = await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side: "home" });
    await putVideoParticipant({ fixtureId: b.fixtureId, side: "home", personId: b.personId });
    meetingsMade.push(held);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((r) => keyServer.close(() => r()));
  if (DB) {
    if (uuidsMade.length > 0) await sql`delete from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`;
    if (meetingsMade.length > 0) {
      await sql`delete from video_rooms_to_end where meeting_id in ${sql(meetingsMade)}`; // parked by the per-test meeting delete
      await sql`delete from fixture_video_presence where meeting_id in ${sql(meetingsMade)}`;
      await sql`delete from realtimekit_ended_sessions where meeting_id in ${sql(meetingsMade)}`;
    }
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});

describe.skipIf(!DB)("POST /api/webhooks/realtimekit", () => {
  it("200 for a signed joined event, with the outcome; the delivery and the presence row are written", async () => {
    const d = delivery(Buffer.from(eventBody({ meetingId: held, peerId: "peer-a" })));
    const res = await send(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "applied" });
    expect(await presenceCount(held)).toBe(1);
    expect((await deliveryRow(d.uuid)).map((r) => r.event)).toEqual(["meeting.participantJoined"]);
  });

  it("a repeat of the same rtk-uuid is 200 duplicate and writes nothing more (the second call)", async () => {
    const d = delivery(Buffer.from(eventBody({ meetingId: held })));
    expect(await (await send(d)).json()).toEqual({ received: true, outcome: "applied" });
    const res = await send(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "duplicate" });
    expect(await presenceCount(held)).toBe(1);
  });

  it("the signature is over the BYTES: an invalid-UTF-8 byte inside a signed body still verifies and applies", async () => {
    // A lone 0xFF inside a JSON string value. Decoded with req.text() it becomes U+FFFD, re-encodes to different bytes, and the
    // signature (made over the vendor's bytes) no longer verifies: 401. Read as bytes it is untouched.
    const head = Buffer.from(eventBody({ meetingId: held, extra: { note: "MARK" } }), "utf8");
    const at = head.indexOf("MARK");
    expect(at).toBeGreaterThan(0);
    const bytes = Buffer.concat([head.subarray(0, at), Buffer.from([0xff]), head.subarray(at + 4)]);
    expect(Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)).toBe(false); // the premise: a text round-trip changes these bytes
    const res = await send(delivery(bytes));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "applied" });
  });

  describe("401", () => {
    it("without headers, 401 before any key is asked for and nothing written", async () => {
      const bytes = Buffer.from(eventBody({ meetingId: held }));
      const before = await deliveryCount();
      const checked: number[] = [];
      const [u1, u2] = [randomUUID(), randomUUID()];
      uuidsMade.push(u1, u2);
      for (const h of [
        { signature: null, uuid: u1 },
        { signature: signBytes(bytes), uuid: null },
        { signature: "", uuid: u2 },
        { signature: null, uuid: null },
      ]) {
        const res = await post({ bytes, ...h });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Invalid signature" });
        checked.push(res.status);
      }
      expect(checked).toHaveLength(4);
      // one warn per refusal, carrying the reason and nothing else (the order is the loop's: no signature, no uuid, empty signature, neither)
      expect(logMock.warn.mock.calls.map((c) => c[0])).toEqual([{ reason: "no_signature" }, { reason: "no_uuid" }, { reason: "no_signature" }, { reason: "no_signature" }]);
      expect(hits).toBe(0);
      expect(await presenceCount(held)).toBe(0);
      expect(await deliveryCount()).toBe(before);
    });

    it("a signature that does not verify against a key fetched for this request is 401 and writes nothing", async () => {
      const bytes = Buffer.from(eventBody({ meetingId: held }));
      const forged = sign("RSA-SHA256", bytes, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey).toString("base64");
      const uuid = randomUUID();
      uuidsMade.push(uuid);
      const res = await post({ bytes, signature: forged, uuid });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid signature" });
      expect(logMock.warn.mock.calls.map((c) => c[0])).toEqual([{ reason: "signature" }]);
      const logged = JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls));
      expect(logged).not.toContain(forged);
      expect(logged).not.toContain(bytes.toString("utf8"));
      expect(hits).toBe(1);
      expect(await presenceCount(held)).toBe(0);
      expect(await deliveryRow(uuid)).toHaveLength(0);
    });
  });

  describe("400", () => {
    it("a signed body that is not an event is 400, and the log carries the event name and top-level KEYS only", async () => {
      // A known event missing its participant: signed, parsed, refused. The values are markers that must never reach a log line.
      const secretValue = "VALUE-MUST-NOT-BE-LOGGED";
      const raw = JSON.stringify({ event: "meeting.participantJoined", meeting: { id: secretValue }, trace: secretValue });
      const d = delivery(Buffer.from(raw));
      const res = await send(d);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unreadable body" });
      const warns = logMock.warn.mock.calls;
      expect(warns).toHaveLength(1);
      expect(warns[0]![0]).toEqual({ shape: { event: "meeting.participantJoined", keys: ["event", "meeting", "trace"] } });
      const everything = JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls));
      expect(everything).not.toContain(secretValue);
      expect(everything).not.toContain(d.signature);
      expect(everything).not.toContain(raw);
      expect(await deliveryRow(d.uuid)).toHaveLength(0);
    });

    it("a signed body that is not JSON is 400 and the log carries no part of it", async () => {
      const raw = "not-json-PAYLOAD-MARKER";
      const d = delivery(Buffer.from(raw));
      const res = await send(d);
      expect(res.status).toBe(400);
      expect(JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls))).not.toContain("PAYLOAD-MARKER");
      expect(logMock.warn.mock.calls[0]![0]).toEqual({ shape: null });
    });
  });

  describe("400 shapes", () => {
    it("the logged shape is capped: 25 long keys log 20 keys of at most 64 chars each, and no value", async () => {
      const longKey = (i: number) => `${"k".repeat(80)}${i}`;
      const obj: Record<string, string> = { event: "meeting.participantJoined" }; // a known event missing its participant: signed, parsed, refused
      for (let i = 0; i < 24; i++) obj[longKey(i)] = "VALUE-MUST-NOT-BE-LOGGED";
      expect(Object.keys(obj), "premise: 25 keys").toHaveLength(25);
      const res = await send(delivery(Buffer.from(JSON.stringify(obj))));
      expect(res.status).toBe(400);
      const shape = (logMock.warn.mock.calls[0]![0] as { shape: { event: string | null; keys: string[] } }).shape;
      expect(shape.event).toBe("meeting.participantJoined");
      expect(shape.keys).toHaveLength(20);
      expect(shape.keys.every((k) => k.length <= 64), "no key longer than 64").toBe(true);
      expect(shape.keys.filter((k) => k.length === 64), "the 19 long keys among the 20 kept were cut to exactly 64").toHaveLength(19);
      expect(JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls))).not.toContain("VALUE-MUST-NOT-BE-LOGGED");
    });

    it("a signed body that is an array, a scalar or null is 400 and logs an empty shape (no event, no keys), not the elements", async () => {
      let checked = 0;
      for (const raw of ['["ELEMENT-MARKER", "x"]', "42", "null", '"STRING-MARKER"']) {
        logMock.warn.mockClear();
        const res = await send(delivery(Buffer.from(raw)));
        expect(res.status, raw).toBe(400);
        expect(logMock.warn.mock.calls.map((c) => c[0]), raw).toEqual([{ shape: { event: null, keys: [] } }]);
        expect(JSON.stringify(logMock.warn.mock.calls), raw).not.toMatch(/MARKER/);
        checked += 1;
      }
      expect(checked).toBe(4);
    });

    it("a signed EMPTY body is 400 (nothing parses), logs shape null, and writes no delivery row", async () => {
      const d = delivery(Buffer.alloc(0));
      const res = await send(d);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Unreadable body" });
      expect(logMock.warn.mock.calls.map((c) => c[0])).toEqual([{ shape: null }]);
      expect(await deliveryRow(d.uuid)).toHaveLength(0);
    });
  });

  describe("200 ignored", () => {
    it("a signed event naming a meeting we do not hold is 200 ignored and NO row of any kind is written", async () => {
      const foreign = `mtg-foreign-${randomUUID().slice(0, 8)}`;
      const d = delivery(Buffer.from(eventBody({ meetingId: foreign })));
      const before = await deliveryCount();
      const res = await send(d);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
      expect(await deliveryRow(d.uuid)).toHaveLength(0);
      expect(await deliveryCount()).toBe(before);
      expect(await presenceCount(foreign)).toBe(0);
      expect((await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_ended_sessions where meeting_id = ${foreign}`)[0]!.n).toBe(0);
    });

    it("an event kind we never apply is 200 ignored", async () => {
      const raw = JSON.stringify({ event: "meeting.started", meeting: { id: held } });
      const res = await send(delivery(Buffer.from(raw)));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
      expect(await presenceCount(held)).toBe(0);
    });
  });

  describe("503", () => {
    it("with Retry-After when the key host is down and no key is cached", async () => {
      mode = "down";
      const d = delivery(Buffer.from(eventBody({ meetingId: held })));
      const res = await send(d);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(await res.json()).toEqual({ error: "Key unavailable" });
      expect(logMock.warn.mock.calls.filter((c) => (c[0] as { reason?: string }).reason === "key_unavailable"), "one route warn with the receipt's reason").toHaveLength(1);
      expect(hits).toBeGreaterThan(0);
      expect(await presenceCount(held)).toBe(0);
      expect(await deliveryRow(d.uuid)).toHaveLength(0);
      // and the vendor's retry once the host is back applies (the 503 lost nothing)
      mode = "ok";
      signatureModule.forgetWebhookKey();
      expect(await (await send(d)).json()).toEqual({ received: true, outcome: "applied" });
    });

    it("for a malformed REALTIMEKIT_BASE_URL (the key path throws), never a 500", async () => {
      vi.stubEnv("REALTIMEKIT_BASE_URL", "not a url");
      const res = await send(delivery(Buffer.from(eventBody({ meetingId: held }))));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    });

    it("for ANY throw out of the key path, not only WebhookKeyUnavailableError", async () => {
      const spy = vi.spyOn(signatureModule, "webhookPublicKey").mockRejectedValue(new TypeError("not a WebhookKeyUnavailableError"));
      const res = await send(delivery(Buffer.from(eventBody({ meetingId: held }))));
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    });
  });

  describe("500", () => {
    it("when the receiver throws, so the vendor retries; the error is logged as { err } and, through the logger's own serializer, carries no bound parameter, row or statement", async () => {
      const driverError = Object.assign(new Error("insert failed"), {
        code: "XX000",
        parameters: ["PARAMS-MARKER"],
        detail: "Failing row contains (DETAIL-MARKER)",
        query: "insert into t values ($1) QUERY-MARKER",
      });
      const spy = vi.spyOn(receiverModule, "receiveRealtimeKitWebhook").mockRejectedValueOnce(driverError);
      const d = delivery(Buffer.from(eventBody({ meetingId: held, extra: { note: "BODY-MARKER" } })));
      const res = await send(d);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Processing failed" });
      expect(logMock.error).toHaveBeenCalledTimes(1);
      const fields = logMock.error.mock.calls[0]![0] as { err: unknown };
      expect(Object.keys(fields), "logged as { err } and nothing else (no hand-picked subset)").toEqual(["err"]);
      expect(fields.err).toBe(driverError);
      // What reaches stdout: the line's fields through the REAL serializer. The marker-carrying fields must be gone, the diagnosis kept.
      const printed = (await realErrSerializer())(fields.err) as Record<string, unknown>;
      const text = JSON.stringify(printed);
      for (const marker of ["PARAMS-MARKER", "DETAIL-MARKER", "QUERY-MARKER"]) expect(text, marker).not.toContain(marker);
      expect(printed).toMatchObject({ type: "Error", message: "insert failed", code: "XX000" });
      // the request body and the signature are never in any log call
      const everything = JSON.stringify(Object.values(logMock).flatMap((m) => m.mock.calls));
      expect(everything).not.toContain("BODY-MARKER");
      expect(everything).not.toContain(d.signature);
      // the throw rolled nothing in: the vendor's retry of the same uuid applies
      expect(await deliveryRow(d.uuid)).toHaveLength(0);
      expect(await (await send(d)).json()).toEqual({ received: true, outcome: "applied" });
    });

    it("a throw that is not an Error (a string) is still a 500 and one error line", async () => {
      vi.spyOn(receiverModule, "receiveRealtimeKitWebhook").mockRejectedValueOnce("just a string");
      const res = await send(delivery(Buffer.from(eventBody({ meetingId: held }))));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Processing failed" });
      expect(logMock.error).toHaveBeenCalledTimes(1);
    });
  });
});
