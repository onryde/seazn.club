// Spectator surface W1, Task 13 — the Info tab: the fixture's own facts, and
// the two links back up the hierarchy.
//
// ---------------------------------------------------------------------------
// Not derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. THE ROW ORDER IS THE SERVER'S AND IS NOT SORTED HERE. It is a READING
//    order — toss · format · venue · start · stage · scored-as — chosen so the
//    two facts a spectator opens this tab for (where, and when) sit together.
//    Alphabetising the labels would scatter them, and would do it differently
//    in each of the four locales, which is the part that makes it a bug rather
//    than a preference.
//
// 2. BOTH HALVES OF A ROW ARE `Msg`, not strings. The value is a dictionary key
//    with params exactly like the label — "Scored ball by ball", "Best of 5" —
//    so the whole row re-resolves in the viewer's own locale, and a live push
//    that changes a fact changes it in every language on the same tick.
//
// 3. THE START TIME IS ALREADY FORMATTED. An earlier draft of the brief had
//    this component run `Intl.DateTimeFormat` in the venue's zone; the schema
//    settles it the other way — `rows[].value` is a `Msg`, never an ISO string
//    — and that is the better split: the venue's time zone is a server fact,
//    and formatting it here would mean shipping the zone to the client to get
//    the same answer.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { TabPanel } from "./tab-panel";

export interface InfoTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  /** Part of the shared panel signature; never read — see CommentaryTab. */
  data: LiveFixtureData;
}

const LINK_CLASS =
  "rounded-lg border border-zinc-200/80 px-3 py-2 text-[13px] font-medium hover:bg-surface";

export function InfoTab({ doc, dict }: InfoTabProps): ReactNode {
  const { rows, calendarHref, divisionHref, competitionHref } = doc.info;
  return (
    <TabPanel id="info" className="grid gap-3">
      {rows.length === 0 ? null : (
        // Two columns even at 320: the labels are short nouns, and one column
        // would push the links below the fold on a phone. Task 15's
        // screenshots are what actually prove they fit.
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          {/* See note 1: the order given. */}
          {rows.map((row, i) => (
            <div key={i} data-testid={`mc-info-${i}`} className="min-w-0">
              <dt className="truncate text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                {t(dict, row.label.key, row.label.params)}
              </dt>
              <dd className="text-[13px]">{t(dict, row.value.key, row.value.params)}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        {calendarHref === null ? null : (
          <a data-testid="mc-info-calendar" href={calendarHref} className={LINK_CLASS}>
            {t(dict, "matchCentre.info.addToCalendar")}
          </a>
        )}
        <a data-testid="mc-info-division" href={divisionHref} className={LINK_CLASS}>
          {t(dict, "matchCentre.info.division")}
        </a>
        <a data-testid="mc-info-competition" href={competitionHref} className={LINK_CLASS}>
          {t(dict, "matchCentre.info.competition")}
        </a>
      </div>
    </TabPanel>
  );
}
