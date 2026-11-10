// Engine 5.0.0 (rulings 266/267, "shared 3rd by default" and `rank_range` keeps ties): a knockout that does not play a
// third-place match ranks its two semi-final losers LEVEL, so a cut that straddles them (qualifying -> main, Top 4)
// flags that tie on the seed proposal, and a confirm must resolve it ("a tie is FLAGGED, never silently ordered",
// seed-proposal.ts). Before 5.0.0 the seed split them silently and these rigs confirmed bare.
//
// This is what an organiser does at the desk: pick the order of each flagged tie. Here the pick is the better seed
// first - the order the pre-5.0.0 fallback produced, so the seating a rig asserts afterwards is unchanged. The
// product flow for that pick (what the desk offers for a `shared_place` tie) is W4 app PR B's.
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { confirmSeedProposal, getSeedProposal } from "../stages";

export async function confirmResolvingTies(
  auth: AuthCtx,
  stageId: string,
  proposalId: string,
): Promise<{ ties: number }> {
  const proposal = await getSeedProposal(auth, stageId);
  if (proposal === null || proposal.id !== proposalId) throw new Error("confirmResolvingTies: the newest proposal is not the one being confirmed");
  const ties = proposal.computed.ties;
  const ids = [...new Set(ties.flatMap((t) => t.entrantIds))];
  const seeds = new Map(
    ids.length === 0 ? [] : (await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where id in ${sql(ids)}`).map((r) => [r.id, r.seed ?? Infinity] as const),
  );
  const tiePicks = ties.map((t) => ({
    slots: t.slots,
    order: [...t.entrantIds].sort((a, b) => seeds.get(a)! - seeds.get(b)! || (a < b ? -1 : 1)),
  }));
  await confirmSeedProposal(auth, stageId, { proposalId, ...(tiePicks.length > 0 ? { tiePicks } : {}) });
  return { ties: ties.length };
}
