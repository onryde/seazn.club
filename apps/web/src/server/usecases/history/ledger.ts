import "server-only";
import type postgres from "postgres";
import { HistoryError, type LedgerEvent } from "@seazn/engine/history";
import { EngineError } from "@seazn/engine/core";
import { HttpError } from "@/lib/errors";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { byeLineSql } from "@/server/engine-db/system-bye-sql";

export type Tx = postgres.TransactionSql;

// EngineError codes for the doc 08 §1 map: 409 for stale clients, 422 rest.
export function toEngineError(err: unknown): never {
  if (err instanceof HistoryError) {
    if (err.code === "UNDO_BLOCKED_HAS_RESULTS") {
      throw new EngineError("ALREADY_DECIDED", err.message, { code: err.code });
    }
    throw new HttpError(422, err.message);
  }
  throw err;
}

export async function loadLedger(tx: Tx, divisionId: string): Promise<LedgerEvent[]> {
  const rows = await tx<{ seq: string | number; type: string; payload: Record<string, unknown> }[]>`
    select seq, type, payload from division_events
    where division_id = ${divisionId} order by seq`;
  return rows.map((r) => ({ seq: Number(r.seq), type: r.type, payload: r.payload }));
}

// What history treats as PLAYED is rebuild's refusal set,
// `fixtureHasResultSql` (./fixture-results-sql.ts; review 2 of #857, I3). It
// was `'decided'` alone, then three statuses: undoing a generation, and
// redoing or making a pool clear, deleted an in-play, a finalized, an
// abandoned or a walkover fixture outright, its score events cascading with
// it — the results-guard ("never silently discard a scoresheet", engine
// history.ts) never saw those scoresheets. `playedFixtureIds` is the guard's
// input: any undo/redo whose op touches one is refused whole
// (`UNDO_BLOCKED_HAS_RESULTS`).

/** The same rule at the row, for every write `execute()` makes: the engine
 *  refuses first, and this still skips a row that started playing since. On
 *  the target row itself (`fixtures`, unaliased), not a re-read of it, so a
 *  write parked on the row's lock re-checks the row it finally gets. */
export const unplayed = (tx: Tx) => tx`not ${fixtureHasResultSql(tx, "fixtures")}`;

/** W3 T5 (X-SW-29; T3 review m3): a replayed PLACEMENT never lands on a bye line. A bye is not played, so it holds no
 *  court and no time (`byeLineSql`, the SQL twin of the one bye-line predicate: a Swiss bye shell, and since W4 T3 (K2,
 *  X-SD-5) a bracket's bye line, pre-award or awarded), and no writer since records one — but a ledger row written
 *  before can name one among its moves, and V485/V493 cleared the slot without touching the ledger. An Undo walking
 *  back reaches those rows, and a Redo replays them. On the target row itself, like `unplayed`, on every statement
 *  below that writes a slot. */
export const slotTaker = (tx: Tx) => tx`not ${byeLineSql(tx, "fixtures")}`;

interface DivisionMeta {
  seq: number;
  edit_watermark: number | null;
  competition_id: string;
}

export async function divisionMeta(tx: Tx, divisionId: string): Promise<DivisionMeta> {
  const [row] = await tx<{ seq: number; edit_watermark: string | number | null; competition_id: string }[]>`
    select seq, edit_watermark, competition_id from divisions where id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return {
    seq: Number(row.seq),
    edit_watermark: row.edit_watermark === null ? null : Number(row.edit_watermark),
    competition_id: row.competition_id,
  };
}

export async function appendEvent(
  tx: Tx,
  divisionId: string,
  event: { type: string; payload: Record<string, unknown> },
  actorId: string | null,
): Promise<number> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from division_events
    where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${event.type},
            ${tx.json(event.payload as never)}, ${actorId})`;
  return last + 1;
}
