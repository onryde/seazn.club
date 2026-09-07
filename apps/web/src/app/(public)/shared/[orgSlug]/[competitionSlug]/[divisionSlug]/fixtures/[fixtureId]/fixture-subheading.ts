// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.

/** The fixture statuses that mean the match is OVER — the two `statusOf`
 *  (`server/public-site/match-centre.ts`) folds into `"decided"`. Everything
 *  else keeps the "to be determined" wording, deliberately: `scheduled` is a
 *  future match whose time genuinely is still to be set, and the default
 *  branch (abandoned / forfeited / cancelled, plus any status this module does
 *  not yet know) is exactly where a confident guess would be wrong, so it is
 *  left alone rather than swept in. */
const PLAYED_STATUSES = new Set(["decided", "finalized"]);

/**
 * "Time TBD" only makes sense pre-match — a live fixture with no
 * scheduled_at (started ad hoc) should say so instead of implying it
 * hasn't started, which contradicts the LIVE scorebug right below it.
 *
 * Task 14b — `timeTbdLabel` localises "Time TBD" (task-14-review.md OWED
 * item 2: no dictionary key carried that exact phrase yet), via the
 * `matchCentre.status.timeTbd` key (`page.tsx`'s own call site); defaulted
 * to "Time TBD" so a caller with no locale in hand (or an existing test)
 * keeps reading exactly as before.
 *
 * R11 fix round, C3 — this page ALWAYS renders `<MatchCentre>` directly
 * below this subheading, and `CourtCard`'s own status chip already carries
 * the word "Live" (`mc-live-pill`, `matchCentre.status.live`) for `in_play`
 * — so an `in_play` fixture with no `scheduledAt` used to print the bare
 * word "Live" here too, immediately above a court card already announcing
 * it. The `in_play` branch now returns `""` (the caller drops the whole
 * line rather than render a bullet-only fragment) — this is NOT "drop the
 * status word for every status the card carries a chip for": `decided` and
 * `scheduled` never returned their chip's word from this function in the
 * first place (only `timeTbdLabel`, a different fact — no time has been
 * announced — not a restatement of "Ended"/"Scheduled"), so nothing else
 * here duplicates the card. Removed the `liveLabel` parameter entirely
 * (it has no caller once the word it carried is never rendered).
 *
 * R11 phone read — a FINISHED match said "Time TBD" (seen on
 * `match-b-tab-scorecard-320.png`, above a scorebug already reading ENDED).
 * "To be determined" is a promise about the future, and this match has
 * already been played; the true fact is that no time was ever recorded for
 * it. `decided`/`finalized` therefore take their own label. The distinction
 * is worth keeping rather than collapsing both into one vaguer string: a
 * spectator looking at a fixture list wants to know which matches are still
 * waiting on a time (something an organiser can fix) versus which are simply
 * missing one after the fact (something nobody needs to act on).
 */
export function fixtureSubheading(
  status: string,
  scheduledAt: string | null | undefined,
  timeTbdLabel: string = "Time TBD",
  timeNotRecordedLabel: string = "Time not recorded",
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
  if (status === "in_play") return "";
  return PLAYED_STATUSES.has(status) ? timeNotRecordedLabel : timeTbdLabel;
}
