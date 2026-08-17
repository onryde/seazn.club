import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { HttpError } from "@/lib/errors";
import { PublicRegisterGroupRequest } from "@/server/api-v1/schemas";
import { submitRegistrationGroup } from "@/server/usecases/registration-submit";
import { getCurrentUser } from "@/lib/auth";
import { hasLocale, type Locale } from "@/lib/i18n-constants";

/** The registrant's explicit locale pick (footer switcher → seazn_locale cookie),
 *  or null when they never chose — then the org's public default applies.
 *  Same shape as the deleted pre-redesign route's own `explicitLocale`
 *  (850cc6308^) — kept local to this file rather than shared, matching it. */
function explicitLocale(req: Request): Locale | null {
  const raw = req.headers.get("cookie")?.match(/(?:^|;\s*)seazn_locale=([^;]+)/)?.[1];
  if (!raw) return null;
  const v = decodeURIComponent(raw);
  return hasLocale(v) ? v : null;
}

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
 * did. `checkout_url` is null this wave — wave 3 wires Stripe checkout.
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
    await rateLimit(`regsubmit:${ip}:${slug}`, { max: 5, windowSeconds: 300 });
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
        entries: input.entries,
      },
    );
    // `SubmitGroupResult` carries no `checkout_url` — wave 3 mints the Stripe
    // session and starts returning a real one; until then the wire contract
    // is already shaped for it so it never has to widen.
    return reply(201, { ...result, checkout_url: null });
  });
}
