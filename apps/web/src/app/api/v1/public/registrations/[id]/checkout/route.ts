import { v1, parseBody } from "@/server/api-v1/http";
import { assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { publicRateLimit } from "@/server/usecases/public";
import { rateLimit, CHECKOUT_LIMIT } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { PublicRegistrationToken } from "@/server/api-v1/schemas";
import { resumeRegistrationCheckout } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** (Re)open Stripe Checkout for a pending paid registration — abandoned
 *  first checkouts and waitlist promotions pay from here. A call hands the
 *  entry's still-open session out again or mints one (polish wave W5), so on
 *  top of the public read budget it spends a per-IP CHECKOUT_LIMIT bucket of
 *  its own. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const ip = clientIp(req.headers);
    await rateLimit(`regcheckout:${ip}`, CHECKOUT_LIMIT);
    const { id } = await params;
    assertUuid(id, "registration");
    const { token } = await parseBody(req, PublicRegistrationToken);
    return resumeRegistrationCheckout(id, token, baseUrl(req));
  });
}
