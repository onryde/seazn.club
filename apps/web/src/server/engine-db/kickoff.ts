import "server-only";
// A match's kick-off, read from its ledger (owner ruling 10-31 (3), Match Day task F3; the engine session's answer to Q2). The
// kick-off is the LAST `core.start` that is still active once the ledger's voids are applied — `resolveVoids`, the engine's own
// reading of a void, never a second copy of it. A Start the scorer voided (a false start, a restart) is not the kick-off. A
// ledger with two ACTIVE Starts cannot be written through the engine (every kernel refuses a second start: "already started"),
// but one the write path did not author (an import, a raw write) can hold them; the last is when the match is under way from.
//
// `fixtures` has no kick-off column (V214), and `scheduled_at` is a plan, not an event: this is the one place the server asks
// "when did it start". Two readers share it, so they cannot disagree: Match Day's board (`match-day.ts`, a court's busy-until and
// "Started 11:20") and the competition desk's in-play cards and phase (`competition-desk.ts`).
import type postgres from "postgres";
import { resolveVoids, type EventEnvelope } from "@seazn/engine/core";

/** A kick-off, twice: the instant as postgres.js returns it (a millisecond `Date`), and the SAME instant at the microsecond
 *  precision Postgres stores, fixed-width UTC — a sort key, so two kick-offs inside one millisecond still order (the desk's
 *  in-play cards, `competition-desk.ts`). */
export interface Kickoff {
  at: Date;
  key: string;
}

interface StartRow {
  fixture_id: string;
  id: string;
  seq: number;
  type: string;
  voids: string | null;
  recorded_at: Date;
  recorded_key: string;
}

/**
 * fixture id → its kick-off, for each of `fixtureIds` that has one; a match with no active Start is absent. ONE query for the
 * lot, and none for an empty list.
 *
 * Only the events the answer depends on are read: every `core.start`, and every `core.void` whose target is one. That subset is
 * a valid ledger for `resolveVoids` (each void's target is in it, earlier — a void follows what it voids), and it gives the same
 * active Starts as the whole ledger: a void is never itself voidable, so a Start is active exactly when no void names it.
 */
export async function kickoffsOf(db: postgres.Sql | postgres.TransactionSql, fixtureIds: readonly string[]): Promise<Map<string, Kickoff>> {
  const out = new Map<string, Kickoff>();
  const ids = [...new Set(fixtureIds)];
  if (ids.length === 0) return out;
  const rows = await db<StartRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.voids_event_id as voids, se.recorded_at,
           to_char(se.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as recorded_key
      from score_events se
     where se.fixture_id in ${db(ids)}
       and (se.type = 'core.start'
            or (se.type = 'core.void'
                and exists (select 1 from score_events t where t.id = se.voids_event_id and t.type = 'core.start')))
     order by se.fixture_id, se.seq`;
  const ledgers = new Map<string, EventEnvelope[]>();
  const byEvent = new Map<string, StartRow>();
  for (const r of rows) {
    byEvent.set(r.id, r);
    let ledger = ledgers.get(r.fixture_id);
    if (ledger === undefined) ledgers.set(r.fixture_id, (ledger = []));
    ledger.push({
      id: r.id,
      fixtureId: r.fixture_id,
      seq: Number(r.seq),
      type: r.type,
      payload: {},
      recordedAt: r.recorded_key,
      recordedBy: null,
      ...(r.voids === null ? {} : { voids: r.voids }),
    });
  }
  for (const [fixtureId, ledger] of ledgers) {
    const starts = resolveVoids(ledger).filter((e) => e.type === "core.start");
    const last = starts[starts.length - 1];
    if (last === undefined) continue;
    const row = byEvent.get(last.id);
    if (row === undefined) throw new Error(`kickoffsOf: an active start ${last.id} has no row`);
    out.set(fixtureId, { at: new Date(row.recorded_at), key: row.recorded_key });
  }
  return out;
}
