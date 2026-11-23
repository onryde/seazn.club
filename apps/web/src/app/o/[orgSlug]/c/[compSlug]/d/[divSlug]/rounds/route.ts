// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the rows of ONE folded round of a big division's run sheet, loaded when the
// organiser opens its bar (`components/v2/desk/run-sheet.tsx`; the page ships only its tally, `lib/run-sheet-paging.ts`). Org data:
// the caller must READ the division (`requireResourceAuth`, the session or a read key), and the answer is never cached. The rows are
// the page's own read (`listDivisionFixtures`), so a loaded round is what the page would have shipped. `round=all` answers EVERY line of
// the stage (review I2 sweep): the Add match form's round planner reads the whole stage, never the window.
import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { listDivisionFixtures } from "@/server/usecases/fixtures";
import { HttpError } from "@/lib/errors";

export async function GET(req: Request) {
  return v1(async () => {
    const q = new URL(req.url).searchParams;
    const divisionId = q.get("division") ?? "";
    const stageId = q.get("stage") ?? "";
    const all = q.get("round") === "all";
    const round = Number(q.get("round"));
    // `Number("")` is 0, never a round: a missing or blank round is refused with the rest.
    if (divisionId === "" || stageId === "" || (!all && (q.get("round")?.trim() === "" || !Number.isInteger(round) || round < 1))) {
      throw new HttpError(400, "ask for one round, or all of the stage: ?division=&stage=&round=<n|all>");
    }
    const auth = await requireResourceAuth(req, "division", divisionId, "read");
    const rows = (await listDivisionFixtures(auth, divisionId)).filter((f) => f.stage_id === stageId && (all || f.round_no === round));
    if (rows.length === 0) throw new HttpError(404, all ? "stage not found" : "round not found");
    // `round=all` feeds the round planner only, and a stage at the caps holds thousands of lines: just the five fields it reads
    // (`adhocRowOf`), never the desk's whole row.
    const body = all
      ? rows.map((f) => ({ round_no: f.round_no, home_entrant_id: f.home_entrant_id, away_entrant_id: f.away_entrant_id, status: f.status, expunged: f.expunged === true }))
      : rows;
    return reply(200, body, { "Cache-Control": "private, no-store" });
  });
}
