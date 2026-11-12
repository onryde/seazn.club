import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { AuthError, HttpError } from "@/lib/errors";
import { invoiceFileName } from "@/lib/sponsor-invoice";
import { invoiceDocForDeal } from "@/server/sponsors/invoice-doc";
import { invoicePdf } from "@/server/sponsors/invoice-pdf";

type Ctx = { params: Promise<{ id: string; dealId: string }> };

/** Organiser: download a deal's invoice as the PDF its sponsor gets (sponsor deals, Task 22; spec §7) - the same document,
 *  in the org's language. "read" auth: anyone who can see the deal can print its invoice. 404 when the deal has no invoice
 *  (complimentary, or made before invoices were numbered) or is not this org's. Raw Response (an attachment), so this skips
 *  the v1 JSON envelope, like the dispute evidence pack beside it. Console-only (key-scopes NEVER_KEY_ROUTES). */
export async function GET(req: Request, { params }: Ctx) {
  const { id, dealId } = await params;
  try {
    assertUuid(id, "organization");
    assertUuid(dealId, "deal");
    const auth = await requireOrgAuth(req, id, "read");
    const doc = await invoiceDocForDeal(auth, dealId);
    const bytes = await invoicePdf(doc);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoiceFileName(doc.number)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response("unauthorized", { status: 401 });
    if (err instanceof HttpError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
