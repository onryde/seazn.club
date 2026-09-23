import "server-only";
// Scorer sheets §4.3 — has this fixture's result moved the competition on?
// Evaluated LIVE at request time: unpairing the next Swiss round re-opens the
// previous one for the umpire's own undo, and nothing is stored that could go
// stale. Consulted by the device-link scoring path (usecases/scoring.ts) and by
// the scan page to choose its View-only screen — one predicate, two askers.
import type { Tx } from "@/lib/db";

export const RESULT_CARRIED_FORWARD = "RESULT_CARRIED_FORWARD";
export const RESULT_CARRIED_FORWARD_MESSAGE =
  "This result has already moved the competition on — ask the organiser to correct it";

export interface CarriedForwardFacts {
  /** `winner_to_fixture`'s `winner_to_slot` side is occupied. */
  winnerFeedFilled: boolean;
  /** `loser_to_fixture`'s `loser_to_slot` side is occupied. */
  loserFeedFilled: boolean;
  /** Swiss only: some board of round_no + 1 in this stage has a side seated. */
  swissNextRoundSeated: boolean;
  /** `stages.status = 'complete'`. */
  stageComplete: boolean;
}

export const NOT_CARRIED: CarriedForwardFacts = {
  winnerFeedFilled: false,
  loserFeedFilled: false,
  swissNextRoundSeated: false,
  stageComplete: false,
};

export function isCarriedForward(f: CarriedForwardFacts): boolean {
  return f.winnerFeedFilled || f.loserFeedFilled || f.swissNextRoundSeated || f.stageComplete;
}

/** Settled but not locked. Only these can have been carried forward: a
 *  scheduled or in-play fixture whose feed target an organiser filled by hand
 *  is still the umpire's to score (Review Focus 2), and finalized/cancelled
 *  keep their own refusals (append-event.ts LOCKED_FIXTURE_STATUSES). */
export const SETTLED_OPEN_STATUSES: ReadonlySet<string> = new Set(["decided", "forfeited", "abandoned"]);

export async function carriedForwardFacts(
  tx: Tx,
  fixtureId: string,
): Promise<{ status: string; facts: CarriedForwardFacts } | null> {
  const [row] = await tx<
    {
      status: string;
      winner_feed_filled: boolean;
      loser_feed_filled: boolean;
      swiss_next_round_seated: boolean;
      stage_complete: boolean;
    }[]
  >`
    select f.status,
      coalesce((select case f.winner_to_slot when 1 then w.home_entrant_id is not null
                                             when 2 then w.away_entrant_id is not null
                                             else false end
                from fixtures w where w.id = f.winner_to_fixture), false) as winner_feed_filled,
      coalesce((select case f.loser_to_slot when 1 then l.home_entrant_id is not null
                                            when 2 then l.away_entrant_id is not null
                                            else false end
                from fixtures l where l.id = f.loser_to_fixture), false) as loser_feed_filled,
      (s.kind = 'swiss' and exists (
         select 1 from fixtures n
         where n.stage_id = f.stage_id and n.round_no = f.round_no + 1
           and (n.home_entrant_id is not null or n.away_entrant_id is not null)
           -- C7: an ad-hoc match (addFixture in stages.ts, ext_key 'adhoc-' || n)
           -- lands at max(round_no)+1 already seated; it is not the next pairing.
           and coalesce(n.ext_key, '') not like 'adhoc-%'
      )) as swiss_next_round_seated,
      (s.status = 'complete') as stage_complete
    from fixtures f join stages s on s.id = f.stage_id
    where f.id = ${fixtureId}`;
  if (!row) return null;
  return {
    status: row.status,
    facts: {
      winnerFeedFilled: row.winner_feed_filled,
      loserFeedFilled: row.loser_feed_filled,
      swissNextRoundSeated: row.swiss_next_round_seated,
      stageComplete: row.stage_complete,
    },
  };
}

export async function resultCarriedForward(tx: Tx, fixtureId: string): Promise<boolean> {
  const loaded = await carriedForwardFacts(tx, fixtureId);
  return loaded !== null && SETTLED_OPEN_STATUSES.has(loaded.status) && isCarriedForward(loaded.facts);
}
