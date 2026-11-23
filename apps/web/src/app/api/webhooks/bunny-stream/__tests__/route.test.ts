// POST /api/webhooks/bunny-stream (Seazn-hosted video, Phase 2 Task 27): the public route around `applyBunnyEvent`, driven through
// its REAL handler. What this file pins is the ROUTE: the signature is checked on the raw body before anything else (401, no detail,
// nothing written), the REPLAY flag (off: 200 `{ ignored: true }`, nothing written), a signed body that is not an event (200,
// nothing written), a throw (500, so Bunny retries, its mark released), and that no key, signature or body reaches a log line. The
// use case's own decisions are seazn-replay-webhook.test.ts's.
//
// Bunny's signing is done here from its contract (B6: lowercase hex HMAC-SHA256 of the raw body keyed with the library's Read-Only
// key; `X-BunnyStream-Signature`, `-Version: v1`, `-Algorithm: hmac-sha256`); the vectors that pin the formula itself are literals in
// video/__tests__/bunny-webhook.test.ts. The settings are fake env values, never a real key.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport rule; every rig rides `generic`.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { FakeReplayHost } from "@/server/video/replay-fake";
import { setReplayDriverForTest } from "@/server/video/replay-driver";
import { discoveredReplays, replayRowsOf } from "@/server/video/__tests__/_seazn-replay-rig";
import { installSeaznEnv, seaznRig } from "@/server/video/__tests__/_seazn-session-rig";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
/** A replay fake whose copy ids are this test's own: the webhook looks a copy up by its id across the whole table (Bunny's guids are
 *  unique in the library, and one row per copy since V543), so a readable prefix of this test's own keeps its ids apart. */
const freshHost = () => new FakeReplayHost({ idPrefix: `t27-${randomUUID()}` });
const URL_ = "https://test.local/api/webhooks/bunny-stream";
const SETTINGS = {
  BUNNY_STREAM_LIBRARY_ID: "424242",
  BUNNY_STREAM_API_KEY: "ZZ-api-key-webhook-route",
  BUNNY_STREAM_READONLY_KEY: "ZZ-read-only-webhook-route",
  BUNNY_STREAM_CDN_HOST: "vz-webhook-route.b-cdn.net",
  BUNNY_TOKEN_KEY: "ZZ-token-key-webhook-route",
} as const;
const SECRETS = [SETTINGS.BUNNY_STREAM_API_KEY, SETTINGS.BUNNY_STREAM_READONLY_KEY, SETTINGS.BUNNY_TOKEN_KEY];

installSeaznEnv("t27-webhook-route");
beforeEach(() => {
  for (const [k, v] of Object.entries(SETTINGS)) vi.stubEnv(k, v);
  vi.stubEnv("SEAZN_HOSTED_REPLAY", "true");
  for (const fn of Object.values(logMock)) fn.mockClear();
});
afterEach(() => setReplayDriverForTest(null));

const bodyOf = (o: { guid: string; status: number; eventId?: string; library?: number }) =>
  JSON.stringify({ IsLiveStreamWebhook: false, VideoLibraryId: o.library ?? 424242, VideoGuid: o.guid, Status: o.status, EventId: o.eventId ?? `evt-${randomUUID()}`, Timestamp: "2026-11-23T10:00:00.1234567Z" });
const eventIdOf = (raw: string) => (JSON.parse(raw) as { EventId: string }).EventId;
/** The contract's signature: lowercase hex HMAC-SHA256 of these exact bytes under the Read-Only key. */
const signed = (raw: string, key: string = SETTINGS.BUNNY_STREAM_READONLY_KEY) => createHmac("sha256", key).update(raw, "utf8").digest("hex");
const sent: string[] = [];
function post(raw: string, h: { signature?: string | null; version?: string | null; algorithm?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = h.signature === undefined ? signed(raw) : h.signature;
  if (signature !== null) { headers["X-BunnyStream-Signature"] = signature; sent.push(signature); }
  const version = h.version === undefined ? "v1" : h.version;
  if (version !== null) headers["X-BunnyStream-Signature-Version"] = version;
  const algorithm = h.algorithm === undefined ? "hmac-sha256" : h.algorithm;
  if (algorithm !== null) headers["X-BunnyStream-Signature-Algorithm"] = algorithm;
  sent.push(raw);
  return POST(new Request(URL_, { method: "POST", headers, body: raw }));
}
const marksOf = async (eventId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from bunny_webhook_events where event_id = ${eventId}`)[0]!.n;
/** Every log line this file's deliveries produced, as text: none may hold a key, a signature sent or a body sent. */
function noSecretLogged(): number {
  const lines = Object.values(logMock).flatMap((fn) => fn.mock.calls.map((c) => JSON.stringify(c)));
  for (const line of lines) {
    for (const s of SECRETS) expect(line).not.toContain(s);
    // A short probe body ("[]") is no secret and reads like any empty list; every body and signature this file signs is longer.
    for (const s of sent.filter((x) => x.length >= 32)) expect(line).not.toContain(s);
  }
  return lines.length;
}

/** A Seazn match whose one recording the real move put on a replay fake, installed as this process's replay driver: the row is
 *  `encoding`, holding the copy, and the host has finished it. */
async function encodingRow() {
  const r = await seaznRig();
  const host = freshHost();
  const d = await discoveredReplays(r, r.fixtureIds[0], host);
  await d.move(d.t0);
  const [row] = await replayRowsOf(r.fixtureIds[0]);
  expect(row?.state, "PREMISE: the copy is on the host, encoding").toBe("encoding");
  host.advance(row!.bunny_video_id!);
  setReplayDriverForTest(host);
  return { host, row: row!, fixtureId: r.fixtureIds[0] };
}

describe.skipIf(!HAS_DB)("POST /api/webhooks/bunny-stream", () => {
  it("EMPTY CASE FIRST: a delivery that is not Bunny's — no signature, another key's, one byte changed, version v2, another algorithm, or no key configured — is 401 with no detail, nothing marked, nothing read; the same body signed right then applies", async () => {
    const w = await encodingRow();
    const video = vi.spyOn(w.host, "video");
    const raw = bodyOf({ guid: w.row.bunny_video_id!, status: 3 });
    const refused: [string, () => Promise<Response>][] = [
      ["no signature", () => post(raw, { signature: null })],
      ["another key's signature", () => post(raw, { signature: signed(raw, "ZZ-someone-else") })],
      ["one byte of the body changed", () => post(raw.replace('"Status":3', '"Status":4'), { signature: signed(raw) })],
      ["version v2", () => post(raw, { version: "v2" })],
      ["no version header", () => post(raw, { version: null })],
      ["another algorithm", () => post(raw, { algorithm: "hmac-sha512" })],
      ["no Read-Only key configured", async () => { vi.stubEnv("BUNNY_STREAM_READONLY_KEY", ""); try { return await post(raw); } finally { vi.stubEnv("BUNNY_STREAM_READONLY_KEY", SETTINGS.BUNNY_STREAM_READONLY_KEY); } }],
    ];
    let checked = 0;
    for (const [label, send] of refused) {
      const res = await send();
      expect(res.status, label).toBe(401);
      expect(await res.json(), `${label}: no detail`).toEqual({ error: "Invalid signature" });
      checked++;
    }
    expect(checked).toBe(7);
    expect(await marksOf(eventIdOf(raw)), "nothing marked").toBe(0);
    expect(video, "the host was never read").not.toHaveBeenCalled();
    expect((await replayRowsOf(w.fixtureId))[0]!.state).toBe("encoding");
    expect(logMock.warn.mock.calls.filter(([, msg]) => msg === "bunny-webhook: delivery refused"), "one line per refusal").toHaveLength(7);

    const ok = await post(raw);
    expect(ok.status, "the positive pair").toBe(200);
    expect(await ok.json()).toEqual({ received: true, outcome: "applied" });
    expect((await replayRowsOf(w.fixtureId))[0]!.state, "the route handed the use case its library and this process's host").toBe("playable");
    expect(noSecretLogged(), "PREMISE: lines were logged").toBeGreaterThan(0);
  });

  it("the signature is checked on the bytes AS SENT: a pretty-printed delivery signed as sent applies; signed over its compact re-serialisation, it is 401", async () => {
    const w = await encodingRow();
    const compact = bodyOf({ guid: w.row.bunny_video_id!, status: 3 });
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    expect(pretty, "PREMISE: the bytes differ").not.toBe(compact);
    const refused = await post(pretty, { signature: signed(compact) });
    expect(refused.status).toBe(401);
    const ok = await post(pretty);
    expect([ok.status, await ok.json()]).toEqual([200, { received: true, outcome: "applied" }]);
    expect((await replayRowsOf(w.fixtureId))[0]!.state).toBe("playable");
  });

  it("REPLAY off: a signed delivery is 200 `{ ignored: true }` — nothing marked, nothing read, the row untouched (the poll catches up once it is on); on, the same delivery applies", async () => {
    const w = await encodingRow();
    const video = vi.spyOn(w.host, "video");
    vi.stubEnv("SEAZN_HOSTED_REPLAY", "false");
    const raw = bodyOf({ guid: w.row.bunny_video_id!, status: 4 });
    const off = await post(raw);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ignored: true });
    expect(await marksOf(eventIdOf(raw))).toBe(0);
    expect(video).not.toHaveBeenCalled();
    expect((await replayRowsOf(w.fixtureId))[0]!.state).toBe("encoding");
    vi.stubEnv("SEAZN_HOSTED_REPLAY", "true");
    const on = await post(raw);
    expect(await on.json()).toEqual({ received: true, outcome: "applied" });
    expect(await marksOf(eventIdOf(raw))).toBe(1);
  });

  it("an apply that throws is 500 (Bunny retries it), with its mark released; Bunny's redelivery of the same event then applies", async () => {
    const w = await encodingRow();
    vi.spyOn(w.host, "video").mockRejectedValueOnce(new Error("bunny video: request failed before a response (video x)"));
    const raw = bodyOf({ guid: w.row.bunny_video_id!, status: 3 });
    const failed = await post(raw);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Processing failed" });
    expect(await marksOf(eventIdOf(raw)), "released: the redelivery is not a duplicate").toBe(0);
    expect(logMock.error.mock.calls.some(([, msg]) => typeof msg === "string" && msg.startsWith("bunny-webhook: applying the event failed"))).toBe(true);
    const again = await post(raw);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, outcome: "applied" });
    expect((await replayRowsOf(w.fixtureId))[0]!.state).toBe("playable");
    noSecretLogged();
  });

  it("a SIGNED body that is not one of Bunny's events (not JSON, a field missing) is 200 `{ ignored: true }`, nothing marked; a repeat is `duplicate`; another library is `ignored`", async () => {
    const w = await encodingRow();
    const video = vi.spyOn(w.host, "video");
    for (const raw of ["not json", "[]", JSON.stringify({ VideoLibraryId: 424242, VideoGuid: w.row.bunny_video_id, Status: 3 })]) {
      const res = await post(raw);
      expect([raw, res.status, await res.json()]).toEqual([raw, 200, { ignored: true }]);
    }
    expect(video).not.toHaveBeenCalled();
    const other = bodyOf({ guid: w.row.bunny_video_id!, status: 3, library: 999 });
    expect(await (await post(other)).json()).toEqual({ received: true, outcome: "ignored" });
    const raw = bodyOf({ guid: w.row.bunny_video_id!, status: 3 });
    expect(await (await post(raw)).json()).toEqual({ received: true, outcome: "applied" });
    expect(await (await post(raw)).json()).toEqual({ received: true, outcome: "duplicate" });
    expect(await marksOf(eventIdOf(raw))).toBe(1);
    noSecretLogged();
  });

  it("Task 27 review m7: every event the route hands over is logged at info, with its event id, video id, status and outcome and nothing else (the stg runbook's check); a refused or unparsed delivery is not", async () => {
    const w = await encodingRow();
    const handled = () => logMock.info.mock.calls.filter(([, msg]) => msg === "bunny-webhook: event handled").map(([fields]) => fields);
    // EMPTY CASE FIRST: a refused delivery and a signed body that is not an event log no such line.
    const early = bodyOf({ guid: w.row.bunny_video_id!, status: 2 });
    expect((await post(early, { signature: "0".repeat(64) })).status).toBe(401);
    await post("not json");
    expect(handled()).toEqual([]);
    const finished = bodyOf({ guid: w.row.bunny_video_id!, status: 3 });
    const sent: [string, string][] = [[early, "ignored"], [finished, "applied"], [finished, "duplicate"]];
    for (const [raw, outcome] of sent) expect(await (await post(raw)).json()).toEqual({ received: true, outcome });
    expect(handled(), "one line per event, these four fields exactly").toEqual(
      sent.map(([raw, outcome]) => ({ eventId: eventIdOf(raw), videoId: w.row.bunny_video_id, status: (JSON.parse(raw) as { Status: number }).Status, outcome })),
    );
    expect(noSecretLogged()).toBeGreaterThan(0);
  });
});
