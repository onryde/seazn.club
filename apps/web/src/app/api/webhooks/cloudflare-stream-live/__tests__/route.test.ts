// POST /api/webhooks/cloudflare-stream-live (Seazn-hosted video, Task 27b): the public route around `recordLiveNotification`,
// driven through its REAL handler against a session the real producers made. What this file pins is the ROUTE: the destination's
// secret is checked before anything is parsed (401, no detail, nothing written), a body that is not a live-input notification
// (200 `{ ignored: true }`, nothing written, a warn naming the FIELD), an input this deployment does not own (200, acked, nothing
// written: stg and prod share one Cloudflare account, so each receives the other's), a handled event (200, one info line), a
// throw (500), and that no secret or body reaches a log line. The use case's own decisions are live-notification.test.ts's.
//
// Cloudflare's contract, typed here from its pages (read 2026-11-23): the webhook destination's secret arrives VERBATIM in the
// `cf-webhook-auth` header (https://developers.cloudflare.com/notifications/get-started/configure-webhooks/), and the body is
// `{ name, text, data: { notification_name, input_id, event_type, updated_at }, ts }`
// (https://developers.cloudflare.com/stream/stream-live/webhooks/). The secret here is a fake env value.
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport rule; every rig rides `generic`.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The use case, delegating to the real one unless a test arms a throw (the 500 path): every other call is the real write.
const failNext = vi.hoisted(() => ({ err: null as Error | null }));
vi.mock("@/server/usecases/stream-sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/stream-sessions")>();
  return {
    ...actual,
    recordLiveNotification: async (...a: Parameters<typeof actual.recordLiveNotification>) => {
      const err = failNext.err;
      failNext.err = null;
      if (err) throw err;
      return actual.recordLiveNotification(...a);
    },
  };
});

import { sql } from "@/lib/db";
import { HAS_DB, inputOf, installSeaznLockEnv, live, rig } from "@/server/usecases/__tests__/_seazn-lock-rig";
import { POST } from "../route";

const SECRET = "ZZ-cf-live-webhook-route-secret";
const URL_ = "https://test.local/api/webhooks/cloudflare-stream-live";

installSeaznLockEnv();
beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_LIVE_WEBHOOK_SECRET", SECRET);
  for (const fn of Object.values(logMock)) fn.mockClear();
  failNext.err = null;
});

const bodyOf = (inputId: string, event = "live_input.disconnected", updatedAt = new Date().toISOString()) => JSON.stringify({
  name: "Seazn live inputs",
  text: `Notification type: Stream Live Input\nInput ID: ${inputId}\nEvent type: ${event}\nUpdated at: ${updatedAt}`,
  data: { notification_name: "Stream Live Input", input_id: inputId, event_type: event, updated_at: updatedAt },
  ts: Math.floor(Date.now() / 1000),
});
const sent: string[] = [];
function post(raw: string, auth: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers["cf-webhook-auth"] = auth;
  sent.push(raw);
  return POST(new Request(URL_, { method: "POST", headers, body: raw }));
}
/** Every row any delivery of this input wrote: the event and the sample. "Nothing written" is this, zero. */
const writtenFor = async (uid: string) => {
  const [{ n }] = await sql<{ n: number }[]>`
    select (select count(*) from fixture_stream_events where source = 'webhook' and payload->>'inputUid' = ${uid})
         + (select count(*) from fixture_stream_samples where source = 'notification' and raw->>'inputUid' = ${uid}) as n`;
  return Number(n);
};
/** Every log line this file's deliveries produced, as text: none may hold the secret or a body sent. */
function noSecretLogged(): number {
  const lines = Object.values(logMock).flatMap((fn) => fn.mock.calls.map((c) => JSON.stringify(c)));
  for (const line of lines) {
    expect(line).not.toContain(SECRET);
    for (const s of sent.filter((x) => x.length >= 32)) expect(line).not.toContain(s);
  }
  return lines.length;
}
/** A composed Seazn session gone live through the real producers: its programme input's Cloudflare uid. */
async function liveInput(): Promise<{ sessionId: string; uid: string }> {
  const r = await rig();
  const sessionId = await live(r, r.fixtureIds[0], r.seazn);
  return { sessionId, uid: (await inputOf(sessionId, "programme")).uid };
}

describe.skipIf(!HAS_DB)("POST /api/webhooks/cloudflare-stream-live (Task 27b)", () => {
  it("EMPTY CASE FIRST: no secret configured (unset or blank) refuses EVERY delivery — 401, no detail, nothing written — even one whose header is empty or blank; set, the same delivery is recorded", async () => {
    const { uid } = await liveInput();
    const raw = bodyOf(uid);
    let checked = 0;
    for (const configured of [undefined, "", "   "]) {
      if (configured === undefined) vi.stubEnv("CLOUDFLARE_LIVE_WEBHOOK_SECRET", undefined);
      else vi.stubEnv("CLOUDFLARE_LIVE_WEBHOOK_SECRET", configured);
      for (const header of [null, "", "   ", SECRET]) {
        const res = await post(raw, header);
        expect([String(configured), header, res.status, await res.json()]).toEqual([String(configured), header, 401, { error: "Invalid signature" }]);
        checked++;
      }
    }
    expect(checked).toBe(12);
    expect(await writtenFor(uid)).toBe(0);
    expect(logMock.warn.mock.calls.filter(([f]) => (f as { reason?: string }).reason === "no_secret_configured")).toHaveLength(12);
    vi.stubEnv("CLOUDFLARE_LIVE_WEBHOOK_SECRET", SECRET);
    expect(await (await post(raw)).json(), "the positive pair").toEqual({ received: true, outcome: "recorded" });
    noSecretLogged();
  });

  it("a delivery without the destination's secret — none, another, one character changed, the secret with more after it — is 401 with no detail and nothing written; the same body with it is recorded", async () => {
    const { uid } = await liveInput();
    const raw = bodyOf(uid);
    let checked = 0;
    for (const header of [null, "another-secret-entirely", SECRET.slice(0, -1) + "X", `${SECRET}x`, SECRET.toLowerCase()]) {
      const res = await post(raw, header);
      expect([header, res.status, await res.json()]).toEqual([header, 401, { error: "Invalid signature" }]);
      checked++;
    }
    expect(checked).toBe(5);
    expect(await writtenFor(uid)).toBe(0);
    expect(logMock.warn.mock.calls.map(([f]) => f)).toEqual(Array.from({ length: 5 }, () => ({ reason: "auth" })));
    expect(await (await post(raw)).json()).toEqual({ received: true, outcome: "recorded" });
    expect(await writtenFor(uid), "one event and one sample").toBe(2);
    noSecretLogged();
  });

  it("Task 27b review m1: the secret is checked BEFORE the body is parsed — a malformed or non-notification body without the secret is 401, never 200 `ignored`, and no field warn is written", async () => {
    let checked = 0;
    for (const [label, configured, header] of [["a wrong secret", SECRET, "wrong"], ["no header", SECRET, null], ["no secret configured", undefined, SECRET]] as const) {
      vi.stubEnv("CLOUDFLARE_LIVE_WEBHOOK_SECRET", configured);
      for (const raw of ["not json", "", JSON.stringify({ text: "Hello World!" })]) {
        const res = await post(raw, header);
        expect([label, raw, res.status, await res.json()]).toEqual([label, raw, 401, { error: "Invalid signature" }]);
        checked++;
      }
    }
    expect(checked).toBe(9);
    expect(logMock.warn.mock.calls.filter(([f]) => "field" in (f as object)), "nothing was parsed").toEqual([]);
    expect(logMock.warn.mock.calls.map(([f]) => (f as { reason: string }).reason).sort()).toEqual([...Array(6).fill("auth"), ...Array(3).fill("no_secret_configured")].sort());
    noSecretLogged();
  });

  it("an authentic body that is not a live-input notification (the destination's Save and Test message, not JSON, an empty body, an event the route does not know) is 200 `{ ignored: true }`, nothing written, and its warn names the field, never a value", async () => {
    const { uid } = await liveInput();
    const cases: [string, string][] = [
      [JSON.stringify({ text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly." }), "data"],
      ["not json", "body"],
      ["", "body"],
      [bodyOf(uid, "live_input.reconnected"), "data.event_type"],
    ];
    for (const [raw, field] of cases) {
      const res = await post(raw);
      expect([raw.slice(0, 30), res.status, await res.json()]).toEqual([raw.slice(0, 30), 200, { ignored: true }]);
      const [fields] = logMock.warn.mock.calls.at(-1)!;
      expect(fields).toEqual({ field, bytes: raw.length });
    }
    expect(await writtenFor(uid)).toBe(0);
    noSecretLogged();
  });

  it("an input this deployment does not own (the other environment's, on the shared account) is acked 200 and ignored: nothing written, no info line, never a 500", async () => {
    const uid = `cf-${randomUUID().replace(/-/g, "")}`;
    let checked = 0;
    for (const event of ["live_input.connected", "live_input.disconnected", "live_input.errored"]) {
      const res = await post(bodyOf(uid, event));
      expect([event, res.status, await res.json()]).toEqual([event, 200, { received: true, outcome: "unknown_input" }]);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await writtenFor(uid)).toBe(0);
    expect(logMock.info).not.toHaveBeenCalled();
    noSecretLogged();
  });

  it("every handled event is logged at info with its input uid, event, session and outcome and nothing else; a second delivery of it is `duplicate`", async () => {
    const { sessionId, uid } = await liveInput();
    const handled = () => logMock.info.mock.calls.filter(([, msg]) => msg === "cloudflare-live-webhook: notification handled").map(([f]) => f);
    // EMPTY CASE FIRST: a refused delivery and an ignored body log no such line.
    await post(bodyOf(uid), "wrong");
    await post("not json");
    expect(handled()).toEqual([]);
    const drop = bodyOf(uid, "live_input.disconnected", "2026-11-23T10:00:00.123456789Z");
    const back = bodyOf(uid, "live_input.connected", "2026-11-23T10:00:20.5Z");
    const deliveries: [string, string, string][] = [[drop, "live_input.disconnected", "recorded"], [drop, "live_input.disconnected", "duplicate"], [back, "live_input.connected", "recorded"]];
    for (const [raw, , outcome] of deliveries) expect(await (await post(raw)).json()).toEqual({ received: true, outcome });
    expect(handled(), "one line per event, these four fields exactly").toEqual(deliveries.map(([, event, outcome]) => ({ inputUid: uid, event, sessionId, outcome })));
    expect(await writtenFor(uid), "two notifications, each an event and a sample").toBe(4);
    expect(noSecretLogged()).toBeGreaterThan(0);
  });

  it("a recording that throws is 500 with no detail, logged with the error's class and the event's ids only; Cloudflare's next delivery of it is recorded", async () => {
    const { uid } = await liveInput();
    const raw = bodyOf(uid);
    failNext.err = new Error(`connection refused (${SECRET})`);
    const failed = await post(raw);
    expect([failed.status, await failed.json()]).toEqual([500, { error: "Processing failed" }]);
    expect(logMock.error.mock.calls.map(([f, msg]) => [f, msg])).toEqual([
      [{ errClass: "Error", inputUid: uid, event: "live_input.disconnected" }, "cloudflare-live-webhook: recording the notification failed"],
    ]);
    expect(await writtenFor(uid)).toBe(0);
    expect(await (await post(raw)).json()).toEqual({ received: true, outcome: "recorded" });
    noSecretLogged();
  });
});
