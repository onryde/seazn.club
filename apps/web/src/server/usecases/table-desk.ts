import "server-only";
// W5 app-A Task 23 (X-CU-8, X-CU-11; R24 picks 1A and 3A, owner 2026-11-16): the desk's reads for a late player joining a running
// ROOT league or group — the neighbour of `knockout-desk.ts`.
// - `listTableWaiting` (X-CU-8; Task 6 ruling I2): the players an automatic door (a paid or confirmed registration, a waitlist
//   promotion, an import, a Reinstate) left WAITING on the table (`entrants.table_waiting_stage_id`, V529). The stage card lists them
//   in a "Waiting to join the table" strip, one "Add to the table" each (the tap, `placeWaitingTableEntrant`). The SAME set the
//   desk's `late_players_waiting` row counts (`competition-desk.ts`: the marker, on a stage that is not complete, an entrant still
//   in the field), so the row's "Open fixtures" always lands on a strip that lists someone to add.
// - `readTableLatePools` (X-CU-11): the pools of the running root GROUP a late player can join, each with its size and how many
//   matches a newcomer would owe there, and the pool the server picks when none is named (`choosePool`: the smallest, ties by the
//   seed snake) — the add form's and the strip's Group field. The members are counted exactly as the admission counts them
//   (`readTableLatePlace`): entrants still in the field seated on the pool's table lines.
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { tableLateEntryOffered } from "@/lib/open-entry-stages";
import { isRrExtKey } from "@/lib/roundrobin-reconcile";
import { choosePool } from "@/lib/roundrobin-late-entry";
import { DEPARTED_STATUSES } from "./entrants";
import { stageHasStarted } from "./fixture-started-sql";
import type { KnockoutWaitingEntrant } from "./knockout-desk";
import { legsOf, rootTableStages } from "./roundrobin-late-entry";

/** The division's players waiting on its root table, in arrival order (`created_at`, then id) — the knockout list's shape. */
export async function listTableWaiting(auth: AuthCtx, divisionId: string): Promise<KnockoutWaitingEntrant[]> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<{ id: string; stage_id: string; display_name: string; paid: boolean }[]>`
      select e.id, e.table_waiting_stage_id as stage_id, e.display_name,
             -- the knockout list's own test (knockout-desk.ts): THIS entry's card payment, net of its refunds.
             exists (select 1 from registrations r
                      where r.entrant_id = e.id and r.payment_intent_id is not null
                        and r.amount_cents > r.refunded_cents - r.late_refunded_cents) as paid
        from entrants e
        join stages s on s.id = e.table_waiting_stage_id
       where e.division_id = ${divisionId}
         and s.status <> 'complete'
         and e.status not in ${tx([...DEPARTED_STATUSES])}
       order by e.created_at, e.id`;
    return rows.map((r) => ({ entrantId: r.id, stageId: r.stage_id, name: r.display_name, paid: r.paid }));
  });
}

export interface TableLatePool {
  /** The pool's key (its letter): what `late_entry_pool` / the tap's `pool_key` names. */
  key: string;
  /** Entrants still in the field seated in it. */
  size: number;
  /** The matches a newcomer would owe there: one per member per leg. */
  owes: number;
}

export interface TableLatePools {
  stageId: string;
  kind: "league" | "group";
  /** In key order. Empty for a league (it has no pools); ONE for a one-pool group, which shows no picker (owner R24). */
  pools: TableLatePool[];
  /** The pool the server joins when none is named; null when there is no choice (a league, one pool). */
  defaultKey: string | null;
  /** Fix round 1 I1 (R24 7A): nothing in the stage has started (`stageHasStarted`, the predicate the late-entry decision reads for
   *  `rebuild_offered`) — so Rebuild fixtures would take, and the waiting strip offers it beside "Add to the table". */
  rebuildable: boolean;
}

/**
 * The running root table of a STARTED division that a late player can join now (`tableLateEntryOffered`, the rail's own rule),
 * and its pools. Null when there is none — before Start, a fed table, a finished one, or one with no fixtures drawn.
 */
export async function readTableLatePools(auth: AuthCtx, divisionId: string, divisionStatus: string): Promise<TableLatePools | null> {
  return withTenant(auth.orgId, async (tx) => {
    const roots = await rootTableStages(tx, divisionId);
    const stage = roots[0];
    if (stage === undefined) return null;
    const lines = await tx<{ ext_key: string | null; pool_id: string | null; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select ext_key, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage.id}`;
    const all = await tx<{ id: string; seq: number; status: string; kind: string; progression: unknown; config: Record<string, unknown> }[]>`
      select id, seq, status, kind, progression, config from stages where division_id = ${divisionId} order by seq`;
    const self = all.find((s) => s.id === stage.id)!;
    if (!tableLateEntryOffered({ stage: self, division: all, divisionStatus, generated: lines.length > 0 })) return null;
    const kind = stage.kind === "group" ? "group" : "league";
    const table = lines.filter((l) => isRrExtKey(l.ext_key));
    const pools = await tx<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stage.id}`;
    const active = new Set(
      (
        await tx<{ id: string }[]>`
          select id from entrants where division_id = ${divisionId} and status not in ${tx([...DEPARTED_STATUSES])}`
      ).map((e) => e.id),
    );
    const legs = legsOf(stage.config);
    const linePools = new Set(table.map((l) => l.pool_id));
    const members = new Map<string, string[]>();
    for (const p of pools) {
      if (!linePools.has(p.id)) continue;
      const seated = new Set(table.filter((l) => l.pool_id === p.id).flatMap((l) => [l.home_entrant_id, l.away_entrant_id]));
      members.set(p.key, [...seated].filter((id): id is string => id !== null && active.has(id)));
    }
    const keys = [...members.keys()].sort();
    const out = keys.map((key) => ({ key, size: members.get(key)!.length, owes: members.get(key)!.length * legs }));
    return {
      stageId: stage.id,
      kind,
      pools: kind === "group" ? out : [],
      defaultKey: kind === "group" && keys.length > 1 ? choosePool(members) : null,
      rebuildable: !(await stageHasStarted(tx, stage.id)),
    };
  });
}
