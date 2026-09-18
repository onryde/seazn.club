// Connect account creation ON THE WIRE, through the REAL Stripe SDK.
//
// stripe-connect.test.ts stubs `@/lib/stripe`, so it proves what this codebase
// PASSES and nothing about what Stripe is SENT: a param the SDK silently drops,
// a nested shape it flattens differently, or a v2 call that goes out on the v1
// path would all stay green there. This file does not mock the SDK. It points
// the real client at e2e/stripe-fixture-server (STRIPE_MOCK_HOST, set below
// before anything can call getStripe) and drives `createConnectOnboardingLink`,
// then reads the HTTP request the SDK actually made.
//
// Why that matters for THIS change specifically: `/v2/core/accounts` is a JSON
// endpoint while every other Stripe call in the app is form-encoded, and the
// SDK picks the encoding off the `/v2/` path prefix. "Did the request go to the
// v2 path, as JSON, with the nested capability tree intact" is a question only
// a real request can answer.
//
// What it cannot prove: that Stripe ACCEPTS these values. That was settled
// against the live test API (every required field here was found by an actual
// 400); the fixture returns what it is told to.

// BEFORE any import pulls in @/lib/stripe: a fake key (the fixture ignores it)
// and the host override, so getStripe() builds a client aimed at the fixture.
// The port is set from the fixture's own ephemeral bound port in beforeAll —
// never a literal, which is how three suites once collided on 12118 (#313).
process.env.STRIPE_SECRET_KEY ??= "sk_test_fixture_never_real";
process.env.STRIPE_MOCK_HOST = "127.0.0.1";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  CONNECT_ACCOUNT_DEFAULT_COUNTRY,
  createConnectOnboardingLink,
} from "@/server/usecases/stripe-connect";
import {
  startStripeFixtureServer,
  type StripeFixtureServer,
} from "../../../../e2e/stripe-fixture-server";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

let fixture: StripeFixtureServer;

interface Seeded {
  owner: AuthCtx;
  orgId: string;
  orgName: string;
  ownerEmail: string;
}

async function seedProOrg(): Promise<Seeded> {
  const s = uniq();
  const ownerEmail = `wire-${s}@test.local`;
  const orgName = `Wire Org ${s}`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${ownerEmail}, 'Wire Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${orgName}, ${"wire-org-" + s}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await setOrgPlan(orgId);
  return {
    owner: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null },
    orgId,
    orgName,
    ownerEmail,
  };
}

/** The account-create request the SDK actually put on the wire. */
function createCall(): { method: string; path: string; body: Record<string, unknown> } {
  const call = fixture.calls.find((c) => c.method === "POST" && c.path === "/v2/core/accounts");
  if (!call) {
    throw new Error(
      `no POST /v2/core/accounts on the wire; saw: ${fixture.calls
        .map((c) => `${c.method} ${c.path}`)
        .join(", ")}`,
    );
  }
  return call;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  fixture = await startStripeFixtureServer();
  process.env.STRIPE_MOCK_PORT = String(fixture.port);
});
beforeEach(() => fixture?.reset());
afterAll(async () => {
  await fixture?.close();
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Connect onboarding against the real SDK + Stripe fixture", () => {
  it("puts the account create on the ACCOUNTS V2 path, and nothing on the v1 one", async () => {
    const { owner, orgId } = await seedProOrg();
    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect", true);

    expect(createCall().path).toBe("/v2/core/accounts");
    // The regression half. `stripe.accounts.create(…)` would show up here as
    // POST /v1/accounts, and every stubbed-SDK assertion in the sibling suite
    // could be satisfied by a v1 call wearing v2 param names.
    expect(fixture.calls.filter((c) => c.path === "/v1/accounts")).toHaveLength(0);
  });

  it("sends the full v2 field set, nested, with the values Stripe requires", async () => {
    const { owner, orgId, orgName, ownerEmail } = await seedProOrg();
    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect", true);
    const body = createCall().body as {
      dashboard?: string;
      contact_email?: string;
      display_name?: string;
      identity?: { country?: string };
      configuration?: {
        merchant?: { capabilities?: { card_payments?: { requested?: boolean } } };
        recipient?: {
          capabilities?: { stripe_balance?: { stripe_transfers?: { requested?: boolean } } };
        };
      };
      defaults?: { currency?: string; responsibilities?: Record<string, string> };
      metadata?: Record<string, string>;
    };

    expect(body.dashboard).toBe("express");
    expect(body.contact_email).toBe(ownerEmail);
    expect(body.display_name).toBe(orgName);
    expect(body.identity?.country).toBe(CONNECT_ACCOUNT_DEFAULT_COUNTRY);
    // The nested capability tree survived JSON encoding on both halves —
    // merchant is what eventually lights `charges_enabled`, recipient is v1's
    // `transfers` and is what a destination charge lands through.
    expect(body.configuration?.merchant?.capabilities?.card_payments?.requested).toBe(true);
    expect(
      body.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.requested,
    ).toBe(true);
    expect(body.defaults?.responsibilities?.fees_collector).toBe("application");
    expect(body.defaults?.responsibilities?.losses_collector).toBe("application");
    // Absent on the WIRE, not merely absent from the params object: nothing in
    // the SDK gets to fill a settlement currency in on our behalf.
    expect(body.defaults).not.toHaveProperty("currency");
    // The ToS acceptance has no DB column — losing it on the wire loses the
    // only record that the club agreed to the chargeback clause.
    expect(body.metadata?.org_id).toBe(orgId);
    expect(new Date(String(body.metadata?.tos_agreed_at)).getTime()).not.toBeNaN();
  });

  it("mints the onboarding link through Account Links V1, against the v2 account id", async () => {
    const { owner, orgId } = await seedProOrg();
    const { url } = await createConnectOnboardingLink(
      owner,
      orgId,
      "http://test.local",
      "/settings/connect",
      true,
    );

    const [stored] = await sql<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from organizations where id = ${orgId}`;
    expect(stored.stripe_account_id).toMatch(/^acct_fixv2_/);

    const link = fixture.calls.find((c) => c.method === "POST" && c.path === "/v1/account_links");
    expect(link, "onboarding links stay on the v1 endpoint — it accepts a v2 id").toBeDefined();
    // Form-encoded, because v1 — the one place both encodings meet in one flow.
    expect(link?.body.account).toBe(stored.stripe_account_id);
    expect(link?.body.type).toBe("account_onboarding");
    expect(url).toBe("https://connect.stripe.test/fixture-onboarding");
  });

  it("does not create a SECOND account when an org reconnects", async () => {
    const { owner, orgId } = await seedProOrg();
    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect", true);
    const first = createCall();
    fixture.reset();

    await createConnectOnboardingLink(owner, orgId, "http://test.local", "/settings/connect");
    expect(fixture.calls.filter((c) => c.path === "/v2/core/accounts")).toHaveLength(0);
    // …and the resume still mints a link, so this is an idempotent create and
    // not a dead second call (an "already connected" early return that also
    // skipped the link would satisfy the line above and be broken).
    expect(
      fixture.calls.filter((c) => c.method === "POST" && c.path === "/v1/account_links"),
    ).toHaveLength(1);
    expect(first.path).toBe("/v2/core/accounts");
  });
});
