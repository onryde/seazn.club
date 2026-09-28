// POST /api/billing/relay-checkout — the Phone tab's embedded Checkout for a
// match-credit pack (streaming R1, design §5.2/§5.3). DB-backed: the org, the
// competition, the division and the fixture are real rows (`streamRig`), and
// the entitlement gate runs the REAL `hasFeature` over a real
// `org_entitlement_overrides` row. Only three things are doubled —
// `requireUser` and `requireBillingOwner` (the cookie-resolved caller) and
// `createRelayCheckout` (the Stripe call). NOTHING here touches Stripe, which
// is the point: the 402 is raised BEFORE Stripe is reached, so the refusal is
// provable with no network at all.
//
// Killers for Task 8's mutant table (route surface):
//   RT1 402 before Stripe   move the `hasFeature` gate below `createRelayCheckout`
//                           → "refuses a plan without streaming.relay … and never calls Stripe"
//   RT2 body orgId pinned   `if (body.orgId !== orgId)` deleted
//                           → "refuses a body naming another organisation"
//   RT3 fixture ownership   drop `and o.id = ${orgId}` from the fixture join
//                           → "a fixture that is not this org's is 404, even unentitled"
//   RT4 org from the RESOLVER, never the body: `orgId: body.orgId` in the
//       createRelayCheckout call → "the checkout is opened for the RESOLVED org"
//   RT5 return_url shape    drop the `"fixtures"` tab argument / the stream=open pair
//                           → "the return_url reopens the Phone tab on that fixture"
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { streamRig } from "@/server/relay/__tests__/_session-rig";

const { requireUserMock, requireBillingOwnerMock, createRelayCheckoutMock, preferredCurrencyMock } =
  vi.hoisted(() => ({
    requireUserMock: vi.fn<() => Promise<{ id: string; email: string }>>(),
    requireBillingOwnerMock: vi.fn<() => Promise<{ orgId: string; subscriptionId: string }>>(),
    createRelayCheckoutMock: vi.fn(),
    preferredCurrencyMock: vi.fn(),
  }));

// Spread the real modules: the rig's usecases import from these too, and a bare
// factory would hand them `undefined` for every other export.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  requireUser: () => requireUserMock(),
}));
vi.mock("@/server/usecases/billing-manage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/billing-manage")>()),
  requireBillingOwner: () => requireBillingOwnerMock(),
}));
// The ONLY Stripe seam. Bare factory on purpose — if the route ever imports a
// second symbol from here, this test fails loudly rather than silently letting
// a real Stripe call through.
vi.mock("@/lib/relay-checkout", () => ({
  createRelayCheckout: (args: unknown) => createRelayCheckoutMock(args),
}));
// `preferredCurrency` reads `cookies()`, which throws outside a Next request
// scope — an environment limit of unit-testing a route, not a route defect.
// Doubled with a currency that is NOT the catalogue's `gbp` default, so the
// accept below witnesses a ROUTED value rather than a hard-coded one.
vi.mock("@/lib/currency-server", () => ({
  preferredCurrency: (...args: unknown[]) => preferredCurrencyMock(...args),
}));

import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/billing/relay-checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** A caller who IS the billing owner of `orgId`. */
async function callerFor(orgId: string): Promise<void> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`relay-checkout-${randomUUID().slice(0, 8)}@test.local`}, 'Relay Buyer', true)
    returning id`;
  requireUserMock.mockReset().mockResolvedValue({ id, email: "buyer@test.local" });
  requireBillingOwnerMock.mockReset().mockResolvedValue({ orgId, subscriptionId: randomUUID() });
  createRelayCheckoutMock.mockReset().mockResolvedValue({ id: "cs_rly", client_secret: "cs_rly_secret_1" });
  preferredCurrencyMock.mockReset().mockResolvedValue("eur");
}

/** The live `streaming.relay` override the REAL resolver reads. No plan grants
 *  this key while streaming is dark (V402), so an override is the only way an
 *  org is entitled — which is exactly how a community pilot is admitted. */
async function entitle(orgId: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'streaming.relay', true, 'task-8 route test')`;
}

describe.skipIf(!HAS_DB)("POST /api/billing/relay-checkout", () => {
  it("opens an embedded checkout for the RESOLVED org and returns its client_secret, with a return_url that reopens the Phone tab on that fixture", async () => {
    const rig = await streamRig();
    await entitle(rig.orgId);
    await callerFor(rig.orgId);
    const fixtureId = rig.fixtureIds[0]!;

    const res = await post({ orgId: rig.orgId, fixtureId, pack: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { client_secret: "cs_rly_secret_1" } });

    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${rig.orgId}`;
    const args = createRelayCheckoutMock.mock.calls[0]![0] as {
      orgId: string;
      fixtureId: string;
      size: number;
      returnUrl: string;
      currency?: string;
      customerEmail?: string;
      customerId?: string | null;
    };
    // RT4: the org is the RESOLVER's, not the body's — they are equal here by
    // construction, so the mismatch case below is what actually separates them.
    expect(args.orgId).toBe(rig.orgId);
    expect(args.fixtureId).toBe(fixtureId);
    expect(args.size).toBe(5);
    expect(args.customerEmail).toBe("buyer@test.local");
    // RT6: the billing entity's LOCKED currency is passed through, not the
    // builder's `gbp` default — Stripe refuses a second currency on one
    // customer, so a hard-coded one here is a rejected charge, not a cosmetic.
    expect(args.currency).toBe("eur");
    expect(preferredCurrencyMock).toHaveBeenCalledWith(rig.orgId, expect.anything());
    // No subscriptions row exists for this doubled id, so a first-ever buyer
    // has no Stripe customer yet — the email branch, not the customer branch.
    expect(args.customerId ?? null).toBeNull();
    // RT5: the whole shape, in order — the division page, the fixtures TAB, the
    // fixture, the panel open, and Stripe's own session-id placeholder (the e2e
    // reads that back). Anchored end-to-end so a dropped pair cannot hide.
    expect(args.returnUrl).toMatch(
      new RegExp(
        `^https?://[^/]+/o/${orgSlug}/c/[^/]+/d/[^/?]+\\?tab=fixtures&fixture=${fixtureId}&stream=open&checkout=success&session_id=\\{CHECKOUT_SESSION_ID\\}$`,
      ),
    );
  });

  it("refuses a plan without streaming.relay with 402 plan_lacks_relay, and never calls Stripe", async () => {
    const rig = await streamRig();
    await callerFor(rig.orgId); // deliberately NOT entitled
    const res = await post({ orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, code: "plan_lacks_relay" });
    // The whole point of the gate order: nobody pays for a tier they cannot use,
    // and the refusal costs no Stripe round-trip.
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("refuses a body naming another organisation (400), before the fixture is even looked up", async () => {
    const rig = await streamRig();
    const other = await streamRig();
    await entitle(rig.orgId);
    await callerFor(rig.orgId);
    const res = await post({ orgId: other.orgId, fixtureId: rig.fixtureIds[0]!, pack: 5 });
    expect(res.status).toBe(400);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("a fixture that is not this org's is 404, even when the org is unentitled — the ownership check precedes the paywall", async () => {
    const rig = await streamRig();
    const other = await streamRig();
    await callerFor(rig.orgId); // NOT entitled: a 402 here would mean the gates ran in the wrong order
    const res = await post({ orgId: rig.orgId, fixtureId: other.fixtureIds[0]!, pack: 5 });
    expect(res.status).toBe(404);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();

    // A fixture that exists nowhere is the same refusal, never a 500.
    const gone = await post({ orgId: rig.orgId, fixtureId: randomUUID(), pack: 5 });
    expect(gone.status).toBe(404);
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("rejects a pack size the catalogue does not sell, and any extra body key", async () => {
    const rig = await streamRig();
    await entitle(rig.orgId);
    await callerFor(rig.orgId);
    const fixtureId = rig.fixtureIds[0]!;
    // 3 is not a pack; 0 and a string are not either. `.strict()` refuses a body
    // that smuggles its own credit amount alongside a legitimate pack.
    for (const body of [
      { orgId: rig.orgId, fixtureId, pack: 3 },
      { orgId: rig.orgId, fixtureId, pack: 0 },
      { orgId: rig.orgId, fixtureId, pack: "5" },
      { orgId: rig.orgId, fixtureId, pack: 5, credits: 500 },
      { orgId: "not-a-uuid", fixtureId, pack: 5 },
    ]) {
      const res = await post(body);
      expect([res.status, JSON.stringify(body)]).toEqual([400, JSON.stringify(body)]);
    }
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });
});
