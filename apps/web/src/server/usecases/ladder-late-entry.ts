import "server-only";
// A late entrant to a RUNNING ladder joins the bottom of its order.
//
// `stage.config.ladder_order` is INITIALISED by the first challenge, from the field as it stood then (stages/ad-hoc.ts
// `issueChallenge`); before this module nothing extended it. Anyone admitted afterwards - an organiser's late add, a registration, an import, or a reinstated
// entrant who was out of the field at that first challenge - sat in no rung: every challenge naming them refused
// LADDER_ENTRANT_FOREIGN and the ladder panel, which lists the order, did not show them. The builder's promise that a
// ladder takes late joiners by design could never be kept.
//
// WHERE: the bottom. The engine declares no ladder-entry rule (its late-entry rows are knockout, Swiss and stepladder
// entry); the convention is the one the order is first written in - seed order, then creation - so a newcomer is the
// youngest seed and sits below everyone. Nobody else moves, and a rung already held is never touched: a withdrawn
// entrant keeps theirs (the order is never pruned, see `issueChallenge`), so a reinstatement of one who held a rung finds
// them in it and writes nothing.
//
// ONE owner of the rule (`appendToLadderOrder`), called in the transaction that admits the entrant at each door -
// `createEntrants`, a registration's materialise, an import commit, and a reinstatement - and once more as a backstop by
// the one reader that depends on it (`issueChallenge`), so a door added later that forgets the call cannot strand a
// player: the reader repairs the order under the same division lock before it judges the challenge.
import type postgres from "postgres";

type Tx = postgres.TransactionSql;

/** The division's active entrants (`registered`/`confirmed`, the same field `issueChallenge` first writes the order
 *  from) that `order` does not hold, in the order that field is first written: seed, then creation. */
export async function missingFromLadder(tx: Tx, divisionId: string, order: readonly string[]): Promise<string[]> {
  const field = await tx<{ id: string }[]>`
    select id from entrants
    where division_id = ${divisionId} and status in ('registered','confirmed')
    order by seed nulls last, created_at, id`;
  const held = new Set(order);
  return field.map((e) => e.id).filter((id) => !held.has(id));
}

/** Append every active entrant a running ladder does not yet hold to the bottom of its `ladder_order`, in this
 *  transaction. A ladder with no order yet writes nothing - its first challenge initialises the order from the whole
 *  live field, newcomers included - and a finished ladder is left as it ended. Idempotent: a second call finds
 *  everyone held and writes nothing. */
export async function appendToLadderOrder(tx: Tx, divisionId: string): Promise<void> {
  // The same lock `issueChallenge` and the Swiss/knockout late-entry doors take, before the stage row is read.
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  const stages = await tx<{ id: string; config: { ladder_order?: unknown } }[]>`
    select id, config from stages
    where division_id = ${divisionId} and kind = 'ladder' and status <> 'complete'`;
  for (const stage of stages) {
    const order = stage.config.ladder_order;
    if (!Array.isArray(order)) continue;
    const missing = await missingFromLadder(tx, divisionId, order as string[]);
    if (missing.length === 0) continue;
    await appendMissingToStage(tx, stage.id, missing);
  }
}

/** Append `missing` to the bottom of ONE stage's `ladder_order`, as ONE statement against the row's CURRENT order, never
 *  a write of a literal array the caller read earlier. A result's swap (scoring.ts) does not take the `division:` lock
 *  the callers hold, so it can commit between their read and this write; a literal `[...order, ...missing]` would put
 *  the stale order back and lose the swap. A blocked UPDATE re-evaluates its SET against the committed row version, so
 *  the newcomers are appended to whatever order is current. A swap never changes membership, and every other writer of
 *  membership (the first challenge's initialisation, the other callers of this) holds the `division:` lock, so `missing`
 *  is still exactly what the row lacks when the UPDATE runs: a guard against double-adding would be unreachable
 *  (mutated, no test could tell, so it is not there). Callers hold the `division:` lock and have seen an array order. */
export async function appendMissingToStage(tx: Tx, stageId: string, missing: readonly string[]): Promise<void> {
  await tx`
    update stages s set config = s.config || jsonb_build_object('ladder_order',
      s.config->'ladder_order' || coalesce((
        select jsonb_agg(m.v order by m.ord)
        from jsonb_array_elements_text(${tx.json(missing as never)}::jsonb) with ordinality as m(v, ord)
        ), '[]'::jsonb))
    where s.id = ${stageId} and jsonb_typeof(s.config->'ladder_order') = 'array'`;
}
