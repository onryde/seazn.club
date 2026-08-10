/**
 * Client-side date-order predicates for the organiser forms.
 *
 * Two shapes, deliberately kept apart, because the safe comparison is not the
 * same for both and picking the wrong one typechecks perfectly:
 *
 *  - **date-only** (`YYYY-MM-DD`, from `<input type="date">`) carries no zone
 *    and no offset, so plain string order IS chronological. This is why
 *    `schemas.ts`'s `checkDateOrder` is allowed to use `<` on the wire.
 *  - **instants** (`IsoDateTime` = `z.iso.datetime({ offset: true })`) accept
 *    ANY offset, so string order is chronological only within one offset.
 *    `2026-03-01T01:00:00-05:00` (06:00Z) sorts BEFORE
 *    `2026-03-01T02:00:00+02:00` (00:00Z) while actually being six hours
 *    later. That mis-comparison shipped once already and was caught in review
 *    on #498; these functions exist so no third call site re-derives it.
 *
 * Pure and dependency-free so the panels' guards are unit-testable — the
 * components that use them call `useLocale()` and cannot be mounted in this
 * repo's jsdom-less suite.
 */

/**
 * The `YYYY-MM-DD` day a `datetime-local` value falls on, or `undefined` when
 * it is blank.
 *
 * Exported so a form's `min=` advisory and its save-time refusal are the SAME
 * expression rather than two copies that can drift — the failure mode being an
 * input that visually permits what the guard then rejects, or worse the
 * reverse.
 */
export function startDay(startLocal: string): string | undefined {
  return startLocal === "" ? undefined : startLocal.slice(0, 10);
}

/**
 * True when a `date`-valued end field lands before the day its
 * `datetime-local` start field is on.
 *
 * Both values come from native inputs on the same (browser) clock, so slicing
 * the day off the start compares like with like. Blank on either side is not
 * an error — a half-filled pair is unfinished, not backwards.
 */
export function endDateIsBackwards(startLocal: string, endDate: string): boolean {
  const day = startDay(startLocal);
  return day !== undefined && endDate !== "" && endDate < day;
}

/**
 * True when `closeIso` is at or before `openIso`.
 *
 * `Date.parse`, never string order — see the header. `>=` rather than `>`
 * because a zero-length window accepts nobody: it is a control that silently
 * does not work, not a very narrow one. Matches the server's own test in
 * `registrations.ts` exactly, so the two layers cannot disagree about which
 * windows are legal.
 *
 * An unparseable value is NOT reported as backwards: the schema is what
 * rejects malformed input, and answering "backwards" here would show the
 * organiser a message about ordering for a problem that is not about ordering.
 */
export function windowIsBackwards(
  openIso: string | null | undefined,
  closeIso: string | null | undefined,
): boolean {
  if (!openIso || !closeIso) return false;
  const open = Date.parse(openIso);
  const close = Date.parse(closeIso);
  if (Number.isNaN(open) || Number.isNaN(close)) return false;
  return open >= close;
}
