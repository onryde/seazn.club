// The outbox driven through its REAL transport: nothing of ours is mocked, only the network (global fetch). dispatch.test.ts
// replaces `transport.deliver`, so it cannot see whether the key, the tags, the timeout and the API key actually reach the
// request, or whether Resend's error NAME survives from the response to the row. This file is that seam, producer to
// consumer: enqueueEmail -> dispatchNow -> attemptClaimed -> checkSendable -> transport.deliver -> email.deliver -> fetch.
//
// The fetch stub is the provider: one message per Idempotency-Key, errors in Resend's `{ statusCode, name, message }` shape.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { suppress } from "@/lib/email";
import { attemptClaimed, dispatchNow, toClaimedRow } from "../attempt";
import { idempotencyKey } from "../constants";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { claimOne } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `wire-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_wire_test";
const SECRET = `SECRET-TOKEN-${randomUUID()}`;
const LINK = `https://seazn.club/api/auth/magic-link/verify?token=${SECRET}`;

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal | undefined };

describe.skipIf(!HAS_DB)("the outbox through the real transport (fetch is the only stub)", () => {
  const created: string[] = [];
  const suppressed: string[] = [];
  const calls: Call[] = [];
  const messages = new Map<string, string>(); // Idempotency-Key -> Resend message id
  let respond: (call: Call) => Response | Promise<Response>;
  let errorSpy: MockInstance<typeof console.error>;

  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  });

  const accept = (call: Call): Response => {
    const key = call.headers["Idempotency-Key"]!;
    if (!messages.has(key)) messages.set(key, `re_${randomUUID()}`);
    return new Response(JSON.stringify({ id: messages.get(key) }), { status: 200 });
  };
  const resendError = (status: number, name: string): Response =>
    new Response(JSON.stringify({ statusCode: status, name, message: `RAW-PROVIDER-MESSAGE ${SECRET}` }), { status });

  async function queue(over: Partial<OutboxMessage> = {}): Promise<string> {
    const id = await enqueueEmail(sql, {
      kind: "magic_link",
      refType: "login",
      refId: `${RUN}-${randomUUID()}`,
      orgId: null,
      to: `${randomUUID()}@x.test`,
      subject: "Your sign-in link",
      html: `<a href="${LINK}">Sign in</a>`,
      text: `Sign in: ${LINK}`,
      transactional: true,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      ...over,
    });
    created.push(id);
    return id;
  }
  const row = async (id: string) => {
    const [r] = await sql<{ status: string; provider_id: string | null; last_error: string | null; attempts: number; body_sealed: Buffer | null }[]>`
      select status, provider_id, last_error, attempts, body_sealed from email_outbox where id = ${id}`;
    return r!;
  };

  beforeAll(async () => {
    await sql`select 1`; // the pool is built before any env is stubbed
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    if (suppressed.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressed)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    calls.length = 0;
    messages.clear();
    fetchStub.mockClear();
    respond = accept;
    vi.stubGlobal("fetch", fetchStub);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a send reaches Resend with the row's key, the outbox tag, the API key, the plaintext body and a live timeout signal", async () => {
    const id = await queue();
    expect((await dispatchNow([id])).get(id)).toBe("sent");

    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.headers["Idempotency-Key"]).toBe(idempotencyKey(id));
    expect(c.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(c.body.tags).toEqual([{ name: "outbox", value: id }]);
    expect(String(c.body.html)).toContain(LINK);
    expect(String(c.body.text)).toContain(LINK);
    expect(c.body.subject).toBe("Your sign-in link");
    expect(c.body.to).toHaveLength(1);
    // SEND_TIMEOUT_MS reached the request: a signal is present and has not fired.
    expect(c.signal).toBeInstanceOf(AbortSignal);
    expect(c.signal!.aborted).toBe(false);

    const r = await row(id);
    expect([r.status, r.provider_id, r.body_sealed]).toEqual(["sent", messages.get(idempotencyKey(id)), null]);
  });

  it("Resend's error NAME survives from the response to the row: 500 -> retrying, 409 invalid -> dead, 422 -> dead; the raw message does not", async () => {
    const cases: Array<[string, number, string, string, string]> = [
      ["500", 500, "internal_server_error", "retrying", "queued"],
      ["409 concurrent", 409, "concurrent_idempotent_requests", "retrying", "queued"],
      ["409 invalid", 409, "invalid_idempotent_request", "dead", "dead"],
      ["422", 422, "validation_error", "dead", "dead"],
      ["429", 429, "rate_limit_exceeded", "retrying", "queued"],
    ];
    let checked = 0;
    for (const [label, status, name, outcome, rowStatus] of cases) {
      const id = await queue();
      respond = () => resendError(status, name);
      expect((await dispatchNow([id])).get(id), label).toBe(outcome);
      const r = await row(id);
      expect([r.status, r.last_error], label).toEqual([rowStatus, `http ${status} ${name}`]);
      expect(r.last_error).not.toContain("RAW-PROVIDER");
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("R8: the outbox never logs Resend's raw response text: console.error gets the status and error name only (and the legacy line would have carried the text)", async () => {
    const id = await queue();
    respond = () => resendError(500, "internal_server_error"); // its message is `RAW-PROVIDER-MESSAGE <SECRET>`
    await dispatchNow([id]);
    // The positive half: the failure IS logged, so an empty log cannot pass the negative half.
    expect(errorSpy).toHaveBeenCalledWith("[email] send failed (500) internal_server_error");
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("RAW-PROVIDER");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(API_KEY);
    // Control for the probe: the raw text really was in the response the transport read.
    const sample = await resendError(500, "x").text();
    expect(sample).toContain("RAW-PROVIDER-MESSAGE");
  });

  it("a network failure -> retrying with the cause code; the body of the exception is not stored", async () => {
    const id = await queue();
    respond = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    expect((await dispatchNow([id])).get(id)).toBe("retrying");
    expect((await row(id)).last_error).toBe("network fetch failed (ECONNRESET)");
  });

  it("a 2xx with an unreadable body is sent with no provider id (R8)", async () => {
    const id = await queue();
    respond = () => new Response("not json", { status: 200 });
    expect((await dispatchNow([id])).get(id)).toBe("sent");
    const r = await row(id);
    expect([r.status, r.provider_id]).toEqual(["sent", null]);
  });

  it("retry then success on the wire: the retried request carries the same Idempotency-Key and the provider holds one message", async () => {
    const id = await queue();
    respond = () => resendError(503, "service_unavailable");
    expect((await dispatchNow([id])).get(id)).toBe("retrying");
    // The worker's retry: its own claim statement (`claimOne`, once the delay has passed) and the same attempt function.
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${id}`;
    const rec = await claimOne([id]);
    respond = accept;
    expect((await attemptClaimed(toClaimedRow(rec!))).outcome).toBe("sent");
    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual([idempotencyKey(id), idempotencyKey(id)]);
    expect(messages.size).toBe(1);
    expect((await row(id)).attempts).toBe(2);
  });

  it("the gate is the real one: a non-transactional mail to a suppressed address never reaches fetch, and with no API key nothing does either", async () => {
    const to = `${randomUUID()}@suppressed.test`;
    suppressed.push(to);
    await suppress(to, "bounce");
    const blocked = await queue({ to, transactional: false });
    expect((await dispatchNow([blocked])).get(blocked)).toBe("suppressed");

    vi.stubEnv("RESEND_API_KEY", undefined);
    const keyless = await queue();
    expect((await dispatchNow([keyless])).get(keyless)).toBe("dead");
    expect((await row(keyless)).last_error).toBe("no_api_key");

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("nothing a send leaves behind carries the API key or the sealed text: the rows read back clean", async () => {
    const ids = [await queue(), await queue(), await queue()];
    let n = 0;
    respond = (call) => {
      n++;
      if (n === 2) return resendError(500, "internal_server_error");
      if (n === 3) return resendError(422, "validation_error");
      return accept(call);
    };
    await dispatchNow(ids);
    const dump = (await sql<{ j: string }[]>`select to_jsonb(e)::text as j from email_outbox e where id in ${sql(ids)}`).map((r) => r.j).join("\n");
    expect(ids.length).toBe(3);
    for (const needle of [API_KEY, SECRET, "RAW-PROVIDER"]) expect(dump, needle).not.toContain(needle);
  });
});
