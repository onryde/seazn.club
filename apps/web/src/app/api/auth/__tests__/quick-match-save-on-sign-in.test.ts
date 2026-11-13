// Quick match plan 3, Task 4 (spec §7.7 as amended 2026-11-08; pre-flight D3, B19): signing in keeps the quick matches a
// guest typed the account's address on, at EVERY door a person's session starts, and never at staff impersonation.
//
// Each door is driven as a person reaches it, through its REAL route over a real database, with the real credential its
// own producer mints (a verification token, a sign-in link, Google's userinfo, a funnel draft, an email invite, a player
// claim's emailed secret), the real `createSession` on a cookie jar, and a quick match made by the real create with the
// address typed on it. The stand-ins are the outside world only: `next/headers` (a Map-backed jar, so the session the
// route SETS is read back), the rate limiter, Google's two endpoints, PostHog and the logger. One seam is wrapped to fail
// on demand (`cancelQueuedEmails`, inside the save's transaction): a failing save must never block a sign-in.
//
// The source scan (server/usecases/__tests__/quick-match-save-doors.test.ts) proves every door CALLS the save; this file
// proves each call SAVES, for the person who signed in. "Unverified" is reachable at one door only: a returning Google
// account found by its google_sub, which the callback signs in without touching `email_verified`. Every other door marks
// the address verified before the session, asserted below as a premise of each case.
//
// Sport: not applicable to sign-in; the quick match is the rig's one sport (its header says why).
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex")); // every quick match create seals a home token

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: vi.fn(async () => {}),
}));
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  logError: vi.fn(),
  failCancel: false,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.94" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (name: string) => void h.jar.delete(name),
  }),
}));
vi.mock("@/server/logger", () => ({
  log: { error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(async () => {}),
}));
vi.mock("@/server/email-outbox/cancel", async (orig) => {
  const actual = await orig<typeof import("@/server/email-outbox/cancel")>();
  return {
    ...actual,
    cancelQueuedEmails: async (...args: Parameters<typeof actual.cancelQueuedEmails>) => {
      if (h.failCancel) throw new Error("armed: the save's cancel failed");
      return actual.cancelQueuedEmails(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { createImpersonationToken } from "@/lib/admin";
import { createFunnelDraft } from "@/lib/funnel";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createInvite } from "@/server/usecases/invites";
import { createClaimInvite } from "@/server/usecases/person-claims";
import { createPerson } from "@/server/usecases/persons";
import {
  addressFor,
  createTypedMatch,
  deleteMadeMatches,
  saveStateOf,
} from "@/server/usecases/__tests__/_quick-match-save-rig";
import ImpersonatePage from "@/app/admin/impersonate/page";
import { POST as CLAIM_ACCEPT } from "@/app/api/claims/[token]/accept/route";
import { POST as FUNNEL_CLAIM } from "@/app/api/funnel/claim/route";
import { POST as INVITE_CLAIM } from "@/app/api/invites/[token]/claim/route";
import { GET as GOOGLE_CALLBACK } from "../google/callback/route";
import { POST as CONSUME } from "../magic-link/consume/route";
import { POST as VERIFY_EMAIL } from "../verify-email/route";
import { callbackRequest, claimsFor, locationOf, plantState, stubGoogle } from "../google/__tests__/_google-callback";
import { warmDefaultLanding } from "./_verify-link";

const HAS_DB = !!process.env.DATABASE_URL;
const SESSION_COOKIE = "seazn_session";

const users: string[] = [];
const orgs: string[] = [];
const addresses: string[] = [];

const address = (tag: string): string => {
  const a = addressFor(tag);
  addresses.push(a);
  return a;
};

async function insertUser(email: string, o: { verified: boolean; googleSub?: string }): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, google_sub)
    values (${email}, 'QM door', ${o.verified}, ${o.googleSub ?? null}) returning id`;
  users.push(id);
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = await insertUser(address("owner"), { verified: true });
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${`QM door ${suffix}`}, ${`qm-door-${suffix}`}, ${ownerId}) returning id`;
  orgs.push(orgId);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { orgId, ownerId };
}

/** The user the session cookie in the jar was signed for, or null when none was set. */
function sessionUser(): string | null {
  const token = h.jar.get(SESSION_COOKIE);
  if (!token) return null;
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { uid: string }).uid;
}

const accountOf = async (email: string) =>
  (
    await sql<{ id: string; email_verified: boolean }[]>`
    select id, email_verified from users where email = ${email} and deleted_at is null`
  )[0] ?? null;

type Envelope = { ok: boolean; error?: string; data?: Record<string, unknown> };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://signin.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
/** A JSON door's answer: success and the landing it hands the browser. */
async function answered(res: Response, landingKey: string): Promise<{ ok: boolean; landed: unknown }> {
  const body = (await res.json()) as Envelope;
  return {
    ok: res.status === 200 && body.ok === true,
    landed: body.data?.[landingKey],
  };
}

interface Door {
  name: string;
  /** Drive the door for `email` as a person does, from a fresh device (an empty jar). */
  signIn: (email: string) => Promise<{ ok: boolean; landed: unknown }>;
}

const DOORS: Door[] = [
  {
    name: "email verification (verify-email)",
    signIn: async (email) => {
      const userId = await insertUser(email, { verified: false });
      const token = await createVerificationToken(userId);
      return answered(await VERIFY_EMAIL(post("/api/auth/verify-email", { token })), "redirect");
    },
  },
  {
    name: "magic link (consume)",
    signIn: async (email) => {
      const userId = await insertUser(email, { verified: false }); // what a sign-in request leaves behind
      const token = await createLoginLink(userId);
      return answered(await CONSUME(post("/api/auth/magic-link/consume", { token })), "redirect");
    },
  },
  {
    name: "Google, a new account",
    signIn: async (email) => {
      plantState(h.jar);
      stubGoogle(claimsFor(`g-sub-${randomUUID()}`, email));
      const res = await GOOGLE_CALLBACK(callbackRequest());
      return {
        ok: res.status === 307 && locationOf(res).pathname !== "/login",
        landed: res.headers.get("location"),
      };
    },
  },
  {
    name: "Google, a returning account found by its google_sub",
    signIn: async (email) => {
      const sub = `g-sub-${randomUUID()}`;
      await insertUser(email, { verified: true, googleSub: sub });
      plantState(h.jar);
      stubGoogle(claimsFor(sub, email));
      const res = await GOOGLE_CALLBACK(callbackRequest());
      return {
        ok: res.status === 307 && locationOf(res).pathname !== "/login",
        landed: res.headers.get("location"),
      };
    },
  },
  {
    name: "the funnel claim",
    signIn: async (email) => {
      const { token } = await createFunnelDraft(email, {
        name: `QM funnel ${randomUUID().slice(0, 6)}`,
        sport: "Badminton",
        entrants: 4,
      });
      return answered(await FUNNEL_CLAIM(post("/api/funnel/claim", { token })), "redirect");
    },
  },
  {
    name: "the email invite claim",
    signIn: async (email) => {
      const { orgId, ownerId } = await seedOrg();
      const invite = await createInvite(orgId, ownerId, {
        role: "admin",
        max_uses: 1,
        email,
      });
      const res = await INVITE_CLAIM(post(`/api/invites/${invite.token}/claim`, {}), {
        params: Promise.resolve({ token: invite.token }),
      });
      return answered(res, "landing");
    },
  },
  {
    name: "the player claim accept, signed out with the emailed secret",
    signIn: async (email) => {
      const { orgId, ownerId } = await seedOrg();
      const owner: AuthCtx = {
        orgId,
        via: "session",
        userId: ownerId,
        role: "owner",
        keyId: null,
      };
      const person = await createPerson(owner, {
        full_name: "Door Player",
        consent: {},
      } as never);
      const invite = await createClaimInvite(owner, person.id, email);
      const res = await CLAIM_ACCEPT(
        post(`/api/claims/${invite.emailSecret}/accept`, {}, { "sec-fetch-site": "same-origin" }),
        {
          params: Promise.resolve({ token: invite.emailSecret }),
        },
      );
      return answered(res, "redirect");
    },
  },
];

beforeAll(async () => {
  process.env.AUTH_SECRET ??= "auth-secret-for-quick-match-save-door-test-0123456789-0123456789";
  if (HAS_DB) await warmDefaultLanding();
});
beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.test");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  h.jar.clear();
  h.logError.mockClear();
  h.failCancel = false;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (!HAS_DB) return;
  await deleteMadeMatches();
  const doorUsers = await sql<{ id: string }[]>`select id from users where email = any(${addresses}::text[])`;
  const ids = [...new Set([...users, ...doorUsers.map((u) => u.id)])];
  await sql`delete from impersonation_sessions where actor_id = any(${ids}::uuid[]) or target_id = any(${ids}::uuid[])`;
  await sql`delete from staff_audit_log where actor_id = any(${ids}::uuid[])`;
  await sql`delete from funnel_drafts where email = any(${addresses}::text[])`;
  await sql`delete from organizations where id = any(${orgs}::uuid[]) or created_by = any(${ids}::uuid[])`;
  await sql`delete from subscriptions where owner_user_id = any(${ids}::uuid[])`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("every door that starts a person's session saves", () => {
  it("the door table is the cases: seven ways in, the six doors and Google's two branches (anti-vacuity)", () => {
    expect(DOORS).toHaveLength(7);
  });

  describe.each(DOORS)("$name", (door) => {
    it("signs the person in, lands them, and saves the match typed with their address; another address's match is left alone", async () => {
      const email = address("door");
      const mine = await createTypedMatch(email);
      const notMine = await createTypedMatch(address("not-mine"));

      const r = await door.signIn(email);

      expect(r.ok, "the door answered its success").toBe(true);
      expect(r.landed, "and handed the browser a landing").toMatch(/^\//);
      const account = await accountOf(email);
      expect(sessionUser(), "signed in as the account holding this address").toBe(account?.id);
      expect(account?.email_verified, "premise: the door verified the address before the session").toBe(true);
      const saved = await saveStateOf(mine.id);
      expect(
        [saved.saved_by_user_id, saved.expires_at],
        "saved for the person who signed in, no longer expiring",
      ).toEqual([account!.id, null]);
      expect((await saveStateOf(notMine.id)).saved_by_user_id).toBeNull();
      expect(h.logError).not.toHaveBeenCalled();
    });

    it("a save that fails never blocks the sign-in: logged, the person still lands, the match stays unsaved", async () => {
      const email = address("fails");
      const mine = await createTypedMatch(email);
      h.failCancel = true;

      const r = await door.signIn(email);

      expect(r.ok).toBe(true);
      expect(r.landed).toMatch(/^\//);
      expect(sessionUser()).toBe((await accountOf(email))?.id);
      expect(h.logError, "the failure is logged once").toHaveBeenCalledTimes(1);
      expect((await saveStateOf(mine.id)).saved_by_user_id, "nothing half-saved").toBeNull();
    });
  });
});

describe.skipIf(!HAS_DB)("the doors that must not save", () => {
  it("B19: a returning Google account whose address is NOT verified signs in and saves nothing", async () => {
    const email = address("google-unverified");
    const sub = `g-sub-${randomUUID()}`;
    const userId = await insertUser(email, { verified: false, googleSub: sub });
    const typed = await createTypedMatch(email);
    plantState(h.jar);
    stubGoogle(claimsFor(sub, email));

    const res = await GOOGLE_CALLBACK(callbackRequest());

    expect(res.status).toBe(307);
    expect(locationOf(res).pathname).not.toBe("/login");
    expect(sessionUser(), "premise: the by-sub branch signs an unverified account in").toBe(userId);
    expect((await accountOf(email))?.email_verified, "premise: and leaves it unverified").toBe(false);
    expect((await saveStateOf(typed.id)).saved_by_user_id).toBeNull();
    // Its positive pair is the door table's "a returning account found by its google_sub", which differs only in
    // `email_verified` and saves.
  });

  it("staff impersonation signs the target in and saves nothing; the target's own sign-in later saves it", async () => {
    const email = address("impersonated");
    const typed = await createTypedMatch(email);
    const target = await insertUser(email, { verified: true });
    const staff = await insertUser(address("staff"), { verified: true });
    const token = await createImpersonationToken(staff, target);

    const thrown = await ImpersonatePage({
      searchParams: Promise.resolve({ token }),
    }).then(
      () => null,
      (e: unknown) => e as { digest?: string },
    );

    expect(String(thrown?.digest), "the page redirected into the dashboard").toContain("/dashboard");
    expect(sessionUser(), "premise: the page signed the target in").toBe(target);
    expect((await saveStateOf(typed.id)).saved_by_user_id, "impersonation never saves").toBeNull();

    // The positive pair, in sequence: the person signs in themselves, and the match is theirs.
    h.jar.clear();
    const link = await createLoginLink(target);
    expect((await answered(await CONSUME(post("/api/auth/magic-link/consume", { token: link })), "redirect")).ok).toBe(
      true,
    );
    expect((await saveStateOf(typed.id)).saved_by_user_id).toBe(target);
  });
});
