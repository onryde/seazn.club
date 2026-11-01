import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PutSponsorStreamSettings } from "@/server/api-v1/schemas";
import { putStreamSettings } from "@/server/sponsors/stream-settings";

type Ctx = { params: Promise<{ id: string }> };

/** R4 sponsors on stream, S12 (spec 2026-10-27 §5.1): save one scope's dial - the organisation's row (`competitionId: null`)
 *  or a competition's own. Editors only (ruling R19: "write" is owner / admin), and never key-reachable (key-scopes.ts
 *  NEVER_KEY_ROUTES). The writer owns the org check, the competition's ownership and the upsert (server/sponsors/stream-settings.ts).
 *  Answers the settings it wrote. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, PutSponsorStreamSettings);
    const auth = await requireOrgAuth(req, id, "write");
    await putStreamSettings(auth, id, body);
    return body;
  });
}
