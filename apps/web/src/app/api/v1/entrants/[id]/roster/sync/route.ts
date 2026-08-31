import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { SyncEntrantRoster } from "@/server/api-v1/schemas";
import { syncEntrantRosterFromSquad } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/entrants/{id}/roster/sync — replace the entrant's roster with
 *  the linked team's current squad (enrollment snapshots once; this re-syncs).
 *  RS011: the body is OPTIONAL (every existing caller posts none) — parsed
 *  AFTER auth, same "authenticate first, then parse" ordering `divisions/
 *  {id}/start`'s route documents (#376), so an unauthenticated caller learns
 *  that from the auth door and nothing else. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    const body = SyncEntrantRoster.parse(await req.json().catch(() => ({})));
    return syncEntrantRosterFromSquad(auth, id, body.eligibility_override);
  });
}
