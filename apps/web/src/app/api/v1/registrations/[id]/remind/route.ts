import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { sendPaymentReminder } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ id: string }> };

/** Organiser: email an unpaid registrant a payment reminder linking their payment page (`/r/pay/<token>` under this origin). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "registration", id, "write");
    return sendPaymentReminder(auth, id, baseUrl(req));
  });
}
