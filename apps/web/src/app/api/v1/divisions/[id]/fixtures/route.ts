import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listDivisionFixtures } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** G3 (bench B03 product-gaps): before this route, the only way to obtain a
 *  division's fixtures over HTTP was POST /stages/{id}/generate, whose
 *  response happens to carry them (idempotent, so re-POSTing to "read" works)
 *  but isn't a documented list endpoint. Response shape matches GET
 *  /fixtures/{id} (S.Fixture) — no `venue`/`court_label` frozen text
 *  columns, `court_id`/`venue_id` + derived names instead — not the older
 *  FixtureRow shape `listDivisionFixtures` returns for RSC callers. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const rows = await listDivisionFixtures(auth, id);
    return rows.map(({ venue: _venue, court_label: _court_label, ...fixture }) => fixture);
  });
}
