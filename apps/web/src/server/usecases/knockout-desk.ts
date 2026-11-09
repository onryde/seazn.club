import "server-only";
// W4 app-A Tasks 19 + 20 (lane B6a): what a knockout stage card on the division's Fixtures tab reads for the organiser.
//
// - `listKnockoutWaiting` (T19, X-LE-10; R24 pick 1A): the players waiting to join a started root knockout — an
//   automatic arrival (a paid or confirmed registration, a waitlist promotion, an import, a Reinstate) the app never
//   places by itself (ruling 271). The card lists them in a "Waiting to join the bracket" strip, one "Add to bracket"
//   each (the tap, `placeWaitingKnockoutEntrant`). The SAME set the desk's `late_players_waiting` row counts
//   (`competition-desk.ts`: the marker, on a stage that is not complete, an entrant still in the field), so the row's
//   "Open bracket" always lands on a card that lists someone to add.
// - `listStageDrawSeeds` (T20, K5 "shown"; R24 pick 3A): the seed each stage's newest Generate drew with
//   (`readStageDrawSeed`, the ONE reader of that ledger field) — shown under the stage header as "Draw #…".
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { DEPARTED_STATUSES } from "./entrants";
import { readStageDrawSeed } from "./stages";

export interface KnockoutWaitingEntrant {
  entrantId: string;
  stageId: string;
  name: string;
  /** The entry was paid online and not fully refunded: a refused tap's exit names a refund (B3 review #5). */
  paid: boolean;
  /** The registration the entrant came from, if any (the Registrations hub filters to it). */
  registrationId: string | null;
}

/** The division's waiting players, in arrival order (`created_at`, then id). */
export async function listKnockoutWaiting(auth: AuthCtx, divisionId: string): Promise<KnockoutWaitingEntrant[]> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<{ id: string; stage_id: string; display_name: string; paid: boolean; registration_id: string | null }[]>`
      select e.id, e.knockout_waiting_stage_id as stage_id, e.display_name,
             exists (select 1 from registrations r join registration_groups g on g.id = r.group_id
                      where r.entrant_id = e.id and g.payment_intent_id is not null
                        and r.amount_cents > r.refunded_cents) as paid,
             (select r.id from registrations r where r.entrant_id = e.id order by r.created_at desc, r.id limit 1) as registration_id
        from entrants e
        join stages s on s.id = e.knockout_waiting_stage_id
       where e.division_id = ${divisionId}
         and s.status <> 'complete'
         and e.status not in ${tx([...DEPARTED_STATUSES])}
       order by e.created_at, e.id`;
    return rows.map((r) => ({
      entrantId: r.id,
      stageId: r.stage_id,
      name: r.display_name,
      paid: r.paid,
      registrationId: r.registration_id,
    }));
  });
}

/** Each stage of the division whose newest Generate drew its field at random, with the seed it drew with. A stage that
 *  drew nothing (a seeded field, a fed bracket, nothing generated) is absent. */
export async function listStageDrawSeeds(auth: AuthCtx, divisionId: string): Promise<Record<string, number>> {
  return withTenant(auth.orgId, async (tx) => {
    const stages = await tx<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq`;
    const out: Record<string, number> = {};
    for (const s of stages) {
      const seed = await readStageDrawSeed(tx, s.id);
      if (seed !== null) out[s.id] = seed;
    }
    return out;
  });
}
