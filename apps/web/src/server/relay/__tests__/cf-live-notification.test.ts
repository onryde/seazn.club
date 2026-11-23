// Task 27b: Cloudflare Stream's live-input notification, the pure half — the shared-secret check and the body.
//
// The contract, typed here from Cloudflare's own pages (read 2026-11-23), never from the module under test:
//  - https://developers.cloudflare.com/stream/stream-live/webhooks/ — the body: `{ name, text, data: { notification_name,
//    input_id, event_type, updated_at, live_input_errored? }, ts }`; `event_type` is `live_input.connected`,
//    `live_input.disconnected` or `live_input.errored`; an errored event carries `live_input_errored.error.code` (one of
//    ERR_GOP_OUT_OF_RANGE, ERR_UNSUPPORTED_VIDEO_CODEC, …). The two example bodies below are that page's, verbatim.
//  - https://developers.cloudflare.com/notifications/get-started/configure-webhooks/ and
//    https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/ — a generic webhook destination's
//    secret arrives VERBATIM in the `cf-webhook-auth` header (no HMAC, no timestamp); "Save and Test" sends
//    `{ "text": "Hello World! This is a test message …" }`.
// The words each event maps to are this app's port (relay/ports.ts IngestState): connected and disconnected are themselves; an
// errored input is neither a phone known to be sending nor one known to be gone, so `unknown`, as the poll reads an unseen word.
import { describe, expect, it, vi } from "vitest";

// Every comparison must be the constant-time one: the real `timingSafeEqual`, counted, with the lengths it was handed.
const compared = vi.hoisted(() => ({ calls: 0, lengths: [] as [number, number][] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls++;
      compared.lengths.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { parseCfLiveNotification, verifyCfWebhookAuth } from "../cf-live-notification";

const SECRET = "ZZ-cf-live-webhook-secret-unit";

/** Cloudflare's own examples (stream/stream-live/webhooks/), verbatim. */
const DOC_DISCONNECTED = {
  name: "Live Webhook Test",
  text: "Notification type: Stream Live Input\nInput ID: eb222fcca08eeb1ae84c981ebe8aeeb6\nEvent type: live_input.disconnected\nUpdated at: 2022-01-13T11:43:41.855717910Z",
  data: { notification_name: "Stream Live Input", input_id: "eb222fcca08eeb1ae84c981ebe8aeeb6", event_type: "live_input.disconnected", updated_at: "2022-01-13T11:43:41.855717910Z" },
  ts: 1642074233,
};
const DOC_ERRORED = {
  name: "Live Webhook Test",
  text: "Notification type: Stream Live Input\nInput ID: 2c28dd2cc444cb77578c4840b51e43a8\nEvent type: live_input.errored\nUpdated at: 2024-07-09T18:07:51.077371662Z\nError Code: ERR_GOP_OUT_OF_RANGE\nError Message: Input GOP size or keyframe interval is out of range.\nVideo Codec: \nAudio Codec: ",
  data: {
    notification_name: "Stream Live Input", input_id: "eb222fcca08eeb1ae84c981ebe8aeeb6", event_type: "live_input.errored", updated_at: "2024-07-09T18:07:51.077371662Z",
    live_input_errored: { error: { code: "ERR_GOP_OUT_OF_RANGE", message: "Input GOP size or keyframe interval is out of range." }, video_codec: "", audio_codec: "" },
  },
  ts: 1720548474,
};
/** The destination's "Save and Test" message (notifications/get-started/configure-webhooks/). */
const SAVE_AND_TEST = { text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly." };

describe("verifyCfWebhookAuth: the destination's secret, verbatim in `cf-webhook-auth`", () => {
  it("EMPTY CASE FIRST: no header, an empty header, or no secret configured is refused — an empty secret is one anybody can send", () => {
    let checked = 0;
    for (const [label, header, secret] of [
      ["no header", null, SECRET], ["an empty header", "", SECRET], ["no secret configured", SECRET, ""], ["neither", "", ""],
    ] as const) {
      expect(verifyCfWebhookAuth(header, secret), label).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("only the exact secret passes: one character changed, another case, a prefix, the secret with more after it, or whitespace around it is refused, and none throws (counts reported)", () => {
    expect(verifyCfWebhookAuth(SECRET, SECRET), "the positive pair").toBe(true);
    const refused = [
      SECRET.slice(0, -1) + "X", SECRET.toUpperCase(), SECRET.slice(0, 8), `${SECRET}x`, ` ${SECRET}`, `${SECRET} `, "x".repeat(2000),
    ];
    let checked = 0;
    for (const header of refused) {
      expect(() => verifyCfWebhookAuth(header, SECRET), JSON.stringify(header.slice(0, 40))).not.toThrow();
      expect(verifyCfWebhookAuth(header, SECRET), JSON.stringify(header.slice(0, 40))).toBe(false);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("every comparison goes through crypto.timingSafeEqual on equal-length digests — whatever length the header is — never through === (so the time taken says nothing about where the two differ)", () => {
    compared.calls = 0;
    compared.lengths = [];
    const headers = [SECRET, `${SECRET}x`, SECRET.slice(0, 3), "x".repeat(2000)];
    for (const h of headers) verifyCfWebhookAuth(h, SECRET);
    expect(compared.calls, "one constant-time comparison per header").toBe(headers.length);
    for (const [a, b] of compared.lengths) expect([a, b], "equal lengths, never the header's own").toEqual([32, 32]);
  });
});

describe("parseCfLiveNotification: Cloudflare's live-input notification body", () => {
  it("EMPTY CASE FIRST: a body that is not a live-input notification is refused, naming the field it lacked (never a value): the destination's own test message, an empty object, a list, a string, null", () => {
    const cases: [string, unknown, string][] = [
      ["the destination's Save and Test message", SAVE_AND_TEST, "data"],
      ["an empty object", {}, "data"],
      ["a list", [], "body"],
      ["a string", "live_input.connected", "body"],
      ["null", null, "body"],
      ["undefined (the route's unparseable body)", undefined, "body"],
      ["data is a list", { data: [] }, "data"],
      ["no input id", { data: { event_type: "live_input.connected" } }, "data.input_id"],
      ["an empty input id", { data: { input_id: "  ", event_type: "live_input.connected" } }, "data.input_id"],
      ["an input id that is not text", { data: { input_id: 42, event_type: "live_input.connected" } }, "data.input_id"],
      ["no event type", { data: { input_id: "abc" } }, "data.event_type"],
      ["an event this route does not know", { data: { input_id: "abc", event_type: "live_input.reconnected" } }, "data.event_type"],
    ];
    let checked = 0;
    for (const [label, body, field] of cases) {
      const r = parseCfLiveNotification(body);
      expect(r, label).toMatchObject({ ok: false, field });
      checked++;
    }
    expect(checked).toBe(12);
  });

  it("Cloudflare's documented examples read as the docs say: the input, the event, the word, the error code, and the moment (updated_at, to the millisecond)", () => {
    expect(parseCfLiveNotification(DOC_DISCONNECTED)).toEqual({
      ok: true,
      notification: { inputUid: "eb222fcca08eeb1ae84c981ebe8aeeb6", event: "live_input.disconnected", word: "disconnected", reason: null, at: new Date("2022-01-13T11:43:41.855Z") },
    });
    expect(parseCfLiveNotification(DOC_ERRORED)).toEqual({
      ok: true,
      notification: { inputUid: "eb222fcca08eeb1ae84c981ebe8aeeb6", event: "live_input.errored", word: "unknown", reason: "ERR_GOP_OUT_OF_RANGE", at: new Date("2024-07-09T18:07:51.077Z") },
    });
  });

  it("every event Cloudflare documents maps to its word, the table enumerated (counts reported)", () => {
    const table: [string, string][] = [["live_input.connected", "connected"], ["live_input.disconnected", "disconnected"], ["live_input.errored", "unknown"]];
    let checked = 0;
    for (const [event, word] of table) {
      const r = parseCfLiveNotification({ ...DOC_DISCONNECTED, data: { ...DOC_DISCONNECTED.data, event_type: event } });
      expect(r, event).toMatchObject({ ok: true, notification: { event, word } });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the moment falls back to the delivery's `ts` (seconds) when updated_at is missing or not a time, and to nothing when neither is there — a body is never refused for its clock", () => {
    const { updated_at: _drop, ...noUpdatedAt } = DOC_DISCONNECTED.data;
    void _drop;
    expect(parseCfLiveNotification({ ...DOC_DISCONNECTED, data: noUpdatedAt })).toMatchObject({ ok: true, notification: { at: new Date(1642074233 * 1000) } });
    expect(parseCfLiveNotification({ ...DOC_DISCONNECTED, data: { ...DOC_DISCONNECTED.data, updated_at: "yesterday" } })).toMatchObject({ ok: true, notification: { at: new Date(1642074233 * 1000) } });
    const { ts: _ts, ...noTs } = DOC_DISCONNECTED;
    void _ts;
    expect(parseCfLiveNotification({ ...noTs, data: noUpdatedAt })).toMatchObject({ ok: true, notification: { at: null } });
    expect(parseCfLiveNotification({ ...noTs, data: noUpdatedAt, ts: "1642074233" }), "a ts that is not a number").toMatchObject({ ok: true, notification: { at: null } });
  });

  it("the reason is the code at live_input_errored.error.code, read only there and cut to 64 characters: absent, it is null — never invented from the message or the event", () => {
    const noCode = { ...DOC_ERRORED, data: { ...DOC_ERRORED.data, live_input_errored: { video_codec: "", audio_codec: "" } } };
    expect(parseCfLiveNotification(noCode)).toMatchObject({ ok: true, notification: { word: "unknown", reason: null } });
    const longCode = { ...DOC_ERRORED, data: { ...DOC_ERRORED.data, live_input_errored: { error: { code: `ERR_${"X".repeat(300)}` } } } };
    const r = parseCfLiveNotification(longCode);
    expect(r.ok && r.notification.reason!.length, "cut").toBe(64);
    const connectedWithCode = { ...DOC_ERRORED, data: { ...DOC_ERRORED.data, event_type: "live_input.connected" } };
    expect(parseCfLiveNotification(connectedWithCode), "read wherever the event: the code is Cloudflare's word for the input's error").toMatchObject({ ok: true, notification: { word: "connected", reason: "ERR_GOP_OUT_OF_RANGE" } });
  });
});
