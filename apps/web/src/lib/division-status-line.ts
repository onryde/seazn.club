import { plural, t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { DivisionPhase } from "@/lib/division-phase";

export interface StatusLineInput {
  phase: DivisionPhase;
  played: number;
  total: number;
  unscheduled: number;
  inPlay: number;
  entrants: number;
  next: { scheduledAt: string | null; home: string | null; away: string | null } | null;
  needsDrawStageName: string | null;
  locale: Locale;
  /** Display zone (schedule_settings.tz resolved) — formatting only. */
  displayTz: string;
}

/**
 * "Sat 12 Sep 10:00" in the display zone. Node's ICU orders/punctuates
 * `format()` by locale (US English gives "Sat, Sep 12, 10:00") — pull the
 * named parts and assemble the fixed product order/spacing ourselves so the
 * string doesn't drift with the ICU version or the CLDR locale data.
 */
export function whenLabel(iso: string, locale: string, tz: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}

/**
 * "Sat 12 Sep" — the competition masthead pill's "Next {when}" ladder step
 * (spec §W1 line 152), a date with no time: `whenLabel` above always
 * includes the kick-off clock, which the masthead never shows (it names a
 * DAY across possibly several divisions, not a single fixture's minute).
 * Same formatToParts assembly as `whenLabel` for the same reason — Node's
 * ICU orders/punctuates `format()` by locale, so the parts are pulled and
 * joined in a fixed order instead.
 */
export function nextDateLabel(iso: string, locale: string, tz: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short",
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

export function statusLine(dict: Dict, i: StatusLineInput): string {
  const base = { played: i.played, total: i.total };
  let line: string;
  switch (i.phase) {
    case "finished":
      line = t(dict, "desk.status.finished", base);
      break;
    case "setting_up":
      line = i.needsDrawStageName
        ? t(dict, "desk.status.needsDraw", { ...base, stage: i.needsDrawStageName })
        // F1 fix (final review, Critical): `setting_up` is now reachable
        // for a division that already HAS fixtures (rule 5's fallback —
        // fixtures exist but none carry a time yet), not only a brand-new
        // division with nothing but entrants. Stating the played/total
        // count there (same shape as every other phase's line, via
        // `card.progress.played`) is the fact this row owes; the entrant
        // count is only ever the right answer once there is nothing else
        // to report.
        : i.total > 0
          ? t(dict, "card.progress.played", base)
          // `{count} entrants` read "1 entrants" for the first entrant an
          // organiser adds — the count strings go through `plural()` so the
          // noun agrees (see the sibling keys in needs-you.tsx).
          : plural(dict, "desk.status.settingUp", i.entrants, i.locale);
      break;
    case "match_day":
      // matchDay minor fix: an empty cell is not information (the same
      // rule the V4 fix applied to `nextLine`) — "0 in play" on a
      // division whose match day fixture is merely dated today, nothing
      // live yet, said nothing a reader couldn't already tell from the
      // absence of the clause.
      line = i.inPlay > 0
        ? t(dict, "desk.status.matchDay", { ...base, inPlay: i.inPlay })
        : t(dict, "card.progress.played", base);
      break;
    case "scheduled": {
      const at = i.next?.scheduledAt ?? null;
      // `desk.status.noNext` stays reachable post-F1: `phase === "scheduled"`
      // only requires SOME non-terminal fixture in the division to carry a
      // scheduledAt (division-phase.ts rule 5) — it does not require THAT
      // fixture to be the one `next` names. `next` is a separate, more
      // selective query (card-stats.ts) that also requires both entrants to
      // be filled in (no TBD slot). A dated fixture with a still-TBD
      // opponent can make the phase "scheduled" while every entrant-filled
      // candidate for "next" is null — `next` comes back null, and this
      // line correctly still has to say something other than a kick-off
      // time it doesn't have.
      line = at && !Number.isNaN(Date.parse(at))
        ? t(dict, "desk.status.scheduled", { ...base, when: whenLabel(at, i.locale, i.displayTz) })
        : t(dict, "desk.status.noNext", base);
      break;
    }
  }
  if (i.unscheduled > 0 && i.phase !== "finished") {
    line += t(dict, "desk.status.unscheduledSuffix", { n: i.unscheduled });
  }
  return line;
}
