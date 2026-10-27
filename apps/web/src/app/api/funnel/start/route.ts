import { z } from "zod";
import { headers } from "next/headers";
import { sql } from "@/lib/db";
import { handler } from "@/lib/http";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import { createFunnelDraft, funnelPayloadSchema } from "@/lib/funnel";
import { funnelClaimEmail } from "@/lib/email";
import { dispatchNow, enqueueEmail, expiryWithin, recipientLocale } from "@/server/email-outbox";
import { explicitLocale } from "@/lib/explicit-locale";
import { LOCALES } from "@/lib/i18n-constants";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { mayExposeDevLink } from "@/lib/dev-links";

const schema = z
  .object({
    email: z.string().email().max(120),
    // The language the /start page was rendered in (its `[lang]` segment, which the proxy resolved from the cookie or Accept-Language
    // when the URL had none): the language the visitor saw. One that names no shipped locale is dropped, never a 400.
    locale: z.enum(LOCALES).optional().catch(undefined),
  })
  .extend(funnelPayloadSchema.shape)
  .strict();

/** POST /api/funnel/start — persist a pre-auth competition draft and email
 *  the single-use claim link (v3/07 §6). The response never says whether the
 *  email has an account; in dev the link is returned for e2e (the magic-link
 *  `login_url` convention). */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`funnel-start:${ip}`, EMAIL_LIMIT);

    // `locale` is kept out of the payload: the claim re-reads the draft's payload strictly. It rides its own column instead.
    const { email, locale, ...payload } = schema.parse(await req.json());
    // D4: the visitor's pick is the language the page was shown in, then the switcher's cookie (read as the public register route
    // reads it) for a client that sent none. The draft remembers it for its +24h reminder (Q3), so the claim and the reminder share a
    // language; null when there was none, and both then fall to `en`: there is no account and no organisation yet.
    const pick = locale ?? explicitLocale(req);

    // The draft and the email that carries its token are one transaction on the pool (a visitor has no account and no
    // organisation): a refused row fails the start and leaves no draft behind. The row's ref is the draft, so a second start (its
    // own draft, its own token, both links live) is a second document and neither row replaces the other.
    const { draftId, rowId, link } = await sql.begin(async (tx) => {
      const draft = await createFunnelDraft(email, payload, tx, pick);
      const link = `${baseUrl(req)}/start/claim?token=${draft.token}`;
      const rowId = await enqueueEmail(tx, {
        kind: "funnel_claim",
        refType: "funnel_draft",
        refId: draft.id,
        orgId: null,
        to: email,
        transactional: true,
        expiresAt: expiryWithin(draft.expiresAt),
        ...(await funnelClaimEmail(
          { competitionName: payload.name, sport: payload.sport, link },
          await recipientLocale(tx, { pick, userId: null, orgDefault: null }),
        )),
      });
      return { draftId: draft.id, rowId, link };
    });
    // After commit, in the request: the visitor is waiting for this link. A failed attempt is the retry worker's to finish, and the
    // outcome is not read — exposure is decided by `mayExposeDevLink`, not by whether the mail went.
    await dispatchNow([rowId]);

    await captureServer({
      event: EVENTS.FUNNEL_DRAFT_CREATED,
      distinctId: `funnel:${draftId}`,
      properties: { sport: payload.sport, entrants: payload.entrants },
    });

    return {
      message: "Check your email — your competition is one click away.",
      // Same rule as the magic-link route, from the same helper: the send
      // outcome does not decide exposure. `!sent` used to, and this claim link
      // signs its holder in exactly as a magic link does.
      ...(mayExposeDevLink() ? { claim_url: link } : {}),
    };
  });
}
