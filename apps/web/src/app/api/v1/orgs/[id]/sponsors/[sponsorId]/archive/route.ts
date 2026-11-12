// Archive a sponsor (docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §6.3, D13): the house archive pattern
// (venues/[venueId]/archive/route.ts). POST archives, DELETE unarchives; both idempotent, both answer the Sponsor. Editors only,
// and never key-accessible (NEVER_KEY_ROUTES).
import { v1 } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { archiveSponsor, unarchiveSponsor } from "@/server/usecases/sponsors";

type Ctx = { params: Promise<{ id: string; sponsorId: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const auth = await requireOrgAuth(req, id, "write");
    return archiveSponsor(auth, sponsorId);
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, sponsorId } = await params;
    assertUuid(id, "organization");
    assertUuid(sponsorId, "sponsor");
    const auth = await requireOrgAuth(req, id, "write");
    return unarchiveSponsor(auth, sponsorId);
  });
}
