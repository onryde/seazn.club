// The schedule-lock refusal, said ONCE.
//
// A frozen division (`divisions.schedule_locked`, written only by
// `setDivisionLocks`) refuses every board write. Before this module the
// sentence was hand-duplicated at five server call sites, a sixth carried a
// machine-readable code nobody else did, and three more write paths did not
// refuse at all — so "which paths honour the freeze?" was answerable only by
// grepping a sentence, and rewording it meant grepping it again.
//
// WHY THIS FILE AND NOT `usecases/schedule.ts`: that module opens with
// `import "server-only"`, which makes anything defined in it unreachable from
// a Playwright spec. The walkthrough already paid that price once — it
// HAND-MIRRORS `autoSolverWallMs` (see the comment at
// `e2e/walkthrough/scheduling-organiser-day.spec.ts`) rather than importing
// it. This file imports NOTHING, so product code, vitest and e2e can all
// import it. Keep it that way: adding any import here — above all
// `server-only` or anything that reaches it — silently un-shares the
// constant again.
//
// The enumeration of sites is not restated here as a count, because a count
// rots (the comment this file replaced claimed a complete enumeration and was
// false at three sites when it was written). The live enumeration is the
// import graph: `grep -rn SCHEDULE_LOCKED_MESSAGE apps/web/src` lists every
// path that refuses, and anything refusing a freeze WITHOUT this constant is
// the bug.

/** `HttpError.code` on every schedule-lock refusal, so a client can branch on
 *  the refusal without matching prose. The AI-plan gates
 *  (`schedule-ai.ts`, `schedule-ai-preview.ts`, `competition-schedule-ai.ts`)
 *  answer 409 with this same code; every board-write path answers 422. */
export const SCHEDULE_LOCKED_CODE = "SCHEDULE_LOCKED";

/** The 422 refusal for a single division, whose id the caller already named. */
export const SCHEDULE_LOCKED_MESSAGE =
  "the division schedule is locked — unlock it to edit";

/** The same refusal where the caller named a COMPETITION and one of its
 *  divisions is the frozen one — the joint apply
 *  (`competition-schedule-apply.ts`) aborts the whole run, so it has to say
 *  WHICH division stopped it. Same code, different sentence, one place. */
export function scheduleLockedMessageFor(divisionName: string): string {
  return `the schedule for division "${divisionName}" is locked — unlock it to edit`;
}
