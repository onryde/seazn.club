import { createHash } from "node:crypto";
import { z } from "zod";
import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { sql } from "@/lib/db";
import { handler } from "@/lib/http";
import { rateLimit, EMAIL_LIMIT, FUNNEL_RECIPIENT_LIMIT } from "@/lib/rate-limit";
import { requireTurnstile } from "@/server/turnstile";
import { baseUrl } from "@/lib/oauth";
import { FUNNEL_REFERENCE_SHAPE, createFunnelDraft, funnelPayloadSchema } from "@/lib/funnel";
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
    // The Change-email flow (V518): the earlier start's reference and the replace key its answer carried, so the draft it wrote is
    // replaced although the address differs. Both or neither; a pair that names no live draft replaces nothing (no error, no tell).
    previousReference: z.string().regex(FUNNEL_REFERENCE_SHAPE).optional(),
    replaceKey: z.string().min(32).max(100).optional(),
  })
  .extend(funnelPayloadSchema.shape)
  .strict()
  .refine((b) => (b.previousReference === undefined) === (b.replaceKey === undefined), {
    message: "previousReference and replaceKey go together",
    path: ["replaceKey"],
  });

/** POST /api/funnel/start — persist a pre-auth competition draft and email
 *  the single-use claim link (v3/07 §6). The response never says whether the
 *  email has an account; in dev the link is returned for e2e (the magic-link
 *  `login_url` convention). It carries the draft's `reference` (SZ-XXXXXX, also
 *  printed in the email) and an opaque `replaceKey`: the client sends both back
 *  as `previousReference` + `replaceKey` to replace this draft from another
 *  address (Change email), keeping the reference. A resubmit from the same
 *  address replaces its live draft without them, under a NEW reference
 *  (lib/funnel.ts createFunnelDraft); one inbox takes FUNNEL_RECIPIENT_LIMIT
 *  starts a day. */
export async function POST(req: Request) {
  return handler(async () => {
    const ip = clientIp(await headers());
    await rateLimit(`funnel-start:${ip}`, EMAIL_LIMIT);
    // Bot check (Cloudflare Turnstile): before the body is read or a draft is written. 403 TURNSTILE_FAILED.
    await requireTurnstile(req, "start");

    // `locale` is kept out of the payload: the claim re-reads the draft's payload strictly. It rides its own column instead. So do the
    // replace pair: they name the draft this start replaces, and are no part of what is built.
    const { email, locale, previousReference, replaceKey: heldKey, ...payload } = schema.parse(await req.json());
    const previous = previousReference !== undefined && heldKey !== undefined ? { reference: previousReference, replaceKey: heldKey } : null;
    // Per RECIPIENT, before anything is written or voided (T1 review m1): a start replaces the address's live draft keylessly, so
    // one inbox takes FUNNEL_RECIPIENT_LIMIT starts a day whatever IPs send them. The bucket is the address's hash, never the address.
    await rateLimit(`funnel-start-recipient:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`, FUNNEL_RECIPIENT_LIMIT);
    // D4: the visitor's pick is the language the page was shown in, then the switcher's cookie (read as the public register route
    // reads it) for a client that sent none. The draft remembers it for its +24h reminder (Q3), so the claim and the reminder share a
    // language; null when there was none, and both then fall to `en`: there is no account and no organisation yet.
    const pick = locale ?? explicitLocale(req);

    // The draft and the email that carries its token are one transaction on the pool (a visitor has no account and no
    // organisation): a refused row fails the start and leaves no draft behind. A second start for the address (or one naming this
    // draft by its reference and replace key) REPLACES the live draft (V518) — keeping its reference only when keyed: its own draft,
    // its own token, its own email row — the row's ref is the draft — and only the newest link claims.
    const { draftId, rowId, link, reference, replaceKey } = await sql.begin(async (tx) => {
      const draft = await createFunnelDraft(email, payload, tx, pick, previous);
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
          { competitionName: payload.name, sport: payload.sport, link, reference: draft.reference },
          await recipientLocale(tx, { pick, userId: null, orgDefault: null }),
        )),
      });
      return { draftId: draft.id, rowId, link, reference: draft.reference, replaceKey: draft.replaceKey };
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
      reference,
      replaceKey,
      // Same rule as the magic-link route, from the same helper: the send
      // outcome does not decide exposure. `!sent` used to, and this claim link
      // signs its holder in exactly as a magic link does.
      ...(mayExposeDevLink() ? { claim_url: link } : {}),
    };
  });
}
