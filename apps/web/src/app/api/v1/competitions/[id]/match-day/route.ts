import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { resolveLocale } from "@/lib/resolve-locale";
import { getMatchDay } from "@/server/usecases/match-day";
import { matchDayForReader } from "@/lib/match-day/view";
import { isEditorRole } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day (spec 2026-10-31 §6, task A2): the competition's courts today, what each is doing and its queue, and the desk's
 *  Needs-you rows in the reader's language. Reads only; the desk route's terms (`read`). The page polls it, so it strips what
 *  the page strips (PB2 item 3): a reader without an editor's role gets no Needs-you rows and no owed-result count. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    const view = await getMatchDay(auth, id, new Date(), { locale: await resolveLocale() });
    return matchDayForReader(view, isEditorRole(auth.role));
  });
}
