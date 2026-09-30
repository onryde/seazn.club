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
//   RT5 return_url shape    `fx.fixture_no` → `1`, or the stream=open pair dropped (spec 2026-09-30 §2: the FIXTURE page)
//                           → "…with a return_url that reopens the Phone tab on that fixture's own page…"
//   RT7 disabled drivers    the `relayDrivers().disabled` gate deleted (Task 14b review I2)
//                           → "I2: refuses with 503 ingest_unavailable while the relay drivers are DISABLED"
//   RT8 the gate constructs  `relayUnavailable()` → `relayDrivers().disabled` (Task 14b re-review N1)
//                           → "m1: a LIVE deployment missing a Cloudflare secret refuses with 503…" (the 500 it throws)
//   RT9 m1 secret check      `relayUnavailable()` reverted to the mode alone (lane-close review m1)
//                           → "m1: a LIVE deployment missing a Cloudflare secret refuses with 503…"
//   RT10 m5 overlay key      the `streaming.overlay` gate deleted (lane-close review m5)
//                           → "m5: refuses an org whose streaming.overlay is switched OFF…"
//   RT11 drift refusal       the `instanceof StreamPackPriceDriftError` branch deleted (parked c)
//                           → "the drift guard's refusal is a 502 checkout_unavailable, answered WITHOUT a second report…"
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
vi.mock("@/lib/relay-checkout", async (importOriginal) => ({
  createRelayCheckout: (args: unknown) => createRelayCheckoutMock(args),
  // Parked (c): the drift guard's typed refusal, which the route answers — the real class, so `instanceof` is honest.
  StreamPackPriceDriftError: (await importOriginal<typeof import("@/lib/relay-checkout")>()).StreamPackPriceDriftError,
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
import { routes } from "@/lib/routes";

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
  it("opens an embedded checkout for the RESOLVED org and returns its client_secret, with a return_url that reopens the Phone tab on that fixture's own page — for a community org entitled by its PLAN alone (V426: no override row)", async () => {
    const rig = await streamRig();
    // No `entitle`: V426 grants streaming.relay on every plan, and the rig's org has no subscription (community).
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_entitlement_overrides where org_id = ${rig.orgId}`;
    expect(n, "premise: no override row — the plan is what admits this org").toBe(0);
    await callerFor(rig.orgId);
    const fixtureId = rig.fixtureIds[0]!;
    // Spec 2026-09-30 §2: the return lands on the fixture page, addressed by its per-division ordinal. A number other
    // than 1, so a hard-coded `/f/1` cannot pass.
    await sql`update fixtures set fixture_no = 14 where id = ${fixtureId}`;

    const res = await post({ orgId: rig.orgId, fixtureId, pack: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { client_secret: "cs_rly_secret_1" } });

    const [scene] = await sql<{ orgSlug: string; compSlug: string; divSlug: string; fixtureNo: number }[]>`
      select o.slug as "orgSlug", c.slug as "compSlug", d.slug as "divSlug", f.fixture_no as "fixtureNo"
        from fixtures f
        join divisions d on d.id = f.division_id
        join competitions c on c.id = d.competition_id
        join organizations o on o.id = c.org_id
       where f.id = ${fixtureId}`;
    expect(scene!.fixtureNo, "premise: the fixture's ordinal is not 1").toBe(14);
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
    // RT5: the whole shape, in order — the organiser FIXTURE page (spec 2026-09-30 §2, the panel's new home), the panel
    // open, and Stripe's own session-id placeholder (the e2e reads that back). Built from `routes.fixture` and the rows'
    // own slugs, and anchored end-to-end so a dropped pair cannot hide.
    const base = new URL(args.returnUrl).origin;
    expect(args.returnUrl).toBe(
      `${base}${routes.fixture(scene!.orgSlug, scene!.compSlug, scene!.divSlug, scene!.fixtureNo)}?stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    );
    expect(args.returnUrl, "no longer the division's fixtures tab").not.toContain("tab=fixtures");
    expect(args.returnUrl, "the page IS the fixture — no fixture param").not.toContain("fixture=");
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

  // m5 (lane-close review): createSession admits only with BOTH keys (admit: no overlay → 402 on streaming.overlay,
  // whatever the relay says), so a pack sold to an org whose overlay is off is a credit nothing can spend. The checkout
  // asks the same two keys, overlay first, as admit does.
  it("m5: refuses an org whose streaming.overlay is switched OFF with 402 plan_lacks_overlay — with the relay on or off — and never calls Stripe; the relay's own refusal is unchanged", async () => {
    const cases: { name: string; overlay: boolean; relay: boolean; status: number; code?: string }[] = [
      { name: "overlay off, relay on", overlay: false, relay: true, status: 402, code: "plan_lacks_overlay" },
      { name: "both off (overlay first, as admit orders them)", overlay: false, relay: false, status: 402, code: "plan_lacks_overlay" },
      { name: "overlay on, relay off", overlay: true, relay: false, status: 402, code: "plan_lacks_relay" },
      { name: "both on", overlay: true, relay: true, status: 200 },
    ];
    let checked = 0;
    for (const c of cases) {
      const rig = await streamRig();
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${rig.orgId}, 'streaming.overlay', ${c.overlay}, 'm5 route test'), (${rig.orgId}, 'streaming.relay', ${c.relay}, 'm5 route test')`;
      await callerFor(rig.orgId);
      const res = await post({ orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 });
      expect(res.status, c.name).toBe(c.status);
      if (c.code) {
        expect(await res.json(), c.name).toMatchObject({ ok: false, code: c.code });
        expect(createRelayCheckoutMock, c.name).not.toHaveBeenCalled();
      } else {
        expect(createRelayCheckoutMock, c.name).toHaveBeenCalledTimes(1);
      }
      checked++;
    }
    expect(checked).toBe(cases.length);
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

  it("m1: a LIVE deployment missing a Cloudflare secret refuses with 503 ingest_unavailable and never calls Stripe — each secret alone; with both it sells", async () => {
    // N1: answered by constructing the drivers, this was a 500 from `new CloudflareIngest()` on every checkout. m1: nor may
    // it SELL — every start on such a deployment fails (the drivers cannot be built), so a pack bought there is money for
    // a credit nothing can spend. The same 503 a disabled deployment answers, before any Stripe call.
    const rig = await streamRig();
    await callerFor(rig.orgId);
    const body = { orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 1 };
    const cases = [
      { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "tok", sells: false },
      { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "", sells: false },
      { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "", sells: false },
      { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "tok", sells: true },
    ];
    let checked = 0;
    try {
      for (const c of cases) {
        vi.unstubAllEnvs();
        vi.stubEnv("RELAY_DRIVERS", "live");
        vi.stubEnv("ENV_NAME", "prod");
        vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", c.CLOUDFLARE_ACCOUNT_ID);
        vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", c.CLOUDFLARE_STREAM_TOKEN);
        setRelayDriversForTest(null);
        createRelayCheckoutMock.mockClear();
        const label = JSON.stringify(c);
        // The premise, from the real constructor: it refuses exactly where the route must.
        let builds = true;
        try { relayDrivers(); } catch { builds = false; }
        setRelayDriversForTest(null);
        expect(builds, `${label}: premise`).toBe(c.sells);
        const res = await post(body);
        if (c.sells) {
          expect(res.status, label).toBe(200);
          expect(createRelayCheckoutMock, label).toHaveBeenCalledTimes(1);
        } else {
          expect(res.status, label).toBe(503);
          expect(await res.json(), label).toMatchObject({ ok: false, code: "ingest_unavailable" });
          expect(createRelayCheckoutMock, label).not.toHaveBeenCalled();
        }
        checked++;
      }
    } finally {
      vi.unstubAllEnvs();
      setRelayDriversForTest(null);
    }
    expect(checked).toBe(cases.length);
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

  // Parked (c): the PROD drift guard (lib/relay-checkout.ts resolveStreamPackPriceId) refuses a pack whose live price
  // differs from the table, and reports it ONCE itself. The route answers the typed refusal with the Phone tab's
  // "Checkout didn't open" code — and does not report it again on every tap, which `handler` would do for any thrown
  // HttpError ≥ 500.
  it("the drift guard's refusal is a 502 checkout_unavailable, answered WITHOUT a second report per tap", async () => {
    const { StreamPackPriceDriftError } = await import("@/lib/relay-checkout");
    const { log } = await import("@/server/logger");
    const rig = await streamRig();
    await callerFor(rig.orgId);
    captureErrorMock.mockReset();
    // `handler`'s own report of an HttpError ≥ 500 (Sentry.captureException beside this log line, lib/http.ts).
    const logged: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation(((_o: unknown, msg?: string) => { logged.push(String(msg)); }) as never);
    let checked = 0;
    try {
      for (let i = 0; i < 2; i++) {
        createRelayCheckoutMock.mockRejectedValueOnce(new StreamPackPriceDriftError("seazn_stream_pack_5", "price_drifted", "eur: live 1, table 2925"));
        const res = await post({ orgId: rig.orgId, fixtureId: rig.fixtureIds[0]!, pack: 5 });
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ ok: false, code: "checkout_unavailable" });
        checked++;
      }
    } finally {
      spy.mockRestore();
    }
    expect(checked).toBe(2);
    expect(captureErrorMock, "reported by the guard once, never by the route per tap").not.toHaveBeenCalled();
    expect(logged.filter((m) => m.includes("HttpError reached 500")), "handler re-reported the typed refusal").toEqual([]);
  });
});
