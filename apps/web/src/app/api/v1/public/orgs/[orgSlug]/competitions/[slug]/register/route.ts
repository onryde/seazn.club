import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { HttpError } from "@/lib/errors";
import { PublicRegisterGroupRequest } from "@/server/api-v1/schemas";
import { submitRegistrationGroup } from "@/server/usecases/registration-submit";
import { mintGroupCheckout, notifySubmitted } from "@/server/usecases/registrations";
import { getCurrentUser } from "@/lib/auth";
import { baseUrl } from "@/lib/oauth";
import { log } from "@/server/logger";
import { explicitLocale } from "@/lib/explicit-locale";
import { OutboxKeyUnavailableError, assertOutboxCanQueue } from "@/server/email-outbox";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/**
 * Public group registration submit (design §4 step 5) — a club rep's whole
 * cart (one or more entries) in one call; `submitRegistrationGroup` owns the
 * transaction, capacity, eligibility and ref_code/access_token minting. Two
 * rate-limit buckets around a honeypot, same shape as the deleted
 * pre-redesign route (850cc6308^: a general per-IP write budget, then the
 * honeypot, then a narrower bucket) — the narrower bucket is now keyed to
 * the COMPETITION rather than a division_id: a multi-division cart has no
 * single division value left to key on the way the old single-entry route
 * did. `checkout_url` is null for an unpayable cart (all-waitlisted,
 * all-free, or offline payment method) — RS003 W3a mints a real one
 * otherwise via `mintGroupCheckout`, which owns the payment_method/subtotal
 * gate and the currency validation; this route only wires the result
 * through.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regsubmit:${ip}`, { max: 10, windowSeconds: 60 });
    const { orgSlug, slug } = await params;
    const input = await parseBody(req, PublicRegisterGroupRequest);
    // Honeypot (v3/05 §4): hidden on the real form; a filled value is a bot.
    // Fires AFTER the general per-IP bucket above (already spent) but BEFORE
    // the narrower one below, matching the deleted route exactly.
    if (input.website) {
      throw new HttpError(400, "Registration failed");
    }
    // Keyed on org AND competition, not the competition slug alone:
    // `competitions_org_id_slug_key` is unique on (org_id, slug), so two orgs
    // may both call a competition "summer-league" and a slug-only key would
    // make one tenant's registrants spend the other's budget. The deleted
    // route keyed on `division_id`, a globally unique uuid, and had no such
    // ambiguity to lose.
    await rateLimit(`regsubmit:${ip}:${orgSlug}:${slug}`, { max: 5, windowSeconds: 300 });
    // Can this box queue the confirmation at all? Asked BEFORE anything is committed. The submit commits the cart (and the mint below
    // may create a Checkout session) before the confirmation is queued, so a box that cannot seal the body (a Resend key set, no usable
    // outbox key) must refuse HERE, with nothing done: an enqueue that was the first to find out would leave a committed cart, and
    // possibly a live payment link, with no mail and a 201 the registrant takes at its word. An anonymous caller is told only
    // "Server error": the real cause (it names a variable) goes to the log, and `v1` reports the 500 to Sentry.
    try {
      assertOutboxCanQueue();
    } catch (err) {
      if (!(err instanceof OutboxKeyUnavailableError)) throw err;
      log.error({ err, org_slug: orgSlug, comp_slug: slug }, "register: the confirmation email cannot be queued; the submit was refused before any cart was committed");
      throw new HttpError(500, "Server error");
    }
    // #402 — resolve the session HERE, never inside the usecase: keeping the
    // lookup at the public boundary is what makes organiser-facing entry
    // paths structurally unable to supply one (an organiser entering a team
    // on someone's behalf must never bind their own user_id to a player's
    // person).
    const sessionUser = await getCurrentUser();
    const result = await submitRegistrationGroup(
      { orgSlug, compSlug: slug, sessionUserId: sessionUser?.id ?? null },
      {
        contact: input.contact,
        locale: explicitLocale(req),
        privacy_consent: input.privacy_consent,
        media_consent: input.media_consent,
        entries: input.entries,
      },
    );
    // `SubmitGroupResult` carries no `checkout_url` (registration-submit.ts
    // stays payment-agnostic) — the route adds it. Skipped entirely for a
    // zero-subtotal cart: no DB round trip needed to know there is nothing
    // to charge, and this keeps every all-free/all-waitlisted submit (the
    // common no-DB-mock test path) from touching Stripe at all.
    //
    // A mint failure must NOT fail the submit. `submitRegistrationGroup` has
    // already COMMITTED the cart by the time we get here, so throwing would
    // return an error for a registration that exists: the entries keep their
    // capacity/waitlist slots, and the registrant never receives the ref_code
    // or access_token, which are the only ways back to the status page to pay.
    // The observable result would be a duplicate cart on their retry.
    // Every throw mintGroupCheckout can raise is recoverable LATER by the
    // organiser (Connect not live yet, a currency snapshot gone stale) or by
    // Stripe itself, and the status page's resume-checkout path re-mints on
    // demand — so the honest response is "you are registered, there is no
    // payment link yet", not "your registration failed".
    // mintGroupCheckout still THROWS for its direct callers (resume-checkout,
    // waitlist promotion), where there is no committed-and-lost work to
    // protect and a 422/503 is exactly what the caller should see.
    let checkout_url: string | null = null;
    if (result.amount_cents > 0) {
      try {
        checkout_url = await mintGroupCheckout(
          result.group_id,
          result.entries[0]!.division_id,
          baseUrl(req),
          result.access_token,
        );
      } catch (err) {
        log.error(
          { err, group_id: result.group_id, org_slug: orgSlug, comp_slug: slug },
          "registration group submitted but checkout mint failed; returning 201 with no payment link",
        );
      }
    }
    // Cart-shaped confirmation (RS005 W4 finding: the confirmation mailer had
    // ZERO callers before this wave — see notifySubmitted's own doc
    // comment). Queued HERE, after the mint attempt resolves either way, so
    // the mail can carry whatever payUrl actually exists rather than a
    // guess made before it was known; its first attempt is made after the
    // response. notifySubmitted never throws — a mail failure must never
    // turn this already-committed cart into an error response.
    await notifySubmitted(result.group_id, baseUrl(req), result.access_token, checkout_url);
    return reply(201, { ...result, checkout_url });
  });
}
