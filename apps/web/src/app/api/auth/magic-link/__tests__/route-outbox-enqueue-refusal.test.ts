// POST /api/auth/magic-link when the ENQUEUE itself refuses for want of a key (Task 6, fix round 2).
//
// The route checks `outboxKeyProblem()` before it touches the account (so every address gets one answer on a misconfigured box,
// route-outbox.test.ts). That makes the catch around `sql.begin` unreachable for the KEY refusal by any ordinary request: the same
// rule decides both. The catch is still the route's last line of defence for the day `enqueueEmail` grows a refusal the pre-check
// does not know about, and "two guards covering for each other are each untested". So this file removes the first guard (the
// pre-check is stubbed to say "ready") and leaves the real `enqueueEmail`, which then refuses, and proves what the catch does on
// its own: the generic 500 to the caller, the real cause to the operator, and the transaction rolled back.
//
// Its own file because `vi.mock` of the outbox index is per file.
//
// Sport: not applicable. Sign-in is sport-agnostic.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.79" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: sentryMock.captureException,
}));
// The first guard, removed: the route's pre-check sees a ready box. Everything else of the outbox is the real thing.
vi.mock("@/server/email-outbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/email-outbox")>()),
  outboxKeyProblem: () => null,
}));

import { POST } from "../route";
import { handler } from "@/lib/http";
import { consumeLoginLink, createLoginLink } from "@/lib/login-link";
import { OutboxKeyUnavailableError, outboxKeyProblem } from "@/server/email-outbox";
import { sealBody } from "@/server/email-outbox/seal";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `mlkey-${randomUUID().slice(0, 8)}`;
const LEAKS = /KEK|RESEND|outbox|\.env|sample|NODE_ENV|openssl/i;

describe.skipIf(!HAS_DB)("POST /api/auth/magic-link when enqueueEmail refuses for want of a key (DB)", () => {
  const emails: string[] = [];
  const fetchStub = vi.fn(async () => new Response(JSON.stringify({ id: `re_${RUN}` }), { status: 200 }));

  beforeAll(async () => {
    await sql`select 1`;
  });
  afterAll(async () => {
    if (emails.length > 0) {
      await sql`delete from email_outbox where lower(recipient) = any(${emails})`;
      await sql`delete from users where email = any(${emails})`;
    }
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });
  beforeEach(() => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    vi.stubEnv("RESEND_API_KEY", "re_t6_enqueue_refusal");
    vi.stubEnv("OAUTH_BASE_URL", "https://signin.test");
    fetchStub.mockClear();
    for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug, sentryMock.captureException]) m.mockClear();
    vi.stubGlobal("fetch", fetchStub);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("premise: the route's pre-check is stubbed to 'ready' while the real seal still refuses this very environment", () => {
    expect(outboxKeyProblem()).toBeNull();
    expect(() => sealBody({ html: "<p>x</p>", text: "x" })).toThrow(OutboxKeyUnavailableError);
  });

  it("the catch alone answers the generic 500, tells the operator the real cause, and rolls the token back with the refused row", async () => {
    const generic = await handler(async () => {
      throw "not an Error";
    });
    const genericBody = await generic.json();
    for (const m of [logMock.error, sentryMock.captureException]) m.mockClear();

    const email = `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
    emails.push(email);
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, 'Key', false) returning id`;
    const older = await createLoginLink(userId); // the route must not delete it when it refuses

    const res = await POST(
      new Request("https://signin.test/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    const raw = await res.text();
    expect(res.status).toBe(generic.status);
    expect(JSON.parse(raw)).toEqual(genericBody);
    expect(raw).not.toMatch(LEAKS);
    expect(raw).not.toContain("login_url");

    // The operator: one log line and one Sentry event, the same real error, naming the variable.
    expect(logMock.error).toHaveBeenCalledTimes(1);
    const err = (logMock.error.mock.calls[0]![0] as { err: Error }).err;
    expect(err).toBeInstanceOf(OutboxKeyUnavailableError);
    expect(err.message).toMatch(/EMAIL_OUTBOX_KEK/);
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException.mock.calls[0]![0]).toBe(err);

    // Rolled back: the token minted inside the transaction is gone, and so is the delete of the older link.
    const links = await sql<{ token: string }[]>`select token from login_links where user_id = ${userId}`;
    expect(links.map((l) => l.token), "no new token; the older one survived").toEqual([older]);
    expect(await consumeLoginLink(older)).toBe(userId);
    expect(await sql`select 1 from email_outbox where lower(recipient) = ${email}`).toHaveLength(0);
    expect(fetchStub, "nothing was sent").not.toHaveBeenCalled();
  });
});
