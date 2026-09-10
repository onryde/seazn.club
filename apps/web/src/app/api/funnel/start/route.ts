import { z } from "zod";
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import { createFunnelDraft, funnelPayloadSchema } from "@/lib/funnel";
import { sendFunnelClaimEmail } from "@/lib/email";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { mayExposeDevLink } from "@/lib/dev-links";

const schema = z
  .object({ email: z.string().email().max(120) })
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

    const { email, ...payload } = schema.parse(await req.json());
    const draft = await createFunnelDraft(email, payload);

    const link = `${baseUrl(req)}/start/claim?token=${draft.token}`;
    // The result is no longer read — exposure is decided by `mayExposeDevLink`,
    // not by whether the mailer worked. `send()` already logs its own failure.
    await sendFunnelClaimEmail(email, {
      competitionName: payload.name,
      sport: payload.sport,
      link,
    });

    await captureServer({
      event: EVENTS.FUNNEL_DRAFT_CREATED,
      distinctId: `funnel:${draft.id}`,
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
