// The retry worker driven through the REAL transport: nothing of ours is mocked, only the network (global fetch).
// worker.test.ts replaces `transport.deliver`, so it cannot see whether the retried request carries the first request's
// Idempotency-Key, whether a real 429 response stops the tick, or whether the lease-reclaim sequence (R9) yields one
// provider message at the HTTP layer. This is that seam, producer to consumer:
//   enqueueEmail -> dispatchNow / runOutboxTick -> attemptClaimed -> checkSendable -> transport.deliver -> email.deliver -> fetch.
// The fetch stub is the provider: one message per Idempotency-Key, errors in Resend's `{ statusCode, name, message }` shape.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { dispatchNow } from "../attempt";
import { idempotencyKey } from "../constants";
import { enqueueEmail, type OutboxMessage } from "../enqueue";
import { runOutboxTick } from "../worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t4wire-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_t4wire_test";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

describe.skipIf(!HAS_DB)("the retry worker through the real transport (fetch is the only stub)", () => {
  const created: string[] = [];
  const calls: Call[] = [];
  const messages = new Map<string, string>(); // Idempotency-Key -> Resend message id
  let respond: (call: Call) => Response | Promise<Response>;
  let clock = 0;
  const fakeClock = {
    sleep: async (ms: number) => {
      clock += ms;
    },
    nowMs: () => clock,
  };
  const tick = (ids: string[]) => runOutboxTick({ onlyIds: ids, ...fakeClock });

  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return respond(call);
  });
  const accept = (call: Call): Response => {
    const key = call.headers["Idempotency-Key"]!;
    if (!messages.has(key)) messages.set(key, `re_${randomUUID()}`);
    return new Response(JSON.stringify({ id: messages.get(key) }), { status: 200 });
  };
  const resendError = (status: number, name: string): Response =>
    new Response(JSON.stringify({ statusCode: status, name, message: "RAW-PROVIDER-MESSAGE" }), { status });

  async function queue(over: Partial<OutboxMessage> = {}): Promise<string> {
    const id = await enqueueEmail(sql, {
      kind: "magic_link",
      refType: "login",
      refId: `${RUN}-${randomUUID()}`,
      orgId: null,
      to: `${randomUUID()}@x.test`,
      subject: "Your sign-in link",
      html: "<a href='https://seazn.club/v?token=T'>Sign in</a>",
      text: "Sign in",
      transactional: true,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      ...over,
    });
    created.push(id);
    return id;
  }
  const row = async (id: string) => {
    const [r] = await sql<{ status: string; provider_id: string | null; attempts: number; last_error: string | null }[]>`
      select status, provider_id, attempts, last_error from email_outbox where id = ${id}`;
    return r!;
  };
  const makeDue = async (id: string) => {
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${id}`;
  };

  beforeAll(async () => {
    await sql`select 1`; // the pool is built before any env is stubbed
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    clock = 0;
    calls.length = 0;
    messages.clear();
    fetchStub.mockClear();
    respond = accept;
    vi.stubGlobal("fetch", fetchStub);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("retry then success on the wire: the worker's request carries the first request's Idempotency-Key, the API key and the outbox tag; the provider holds one message", async () => {
    const id = await queue();
    respond = () => resendError(503, "service_unavailable");
    expect((await dispatchNow([id])).get(id)).toBe("retrying");
    await makeDue(id);
    respond = accept;
    expect(await tick([id])).toMatchObject({ claimed: 1, sent: 1, failed: 0 });

    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual([idempotencyKey(id), idempotencyKey(id)]);
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(calls.map((c) => c.body.tags)).toEqual([[{ name: "outbox", value: id }], [{ name: "outbox", value: id }]]);
    expect(messages.size, "one email however many requests").toBe(1);
    const r = await row(id);
    expect([r.status, r.attempts, r.provider_id]).toEqual(["sent", 2, messages.get(idempotencyKey(id))]);
  });

  it("a real 429 response stops the tick: the second row's request is never made and it stays queued, counted as deferred", async () => {
    const a = await queue();
    const b = await queue();
    await makeDue(a);
    await makeDue(b);
    respond = () => resendError(429, "rate_limit_exceeded");
    expect(await tick([a, b])).toMatchObject({ claimed: 1, retried: 1, deferred: 1 });
    expect(calls).toHaveLength(1);
    const rows = await Promise.all([a, b].map(row));
    expect(rows.map((r) => [r.status, r.attempts, r.last_error])).toEqual([
      ["queued", 1, "http 429 rate_limit_exceeded"],
      ["queued", 0, null],
    ]);
  });

  it("R9 on the wire: a 2xx whose id cannot be written leaves the row sending; once the lease lapses the worker re-sends under the SAME key and the provider still holds ONE message", async () => {
    const id = await queue();
    const holder = await queue();
    // The provider will answer with this id, and another row already holds it: the post-send write throws.
    const collide = `re_collide_${RUN}`;
    await sql`update email_outbox set provider_id = ${collide} where id = ${holder}`;
    respond = (call) => {
      messages.set(call.headers["Idempotency-Key"]!, collide);
      return new Response(JSON.stringify({ id: collide }), { status: 200 });
    };
    expect((await dispatchNow([id])).get(id)).toBe("deferred");
    expect((await row(id)).status).toBe("sending");

    await sql`update email_outbox set provider_id = null where id = ${holder}`;
    await sql`update email_outbox set lease_until = now() - interval '1 second' where id = ${id}`;
    expect(await tick([id])).toMatchObject({ claimed: 1, sent: 1 });

    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual([idempotencyKey(id), idempotencyKey(id)]);
    expect(new Set(calls.map((c) => c.headers["Idempotency-Key"])).size, "one key, so one message at the provider").toBe(1);
    const r = await row(id);
    expect([r.status, r.attempts, r.provider_id]).toEqual(["sent", 2, collide]);
  });
});
