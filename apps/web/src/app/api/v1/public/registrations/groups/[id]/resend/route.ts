import { v1, parseBody } from "@/server/api-v1/http";
import { assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { publicRateLimit } from "@/server/usecases/public";
import { rateLimit, EMAIL_LIMIT } from "@/lib/rate-limit";
import { PublicRegistrationToken } from "@/server/api-v1/schemas";
import { resendRegistrationConfirmationPublic } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Registrant self-service resend (RS007) — the token-gated sibling of
 * /api/v1/registrations/{id}/resend-confirmation (organiser, session-
 * authenticated). Keyed on the GROUP id (`rid` on the status page), not one
 * entry: the confirmation mail is cart-shaped, so this resends the whole
 * cart, never just one entry. Every call sends mail, so on top of the public
 * read budget it spends a per-IP EMAIL_LIMIT bucket of its own.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regresend:${ip}`, EMAIL_LIMIT);
    const { id } = await params;
    assertUuid(id, "registration group");
    const { token } = await parseBody(req, PublicRegistrationToken);
    return resendRegistrationConfirmationPublic(id, token, baseUrl(req));
  });
}
