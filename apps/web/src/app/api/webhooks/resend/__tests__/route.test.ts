// POST /api/webhooks/resend with the two things behind it replaced: `suppress` (the suppression list) and
// `applyProviderEvent` (the outbox row). What this file pins is the ROUTE: the signature check and its failure modes, the
// secret policy, the order of the work, and what the status code tells Resend to do (a non-2xx makes it retry).
// The row transitions themselves are tested against a real database in server/email-outbox/__tests__/provider-events.test.ts,
// and the whole route against that database in route-outbox.test.ts.
//
// The signatures are made here from Svix's own rule, not by the route's code: the signed content is
// `<svix-id>.<svix-timestamp>.<raw body>`, the key is the base64 text after `whsec_`, the MAC is HMAC-SHA256, and the header
// holds one or more space-separated `v1,<base64>` entries. Svix accepts a timestamp up to 5 minutes either side of now.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

const suppressMock = vi.hoisted(() => vi.fn<(email: string, type: string, id?: string) => Promise<void>>(async () => {}));
vi.mock("@/lib/email", () => ({ suppress: suppressMock }));

const applyMock = vi.hoisted(() => vi.fn<(type: string, data: Record<string, unknown>) => Promise<string>>(async () => "moved"));
vi.mock("@/server/email-outbox/provider-events", () => ({ applyProviderEvent: applyMock }));

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { POST } from "../route";

const KEY_BYTES = randomBytes(24);
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;
const OTHER_KEY_BYTES = randomBytes(24);
/** Svix's tolerance, from its documentation: 5 minutes either side of the receiver's clock. */
const TOLERANCE_S = 5 * 60;
const T0 = new Date("2026-10-23T12:00:00.000Z");
const NOW_S = Math.floor(T0.getTime() / 1000);

const sign = (id: string, ts: string | number, body: string, key: Buffer = KEY_BYTES): string =>
  `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;

const event = (type: string, data: Record<string, unknown> = { email_id: "re_abc", to: ["pat@example.test"] }): string =>
  JSON.stringify({ type, created_at: T0.toISOString(), data });

type Hdr = { id?: string | null; ts?: string | number | null; sig?: string | null };
/** A POST carrying `body`; each Svix header defaults to a correct value for it and `null` omits the header. */
function post(body: string, h: Hdr = {}): Promise<Response> {
  const id = h.id === undefined ? "msg_1" : h.id;
  const ts = h.ts === undefined ? NOW_S : h.ts;
  const sig = h.sig === undefined ? sign(id ?? "msg_1", ts ?? NOW_S, body) : h.sig;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (id !== null) headers["svix-id"] = id;
  if (ts !== null) headers["svix-timestamp"] = String(ts);
  if (sig !== null) headers["svix-signature"] = sig;
  return POST(new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", headers, body }));
}
const bodyOf = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  suppressMock.mockReset();
  suppressMock.mockResolvedValue(undefined);
  applyMock.mockReset();
  applyMock.mockResolvedValue("moved");
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.info.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the secret policy (no secret configured)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("%s + NODE_ENV production -> 401, an error is logged, and neither the suppression list nor the outbox is touched (even for a bounce)", async (_n, value) => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", value);
    vi.stubEnv("NODE_ENV", "production");
    const body = event("email.bounced");
    const res = await post(body, { id: null, ts: null, sig: null });
    expect(res.status).toBe(401);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(suppressMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
    // Even a request that carries a perfectly good signature for SOME key is refused: there is nothing to verify it against.
    expect((await post(body)).status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])("unset + NODE_ENV %s -> accepted as before (200), with a warning, and the event still reaches the outbox", async (env) => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", undefined);
    vi.stubEnv("NODE_ENV", env);
    const res = await post(event("email.delivered"), { id: null, ts: null, sig: null });
    expect(res.status).toBe(200);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
    expect(applyMock).toHaveBeenCalledTimes(1);
    // Today's behaviour includes not looking at a signature at all when there is no secret.
    expect((await post(event("email.delivered"), { sig: "v1,garbage" })).status).toBe(200);
  });

  it("with a secret in production, the policy is the signature: a good one is 200, none is 401 (the refusal is not just 'production')", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await post(event("email.delivered"))).status).toBe(200);
    expect((await post(event("email.delivered"), { id: null, ts: null, sig: null })).status).toBe(401);
  });
});

describe("the Svix signature", () => {
  it("a correct signature is accepted; the same request with one byte of the body changed is refused", async () => {
    const body = event("email.delivered");
    expect((await post(body)).status).toBe(200);
    const signedForBody = sign("msg_1", NOW_S, body);
    expect((await post(`${body} `, { sig: signedForBody })).status).toBe(401);
    expect((await post(body.replace("re_abc", "re_abd"), { sig: signedForBody })).status).toBe(401);
  });

  it.each([
    ["svix-id", { id: null }],
    // The signature below IS valid for the literal text "null" in the id's place: only an explicit missing-header refusal stops it.
    ["svix-id (signed as the text 'null')", { id: null, sig: sign("null", NOW_S, event("email.bounced")) }],
    ["svix-timestamp", { ts: null }],
    ["svix-signature", { sig: null }],
  ] as [string, Hdr][])("a missing %s header -> 401 and nothing is applied", async (_n, h) => {
    const res = await post(event("email.bounced"), h);
    expect(res.status).toBe(401);
    expect(suppressMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("a signature made with another key, for another id, or for another timestamp is refused (each header is bound into the MAC)", async () => {
    const body = event("email.delivered");
    expect((await post(body, { sig: sign("msg_1", NOW_S, body, OTHER_KEY_BYTES) })).status).toBe(401);
    expect((await post(body, { id: "msg_2", sig: sign("msg_1", NOW_S, body) })).status).toBe(401);
    expect((await post(body, { ts: NOW_S + 1, sig: sign("msg_1", NOW_S, body) })).status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("the header may hold several space-separated entries: any v1 match passes, in any position; none matching fails; other versions are not accepted", async () => {
    const body = event("email.delivered");
    const good = sign("msg_1", NOW_S, body);
    const bad = sign("msg_1", NOW_S, body, OTHER_KEY_BYTES);
    expect((await post(body, { sig: `${bad} ${good}` })).status).toBe(200);
    expect((await post(body, { sig: `${good} ${bad}` })).status).toBe(200);
    expect((await post(body, { sig: `${bad} ${bad}` })).status).toBe(401);
    // The same MAC under another version tag, or with no tag at all, is not a v1 signature.
    expect((await post(body, { sig: good.replace("v1,", "v2,") })).status).toBe(401);
    expect((await post(body, { sig: good.replace("v1,", "") })).status).toBe(401);
    expect((await post(body, { sig: "" })).status).toBe(401);
    expect((await post(body, { sig: "v1," })).status).toBe(401);
  });

  it("a signature of the wrong length is refused without an error (the comparison must not throw on unequal buffers)", async () => {
    const body = event("email.delivered");
    for (const sig of ["v1,AAAA", `${sign("msg_1", NOW_S, body)}AAAA`, `v1,${"A".repeat(500)}`]) {
      expect((await post(body, { sig })).status, sig.slice(0, 20)).toBe(401);
    }
  });

  it("a secret that is not valid base64 is refused (401), not a crash, and an error is logged", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_!!!not base64!!!");
    const res = await post(event("email.delivered"));
    expect(res.status).toBe(401);
    expect(logMock.error).toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("the whsec_ prefix is optional in the configured secret, as before", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", KEY_BYTES.toString("base64"));
    expect((await post(event("email.delivered"))).status).toBe(200);
  });
});

describe("the timestamp window (replay protection)", () => {
  it.each([
    ["exactly 5 minutes old", NOW_S - TOLERANCE_S, 200],
    ["5 minutes and 1 second old", NOW_S - TOLERANCE_S - 1, 401],
    ["exactly 5 minutes ahead", NOW_S + TOLERANCE_S, 200],
    ["5 minutes and 1 second ahead", NOW_S + TOLERANCE_S + 1, 401],
    ["now", NOW_S, 200],
    ["a day old (a replayed capture)", NOW_S - 86_400, 401],
  ])("a correctly signed request %s -> %i", async (_n, ts, status) => {
    const body = event("email.bounced");
    const res = await post(body, { ts });
    expect(res.status).toBe(status);
    // Both halves of the pair: a refused replay changed nothing, an accepted one did the work.
    expect(applyMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(suppressMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it.each(["", "abc", "NaN", "Infinity", "-Infinity", "1e3", "12.5", "0x10", `+${NOW_S}`, `${NOW_S}.0`, `${NOW_S}e0`, `-${NOW_S}`])("a timestamp that is not a whole number of seconds (%j) is refused, even if the MAC covers it", async (ts) => {
    const body = event("email.delivered");
    expect((await post(body, { ts, sig: sign("msg_1", ts, body) })).status).toBe(401);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("the window moves with the clock: the same signed request is fine at its own time and stale 301 s later (a replay a minute past the window)", async () => {
    const body = event("email.delivered");
    const sig = sign("msg_1", NOW_S, body);
    expect((await post(body, { sig })).status).toBe(200);
    vi.setSystemTime(new Date(T0.getTime() + (TOLERANCE_S + 1) * 1000));
    expect((await post(body, { sig })).status).toBe(401);
  });
});

describe("the work, in order", () => {
  it("a bad signature on an unparseable body is 401 (the signature is judged first); a good one on garbage is 400 and applies nothing", async () => {
    expect((await post("{not json", { sig: "v1,nope" })).status).toBe(401);
    for (const garbage of ["{not json", "null", "[]", '"a string"', "42", ""]) {
      expect((await post(garbage)).status, JSON.stringify(garbage)).toBe(400);
    }
    expect(applyMock).not.toHaveBeenCalled();
    expect(suppressMock).not.toHaveBeenCalled();
  });

  it("email.bounced still suppresses the address (type 'bounce', with the email id) AND moves the row", async () => {
    const res = await post(event("email.bounced", { email_id: "re_b1", to: ["bounced@example.test"] }));
    expect(res.status).toBe(200);
    expect(suppressMock).toHaveBeenCalledWith("bounced@example.test", "bounce", "re_b1");
    expect(applyMock).toHaveBeenCalledWith("email.bounced", { email_id: "re_b1", to: ["bounced@example.test"] });
    expect(await bodyOf(res)).toEqual({ ok: true });
  });

  it("email.complained still suppresses (type 'complaint') AND moves the row; the address falls back to data.email", async () => {
    expect((await post(event("email.complained", { email_id: "re_c1", email: "angry@example.test" }))).status).toBe(200);
    expect(suppressMock).toHaveBeenCalledWith("angry@example.test", "complaint", "re_c1");
    expect(applyMock).toHaveBeenCalledWith("email.complained", { email_id: "re_c1", email: "angry@example.test" });
  });

  it.each(["email.delivered", "email.delivery_delayed", "email.failed", "email.suppressed", "email.sent", "email.opened"])(
    "%s does not touch the suppression list but still reaches the outbox (the pair of the two tests above)",
    async (type) => {
      expect((await post(event(type))).status).toBe(200);
      expect(suppressMock).not.toHaveBeenCalled();
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(applyMock.mock.calls[0]![0]).toBe(type);
    },
  );

  it("a failing suppression write is logged and does not stop the row from moving (existing behaviour kept)", async () => {
    suppressMock.mockRejectedValue(new Error("db down"));
    const res = await post(event("email.bounced"));
    expect(res.status).toBe(200);
    expect(logMock.error).toHaveBeenCalled();
    expect(applyMock).toHaveBeenCalledTimes(1);
  });

  it("applyProviderEvent throwing -> 500, so Resend retries it; the suppression for that event was already written", async () => {
    applyMock.mockRejectedValue(new Error("connection terminated"));
    const res = await post(event("email.complained"));
    expect(res.status).toBe(500);
    expect(suppressMock).toHaveBeenCalledTimes(1);
    expect(logMock.error).toHaveBeenCalled();
  });

  it.each(["unknown", "not_tracked", "ignored", "moved"])("applyProviderEvent answering %s -> 200 (a duplicate, a stranger's email and an untracked type are all fine)", async (answer) => {
    applyMock.mockResolvedValue(answer);
    const res = await post(event("email.delivered"));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ ok: true });
  });

  it("a payload with no type or a non-object data is handled: the outbox is asked with an empty type / empty data, never a crash", async () => {
    expect((await post(JSON.stringify({ data: { email_id: "re_x" } }))).status).toBe(200);
    expect(applyMock).toHaveBeenLastCalledWith("", { email_id: "re_x" });
    expect((await post(JSON.stringify({ type: "email.delivered", data: "oops" }))).status).toBe(200);
    expect(applyMock).toHaveBeenLastCalledWith("email.delivered", {});
    expect((await post(JSON.stringify({ type: 7, data: [] }))).status).toBe(200);
    expect(applyMock).toHaveBeenLastCalledWith("", {});
  });
});

describe("what the route logs", () => {
  it("never the raw payload, the recipient or the sender: the event type and the email id only", async () => {
    const data = { email_id: "re_log1", to: ["secret-person@example.test"], from: "RAW-FROM <f@secret.test>", subject: "RAW-SUBJECT", tags: { outbox: "x" } };
    await post(event("email.bounced", data));
    applyMock.mockRejectedValueOnce(new Error("boom with secret-person@example.test inside"));
    await post(event("email.complained", data));
    // An Error serialises to {} by default; the real logger (pino) writes its message and stack, so expand them here.
    const expandErrors = (_k: string, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
    const logged = JSON.stringify([logMock.error.mock.calls, logMock.warn.mock.calls, logMock.info.mock.calls], expandErrors);
    // Positive pair: lines were written (a suppression, a failed apply), so the absences below mean something.
    expect(logMock.info.mock.calls.length + logMock.error.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logged).toContain("re_log1");
    expect(logged).toContain("email.complained");
    for (const secret of ["secret-person", "RAW-FROM", "RAW-SUBJECT", "secret.test", "boom"]) expect(logged, secret).not.toContain(secret);
  });
});
