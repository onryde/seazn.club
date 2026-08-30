import { v1, parseBody } from "@/server/api-v1/http";
import { assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { publicRateLimit } from "@/server/usecases/public";
import { PublicRegistrationToken } from "@/server/api-v1/schemas";
import { resendRegistrationConfirmationPublic } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Registrant self-service resend (RS007) — the token-gated sibling of
 * /api/v1/registrations/{id}/resend-confirmation (organiser, session-
 * authenticated). Keyed on the GROUP id (`rid` on the status page), not one
 * entry: the confirmation mail is cart-shaped, so this resends the whole
 * cart, never just one entry.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    assertUuid(id, "registration group");
    const { token } = await parseBody(req, PublicRegistrationToken);
    return resendRegistrationConfirmationPublic(id, token, baseUrl(req));
  });
}
