import { v1, reply } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { toApiPost } from "@/server/api-v1/posts";
import { generateWeeklyDigest } from "@/server/usecases/org-posts";

type Ctx = { params: Promise<{ id: string }> };

/** Generate a weekly digest draft (P3 / D7): standings movement, stat
 *  leaders, next 7 days, claimed-player highlight — always creates a draft,
 *  even one with every section absent ("a missing DRAFT is a defect"; see
 *  org-posts.ts's digestForOrg). Pro `news.auto`, same entitlement the
 *  system auto-drafts check — `generateWeeklyDigest` gates it, this route
 *  only proves org membership. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, toApiPost(await generateWeeklyDigest(auth, id)));
  });
}
