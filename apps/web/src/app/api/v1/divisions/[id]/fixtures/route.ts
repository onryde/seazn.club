import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { omit } from "@/lib/omit";

type Ctx = { params: Promise<{ id: string }> };

/** G3 (bench B03 product-gaps): before this route, the only way to obtain a
 *  division's fixtures over HTTP was POST /stages/{id}/generate, whose
 *  response happens to carry them (idempotent, so re-POSTing to "read" works)
 *  but isn't a documented list endpoint. Response shape matches GET
 *  /fixtures/{id} (S.Fixture) — no `venue`/`court_label` frozen text
 *  columns, `court_id`/`venue_id` + derived names instead — not the older
 *  FixtureRow shape `listDivisionFixtures` returns for RSC callers.
 *
 *  The four bracket FEED columns are stripped here for the same reason: the
 *  usecase selects them so the division page's draw sheet can name an
 *  unfilled seat by its feeder, but they are internal bracket wiring and are
 *  NOT declared on `S.Fixture`. Serving an undeclared field is the silent
 *  "published spec vs real payload" gap `fixture_no` and `lane`'s own schema
 *  comments were written about — this route projects them out rather than
 *  widening the published contract as a side effect of a rendering fix. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const rows = await listDivisionFixtures(auth, id);
    return rows.map((row) =>
      omit(
        row,
        "venue",
        "court_label",
        "winner_to_fixture",
        "winner_to_slot",
        "loser_to_fixture",
        "loser_to_slot",
        // W2b loop-F I-2: the console's qualification read, not part of the published `Fixture` contract.
        "expunged",
        // W2b Task 13: the run sheet's abandon tag read, not part of the published `Fixture` contract either.
        "abandon_reason",
        // W2c X-AB-5: the console's qualification read of the ledger, not part of the published `Fixture` contract.
        "has_active_abandon",
        // W2c Task 19 (S4): the run sheet's "Format changed" chip read, not part of the published `Fixture` contract either.
        "format_changed",
      ),
    );
  });
}
