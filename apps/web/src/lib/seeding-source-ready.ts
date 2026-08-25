// Whether a setup-timing stage's seed-proposal panel should be visible at
// all — the ONE definition, pure and DB-free so the division page (an RSC)
// and its tests can share it without either mocking the server usecase or
// hand-duplicating the rule (roster-drift-eligibility.ts's own precedent for
// why this lives here rather than inline in page.tsx).
//
// Mirrors resolveProgressionSource (server/usecases/stage-seeding.ts:73-111)
// FIELD-FOR-FIELD, over an in-memory stage list instead of a SQL query:
//   - "previous" -> the same-division stage with the largest `seq` less than
//     the target's (`where division_id = ... and seq < ... order by seq desc
//     limit 1`).
//   - an explicit `{stageId}` -> that stage, but ONLY if it's in the same
//     division AND its `seq` is strictly less than the target's — the same
//     `row.seq >= target.seq` check resolveProgressionSource throws 422
//     SEEDING_RULES_MISSING on. A misconfigured explicit source (naming a
//     later-or-equal-seq stage) is treated as NOT ready here too: either way
//     Recompute would fail immediately (422 instead of the 409 this module
//     exists to avoid), so hiding the panel is still the correct call.
// If resolveProgressionSource's ordering or eligibility ever changes, this
// must change with it or the panel's visibility will disagree with the
// server's real gate.
import type { ProgressionSource, ProgressionSpec } from "@seazn/engine/competition";

export interface SeedingSourceStage {
  id: string;
  division_id: string;
  seq: number;
  status: string;
}

export function resolveSeedingSourceStage(
  stages: readonly SeedingSourceStage[],
  target: { division_id: string; seq: number },
  stage: ProgressionSource["stage"],
): SeedingSourceStage | undefined {
  if (stage === "previous") {
    return stages
      .filter((st) => st.division_id === target.division_id && st.seq < target.seq)
      .sort((a, b) => b.seq - a.seq)[0];
  }
  const row = stages.find((st) => st.id === stage.stageId && st.division_id === target.division_id);
  return row && row.seq < target.seq ? row : undefined;
}

/** True when every source a setup-timing stage's progression names has
 *  status "complete" — the panel's `sourceReady` prop. `progression` is the
 *  target stage's own JSONB field, already cast at the caller's read site. */
export function seedingSourceReady(
  stages: readonly SeedingSourceStage[],
  target: SeedingSourceStage,
  progression: Pick<ProgressionSpec, "sources">,
): boolean {
  return progression.sources.every(
    (src) => resolveSeedingSourceStage(stages, target, src.stage)?.status === "complete",
  );
}
