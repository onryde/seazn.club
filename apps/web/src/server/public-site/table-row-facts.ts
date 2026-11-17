// W5 app PR A, Task 5b (X-CU-10, RB5-L5; owner R24 pick 2 A) - the per-row facts a ROUND-ROBIN standings table marks: while a late
// entrant still has undecided catch-up lines (`rr-cu-` / `rr-by-`, Task 5), her row reads "Joined round N". No missed round is
// scored as a loss; the marker only says why her played count is short of everyone else's.
//
// Where it reads from, and when it stops: the round she joined is the `joined_round` of the `roundrobin_late_entry` ledger row Task 5
// wrote when she arrived (the round the table was on THEN - not derivable from the lines afterwards). The row is append-only, so the
// marker is a READ CONDITION, not a write: it shows only while an ACTIVE entrant still holds an undecided catch-up line of that
// stage. The last line decided, a Rebuild (it regenerates every line, the prefix is gone) and a withdrawal (she leaves the field)
// each end it, with nothing to clean up.
//
// The Swiss path (`swissRowFactsFor`) is untouched and is tried first; this answers for a league or a group. The Sits-out fact
// (`config.round_byes`) is deliberately NOT turned into a "Bye R{n}" chip here: on an odd field every row would carry one, and the
// owner-approved screens put that fact on the round bar (Task 3), not on the table.
import { DEPARTED_STATUS_CHIPS } from "@/components/public-site/standings-table";
import { sql } from "@/lib/db";
import { isCatchUpExtKey } from "@/lib/roundrobin-late-entry";
import { swissRowFactsFor, type RowFactsFixture, type SwissRowFacts } from "./swiss-row-facts";

/** One ledger row's claim: this entrant joined this stage at this round. */
export interface RrLateJoin {
  stageId: string;
  entrantId: string;
  joinedRound: number;
}

/** The columns of a fixture this reads (the loaders' rows carry them all). */
export interface TableFactsFixture {
  stage_id: string;
  ext_key?: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status?: string;
}

/** A line with no result yet: it still owes a score (a held `needs_decision` included). Every other status is settled or void. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play", "needs_decision"]);

/**
 * The ledger's late-entry rows of a division, read only when a catch-up line exists in `fixtures` (the common division has none, so
 * most reads cost nothing). A later row for the same entrant and stage wins. Rows with no integer `joined_round` above 1 are dropped:
 * round 1 is a newcomer who missed nothing (a Rebuild's `rebuilt` row, or an arrival before anything started).
 */
export async function loadRrLateJoins(divisionId: string, fixtures: readonly { ext_key?: string | null }[]): Promise<RrLateJoin[]> {
  if (!fixtures.some((f) => isCatchUpExtKey(f.ext_key ?? null))) return [];
  const rows = await sql<{ payload: unknown }[]>`
    select payload from division_events where division_id = ${divisionId} and type = 'roundrobin_late_entry' order by seq`;
  const latest = new Map<string, RrLateJoin>();
  for (const { payload } of rows) {
    const p = payload as { stage_id?: unknown; entrant_id?: unknown; joined_round?: unknown } | null;
    if (p === null || typeof p.stage_id !== "string" || typeof p.entrant_id !== "string") continue;
    if (!Number.isInteger(p.joined_round) || (p.joined_round as number) <= 1) {
      latest.delete(`${p.stage_id}|${p.entrant_id}`);
      continue;
    }
    latest.set(`${p.stage_id}|${p.entrant_id}`, { stageId: p.stage_id, entrantId: p.entrant_id, joinedRound: p.joined_round as number });
  }
  return [...latest.values()];
}

/**
 * The marked rows of one league or group stage, keyed by entrant id: an entrant with a ledger row, still in the field
 * (`entrantStatuses` is every entrant's status; a status in the table's own departed vocabulary is out), who holds at least one
 * undecided catch-up line of the stage. `fixtures` and `joins` are the stage's (`rowFactsFor` filters).
 */
export function tableRowFacts(
  fixtures: readonly TableFactsFixture[],
  joins: readonly RrLateJoin[],
  entrantStatuses: Readonly<Record<string, string>>,
): Record<string, SwissRowFacts> {
  const out: Record<string, SwissRowFacts> = {};
  for (const j of joins) {
    const status = entrantStatuses[j.entrantId];
    if (status === undefined || status in DEPARTED_STATUS_CHIPS) continue;
    if (j.joinedRound <= 1) continue; // the loader drops these too; a caller's own list must not mark "Joined round 1" either
    const undecided = fixtures.some(
      (f) =>
        f.stage_id === j.stageId &&
        isCatchUpExtKey(f.ext_key ?? null) &&
        OPEN_STATUSES.has(f.status ?? "") &&
        (f.home_entrant_id === j.entrantId || f.away_entrant_id === j.entrantId),
    );
    if (undecided) out[j.entrantId] = { byeRounds: [], joinedRound: j.joinedRound, catchUp: true };
  }
  return out;
}

/**
 * The one entry the four pages and the hub call: a Swiss stage's facts as before, a league's or group's from the ledger, and
 * undefined for any other stage (a bracket has no table row). `fixtures` is the whole division's; `joins` come from `loadRrLateJoins`.
 */
export function rowFactsFor(
  stage: { id: string; kind: string },
  fixtures: readonly RowFactsFixture[],
  rows: readonly { entrantId: string }[],
  joins: readonly RrLateJoin[],
  entrantStatuses: Readonly<Record<string, string>>,
): Record<string, SwissRowFacts> | undefined {
  if (stage.kind === "swiss") return swissRowFactsFor(stage, fixtures, rows);
  if (stage.kind !== "league" && stage.kind !== "group") return undefined;
  const onTable = new Set(rows.map((r) => r.entrantId));
  const mine = tableRowFacts(
    fixtures.filter((f) => f.stage_id === stage.id),
    joins.filter((j) => j.stageId === stage.id),
    entrantStatuses,
  );
  return Object.fromEntries(Object.entries(mine).filter(([id]) => onTable.has(id)));
}
