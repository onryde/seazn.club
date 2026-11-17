// W5 app PR A, Task 8 (RB5-W7, X-WDT-5; owner R24 pick 11 A): the footnote under a league or group table that names the
// rule a departure applied — "P1 (withdrawn): left after 2 of 5, so their results are removed and their other matches are
// void." One line per departed entrant of THAT table, under it, on every surface that prints the table.
//
// Its source is the division ledger: the withdrawal cascade (`usecases/withdrawal.ts`) appends one `table_withdrawal` row per
// league or group stage it settled, with the count its decision used (RB5-W4: the entrant's fixtures in the stage at the
// moment of withdrawal, catch-up lines included; decided or finalized counts as played, voided does not). Reinstate voids it
// with a `table_withdrawal_voided` row (append-only, as `joint_winners_*` is), so the footnote goes with the reversal (RB5-W6).
// Neither row is a history step nor an Undo barrier: `isReversible` is false for both, and Undo steps over them.
//
// Pure and client-safe: the public pages and the hub resolve the text with this module; the readers that load the rows live
// server-side (`server/public-site/table-withdrawals.ts`).
import type { TKey } from "@/lib/i18n-runtime";

export const TABLE_WITHDRAWAL_ROW = "table_withdrawal";
export const TABLE_WITHDRAWAL_VOIDED_ROW = "table_withdrawal_voided";
/** Task 8b re-review 2 (ruling C): the cascade's write-ahead row, one per line it is about to expunge, written in its own
 *  transaction BEFORE the line's first void — `{entrant_id, stage_id, fixture_id, planned_void_ids, from_seq}`. A resume and
 *  a Reinstate read only these to take an expunge back; a `table_withdrawal_line_voided` row naming its seq retires it. Not a
 *  history step and not read by the footnote. */
export const TABLE_WITHDRAWAL_LINE_ROW = "table_withdrawal_line";
/** Retires a `table_withdrawal_line` row once its line is taken back (`{voids_seq}`), so nothing is reversed twice. Its own
 *  type, so `table_withdrawal_voided` keeps meaning "the footnote's row is voided". */
export const TABLE_WITHDRAWAL_LINE_VOIDED_ROW = "table_withdrawal_line_voided";

/** W5 T10 fix round 2 (R12; I-1): the durable "owed" marker of a pair a released placed solo left a partner short, written in the
 *  releasing transaction - `{entrant_id, registration_id}` (the pair, and the solo's registration). The release deletes the
 *  placement row, so nothing else keeps the link to the pair; the desk's "withdrawal did not finish" item and the retries read this
 *  row, through `withdrawalOwedSince` (owed while the pair is still in the field and not reinstated since). Not a history step. */
export const PAIR_DISSOLVE_OWED_ROW = "pair_dissolve_owed";

/** W5 T10b (ruling 292): the durable trace of a Reinstate, written for EVERY stage kind in the transaction that puts the entrant back
 *  in the field - `{entrant_id}`. A Swiss or knockout cascade writes no `table_withdrawal` row, so `table_withdrawal_voided` is no
 *  evidence of a Reinstate there; `withdrawalOwedSince` reads this row instead. Not a history step. */
export const WITHDRAWAL_REINSTATED_ROW = "withdrawal_reinstated";

export type TableWithdrawalPolicy = "expunge" | "walkover";

/** One active `table_withdrawal` row, as written (`seq` is its ledger position). */
export interface TableWithdrawalRecord {
  seq: number;
  entrant_id: string;
  stage_id: string;
  policy: TableWithdrawalPolicy;
  played_at_departure: number;
  scheduled: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The rows still in force, oldest first: every `table_withdrawal` no `table_withdrawal_voided` names (`voids_seq`), and of
 * those the latest per (stage, entrant) — a second withdrawal after a Reinstate is the one that holds. A row this module's
 * writer never produces (a missing field, a played count above the scheduled one) is not read: the footnote never prints a
 * count it cannot stand behind.
 */
export function activeTableWithdrawals(ledger: readonly { seq: number; type: string; payload: unknown }[]): TableWithdrawalRecord[] {
  const voided = new Set<number>();
  for (const row of ledger) {
    const of = (row.payload as { voids_seq?: unknown } | null)?.voids_seq;
    if (row.type === TABLE_WITHDRAWAL_VOIDED_ROW && typeof of === "number") voided.add(of);
  }
  const latest = new Map<string, TableWithdrawalRecord>();
  for (const row of [...ledger].sort((a, b) => a.seq - b.seq)) {
    if (row.type !== TABLE_WITHDRAWAL_ROW || voided.has(row.seq)) continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (typeof p.entrant_id !== "string" || typeof p.stage_id !== "string") continue;
    if (p.policy !== "expunge" && p.policy !== "walkover") continue;
    if (!isCount(p.played_at_departure) || !isCount(p.scheduled) || p.played_at_departure > p.scheduled) continue;
    latest.set(`${p.stage_id}|${p.entrant_id}`, {
      seq: row.seq,
      entrant_id: p.entrant_id,
      stage_id: p.stage_id,
      policy: p.policy,
      played_at_departure: p.played_at_departure,
      scheduled: p.scheduled,
    });
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/** The departed statuses a table marks (the same two `DEPARTED_STATUS_CHIPS` chips). */
export type DepartedTableStatus = "withdrawn" | "disqualified";
const DEPARTED: ReadonlySet<string> = new Set<DepartedTableStatus>(["withdrawn", "disqualified"]);

export interface WithdrawalNote {
  entrantId: string;
  name: string;
  status: DepartedTableStatus;
  policy: TableWithdrawalPolicy;
  played: number;
  scheduled: number;
}

/**
 * The notes of ONE table: its stage's active rows for the entrants it lists (`tableEntrantIds`, in the table's own order — a
 * pool's table names only its pool), and only while the entrant is still departed. A reinstated entrant's row is voided by
 * the Reinstate; one whose reversal the cascade did not run (a table already complete) is back in the field, and a footnote
 * about a player who is playing would be false.
 */
export function withdrawalNotesFor(
  stageId: string,
  tableEntrantIds: readonly string[],
  records: readonly TableWithdrawalRecord[],
  statuses: Readonly<Record<string, string>>,
  names: Readonly<Record<string, string>>,
): WithdrawalNote[] {
  const byEntrant = new Map(records.filter((r) => r.stage_id === stageId).map((r) => [r.entrant_id, r]));
  const out: WithdrawalNote[] = [];
  for (const id of tableEntrantIds) {
    const record = byEntrant.get(id);
    const status = statuses[id];
    if (record === undefined || status === undefined || !DEPARTED.has(status)) continue;
    out.push({
      entrantId: id,
      name: names[id] ?? id,
      status: status as DepartedTableStatus,
      policy: record.policy,
      played: record.played_at_departure,
      scheduled: record.scheduled,
    });
  }
  return out;
}

/** One footnote line, resolved: the bold lead ("P1 (withdrawn):") and the sentence after it. */
export interface WithdrawalNoteText {
  entrantId: string;
  lead: string;
  body: string;
}

/** The sentence's key and its numbers. Never "left after 0 of 0" (R24 item 11): nothing scheduled has its own line. An
 *  expunge with nothing played removes no result, so it says only that the matches are void. */
export function withdrawalNoteBody(note: Pick<WithdrawalNote, "policy" | "played" | "scheduled">): {
  key: TKey;
  vars: Record<string, number>;
} {
  const { played, scheduled } = note;
  const remaining = scheduled - played;
  if (scheduled === 0) return { key: "table.withdrawalNote.none", vars: {} };
  if (note.policy === "expunge") {
    return { key: played === 0 ? "table.withdrawalNote.expungedUnplayed" : "table.withdrawalNote.expunged", vars: { played, scheduled } };
  }
  if (remaining === 0) return { key: "table.withdrawalNote.stood", vars: { played, scheduled } };
  if (remaining === 1) return { key: "table.withdrawalNote.walkedOverOne", vars: { played, scheduled } };
  return { key: "table.withdrawalNote.walkedOver", vars: { played, scheduled, remaining } };
}

const STATUS_KEY: Record<DepartedTableStatus, TKey> = {
  withdrawn: "table.withdrawalNote.status.withdrawn",
  disqualified: "table.withdrawalNote.status.disqualified",
};

export function withdrawalNoteText(
  note: WithdrawalNote,
  msg: (key: TKey, vars?: Record<string, string | number>) => string,
): WithdrawalNoteText {
  const body = withdrawalNoteBody(note);
  return {
    entrantId: note.entrantId,
    lead: msg("table.withdrawalNote.lead", { name: note.name, status: msg(STATUS_KEY[note.status]) }),
    body: msg(body.key, body.vars),
  };
}
