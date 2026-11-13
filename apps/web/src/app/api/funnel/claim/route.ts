import { z } from "zod";
import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { HttpError, handler } from "@/lib/http";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { sql } from "@/lib/db";
import { createSession, setActiveOrgId } from "@/lib/auth";
import { consumeFunnelDraft, createFromDraft } from "@/lib/funnel";
import { FUNNEL_CLAIM_INVALID, FUNNEL_CLAIM_SIGNED_IN } from "@/lib/funnel-claim-codes";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { log } from "@/server/logger";
import { saveQuickMatchesForVerifiedUser } from "@/server/usecases/quick-match-save";

const schema = z.object({ token: z.string().min(10) }).strict();

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

    const { token } = schema.parse(await req.json());
    const draft = await consumeFunnelDraft(token);
    if (!draft) {
      // An expected answer, not a fault: a 400 the card words in the visitor's language (no Sentry).
      throw new HttpError(400, "This setup link is invalid, expired, or already used.", FUNNEL_CLAIM_INVALID);
    }

    const userId = await resolveOrCreateVerifiedUser(draft.email);
    if (!userId) throw new Error("Could not resolve an account for this email.");
    await createSession(userId);
    // Quick match §7.7: keep the matches a guest typed this verified address on (never throws; logs and goes on).
    await saveQuickMatchesForVerifiedUser(userId);

    // From here the visitor IS signed in and the token is spent: a failure names that, so the card sends them to their
    // dashboard (the event may be partly built — createFromDraft logs which step) instead of "start again or sign in".
    // The thrown status rides through, so a 5xx still reaches Sentry and the handler's log (the inner error as `cause`);
    // a 4xx the handler does not log is logged here. The body carries neither the inner message nor anything personal.
    let built: Awaited<ReturnType<typeof createFromDraft>>;
    try {
      built = await createFromDraft(userId, draft);
      await setActiveOrgId(built.orgId);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status < 500) log.warn({ err, status }, "funnel_claim_signed_in_refused");
      const signedIn = new HttpError(
        status,
        "Signed in, but the competition could not be finished.",
        FUNNEL_CLAIM_SIGNED_IN,
      );
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
