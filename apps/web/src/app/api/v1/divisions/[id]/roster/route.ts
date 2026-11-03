import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { divisionRoster } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/divisions/{id}/roster — every (person → entrant) membership of
 *  an entrant still in the division's field, of every kind (`entrant_kind`).
 *  The console's one-team-per-division read (UI5 item 3): a person listed here
 *  is refused on any other entrant of the division (409 PERSON_ON_OTHER_TEAM),
 *  by the same predicate (`heldMemberships`). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return divisionRoster(auth, id);
  });
}
