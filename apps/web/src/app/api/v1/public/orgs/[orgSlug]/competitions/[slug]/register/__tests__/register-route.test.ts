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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => {}) }));

// RS003 W3a — the route now mints a real checkout for a payable cart, so
// this file needs the same Stripe mock shape registrations.test.ts uses
// (checkout.sessions.create only; nothing else is reachable from here).
const stripeMock = vi.hoisted(() => ({ checkoutCreate: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: stripeMock.checkoutCreate } } }),
}));

// RS005 W4 — the route sends the cart confirmation post-submit (notifySubmitted, usecases/registrations/mail.ts). Since phase 3 wave 1 that mail is
// QUEUED on the email outbox (kind `registration_confirmation`, ref `registration_group/<group id>`) and attempted after the response.
// Only the outbox's network seam is replaced: this file proves the route's WIRING (what was queued, for whom, with what body, and what
// the 201 does when the mail goes wrong); the queue itself is registration-confirmation-outbox.test.ts's and the template's is
// email-builders.test.ts's.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

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
import { idempotencyKey } from "@/server/email-outbox/constants";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { dictionarySubject } from "@/server/email-outbox/__tests__/_kind-harness";
import { log } from "@/server/logger";
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
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_rr_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type ConfirmationRow = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
};

/** The cart's confirmation row once its first attempt has finished (the dispatch after the response runs on its own). */
async function confirmationOf(groupId: string): Promise<ConfirmationRow> {
  await vi.waitFor(
    async () => {
      const rows = await sql<{ status: string; attempts: number }[]>`
        select status, attempts from email_outbox where kind = 'registration_confirmation' and ref_id = ${groupId}`;
      if (rows.length !== 1) throw new Error(`${rows.length} confirmation row(s) for the cart`);
      if (rows[0]!.status === "queued" && rows[0]!.attempts === 0) throw new Error("the first attempt has not started");
      if (rows[0]!.status === "sending") throw new Error("the first attempt is still in flight");
    },
    { timeout: 10_000, interval: 50 },
  );
  const [row] = await sql<ConfirmationRow[]>`
    select id, kind, ref_type, ref_id, recipient, subject, status, attempts
      from email_outbox where kind = 'registration_confirmation' and ref_id = ${groupId}`;
  return row!;
}

/** What the provider was handed under the row's key. */
const providerSaw = (row: { id: string }) =>
  transport.deliver.mock.calls
    .map((c) => c[0] as { to: string; subject: string; html: string; text: string; idempotencyKey: string })
    .filter((m) => m.idempotencyKey === idempotencyKey(row.id));

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
    // Player payment page (P5): the response keeps `checkout_url`, but the
    // confirmation mail never carries it — its Pay button goes to the cart's
    // own token-bearing status page.
    const row = await confirmationOf(String(body.data!.group_id));
    expect(row).toMatchObject({ kind: "registration_confirmation", ref_type: "registration_group", ref_id: body.data!.group_id, status: "sent" });
    const saw = providerSaw(row);
    expect(saw).toHaveLength(1);
    for (const part of [saw[0]!.text, saw[0]!.html]) {
      expect(part).not.toContain("checkout.stripe");
      expect(part).not.toContain("cs_test_");
    }
    expect(saw[0]!.text).toContain(
      `/live/${orgSlug}/${competition.slug}/register/status?rid=${String(body.data!.group_id)}&token=${encodeURIComponent(String(body.data!.access_token))}`,
    );
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
    // RS005 W4: a mint failure must not skip the send — the registrant
    // still needs the confirmation, just without a pay link this time.
    const row = await confirmationOf(String(body.data!.group_id));
    expect(row.status).toBe("sent");
    const saw = providerSaw(row);
    expect(saw).toHaveLength(1);
    expect(saw[0]!.text, "no pay link: none was minted").not.toContain("checkout.stripe.test");
    expect(saw[0]!.text, "but it is still the cart's confirmation, with its status link").toContain(`rid=${String(body.data!.group_id)}`);
  });

  // RS005 W4 finding: the confirmation mailer had ZERO callers before this
  // wave, so nobody who registered ever received a ref code, a status link
  // or a receipt. This is the assertion whose absence let the whole gap
  // exist — it proves a confirmation is actually queued and sent, with the
  // cart's own contact and every entry, not just that the route returns 201.
  it("a real submit queues the cart confirmation — addressed to the contact, listing every entry", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // capacity 1 + two entries in one cart: the first takes the spot, the
    // second waitlists — one submit call, one commit, one email, both
    // entries' OWN status/fee.
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 1500, 1, 'stripe', 'auto', false)`;
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const contactEmail = `rep-${randomUUID().slice(0, 8)}@test.local`;

    const res = await registerRoute(
      req(
        URL_(orgSlug, competition.slug),
        groupBody({
          contact: { name: "Rep", email: contactEmail },
          entries: [
            { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "First In" }], answers: {} },
            { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Second In" }], answers: {} },
          ],
        }),
        { "x-forwarded-for": "9.9.9.30" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    const groupId = String(body.data!.group_id);

    // The row: one confirmation for the cart, addressed to the contact, in the dictionary's English subject.
    const row = await confirmationOf(groupId);
    expect(row).toMatchObject({ kind: "registration_confirmation", ref_type: "registration_group", ref_id: groupId, recipient: contactEmail, status: "sent" });
    const [{ name: competitionName }] = await sql<{ name: string }[]>`select name from competitions where id = ${competition.id}`;
    expect(row.subject).toBe(dictionarySubject("en", "registration.subject", { competitionName }));
    const saw = providerSaw(row);
    expect(saw, "one mail for the whole cart").toHaveLength(1);
    expect(saw[0]!.to).toBe(contactEmail);
    expect(saw[0]!.subject).toBe(row.subject);
    // Every entry is in it, with its OWN status (the waitlisted one carries no charge, by construction upstream) and the cart's total.
    // Each on its own line with its own status, the words from the dictionary: the card entry that holds the spot is awaiting
    // payment (polish wave: the status word says what is owed, not a bare "Pending"), the second is waitlisted.
    const lineOf = (name: string) => saw[0]!.text.split("\n").filter((l) => l.includes(name));
    expect(lineOf("First In")).toHaveLength(1);
    expect(lineOf("Second In")).toHaveLength(1);
    expect(lineOf("First In")[0]).toContain(dictionarySubject("en", "registration.entryStatusAwaitingPayment", {}));
    expect(lineOf("Second In")[0]).toContain(dictionarySubject("en", "registration.entryStatusWaitlisted", {}));
    expect(lineOf("Second In")[0], "a waitlisted entry carries no charge").not.toContain("£");
    expect(saw[0]!.text).toContain("£15.00");
  });

  // The other half of "never fail the submit": submitRegistrationGroup has
  // already COMMITTED by the time notifySubmitted runs, so a mail-provider
  // throw must not turn a real, capacity-holding registration into an error
  // response the registrant would (wrongly) read as "it didn't work".
  it("a mail failure does not fail the submit — the registration still exists, the response is still 201, and the outbox keeps the mail to retry", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedSettings(division.id);
    // The provider call itself blows up: the attempt reads it as a network failure and leaves the row to the retry worker.
    transport.deliver.mockReset().mockRejectedValue(new Error("resend is down"));

    const res = await registerRoute(
      req(
        URL_(orgSlug, competition.slug),
        groupBody({
          entries: [
            { division_id: division.id, entrant_kind: "individual", players: [{ full_name: "Resilient" }], answers: {} },
          ],
        }),
        { "x-forwarded-for": "9.9.9.31" },
      ),
      ctx(orgSlug, competition.slug),
    );
    const { status, body } = await read(res);
    expect(status).toBe(201);
    const entries = body.data!.entries as { registration_id: string }[];
    const [row] = await sql<{ status: string }[]>`
      select status from registrations where id = ${entries[0]!.registration_id}`;
    expect(row!.status).toBe("confirmed");
    const mail = await confirmationOf(String(body.data!.group_id));
    expect(mail, "the confirmation waits in the outbox for the retry worker").toMatchObject({ status: "queued", attempts: 1 });
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B0 — per-stage submit timing (spec 2026-11-13-registration-redesign-design.md §3.2). Every submit logs one
// `register.submit.timing` line; the `Server-Timing` header rides the 201 only when REGISTER_SERVER_TIMING is exactly "1". The
// stage names below are the spec's list (rate_limit, turnstile, user, pre_tx + its sub-stages, tx, mint + its sub-stages, mail,
// total), filtered by what each cart actually runs - never read back from the timer.
// ---------------------------------------------------------------------------

/** The plan's Server-Timing grammar: `name;dur=N` entries, ", "-separated, at most one decimal. */
const SERVER_TIMING_LIST = /^[a-z_.]+;dur=\d+(\.\d)?(, [a-z_.]+;dur=\d+(\.\d)?)*$/;

type TimingLine = { timing: Record<string, number>; divisions: number; entries: number; players: number; payment_method: string };

/** Every `register.submit.timing` payload the spy saw, in order. */
function timingLines(spy: { mock: { calls: unknown[][] } }): TimingLine[] {
  return spy.mock.calls.filter((c) => c[1] === "register.submit.timing").map((c) => c[0] as TimingLine);
}

const headerStages = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").filter(Boolean).map((m) => m.split(";")[0]!);

/** Route-level stages a submit runs whatever the cart (the usecase's own are added by the DB-backed cases). */
const ROUTE_STAGES = ["rate_limit", "turnstile", "user", "mail", "total"];

describe("POST .../register — submit timing (routing)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(log, "info");
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it.each([[undefined], [""], ["0"], ["true"], ["yes"]])("sends no Server-Timing when REGISTER_SERVER_TIMING is %j, and still logs the timing line", async (value) => {
    vi.stubEnv("REGISTER_SERVER_TIMING", value);
    submitSpy.mockResolvedValueOnce(fakeResult());
    const res = await registerRoute(req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.8.1" }), ctx("acme", "cup"));
    expect(res.status).toBe(201);
    expect(res.headers.get("server-timing")).toBeNull();
    const lines = timingLines(infoSpy);
    expect(lines, "one timing line per submit, header or not").toHaveLength(1);
    expect(Object.keys(lines[0]!.timing).sort()).toEqual([...ROUTE_STAGES].sort());
  });

  it("sends Server-Timing when REGISTER_SERVER_TIMING=1, naming exactly the stages the log line reports", async () => {
    vi.stubEnv("REGISTER_SERVER_TIMING", "1");
    submitSpy.mockResolvedValueOnce(fakeResult());
    const res = await registerRoute(req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.8.2" }), ctx("acme", "cup"));
    expect(res.status).toBe(201);
    const header = res.headers.get("server-timing");
    expect(header).toMatch(SERVER_TIMING_LIST);
    const lines = timingLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(headerStages(res).sort()).toEqual(Object.keys(lines[0]!.timing).sort());
    // A zero-subtotal cart never reaches the mint (route: `amount_cents > 0`), so no mint stage is timed.
    expect(headerStages(res).sort()).toEqual([...ROUTE_STAGES].sort());
  });

  it("the body is unchanged by the timer: the same 201 envelope with or without the header", async () => {
    const fake = fakeResult();
    vi.stubEnv("REGISTER_SERVER_TIMING", "1");
    submitSpy.mockResolvedValueOnce(fake);
    const on = await read(await registerRoute(req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.8.3" }), ctx("acme", "cup")));
    vi.stubEnv("REGISTER_SERVER_TIMING", undefined);
    submitSpy.mockResolvedValueOnce(fake);
    const off = await read(await registerRoute(req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.8.3" }), ctx("acme", "cup")));
    expect(on.body.data).toEqual({ ...fake, checkout_url: null });
    expect(off.body.data).toEqual(on.body.data);
  });

  it("a refused submit (rate limit) sends no timing header and logs no timing line", async () => {
    vi.stubEnv("REGISTER_SERVER_TIMING", "1");
    rl.mockImplementationOnce(async () => {
      throw new HttpError(429, "slow down");
    });
    const res = await registerRoute(req(URL_("acme", "cup"), groupBody(), { "x-forwarded-for": "9.9.8.4" }), ctx("acme", "cup"));
    expect(res.status).toBe(429);
    expect(res.headers.get("server-timing")).toBeNull();
    expect(timingLines(infoSpy)).toEqual([]);
  });

  // The line goes to stdout and on to Sentry Logs: stage names, milliseconds and the cart's SHAPE only. No contact, no player name,
  // no slug, no ip, no id, ref code or token.
  it("logs the cart's shape - distinct divisions, entries, players, payment method - and nothing that names anyone", async () => {
    const divisionA = randomUUID();
    const divisionB = randomUUID();
    const fake = fakeResult();
    submitSpy.mockResolvedValueOnce(fake);
    const body = groupBody({
      contact: { name: "Zelda Contact", email: "zelda.contact@test.local" },
      entries: [
        { division_id: divisionA, entrant_kind: "individual", players: [{ full_name: "Ana Example" }], answers: {} },
        { division_id: divisionB, entrant_kind: "pair", players: [{ full_name: "Ben Example" }, { full_name: "Cy Example" }], answers: {} },
        { division_id: divisionA, entrant_kind: "individual", players: [{ full_name: "Dee Example" }], answers: {} },
      ],
    });
    const res = await registerRoute(req(URL_("acme-shape", "cup-shape"), body, { "x-forwarded-for": "9.9.8.5" }), ctx("acme-shape", "cup-shape"));
    expect(res.status).toBe(201);
    const [line] = timingLines(infoSpy);
    // 2 distinct divisions, 3 entries, 1 + 2 + 1 = 4 players: three different numbers, so a swapped count cannot pass.
    expect(line).toMatchObject({ divisions: 2, entries: 3, players: 4, payment_method: "none" });
    expect(Object.keys(line!).sort()).toEqual(["divisions", "entries", "payment_method", "players", "timing"]);
    for (const [stage, ms] of Object.entries(line!.timing)) {
      expect(stage).toMatch(/^[a-z_.]+$/);
      expect(typeof ms).toBe("number");
    }
    const text = JSON.stringify(line);
    for (const secret of [
      "Zelda", "zelda.contact@test.local", "Ana Example", "Ben Example", "Cy Example", "Dee Example",
      "acme-shape", "cup-shape", "9.9.8.5", divisionA, divisionB, fake.group_id, fake.ref_code, fake.access_token,
    ]) {
      expect(text, `the timing line must not carry ${secret}`).not.toContain(secret);
    }
  });
});

describe.skipIf(!HAS_DB)("POST .../register — submit timing (DB-backed)", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(log, "info");
    vi.stubEnv("REGISTER_SERVER_TIMING", "1");
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  async function paidRig(paymentMethod: "stripe" | "offline"): Promise<{ orgSlug: string; compSlug: string; divisionId: string }> {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    await sql`update organizations
              set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const { competition, division } = await rig(asOwner(orgId, ownerId));
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, ${paymentMethod}, 'auto', false)`;
    return { orgSlug, compSlug: competition.slug, divisionId: division.id };
  }

  const oneEntry = (divisionId: string) =>
    groupBody({ entries: [{ division_id: divisionId, entrant_kind: "individual", players: [{ full_name: "Timed Player" }], answers: {} }] });

  it("a free cart times every pre-transaction read under pre_tx, the transaction, and never the mint", async () => {
    const { orgSlug, orgId, ownerId } = await seedOrg();
    const { competition, division } = await rig(asOwner(orgId, ownerId));
    await seedSettings(division.id);

    const res = await registerRoute(req(URL_(orgSlug, competition.slug), oneEntry(division.id), { "x-forwarded-for": "9.9.8.10" }), ctx(orgSlug, competition.slug));
    expect(res.status).toBe(201);
    const [line] = timingLines(infoSpy);
    expect(line!.payment_method).toBe("none");
    // Not an online division (no `online`/`seat_gate`), no paid card division's feature check beyond the plan cap, nothing to mint.
    expect(Object.keys(line!.timing).sort()).toEqual(
      [...ROUTE_STAGES, "pre_tx", "pre_tx.division_ctx", "pre_tx.settings", "pre_tx.entitlements", "tx"].sort(),
    );
    expect(headerStages(res).sort()).toEqual(Object.keys(line!.timing).sort());
    // The nesting is real: a parent spans its children, and the run spans its sequential parts.
    const t = line!.timing;
    for (const sub of ["pre_tx.division_ctx", "pre_tx.settings", "pre_tx.entitlements"]) expect(t.pre_tx!).toBeGreaterThanOrEqual(t[sub]!);
    expect(t.total!).toBeGreaterThanOrEqual(t.pre_tx! + t.tx! - 0.2);
  });

  it("a card cart times the mint, its reads and the Stripe call, and logs the method as card", async () => {
    const rigd = await paidRig("stripe");
    const res = await registerRoute(req(URL_(rigd.orgSlug, rigd.compSlug), oneEntry(rigd.divisionId), { "x-forwarded-for": "9.9.8.11" }), ctx(rigd.orgSlug, rigd.compSlug));
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBe("https://checkout.stripe.test/session");
    const [line] = timingLines(infoSpy);
    expect(line!.payment_method).toBe("card");
    expect(Object.keys(line!.timing)).toEqual(expect.arrayContaining(["mint", "mint.mint_reads", "mint.stripe", "pre_tx", "tx"]));
    expect(line!.timing.mint!).toBeGreaterThanOrEqual(line!.timing["mint.stripe"]!);
    expect(headerStages(res).sort()).toEqual(Object.keys(line!.timing).sort());
  });

  it("a mint that fails is still timed, the 201 still goes out, and the method is logged as mint_failed", async () => {
    const rigd = await paidRig("stripe");
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe is down"));
    const res = await registerRoute(req(URL_(rigd.orgSlug, rigd.compSlug), oneEntry(rigd.divisionId), { "x-forwarded-for": "9.9.8.12" }), ctx(rigd.orgSlug, rigd.compSlug));
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBeNull();
    const [line] = timingLines(infoSpy);
    expect(line!.payment_method).toBe("mint_failed");
    expect(Object.keys(line!.timing)).toEqual(expect.arrayContaining(["mint", "mint.mint_reads", "mint.stripe"]));
    expect(res.headers.get("server-timing")).toMatch(SERVER_TIMING_LIST);
  });

  it("an offline paid cart reaches the mint, which reads and declines without calling Stripe; the method is offline", async () => {
    const rigd = await paidRig("offline");
    const res = await registerRoute(req(URL_(rigd.orgSlug, rigd.compSlug), oneEntry(rigd.divisionId), { "x-forwarded-for": "9.9.8.13" }), ctx(rigd.orgSlug, rigd.compSlug));
    const { status, body } = await read(res);
    expect(status).toBe(201);
    expect(body.data?.checkout_url).toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    const [line] = timingLines(infoSpy);
    expect(line!.payment_method).toBe("offline");
    expect(Object.keys(line!.timing)).toEqual(expect.arrayContaining(["mint", "mint.mint_reads"]));
    expect(Object.keys(line!.timing)).not.toContain("mint.stripe");
  });
});
