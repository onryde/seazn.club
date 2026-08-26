import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { resendRegistrationConfirmation } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Organiser: resend the registrant's confirmation email (RS005 W4). Resends
 * the WHOLE cart `id`'s entry belongs to, not just that one entry — the
 * mail itself is cart-shaped, same as the submit-time send. Mirrors
 * `/remind`'s shape (no request body, `{ sent: boolean }`), the closer
 * precedent than returning a registration row: there is no row-shaped
 * result to strip a secret from here.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return resendRegistrationConfirmation(auth, id, baseUrl(req));
  });
}
