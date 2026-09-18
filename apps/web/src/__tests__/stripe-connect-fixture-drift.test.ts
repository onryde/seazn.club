// scripts/stripe-connect-fixture.ts cannot IMPORT the app's Connect constants:
// it runs under plain `node --experimental-strip-types`, which resolves
// neither `server-only` nor the `@/` alias, so the account country is
// hand-copied there (its own comment explains why, and points here).
//
// A hand-copied literal is only safe if something fails when it drifts. This
// test is that something, and it lives in apps/web rather than beside the
// script because only here do both sides resolve — scripts/__tests__ runs from
// the repo root with no `@/` alias at all (ci.yml runs it with packages/engine's
// vitest binary). Same shape as the REQUIRED_CURRENCIES guard in
// stripe-sync.test.ts, which exists for exactly the same reason.
//
// The country is only the SMALLEST hand-copy. The whole create payload is
// hand-mirrored, and prose claiming "every field production sends is sent
// here too" has now been wrong twice (it missed `metadata.tos_agreed_at`).
// The second describe below replaces that prose with a check: both payloads
// are captured from the REAL calls — production's through
// createConnectOnboardingLink, the fixture's through createFixtureAccount —
// and compared, with the deliberate differences named in one place.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const v2AccountCreate = vi.fn();
  const accountLinkCreate = vi.fn();
  const accountsRetrieve = vi.fn();
  return {
    v2AccountCreate,
    accountLinkCreate,
    accountsRetrieve,
    stripe: {
      accounts: { retrieve: accountsRetrieve },
      accountLinks: { create: accountLinkCreate },
      v2: { core: { accounts: { create: v2AccountCreate } } },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  CONNECT_ACCOUNT_DEFAULT_COUNTRY,
  createConnectOnboardingLink,
} from "@/server/usecases/stripe-connect";
import {
  createFixtureAccount,
  FIXTURE_ACCOUNT_COUNTRY,
} from "../../../../scripts/stripe-connect-fixture.ts";

describe("Connect fixture script mirrors production's account country", () => {
  it("FIXTURE_ACCOUNT_COUNTRY tracks CONNECT_ACCOUNT_DEFAULT_COUNTRY", () => {
    // Accounts v2 requires identity.country before configuration.merchant may
    // be set. If production's default moves and the fixture's does not, the
    // local/CI destination-charge fixture is an account from a different
    // country than the one users get — a difference that shows up as a Stripe
    // capability or currency surprise, far from its cause.
    expect(FIXTURE_ACCOUNT_COUNTRY).toBe(CONNECT_ACCOUNT_DEFAULT_COUNTRY);
  });

  it("is a plausible ISO 3166-1 alpha-2 code, so neither side can drift to junk", () => {
    // The equality above is satisfied by two matching empty strings; the v2
    // API would reject that at create time, which is the worst place to learn.
    expect(FIXTURE_ACCOUNT_COUNTRY).toMatch(/^[A-Z]{2}$/);
  });
});

const HAS_DB = !!process.env.DATABASE_URL;

/**
 * Every way the fixture's create payload is allowed to differ from
 * production's, named once. Anything NOT listed here must match, and
 * anything listed here must still differ — a difference that quietly
 * disappears is drift too (it would mean the fixture started stamping a real
 * org_id, or production stopped sending one).
 */
const DELIBERATE = {
  /** Whole-object difference: neither side's metadata keys belong on the
   *  other. Production stamps `org_id` (which org owns the account) and
   *  `tos_agreed_at` (the chargeback acceptance — there is no DB column for
   *  it, so the metadata IS the record). The fixture belongs to no org and
   *  nobody accepted anything, so it stamps its own provenance instead. */
  metadata: { production: ["org_id", "tos_agreed_at"], fixture: ["created_at", "fixture"] },
  /** Same key, deliberately different value: there is no owner and no org
   *  here to read an email or a name from, so both are fixture constants.
   *  Both are still SENT — v2 requires contact_email whenever
   *  configuration.recipient is present, and production sends display_name
   *  for every org whose name is non-blank, which is essentially always. */
  valueOnly: ["contact_email", "display_name"] as const,
};

async function seedProOrg(): Promise<{ owner: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`drift-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Drift Org " + suffix}, ${"drift-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  return { owner: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null }, orgId };
}

/** The params the LAST v2 create was made with, typed off the SDK's own
 *  declaration so an SDK shape change moves this file rather than leaving it
 *  asserting a stale field name. */
const lastCreate = (): Record<string, unknown> =>
  stripeMock.v2AccountCreate.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;

describe.skipIf(!HAS_DB)("Connect fixture script mirrors production's create payload", () => {
  beforeEach(() => {
    stripeMock.v2AccountCreate.mockReset().mockImplementation(async () => ({
      id: "acct_v2_" + randomUUID().slice(0, 8),
    }));
    stripeMock.accountLinkCreate
      .mockReset()
      .mockResolvedValue({ url: "https://connect.stripe.test/onboard" });
    stripeMock.accountsRetrieve.mockReset().mockResolvedValue({ id: "acct_v2_fixture" });
  });

  /** Production's payload, from production's own call — not a table typed
   *  into this test, which is what let the count of differences be wrong
   *  twice. */
  async function productionPayload(): Promise<Record<string, unknown>> {
    const { owner, orgId } = await seedProOrg();
    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect", true);
    return lastCreate();
  }

  async function fixturePayload(): Promise<Record<string, unknown>> {
    await createFixtureAccount(stripeMock.stripe as unknown as Stripe);
    return lastCreate();
  }

  it("sends the same top-level fields — a new production field is not silently skipped", async () => {
    const prod = Object.keys(await productionPayload()).sort();
    const fix = Object.keys(await fixturePayload()).sort();
    // No allow-list at this level on purpose: every difference between the
    // two is a difference in a VALUE, so the key sets are simply equal. Add a
    // field to production's create and this reds until the fixture has it too.
    expect(fix).toEqual(prod);
  });

  it("sends identical values for every field that is not deliberately different", async () => {
    const prod = await productionPayload();
    const fix = await fixturePayload();
    const shared = Object.keys(prod).filter(
      (k) => k !== "metadata" && !DELIBERATE.valueOnly.includes(k as "contact_email"),
    );
    // dashboard, identity, configuration, defaults — the capability and
    // responsibility shape the fixture exists to reproduce. Deep equality, so
    // a nested change (dropping `merchant`, moving a collector) reds here.
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) expect({ [key]: fix[key] }).toEqual({ [key]: prod[key] });
  });

  it("differs from production exactly where DELIBERATE says, and nowhere else", async () => {
    const prod = await productionPayload();
    const fix = await fixturePayload();
    expect(Object.keys(prod.metadata as object).sort()).toEqual(DELIBERATE.metadata.production);
    expect(Object.keys(fix.metadata as object).sort()).toEqual(DELIBERATE.metadata.fixture);
    // The fixture belongs to no club: an org_id here would make it look like
    // a real one in the Dashboard.
    expect(fix.metadata).not.toHaveProperty("org_id");
    for (const key of DELIBERATE.valueOnly) {
      // Present on both (the key-set test above would catch an omission, but
      // not an undefined value), and different — if they ever match, one side
      // has started reading the other's source.
      expect(fix[key]).toBeTruthy();
      expect(prod[key]).toBeTruthy();
      expect(fix[key]).not.toBe(prod[key]);
    }
  });
});
