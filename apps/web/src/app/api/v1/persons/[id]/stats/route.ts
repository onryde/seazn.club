import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { personCareerStats, personStats } from "@/server/usecases/player-stats";

type Ctx = { params: Promise<{ id: string }> };

/** A player's card stats, keyed per division (Jul3/07 §6). S9/#418:
 *  `?group=sport` switches to the cross-division career rollup instead —
 *  validated against the exact literal rather than trusted, so a typo or an
 *  unrecognised value (including a future group kind this route doesn't
 *  support yet) falls back to today's per-division behaviour byte-for-byte,
 *  never a 400 for an unknown query value. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    const url = new URL(req.url);
    if (url.searchParams.get("group") === "sport") {
      return personCareerStats(auth, id);
    }
    const divisionId = url.searchParams.get("division_id") ?? undefined;
    return personStats(auth, id, divisionId);
  });
}
