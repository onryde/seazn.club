// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module, so a helper the page needs lives here instead.
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";

/** The fixture statuses that mean the match is OVER — the two `statusOf`
 *  (`server/public-site/match-centre.ts`) folds into `"decided"`. Everything
 *  else keeps the "to be determined" wording, deliberately: `scheduled` is a
 *  future match whose time genuinely is still to be set, and the default
 *  branch (abandoned / forfeited / cancelled, plus any status this module does
 *  not yet know) is exactly where a confident guess would be wrong, so it is
 *  left alone rather than swept in.
 *
 *  Both the RAW fixture status and the document's FOLDED one (`statusOf`'s
 *  four-value enum, which is what the live document carries) are read by the
 *  same set — `decided` is a member of both vocabularies, and `finalized`
 *  only of the raw one, so the pair covers either caller. */
const PLAYED_STATUSES = new Set(["decided", "finalized"]);

/**
 * "Time TBD" only makes sense pre-match — a live fixture with no
 * scheduled time (started ad hoc) should say so instead of implying it
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
 * — so an `in_play` fixture with no scheduled time used to print the bare
 * word "Live" here too, immediately above a court card already announcing
 * it. The `in_play` branch now returns `""` (the caller drops the whole
 * line rather than render a bullet-only fragment) — this is NOT "drop the
 * status word for every status the card carries a chip for": `decided` and
 * `scheduled` never returned their chip's word from this function in the
 * first place (only `timeTbdLabel`, a different fact — no time has been
 * announced — not a restatement of "Ended"/"Scheduled"), so nothing else
 * here duplicates the card.
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
 *
 * M1 k2 — this takes the ALREADY-FORMATTED start time, not an ISO string and
 * a locale. It used to run its own `new Date(iso).toLocaleString(locale, …)`,
 * which was wrong twice over: it passed NO `timeZone`, so it printed the
 * rendering server's zone rather than the venue's, and it used a long
 * weekday style the court card immediately below does not, so one page showed
 * one kick-off in two wordings and two zones. The single formatter is now
 * `startTimeText` (`server/public-site/match-centre.ts`), whose output arrives
 * on the live document as `MatchCentreDoc.startTime` — which is also what
 * makes the line move when a match is rescheduled (rule R10) instead of
 * freezing at page load.
 */
export function fixtureSubheading(
  status: string,
  startTime: string | null | undefined,
  timeTbdLabel: string = "Time TBD",
  timeNotRecordedLabel: string = "Time not recorded",
): string {
  if (startTime) return startTime;
  if (status === "in_play") return "";
  return PLAYED_STATUSES.has(status) ? timeNotRecordedLabel : timeTbdLabel;
}

/**
 * The whole line under the fixture title: "20 Jul 2026, 14:30 · Riverside
 * Sports Hall · Court 3".
 *
 * R11 fix round, C3 — `fixtureSubheading` returns "" for an in-play fixture
 * with no start time (the court card right below already carries the LIVE
 * chip); joining through `filter(Boolean)` rather than string concatenation
 * means that empty case does not leave a stray leading " · " in front of the
 * venue, and `null` (rather than an empty paragraph) is returned when there is
 * neither a time nor a venue/court to show.
 *
 * M1 k2 — EVERY part comes off the live match-centre document, so a poll or a
 * realtime push re-renders the line in place: a rain-delay reschedule moves
 * this and the court card together. `fallbackStatus` is read ONLY when there
 * is no document at all (`MatchCentre`'s own `mc-fallback` path, which the
 * page's `baseData()`-style tests also exercise) — a document, when present,
 * is the single authority for all four facts.
 */
export function fixtureSubheadingLine(
  doc: MatchCentreDocT | undefined,
  fallbackStatus: string,
  labels: { timeTbd: string; timeNotRecorded: string },
): string | null {
  const parts = [
    fixtureSubheading(
      doc?.header.status ?? fallbackStatus,
      doc?.startTime,
      labels.timeTbd,
      labels.timeNotRecorded,
    ),
    doc?.venueName ?? null,
    doc?.courtName ?? null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}
