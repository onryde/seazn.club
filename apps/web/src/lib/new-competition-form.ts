// Match Day C8 — the New competition form's two pure rules. Dependency-free so
// the island and the tests read the same functions.

/**
 * Where "Ends on" goes when "Starts on" changes.
 *
 * Ends defaults to Start, and keeps following it for as long as it is still
 * only a copy of it. It moves when it is
 *   - empty (the first Start picked), or
 *   - equal to or earlier than the PREVIOUS Start (it was following, or was
 *     never later than Start), or
 *   - earlier than the NEW Start (it would otherwise end before it begins).
 * An End the organiser pushed past Start ("a longer event") stays put when
 * Start moves earlier or a little later. Clearing Start never touches Ends.
 */
export function endsOnAfterStartChange(c: {
  prevStart: string;
  nextStart: string;
  endsOn: string;
}): string {
  if (c.nextStart === "") return c.endsOn;
  if (c.endsOn === "") return c.nextStart;
  if (c.endsOn <= c.prevStart || c.endsOn < c.nextStart) return c.nextStart;
  return c.endsOn;
}

/** Why Create is disabled, or null when it is not. */
export type CreateBlocker = "name" | "endsOn" | "both" | "order";

/**
 * The first thing standing between the form and a valid create. A missing field
 * outranks the date order — there is nothing to compare until the End exists.
 * Start is optional, so it is never a blocker on its own.
 */
export function createBlocker(c: { name: string; startsOn: string; endsOn: string }): CreateBlocker | null {
  const noName = c.name.trim() === "";
  const noEnd = c.endsOn === "";
  if (noName && noEnd) return "both";
  if (noName) return "name";
  if (noEnd) return "endsOn";
  if (c.startsOn !== "" && c.endsOn < c.startsOn) return "order";
  return null;
}
