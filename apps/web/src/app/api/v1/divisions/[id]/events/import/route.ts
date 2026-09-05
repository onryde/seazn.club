import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { requireFeature } from "@/lib/entitlements";
import { EventImportRequest } from "@/server/api-v1/schemas";
import { importEvents } from "@/server/usecases/event-import";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/divisions/{id}/events/import — P11 (D6) batch score-event
 *  import. Returns 200 whenever the CALL executed; per-stream outcomes are
 *  data, not transport errors (design doc §4). Gated behind `import.events`,
 *  which V396 (entitlements v18 W2 T14, owner ruling 2026-09-03) grants bool
 *  TRUE on all five plans — the rollout kill-switch is OPEN and this importer
 *  is a launched feature on Free. The check below STAYS: `orgPlanKey`
 *  coalesces a planless org to `community`, so no plan can deny the key any
 *  more, but a staff `org_entitlement_overrides` deny still can and this is
 *  the site that honours it.
 *
 *  AUTHENTICATE FIRST, THEN ENTITLEMENT, THEN PARSE — same ordering rationale
 *  as `start/route.ts` (#376): a caller with no write permission, or without
 *  the feature, must learn that from the door before the body is even
 *  looked at, not from a 400 that happens to fire first because parsing ran
 *  earlier.
 *
 *  The concurrency lock (`import.concurrent`, 409) lives in `importEvents`
 *  itself, not here — see that function's own doc comment. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    await requireFeature(auth.orgId, "import.events"); // granted on every plan (V396); a staff override can still deny
    const body = await parseBody(req, EventImportRequest);
    return reply(200, await importEvents(auth, id, body));
  });
}
