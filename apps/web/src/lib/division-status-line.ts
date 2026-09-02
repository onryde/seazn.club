import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
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
  locale: string;
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
        : t(dict, "desk.status.settingUp", { entrants: i.entrants });
      break;
    case "match_day":
      line = t(dict, "desk.status.matchDay", { ...base, inPlay: i.inPlay });
      break;
    case "scheduled": {
      const at = i.next?.scheduledAt ?? null;
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
