// The public Schedule's phrases, in the org's locale (spectator N1e e5).
//
// `components/public-site/schedule.tsx` is a client component and loads no
// dictionary, so both of its callers (the division page's schedule tab and the
// embed schedule widget) hand it every phrase already resolved. This is that
// one list, so the two callers cannot drift: a phrase added to the Schedule is
// added here once. Keys reuse what the dictionaries already carried where the
// phrase is the same (the review's unused `division.view.*`,
// `division.calendar`, `division.scheduleEmpty`; the hub's `matchesHub.live` /
// `.ended`; ui `schedule.tbd`); `division.timesIn` and
// `division.filter.showFor` were added for it.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { ScheduleCopy, ScheduleWatchCopy } from "@/components/public-site/schedule";

/**
 * @param dict the PUBLIC dictionary, in the org's locale.
 * @param ui   the org-locale lookup the page already holds for `ui` keys.
 */
export function publicScheduleCopy(dict: Dict, ui: (key: "schedule.tbd") => string): ScheduleCopy {
  return {
    timeTbd: t(dict, "matchCentre.status.timeTbd"),
    allEntrants: t(dict, "division.filter.allEntrants"),
    live: t(dict, "matchesHub.live"),
    ended: t(dict, "matchesHub.ended"),
    // W2a: the SAME words the match centre's status line uses for a held fixture (Task 7), so the bracket card and the
    // page it opens cannot describe one match two ways.
    held: t(dict, "matchCentre.status.needs_decision"),
    tbd: ui("schedule.tbd"),
    filterLabel: t(dict, "division.filter.showFor"),
    viewLabel: t(dict, "division.view.label"),
    viewDay: t(dict, "division.view.day"),
    viewRound: t(dict, "division.view.round"),
    calendar: t(dict, "division.calendar"),
    // The raw template: the Schedule fills `{zone}` per group, from that
    // group's first timed match (a DST boundary can change the abbreviation).
    timesIn: t(dict, "division.timesIn"),
    empty: t(dict, "division.scheduleEmpty"),
  };
}

/** T16 fix round 1, I4 — the online watch links' words (ui keys; the canvas's "Watch live", "Final position",
 *  "Round not opened yet"), from the org-locale lookup the division page already holds. */
export function publicWatchCopy(
  ui: (key: "externalPlay.watch.list.live" | "externalPlay.watch.list.final" | "externalPlay.watch.list.notOpened") => string,
): ScheduleWatchCopy {
  return {
    live: ui("externalPlay.watch.list.live"),
    final: ui("externalPlay.watch.list.final"),
    notOpened: ui("externalPlay.watch.list.notOpened"),
  };
}
