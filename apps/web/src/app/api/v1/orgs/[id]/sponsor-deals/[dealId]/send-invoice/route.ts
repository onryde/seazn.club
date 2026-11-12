import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { baseUrl } from "@/lib/oauth";
import { sendDealInvoice } from "@/server/usecases/sponsor-deals";

type Ctx = { params: Promise<{ id: string; dealId: string }> };

/** Send (or resend) a deal's invoice, online or offline (Task 23): `{ deal, invoice_url }`, the url being the link the email
 *  carries (the numbered invoice page, never a payment link; every send mints a new one). Online, the stored payment link is
 *  reused while more than 10 minutes are left of it, else retired and a new one minted. 409 when the deal is not invoiceable
 *  (paid, ended with nothing due, complimentary, unnumbered), 422 for an offline deal with no billing email, 402 when the plan no
 *  longer sells online, 429 past the org's invoice emails for the day, 502 when Stripe cannot do it. Console-only. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, dealId } = await params;
    assertUuid(id, "organization");
    assertUuid(dealId, "deal");
    const auth = await requireOrgAuth(req, id, "write");
    return sendDealInvoice(auth, dealId, baseUrl(req));
  });
}
