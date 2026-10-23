// POST /api/auth/magic-link on the email outbox (Task 6), driven end to end against a real Postgres. The REAL route handler,
// the REAL token minter, the REAL outbox (enqueue, dispatch, retry worker, sealing) and the REAL Resend webhook route run;
// the only stand-ins are the network (global `fetch` IS Resend), the rate limiter, `next/headers` and the logger (captured).
//
// What this file proves, producer to consumer:
//   request -> token row + outbox row in ONE transaction -> after commit, dispatchNow -> Resend -> the row is `sent` with the
//   provider's id -> the webhook moves it to `delivered`; and the response the person sees is byte-for-byte what it was
//   before the outbox existed.
//
// Controller ruling R4: e2e/passwordless-login.spec.ts is skipped under E2E_PROD_TARGET in CI, so this file (not that spec)
// is the proof of the seam that CI actually runs.
//
// Sport: not applicable. Sign-in is sport-agnostic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import emailsEn from "@/dictionaries/en/emails.json";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.77" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));

import { POST } from "../route";
import { POST as WEBHOOK } from "@/app/api/webhooks/resend/route";
import { suppress } from "@/lib/email";
import { consumeLoginLink, LOGIN_LINK_TTL_MS } from "@/lib/login-link";
import { idempotencyKey } from "@/server/email-outbox/constants";
import { openBody, OutboxKeyUnavailableError } from "@/server/email-outbox/seal";
import { runOutboxTick } from "@/server/email-outbox/worker";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `ml-${randomUUID().slice(0, 8)}`;
const KEK = "ab".repeat(32);
const API_KEY = "re_t6_route";
const ORIGIN = "https://signin.test";
const WEBHOOK_KEY = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString("base64")}`;
/** The message the person is shown. It is the contract: the route's answer must not change with the outbox. */
const MESSAGE = "Check your email — a sign-in link is on its way.";

type Call = { url: string; headers: Record<string, string>; body: { to: string[]; subject: string; html: string; text: string; tags: { name: string; value: string }[] } };
type Seen = { outboxStatus: string | null; tokenRowExists: boolean };
type Envelope = { ok: boolean; error?: string; data?: { message?: string; login_url?: string } };
type OutboxRow = {
  id: string; kind: string; ref_type: string; ref_id: string; org_id: string | null; meta: unknown; recipient: string;
  subject: string; transactional: boolean; status: string; attempts: number; expires_at: Date; last_error: string | null;
  provider_id: string | null; cleared: boolean;
};

describe.skipIf(!HAS_DB)("POST /api/auth/magic-link writes the token and the outbox row together and sends after commit (DB)", () => {
  const emails: string[] = [];
  const calls: Call[] = [];
  const seenAtSend: Seen[] = [];
  const messages = new Map<string, string>(); // Idempotency-Key -> Resend message id
  let respond: (call: Call) => Response | Promise<Response>;

  /** What the provider answers with: one message per Idempotency-Key, like Resend. */
  const accept = (call: Call): Response => {
    const key = call.headers["Idempotency-Key"]!;
    if (!messages.has(key)) messages.set(key, `re_${RUN}_${randomUUID()}`);
    return new Response(JSON.stringify({ id: messages.get(key) }), { status: 200 });
  };
  const resendError = (status: number, name: string, echo: string): Response =>
    new Response(JSON.stringify({ statusCode: status, name, message: `RAW-PROVIDER-MESSAGE ${echo}` }), { status });

  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    const call: Call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    // At the instant of sending, ask the database (a DIFFERENT connection) what a reader sees: the outbox row must already be
    // committed and claimed, and so must the token it carries. A send before the commit sees neither.
    const outboxId = call.body.tags.find((t) => t.name === "outbox")?.value;
    const token = /token=([A-Za-z0-9_-]+)/.exec(call.body.text)?.[1];
    const [row] = outboxId ? await sql<{ status: string }[]>`select status from email_outbox where id = ${outboxId}` : [];
    const [link] = token ? await sql<{ n: number }[]>`select count(*)::int as n from login_links where token = ${token}` : [];
    calls.push(call);
    seenAtSend.push({ outboxStatus: row?.status ?? null, tokenRowExists: (link?.n ?? 0) > 0 });
    return respond(call);
  });

  const newEmail = (): string => {
    const email = `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
    emails.push(email);
    return email;
  };
  const post = async (body: unknown): Promise<{ status: number; json: Envelope; raw: string }> => {
    const res = await POST(
      new Request(`${ORIGIN}/api/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const raw = await res.text();
    return { status: res.status, json: JSON.parse(raw) as Envelope, raw };
  };
  const rowsFor = (email: string) =>
    sql<OutboxRow[]>`
      select id, kind, ref_type, ref_id, org_id, meta, recipient, subject, transactional, status, attempts, expires_at,
             last_error, provider_id, body_sealed is null as cleared
        from email_outbox where lower(recipient) = lower(${email}) order by created_at, id`;
  const userIdOf = async (email: string) => (await sql<{ id: string }[]>`select id from users where email = ${email}`)[0]!.id;
  const linksOf = (userId: string) =>
    sql<{ token: string; expires_at: Date; used: boolean }[]>`select token, expires_at, used from login_links where user_id = ${userId} order by created_at, id`;
  const tokenOf = (url: string | undefined): string => new URL(url!).searchParams.get("token")!;
  /** The link as the provider received it, plain text: the one a person clicks. */
  const textLinkOf = (call: Call): string => /(https?:\/\/\S+)/.exec(call.body.text)![1]!;

  /** A signed webhook delivery, as Svix would send it (signed from the vendor's rule, not the route's helper). */
  const webhook = (type: string, data: Record<string, unknown>): Promise<Response> => {
    const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
    const id = `msg_${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v1,${createHmac("sha256", WEBHOOK_KEY).update(`${id}.${ts}.${body}`).digest("base64")}`;
    return WEBHOOK(new NextRequest("http://localhost/api/webhooks/resend", { method: "POST", headers: { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": sig }, body }));
  };

  /** Every place a log line could go, as one string with Errors expanded (JSON.stringify renders an Error as {}). */
  const allLogged = (): string =>
    JSON.stringify(
      [logMock.error, logMock.warn, logMock.info, logMock.debug, ...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.mocked(console[m]))].map((m) => m.mock.calls),
      (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack, cause: String(v.cause) } : v),
    );

  beforeAll(async () => {
    await sql`select 1`; // the pool is built before any env is stubbed
  });
  afterAll(async () => {
    if (emails.length > 0) {
      await sql`delete from email_outbox where lower(recipient) = any(${emails.map((e) => e.toLowerCase())})`;
      await sql`delete from email_suppressions where email = any(${emails})`;
      await sql`delete from users where email = any(${emails})`; // login_links cascade
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("OAUTH_BASE_URL", ORIGIN);
    vi.stubEnv("AUTH_DEV_LINKS", undefined);
    calls.length = 0;
    seenAtSend.length = 0;
    messages.clear();
    fetchStub.mockClear();
    for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug]) m.mockClear();
    respond = accept;
    vi.stubGlobal("fetch", fetchStub);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- the row ----------------------------------------------------------------------------------------------------

  it("one request writes one magic_link row: ref user/<userId>, transactional, no org, expiring exactly when the link does", async () => {
    const email = newEmail();
    const t0 = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const res = await post({ email });
    vi.useRealTimers();
    expect(res.status).toBe(200);

    const userId = await userIdOf(email);
    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect([r.kind, r.ref_type, r.ref_id, r.org_id, r.recipient, r.transactional, r.meta]).toEqual([
      "magic_link", "user", userId, null, email, true, {},
    ]);
    expect(r.subject).toBe(emailsEn["magicLink.subject" as keyof typeof emailsEn]);

    // The row expires WITH the link: the same instant the token row stores, TTL after the request began.
    const links = await linksOf(userId);
    expect(links).toHaveLength(1);
    expect(r.expires_at.getTime()).toBe(links[0]!.expires_at.getTime());
    expect(r.expires_at.getTime()).toBe(t0.getTime() + LOGIN_LINK_TTL_MS);
    // ...and the credential really does live exactly that long (the row's expiry is not a second clock that can drift).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(r.expires_at.getTime() + 1000));
    expect(await consumeLoginLink(links[0]!.token), "one second after the row's expiry the link is dead").toBeNull();
    vi.useRealTimers();
  });

  it("the live link is consumable until the row's expiry: the row never outlives or undercuts the credential", async () => {
    const email = newEmail();
    const res = await post({ email });
    const token = tokenOf(res.json.data?.login_url);
    const [r] = await rowsFor(email);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(r!.expires_at.getTime() - 1000));
    expect(await consumeLoginLink(token), "one second before the row's expiry the link works").toBe(await userIdOf(email));
  });

  it("a send that Resend accepts ends the row 'sent' with the provider's id and no body left", async () => {
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(200);
    const [r] = await rowsFor(email);
    expect(calls).toHaveLength(1);
    expect([r!.status, r!.attempts, r!.provider_id, r!.cleared, r!.last_error]).toEqual([
      "sent", 1, messages.get(idempotencyKey(r!.id)), true, null,
    ]);
    expect(r!.provider_id, "premise: the stub issued an id").toBeTruthy();
  });

  // ---- producer -> consumer -----------------------------------------------------------------------------------------

  it("the link Resend received is the login_url the route exposed, and its token signs the person in", async () => {
    const email = newEmail();
    const res = await post({ email, next: "/join/some-token" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const exposed = res.json.data?.login_url;
    expect(exposed, "premise: the dev path exposes the link").toBeTruthy();
    expect(textLinkOf(call)).toBe(exposed);
    expect(call.body.html).toContain(tokenOf(exposed));
    expect(exposed).toBe(`${ORIGIN}/magic-link?token=${tokenOf(exposed)}&next=${encodeURIComponent("/join/some-token")}`);

    // The wire: addressed to the person, tagged with the row, idempotent under the row's own key, authorised.
    const [r] = await rowsFor(email);
    expect(call.body.to).toEqual([email]);
    expect(call.body.tags).toEqual([{ name: "outbox", value: r!.id }]);
    expect(call.headers["Idempotency-Key"]).toBe(idempotencyKey(r!.id));
    expect(call.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.body.subject).toBe(r!.subject);

    // The consumer: the token in what was mailed is the one the app accepts.
    expect(await consumeLoginLink(tokenOf(exposed))).toBe(await userIdOf(email));
  });

  it("dispatch happens inside the request and after the commit: when the response resolves the mail has gone, and at send time the row and its token were already visible", async () => {
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(calls, "the send finished before the response resolved").toHaveLength(1);
    // A send made before the transaction committed would see no row at all (and its claim would find nothing to claim).
    expect(seenAtSend).toEqual([{ outboxStatus: "sending", tokenRowExists: true }]);
  });

  it("a sign-in address on the suppression list is still mailed: the link is transactional", async () => {
    const email = newEmail();
    await suppress(email, "manual");
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await rowsFor(email))[0]!.status).toBe("sent");
  });

  // ---- the response is unchanged ----------------------------------------------------------------------------------

  it("development: 200, the unchanged message, and the link under login_url (exactly these keys)", async () => {
    const res = await post({ email: newEmail() });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(["data", "ok"]);
    expect(res.json.ok).toBe(true);
    expect(Object.keys(res.json.data!).sort()).toEqual(["login_url", "message"]);
    expect(res.json.data!.message).toBe(MESSAGE);
  });

  it("production without AUTH_DEV_LINKS: the same 200 and message, and NO login_url anywhere in the body", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { message: MESSAGE } });
    const link = textLinkOf(calls[0]!);
    expect(res.raw, "the live link must not leak into the body").not.toContain(tokenOf(link));
    expect(calls, "premise: the mail was sent, so the link existed").toHaveLength(1);
  });

  it("production with AUTH_DEV_LINKS=1 (a harness server) exposes the link, as before", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_DEV_LINKS", "1");
    const res = await post({ email: newEmail() });
    expect(res.json.data?.login_url).toBe(textLinkOf(calls[0]!));
  });

  it("a 500 from Resend in production mode: still 200, the unchanged message, no login_url; the row waits for a retry with its body sealed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    respond = () => resendError(500, "application_error", "ECHOED-PROVIDER-TEXT");
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { message: MESSAGE } });
    expect(calls).toHaveLength(1);
    const [r] = await rowsFor(email);
    expect([r!.status, r!.attempts, r!.provider_id, r!.cleared, r!.last_error]).toEqual([
      "queued", 1, null, false, "http 500 application_error",
    ]);
  });

  it("an address that cannot be signed in (held by a deleted account) gets the same answer and nothing is queued", async () => {
    const email = newEmail();
    await sql`insert into users (email, display_name, email_verified, deleted_at) values (${email}, 'Gone', false, now())`;
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: { message: MESSAGE } });
    expect(calls).toHaveLength(0);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it("a malformed request is refused as before (400) and queues nothing", async () => {
    const email = newEmail();
    const res = await post({ email, unexpected: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Invalid input");
    expect(calls).toHaveLength(0);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it("a box with no Resend key (CI, a laptop): 200 and the dev link as before; the row ends dead, its body gone", async () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(200);
    expect(res.json.data?.login_url, "dev capture keeps working with no mail").toMatch(new RegExp(`^${ORIGIN}/magic-link\\?token=`));
    expect(calls).toHaveLength(0);
    const rows = await rowsFor(email);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.status, rows[0]!.cleared, rows[0]!.last_error]).toEqual(["dead", true, "no_api_key"]);
    // The dev link is still a working credential.
    expect(await consumeLoginLink(tokenOf(res.json.data!.login_url))).toBe(await userIdOf(email));
  });

  // ---- a request that cannot be queued is not half done ----------------------------------------------------------

  it("committed <=> queued: a box that can send but cannot seal refuses the request, and leaves the earlier link and mail untouched", async () => {
    const email = newEmail();
    const first = await post({ email });
    const userId = await userIdOf(email);
    const [firstRow] = await rowsFor(email);
    const [firstLink] = await linksOf(userId);
    expect(firstRow!.status, "premise: the first request was sent").toBe("sent");
    calls.length = 0;

    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined); // the Resend key is still set: OutboxKeyUnavailableError
    const second = await post({ email });
    expect(second.status).toBe(500);
    expect(second.json.ok).toBe(false);
    expect(second.json.error).toBe(new OutboxKeyUnavailableError().message);
    expect(second.json.data).toBeUndefined();
    expect(second.raw, "a refused request exposes no link").not.toContain("login_url");

    // The token written before the refusal rolled back WITH it, and so did the delete of the older link.
    const links = await linksOf(userId);
    expect(links.map((l) => l.token)).toEqual([firstLink!.token]);
    expect(links[0]!.token).toBe(tokenOf(first.json.data?.login_url));
    expect(await consumeLoginLink(links[0]!.token), "the earlier link still signs the person in").toBe(userId);
    // No new row, and the earlier one was not replaced.
    const rows = await rowsFor(email);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[firstRow!.id, "sent"]]);
    expect(calls, "nothing was sent for the refused request").toHaveLength(0);
  });

  it("committed <=> queued: for a first-time address a refused request leaves no token and no row", async () => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    const email = newEmail();
    const res = await post({ email });
    expect(res.status).toBe(500);
    const userId = await userIdOf(email); // the account itself was made before the link, as it always was
    expect(await linksOf(userId)).toHaveLength(0);
    expect(await rowsFor(email)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("committed <=> queued, at the commit: a transaction that fails AFTER the row was written leaves no new row, does not replace the earlier one, and sends nothing", async () => {
    const email = newEmail();
    await post({ email });
    const userId = await userIdOf(email);
    const [first] = await rowsFor(email);
    const [firstLink] = await linksOf(userId);
    expect(first!.status, "premise: the first request was sent").toBe("sent");
    calls.length = 0;

    // A constraint trigger that fails the transaction at COMMIT, for this user's next token only (a random uuid, so it is
    // inert for every other test sharing the database). By then the outbox row has been written: whatever handle wrote it
    // decides whether that row survives, and whether the replace trigger already marked the earlier row `replaced`.
    const fn = `t6_refuse_commit_${RUN.replace(/-/g, "_")}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'refused at commit'; end $$`);
    await sql.unsafe(
      `create constraint trigger ${fn} after insert on login_links deferrable initially deferred for each row when (new.user_id = '${userId}') execute function ${fn}()`,
    );
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post({ email });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on login_links`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }

    expect(res.status).toBe(500);
    expect(res.raw).not.toContain("login_url");
    expect((await rowsFor(email)).map((r) => [r.id, r.status]), "no new row; the earlier row was not replaced").toEqual([[first!.id, "sent"]]);
    expect((await linksOf(userId)).map((l) => l.token), "the earlier link survived").toEqual([firstLink!.token]);
    expect(calls, "nothing was sent").toHaveLength(0);
  });

  // ---- sequences --------------------------------------------------------------------------------------------------

  it("two requests in a row after a failed first send: the first row is replaced and its link is dead; only the second link is ever delivered, by the request and by the worker", async () => {
    const email = newEmail();
    respond = () => resendError(500, "application_error", "x");
    const first = await post({ email });
    const userId = await userIdOf(email);
    const [row1] = await rowsFor(email);
    expect(row1!.status, "premise: the first send failed and is waiting for a retry").toBe("queued");
    const token1 = tokenOf(first.json.data?.login_url);
    expect(calls).toHaveLength(1);

    respond = accept;
    const second = await post({ email });
    const token2 = tokenOf(second.json.data?.login_url);
    expect(token2).not.toBe(token1);

    const rows = await rowsFor(email);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect(rows[0]!.cleared, "the replaced row's body is gone").toBe(true);
    expect((await linksOf(userId)).map((l) => l.token)).toEqual([token2]);
    expect(await consumeLoginLink(token1), "the first link is dead").toBeNull();
    expect(calls.map((c) => tokenOf(textLinkOf(c)))).toEqual([token1, token2]);

    // The retry worker finds nothing to send for the replaced row even if it were due.
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${row1!.id}`;
    const report = await runOutboxTick({ onlyIds: rows.map((r) => r.id) });
    expect(report.claimed).toBe(0);
    expect(calls, "no third send: the dead link is never mailed").toHaveLength(2);

    expect(await consumeLoginLink(token2)).toBe(userId);
  });

  it("two requests in a row after a successful first send: the first row is replaced, the second sent; a different person's row is untouched", async () => {
    const email = newEmail();
    const other = newEmail();
    await post({ email });
    await post({ email: other });
    await post({ email });
    const rows = await rowsFor(email);
    expect(rows.map((r) => r.status)).toEqual(["replaced", "sent"]);
    expect((await rowsFor(other)).map((r) => r.status), "another user's sign-in row is not replaced").toEqual(["sent"]);
    expect(calls).toHaveLength(3);
  });

  it("a first row already delivered stays delivered when the person asks again (history is not rewritten)", async () => {
    const email = newEmail();
    await post({ email });
    const [row1] = await rowsFor(email);
    expect((await webhook("email.delivered", { email_id: row1!.provider_id })).status).toBe(200);
    expect((await rowsFor(email))[0]!.status).toBe("delivered");
    await post({ email });
    expect((await rowsFor(email)).map((r) => r.status)).toEqual(["delivered", "sent"]);
  });

  it("retry after a 500: the worker re-sends the SAME link under the same key, one message results, and the webhook then reports delivered", async () => {
    const email = newEmail();
    respond = () => resendError(500, "application_error", "x");
    const requested = await post({ email });
    const link = requested.json.data!.login_url!;
    const [queued] = await rowsFor(email);
    expect(queued!.status).toBe("queued");
    expect(calls).toHaveLength(1);

    // The retry is due.
    respond = accept;
    await sql`update email_outbox set next_attempt_at = now() - interval '1 second' where id = ${queued!.id}`;
    const report = await runOutboxTick({ onlyIds: [queued!.id] });
    expect([report.claimed, report.sent, report.failed]).toEqual([1, 1, 0]);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["Idempotency-Key"]).toBe(calls[0]!.headers["Idempotency-Key"]);
    expect(textLinkOf(calls[1]!), "the retry carries the link the person was shown").toBe(link);
    expect(messages.size, "one provider message for two attempts").toBe(1);
    const [sent] = await rowsFor(email);
    expect([sent!.status, sent!.attempts, sent!.cleared, sent!.provider_id]).toEqual(["sent", 2, true, messages.get(idempotencyKey(sent!.id))]);
    expect(await consumeLoginLink(tokenOf(link)), "the link in the retried mail still works").toBe(await userIdOf(email));

    // The provider reports delivery.
    expect((await webhook("email.delivered", { email_id: sent!.provider_id })).status).toBe(200);
    expect((await rowsFor(email))[0]!.status).toBe("delivered");
  });

  it("a retry that falls due after the link has expired is never sent: the row ends expired, body gone", async () => {
    const email = newEmail();
    respond = () => resendError(500, "application_error", "x");
    await post({ email });
    const [queued] = await rowsFor(email);
    // Time passes: the link's whole lifetime and a second more (the row's expiry minus that is the moment of the request).
    await sql`update email_outbox
                 set expires_at = expires_at - make_interval(secs => ${LOGIN_LINK_TTL_MS / 1000 + 1}),
                     next_attempt_at = now() - interval '1 second'
               where id = ${queued!.id}`;
    respond = accept;
    const report = await runOutboxTick({ onlyIds: [queued!.id] });
    expect(report.expired).toBe(1);
    expect(calls, "no second attempt: a late sign-in link is worse than none").toHaveLength(1);
    const [r] = await rowsFor(email);
    expect([r!.status, r!.cleared]).toEqual(["expired", true]);
  });

  // ---- the credential never leaves the sealed body -----------------------------------------------------------------

  it("the token appears in no plaintext column of the row and in no log line; the sealed body, opened, holds the link", async () => {
    vi.stubEnv("NODE_ENV", "production");
    respond = () => resendError(500, "application_error", "ECHOED-PROVIDER-TEXT");
    const email = newEmail();
    await post({ email });
    const token = tokenOf(textLinkOf(calls[0]!));
    const [row] = await sql<{ plain: string; sealed: Buffer | null }[]>`
      select (to_jsonb(o) - 'body_sealed')::text as plain, body_sealed as sealed
        from email_outbox o where lower(recipient) = lower(${email})`;
    expect(row!.sealed, "premise: the row is queued, so its body is stored").not.toBeNull();

    expect(row!.plain, "no plaintext column holds the token (subject, meta, recipient, refs, last_error)").not.toContain(token);
    expect(row!.sealed!.includes(Buffer.from(token)), "the stored body is sealed, not plaintext").toBe(false);
    expect(openBody(row!.sealed!).text, "premise: the sealed body does carry the link").toContain(token);

    const logged = allLogged();
    expect(logged.length, "premise: the failed send was logged somewhere").toBeGreaterThan("[[],[],[],[],[],[],[],[],[]]".length);
    expect(logged, "no log line carries the token").not.toContain(token);
    expect(logged, "nor Resend's echoed text").not.toContain("ECHOED-PROVIDER-TEXT");
  });

  it("the token is in no log line on a successful send either", async () => {
    const email = newEmail();
    const res = await post({ email });
    expect(allLogged()).not.toContain(tokenOf(res.json.data?.login_url));
    const [r] = await rowsFor(email);
    expect(JSON.stringify(r)).not.toContain(tokenOf(res.json.data?.login_url));
  });
});

describe("without a database", () => {
  it("the route module loads and is a POST handler (the DB cases above are skipped)", () => {
    expect(typeof POST).toBe("function");
    expect(typeof WEBHOOK).toBe("function");
  });
});
