// POST /api/funnel/claim names its refusals with a machine `code` (start wizard T2 follow-up, owner-ordered), so the
// claim card can word them in the visitor's language instead of printing the route's English:
//   FUNNEL_CLAIM_INVALID    — the token names no live draft (never minted, already claimed, or not even token-shaped).
//                             A 400: nothing happened, nobody was signed in, not a server fault (it used to be a 500).
//   FUNNEL_CLAIM_SIGNED_IN  — the session cookie WAS set, then building the event (or making its org the active one)
//                             failed: the event may be partly built and the token is spent. The thrown status rides
//                             through (a 5xx still reaches Sentry); the inner message does not reach the body.
//   FUNNEL_CLAIM_PLAN_LIMIT — signed in, and the plan refused the competition itself (the quota, before its insert):
//                             a 402 carrying its feature_key, and NOTHING of the event written.
// Unnamed: a failure BEFORE the session (500, no code, no cookie, Sentry) and the limiter's 429 (the token unread).
//
// Driven through the REAL route over a real database, with a real draft from the real producer and the real
// `createSession` on a cookie jar; the plan refusals are the REAL gates, armed with a staff override on the org
// (org_entitlement_overrides). The stand-ins are the outside world (`next/headers`, the limiter, PostHog, the logger,
// Sentry) plus seams wrapped to fail on demand: `createFromDraft`, `createSession`, `setActiveOrgId`.
//
// Sport: not applicable to the refusal (the rig's one sport, Badminton). Real Postgres; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  failBuild: null as null | (() => Error),
  failSession: false,
  failActiveOrg: false,
  limited: false,
  builds: 0,
  captured: [] as unknown[],
  warned: [] as string[],
  errors: [] as { obj: unknown; msg: string }[],
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {
    if (!h.limited) return;
    const { HttpError } = await import("@/lib/errors");
    throw new HttpError(429, "Too many requests", undefined, undefined, { "Retry-After": "30" });
  }),
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
  log: {
    error: vi.fn((obj: unknown, msg: string) => void h.errors.push({ obj, msg })),
    warn: vi.fn((_o: unknown, m: string) => void h.warned.push(m)),
    info: vi.fn(),
    debug: vi.fn(),
  },
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
    createSession: async (...args: Parameters<typeof actual.createSession>) => {
      if (h.failSession) throw new Error("armed: the session could not be signed");
      return actual.createSession(...args);
    },
    setActiveOrgId: async (...args: Parameters<typeof actual.setActiveOrgId>) => {
      if (h.failActiveOrg) throw new Error("armed: the active org could not be set");
      return actual.setActiveOrgId(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { createFunnelDraft, type FunnelPayload } from "@/lib/funnel";
import { FUNNEL_CLAIM_INVALID, FUNNEL_CLAIM_PLAN_LIMIT, FUNNEL_CLAIM_SIGNED_IN } from "@/lib/funnel-claim-codes";
import { HttpError } from "@/lib/http";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const SESSION_COOKIE = "seazn_session";
const RUN = `fcr-${randomUUID().slice(0, 8)}`;
const addresses: string[] = [];

type Envelope = { ok: boolean; error?: string; code?: string; feature_key?: string; data?: { redirect?: string } };
async function post(body: string): Promise<{ status: number; body: Envelope }> {
  const res = await POST(
    new Request("https://claim.test/api/funnel/claim", { method: "POST", headers: { "content-type": "application/json" }, body }),
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}
const claim = (token: string) => post(JSON.stringify({ token }));
async function draft(over: Partial<FunnelPayload> = {}, email = newAddress()): Promise<{ token: string; email: string }> {
  const payload = { name: `${RUN} ${randomUUID().slice(0, 6)}`, sport: "Badminton", entrants: 4, ...over } as FunnelPayload;
  const { token } = await createFunnelDraft(email, payload);
  return { token, email };
}
function newAddress(): string {
  const email = `${RUN}-${randomUUID().slice(0, 6)}@example.com`;
  addresses.push(email);
  return email;
}
/** A returning organiser: the draft's address already has an account and an organisation, so the claim builds into it. */
async function returningOrganiser(): Promise<{ email: string; userId: string; orgId: string }> {
  const email = newAddress();
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${email}, 'Returning organiser', true) returning id`;
  const org = await createOrgForUser(u!.id, `${RUN} org`);
  return { email, userId: u!.id, orgId: org.id };
}
const override = (orgId: string, feature: string, v: { int?: number; bool?: boolean }) => sql`
  insert into org_entitlement_overrides (org_id, feature_key, int_value, bool_value, reason)
  values (${orgId}, ${feature}, ${v.int ?? null}, ${v.bool ?? null}, ${`${RUN} claim refusal`})`;
const competitionsOf = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from competitions where org_id = ${orgId}`)[0]!.n;
const usedAt = async (token: string) =>
  (await sql<{ used_at: Date | null }[]>`select used_at from funnel_drafts where token = ${token}`)[0]?.used_at ?? null;
/** The user the jar's session cookie was signed for, or null when none was set. */
function sessionUser(): string | null {
  const token = h.jar.get(SESSION_COOKIE);
  if (!token) return null;
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { uid: string }).uid;
}
const userOf = async (email: string) =>
  (await sql<{ id: string }[]>`select id from users where email = ${email} and deleted_at is null`)[0]?.id ?? null;

function reset(): void {
  h.jar.clear();
  h.failBuild = null;
  h.failSession = false;
  h.failActiveOrg = false;
  h.limited = false;
  h.builds = 0;
  h.captured.length = 0;
  h.warned.length = 0;
  h.errors.length = 0;
}
beforeEach(reset);
afterAll(async () => {
  if (!HAS_DB) return;
  const ids = (await sql<{ id: string }[]>`select id from users where email = any(${addresses}::text[])`).map((u) => u.id);
  await sql`delete from org_entitlement_overrides where reason = ${`${RUN} claim refusal`}`;
  await sql`delete from funnel_drafts where email = any(${addresses}::text[])`;
  // Courts first: their (venue, org) key does not cascade from the venue, so an org delete would trip on it.
  await sql`delete from courts where org_id in (select id from organizations where created_by = any(${ids}::uuid[]))`;
  await sql`delete from organizations where created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("the funnel claim's named refusals", () => {
  it("dead links — used, never minted, truncated, not even JSON: 400 FUNNEL_CLAIM_INVALID, nobody signed in, nothing built", async () => {
    const { token } = await draft();
    const first = await claim(token);
    expect(first.status, "premise: the first claim lands").toBe(200);
    expect(first.body.data?.redirect).toMatch(/^\/o\//);

    const cases = [
      { name: "the same link again", body: JSON.stringify({ token }) },
      { name: "a token no draft was minted for", body: JSON.stringify({ token: `never-${randomUUID()}` }) },
      { name: "a truncated link (shorter than any token)", body: JSON.stringify({ token: token.slice(0, 5) }) },
      { name: "a body that is not JSON", body: "token=" },
    ];
    let checked = 0;
    for (const c of cases) {
      reset();
      const got = await post(c.body);
      expect(got.status, c.name).toBe(400);
      expect(got.body, c.name).toMatchObject({ ok: false, code: FUNNEL_CLAIM_INVALID });
      expect(sessionUser(), `${c.name}: nobody is signed in`).toBeNull();
      expect(h.builds, `${c.name}: nothing is built`).toBe(0);
      expect(h.captured, `${c.name}: an expected refusal is not a server fault`).toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every dead link").toBe(cases.length);
  });

  it("the limiter refuses: a 429 with no code, nobody signed in, and the link is still unused — it lands once let through", async () => {
    const { token } = await draft();
    h.limited = true;
    const got = await claim(token);
    expect(got.status).toBe(429);
    expect(got.body.code, "not one of the claim's own refusals").toBeUndefined();
    expect(sessionUser()).toBeNull();
    expect(h.builds).toBe(0);
    expect(await usedAt(token), "the token was never read").toBeNull();
    h.limited = false;
    expect((await claim(token)).status, "the same link works a moment later").toBe(200);
  });

  it("the session cannot be signed: a 500 with no code (signed out), no cookie, nothing built, Sentry", async () => {
    h.failSession = true;
    const { token } = await draft();
    const got = await claim(token);
    expect(got.status).toBe(500);
    expect(got.body.code, "never the signed-in refusal: nobody is signed in").toBeUndefined();
    expect(sessionUser()).toBeNull();
    expect(h.builds).toBe(0);
    expect(h.captured.length, "a server fault").toBeGreaterThan(0);
  });

  it("the build fails after the session is set: FUNNEL_CLAIM_SIGNED_IN, the cookie stands, the token is spent", async () => {
    const cases = [
      { name: "an unexpected throw", fail: () => new Error("armed: insert into divisions failed"), status: 500, sentry: true },
      { name: "a 5xx HttpError", fail: () => new HttpError(503, "armed: placement down", "PLACEMENT_DOWN"), status: 503, sentry: true },
      { name: "a 4xx refusal inside the build", fail: () => new HttpError(409, "armed: name taken", "NAME_TAKEN"), status: 409, sentry: false },
    ];
    let checked = 0;
    for (const c of cases) {
      reset();
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

  it("the plan refuses the competition itself: 402 FUNNEL_CLAIM_PLAN_LIMIT with its feature_key, signed in, NOTHING written", async () => {
    // The real quota (createCompetition's own check, before its insert), on a returning organiser held to none.
    const o = await returningOrganiser();
    await override(o.orgId, "competitions.max_active", { int: 0 });
    const { token } = await draft({ format: "league", courts: 2 }, o.email);
    const got = await claim(token);
    expect(got.status).toBe(402);
    expect(got.body).toMatchObject({ ok: false, code: FUNNEL_CLAIM_PLAN_LIMIT, feature_key: "competitions.max_active" });
    expect(sessionUser(), "signed in as the returning organiser").toBe(o.userId);
    expect(await competitionsOf(o.orgId), "nothing of the event was written").toBe(0);
    expect(h.errors.filter((e) => e.msg === "funnel_claim_build_partial"), "nothing part-built to report").toEqual([]);
    expect(h.captured, "a plan refusal is not a server fault").toEqual([]);
    expect(h.warned).toContain("funnel_claim_signed_in_refused");
  });

  it("the plan refuses a stage after the competition exists: 402 FUNNEL_CLAIM_SIGNED_IN (part-built) with its feature_key", async () => {
    // The real stage gate (createStages' requireFeature), refused after the competition and its division were written.
    const o = await returningOrganiser();
    await override(o.orgId, "formats.double_elim", { bool: false });
    const { token } = await draft({ format: "double_elim", entrants: 8 }, o.email);
    const got = await claim(token);
    expect(got.status).toBe(402);
    expect(got.body).toMatchObject({ ok: false, code: FUNNEL_CLAIM_SIGNED_IN, feature_key: "formats.double_elim" });
    expect(sessionUser()).toBe(o.userId);
    expect(await competitionsOf(o.orgId), "the competition was written before the refusal").toBe(1);
    const partial = h.errors.filter((e) => e.msg === "funnel_claim_build_partial");
    expect(partial.map((e) => e.obj), "logged by its step, with the refusal's status").toEqual([
      expect.objectContaining({ step: "stages", status: 402 }),
    ]);
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
