import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PutOrgStreamDefaults } from "@/server/api-v1/schemas";
import { orgStreamDefaultsOf, saveOrgStreamDefaults } from "@/server/usecases/org-stream-defaults";

type Ctx = { params: Promise<{ id: string }> };

/** Seazn-hosted video, Task 38 (V558): the club's default Score style and Score timing, `{ overlayTemplate, overlayDelayMs, revision }`.
 *  The Streaming page's gate (the stream-targets and seazn-hosted routes beside this one): org read for GET (a viewer sees the
 *  defaults), org write for PUT (ruling R19: owner / admin; an admin whose seat is paused is read-only, 402), and never key-reachable
 *  (key-scopes.ts NEVER_KEY_ROUTES). A new stream copies them at its start; a running one never moves (usecases/org-stream-defaults.ts). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    return orgStreamDefaultsOf(auth.orgId);
  });
}

export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    // The door before the body: a caller who may not write never learns the body's shape from a 400.
    const auth = await requireOrgAuth(req, id, "write");
    const body = await parseBody(req, PutOrgStreamDefaults);
    return saveOrgStreamDefaults(auth, id, body);
  });
}
