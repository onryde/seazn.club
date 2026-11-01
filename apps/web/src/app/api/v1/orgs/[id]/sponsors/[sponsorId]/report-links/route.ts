import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateSponsorReportLink } from "@/server/api-v1/schemas";
import { createReportLink } from "@/server/sponsors/report";

type Ctx = { params: Promise<{ id: string; sponsorId: string }> };

/** R4 sponsors on stream, S13 (spec §4, §5.2): mint a shareable report link for one sponsor. Editors only (ruling R19: "write"
 *  is owner / admin), asked BEFORE the body is read, so a viewer is told 403 whatever it sent; never key-reachable (key-scopes.ts
 *  NEVER_KEY_ROUTES). The usecase owns the org check, the sponsor's and competition's ownership and the token
 *  (server/sponsors/report.ts). Answers `{ id, url }` - the only time the url is ever answered. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const auth = await requireOrgAuth(req, id, "write");
    const body = await parseBody(req, CreateSponsorReportLink);
    return reply(201, await createReportLink(auth, id, { sponsorId, ...body }));
  });
}
