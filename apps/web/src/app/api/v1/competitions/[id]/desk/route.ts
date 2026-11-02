import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { getCompetitionDesk } from "@/server/usecases/competition-desk";

type Ctx = { params: Promise<{ id: string }> };

/** W3 Task 6: the band's second door. Same producer the competition page's
 *  SSR pill already reads (`getCompetitionDesk`) — no second query, no
 *  second authority for `in_play`/`in_play_fixtures`.
 *
 *  Review finding m9, ACCEPTED as it stands. "One shape, two doors" is the
 *  design doc's own ruling for this route, and it means the poll returns the
 *  WHOLE desk — every division's phase, its `attention[]` and its
 *  `fixture_names` map — while its only in-app caller (the in-play band) lifted
 *  exactly two fields off it, three times a minute per open tab. The cost is
 *  real and it is deliberate: a second, narrower shape would be a second
 *  authority for `in_play`, which is the defect class this wave spent three
 *  fix rounds on one level up. If the payload ever becomes the problem, the
 *  fix is a `?fields=` NARROWING of this same shape — never a second
 *  endpoint, and never a second query.
 *
 *  Match Day B1 (spec 2026-10-31 §9): the band is gone, and with it this
 *  route's last in-app caller; it stays as the public API's desk read, now
 *  carrying `fixtures_today` (A2's `countFixturesToday`) beside the rest.
 *
 *  Match Day PB2 (review m4): this read is NOT a confidentiality boundary for the organiser's to-do list. It serves every
 *  division's `attention[]` — the facts Match Day's Needs-you rows are built from — to every reader of the competition,
 *  viewers and API keys included. Match Day's `matchDayForReader` strips Needs-you for a non-editor because a viewer
 *  cannot ACT on those rows (a presentation choice), not because they are private: nothing may lean on that strip, or on
 *  this route, to keep attention facts from a reader. */
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
