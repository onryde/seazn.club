// The Resend webhook route driven end to end against a real Postgres, with nothing of ours replaced: the real signature check,
// the real suppression list (`email_suppressions`), the real `applyProviderEvent` and the real outbox. route.test.ts mocks the
// last two, so it cannot see whether a webhook the route accepts actually moves a row the sender created; this file is that
// seam, producer to consumer: enqueueEmail -> dispatchNow -> (fetch stub = Resend) -> POST /api/webhooks/resend.
// Only the network (global fetch) and the logger are stubbed. The kind hook is observed with a spy so "the seat is released
// once" is a count, not a hope.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { dispatchNow } from "@/server/email-outbox/attempt";
import { OUTBOX_KINDS } from "@/server/email-outbox/constants";
import { enqueueEmail } from "@/server/email-outbox/enqueue";
import { KIND_HOOKS, type EndedRow } from "@/server/email-outbox/hooks";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `t5r-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const KEY_BYTES = randomBytes(24);
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;

describe.skipIf(!HAS_DB)("POST /api/webhooks/resend against the real outbox and suppression list (DB)", () => {
  const savedHooks = {} as Record<(typeof OUTBOX_KINDS)[number], (typeof KIND_HOOKS)[(typeof OUTBOX_KINDS)[number]]>;
  const hookSpy = vi.fn<(row: EndedRow) => Promise<void>>(async () => {});
  const suppressedEmails: string[] = [];

  type Request = { headers: Record<string, string>; body: { tags: { name: string; value: string }[]; to: string[] } };
  const requests: Request[] = [];
  let messageId = "";
  const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: messageId }), { status: 200 });
  });

  /** A signed delivery of `type` for a message, as Svix would send it: the bytes of one HTTP request, reusable to replay it. */
  type Signed = { body: string; headers: Record<string, string> };
  function signed(type: string, data: Record<string, unknown>): Signed {
    const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
    const id = `msg_${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v1,${createHmac("sha256", KEY_BYTES).update(`${id}.${ts}.${body}`).digest("base64")}`;
    return { body, headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sig } };
  }
  /** One POST of exactly those bytes (a new request object each time, the same headers and body). */
  const postSigned = (s: Signed): Promise<Response> =>
    POST(new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", headers: s.headers, body: s.body }));
  /** A fresh signed delivery (new svix-id and timestamp per call). */
  const webhook = (type: string, data: Record<string, unknown>): Promise<Response> => postSigned(signed(type, data));
  const rowOf = async (id: string) => (await sql`select * from email_outbox where id = ${id}`)[0]!;

  async function sendOne(): Promise<{ id: string; to: string }> {
    const to = `${RUN}-${randomUUID()}@x.test`;
    const id = await enqueueEmail(sql, {
      kind: "magic_link",
      refType: "login",
      refId: `${RUN}-${randomUUID()}`,
      orgId: null,
      to,
      subject: "Your sign-in link",
      html: "<a href='https://seazn.club/v?token=T'>Sign in</a>",
      text: "Sign in",
      transactional: true,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect((await dispatchNow([id])).get(id)).toBe("sent");
    suppressedEmails.push(to);
    return { id, to };
  }
  const statusOf = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from email_outbox where id = ${id}`)[0]!.status;
  const suppressionsFor = (email: string) => sql<{ email: string; type: string; provider_id: string | null }[]>`select email, type, provider_id from email_suppressions where email = ${email}`;

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    await sql`delete from email_outbox where ref_id like ${`${RUN}-%`}`;
    if (suppressedEmails.length > 0) await sql`delete from email_suppressions where email in ${sql(suppressedEmails)}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", "re_t5_route");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal("fetch", fetchStub);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    messageId = `re_${RUN}_${randomUUID()}`;
    requests.length = 0;
    fetchStub.mockClear();
    logMock.error.mockClear();
    logMock.warn.mockClear();
    logMock.info.mockClear();
    hookSpy.mockClear();
    for (const k of OUTBOX_KINDS) savedHooks[k] = KIND_HOOKS[k];
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = { onEndedBadly: hookSpy };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const k of OUTBOX_KINDS) KIND_HOOKS[k] = savedHooks[k];
  });

  it("send -> delivered -> complained: the row ends 'complained', the address is suppressed and STAYS suppressed, the hook ran once", async () => {
    const { id, to } = await sendOne();
    const data = { email_id: messageId, to: [to], tags: Object.fromEntries(requests[0]!.body.tags.map((t) => [t.name, t.value])) };
    expect(await statusOf(id)).toBe("sent");

    expect((await webhook("email.delivered", data)).status).toBe(200);
    expect(await statusOf(id)).toBe("delivered");
    expect(await suppressionsFor(to)).toEqual([]); // a delivery suppresses nothing
    expect(hookSpy).not.toHaveBeenCalled();

    expect((await webhook("email.complained", data)).status).toBe(200);
    expect(await statusOf(id)).toBe("complained");
    expect(await suppressionsFor(to)).toEqual([{ email: to, type: "complaint", provider_id: messageId }]);
    expect(hookSpy).toHaveBeenCalledTimes(1);
    expect(hookSpy.mock.calls[0]![0]).toMatchObject({ id, kind: "magic_link", status: "complained" });

    // Resend retries the same complaint, and a late delivered/delayed shows up: all 200, nothing moves, nothing is un-suppressed.
    for (const type of ["email.complained", "email.delivered", "email.delivery_delayed", "email.bounced"]) {
      expect((await webhook(type, data)).status, type).toBe(200);
      expect(await statusOf(id), type).toBe("complained");
    }
    expect(await suppressionsFor(to)).toEqual([{ email: to, type: "complaint", provider_id: messageId }]);
    expect(hookSpy).toHaveBeenCalledTimes(1); // the seat is not released twice for one row
  });

  it("send -> bounced: suppressed as a bounce and the row ends 'bounced'; a delivered that arrives afterwards changes neither", async () => {
    const { id, to } = await sendOne();
    const data = { email_id: messageId, to: [to] };
    expect((await webhook("email.bounced", data)).status).toBe(200);
    expect(await statusOf(id)).toBe("bounced");
    expect(await suppressionsFor(to)).toEqual([{ email: to, type: "bounce", provider_id: messageId }]);
    expect((await webhook("email.delivered", data)).status).toBe(200);
    expect(await statusOf(id)).toBe("bounced");
    expect(hookSpy).toHaveBeenCalledTimes(1);
  });

  it("an event for an email that is not on the outbox is 200 and changes no outbox row; a bounce for it still suppresses the address", async () => {
    const { id } = await sendOne();
    const stranger = `${RUN}-stranger-${randomUUID()}@x.test`;
    suppressedEmails.push(stranger);
    expect((await webhook("email.delivered", { email_id: `re_${RUN}_nobody`, to: [stranger] })).status).toBe(200);
    expect((await webhook("email.bounced", { email_id: `re_${RUN}_nobody`, to: [stranger] })).status).toBe(200);
    expect(await statusOf(id)).toBe("sent");
    expect(await suppressionsFor(stranger)).toEqual([{ email: stranger, type: "bounce", provider_id: `re_${RUN}_nobody` }]);
    expect(hookSpy).not.toHaveBeenCalled();
  });

  it.each(["email.complained", "email.bounced", "email.delivered"])(
    "the SAME signed request, byte for byte, posted twice (Resend retried it): the second is a no-op - %s",
    async (type) => {
      const { id, to } = await sendOne();
      const req = signed(type, { email_id: messageId, to: [to] });
      const replay = { body: req.body, headers: { ...req.headers } };

      expect((await postSigned(req)).status).toBe(200);
      const afterFirst = await rowOf(id);
      const suppressionAfterFirst = await suppressionsFor(to);
      const hooksAfterFirst = hookSpy.mock.calls.length;
      expect(afterFirst.status).toBe(type.replace("email.", "")); // the first really moved the row: delivered | complained | bounced
      expect(hooksAfterFirst).toBe(type === "email.delivered" ? 0 : 1);

      expect(replay).toEqual(req); // anti-vacuity: the replay IS the same bytes (same svix-id, timestamp, signature, body)
      expect((await postSigned(replay)).status).toBe(200);
      // Nothing about the row changed (status_at included: a second UPDATE would have refreshed it), nothing re-suppressed,
      // no second hook.
      expect(await rowOf(id)).toEqual(afterFirst);
      expect(await suppressionsFor(to)).toEqual(suppressionAfterFirst);
      expect(suppressionAfterFirst.length).toBe(type === "email.delivered" ? 0 : 1);
      expect(hookSpy.mock.calls.length).toBe(hooksAfterFirst);
    },
  );

  it("an unsigned request moves nothing and suppresses nothing, however well-formed the event", async () => {
    const { id, to } = await sendOne();
    const body = JSON.stringify({ type: "email.complained", data: { email_id: messageId, to: [to] } });
    const res = await POST(new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", body }));
    expect(res.status).toBe(401);
    expect(await statusOf(id)).toBe("sent");
    expect(await suppressionsFor(to)).toEqual([]);
  });
});
