"use client";
// The Sponsors hub's Overview tab (R4 sponsors on stream, S13; spec 2026-10-27 §5.1): for the period picked, each sponsor's
// times shown, time on screen, viewer impressions and link clicks - the numbers a club shows its sponsors - and, for an editor,
// a Share report link per sponsor.
//
// The numbers are the server's (`sponsorOverview`, server/sponsors/report.ts, where every rule is stated); this file only lays
// them out. A value the server does not have is a DASH, never 0: viewer numbers until Y1 fills them, and a deleted sponsor's
// clicks (they were deleted with it).
//
// ONE DOM for every width (house rule): a list of sponsors, each a definition list of its four numbers. On a phone each sponsor
// is a card whose lines carry their labels; from `md` the same list lines up under a column header row (aria-hidden - the
// labels stay in every row for screen readers, `md:sr-only`). Nothing here widens the page: the name truncates with `min-w-0`
// on its whole chain, and the four number columns are fixed widths that wrap their own text.
//
// R19: every member reads it; only an editor (`canEdit`) gets Share report, and the routes refuse anyone else anyway.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import Link from "@/components/ui/console-link";
import { ShareReport } from "@/components/sponsors/share-report";
import { fmtNumber } from "@/lib/format";
import {
  fmtIsoDay,
  fmtOnScreen,
  overviewHref,
  periodParam,
  periodWindow,
  resolveSponsorPeriod,
  windowDates,
  type ReportLinkDefaults,
  type ReportLinkSummary,
  type SponsorOverviewRow,
  type SponsorPeriod,
} from "@/lib/sponsor-report";
import { sponsorsHref } from "@/lib/sponsors-hub";

export interface OverviewTabProps {
  orgId: string;
  orgSlug: string;
  /** The period on screen (the page resolved `?period=` against the org's own competitions). */
  period: SponsorPeriod;
  /** The instant the page read the numbers at, so the caption names the same window the server counted. */
  nowIso: string;
  competitions: { id: string; name: string }[];
  rows: SponsorOverviewRow[];
  canEdit: boolean;
  /** The org's live report links (editors only; [] for anyone else). */
  links: ReportLinkSummary[];
  /** What a new link opens at for this period (editors only; null for anyone else). */
  shareDefaults: ReportLinkDefaults | null;
}

const DASH = "—";
/** The picker's value for "This year" (its URL carries no `?period=`). */
const THIS_YEAR_VALUE = "this_year";

/** A row's React key and testid suffix: a live sponsor by id; a deleted one by the name its airings kept. */
const rowKey = (r: SponsorOverviewRow) => (r.sponsorId !== null ? r.sponsorId : `gone-${r.name}`);

export function OverviewTab(props: OverviewTabProps) {
  const { orgId, orgSlug, period, nowIso, competitions, rows, canEdit, links, shareDefaults } = props;
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  /** The sponsor whose Share report panel is open (one at a time). */
  const [sharing, setSharing] = useState<string | null>(null);

  const span = periodWindow(period, new Date(nowIso));
  const dates = span === null ? null : windowDates(span);
  const competitionName = period.kind === "competition" ? (competitions.find((c) => c.id === period.competitionId)?.name ?? null) : null;
  const sharable = canEdit && shareDefaults !== null;
  const cols = sharable ? "md:grid-cols-[minmax(0,1fr)_24rem_7.5rem]" : "md:grid-cols-[minmax(0,1fr)_24rem]";
  const hasDeleted = rows.some((r) => r.sponsorId === null);

  /** A value the server does not have: the dash on screen, and words for a screen reader (which would read "em dash"). */
  const dash = (spoken: string) => (
    <>
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only">{spoken}</span>
    </>
  );
  /** A count, or - for a deleted sponsor's clicks, which went with it - a dash read as "not available". */
  const count = (n: number | null) => (n === null ? dash(msg("sponsors.overview.notAvailable")) : fmtNumber(locale, n));
  /** One number with its label: a labelled line on a phone card, a right-aligned cell under the header from `md`. */
  const stat = (key: string, field: string, label: string, value: React.ReactNode, accent = false) => (
    <div className="flex min-w-0 items-baseline justify-between gap-3 md:block md:text-right">
      <dt className="text-slate-500 md:sr-only" data-row={key}>
        {label}
      </dt>
      <dd
        className={`min-w-0 font-semibold tabular-nums ${accent ? "text-purple-700" : "text-slate-800"}`}
        data-testid={`sponsor-overview-${field}`}
        data-row={key}
      >
        {value}
      </dd>
    </div>
  );

  return (
    <div className="grid min-w-0 gap-5" data-testid="sponsor-overview">
      <div className="grid min-w-0 gap-1.5 sm:max-w-xs">
        <label htmlFor="sponsor-overview-period" className="text-sm font-medium text-slate-700">
          {msg("sponsors.overview.periodLabel")}
        </label>
        <select
          id="sponsor-overview-period"
          data-testid="sponsor-overview-period"
          className="select w-full min-w-0"
          value={periodParam(period) ?? THIS_YEAR_VALUE}
          onChange={(e) => router.push(overviewHref(orgSlug, resolveSponsorPeriod(e.target.value, competitions)))}
        >
          <option value={THIS_YEAR_VALUE}>{msg("sponsors.overview.period.this_year")}</option>
          <option value="last_30_days">{msg("sponsors.overview.period.last_30_days")}</option>
          {competitions.length > 0 && (
            <optgroup label={msg("sponsors.overview.periodCompetitions")}>
              {competitions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <p className="text-xs text-slate-500" data-testid="sponsor-overview-window">
          {dates !== null
            ? msg("sponsors.overview.window", { from: fmtIsoDay(locale, dates.from), to: fmtIsoDay(locale, dates.to) })
            : msg("sponsors.overview.windowCompetition")}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="grid min-w-0 justify-items-start gap-3 rounded-xl border border-dashed border-purple-200 p-4 sm:p-5" data-testid="sponsor-overview-empty">
          <p className="max-w-prose text-sm text-slate-600">{msg("sponsors.overview.empty")}</p>
          {canEdit && (
            <Link href={sponsorsHref(orgSlug, "sponsors")} className="btn btn-primary" data-testid="sponsor-overview-empty-link">
              {msg("sponsors.overview.emptyLink")}
            </Link>
          )}
        </div>
      ) : (
        <div className="grid min-w-0">
          <div aria-hidden="true" className={`hidden min-w-0 gap-3 border-b border-slate-200 pb-2 text-xs font-medium text-slate-500 md:grid ${cols}`}>
            <span>{msg("sponsors.overview.col.sponsor")}</span>
            <span className="grid grid-cols-4 gap-3 text-right">
              <span>{msg("sponsors.overview.col.timesShown")}</span>
              <span>{msg("sponsors.overview.col.onScreen")}</span>
              <span>{msg("sponsors.overview.col.viewerImpressions")}</span>
              <span>{msg("sponsors.overview.col.linkClicks")}</span>
            </span>
            {sharable && <span />}
          </div>
          <ul aria-label={msg("sponsors.overview.listLabel")} className="grid min-w-0 gap-3 md:gap-0" data-testid="sponsor-overview-list">
            {rows.map((r) => {
              const key = rowKey(r);
              const panelId = `sponsor-share-${key}`;
              const open = r.sponsorId !== null && sharing === r.sponsorId;
              return (
                <li
                  key={key}
                  data-testid={`sponsor-overview-row-${key}`}
                  className="min-w-0 rounded-xl border border-slate-200 p-3 md:rounded-none md:border-0 md:border-b md:border-slate-100 md:px-0 md:py-3"
                >
                  <div className={`grid min-w-0 gap-3 md:items-center ${cols}`}>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-medium text-slate-800" title={r.name} data-testid="sponsor-overview-name">
                        {r.name}
                      </span>
                      {r.sponsorId === null && (
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{msg("sponsors.overview.deleted")}</span>
                      )}
                    </div>
                    <dl className="grid min-w-0 gap-1.5 text-sm md:grid-cols-4 md:gap-3">
                      {stat(key, "times", msg("sponsors.overview.col.timesShown"), count(r.timesShown))}
                      {stat(key, "onscreen", msg("sponsors.overview.col.onScreen"), fmtOnScreen(locale, r.onScreenMs), true)}
                      {stat(
                        key,
                        "viewers",
                        msg("sponsors.overview.col.viewerImpressions"),
                        r.viewerImpressions === null ? (
                          dash(msg("sponsors.overview.notMeasured"))
                        ) : (
                          <>
                            {count(r.viewerImpressions)}
                            {r.peakViewers !== null && (
                              <span className="block text-xs font-normal text-slate-500">
                                {msg("sponsors.overview.peak", { count: fmtNumber(locale, r.peakViewers) })}
                              </span>
                            )}
                          </>
                        ),
                      )}
                      {stat(key, "clicks", msg("sponsors.overview.col.linkClicks"), count(r.linkClicks))}
                    </dl>
                    {sharable && (
                      <div className="min-w-0 md:text-right">
                        {r.sponsorId !== null && (
                          <button
                            type="button"
                            className="btn btn-ghost w-full px-2.5 py-1.5 text-xs md:w-auto"
                            data-testid="sponsor-overview-share"
                            data-row={key}
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={() => setSharing(open ? null : r.sponsorId)}
                          >
                            {msg("sponsors.overview.share")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  {open && shareDefaults !== null && (
                    <ShareReport
                      id={panelId}
                      orgId={orgId}
                      sponsor={{ id: r.sponsorId!, name: r.name }}
                      defaults={shareDefaults}
                      competitionName={competitionName}
                      links={links.filter((l) => l.sponsorId === r.sponsorId)}
                      onClose={() => setSharing(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <dl aria-label={msg("sponsors.overview.notesLabel")} className="grid min-w-0 gap-1.5 border-t border-slate-100 pt-4 text-xs text-slate-500" data-testid="sponsor-overview-notes">
          <div>
            <dt className="inline font-medium text-slate-600">{msg("sponsors.overview.col.linkClicks")}</dt>{" "}
            <dd className="inline">{msg("sponsors.overview.clicksFootnote")}</dd>
            {period.kind === "competition" && (
              <>
                {" "}
                <dd className="inline" data-testid="sponsor-overview-competition-clicks-note">
                  {msg("sponsors.overview.competitionClicksFootnote", {
                    thisYear: msg("sponsors.overview.period.this_year"),
                    last30: msg("sponsors.overview.period.last_30_days"),
                  })}
                </dd>
              </>
            )}
          </div>
          <div>
            <dt className="inline font-medium text-slate-600">{msg("sponsors.overview.airingsTerm")}</dt>{" "}
            <dd className="inline">{msg("sponsors.overview.airingsFootnote")}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-slate-600">{msg("sponsors.overview.col.viewerImpressions")}</dt>{" "}
            <dd className="inline">{msg("sponsors.overview.viewersFootnote")}</dd>
          </div>
          {hasDeleted && (
            <div>
              <dt className="inline font-medium text-slate-600">{msg("sponsors.overview.deleted")}</dt>{" "}
              <dd className="inline">{msg("sponsors.overview.deletedFootnote")}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
