import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { resolveLocale } from "@/lib/resolve-locale";
import { getMatchDay } from "@/server/usecases/match-day";

type Ctx = { params: Promise<{ id: string }> };

/** Match Day (spec 2026-10-31 §6, task A2): the competition's courts today, what each is doing and its queue, and the desk's
 *  Needs-you rows in the reader's language. Reads only; the desk route's terms (`read`). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    return getMatchDay(auth, id, new Date(), { locale: await resolveLocale() });
  });
}
