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
//   RT7 disabled drivers    the `relayDrivers().disabled` gate deleted (Task 14b review I2)
//                           → "I2: refuses with 503 ingest_unavailable while the relay drivers are DISABLED"
//   RT8 the gate constructs  `relayIsDisabled()` → `relayDrivers().disabled` (Task 14b re-review N1)
//                           → "N1: a LIVE deployment missing its Cloudflare secret still sells"
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { disabledRelayDrivers, relayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";

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

// B5 (Task 14 fix round 1): a Stripe request error is REPORTED here, once, with context — and answered as a typed 502.
const { captureErrorMock } = vi.hoisted(() => ({ captureErrorMock: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: (...args: unknown[]) => captureErrorMock(...args) }));

import { POST } from "../route";
import { HttpError } from "@/lib/errors";

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

/** A live `streaming.relay` override set to TRUE — a staff lift. Since V426 (Task 14b) every plan grants the key, so
 *  this is belt-and-braces for the cases that are not about the gate; the first case below proves the PLAN alone
 *  admits a community org. */
async function entitle(orgId: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'streaming.relay', true, 'task-8 route test')`;
}

/** A live `streaming.relay` override set to FALSE — since V426 the ONLY way an org lacks the relay (every plan grants
 *  it), and so the only way this route's 402 is reachable. */
async function deny(orgId: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'streaming.relay', false, 'task-14b route test: staff switch-off')`;
}

describe.skipIf(!HAS_DB)("POST /api/billing/relay-checkout", () => {
  it("opens an embedded checkout for the RESOLVED org and returns its client_secret, with a return_url that reopens the Phone tab on that fixture — for a community org entitled by its PLAN alone (V426: no override row)", async () => {
    const rig = await streamRig();
    // No `entitle`: V426 grants streaming.relay on every plan, and the rig's org has no subscription (community).
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_entitlement_overrides where org_id = ${rig.orgId}`;
    expect(n, "premise: no override row — the plan is what admits this org").toBe(0);
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

  it("refuses an org whose streaming.relay is switched OFF by an override with 402 plan_lacks_relay, and never calls Stripe (V426: the only way the gate is reachable)", async () => {
    const rig = await streamRig();
    await deny(rig.orgId); // every plan grants it now, so the refusal needs a staff switch-off
    await callerFor(rig.orgId);
    const res = await post({ orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, code: "plan_lacks_relay" });
    // The whole point of the gate order: nobody pays for a tier they cannot use,
    // and the refusal costs no Stripe round-trip.
    expect(createRelayCheckoutMock).not.toHaveBeenCalled();
  });

  it("I2: refuses with 503 ingest_unavailable while the relay drivers are DISABLED — before the entitlement read and any Stripe call; the same org buys once they are back", async () => {
    // R5: a production process with RELAY_DRIVERS unset runs the disabled pair and refuses every start (createSession's
    // 503). Selling a pack meanwhile takes real money for a credit nothing can spend.
    const rig = await streamRig();
    await callerFor(rig.orgId);
    const body = { orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 };
    setRelayDriversForTest(disabledRelayDrivers());
    try {
      const res = await post(body);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, code: "ingest_unavailable" });
      expect(createRelayCheckoutMock).not.toHaveBeenCalled();
    } finally {
      setRelayDriversForTest(null);
    }
    // The positive pair: the same caller, the same body, on the default (fake) drivers.
    expect((await post(body)).status).toBe(200);
    expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);
  });

  it("N1: a LIVE deployment missing its Cloudflare secret still sells — the disabled check never constructs the drivers", async () => {
    // The route asks "is the relay off?" before anything else. Answered by constructing the drivers, a live deploy
    // without CLOUDFLARE_* answered every checkout with a 500 from `new CloudflareIngest()`.
    const rig = await streamRig();
    await callerFor(rig.orgId);
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "");
    setRelayDriversForTest(null);
    try {
      expect(() => relayDrivers(), "premise: constructing the drivers here throws").toThrow(/CLOUDFLARE_ACCOUNT_ID/);
      expect((await post({ orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 })).status).toBe(200);
      expect(createRelayCheckoutMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      setRelayDriversForTest(null);
    }
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
    await deny(rig.orgId); // switched OFF: a 402 here would mean the gates ran in the wrong order
    await callerFor(rig.orgId);
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

  // B5 — the browser pass met this for real: a sandbox account with no head-office address refuses automatic tax, and
  // Stripe's 400 surfaced as an UNHANDLED 500 in the log. A Stripe request error is an outcome of THIS route, not a
  // crash: reported once with the org and Stripe's own ids, answered 502 with a code, which the Phone tab already reads
  // as "Checkout didn't open. Try again." Scoped both ways — the route's own typed refusals and a genuine bug keep
  // their paths.
  it("a Stripe request error is a handled 502 checkout_unavailable, reported once with context — never an unhandled 500", async () => {
    const rig = await streamRig();
    await entitle(rig.orgId);
    await callerFor(rig.orgId);
    const fixtureId = rig.fixtureIds[0]!;
    captureErrorMock.mockReset();
    let checked = 0;
    for (const type of ["StripeInvalidRequestError", "StripeAPIError", "StripeConnectionError", "StripeRateLimitError"]) {
      const stripeErr = Object.assign(new Error("Your head office address is required for automatic tax."), {
        type, code: "parameter_missing", requestId: `req_${type}`, statusCode: 400,
      });
      createRelayCheckoutMock.mockRejectedValueOnce(stripeErr);
      const res = await post({ orgId: rig.orgId, fixtureId, pack: 5 });
      expect([type, res.status]).toEqual([type, 502]);
      expect(await res.json()).toMatchObject({ ok: false, code: "checkout_unavailable" });
      expect(captureErrorMock).toHaveBeenLastCalledWith(
        stripeErr,
        expect.objectContaining({ orgId: rig.orgId, route: "billing/relay-checkout", extra: expect.objectContaining({ stripeType: type, stripeRequestId: `req_${type}` }) }),
      );
      checked++;
    }
    expect(checked).toBe(4);
    expect(captureErrorMock).toHaveBeenCalledTimes(4);

    // The route's OWN typed refusal (an account the pack prices were never synced to) keeps its status and is not
    // re-reported as a Stripe failure.
    captureErrorMock.mockReset();
    createRelayCheckoutMock.mockRejectedValueOnce(new HttpError(503, "Billing is not yet configured. Please contact support."));
    expect((await post({ orgId: rig.orgId, fixtureId, pack: 5 })).status).toBe(503);
    // …and a genuine bug is still the unhandled 500 it is, not laundered into "try again".
    createRelayCheckoutMock.mockRejectedValueOnce(new TypeError("cannot read properties of undefined"));
    expect((await post({ orgId: rig.orgId, fixtureId, pack: 5 })).status).toBe(500);
    // A `type` field alone is not Stripe's: node-fetch's FetchError carries `type: "system"`, and it is not a
    // Stripe answer to this request.
    createRelayCheckoutMock.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { type: "system" }));
    expect((await post({ orgId: rig.orgId, fixtureId, pack: 5 })).status).toBe(500);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
