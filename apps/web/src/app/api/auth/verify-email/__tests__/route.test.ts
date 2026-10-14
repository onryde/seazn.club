// POST /api/auth/verify-email must verify a link that carries `next`.
//
// Measured live on staging, 2026-10-14: the route's schema was
// `z.object({ token }).strict()`, while `components/verify-email.tsx` POSTs
// `{ token, next }` whenever the emailed link carries one. Four pages hand
// `AuthForm` a `next`, and a signup through any of them puts it in the link:
// invite (`/join/{token}`), claim (`/claim/{token}`), check-in
// (`/checkin/{token}`) and the login page (any safe `?next=` it arrived with,
// e.g. a settings destination bounced through sign-in). `.strict()` refused the body with
// 400 "Invalid input" before the token was even read, so an invited person
// could not verify at all. The same token verified with `{ token }` alone.
//
// Driven through the REAL route, the REAL token store (`createVerificationToken`
// / `consumeVerificationToken`), the REAL `postAuthLanding` and its REAL
// validator `safeNextPath`, against a real database. Only the request edges
// are stand-ins: `next/headers` (no request scope under vitest — the cookie
// jar is a Map, read back through the real `getCurrentUser`) and the limiter
// (its behaviour is pinned in ../../__tests__/token-rate-limits.test.ts).
//
// Sport: not applicable — this path is sport-agnostic auth.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));

const jar = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.values.set(name, value),
    delete: (name: string) => void jar.values.delete(name),
  }),
}));

// ONE stable router object: a fresh one per call would re-fire the page's
// effect (it lists `router` as a dependency) — see _hook-harness's notes.
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { sql } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { routes } from "@/lib/routes";
import { signupSchema } from "@/lib/types";
import { createVerificationToken } from "@/lib/verification";
import { VerifyEmail } from "@/components/verify-email";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://seazn.club";

/** The four real producers of a signup `next` — the pages that hand `AuthForm`
 *  one: join/[token]/page.tsx, claim/[token]/page.tsx, checkin/[token]/page.tsx,
 *  and login/page.tsx, which forwards whatever safe `?next=` it arrived with
 *  (the settings destination page-auth's org-less bounce carries is one). */
const INVITE_NEXT = "/join/inv0123456789";
const CLAIM_NEXT = routes.claim("clm0123456789");
const CHECKIN_NEXT = "/checkin/chk0123456789";
const LOGIN_CARRIED_NEXT = "/settings?tab=account&email_change=success";
const PRODUCER_NEXTS = [INVITE_NEXT, CLAIM_NEXT, CHECKIN_NEXT, LOGIN_CARRIED_NEXT];

/** The first-run wizard (app/onboarding/page.tsx). postAuthLanding's rule:
 *  without a safe `next` a user is guaranteed an org, and a NEW user
 *  (onboarding not completed) goes to the wizard. */
const FIRST_RUN_WIZARD = "/onboarding";

interface Envelope {
  ok: boolean;
  error?: string;
  data?: { redirect: string; has_org: boolean; org_id: string | null };
}

const made: string[] = [];

async function freshUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`verify-next-${randomUUID()}@example.test`}, 'Verify Next', false)
    returning id`;
  made.push(u.id);
  return u.id;
}

async function verify(body: unknown): Promise<{ status: number; body: Envelope }> {
  const res = await POST(
    new Request(`${ORIGIN}/api/auth/verify-email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function emailVerified(userId: string): Promise<boolean> {
  const [row] = await sql<{ v: boolean }[]>`select email_verified as v from users where id = ${userId}`;
  return row.v;
}

async function orgsOwned(userId: string): Promise<string[]> {
  const rows = await sql<{ org_id: string }[]>`select org_id from org_members where user_id = ${userId}`;
  return rows.map((r) => r.org_id);
}

async function expiredToken(userId: string): Promise<string> {
  const token = `expired-${randomUUID()}`;
  await sql`
    insert into email_verifications (user_id, token, expires_at)
    values (${userId}, ${token}, now() - interval '1 hour')`;
  return token;
}

beforeEach(() => {
  jar.values.clear();
  router.push.mockClear();
  router.refresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (!HAS_DB || made.length === 0) return;
  await sql`delete from organizations where created_by = any(${made})`;
  await sql`delete from subscriptions where owner_user_id = any(${made})`;
  await sql`delete from users where id = any(${made})`;
});

describe.skipIf(!HAS_DB)("POST /api/auth/verify-email — a link that carries next", () => {
  it("verifies a link from each of the four next producers and lands on it, without provisioning a default org", async () => {
    let checked = 0;
    for (const next of PRODUCER_NEXTS) {
      jar.values.clear();
      const userId = await freshUser();
      const token = await createVerificationToken(userId);

      const r = await verify({ token, next });

      expect(r.status, `${next}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.data, next).toEqual({ redirect: next, has_org: false, org_id: null });
      expect(await emailVerified(userId), next).toBe(true);
      expect((await getCurrentUser())?.id, `${next}: signed in`).toBe(userId);
      // postAuthLanding honours a safe next WITHOUT minting an org, so the
      // invited person lands on the invite rather than on a stranger's club.
      expect(await orgsOwned(userId), next).toEqual([]);
      checked++;
    }
    expect(checked).toBe(PRODUCER_NEXTS.length);
    expect(checked).toBe(4);
  });

  it("accepts the longest next the signup route will put in the link", async () => {
    // The producer's bound, read from its own schema — so tightening either
    // side's bound without the other reds here. signup/route.ts parses with
    // signupSchema and copies `next` into the emailed verify link.
    const bound = signupSchema.shape.next.unwrap().maxLength;
    expect(bound, "signupSchema declares a bound on next").toBeGreaterThan(1);
    const longest = "/" + "a".repeat(bound! - 1);
    const signup = { email: "longest@example.test", password: "hunter22" };
    expect(signupSchema.safeParse({ ...signup, next: longest }).success, "signup accepts it").toBe(true);
    expect(signupSchema.safeParse({ ...signup, next: `${longest}a` }).success, "the bound is real").toBe(false);

    const userId = await freshUser();
    const token = await createVerificationToken(userId);
    const r = await verify({ token, next: longest });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.redirect).toBe(longest);
  });

  it("an over-long next is refused 400 before the token is read — and the SAME token still verifies", async () => {
    // One past the producer's own bound: signup would never mint it, so the
    // route refuses it as malformed rather than guessing at it.
    const bound = signupSchema.shape.next.unwrap().maxLength!;
    const tooLong = "/" + "a".repeat(bound);
    expect(tooLong).toHaveLength(bound + 1);
    const userId = await freshUser();
    const token = await createVerificationToken(userId);

    const refused = await verify({ token, next: tooLong });

    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toBe("Invalid input");
    expect(await emailVerified(userId), "refused before the token was read").toBe(false);
    expect(await getCurrentUser(), "nobody signed in by a refused body").toBeNull();

    // The refusal consumed nothing: the link still works with a valid body.
    const retried = await verify({ token, next: INVITE_NEXT });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.data?.redirect).toBe(INVITE_NEXT);
    expect(await emailVerified(userId)).toBe(true);
  });

  it("a non-string next (null, a number, an array, an object) is refused 400 and leaves the token usable", async () => {
    const NOT_STRINGS: unknown[] = [null, 42, [INVITE_NEXT], { path: INVITE_NEXT }];
    const userId = await freshUser();
    const token = await createVerificationToken(userId);
    let checked = 0;
    for (const next of NOT_STRINGS) {
      const r = await verify({ token, next });
      expect(r.status, `${JSON.stringify(next)}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error, JSON.stringify(next)).toBe("Invalid input");
      checked++;
    }
    expect(checked).toBe(NOT_STRINGS.length);
    expect(checked).toBe(4);
    expect(await emailVerified(userId), "no refusal read the token").toBe(false);

    const r = await verify({ token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await emailVerified(userId)).toBe(true);
  });

  it("with no next — the empty case — lands a new user on the first-run wizard and provisions their org", async () => {
    const userId = await freshUser();
    const token = await createVerificationToken(userId);

    const r = await verify({ token });

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data?.redirect).toBe(FIRST_RUN_WIZARD);
    expect(r.body.data?.has_org).toBe(true);
    const owned = await orgsOwned(userId);
    expect(owned).toHaveLength(1);
    expect(r.body.data?.org_id).toBe(owned[0]);
    expect(await emailVerified(userId)).toBe(true);
    expect((await getCurrentUser())?.id).toBe(userId);
  });

  it("an unsafe next is ignored — 200 and the default landing, never 400 and never the attacker's URL", async () => {
    const UNSAFE = ["https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)"];
    let checked = 0;
    for (const evil of UNSAFE) {
      // The hazard, proven rather than asserted: each one leaves the origin
      // once a browser resolves it (`/\evil` becomes `https://evil/`, and a
      // `javascript:` URL has an opaque "null" origin).
      expect(new URL(evil, ORIGIN).origin, `${evil} escapes the origin`).not.toBe(ORIGIN);
      jar.values.clear();
      const userId = await freshUser();
      const token = await createVerificationToken(userId);

      const r = await verify({ token, next: evil });

      expect(r.status, `${evil}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.data?.redirect, evil).toBe(FIRST_RUN_WIZARD);
      expect(await emailVerified(userId), evil).toBe(true);
      expect((await getCurrentUser())?.id, `${evil}: signed in`).toBe(userId);
      checked++;
    }
    expect(checked).toBe(UNSAFE.length);
  });

  it("a USED token is refused exactly as before — with next or without — and signs nobody in", async () => {
    const userId = await freshUser();
    const token = await createVerificationToken(userId);
    expect((await verify({ token, next: INVITE_NEXT })).status, "first use").toBe(200);
    jar.values.clear();

    const without = await verify({ token });
    const withNext = await verify({ token, next: INVITE_NEXT });

    // Not a schema refusal — the token is read, and rejected, on its merits.
    // The status is deliberately not frozen here: today it is whatever an
    // unexpected Error maps to in lib/http.ts, and pinning that would only
    // block a later fix. What must hold is that `next` changes nothing.
    expect(without.body).toEqual({ ok: false, error: "This verification link is invalid or has expired" });
    expect(without.status).toBeGreaterThanOrEqual(400);
    expect(withNext).toEqual(without);
    expect(await getCurrentUser(), "nobody signed in by a used link").toBeNull();
  });

  it("an EXPIRED token is refused exactly as before — with next or without — and verifies nobody", async () => {
    const userId = await freshUser();

    const without = await verify({ token: await expiredToken(userId) });
    const withNext = await verify({ token: await expiredToken(userId), next: CLAIM_NEXT });

    expect(without.body).toEqual({ ok: false, error: "This verification link is invalid or has expired" });
    expect(without.status).toBeGreaterThanOrEqual(400);
    expect(withNext).toEqual(without);
    expect(await emailVerified(userId), "an expired link verifies nobody").toBe(false);
    expect(await getCurrentUser(), "an expired link signs nobody in").toBeNull();
  });
});

/** What the verify page POSTs, captured at `fetch` — under the REAL `api()`. */
function captureFetch(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return answer(url, init);
    }),
  );
  return calls;
}

describe("VerifyEmail (the page's client half) — sends the link's next with the token", () => {
  const canned = async () =>
    new Response(JSON.stringify({ ok: true, data: { redirect: "/canned" } }), {
      headers: { "content-type": "application/json" },
    });

  it("POSTs { token, next } when the link carries a next", async () => {
    const calls = captureFetch(canned);
    renderIsland(VerifyEmail, { token: "tok-0123456789", next: INVITE_NEXT });
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));

    expect(calls).toEqual([{ url: "/api/auth/verify-email", body: { token: "tok-0123456789", next: INVITE_NEXT } }]);
  });

  it("POSTs { token } alone — no next key — when the link carries none", async () => {
    const calls = captureFetch(canned);
    renderIsland(VerifyEmail, { token: "tok-0123456789", next: null });
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));

    expect(calls).toEqual([{ url: "/api/auth/verify-email", body: { token: "tok-0123456789" } }]);
  });
});

describe.skipIf(!HAS_DB)("the verify page's own request, through the real route", () => {
  it("an invite link opened in the browser verifies and routes to the invite", async () => {
    // The seam end to end: the body is whatever VerifyEmail builds, through the
    // real api() helper, answered by the real route — not a fixture on each end.
    const userId = await freshUser();
    const token = await createVerificationToken(userId);
    const calls = captureFetch((url, init) => POST(new Request(new URL(url, ORIGIN), init)));

    const page = renderIsland(VerifyEmail, { token, next: INVITE_NEXT });
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));

    expect(calls).toHaveLength(1);
    expect(router.push).toHaveBeenCalledWith(INVITE_NEXT);
    // The page's own success state (English: the harness has no DictProvider,
    // so useMsg reads the shipped en catalog), and not its failure state.
    await vi.waitFor(() => expect(page.text()).toContain(en["verifyEmail.verified"]));
    expect(page.text()).not.toContain(en["verifyEmail.failed"]);
    expect(await emailVerified(userId)).toBe(true);
    expect((await getCurrentUser())?.id).toBe(userId);
  });
});
