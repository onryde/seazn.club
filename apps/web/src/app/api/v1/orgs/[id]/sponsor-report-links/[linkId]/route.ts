import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { revokeReportLink } from "@/server/sponsors/report";

type Ctx = { params: Promise<{ id: string; linkId: string }> };

/** R4 sponsors on stream, S13: revoke a sponsor report link. Editors only (R19); never key-reachable (NEVER_KEY_ROUTES). A link
 *  already revoked, unknown or another organisation's is 404 (server/sponsors/report.ts). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, linkId } = await params;
    assertUuid(id, "organization");
    assertUuid(linkId, "report link");
    const auth = await requireOrgAuth(req, id, "write");
    await revokeReportLink(auth, id, linkId);
    return { revoked: true as const };
  });
}
