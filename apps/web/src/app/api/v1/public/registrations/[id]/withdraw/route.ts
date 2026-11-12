import { v1, parseBody } from "@/server/api-v1/http";
import { assertUuid } from "@/server/api-v1/auth";
import { publicRateLimit } from "@/server/usecases/public";
import { PublicRegistrationToken } from "@/server/api-v1/schemas";
import { withdrawRegistrationPublic } from "@/server/usecases/registrations";
import { requireTurnstile } from "@/server/turnstile";

type Ctx = { params: Promise<{ id: string }> };

/** Registrant self-withdraw: frees the spot, auto-promotes the waitlist,
 *  auto-refunds before refund_lock_at (doc 16 §1.1). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    // Bot check (Cloudflare Turnstile): after the public read budget, before the id is validated or the body is read. 403 TURNSTILE_FAILED.
    await requireTurnstile(req, "withdraw");
    const { id } = await params;
    assertUuid(id, "registration");
    const { token } = await parseBody(req, PublicRegistrationToken);
    return withdrawRegistrationPublic(id, token);
  });
}
