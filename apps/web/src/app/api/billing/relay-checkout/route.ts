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
 * Stripe call — the org's resolved `streaming.relay` must be true, or 402
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

    if (!(await hasFeature(orgId, "streaming.relay", fx.competition_id))) {
      throw new HttpError(402, "This plan does not include phone streaming", "plan_lacks_relay");
    }

    const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
    const tab = `${baseUrl(req)}${routes.division(fx.org_slug, fx.comp_slug, fx.div_slug, "fixtures")}&fixture=${body.fixtureId}`;
    const session = await createRelayCheckout({
      // The RESOLVED org, never `body.orgId` — they are equal by the check
      // above, and keeping the resolver's value means a future relaxation of
      // that check cannot quietly turn the body into the authority.
      orgId,
      fixtureId: body.fixtureId,
      size: body.pack,
      returnUrl: `${tab}&stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      currency: await preferredCurrency(orgId, req),
      customerId: sub?.stripe_customer_id,
      customerEmail: user.email,
    });
    return { client_secret: session.client_secret };
  });
}
