// RS003 W2 — the public group-submit HTTP boundary over RS002's
// submitRegistrationGroup. The usecase owns the transaction, capacity,
// eligibility and minting; this file proves the ROUTE's own job only: the
// two rate-limit buckets (exact key/config, in order relative to the
// honeypot), the honeypot short-circuit itself, cookie-derived locale
// resolution, optional session-user threading, and the checkout_url:null
// response mapping (SubmitGroupResult carries no such field — the route adds
// it). `rateLimit` is mocked outright (real behaviour needs Redis and fails
// OPEN without it, which would make a "prove the limiter is wired" test pass
// whether or not it's actually called — see RS003 W2 dispatch). The usecase
// is mocked as a spy WRAPPING the real implementation, so wiring assertions
// and DB-backed persistence share one file without diverging behaviour.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

// RS003 W3a — the route now mints a real checkout for a payable cart, so
// this file needs the same Stripe mock shape registrations.test.ts uses
// (checkout.sessions.create only; nothing else is reachable from here).
const stripeMock = vi.hoisted(() => ({ checkoutCreate: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeMock.checkoutCreate } } }),
}));

vi.mock("@/server/usecases/registration-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registration-submit")>();
  return { ...actual, submitRegistrationGroup: vi.fn(actual.submitRegistrationGroup) };
});

const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: async () => (authState.userId ? { id: authState.userId } : null) };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  submitRegistrationGroup,
  type SubmitGroupResult,
} from "@/server/usecases/registration-submit";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { POST as registerRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const rl = vi.mocked(rateLimit);
const submitSpy = vi.mocked(submitRegistrationGroup);

// ---------------------------------------------------------------------------
// Request / response helpers (merge-route.test.ts's shape).
// ---------------------------------------------------------------------------

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; [k: string]: unknown };
}

function req(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function read(res: Response): Promise<{ status: number; body: Envelope }> {
  return { status: res.status, body: (await res.json()) as Envelope };
}

const ctx = (orgSlug: string, slug: string) => ({ params: Promise.resolve({ orgSlug, slug }) });
const URL_ = (orgSlug: string, slug: string) => `/public/orgs/${orgSlug}/competitions/${slug}/register`;

function groupBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contact: { name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
    privacy_consent: true,
    entries: [
      {
        division_id: randomUUID(),
        entrant_kind: "individual",
        players: [{ full_name: "Solo Player" }],
        answers: {},
      },
    ],
    ...over,
  };
}

function fakeResult(): SubmitGroupResult {
  return {
    group_id: randomUUID(),
    ref_code: "SZ-1234-5678",
    access_token: "regtok_" + randomUUID(),
    currency: "usd",
    amount_cents: 0,
    entries: [
      {
        registration_id: randomUUID(),
        division_id: randomUUID(),
        status: "confirmed",
        amount_cents: 0,
        join_code: null,
        free_agent: false,
      },
    ],
  };
}

beforeEach(() => {
  rl.mockClear();
  submitSpy.mockClear();
  authState.userId = null;
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------
// Routing / wiring — usecase mocked, no DB required.
// ---------------------------------------------------------------------------

describe("POST .../register — routing", () => {
  it("honeypot: a filled website 400s \"Registration failed\", never calls the usecase, and bucket 2 never fires", async () => {
    const res = await registerRoute(
      req(URL_("acme", "cup"), groupBody({ website: "http://spam.example" }), {
        "x-forwarded-for": "9.9.9.1",
      }),
      ctx("acme", "cup"),
    );
    const { status, body } = await read(res);
    expect(status).toBe(400);
    expect(body.error?.message).toBe("Registration failed");
    expect(submitSpy).not.toHaveBeenCalled();
    // Bucket 1 (general per-IP) was already spent before the honeypot check;
    // bucket 2 (competition-scoped) must NOT fire once it trips.
    expect(rl.mock.calls).toEqual([["regsubmit:9.9.9.1", { max: 10, windowSeconds: 60 }]]);
  });

  it("a clean submit fires both buckets with the documented key/config, in order", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult());
    const res = await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.2" }),
      ctx("acme", "cup"),
    );
    expect((await read(res)).status).toBe(201);
    expect(rl.mock.calls).toEqual([
      ["regsubmit:9.9.9.2", { max: 10, windowSeconds: 60 }],
      ["regsubmit:9.9.9.2:acme:cup", { max: 5, windowSeconds: 300 }],
    ]);
  });

  // Competition slugs are unique per (org_id, slug) — `competitions_org_id_slug_key`
  // — never globally, so a bucket keyed on the slug alone silently joins two
  // tenants: the same IP registering at two orgs that both run a "cup" would
  // spend one budget across both. The deleted single-entry route keyed on
  // `division_id` (a globally unique uuid) and could not express this bug.
  it("scopes the narrow bucket per ORG, so two orgs sharing a slug do not share a budget", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult()).mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.7" }),
      ctx("acme", "cup"),
    );
    await registerRoute(
      req(URL_("rivals", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.7" }),
      ctx("rivals", "cup"),
    );
    const narrow = rl.mock.calls.map(([k]) => k).filter((k: string) => k.split(":").length > 2);
    expect(narrow).toEqual(["regsubmit:9.9.9.7:acme:cup", "regsubmit:9.9.9.7:rivals:cup"]);
    expect(new Set(narrow).size).toBe(2);
  });

  it("surfaces a rate-limit rejection instead of swallowing it", async () => {
    rl.mockImplementationOnce(async () => {
      throw new HttpError(429, "slow down");
    });
    const res = await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.3" }),
      ctx("acme", "cup"),
    );
    const { status } = await read(res);
    expect(status).toBe(429);
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("a seazn_locale=fr cookie reaches the usecase as locale:'fr'", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.4", cookie: "seazn_locale=fr" }),
      ctx("acme", "cup"),
    );
    expect(submitSpy.mock.calls[0]![1].locale).toBe("fr");
  });

  it("an absent cookie reaches the usecase as locale:null", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.5" }),
      ctx("acme", "cup"),
    );
    expect(submitSpy.mock.calls[0]![1].locale).toBeNull();
  });

  it("an invalid locale cookie value reaches the usecase as locale:null", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.6", cookie: "seazn_locale=xx" }),
      ctx("acme", "cup"),
    );
    expect(submitSpy.mock.calls[0]![1].locale).toBeNull();
  });

  it("returns the usecase result with checkout_url:null at 201", async () => {
    const fake = fakeResult();
    submitSpy.mockResolvedValueOnce(fake);
    const res = await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.7" }),
      ctx("acme", "cup"),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data).toEqual({ ...fake, checkout_url: null });
  });

  it("a signed-in registrant's session id reaches the usecase as sessionUserId", async () => {
    authState.userId = "11111111-1111-1111-1111-111111111111";
    submitSpy.mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.8" }),
      ctx("acme", "cup"),
    );
    expect(submitSpy.mock.calls[0]![0]).toMatchObject({
      orgSlug: "acme",
      compSlug: "cup",
      sessionUserId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("signed-out reaches the usecase as sessionUserId:null", async () => {
    submitSpy.mockResolvedValueOnce(fakeResult());
    await registerRoute(
      req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.9.9" }),
      ctx("acme", "cup"),
    );
    expect(submitSpy.mock.calls[0]![0]).toMatchObject({ sessionUserId: null });
  });
});

// ---------------------------------------------------------------------------
// DB-backed — real Postgres, real usecase (the spy's default wraps it).
// Fixture shape copied from registration-submit.test.ts's own
// seedOrg/rig/seedSettings (this repo has no shared fixtures module).
// ---------------------------------------------------------------------------

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; orgSlug: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "rt-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Route Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const { setOrgPlan } = await import("@/lib/__tests__/_billing-group");
  await setOrgPlan(orgId, "pro");
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(
  owner: AuthCtx,
): Promise<{ competition: { id: string; slug: string }; division: { id: string; slug: string } }> {
  const competition = await createCompetition(owner, {
    name: "Route Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return { competition, division };
}

async function seedSettings(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents)
    values (${divisionId}, true, 'individual', 0, null, 'offline', 'auto', false)
    on conflict (division_id) do update set
      enabled = excluded.enabled, entrant_kind = excluded.entrant_kind, fee_cents = excluded.fee_cents`;
}

describe.skipIf(!HAS_DB)("POST .../register — DB-backed", () => {
  it("a real individual entry persists end-to-end through the route", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id);

    const res = await registerRoute(
      req(
        URL_(orgSlug, competition.slug),
        groupBody({
          entries: [
            {
              division_id: division.id,
              entrant_kind: "individual",
              players: [{ full_name: "Real Player" }],
              answers: {},
            },
          ],
        }),
        { "x-forwarded-for": "9.9.9.20" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBeNull();
    const entries = body.data!.entries as { registration_id: string; status: string }[];
    expect(entries).toHaveLength(1);

    const [row] = await sql<{ status: string; group_id: string }[]>`
      select status, group_id from registrations where id = ${entries[0]!.registration_id}`;
    expect(row!.status).toBe("confirmed");
    expect(row!.group_id).toBe(body.data!.group_id);
  });

  // RS003 W3a: the route now wires mintGroupCheckout's result through for a
  // payable cart, instead of hardcoding null.
  it("a paid entry mints a real checkout session and returns its url", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, 'stripe', 'auto', false)`;

    const res = await registerRoute(
      req(
        URL_(orgSlug, competition.slug),
        groupBody({
          entries: [
            {
              division_id: division.id,
              entrant_kind: "individual",
              players: [{ full_name: "Payer" }],
              answers: {},
            },
          ],
        }),
        { "x-forwarded-for": "9.9.9.21" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBe("https://checkout.stripe.test/session");
    expect(stripeMock.checkoutCreate).toHaveBeenCalledTimes(1);
  });

  // submitRegistrationGroup COMMITS before the route mints. If a mint failure
  // propagated, the response would be an error for a registration that exists:
  // the entries keep their capacity/waitlist slots and the registrant never
  // receives the ref_code or access_token, which are the only routes back to
  // the status page to pay. Their retry then duplicates the whole cart.
  // Every mint failure is recoverable later (organiser finishes Connect, fixes
  // a stale currency snapshot; resume-checkout re-mints), so the cart must
  // survive with no payment link rather than be reported as failed.
  it("a Stripe failure after submit still returns 201 and PERSISTS the cart, with no payment link", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, 'stripe', 'auto', false)`;
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe is down"));

    const res = await registerRoute(
      req(
        URL_(orgSlug, competition.slug),
        groupBody({
          entries: [
            {
              division_id: division.id,
              entrant_kind: "individual",
              players: [{ full_name: "Payer" }],
              answers: {},
            },
          ],
        }),
        { "x-forwarded-for": "9.9.9.22" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBeNull();
    // The registrant keeps everything they need to come back and pay.
    expect(body.data?.ref_code).toBeTruthy();
    expect(body.data?.access_token).toBeTruthy();
    const rows = await sql<{ id: string }[]>`
      select id from registrations where group_id = ${String(body.data!.group_id)}`;
    expect(rows).toHaveLength(1);
  });
});
