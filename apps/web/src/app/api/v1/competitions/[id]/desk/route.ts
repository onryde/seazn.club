import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { getCompetitionDesk } from "@/server/usecases/competition-desk";

type Ctx = { params: Promise<{ id: string }> };

/** W3 Task 6: the band's second door. Same producer the competition page's
 *  SSR pill already reads (`getCompetitionDesk`) — no second query, no
 *  second authority for `in_play`/`in_play_fixtures`. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const desk = await getCompetitionDesk(auth, id);
    // `divisions` is a `Map` on the usecase's own type — it serialises to
    // `{}` over JSON (no own enumerable properties), so it is converted to a
    // plain object here rather than returned bare. Everything else on `desk`
    // is a primitive, array or plain object already.
    return { ...desk, divisions: Object.fromEntries(desk.divisions) };
  });
}
