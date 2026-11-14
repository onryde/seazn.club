import { z } from "zod";
import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { HttpError, PaymentRequiredError, handler } from "@/lib/http";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { sql } from "@/lib/db";
import { createSession, setActiveOrgId } from "@/lib/auth";
import { FunnelClaimPartialError, consumeFunnelDraft, createFromDraft, replacedFunnelDraftReference } from "@/lib/funnel";
import {
  FUNNEL_CLAIM_DATE_PAST,
  FUNNEL_CLAIM_INVALID,
  FUNNEL_CLAIM_PLAN_LIMIT,
  FUNNEL_CLAIM_REPLACED,
  FUNNEL_CLAIM_SIGNED_IN,
} from "@/lib/funnel-claim-codes";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { log } from "@/server/logger";
import { saveQuickMatchesForVerifiedUser } from "@/server/usecases/quick-match-save";

const schema = z.object({ token: z.string().min(10) }).strict();
const DEAD_LINK = "This setup link is invalid, expired, or already used.";
const REPLACED_LINK = "This setup link was replaced by a newer one — check your latest email.";

/** Turn an email into a friendly default display name (the part before @). */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "Member";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return (
    cleaned
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ") || "Member"
  );
}

/** Find-or-create the account for a claimed draft. Opening the emailed link
 *  proves control of the address, so the account lands verified — the funnel
 *  token IS the magic link (v3/07 §6). */
async function resolveOrCreateVerifiedUser(email: string): Promise<string | null> {
  const existing = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  if (existing[0]) {
    await sql`update users set email_verified = true where id = ${existing[0].id}`;
    return existing[0].id;
  }
  const created = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${displayNameFromEmail(email)}, true)
    on conflict (email) do nothing
    returning id`;
  if (created[0]) return created[0].id;
  const again = await sql<{ id: string }[]>`
    select id from users where email = ${email} and deleted_at is null limit 1`;
  return again[0]?.id ?? null;
}

/** POST /api/funnel/claim — consume the draft token, sign the visitor in
 *  (creating the account if new), build org + competition + division from the
 *  draft, and return where to land: inside the competition. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = clientIp(await headers());
    await rateLimit(`funnel-claim:${ip}`, AUTH_LIMIT);

    // A token the schema refuses (a truncated link) names no draft either: the same dead-link answer, not "Invalid input".
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, DEAD_LINK, FUNNEL_CLAIM_INVALID);
    const draft = await consumeFunnelDraft(body.data.token);
    if (!draft) {
      // An expected answer, not a fault: a 400 the card words in the visitor's language (no Sentry). A link a newer start replaced
      // is told apart (V518): the way on is the latest email, not a fresh start.
      if ((await replacedFunnelDraftReference(body.data.token)) !== null) throw new HttpError(400, REPLACED_LINK, FUNNEL_CLAIM_REPLACED);
      throw new HttpError(400, DEAD_LINK, FUNNEL_CLAIM_INVALID);
    }

    const userId = await resolveOrCreateVerifiedUser(draft.email);
    if (!userId) throw new Error("Could not resolve an account for this email.");
    await createSession(userId);
    // Quick match §7.7: keep the matches a guest typed this verified address on (never throws; logs and goes on).
    await saveQuickMatchesForVerifiedUser(userId);

    // From here the visitor IS signed in and the token is spent: a failure names that, so the card sends them to their
    // dashboard instead of "start again or sign in". A plan refusal of the competition itself (the quota, refused before
    // its insert) wrote nothing: FUNNEL_CLAIM_PLAN_LIMIT. A first day that has passed (createFromDraft's first check, before
    // any write) wrote nothing either: FUNNEL_CLAIM_DATE_PAST, as thrown. Anything else may have left a part-built event (createFromDraft
    // logs which step): FUNNEL_CLAIM_SIGNED_IN. The inner status rides through, so a 5xx still reaches Sentry and the
    // handler's log (the inner error as `cause`); a 4xx the handler does not log is logged here; a 402 keeps its
    // `feature_key`. The body carries neither the inner message nor anything personal.
    let built: Awaited<ReturnType<typeof createFromDraft>>;
    try {
      built = await createFromDraft(userId, draft);
      await setActiveOrgId(built.orgId);
    } catch (err) {
      const partial = err instanceof FunnelClaimPartialError;
      const inner = partial ? err.cause : err;
      const status = inner instanceof HttpError ? inner.status : 500;
      if (status < 500) log.warn({ err: inner, status, partial }, "funnel_claim_signed_in_refused");
      if (!partial && inner instanceof HttpError && inner.code === FUNNEL_CLAIM_DATE_PAST) throw inner;
      const signedIn =
        inner instanceof PaymentRequiredError
          ? new PaymentRequiredError(inner.featureKey, {
              ...inner.extra,
              code: partial ? FUNNEL_CLAIM_SIGNED_IN : FUNNEL_CLAIM_PLAN_LIMIT,
            })
          : new HttpError(status, "Signed in, but the competition could not be finished.", FUNNEL_CLAIM_SIGNED_IN);
      throw Object.assign(signedIn, { cause: err });
    }
    const { redirect } = built;

    await captureServer({
      event: EVENTS.FUNNEL_CLAIMED,
      distinctId: userId,
      properties: { sport: draft.payload.sport, entrants: draft.payload.entrants },
    });

    return { redirect };
  });
}
