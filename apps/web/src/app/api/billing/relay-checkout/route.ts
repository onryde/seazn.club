import { z } from "zod";
import { getOrgRole, requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { baseUrl } from "@/lib/oauth";
import { hasFeature } from "@/lib/entitlements";
import { createRelayCheckout, StreamPackPriceDriftError } from "@/lib/relay-checkout";
import { preferredCurrency } from "@/lib/currency-server";
import { requireBillingOwner } from "@/server/usecases/billing-manage";
import { routes } from "@/lib/routes";
import { isEditorRole } from "@/lib/types";
import { OnlineSizeS } from "@/server/api-v1/schemas/online-package";
import { onlineChessDisabled, onlineChessOffered } from "@/server/usecases/external-play/online-chess-flag";
import { NextResponse } from "next/server";
import { captureError } from "@/lib/sentry";
import { relayUnavailable } from "@/server/relay/drivers";
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

const pack = z.union([z.literal(1), z.literal(5), z.literal(20)]);
/** Exactly ONE return is named, by the body's own shape: a fixture (the Stream panel on that fixture's page — Stripe
 *  returns the buyer there), `returnTo: "settings"` (Settings → Credits → Streaming, which has no fixture) or
 *  `returnTo: "division"` (an Online Chess division's own page, the receipt reopened — spec 2026-11-23 §7.6, §8.4). Three
 *  strict objects in a union, so a body that names two — or none — matches none and is a 400: the route never has to
 *  pick which return the buyer meant. `size` exists on the division arm alone and only from the ladder: it is an
 *  upgrade's target riding in the return address (§8.4), never a price, and never a free-text value in a URL. `cameras` is the
 *  same kind of rider: the literal `true` only, the intent "this purchase was for the camera of a paid package", so the return can
 *  reopen that receipt (a camera add is quoted AT the paid size, which names nothing to pay on its own). */
const schema = z.union([
  z.object({ orgId: z.string().uuid(), fixtureId: z.string().uuid(), pack }).strict(),
  z.object({ orgId: z.string().uuid(), pack, returnTo: z.literal("settings") }).strict(),
  z.object({ orgId: z.string().uuid(), pack, returnTo: z.literal("division"), divisionId: z.string().uuid(), size: OnlineSizeS.optional(), cameras: z.literal(true).optional() }).strict(),
]);

/** Why this org cannot buy a pack for PHONE STREAMING, or null when it can: the refusal the route answers with unless Online
 *  Chess is offered (the credits are one pool). Returned, not thrown, so the caller decides; order is the old route's.
 *
 *  I2 (Task 14b review): a deployment with no relay (R5 — RELAY_DRIVERS unset in production, drivers.ts `disabledRelayDrivers`)
 *  refuses every start with a 503, so a pack sold meanwhile is real money for a credit nothing can spend — and so (m1) does a LIVE
 *  one missing a Cloudflare secret, whose drivers cannot be built. The code is the one the Phone tab already reads ("The streaming
 *  service is unavailable"). Refused BEFORE the entitlement read and any Stripe call, after the ownership checks: a fixture that
 *  is not this org's stays 404 whatever the deployment.
 *
 *  m5 (lane-close review): the same TWO keys createSession admits on, in admit's order — without the overlay no start is admitted
 *  whatever the relay says, so a pack sold then is a credit nothing can spend. */
async function refuseStreaming(orgId: string, competitionId: string | undefined): Promise<HttpError | null> {
  if (relayUnavailable()) return new HttpError(503, "the streaming ingest is unavailable", "ingest_unavailable");
  const [overlay, relay] = await Promise.all([
    hasFeature(orgId, "streaming.overlay", competitionId),
    hasFeature(orgId, "streaming.relay", competitionId),
  ]);
  if (!overlay) return new HttpError(402, "The stream overlay is switched off for this organisation", "plan_lacks_overlay");
  if (!relay) return new HttpError(402, "Phone streaming is switched off for this organisation", "plan_lacks_relay");
  return null;
}

/**
 * POST /api/billing/relay-checkout — an EMBEDDED one-time Checkout Session for
 * a match-credit pack (streaming R1, design §5.2 / §5.3; owner 2026-09-14:
 * "inbuilt as other"). Returns `{ client_secret }` exactly as
 * credit-pack-checkout/route.ts does. `return_url` depends on where the buyer started: the organiser FIXTURE page
 * (spec 2026-09-30 §2) with `?stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}` for a fixture purchase, or
 * Settings → Credits → Streaming (`?kind=stream&checkout=success&session_id={CHECKOUT_SESSION_ID}`) for a body that
 * names `returnTo: "settings"` instead of a fixture, or the DIVISION page (`?tab=fixtures&oc=pay&checkout=success&session_id=
 * {CHECKOUT_SESSION_ID}`, plus `&size=` when the buyer was upgrading) for `returnTo: "division"` — Online Chess pays for a
 * division with the same Seazn credits (spec 2026-11-23 §7.6), so a division is a place a pack is bought FROM. The page reopens the
 * receipt and reconciles the session before it reads the balance.
 *
 * Gate order, and why (P7, recorded at Task 0): `requireBillingOwner` — the
 * Stripe customer, the locked currency and the payer's card belong to the
 * BILLING GROUP, exactly as credit-pack-checkout/route.ts reasons. The body's
 * `orgId` must EQUAL the resolved org (400): the resolver reads a cookie, and
 * a stale one must not buy credits for a different organisation. Then, for a
 * fixture purchase, the fixture must be that org's (404, never "forbidden");
 * a Settings purchase has no fixture and its entitlements resolve for the org; a division purchase is behind the Online Chess
 * flag (403 ONLINE_CHESS_DISABLED, asked first, whatever streaming says), then for an ORGANISER of the division's org only (403 —
 * owner or admin, the people who may pay a package), and the division must be that org's (404). Then — BEFORE any
 * Stripe call — the deployment must have a relay at all (503
 * `ingest_unavailable`, Task 14b review I2), and the org's resolved
 * `streaming.overlay` and `streaming.relay` must both be true — the two keys
 * createSession admits on, in its order (m5) — or 402 `plan_lacks_overlay` /
 * `plan_lacks_relay`: nobody pays for a tier they cannot use. UNLESS Online Chess is offered to the org (spec §7.6): the credits
 * are one pool, and a club that plays chess online and does not stream still spends them. The flag is asked only once
 * streaming has refused, so a club that streams never costs a PostHog call here. Never a redirect
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

    // Where the buyer lands afterwards, and which competition's entitlements the gates below read. A fixture purchase
    // is scoped to its competition (an Event Pass grants for the competition it was bought for); a Settings purchase has
    // none, so it resolves for the org — the way the Streaming page does.
    let competitionId: string | undefined;
    let fixtureId: string | undefined;
    let landing: string;
    // Set once the Online Chess flag has been asked and answered yes on this request (the division arm's own gate), so the streaming
    // gates below do not ask the same remote question twice.
    let chessOffered = false;
    if ("fixtureId" in body) {
      const [fx] = await sql<{ competition_id: string; org_slug: string; comp_slug: string; div_slug: string; fixture_no: number }[]>`
        select c.id as competition_id, o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug, f.fixture_no
          from fixtures f
          join divisions d on d.id = f.division_id
          join competitions c on c.id = d.competition_id
          join organizations o on o.id = c.org_id
         where f.id = ${body.fixtureId} and o.id = ${orgId}`;
      if (!fx) throw new HttpError(404, "fixture not found");
      competitionId = fx.competition_id;
      fixtureId = body.fixtureId;
      // Spec 2026-09-30 §2: the panel lives on the fixture page now, so the pack checkout returns THERE. `stream=open`
      // opens the Stream panel on its Phone tab; the fixture page reconciles `session_id` before reading the balance.
      landing = `${routes.fixture(fx.org_slug, fx.comp_slug, fx.div_slug, fx.fixture_no)}?stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    } else if (body.returnTo === "division") {
      // The division return is a NEW door and belongs to Online Chess (§7.6): behind the same flag as every other start gate (403
      // ONLINE_CHESS_DISABLED), asked FIRST and whatever streaming says — a club that streams but is not offered Online Chess has
      // no package to pay for from a division, and the return page it names would not offer one.
      if (!(await onlineChessOffered({ orgId, userId: user.id }))) throw onlineChessDisabled();
      chessOffered = true;
      // An organiser pays for a division's package (§7.6): the same role the pay door asks (`isEditorRole`, usecases/online-package/
      // pay.ts), read for the RESOLVED org. A member who only views, and a billing payer who is no member of the org, are refused
      // before the division is even looked up.
      if (!isEditorRole(await getOrgRole(orgId, user.id))) {
        throw new HttpError(403, "Only an owner or admin can buy credits for an Online Chess division");
      }
      // The org in the WHERE is the ownership check (404, never "forbidden"): a division id of another organisation, or one that
      // does not exist, is the same answer. The slugs come from the row, never the body, so the return can only land on this
      // org's own division page.
      const [dv] = await sql<{ competition_id: string; org_slug: string; comp_slug: string; div_slug: string }[]>`
        select c.id as competition_id, o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
          from divisions d
          join competitions c on c.id = d.competition_id
          join organizations o on o.id = c.org_id
         where d.id = ${body.divisionId} and o.id = ${orgId}`;
      if (!dv) throw new HttpError(404, "division not found");
      competitionId = dv.competition_id;
      // `oc=pay` reopens the receipt; `size` (an upgrade's target, from the ladder) rides next, then `cameras=1` (the camera intent) last. The division page reconciles
      // `session_id` before it reads the balance.
      landing = `${routes.division(dv.org_slug, dv.comp_slug, dv.div_slug, "fixtures")}&oc=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}${body.size !== undefined ? `&size=${body.size}` : ""}${body.cameras === true ? "&cameras=1" : ""}`;
    } else {
      // The slug of the RESOLVED org (`orgId`, equal to the body's by the check above — never the body's own), so the
      // return can only ever land on the buyer's own Credits tab. The tab reconciles `session_id` before it reads.
      const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${orgId}`;
      if (!org) throw new HttpError(404, "organisation not found");
      landing = `${routes.creditsStream(org.slug)}&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    }

    // The streaming gates, in order. Each is a refusal the buyer's Phone tab already reads; none is final while Online Chess is
    // offered to the org (spec 2026-11-23 §7.6 — "Also allowed when Online Chess is offered to the org").
    const streamingRefusal = await refuseStreaming(orgId, competitionId);
    if (streamingRefusal && !(chessOffered || (await onlineChessOffered({ orgId, userId: user.id })))) throw streamingRefusal;

    const [sub] = await sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from subscriptions where id = ${subscriptionId}`;
    const returnUrl = `${baseUrl(req)}${landing}`;
    const currency = await preferredCurrency(orgId, req);
    let session: Awaited<ReturnType<typeof createRelayCheckout>>;
    try {
      session = await createRelayCheckout({
        // The RESOLVED org, never `body.orgId` — they are equal by the check
        // above, and keeping the resolver's value means a future relaxation of
        // that check cannot quietly turn the body into the authority.
        orgId,
        fixtureId,
        size: body.pack,
        returnUrl,
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
      // Parked (c): the PROD drift guard refused a pack whose live price differs from the table. It has already logged
      // and reported that once (lib/relay-checkout.ts); answered here with the same 502 code, and not re-thrown, which
      // would have `handler` report it again on every tap.
      if (err instanceof StreamPackPriceDriftError) {
        return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
      }
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
