// W5 app PR B Task 4 (X-UP-3; R24 pick 16 B): the comparison basis each group stage's best-Nth qualifiers were seated on, for
// the Standings footnote under that stage's tables (`bestNthBasisNote`). The basis is the engine's own (`ComparisonBasis`), as
// the destination's seed proposal stored it per slot (seed-proposal.ts) - this is only the read.
//
// Which proposal: each destination stage's LATEST row, and only while it is live (draft or confirmed). A re-proposal stales
// the previous row and writes its own slots, so a replaced basis is never read; a stale latest row (its source moved and
// nothing re-proposed yet) shows no footnote rather than a basis the table no longer bears out. An on_complete progression
// seeds with no proposal (API-only: every format template uses setup), so its source has no footnote.
import "server-only";
import type { ComparisonBasis } from "@seazn/engine/competition";
import { sql } from "@/lib/db";

interface StoredSlot {
  source?: { stageId?: string };
  basis?: ComparisonBasis;
}

/** Source stage id -> the distinct comparison bases (one per nth) its best-Nth qualifiers were seated on. */
export async function loadBestNthBases(divisionId: string): Promise<ReadonlyMap<string, readonly ComparisonBasis[]>> {
  const rows = await sql<{ status: string; computed: { qualifiers?: StoredSlot[] } }[]>`
    select distinct on (p.stage_id) p.status, p.computed
      from stage_seed_proposals p
      join stages s on s.id = p.stage_id
     where s.division_id = ${divisionId}
     order by p.stage_id, p.created_at desc, p.id desc`;
  const out = new Map<string, ComparisonBasis[]>();
  for (const row of rows) {
    if (row.status !== "draft" && row.status !== "confirmed") continue;
    for (const slot of row.computed.qualifiers ?? []) {
      const stageId = slot.source?.stageId;
      if (slot.basis === undefined || stageId === undefined) continue;
      const bases = out.get(stageId) ?? [];
      // Every slot of one comparison carries the same basis (the engine compares once per nth): keep one per nth.
      if (!bases.some((b) => b.nth === slot.basis!.nth)) bases.push(slot.basis);
      out.set(stageId, bases);
    }
  }
  return out;
}
