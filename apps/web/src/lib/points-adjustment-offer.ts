// W5 app PR B, Task 7 (preflight C5; R24 pick 15 A): the ONE predicate that decides whether "Adjust points" applies to a stage - the
// server's refusal (`adjustPoints` / `undoPointsAdjustment`, usecases/points-adjustments.ts) and the desk's offer (the stage card's
// More menu, desk/stage-rail.tsx) read it, so the item is never offered where the write would be refused. Client-safe, no imports.
//
// C5: a league, group or Swiss table (a bracket, a ladder or an americano has no table to adjust) that has STARTED - the division is
// under way (`active`) and the stage is live (`active`: generated, its rules pinned) - and is not complete. Before Start an adjustment
// would draw lots for a level, unplayed pool; after completion the next stage is already seeded from the frozen cut.
export type AdjustRefusalCode = "RR_ADJUST_NOT_TABLE" | "RR_ADJUST_STAGE_COMPLETE" | "RR_ADJUST_NOT_STARTED";

const ADJUSTABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);

/** Null when the stage takes an adjustment now, else the refusal's code (checked in this order). */
export function adjustRefusalCode(stage: { kind: string; status: string }, divisionStatus: string): AdjustRefusalCode | null {
  if (!ADJUSTABLE_KINDS.has(stage.kind)) return "RR_ADJUST_NOT_TABLE";
  if (stage.status === "complete") return "RR_ADJUST_STAGE_COMPLETE";
  if (divisionStatus !== "active" || stage.status !== "active") return "RR_ADJUST_NOT_STARTED";
  return null;
}

export function pointsAdjustmentOffered(stage: { kind: string; status: string }, divisionStatus: string | undefined): boolean {
  return divisionStatus !== undefined && adjustRefusalCode(stage, divisionStatus) === null;
}
