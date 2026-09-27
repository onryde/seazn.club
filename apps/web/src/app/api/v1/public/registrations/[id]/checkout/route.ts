import { v1, parseBody } from "@/server/api-v1/http";
import { assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { publicRateLimit } from "@/server/usecases/public";
import { rateLimit, CHECKOUT_LIMIT } from "@/lib/rate-limit";
import { PublicRegistrationToken } from "@/server/api-v1/schemas";
import { resumeRegistrationCheckout } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** (Re)open Stripe Checkout for a pending paid registration — abandoned
 *  first checkouts and waitlist promotions pay from here. Every call mints a
 *  Checkout Session, so on top of the public read budget it spends a per-IP
 *  CHECKOUT_LIMIT bucket of its own. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regcheckout:${ip}`, CHECKOUT_LIMIT);
    const { id } = await params;
    assertUuid(id, "registration");
    const { token } = await parseBody(req, PublicRegistrationToken);
    return resumeRegistrationCheckout(id, token, baseUrl(req));
  });
}
