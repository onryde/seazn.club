import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateStreamTarget } from "@/server/api-v1/schemas";
import { createStreamTarget, listStreamTargets } from "@/server/usecases/stream-targets";

type Ctx = { params: Promise<{ id: string }> };

/** Streaming destinations (R1, design §6.1). Same gate as venues: org write
 *  for POST, org read for GET; never key-reachable (key-scopes.ts). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    return listStreamTargets(auth, id);
  });
}

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreateStreamTarget);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(201, await createStreamTarget(auth, id, body));
  });
}
