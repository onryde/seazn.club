import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { buildSponsorDisputeEvidence } from "@/server/usecases/sponsors";
import { baseUrl } from "@/lib/oauth";
import { AuthError, HttpError } from "@/lib/errors";

type Ctx = { params: Promise<{ id: string; dealId: string }> };

/** Organiser: download the dispute evidence pack for a sponsor deal as a printable HTML document. Raw Response (an
 *  attachment), so this skips the v1 JSON envelope — auth is still the v1 org door. Console-only. */
export async function GET(req: Request, { params }: Ctx) {
  const { id, dealId } = await params;
  try {
    assertUuid(id, "organization");
    assertUuid(dealId, "deal");
    const auth = await requireOrgAuth(req, id, "write");
    const pack = await buildSponsorDisputeEvidence(auth, dealId, baseUrl(req));
    return new Response(pack.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="sponsor-dispute-evidence-${pack.ref}.html"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return new Response("unauthorized", { status: 401 });
    if (err instanceof HttpError) return new Response(err.message, { status: err.status });
    throw err;
  }
}
