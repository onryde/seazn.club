import "server-only";
// W3 Task 17 (RB3-19, X-SW-25) — the desk's read of "did a correction after the knockout began move the Swiss cut?"
//
// A correction to a decided Swiss board is NOT refused once the Swiss is complete or the knockout is under way
// (`LOCKED_FIXTURE_STATUSES` is {finalized, cancelled}; `onDecided` re-ranks the stage and re-stales the dependent
// DRAFT proposals, which a confirmed one ignores). So the table can move under a bracket that is already seated — and
// the bracket STANDS: nothing here, or in the correction, touches a seat. What the organiser is owed is the fact, with
// the names. This reads three things:
//
//   1. the FROZEN cut — the TABLE's cut when the bracket was seeded, never the seats (an organiser's tie pick or
//      `edits[]` override seats someone the table did not put in, which is a choice, not a correction: RB3-19 warns about
//      CORRECTIONS). Where it is read from depends on the next stage's timing:
//        - `timing: "on_complete"`: `config.qualified`, written once by `seedNextStage` at completion from
//          `resolveProgression` over the completed tables — the table's cut, no organiser step in between;
//        - `timing: "setup"` (swiss_knockout and swiss_playoff, the shapes RB3-19 is about): no `config.qualified`
//          exists. The confirmed proposal's `computed.qualifiers` is the table's cut as it stood when the draft was
//          computed; `confirmSeedProposal` applies picks and edits to the SEATS only and leaves `computed` as it was,
//          and only a draft is ever re-staled. A BEGUN bracket with no confirmed proposal is an invariant breach (thrown by name);
//   2. TODAY'S top q — the Swiss stage's live ranking (`rankedStageStandings`, the cascade the standings tab renders),
//      read through the SAME eligibility the cut itself uses (`cutEligiblePools`, T15 Carry A): a withdrawn or
//      disqualified entrant leaves the cut and the next eligible entrant backfills, so a departed entrant is never
//      "would qualify". q is the number of frozen qualifiers still in the field, so one who left AFTER the bracket was
//      seeded (her seat stands, as a walkover) is no drift on her own;
//   3. whether the knockout has BEGUN — a fixture of that stage holding a result (`fixtureHasResultSql`: a generated
//      bye is no start, the same reading `swissIsOver` takes).
//
// A display read, taking no lock. It writes nothing of its own, with one exception it shares with every reader of the
// ranking: `rankedStageStandings` stores a lots draw the first time a level class has to be drawn (`persistLotsDraws`,
// `on conflict do nothing` — a racing writer's draw wins for both), exactly as the correction's own recompute and the
// standings tab do. So a GET of the route or a render of the Fixtures tab can persist a draw; it is the one the table
// shows, never a second one.
import type postgres from "postgres";
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { swissCutDrift, type SwissCutDrift } from "@/lib/swiss-cut-drift";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { fixtureHasResultSql } from "./fixture-results-sql";
import { cutEligiblePools } from "./stage-seeding";
import { departedEntrantIds } from "./stages";

export type { SwissCutDrift };

/**
 * Who a correction moved across the Swiss cut after the knockout began, or null (no warning). Null for: a stage that is
 * not a complete Swiss, a Swiss with no stage after it (the commonest shape: a Swiss on its own) or one that draws from
 * nothing, a knockout that has not begun (which also covers an unseated or unconfirmed bracket),
 * and a cut that today's table still makes. 404 for an unknown stage or another organisation's (RLS). Throws (a 500, loud
 * on purpose) when the knockout HAS begun yet no cut was ever recorded for it: see `frozenCutOf`.
 */
export async function getSwissCutDrift(auth: AuthCtx, swissStageId: string): Promise<SwissCutDrift | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [swiss] = await tx<{ id: string; division_id: string; seq: number; kind: string; status: string }[]>`
      select id, division_id, seq, kind, status from stages where id = ${swissStageId}`;
    if (!swiss) throw new HttpError(404, "stage not found");
    if (swiss.kind !== "swiss" || swiss.status !== "complete") return null;

    const [next] = await tx<{ id: string; progression: unknown; config: Record<string, unknown> }[]>`
      select id, progression, config from stages
      where division_id = ${swiss.division_id} and seq > ${swiss.seq}
      order by seq limit 1`;
    if (!next || !next.progression) return null;

    const [began] = await tx`
      select 1 from fixtures f where f.stage_id = ${next.id} and ${fixtureHasResultSql(tx, "f")} limit 1`;
    const knockoutStarted = began !== undefined;
    if (!knockoutStarted) return null;

    const frozen = await frozenCutOf(tx, next, swiss.id);
    const departed = await departedEntrantIds(tx, swiss.division_id);
    const ranked = [...(await rankedStageStandings(tx, swiss.id))].sort(
      (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
    );
    // The cut's own eligibility: departed rows move to the bottom, the eligible ones renumbered in table order.
    const [table] = cutEligiblePools(swiss.kind, [{ pool: "", rows: ranked }], departed);
    const place = new Map((table?.rows ?? []).map((row, i) => [row.entrantId, i] as const));
    // Still in the field AND ranked by this Swiss (a stage fed by several sources can seat entrants it never ranked —
    // they are not this cut's to drift), in table order so both lists read in rank order.
    const live = frozen.filter((id) => !departed.has(id) && place.has(id)).sort((a, b) => place.get(a)! - place.get(b)!);
    const currentTop = (table?.rows ?? []).slice(0, live.length).map((row) => row.entrantId);
    return swissCutDrift(live, currentTop, knockoutStarted);
  });
}

type Tx = postgres.TransactionSql;

/** The table's cut the stage after the Swiss was seeded from (see the header). Distinct ids, in a stable order.
 *
 *  Only called once the knockout HAS BEGUN (a fixture of the stage holds a result), so the bracket is seated and its seating
 *  recorded a cut: an `on_complete` stage by `seedNextStage` (`config.qualified`), a `setup` stage by `confirmSeedProposal`
 *  (a confirmed proposal whose `computed.qualifiers` stays the table's cut). A begun bracket with neither is an invariant
 *  breach - something seated and played it without the recorded cut - and is refused by name rather than read as "no drift"
 *  (a silent null would hide the very warning this read exists to give). An unseated or not-yet-confirmed bracket never
 *  reaches here: it has no result, so `getSwissCutDrift` has already answered null. */
async function frozenCutOf(tx: Tx, next: { id: string; config: Record<string, unknown> }, swissStageId: string): Promise<string[]> {
  const stored = next.config.qualified;
  const ids = (list: unknown[]) => [...new Set(list.filter((id): id is string => typeof id === "string"))];
  if (Array.isArray(stored)) return ids(stored);
  const [confirmed] = await tx<{ computed: { qualifiers?: { entrantId?: unknown }[] } | null }[]>`
    select computed from stage_seed_proposals
    where stage_id = ${next.id} and status = 'confirmed'
    order by confirmed_at desc nulls last, id limit 1`;
  const qualifiers = confirmed?.computed?.qualifiers;
  if (!Array.isArray(qualifiers)) {
    throw new Error(
      `getSwissCutDrift: stage ${next.id} (after Swiss ${swissStageId}) has a result but no recorded cut - ` +
        `no config.qualified array and ${confirmed ? "a confirmed proposal without a computed.qualifiers array" : "no confirmed proposal"}`,
    );
  }
  return ids(qualifiers.map((q) => q.entrantId));
}
