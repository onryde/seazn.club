import "server-only";
// Add stage after groups (owner Option C, 2026-11-24): the save-time door for a per-group take (`topNPerGroup` / `bestNth`) read from a
// stage of SEVERAL pools - what the Add stage form's one count ("Qualify to the knockout: N") posts. A count the stage could never be
// drawn from is refused HERE, by the draw's own codes (lib/group-take-refusal.ts, the one predicate the form reads too), and writes
// nothing: the anti-goal is a save that succeeds and then never generates (#1294's defect).
//
// Called by `validateStageProgression` (stage-seeding.ts) for every saved progression, so the create door and the Format dialog's
// replace both hold it. Judged: an `on_complete` stage - one nobody reviews before it is seeded: Complete draws it, and by then results
// exist and the format is locked. (A `setup` stage, the builder's templates', is proposed and confirmed by the organiser, and the
// builder only WARNS of a draw that can refuse: `crossPoolDrawCanRefuse`; that behaviour is unchanged.) ONE source that is a group
// stage of two or more pools and a take made only of per-group rules. Two questions, in this order, each answered by name:
//   1. more places than the groups hold (RR_CUT_EXCEEDS_FIELD, `takeCutIssue` - the cut gate's own count over the field snaked into the
//      pools). Asked before the draw's shape, so a refusal never offers a count above the field; and not asked of a finished source
//      (`refuseUnfillableFromFinishedSources` reads the tables it finished with, where a departed entrant keeps her row);
//   2. the draw's own refusals (`groupTakeRefusal`): too few places (SEEDING_QUALIFY_TOO_FEW), too large, a page playoff not of four, no ordering that keeps pool-mates apart.
import type { ProgressionSpec } from "@seazn/engine/competition";
import { HttpError } from "@/lib/errors";
import { snakeSizes, takeCutIssue } from "@/lib/field-cut-gate";
import { groupTakeRefusal, takeSlots, type GroupTakeRefusal } from "@/lib/group-take-refusal";
import { POOL_COUNT_MAX } from "@/lib/format-bounds";
import { groupsKoTake } from "@/lib/format-templates";
import { roundRobinRefusal } from "../roundrobin-refusal";
import type { Tx } from "./types";

/** The English sentence for the wire (the client reads the dictionary's, by code and `phase`). */
const ENGLISH: Record<GroupTakeRefusal["code"], (v: Record<string, string | number>) => string> = {
  SEEDING_QUALIFY_TOO_FEW: (v) => `a knockout takes at least ${v.min} qualifiers, and this take opens ${v.qualified}`,
  SEEDING_PAGE_PLAYOFF_NEEDS_FOUR: (v) => `a page playoff takes exactly ${v.size} qualifiers, and this take opens ${v.entrants}`,
  SEEDING_CROSS_POOL_DRAW_TOO_LARGE: (v) =>
    `a draw across the groups takes at most ${v.maxPools} groups and ${v.maxEntrants} qualifiers, and this one has ${v.pools} groups and ${v.entrants} qualifiers`,
  SEEDING_POOL_SEPARATION_IMPOSSIBLE: (v) =>
    `${v.entrants} qualifiers from ${v.pools} groups cannot be drawn so that no two of one group meet in round one` +
    (v.options === "" || v.options === undefined ? "" : `; ${v.options} would work`),
};

function refusal(r: GroupTakeRefusal): HttpError {
  return new HttpError(422, ENGLISH[r.code](r.vars), r.code, r.vars);
}

/** Refuse a per-group take from a group source the stage could never be drawn from. `sources[i]` is `progression.sources[i]`'s stage
 *  (`status` absent for a preset, which has none yet); `poolCounts[i]` is that stage's pool count (`sourceShapeOf`). */
export async function refuseGroupTakeShape(
  tx: Tx,
  target: { division_id: string; kind?: string },
  progression: Pick<ProgressionSpec, "sources" | "placement"> & { timing?: string },
  sources: readonly { id?: string; kind: string; status?: string }[],
  poolCounts: readonly number[],
): Promise<void> {
  if (progression.timing !== "on_complete" || progression.sources.length !== 1) return;
  const source = sources[0]!;
  const pools = poolCounts[0] ?? 0;
  const take = progression.sources[0]!.take;
  // A pooled source: only a group stage has pool keys (`sourceShapeOf`), so two or more of them is a group of two or more pools.
  if (pools < 2 || take.length === 0 || !take.every((t) => t.kind === "topNPerGroup" || t.kind === "bestNth")) return;
  const field = await rosterSize(tx, target.division_id);
  const refused = groupTakeRefusal({ destKind: target.kind ?? "", placement: progression.placement, pools, take, entrants: field });
  if (field !== null && pools <= POOL_COUNT_MAX && source.status !== "complete") {
    const sizes = snakeSizes(field, pools);
    const issue = takeCutIssue(take, sizes);
    if (issue !== null) {
      // `max` is what the Add stage form's own split can fill (the builder's `cutIssue` reading), not the cut's own supply: pools of
      // 4, 4, 4 and 3 hold 15, though a top-16 take (4 from every pool) fills only the 12 its waves complete. A count the form cannot
      // offer would be a remedy that is not one.
      const qualified = takeSlots(take, pools);
      let max = issue.max;
      for (let q = qualified - 1; q > issue.max; q--) {
        if (takeCutIssue(groupsKoTake(q, pools), sizes) === null) {
          max = q;
          break;
        }
      }
      throw roundRobinRefusal("RR_CUT_EXCEEDS_FIELD", { qualified, max, reason: issue.reason, ...(source.id !== undefined ? { stageId: source.id } : {}) });
    }
  }
  if (refused !== null) throw refusal(refused);
}

/** The division's active roster (registered and confirmed, the generators' own field, as `refuseCutBeyondField` reads it), or null when
 *  it is empty. For a FED group stage this is an upper bound of its field (it is fed no more than the roster holds), so a cut past it
 *  is past the fed field too, and the pool sizes it snakes into are never smaller than the fed stage's - never a false refusal. */
async function rosterSize(tx: Tx, divisionId: string): Promise<number | null> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')`;
  return n > 0 ? n : null;
}
