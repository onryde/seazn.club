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
  /** Display zone (`schedule_settings.tz` resolved through `resolveVenueTz`)
   *  — the venue's zone, and the ONE zone this row uses for everything (G2
   *  fix, fix round D; corrected again by H1, round E).
   *
   *  There is deliberately no `orgTz` field here. Two zones in one row IS the
   *  bug, wherever the seam is drawn: a fixture's day is its VENUE's day, for
   *  BOTH day-bucketing (division-phase.ts's `localDateKey`, which callers
   *  feed this same resolved zone) and printing (`whenLabel` below). The org
   *  zone is only what `resolveVenueTz` falls back to when a division has no
   *  venue zone at all — never a second authority. */
  displayTz: string;
  /** G1 fix (fix round D, Critical): this field did not exist at all before
   *  — the `scheduled` arm below had no way to ask "is this kick-off still
   *  ahead of us?" and could print a past instant as "Next …" directly
   *  beside a Needs-you row reading "the match window has passed" for the
   *  SAME fixture. The caller captures ONE `now` (never reads the wall
   *  clock inside a render — react-hooks/purity) and threads it through
   *  every consumer that renders a fixture time, the same discipline
   *  division-ledger.tsx's `nextLine` already had. */
  now: string;
}

/**
 * "Sat 12 Sep 10:00" — the WHOLE instant (day AND clock face) formatted in
 * ONE zone, the DISPLAY zone: what the person standing at the venue reads.
 * Node's ICU orders/punctuates `format()` by locale (US English gives "Sat,
 * Sep 12, 10:00") — pull the named parts and assemble the fixed product
 * order/spacing ourselves so the string doesn't drift with the ICU version
 * or the CLDR locale data.
 *
 * G2 fix (fix round D, Important — corrected ruling): fix-round-c took the
 * DAY from the org (governing) zone and the CLOCK from the display zone —
 * that was round C's brief, taken literally and correctly, and it was
 * WRONG. It names an instant that can exist in NEITHER zone: measured live,
 * org `Europe/London`, division `America/New_York`, `2026-09-06T23:00Z`
 * rendered "Mon 7 Sept 19:00" where the venue truth is Sun 6 Sept 19:00 —
 * one hour of offset near midnight is enough to flip the day in one zone
 * without flipping it in the other. A rendered instant names ONE reality;
 * splitting it across two zones can name a reality that never happened in
 * either.
 *
 * H1 (round E) then corrected the OTHER half of that sentence. This comment
 * used to end "the org zone still governs day-BUCKETING (division-phase.ts's
 * `localDateKey`) — never half of a printed label", and that ruling is
 * RETIRED (fix round F, minor 2): bucketing reads the VENUE zone too. One
 * zone per fixture, for the day group and the printed label alike; the org
 * zone is `resolveVenueTz`'s fallback for a division with no venue zone,
 * never a second authority. Splitting a row across two zones was the bug
 * twice over — first date-from-org/clock-from-display, then
 * bucket-in-org/print-in-display.
 */
export function whenLabel(iso: string, locale: string, tz: string): string {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
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
      //
      // G1 fix (fix round D, Critical): this arm had NO floor against `now`
      // at all — a past, unresulted kick-off rendered "Next {past date}"
      // directly beside a Needs-you row reading "the match window has
      // passed" for the SAME fixture, F5's own symptom, at the ONE consumer
      // that had never gotten F5's guard. Same "not already past" floor
      // division-ledger.tsx's `nextLine` already applies.
      const nowMs = Date.parse(i.now);
      const atMs = at ? Date.parse(at) : NaN;
      line = at && !Number.isNaN(atMs) && atMs >= nowMs
        ? t(dict, "desk.status.scheduled", { ...base, when: whenLabel(at, i.locale, i.displayTz) })
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
