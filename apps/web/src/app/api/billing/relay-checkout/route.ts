import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { hasFeature } from "@/lib/entitlements";
import { createRelayCheckout } from "@/lib/relay-checkout";
import { preferredCurrency } from "@/lib/currency-server";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { routes } from "@/lib/routes";
import { NextResponse } from "next/server";
import { captureError } from "@/lib/sentry";
import { relayIsDisabled } from "@/server/relay/drivers";
import { log } from "@/server/logger";

/** Every error the Stripe SDK raises for a request carries a `type` of `Stripe…Error` (invalid request, API, connection,
 *  rate limit, authentication, permission, idempotency). Read by shape, as billing-manage.ts reads it — a genuine bug
 *  (a TypeError) or this route's own HttpError is NOT one. */
function stripeRequestError(err: unknown): { type: string; code?: string; requestId?: string; statusCode?: number } | null {
  const e = err as { type?: unknown; code?: unknown; requestId?: unknown; statusCode?: unknown } | null;
  if (!e || typeof e.type !== "string" || !e.type.startsWith("Stripe")) return null;
  return {
    type: e.type,
    code: typeof e.code === "string" ? e.code : undefined,
    requestId: typeof e.requestId === "string" ? e.requestId : undefined,
    statusCode: typeof e.statusCode === "number" ? e.statusCode : undefined,
  };
}

const schema = z
  .object({
    orgId: z.string().uuid(),
    fixtureId: z.string().uuid(),
    pack: z.union([z.literal(1), z.literal(5), z.literal(20)]),
  })
  .strict();

/**
 * POST /api/billing/relay-checkout — an EMBEDDED one-time Checkout Session for
 * a match-credit pack (streaming R1, design §5.2 / §5.3; owner 2026-09-14:
 * "inbuilt as other"). Returns `{ client_secret }` exactly as
 * credit-pack-checkout/route.ts does; `return_url` is the division fixtures
 * tab with `?tab=fixtures&fixture=<id>&stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`.
 *
 * Gate order, and why (P7, recorded at Task 0): `requireBillingOwner` — the
 * Stripe customer, the locked currency and the payer's card belong to the
 * BILLING GROUP, exactly as credit-pack-checkout/route.ts reasons. The body's
 * `orgId` must EQUAL the resolved org (400): the resolver reads a cookie, and
 * a stale one must not buy credits for a different organisation. Then the
 * fixture must be that org's (404, never "forbidden"). Then — BEFORE any
 * Stripe call — the deployment must have a relay at all (503
 * `ingest_unavailable`, Task 14b review I2), and the org's resolved
 * `streaming.relay` must be true, or 402
 * `plan_lacks_relay`: nobody pays for a tier they cannot use. Never a redirect
 * (R8): JSON with the secret.
 *
 * The 402 carries a `code` and NO `extra`: `lib/http.ts`'s generic `HttpError`
 * branch forwards `code` and DROPS `extra` — only its `PaymentRequiredError`
 * branch forwards `extra` — so a `{ featureKey }` argument here would be dead
 * weight that reads as a contract. The client's `CheckoutSecretResult` has no
 * `code` field either, so the buyer-facing surface keys on `status === 402`;
 * the code is for logs and for any future non-browser caller.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { orgId, subscriptionId } = await requireBillingOwner();
    const body = schema.parse(await req.json());
    if (body.orgId !== orgId) throw new HttpError(400, "orgId does not match the billing organisation");

    const [fx] = await sql<{ competition_id: string; org_slug: string; comp_slug: string; div_slug: string }[]>`
      select c.id as competition_id, o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
        from fixtures f
        join divisions d on d.id = f.division_id
        join competitions c on c.id = d.competition_id
        join organizations o on o.id = c.org_id
       where f.id = ${body.fixtureId} and o.id = ${orgId}`;
    if (!fx) throw new HttpError(404, "fixture not found");

    // I2 (Task 14b review): a deployment with no relay (R5 — RELAY_DRIVERS unset in production, drivers.ts
    // `disabledRelayDrivers`) refuses every start with this same 503, so a pack sold meanwhile is real money for a
    // credit nothing can spend. Refused BEFORE the entitlement read and any Stripe call, with the code the Phone tab
    // already reads ("The streaming service is unavailable"). After the ownership checks: a fixture that is not this
    // org's stays 404 whatever the deployment.
    if (relayIsDisabled()) {
      throw new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
    }

    if (!(await hasFeature(orgId, "streaming.relay", fx.competition_id))) {
      throw new HttpError(402, "This plan does not include phone streaming", "plan_lacks_relay");
    }

    const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
    const tab = `${baseUrl(req)}${routes.division(fx.org_slug, fx.comp_slug, fx.div_slug, "fixtures")}&fixture=${body.fixtureId}`;
    const currency = await preferredCurrency(orgId, req);
    let session: Awaited<ReturnType<typeof createRelayCheckout>>;
    try {
      session = await createRelayCheckout({
        // The RESOLVED org, never `body.orgId` — they are equal by the check
        // above, and keeping the resolver's value means a future relaxation of
        // that check cannot quietly turn the body into the authority.
        orgId,
        fixtureId: body.fixtureId,
        size: body.pack,
        returnUrl: `${tab}&stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        currency,
        customerId: sub?.stripe_customer_id,
        customerEmail: user.email,
      });
    } catch (err) {
      // B5 (Task 14 fix round 1): Stripe refusing to open the session — an account missing its tax head-office
      // address answers 400, an outage 5xx, a timeout a connection error — is an OUTCOME here, not a crash. Reported
      // ONCE, with the org and Stripe's own ids, and answered 502 with a code the Phone tab already reads as "Checkout
      // didn't open. Try again." Returned rather than thrown: `handler` captures every HttpError ≥ 500 itself, which
      // would report the same failure twice. This route's own typed refusals (the 503 for unsynced pack prices) and a
      // genuine bug keep their paths.
      const stripe = stripeRequestError(err);
      if (!stripe) throw err;
      captureError(err, {
        userId: user.id,
        orgId,
        route: "billing/relay-checkout",
        extra: { stripeType: stripe.type, stripeCode: stripe.code, stripeRequestId: stripe.requestId, stripeStatus: stripe.statusCode, pack: body.pack },
      });
      log.error({ orgId, stripeType: stripe.type, stripeCode: stripe.code, stripeRequestId: stripe.requestId }, "relay-checkout: Stripe refused to open the session");
      return NextResponse.json(
        { ok: false, error: "Checkout could not be opened. Please try again.", code: "checkout_unavailable" },
        { status: 502 },
      );
    }
    return { client_secret: session.client_secret };
  });
}
