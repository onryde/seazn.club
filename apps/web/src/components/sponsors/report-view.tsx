// components/sponsors/report-view.tsx - R4 sponsors on stream, S14: the page a sponsor opens from a club's report link
// (spec 2026-10-27 §5.2). A SERVER component: it is handed the report and the reader's dictionary and draws; it reads nothing.
//
// The sponsor leads (owner mock, "their brand leads, Seazn recedes"): their logo and name head the sheet, then the three
// figures under spec §5.2's own labels, then every showing with the frame the broadcast carried. House public theme (the
// `--ps-*` tokens, the Barlow Condensed display face the root layout mounts), one DOM for every width: one column on a phone,
// the figures in a row from `sm`, the showings in two then three columns. Print: the sheet loses its card chrome, the button
// hides, and a showing never splits across a page.
//
// Long names (Review Focus 5): a showing's match is two lines (home; the join and away - final review S14 m2), each truncating
// with `min-w-0` on every box down to it, the full label kept in `title`; the sponsor's own name WRAPS (`break-words`) - a report never cuts off the name of the company it is for.
import type { CSSProperties } from "react";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { fmtNumber } from "@/lib/format";
import { fmtIsoDay, fmtOnScreen, type SponsorReport, type SponsorReportShowing } from "@/lib/sponsor-report";
import { PrintButton } from "@/components/print-button";
import { breakMsgKey } from "@/components/sponsors/break-labels";

/** The root layout mounts Barlow Condensed as `--font-barlow`; the public theme's `font-display` reads `--ps-font-display`. */
const DISPLAY_FACE = { "--ps-font-display": "var(--font-barlow)" } as CSSProperties;

/** A figure that is not measured yet: a dash to the eye, words to a screen reader (the Overview's own rule). */
function Dash({ words }: { words: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{words}</span>
    </>
  );
}

/** The break a showing filled, by the `naturalBreaks` kind its airing carries: the ONE map the On stream tab reads too
 *  (`break-labels.ts`), with its one fallback. A carousel showing with no kind is the stream's break screen. */
export function breakLabel(ui: Dict, s: Pick<SponsorReportShowing, "breakKind" | "source">): string {
  if (s.breakKind === null && s.source === "scene") return t(ui, "sponsorReport.break.scene");
  return t(ui, breakMsgKey(s.breakKind));
}

export function matchLabel(ui: Dict, match: SponsorReportShowing["match"]): string {
  if (match === null) return t(ui, "sponsorReport.match.gone");
  const tbd = t(ui, "sponsorReport.match.tbd");
  return t(ui, "sponsorReport.match.sides", { home: match.home ?? tbd, away: match.away ?? tbd });
}

/** The match line as TWO lines (final review S14 m2): the home side, then the dictionary's own join and the away side, so a
 *  long home name can never truncate the away side out of sight at 320. Every locale's label leads with `{home}` (pinned in
 *  the tests), so the second line is the label with an empty home. Null for a deleted fixture: one line, as before. */
export function matchLines(ui: Dict, match: SponsorReportShowing["match"]): [string, string] | null {
  if (match === null) return null;
  const tbd = t(ui, "sponsorReport.match.tbd");
  return [match.home ?? tbd, t(ui, "sponsorReport.match.sides", { home: "", away: match.away ?? tbd }).trimStart()];
}

/** Two initials for a sponsor with no logo (the hub's tile rule): the first letters of the first two words. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join("");
}

function Showing({ s, ui, locale }: { s: SponsorReportShowing; ui: Dict; locale: Locale }) {
  const match = matchLabel(ui, s.match);
  const lines = matchLines(ui, s.match);
  return (
    <li data-testid="report-showing" className="min-w-0 break-inside-avoid">
      <figure className="min-w-0 overflow-hidden rounded-xl border border-accent-line bg-surface print:rounded-md">
        {s.frameUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived SIGNED url to a private bucket: next/image would re-fetch it through the optimiser, which has no rule for it
          <img
            src={s.frameUrl}
            alt={t(ui, "sponsorReport.frame.alt", { match })}
            loading="eager"
            referrerPolicy="no-referrer"
            className="block aspect-video w-full bg-court object-cover"
          />
        ) : (
          <div
            data-testid="report-frame-missing"
            className="grid aspect-video w-full place-items-center bg-accent-soft bg-[repeating-linear-gradient(135deg,transparent_0_10px,rgb(124_58_237/0.06)_10px_20px)] px-4 text-center text-xs text-ink-muted"
          >
            {t(ui, "sponsorReport.frame.missing")}
          </div>
        )}
        <figcaption className="min-w-0 px-3 pt-2.5 pb-3">
          <p className="min-w-0 text-sm font-semibold text-ink" title={match}>
            {lines === null ? (
              <span className="block truncate">{match}</span>
            ) : (
              <>
                {/* The space keeps the label's own words in the text (a reader, a copy, `textContent`); two blocks draw it as two lines. */}
                <span className="block truncate">{lines[0]}</span>{" "}
                <span className="block truncate">{lines[1]}</span>
              </>
            )}
          </p>
          <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-ink-muted">
            <span className="min-w-0">{breakLabel(ui, s)}</span>
            <span className="shrink-0 tabular-nums">
              {s.onScreenMs === null
                ? t(ui, "sponsorReport.showing.open")
                : t(ui, "sponsorReport.showing.onScreen", { duration: fmtOnScreen(locale, s.onScreenMs) })}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            <time dateTime={s.startedAt}>{fmtIsoDay(locale, s.startedAt.slice(0, 10))}</time>
          </p>
        </figcaption>
      </figure>
    </li>
  );
}

export function SponsorReportView({ report, ui, locale }: { report: SponsorReport; ui: Dict; locale: Locale }) {
  const { sponsor } = report;
  const scope = report.competition ?? t(ui, "sponsorReport.scope.all");
  const period = t(ui, "sponsorReport.period", { from: fmtIsoDay(locale, report.period.from), to: fmtIsoDay(locale, report.period.to) });
  const latest = report.timesShown > report.showings.length;
  return (
    <main
      data-testid="sponsor-report"
      style={DISPLAY_FACE}
      className="min-h-screen bg-canvas px-3 py-6 text-ink sm:px-6 sm:py-10 print:min-h-0 print:bg-white print:p-0"
    >
      <article className="mx-auto min-w-0 max-w-5xl overflow-hidden rounded-2xl border border-accent-line bg-surface shadow-[0_10px_30px_-18px_rgb(35_23_56/0.45)] print:max-w-none print:rounded-none print:border-0 print:shadow-none">
        <header className="flex min-w-0 items-start gap-4 border-b border-accent-line px-4 py-5 sm:items-center sm:gap-5 sm:px-8 sm:py-7">
          <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-accent-line bg-white sm:size-20">
            {sponsor.logoUrl !== null ? (
              // eslint-disable-next-line @next/next/no-img-element -- the sponsor's logo is a URL the club typed (any host): next/image only optimises the hosts next.config names
              <img src={sponsor.logoUrl} alt="" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain p-1.5" />
            ) : (
              <span aria-hidden="true" className="font-display text-xl font-bold text-accent-strong sm:text-2xl">
                {initials(sponsor.name)}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-tight font-bold break-words text-ink sm:text-4xl">
              {t(ui, "sponsorReport.heading", { sponsor: sponsor.name, org: report.orgName })}
            </h1>
            <p className="mt-1.5 text-sm break-words text-ink-muted sm:text-base">
              <span className="font-medium text-ink">{scope}</span>
              <span aria-hidden="true">{", "}</span>
              {period}
            </p>
          </div>
        </header>

        <section aria-label={t(ui, "sponsorReport.statsLabel")}>
          <dl className="grid grid-cols-1 divide-y divide-accent-line border-b border-accent-line sm:grid-cols-3 sm:divide-x sm:divide-y-0 print:grid-cols-3 print:divide-x print:divide-y-0">
            <div className="flex min-w-0 flex-col-reverse gap-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
              <dt className="text-sm text-ink-muted">
                {plural(ui, "sponsorReport.stat.onScreen", report.timesShown, locale, { count: fmtNumber(locale, report.timesShown) })}
              </dt>
              <dd data-testid="report-on-screen" className="font-display text-4xl leading-none font-bold tabular-nums text-balance text-accent-strong lg:text-5xl">
                {fmtOnScreen(locale, report.onScreenMs)}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col-reverse gap-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
              <dt className="text-sm text-ink-muted">{t(ui, "sponsorReport.stat.viewers")}</dt>
              <dd data-testid="report-viewers" className="font-display text-4xl leading-none font-bold tabular-nums text-balance text-ink-muted lg:text-5xl">
                {report.viewerImpressions === null ? <Dash words={t(ui, "sponsorReport.notAvailable")} /> : fmtNumber(locale, report.viewerImpressions)}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col-reverse gap-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
              <dt className="text-sm text-ink-muted">{plural(ui, "sponsorReport.stat.visits", report.streamVisits, locale)}</dt>
              <dd data-testid="report-stream-visits" className="font-display text-4xl leading-none font-bold tabular-nums text-balance text-ink lg:text-5xl">{fmtNumber(locale, report.streamVisits)}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="report-showings" className="px-4 py-5 sm:px-8 sm:py-7">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="report-showings" className="font-display text-xl font-semibold text-ink sm:text-2xl">
              {t(ui, "sponsorReport.showings.title")}
            </h2>
            {latest ? (
              <p className="text-xs text-ink-muted">
                {t(ui, "sponsorReport.showings.latest", { shown: fmtNumber(locale, report.showings.length), total: fmtNumber(locale, report.timesShown) })}
              </p>
            ) : null}
          </div>
          {report.showings.length === 0 ? (
            <p className="mt-3 max-w-prose text-sm text-ink-muted">{t(ui, "sponsorReport.showings.empty")}</p>
          ) : (
            <ul className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-3 print:gap-3">
              {report.showings.map((s) => (
                <Showing key={s.airingId} s={s} ui={ui} locale={locale} />
              ))}
            </ul>
          )}
        </section>

        <footer className="flex min-w-0 flex-col gap-3 border-t border-accent-line px-4 py-4 text-xs text-ink-muted sm:flex-row sm:items-end sm:justify-between sm:px-8">
          <div className="min-w-0 max-w-prose space-y-1">
            <p>{t(ui, "sponsorReport.footnote")}</p>
            <p>{t(ui, "sponsorReport.viewersNote")}</p>
            <p>{t(ui, "sponsorReport.asOf", { date: fmtIsoDay(locale, report.asOf.slice(0, 10)) })}</p>
          </div>
          <div className="shrink-0">
            <PrintButton label={t(ui, "sponsorReport.print")} />
          </div>
        </footer>
      </article>
    </main>
  );
}

/** The two answers that are not a report: the opaque 404 (not-found.tsx) and the throttled screen. Same quiet sheet. */
export function SponsorReportNotice({ testId, title, body }: { testId: string; title: string; body: string }) {
  return (
    <main data-testid={testId} style={DISPLAY_FACE} className="grid min-h-[70vh] place-items-center bg-canvas px-4 py-12 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-accent-line bg-surface px-6 py-8 text-center">
        <h1 className="font-display text-2xl font-bold text-ink">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{body}</p>
      </div>
    </main>
  );
}
