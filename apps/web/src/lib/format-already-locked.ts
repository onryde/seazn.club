// Is a division's FORMAT already locked at the moment Start is offered?
//
// `replaceStages` (`server/usecases/stages.ts`) refuses a format change with
// 409 FORMAT_LOCKED once ANY fixture row exists anywhere in the division:
//
//   select 1 from fixtures f join stages s on s.id = f.stage_id
//   where s.division_id = $1 limit 1
//
// Note what that guard does NOT test — no status filter, no stage filter. One
// fixture row in one stage locks the whole division's stage graph, whatever
// state that row is in. `__tests__/format-already-locked.test.ts` reads the
// real SQL and reds if that ever narrows.
//
// Client-safe on purpose, for the same reason as `open-entry-stages.ts`: the
// Start-tournament confirmation is a client island
// (`components/v2/launch-actions.tsx`) and has to know whether "the format is
// already locked" is TRUE before it says so. On the quick-start path it is
// not — `/start` is what generates the fixtures, so at the moment the dialog
// renders there are none and nothing is locked yet. Saying otherwise was a
// live defect (found by driving the product 2026-09-20): the dialog claimed
// "the format is already locked — fixtures exist" over a page whose own body
// read "No fixtures yet — generate them when entrants are registered".
export function formatAlreadyLocked(fixtureCount: number): boolean {
  return fixtureCount > 0;
}
