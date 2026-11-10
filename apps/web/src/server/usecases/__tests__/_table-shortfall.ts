// W4 T13 (RB4-V6, X-LL-5): a departed entrant now LEAVES a league's or a group's cut and the next-ranked entrant of her
// pool takes her place (as W3 T15 Carry A ruled for Swiss), so a qualifier's knockout seat VACATES only on a SHORTFALL —
// when nobody below the cut is left in her pool. The suites that prove what a vacated seat does (vacated-seat-*.test.ts,
// withdrawn-entrant-not-seeded.test.ts) were written when every departure vacated; they build that shortfall here, through
// the real cascade: first every entrant of her source pool the current proposal does not offer, then her.
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getSeedProposal } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";

/**
 * Withdraw `entrantId` (a qualifier the current draft of `koStageId` offers) so that her seat vacates: the entrants of her
 * pool in the stage before `koStageId` who are still in the field and NOT offered (those below the cut) withdraw first,
 * then she does. Returns who left before her, in withdrawal order (none when her pool had nobody below the cut).
 */
export async function departIntoShortfall(auth: AuthCtx, koStageId: string, entrantId: string): Promise<string[]> {
  const draft = await getSeedProposal(auth, koStageId);
  if (draft === null) throw new Error("departIntoShortfall: no proposal to read the cut from — compute one first");
  const offered = new Set(draft.computed.qualifiers.map((q) => q.entrantId));
  if (!offered.has(entrantId)) throw new Error("departIntoShortfall: the entrant is not a qualifier the draft offers");
  const mates = await sql<{ id: string }[]>`
    select distinct r ->> 'entrantId' as id
      from stages ko
      join stages src on src.division_id = ko.division_id and src.seq = ko.seq - 1
      join standings_snapshots ss on ss.stage_id = src.id
      cross join lateral jsonb_array_elements(ss.rows) r
      join entrants e on e.id = (r ->> 'entrantId')::uuid
     where ko.id = ${koStageId}
       and ss.rows @> ${sql.json([{ entrantId }] as never)}
       and e.status not in ('withdrawn', 'disqualified')
     order by 1`;
  if (mates.length === 0) throw new Error("departIntoShortfall: her pool was not found in the source stage's snapshots");
  const below = mates.map((m) => m.id).filter((id) => id !== entrantId && !offered.has(id));
  for (const id of below) await withdrawEntrantCascade(auth, id);
  await withdrawEntrantCascade(auth, entrantId);
  return below;
}
