import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PutSeaznHosted } from "@/server/api-v1/schemas";
import { seaznOfferOf, setSeaznOffered } from "@/server/usecases/stream-targets";

type Ctx = { params: Promise<{ id: string }> };

/** Seazn-hosted video, Task 33 (V559): the organisation's Seazn switch, `{ offered }`. The streaming destinations' gate (the
 *  stream-targets route beside this one): org read for GET (a viewer sees the switch), org write for PUT (ruling R19: owner /
 *  admin), and never key-reachable (key-scopes.ts NEVER_KEY_ROUTES). Off gates only NEW Seazn picks and starts; a live Seazn stream,
 *  its recordings and its replays are untouched (usecases/stream-targets.ts). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    return seaznOfferOf(auth.orgId);
  });
}

export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    // The door before the body: a caller who may not write never learns the body's shape from a 400.
    const auth = await requireOrgAuth(req, id, "write");
    const body = await parseBody(req, PutSeaznHosted);
    return setSeaznOffered(auth, id, body.offered);
  });
}
