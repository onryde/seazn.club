// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.

/**
 * "Time TBD" only makes sense pre-match — a live fixture with no
 * scheduled_at (started ad hoc) should say so instead of implying it
 * hasn't started, which contradicts the LIVE scorebug right below it.
 *
 * Task 14 — `liveLabel` lets the page pass the localised
 * `matchCentre.status.live` word (the SAME key `CourtCard`'s own live pill
 * uses) instead of a bare English literal; defaulted to "Live" so this
 * function's own unit tests (which call it with two args, proving the
 * status/date branching alone) keep reading exactly as before.
 *
 * Task 14b — `timeTbdLabel` does the same for "Time TBD" (task-14-review.md
 * OWED item 2: no dictionary key carried that exact phrase yet), via the
 * new `matchCentre.status.timeTbd` key (`page.tsx`'s own call site). Same
 * default-so-existing-tests-keep-working convention as `liveLabel`.
 */
export function fixtureSubheading(
  status: string,
  scheduledAt: string | null | undefined,
  liveLabel: string = "Live",
  timeTbdLabel: string = "Time TBD",
): string {
  if (scheduledAt) {
    return new Date(scheduledAt).toLocaleString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return status === "in_play" ? liveLabel : timeTbdLabel;
}
