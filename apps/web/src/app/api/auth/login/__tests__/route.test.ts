// POST /api/auth/login, unverified password account: the route re-sends the
// verification link, and that link must carry the `next` the login already has.
//
// An invited person who signs up and loses the verification email comes back
// through the invite's sign-in form, which posts `{ email, password, next }`.
// The route used to re-send `/verify-email?token=…` WITHOUT that `next`, so
// verifying through the re-sent link landed them on /onboarding, with a fresh
// default org, instead of on the invite they were trying to accept. The signup
// route carries it (`safeNextPath`, then `&next=` + encodeURIComponent); the
// re-send now does the same.
//
// Driven through the REAL login route, the REAL token store, and then the REAL
// verify page and route via `openVerifyLink`, so the assertion is where the
// person lands. Stand-ins: the mail sender (captured, never sent), the limiter
// (pinned in ../../__tests__/token-rate-limits.test.ts), and `next/headers`.
//
// Sport: not applicable. This path is sport-agnostic auth.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.10" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

// ONE stable router object, so the verify page's effect fires once.
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const mail = vi.hoisted(() => ({ sent: [] as { to: string; link: string }[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendVerificationEmail: vi.fn(async (to: string, link: string) => {
    mail.sent.push({ to, link });
    return true;
  }),
}));

import { sql } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import {
  FIRST_RUN_WIZARD,
  ORIGIN,
  PRODUCER_NEXTS,
  UNSAFE_NEXTS,
  openVerifyLink,
  warmDefaultLanding,
} from "../../__tests__/_verify-link";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const PASSWORD = "correct-horse-1";
const made: string[] = [];

/** A password account that signed up and never verified. */
async function unverified(): Promise<{ id: string; email: string }> {
  const email = `login-next-${randomUUID()}@example.test`;
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, password_hash, display_name, email_verified)
    values (${email}, ${await hashPassword(PASSWORD)}, 'Login Next', false)
    returning id`;
  made.push(u.id);
  return { id: u.id, email };
}

async function login(body: unknown): Promise<{ status: number; error?: string }> {
  const res = await POST(
    new Request(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as { error?: string };
  return { status: res.status, error: json.error };
}

/** Log in as an unverified account and return the ONE link the re-send mailed. */
async function resentLink(email: string, next?: string): Promise<URL> {
  mail.sent = [];
  const r = await login({ email, password: PASSWORD, ...(next === undefined ? {} : { next }) });
  // The re-send is a refusal: the person is told to check their mail. Its
  // status is today's mapping of a thrown Error and is deliberately not frozen.
  expect(r.error).toBe("Your email isn't verified yet — we've re-sent the verification link.");
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(mail.sent.map((m) => m.to)).toEqual([email]);
  return new URL(mail.sent[0]!.link);
}

async function emailVerified(userId: string): Promise<boolean> {
  const [row] = await sql<{ v: boolean }[]>`select email_verified as v from users where id = ${userId}`;
  return row.v;
}

beforeAll(async () => {
  if (HAS_DB) await warmDefaultLanding();
});

beforeEach(() => {
  jar.values.clear();
  router.push.mockClear();
  router.refresh.mockClear();
});

afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from organizations where created_by = any(${made})`;
  await sql`delete from subscriptions where owner_user_id = any(${made})`;
  await sql`delete from users where id = any(${made})`;
});

describe.skipIf(!HAS_DB)("POST /api/auth/login — the re-sent verification link carries next", () => {
  it("for each of the four next producers, opening the re-sent link lands the person on that next", async () => {
    let checked = 0;
    for (const next of PRODUCER_NEXTS) {
      const user = await unverified();
      const link = await resentLink(user.email, next);
      expect(link.searchParams.get("next"), `${next}: carried into the link`).toBe(next);

      jar.values.clear();
      router.push.mockClear();
      const opened = await openVerifyLink(link.href, router.push);

      expect(opened.landed, `${next}: where the person lands`).toBe(next);
      expect(await emailVerified(user.id), next).toBe(true);
      checked++;
    }
    expect(checked).toBe(PRODUCER_NEXTS.length);
    expect(checked).toBe(4);
  });

  it("an unsafe next never reaches the re-sent link, so opening it gives the default landing", async () => {
    let checked = 0;
    for (const evil of UNSAFE_NEXTS) {
      expect(new URL(evil, ORIGIN).origin, `${evil} escapes the origin`).not.toBe(ORIGIN);
      const user = await unverified();
      const link = await resentLink(user.email, evil);
      expect(link.searchParams.has("next"), `${evil}: kept out of the link`).toBe(false);

      jar.values.clear();
      router.push.mockClear();
      const opened = await openVerifyLink(link.href, router.push);

      expect(opened.landed, evil).toBe(FIRST_RUN_WIZARD);
      checked++;
    }
    expect(checked).toBe(UNSAFE_NEXTS.length);
    expect(checked).toBe(4);
  });

  it("with no next (the empty case), the re-sent link carries none and lands on the first-run wizard", async () => {
    const user = await unverified();
    const link = await resentLink(user.email);
    expect(link.searchParams.has("next")).toBe(false);

    const opened = await openVerifyLink(link.href, router.push);

    expect(opened.landed).toBe(FIRST_RUN_WIZARD);
    expect(await emailVerified(user.id)).toBe(true);
  });

  it("a second login re-sends a second link that carries the next as well, and both links work", async () => {
    // The re-send mints a token per login and never deletes earlier ones
    // (lib/verification.ts), so the first email still works after the second.
    const user = await unverified();
    const next = PRODUCER_NEXTS[0]!;
    const first = await resentLink(user.email, next);
    const second = await resentLink(user.email, next);
    expect(second.searchParams.get("token")).not.toBe(first.searchParams.get("token"));
    expect(second.searchParams.get("next")).toBe(next);

    let checked = 0;
    for (const link of [second, first]) {
      jar.values.clear();
      router.push.mockClear();
      const opened = await openVerifyLink(link.href, router.push);
      expect(opened.landed, link.href).toBe(next);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
