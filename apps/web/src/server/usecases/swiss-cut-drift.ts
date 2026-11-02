import "server-only";
// W3 Task 17 (RB3-19, X-SW-25) — the desk's read of "did a correction after the knockout began move the Swiss cut?"
//
// A correction to a decided Swiss board is NOT refused once the Swiss is complete or the knockout is under way
// (`LOCKED_FIXTURE_STATUSES` is {finalized, cancelled}; `onDecided` re-ranks the stage and re-stales the dependent
// proposal, which a confirmed one ignores). So the table can move under a bracket that is already seated — and the
// bracket STANDS: nothing here, or in the correction, touches a seat. What the organiser is owed is the fact, with the
// names. This reads three things:
//
//   1. the FROZEN cut — who the bracket was seeded from:
//        - `config.qualified` of the stage after the Swiss, when it is an array. Only a `timing: "on_complete"` next stage
//          writes it (`seedNextStage`, at completion);
//        - otherwise the entrants SEATED in that stage's fixtures. A `timing: "setup"` next stage — swiss_knockout and
//          swiss_playoff, the shapes RB3-19 is about — is filled by the confirmed proposal and never writes
//          `config.qualified` at all, so the seats ARE its frozen cut (an unconfirmed bracket has none: no cut, no drift);
//   2. TODAY'S top q — the Swiss stage's live ranking (`rankedStageStandings`, the cascade the standings tab renders),
//      read through the SAME eligibility the cut itself uses (`cutEligiblePools`, T15 Carry A): a withdrawn or
//      disqualified entrant leaves the cut and the next eligible entrant backfills, so a departed entrant is never
//      "would qualify". q is the number of frozen qualifiers still in the field, so one who left AFTER the bracket was
//      seeded (her seat stands, as a walkover) is no drift on her own;
//   3. whether the knockout has BEGUN — a fixture of that stage holding a result (`fixtureHasResultSql`: a generated
//      bye is no start, the same reading `swissIsOver` takes).
//
// A display read: no locks, nothing written by the read itself. The ranking is the stage's own; a lots draw it may have
// to make is stored exactly as the correction's own recompute stores it (`on conflict do nothing`, a racing writer's
// draw wins for both), so the table this names is the table the standings tab shows.
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
 * not a complete Swiss, a Swiss with no stage after it or one that draws from nothing, a bracket not yet seated, a
 * knockout that has not begun, and a cut that today's table still makes. 404 for an unknown stage or another
 * organisation's (RLS).
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

    const frozen = await frozenCutOf(tx, next);
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

/** The cut the stage after the Swiss was seeded from (see the header). Distinct ids, in a stable order. */
async function frozenCutOf(tx: Tx, next: { id: string; config: Record<string, unknown> }): Promise<string[]> {
  const stored = next.config.qualified;
  if (Array.isArray(stored)) return [...new Set(stored.filter((id): id is string => typeof id === "string"))];
  const seats = await tx<{ home: string | null; away: string | null }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures
    where stage_id = ${next.id} order by round_no, seq_in_round, id`;
  return [...new Set(seats.flatMap((seat) => [seat.home, seat.away]).filter((id): id is string => id !== null))];
}
