/**
 * Stage-progression helper for seed-demo.
 *
 * Extracted for the same reason seed-resume.ts's helpers were: seed-demo.ts
 * calls `main()` at import, so nothing inside it is reachable from a spec.
 *
 * The rule it encodes: **mint the NEXT stage's TBD fixtures BEFORE completing
 * the current one.** Completing a stage resolves its progression into the next
 * stage's destination slots, and `computeSeedProposal` (apps/web
 * server/usecases/stages.ts) refuses when there are none to fill:
 *
 *     const slotBySeed = await destinationSlotsBySeed(tx, stageId);
 *     if (slotBySeed.size === 0) throw new HttpError(422,
 *       "this stage has no generated TBD fixtures yet — generate its fixtures first",
 *       "SEEDING_RULES_MISSING", { stageId });
 *
 * The completion has already committed by then, so `completeStage` re-wraps it
 * as 409 STAGE_COMPLETED_SEEDING_FAILED — which is the shape the seeder failed
 * with. Nothing else mints those slots: `startDivision` generates only
 * `pre.firstStage.id` (usecases/schedule.ts), so the seeder's own
 * `POST /stages/{next}/generate` is their only source, and it used to be
 * issued AFTER the complete, from inside `playStage`.
 *
 * Why it only failed SOMETIMES: the seeder enters this branch solely when a
 * division's RANDOM play ratio happens to decide every fixture of stage one,
 * so the bug tracked the dice rather than the code.
 *
 * `playStage`'s own generate stays where it is. Verified against the live
 * server, not reasoned about: a second generate on the now-seeded stage
 * answers `created: 0` with the same one fixture — the setup-timing path keys
 * `newRows` by `ext_key` off a deterministic `generate()`, so it inserts
 * nothing new (see generateProgressionSetupFixtures' own note on this).
 */
import type { ApiCall } from "./seed-resume.ts";

/**
 * Complete `completedStageId`, having first made sure `nextStageId` has the
 * TBD fixtures that completion needs to seed. Call order is the whole point:
 * swapping these two lines restores the intermittent 409.
 */
export async function completeStageIntoNext(
  call: ApiCall,
  completedStageId: string,
  nextStageId: string,
): Promise<void> {
  await call(`/api/v1/stages/${nextStageId}/generate`, "POST");
  await call(`/api/v1/stages/${completedStageId}/complete`, "POST");
}
