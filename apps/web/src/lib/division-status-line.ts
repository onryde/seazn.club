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
  /** Display zone (schedule_settings.tz resolved) — formats HH:mm only
   *  (spec: "the DISPLAY zone and formats HH:mm only"). */
  displayTz: string;
  /** The GOVERNING clock (`resolveVenueTz(null, organizations.timezone)`) —
   *  fix-round-c, Defect (c): every date-key/day-name computation (weekday,
   *  day, month) uses this, so the row's own date never disagrees with the
   *  masthead pill's "Next {when}", which has always used it
   *  (competition-desk.ts's `competitionPhase` / page.tsx's `nextDateLabel`
   *  call). Before this fix `whenLabel` took one tz and used it for BOTH the
   *  date and the clock face, so a venue in a different zone from the org
   *  could make the row name a different DAY than the masthead. */
  orgTz: string;
}

/**
 * "Sat 12 Sep 10:00" — the DAY (weekday/day/month) in the governing ORG
 * zone, the CLOCK FACE (hour/minute) in the display zone. Node's ICU
 * orders/punctuates `format()` by locale (US English gives "Sat, Sep 12,
 * 10:00") — pull the named parts and assemble the fixed product
 * order/spacing ourselves so the string doesn't drift with the ICU version
 * or the CLDR locale data.
 *
 * fix-round-c, Defect (c): this used to take ONE tz and format both halves
 * with it (`displayTz`), which could name a different DAY than the
 * masthead's own "Next {when}" pill (always org tz) for a venue in a
 * different zone from the org — the two facts on one screen could disagree.
 * The spec's rule ("the governing clock is the ORG zone... `schedule_
 * settings.tz` is the DISPLAY zone and formats HH:mm only") is the tie-
 * breaker: the date half is chosen to agree with the masthead (org tz),
 * and only the clock digits stay venue-local, matching the spec's own
 * "formats HH:mm only" wording literally.
 */
export function whenLabel(iso: string, locale: string, orgTz: string, displayTz: string): string {
  const at = new Date(iso);
  const dateParts = new Intl.DateTimeFormat(locale, {
    timeZone: orgTz, weekday: "short", day: "numeric", month: "short",
  }).formatToParts(at);
  const timeParts = new Intl.DateTimeFormat(locale, {
    timeZone: displayTz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const getDate = (type: Intl.DateTimeFormatPartTypes) => dateParts.find((p) => p.type === type)?.value ?? "";
  const getTime = (type: Intl.DateTimeFormatPartTypes) => timeParts.find((p) => p.type === type)?.value ?? "";
  return `${getDate("weekday")} ${getDate("day")} ${getDate("month")} ${getTime("hour")}:${getTime("minute")}`;
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
      // fix-round-c, Defect 1 (owner ruling 2026-09-02): a usable `next`
      // instant is NOT guaranteed here. `phase === "scheduled"` only
      // requires SOME non-terminal fixture in the division to carry a
      // scheduledAt (division-phase.ts rule 5), or — after this round's
      // Defect 2 fix — that the division has already played something at
      // all; neither requires that fact to be the one `next` names. `next`
      // is a separate, more selective query (card-stats.ts) that also
      // requires both entrants to be filled in (no TBD slot). A dated
      // fixture with a still-TBD opponent (the knockout final) can make the
      // phase "scheduled" while every entrant-filled candidate for "next"
      // is null or itself undated — `next` comes back null or dateless.
      //
      // The old fallback here was `desk.status.noNext` ("nothing
      // scheduled") — reachable in exactly this state, printed directly
      // beside a "Scheduled" pill: the wave's headline three-fact
      // contradiction, reproduced live in fix-round-c
      // (`0 of 3 played · nothing scheduled · 2 unscheduled` next to
      // "Scheduled"). The ruling retires that key everywhere (see the four
      // locale dicts) so the sentence can never be reached from any arm of
      // any phase again: this now states the progress instead, the same
      // fallback `setting_up` and `match_day` already use when they have no
      // more specific fact to report.
      line = at && !Number.isNaN(Date.parse(at))
        ? t(dict, "desk.status.scheduled", { ...base, when: whenLabel(at, i.locale, i.orgTz, i.displayTz) })
        : t(dict, "card.progress.played", base);
      break;
    }
  }
  if (i.unscheduled > 0 && i.phase !== "finished") {
    // Pluralised: French inflects the adjective, so a hardcoded plural read
    // "1 non planifiés" — a defect English cannot show, since its adjectives
    // do not agree. Found by rendering n=1 in all four locales, not by parity
    // (the key existed everywhere and was wrong in one of them).
    line += plural(dict, "desk.status.unscheduledSuffix", i.unscheduled, i.locale);
  }
  return line;
}
