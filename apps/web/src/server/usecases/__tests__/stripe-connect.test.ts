// ToS gate on Stripe Connect onboarding (PROMPT-55): the connected account is
// only created after the owner accepts the entry-fee chargeback terms; the
// acceptance timestamp is recorded on the Stripe account metadata. Real
// Postgres required; skipped without DATABASE_URL.
//
// Since the Accounts v2 migration this file also owns the CREATE SHAPE — see
// the "Connect account creation goes through Accounts v2" block below. These
// assertions are against a STUBBED SDK, so they prove what we pass and nothing
// about what is sent; connect-accounts-v2-wire.test.ts covers the wire and
// connect-accounts-v2.live.test.ts (BILLING_LIVE=1) covers Stripe itself.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  // `accounts.create` is the ACCOUNTS V1 call this codebase no longer makes.
  // It stays stubbed rather than being deleted so the regression assertions
  // below can prove it is never reached — a bare `vi.fn()` that nothing calls
  // is the only way to witness a reintroduced `accounts.create({type:"express"})`.
  const accountCreate = vi.fn();
  const v2AccountCreate = vi.fn();
  const accountLinkCreate = vi.fn();
  const loginLinkCreate = vi.fn();
  return {
    accountCreate,
    v2AccountCreate,
    accountLinkCreate,
    loginLinkCreate,
    stripe: {
      accounts: { create: accountCreate, createLoginLink: loginLinkCreate },
      accountLinks: { create: accountLinkCreate },
      v2: { core: { accounts: { create: v2AccountCreate } } },
    },
  };
});

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  CONNECT_ACCOUNT_DEFAULT_COUNTRY,
  connectStatus,
  createConnectDashboardLink,
  createConnectOnboardingLink,
  syncConnectAccount,
} from "../stripe-connect";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

/** The params the Accounts v2 create call was actually made with, typed off
 *  the SDK's own declaration so a shape change in the SDK moves this file
 *  with it rather than leaving it asserting a stale field name. */
const createdWith = (): Stripe.V2.Core.AccountCreateParams =>
  stripeMock.v2AccountCreate.mock.calls[0][0] as Stripe.V2.Core.AccountCreateParams;

async function seedProOrg(opts: { orgName?: string } = {}): Promise<{
  owner: AuthCtx;
  orgId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`owner-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${opts.orgName ?? "Connect Org " + suffix}, ${"cn-org-" + suffix}, ${ownerId})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  return {
    owner: {
      orgId,
      via: "session",
      userId: ownerId,
      role: "owner",
      keyId: null,
    },
    orgId,
  };
}

beforeEach(() => {
  stripeMock.accountCreate.mockReset().mockImplementation(async () => ({
    id: "acct_v1_" + randomUUID().slice(0, 8),
  }));
  stripeMock.v2AccountCreate.mockReset().mockImplementation(async () => ({
    id: "acct_v2_" + randomUUID().slice(0, 8),
  }));
  stripeMock.accountLinkCreate
    .mockReset()
    .mockResolvedValue({ url: "https://connect.stripe.test/onboard" });
  stripeMock.loginLinkCreate
    .mockReset()
    .mockResolvedValue({ url: "https://connect.stripe.test/express-dash" });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Connect onboarding ToS gate (PROMPT-55)", () => {
  it("first connect without agreement → 422, no Stripe account created", async () => {
    const { owner, orgId } = await seedProOrg();
    await expect(
      createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect"),
    ).rejects.toMatchObject({ status: 422 });
    expect(stripeMock.v2AccountCreate).not.toHaveBeenCalled();
    expect(stripeMock.accountCreate).not.toHaveBeenCalled();
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id).toBeNull();
  });

  it("agreement creates the account with the acceptance stamped in metadata", async () => {
    const { owner, orgId } = await seedProOrg();
    const { url } = await createConnectOnboardingLink(
      owner,
      orgId,
      "http://test.local",
      "/settings/connect",
      true,
    );
    expect(url).toBe("https://connect.stripe.test/onboard");
    expect(stripeMock.v2AccountCreate).toHaveBeenCalledTimes(1);
    const args = createdWith();
    expect(args.metadata?.org_id).toBe(orgId);
    expect(new Date(String(args.metadata?.tos_agreed_at)).getTime()).not.toBeNaN();
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id).not.toBeNull();
  });

  it("resuming onboarding on an existing account does not re-ask", async () => {
    const { owner, orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_prior_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    const { url } = await createConnectOnboardingLink(
      owner,
      orgId,
      "http://test.local",
      "/settings/connect",
    );
    expect(url).toBe("https://connect.stripe.test/onboard");
    expect(stripeMock.v2AccountCreate).not.toHaveBeenCalled();
    expect(stripeMock.accountCreate).not.toHaveBeenCalled();
  });
});

/**
 * ACCOUNTS V2 create shape.
 *
 * Every field below was required by an actual 400 from the live v2 API, or is
 * exact parity with the v1 call this replaced. A test that only asserted "v2
 * create was called" would be worthless here: the whole risk of this migration
 * is a wrong VALUE in a field v1 never had, and a wrongly-seeded field is worse
 * than an absent one because it overrides the default Stripe would have picked.
 */
describe.skipIf(!HAS_DB)("Connect account creation goes through Accounts v2", () => {
  /** The org row as the DATABASE holds it — the source the use-case reads
   *  contact_email/display_name from, never a literal typed into this file. */
  async function ownerProfile(orgId: string): Promise<{ name: string; email: string }> {
    const [row] = await sql<{ name: string; email: string }[]>`
      select o.name, u.email
      from organizations o
      join org_members m on m.org_id = o.id and m.role = 'owner'
      join users u on u.id = m.user_id
      where o.id = ${orgId}`;
    return row;
  }

  async function connect(owner: AuthCtx, orgId: string): Promise<void> {
    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect", true);
  }

  it("creates through v2, and never through the v1 accounts API", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    expect(stripeMock.v2AccountCreate).toHaveBeenCalledTimes(1);
    // The regression guard: `stripe.accounts.create({type:"express"})` coming
    // back would light this, and nothing else in the suite would notice.
    expect(stripeMock.accountCreate).not.toHaveBeenCalled();
  });

  it("keeps the EXPRESS dashboard, which is what createConnectDashboardLink's login links need", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    expect(createdWith().dashboard).toBe("express");
  });

  it("requests BOTH the merchant card_payments and the recipient transfers capability", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    const cfg = createdWith().configuration;
    // MERCHANT is the half that is easy to drop — a recipient-only account can
    // receive transfers but may never light `charges_enabled`, the flag
    // syncConnectAccount writes and ~17 non-test sites gate registration,
    // sponsors and public data on. Asserted as a VALUE, not a presence check.
    expect(cfg?.merchant?.capabilities?.card_payments?.requested).toBe(true);
    // …and RECIPIENT is v1's `transfers`, which every destination charge needs.
    expect(cfg?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.requested).toBe(true);
  });

  it("makes the PLATFORM the fees and losses collector, as destination charges already assume", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    const responsibilities = createdWith().defaults?.responsibilities;
    expect(responsibilities?.fees_collector).toBe("application");
    expect(responsibilities?.losses_collector).toBe("application");
  });

  it("does NOT pin a settlement currency — syncConnectAccount owns that", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    const defaults = createdWith().defaults;
    // Positive pair first: `defaults` IS sent, so the absence below is a real
    // decision about `currency` and not a vacuously-empty object.
    expect(defaults?.responsibilities).toBeDefined();
    // syncConnectAccount deliberately handles a NULL settlement currency
    // (an account has none until Stripe knows its country/bank). Pinning one
    // here would defeat that and go stale — the field does not follow a later
    // country change.
    expect(defaults?.currency).toBeUndefined();
  });

  it("carries the owner's email as contact_email and the org's name as display_name", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    const profile = await ownerProfile(orgId);
    const params = createdWith();
    // Both required by v2 and absent from v1's call — `AuthCtx` carries no
    // email and `organizations` has no contact-email column, so a broken join
    // here is the most likely way this migration ships a 400 to a real club.
    expect(params.contact_email).toBe(profile.email);
    expect(params.display_name).toBe(profile.name);
  });

  it("omits display_name entirely when the org name is blank, rather than sending an empty one", async () => {
    // `organizations.name` is `text not null` with no non-empty CHECK, so a
    // whitespace name is reachable. `display_name: ""` is a 400 waiting to
    // happen; omitting it lets Stripe collect one during onboarding.
    const { owner, orgId } = await seedProOrg({ orgName: "   " });
    await connect(owner, orgId);
    expect(createdWith().display_name).toBeUndefined();
    // …and the account is still created: a blank name must not block connect.
    expect(stripeMock.v2AccountCreate).toHaveBeenCalledTimes(1);
  });

  it("defaults identity.country to the platform country, which stays mutable through onboarding", async () => {
    const { owner, orgId } = await seedProOrg();
    await connect(owner, orgId);
    const country = createdWith().identity?.country;
    // Derived from the module's own constant, so moving the platform country
    // moves this test with it instead of asserting yesterday's value…
    expect(country).toBe(CONNECT_ACCOUNT_DEFAULT_COUNTRY);
    // …and the constant itself has to be a real ISO 3166-1 alpha-2 code, which
    // is what the create call is rejected for if it is not.
    expect(CONNECT_ACCOUNT_DEFAULT_COUNTRY).toMatch(/^[A-Z]{2}$/);
  });

  it("refuses before Stripe when the session's user has no email row to use as contact_email", async () => {
    // The case that DEFEATS the guard: v2 rejects a create with no
    // contact_email, so sending the request anyway would turn a local data
    // problem into an opaque Stripe 400. A session whose user row is gone is
    // the only way to reach it — and it must cost nothing at Stripe.
    const { orgId } = await seedProOrg();
    const ghost: AuthCtx = {
      orgId,
      via: "session",
      userId: randomUUID(),
      role: "owner",
      keyId: null,
    };
    await expect(
      createConnectOnboardingLink(ghost, orgId, "http://test.local", "/settings/connect", true),
    ).rejects.toMatchObject({ status: 500 });
    expect(stripeMock.v2AccountCreate).not.toHaveBeenCalled();
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id, "nothing may be stored for a refused create").toBeNull();
  });

  it("stores the id v2 returned, and mints the onboarding link against it through Account Links v1", async () => {
    const { owner, orgId } = await seedProOrg();
    // Run-unique: `organizations.stripe_account_id` is UNIQUE, so a literal id
    // reds on the second run against the same database.
    const pinned = "acct_v2_pinned_" + randomUUID().slice(0, 8);
    stripeMock.v2AccountCreate.mockResolvedValueOnce({ id: pinned });
    await connect(owner, orgId);
    const [org] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(org.stripe_account_id).toBe(pinned);
    // The link API stays on v1 on purpose — it accepts a v2 account id.
    expect(stripeMock.accountLinkCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account: pinned, type: "account_onboarding" }),
    );
  });
});

describe.skipIf(!HAS_DB)("Onboarding masks Stripe's raw failures", () => {
  // `v1()`'s catch-all (server/api-v1/http.ts) puts `err.message` straight into
  // the 500 body, and org-payment-instructions.tsx's startOnboarding() renders
  // that message verbatim — so an unguarded Stripe throw here is printed on a
  // money screen. `createConnectDashboardLink` below already guards its own
  // call the same way; these two pin the onboarding half.
  //
  // Both halves are asserted on purpose: "the raw text is gone" alone is
  // satisfied by any replacement (including an empty message or a 500 that
  // says nothing), so each case also pins the status and the generic string.
  const RAW = "You provided a malformed API Key 'sk_test_51Hxxx' for account 'acct_1Leak'";
  const GENERIC = "Stripe couldn't start onboarding for this organization";

  it("a failing account CREATE becomes a clean 502, not Stripe's message", async () => {
    const { owner, orgId } = await seedProOrg();
    stripeMock.v2AccountCreate.mockRejectedValue(
      Object.assign(new Error(RAW), { type: "StripeAuthenticationError", statusCode: 401 }),
    );
    const err = (await createConnectOnboardingLink(
      owner,
      orgId,
      "http://test.local",
      "/settings/connect",
      true,
    ).catch((e) => e)) as Error & { status?: number };
    // Negative: no key material, no account id, none of Stripe's wording.
    expect(err.message).not.toContain("malformed API Key");
    expect(err.message).not.toMatch(/sk_test|acct_/);
    // Positive pair: it is the generic 502 and not some other refusal that
    // happens to lack those substrings (a 402/422 would also pass the above).
    expect(err.status).toBe(502);
    expect(err.message).toBe(GENERIC);
  });

  it("a failing LINK mint is masked too — the resume path throws no account create", async () => {
    // An org that already holds an account takes the resume branch, so the
    // only Stripe call left is accountLinks.create. Without its own guard this
    // one leaks even when the create path is wrapped.
    const { owner, orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_link_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    stripeMock.accountLinkCreate.mockRejectedValue(
      Object.assign(new Error(RAW), { type: "StripeAuthenticationError", statusCode: 401 }),
    );
    const err = (await createConnectOnboardingLink(
      owner,
      orgId,
      "http://test.local",
      "/settings/connect",
      true,
    ).catch((e) => e)) as Error & { status?: number };
    expect(err.message).not.toMatch(/malformed API Key|sk_test|acct_/);
    expect(err.status).toBe(502);
    expect(err.message).toBe(GENERIC);
    expect(stripeMock.v2AccountCreate).not.toHaveBeenCalled();
  });

  it("the org's OWN refusals still answer as themselves, not as a Stripe 502", async () => {
    // The guard must mask Stripe, not swallow the deliberate answers around
    // it. Without this, wrapping the whole body in one catch-all would look
    // green: the ToS 422 is the copy that tells an owner what to DO.
    const { owner, orgId } = await seedProOrg();
    await expect(
      createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect"),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe.skipIf(!HAS_DB)("Express dashboard login link", () => {
  it("connected org gets a fresh login link for its account", async () => {
    const { owner, orgId } = await seedProOrg();
    const acctId = "acct_dash_" + orgId.slice(0, 8);
    await sql`update organizations set stripe_account_id = ${acctId} where id = ${orgId}`;
    const { url } = await createConnectDashboardLink(owner, orgId);
    expect(url).toBe("https://connect.stripe.test/express-dash");
    expect(stripeMock.loginLinkCreate).toHaveBeenCalledWith(acctId);
  });

  it("no Connect account → 409 before Stripe is touched", async () => {
    const { owner, orgId } = await seedProOrg();
    await expect(createConnectDashboardLink(owner, orgId)).rejects.toMatchObject({
      status: 409,
    });
    expect(stripeMock.loginLinkCreate).not.toHaveBeenCalled();
  });

  it("non-owner → 403", async () => {
    const { orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_x_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    const viewer: AuthCtx = {
      orgId,
      via: "session",
      userId: randomUUID(),
      role: "viewer",
      keyId: null,
    };
    await expect(createConnectDashboardLink(viewer, orgId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("restricted key (login links fenced) falls back to Stripe's Express login page", async () => {
    const { owner, orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_rk_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    // Stripe rejects createLoginLink for rk_ keys with a PermissionError —
    // not a grantable scope, the endpoint requires a full secret key.
    stripeMock.loginLinkCreate.mockRejectedValue(
      Object.assign(new Error("This is a restricted API key"), {
        type: "StripePermissionError",
        statusCode: 403,
      }),
    );
    const { url } = await createConnectDashboardLink(owner, orgId);
    expect(url).toBe("https://connect.stripe.com/express_login");
  });

  it("other Stripe failures become a clean 502 — no key material in the message", async () => {
    const { owner, orgId } = await seedProOrg();
    await sql`update organizations set stripe_account_id = ${"acct_bad_" + orgId.slice(0, 8)}
              where id = ${orgId}`;
    stripeMock.loginLinkCreate.mockRejectedValue(
      Object.assign(
        new Error("The provided key 'rk_test_abc123' does not have access to account 'acct_nope'"),
        { type: "StripeInvalidRequestError", statusCode: 400 },
      ),
    );
    const err = (await createConnectDashboardLink(owner, orgId).catch((e) => e)) as Error & {
      status?: number;
    };
    expect(err.status).toBe(502);
    expect(String(err.message)).not.toMatch(/rk_test|acct_/);
  });
});

describe.skipIf(!HAS_DB)("Connect health mirror (P1-8)", () => {
  it("syncConnectAccount mirrors payouts/disabled-reason/requirements onto the org row", async () => {
    const { owner, orgId } = await seedProOrg();
    const acctId = "acct_health_" + orgId.slice(0, 8);
    await sql`update organizations set stripe_account_id = ${acctId} where id = ${orgId}`;

    const account = {
      id: acctId,
      charges_enabled: true,
      payouts_enabled: false,
      requirements: {
        currently_due: ["individual.id_number"],
        disabled_reason: "requirements.pending_verification",
      },
    } as unknown as Stripe.Account;
    await syncConnectAccount(account);

    const [org] = await sql<
      {
        stripe_charges_enabled: boolean;
        stripe_payouts_enabled: boolean;
        stripe_disabled_reason: string | null;
        stripe_requirements_due: number;
      }[]
    >`
      select stripe_charges_enabled, stripe_payouts_enabled,
             stripe_disabled_reason, stripe_requirements_due
      from organizations where id = ${orgId}`;
    expect(org.stripe_charges_enabled).toBe(true);
    expect(org.stripe_payouts_enabled).toBe(false);
    expect(org.stripe_disabled_reason).toBe("requirements.pending_verification");
    expect(org.stripe_requirements_due).toBe(1);

    const status = await connectStatus(owner, orgId);
    expect(status.connected).toBe(true);
    expect(status.charges_enabled).toBe(true);
    expect(status.payouts_enabled).toBe(false);
    expect(status.disabled_reason).toBe("requirements.pending_verification");
    expect(status.requirements_due).toBe(1);
  });
});
