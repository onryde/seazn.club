// POST /api/funnel/claim names its two refusals with a machine `code` (start wizard T2 follow-up, owner-ordered), so the
// claim card can word them in the visitor's language instead of printing the route's English:
//   FUNNEL_CLAIM_INVALID   — the token names no live draft (never minted, or already claimed). A 400: nothing happened,
//                            nobody was signed in, and it is not a server fault (it used to be a 500 to Sentry).
//   FUNNEL_CLAIM_SIGNED_IN — the session cookie WAS set, then building the event (or making its org the active one)
//                            failed: the event may be partly built and the token is spent. The thrown status rides
//                            through (a 5xx still reaches Sentry); the inner message does not reach the body.
//
// Driven through the REAL route over a real database, with a real draft from the real producer and the real
// `createSession` on a cookie jar. The stand-ins are the outside world (`next/headers`, the limiter, PostHog, the logger,
// Sentry) plus two wrapped seams armed to fail on demand: `createFromDraft` and `setActiveOrgId`.
//
// Sport: not applicable to the refusal (the rig's one sport, Badminton). Real Postgres; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  failBuild: null as null | (() => Error),
  failActiveOrg: false,
  builds: 0,
  captured: [] as unknown[],
  warned: [] as string[],
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.95" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/server/logger", () => ({
  log: { error: vi.fn(), warn: vi.fn((_o: unknown, m: string) => void h.warned.push(m)), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn((err: unknown) => void h.captured.push(err)),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
vi.mock("@/lib/funnel", async (orig) => {
  const actual = await orig<typeof import("@/lib/funnel")>();
  return {
    ...actual,
    createFromDraft: async (...args: Parameters<typeof actual.createFromDraft>) => {
      h.builds++;
      if (h.failBuild) throw h.failBuild();
      return actual.createFromDraft(...args);
    },
  };
});
vi.mock("@/lib/auth", async (orig) => {
  const actual = await orig<typeof import("@/lib/auth")>();
  return {
    ...actual,
    setActiveOrgId: async (...args: Parameters<typeof actual.setActiveOrgId>) => {
      if (h.failActiveOrg) throw new Error("armed: the active org could not be set");
      return actual.setActiveOrgId(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { createFunnelDraft } from "@/lib/funnel";
import { FUNNEL_CLAIM_INVALID, FUNNEL_CLAIM_SIGNED_IN } from "@/lib/funnel-claim-codes";
import { HttpError } from "@/lib/http";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const SESSION_COOKIE = "seazn_session";
const RUN = `fcr-${randomUUID().slice(0, 8)}`;
const addresses: string[] = [];

type Envelope = { ok: boolean; error?: string; code?: string; data?: { redirect?: string } };
async function claim(token: string): Promise<{ status: number; body: Envelope }> {
  const res = await POST(
    new Request("https://claim.test/api/funnel/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}
async function draft(): Promise<{ token: string; email: string }> {
  const email = `${RUN}-${randomUUID().slice(0, 6)}@example.com`;
  addresses.push(email);
  const { token } = await createFunnelDraft(email, { name: `${RUN} ${randomUUID().slice(0, 6)}`, sport: "Badminton", entrants: 4 });
  return { token, email };
}
/** The user the jar's session cookie was signed for, or null when none was set. */
function sessionUser(): string | null {
  const token = h.jar.get(SESSION_COOKIE);
  if (!token) return null;
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { uid: string }).uid;
}
const userOf = async (email: string) =>
  (await sql<{ id: string }[]>`select id from users where email = ${email} and deleted_at is null`)[0]?.id ?? null;

beforeEach(() => {
  h.jar.clear();
  h.failBuild = null;
  h.failActiveOrg = false;
  h.builds = 0;
  h.captured.length = 0;
  h.warned.length = 0;
});
afterAll(async () => {
  if (!HAS_DB) return;
  const ids = (await sql<{ id: string }[]>`select id from users where email = any(${addresses}::text[])`).map((u) => u.id);
  await sql`delete from funnel_drafts where email = any(${addresses}::text[])`;
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the funnel claim's named refusals", () => {
  it("a used link and a never-minted one: 400 FUNNEL_CLAIM_INVALID, nobody signed in, nothing built, no Sentry", async () => {
    const { token } = await draft();
    const first = await claim(token);
    expect(first.status, "premise: the first claim lands").toBe(200);
    expect(first.body.data?.redirect).toMatch(/^\/o\//);

    const cases = [
      { name: "the same link again", token },
      { name: "a token no draft was minted for", token: `never-${randomUUID()}` },
    ];
    let checked = 0;
    for (const c of cases) {
      h.jar.clear();
      h.builds = 0;
      h.captured.length = 0;
      const got = await claim(c.token);
      expect(got.status, c.name).toBe(400);
      expect(got.body, c.name).toMatchObject({ ok: false, code: FUNNEL_CLAIM_INVALID });
      expect(sessionUser(), `${c.name}: nobody is signed in`).toBeNull();
      expect(h.builds, `${c.name}: nothing is built`).toBe(0);
      expect(h.captured, `${c.name}: an expected refusal is not a server fault`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: both dead links").toBe(cases.length);
  });

  it("the build fails after the session is set: FUNNEL_CLAIM_SIGNED_IN, the cookie stands, the token is spent", async () => {
    const cases = [
      { name: "an unexpected throw", fail: () => new Error("armed: insert into divisions failed"), status: 500, sentry: true },
      { name: "a 5xx HttpError", fail: () => new HttpError(503, "armed: placement down", "PLACEMENT_DOWN"), status: 503, sentry: true },
      { name: "a 4xx refusal inside the build", fail: () => new HttpError(409, "armed: name taken", "NAME_TAKEN"), status: 409, sentry: false },
    ];
    let checked = 0;
    for (const c of cases) {
      h.jar.clear();
      h.captured.length = 0;
      h.warned.length = 0;
      h.failBuild = c.fail;
      const { token, email } = await draft();
      const got = await claim(token);
      expect(got.status, `${c.name}: the thrown status rides through`).toBe(c.status);
      expect(got.body, c.name).toMatchObject({ ok: false, code: FUNNEL_CLAIM_SIGNED_IN });
      expect(got.body.error ?? "", `${c.name}: the inner message stays in the logs`).not.toContain("armed");
      const uid = await userOf(email);
      expect(uid, `${c.name}: the account exists`).not.toBeNull();
      expect(sessionUser(), `${c.name}: the visitor IS signed in, as the draft's address`).toBe(uid);
      expect(h.captured.length > 0, `${c.name}: Sentry`).toBe(c.sentry);
      // A 4xx skips Sentry and the handler's log, so the route logs it: the reason is never lost.
      expect(h.warned.includes("funnel_claim_signed_in_refused"), `${c.name}: logged when Sentry is not`).toBe(!c.sentry);
      // The token is spent: the same link is now the dead-link refusal, never a second build.
      h.failBuild = null;
      h.jar.clear();
      expect((await claim(token)).body.code, `${c.name}: spent`).toBe(FUNNEL_CLAIM_INVALID);
      checked++;
    }
    expect(checked, "anti-vacuity: every failure shape").toBe(cases.length);
  });

  it("making the new org the active one fails: FUNNEL_CLAIM_SIGNED_IN as well", async () => {
    h.failActiveOrg = true;
    const { token, email } = await draft();
    const got = await claim(token);
    expect(got.status).toBe(500);
    expect(got.body).toMatchObject({ ok: false, code: FUNNEL_CLAIM_SIGNED_IN });
    expect(sessionUser()).toBe(await userOf(email));
  });
});
