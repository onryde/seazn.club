"use client";
// Match Day (spec 2026-10-31 §6, task A3): "court list + focus" (owner pick C). The header — "Match Day · <weekday date>", the
// competition, "N courts · N playing · N free", the division chips — then the court list and the focused court: two columns
// from md, and on a phone the list as home with a court opening full-screen over it ("‹ All courts" back). One DOM, branched
// with max-md:/md:hidden (AGENTS.md "The phone composition").
//
// SSR-first, then polled through the competition desk's own schedule (desk/band-poll.ts): fast while a match is playing or
// called, slow while the day is quiet, paused while the tab is hidden. A poll that fails (a rare race on the server, task A2
// m1) keeps the last view and tries again on the next tick.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "@/components/ui/console-link";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicDate } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import type { MatchDayView } from "@/lib/match-day/types";
import { courtCounts, filterCourts, isLive, sharedNoun } from "@/lib/match-day/view";
import { browserBandPollDeps, startBandPolling } from "@/components/v2/desk/band-poll";
import { CourtFocus, type MatchDayCtx } from "./court-focus";
import { CourtList } from "./court-list";

export interface MatchDayShellProps {
  competitionId: string;
  competitionName: string;
  orgSlug: string;
  compSlug: string;
  locale: Locale;
  /** The competition's live divisions, for the filter chips. */
  divisions: { id: string; name: string }[];
  initial: MatchDayView;
  /** The `ui` dictionary's `matchDay.*` keys. */
  dict: Dict;
  /** The `public` dictionary's scoreboard keys (`LiveScoreBody`). */
  scoreDict: Dict;
}

export function MatchDayShell({
  competitionId,
  competitionName,
  orgSlug,
  compSlug,
  locale,
  divisions,
  initial,
  dict,
  scoreDict,
}: MatchDayShellProps) {
  const [view, setView] = useState<MatchDayView>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** On a phone: the list (false) or one court full-screen (true). Desktop shows both and ignores it. */
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setView(await apiV1<MatchDayView>(`/api/v1/competitions/${competitionId}/match-day`));
    } catch {
      // Keep the last view; the next tick tries again.
    }
  }, [competitionId]);

  const live = isLive(view);
  useEffect(() => startBandPolling(live, () => void refresh(), browserBandPollDeps()), [live, refresh]);

  const filter = chosen.size === 0 ? null : chosen;
  const courts = useMemo(() => filterCourts(view.courts, filter), [view.courts, filter]);
  // The focused court: the one tapped while it is still on the page, else the first.
  const focused = courts.find((c) => c.court_id === selectedId) ?? courts[0] ?? null;
  const counts = courtCounts(courts);
  const noun = sharedNoun(courts.length > 0 ? courts : view.courts);
  const ctx: MatchDayCtx = { competitionId, orgSlug, compSlug, locale, tz: view.tz, dict, scoreDict };
  const date = fmtPublicDate(locale, "UTC", `${view.date}T12:00:00Z`, { weekday: "long", day: "numeric", month: "short" });

  const open = (courtId: string) => {
    setSelectedId(courtId);
    setPhoneOpen(true);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches) window.scrollTo({ top: 0 });
  };
  const toggle = (divisionId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(divisionId)) next.delete(divisionId);
      else next.add(divisionId);
      return next;
    });

  return (
    <div data-testid="match-day" className="min-w-0">
      <header data-testid="md-header" className={`mb-5 min-w-0${phoneOpen ? " max-md:hidden" : ""}`}>
        <h1 className="page-title min-w-0 [overflow-wrap:anywhere]">{t(dict, "matchDay.title", { date })}</h1>
        <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
          <Link
            href={routes.competition(orgSlug, compSlug)}
            aria-label={t(dict, "matchDay.backToCompetition", { competition: competitionName })}
            className="min-w-0 font-medium text-purple-800 underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          >
            {competitionName}
          </Link>
          <span aria-hidden>·</span>
          <span data-testid="md-counts">
            {plural(dict, `matchDay.header.places.${noun}`, counts.courts, locale)} ·{" "}
            {t(dict, "matchDay.header.playing", { count: counts.playing })} · {t(dict, "matchDay.header.free", { count: counts.free })}
          </span>
        </p>
        {divisions.length > 1 && (
          <div role="group" aria-label={t(dict, "matchDay.filter.label")} className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={filter === null}
              onClick={() => setChosen(new Set())}
              className={chipClass(filter === null)}
            >
              {t(dict, "matchDay.filter.all")}
            </button>
            {divisions.map((d) => (
              <button
                key={d.id}
                type="button"
                data-testid="md-division-chip"
                aria-pressed={chosen.has(d.id)}
                onClick={() => toggle(d.id)}
                className={chipClass(chosen.has(d.id))}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
      </header>

      {courts.length === 0 ? (
        <div data-testid="md-empty" className="card p-6">
          <p className="font-semibold text-slate-900">{t(dict, "matchDay.empty.title")}</p>
          <p className="mt-1 text-sm text-slate-600">
            {filter === null ? t(dict, "matchDay.empty.body") : t(dict, "matchDay.empty.filtered")}
          </p>
          {filter === null && (
            <Link href={routes.competitionSchedule(orgSlug, compSlug)} className="btn btn-ghost mt-4 min-h-11">
              {t(dict, "matchDay.empty.schedule")}
            </Link>
          )}
        </div>
      ) : (
        <div className="min-w-0 md:grid md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] md:items-start md:gap-6 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          <div data-testid="md-list" className={`min-w-0${phoneOpen ? " max-md:hidden" : ""}`}>
            <CourtList courts={courts} selectedId={focused?.court_id ?? null} dict={dict} onSelect={open} />
          </div>
          {focused !== null && (
            <CourtFocus
              ctx={ctx}
              court={focused}
              backLabel={t(dict, `matchDay.back.${noun}`)}
              onBack={() => setPhoneOpen(false)}
              onChanged={() => void refresh()}
              refreshKey={view.now}
              divisions={filter}
              hiddenOnPhone={!phoneOpen}
            />
          )}
        </div>
      )}
    </div>
  );
}

function chipClass(on: boolean): string {
  return `inline-flex min-h-11 items-center rounded-full px-3 text-xs font-medium ring-1 ring-inset transition md:min-h-8 ${
    on ? "bg-purple-600 text-white ring-purple-600" : "bg-white text-purple-800 ring-purple-200 hover:bg-purple-50"
  }`;
}
