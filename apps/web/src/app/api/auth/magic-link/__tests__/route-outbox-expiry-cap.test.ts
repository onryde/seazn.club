// POST /api/auth/magic-link when the outbox refuses the row's expiry (Task 6). `enqueueEmail` refuses an expiry further out
// than MAX_EXPIRY_MS (a retry could outlive Resend's idempotency key and mail twice). The sign-in link expires in 15 minutes, far
// inside the real bound, so this file lowers the bound BELOW the link's lifetime (derived from it: half of it) and proves what the
// route then does: the request fails as a whole, and the token written before the refusal rolls back with it.
//
// Its own file because `vi.mock` of the constants module is per file; route-outbox.test.ts needs the real bound.
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.78" }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));
const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: sentryMock.captureException,
}));
vi.mock("@/server/email-outbox/constants", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/email-outbox/constants")>();
  const { LOGIN_LINK_TTL_MS } = await import("@/lib/login-link");
  return { ...real, MAX_EXPIRY_MS: LOGIN_LINK_TTL_MS / 2 };
});

import { POST } from "../route";
import { consumeLoginLink, createLoginLink, LOGIN_LINK_TTL_MS } from "@/lib/login-link";
import { MAX_EXPIRY_MS } from "@/server/email-outbox/constants";
import { handler } from "@/lib/http";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `mlcap-${randomUUID().slice(0, 8)}`;

describe.skipIf(!HAS_DB)("POST /api/auth/magic-link when the expiry cap refuses the row (DB)", () => {
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
    vi.stubEnv("EMAIL_OUTBOX_KEK", "ab".repeat(32));
    vi.stubEnv("RESEND_API_KEY", "re_t6_cap");
    vi.stubEnv("OAUTH_BASE_URL", "https://signin.test");
    fetchStub.mockClear();
    vi.stubGlobal("fetch", fetchStub);
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("premise: the mocked bound is below the link's lifetime, so the real expiry is over it", () => {
    expect(MAX_EXPIRY_MS).toBeLessThan(LOGIN_LINK_TTL_MS);
  });

  it("the request fails as a whole: the GENERIC 500 (no bound, no outbox vocabulary), no link exposed, and the token row (and the delete of the older one) rolled back", async () => {
    // The app's own generic answer, taken from the global handler for an unexpected non-Error failure.
    const generic = await handler(async () => {
      throw "not an Error";
    });
    const genericBody = await generic.json();
    expect(generic.status, "premise: the handler's generic answer is a 500").toBe(500);
    logMock.error.mockClear();
    sentryMock.captureException.mockClear();

    const email = `${RUN}-${randomUUID().slice(0, 8)}@x.test`;
    emails.push(email);
    // A user with an older unused link, made directly: the route must not delete it when it refuses.
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (email, display_name, email_verified) values (${email}, 'Cap', false) returning id`;
    const older = await createLoginLink(userId);

    const res = await POST(
      new Request("https://signin.test/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
    );
    const raw = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(raw)).toEqual(genericBody);
    expect(raw, "an anonymous caller is told nothing of the bound or the outbox").not.toMatch(/outbox|expir|MAX_|magic_link|bound|KEK/i);
    expect(raw).not.toContain("login_url");
    // The operator is told the real cause: in the log and in Sentry, one each.
    expect(logMock.error).toHaveBeenCalledTimes(1);
    const err = (logMock.error.mock.calls[0]![0] as { err: Error }).err;
    expect(err.name).toBe("OutboxExpiryTooLongError");
    expect(err.message).toMatch(/expiry/i);
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException.mock.calls[0]![0]).toBe(err);

    const links = await sql<{ token: string }[]>`select token from login_links where user_id = ${userId}`;
    expect(links.map((l) => l.token), "no new token; the older one survived the refused request").toEqual([older]);
    expect(await consumeLoginLink(older)).toBe(userId);
    expect(await sql`select 1 from email_outbox where lower(recipient) = ${email}`).toHaveLength(0);
    expect(fetchStub, "nothing was sent").not.toHaveBeenCalled();
  });
});
