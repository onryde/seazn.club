"use client";
// Match Day (spec 2026-10-31 §6, task A3): "court list + focus" (owner pick C). The header — "Match Day · <weekday date>", the
// competition, "N courts · N playing · N free", the division chips — then the court list and the focused court: two columns
// from md, and on a phone the list as home with a court opening full-screen over it ("‹ All courts" back). One DOM, branched
// with max-md:/md:hidden (AGENTS.md "The phone composition").
//
// SSR-first, then polled through the competition desk's own schedule (desk/band-poll.ts): fast while a match is playing or
// called, slow while the day is quiet, paused while the tab is hidden. A poll that fails (a rare race on the server, task A2
// m1) or answers something that is not a view (a cut-off 200, review M1) keeps the last view and tries again on the next tick.
//
// The court the organiser opened stays opened only while it is on the list: when the filter or the day takes it away, the page
// says so and goes back to the list — never silently onto a different court (review M6), and a phone sent back to the list is
// not jumped into the court again if it returns (M6b). A refused call or undo is kept per
// court through the refresh it triggers, until dismissed or another court is opened (review M5).
//
// Needs you (spec §6.3, §9; task A4): on a match day the competition's whole Needs-you list lives HERE, behind one attention
// button in the header — "11 need you · 3 results owed" — that opens the desk's own list (`NeedsYou`, reused) with the results
// owed first, each with Enter result. No list, no button. A middle-dot line never leaves a dot dangling at a wrap (`DotLine`).
//
// Task B4 (owner rulings Q1, 2026-10-31):
//  - "Playing, no court": the matches in play with no court (an untimed bracket match, an online board) list under the courts
//    and open a panel of their own (`NoCourtFocus`) — and on a day with no courts at all they ARE the list, rather than "No
//    courts to run yet". Only a day with neither says so, and says what to do;
//  - a view-only member (`readOnly`) gets the same page with nothing that writes, and without the Needs-you list;
//  - Needs you's unscheduled row carries "Find a court": the first free court's candidates, opened in place (`?court=` when
//    the link is opened another way), or back to the list when no court is free.
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicDate } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import type { Severity } from "@/lib/division-phase";
import type { MatchDayView } from "@/lib/match-day/types";
import type { ViewerPlan } from "@/lib/viewer-plan";
import {
  filterCourts,
  filterNoCourt,
  headerCountParts,
  isLive,
  isMatchDayView,
  matchLabel,
  needsYouButtonParts,
  needsYouOrder,
  needsYouTone,
  noCourtNoun,
  resolveFocus,
  sharedNoun,
  type Opened,
} from "@/lib/match-day/view";
import { browserBandPollDeps, startBandPolling } from "@/components/v2/desk/band-poll";
import { NeedsYou } from "@/components/v2/desk/needs-you";
import { CourtFocus, NoCourtFocus, fixtureHref, type MatchDayCtx } from "./court-focus";
import { CourtList, NoCourtList } from "./court-list";

export interface MatchDayShellProps {
  competitionId: string;
  competitionName: string;
  orgSlug: string;
  compSlug: string;
  locale: Locale;
  /** The competition's live divisions, for the filter chips. */
  divisions: { id: string; name: string }[];
  initial: MatchDayView;
  /** The `ui` dictionary's `matchDay.*` keys, and the borrowed ones the page lists (page.tsx). */
  dict: Dict;
  /** The `public` dictionary's scoreboard keys (`LiveScoreBody`). */
  scoreDict: Dict;
  /** The organisation's plan class, for the scorer QR's paywall copy. */
  viewerPlan: ViewerPlan;
  /** A member who may view but not edit (B4, owner ruling Q1b): the page with nothing that writes. */
  readOnly?: boolean;
  /** `?court=<id>`: the court to open first (Needs you's "Find a court" link, opened another way). Ignored when not on the list. */
  focusCourtId?: string | null;
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
  viewerPlan,
  readOnly = false,
  focusCourtId = null,
}: MatchDayShellProps) {
  const [view, setView] = useState<MatchDayView>(initial);
  /** The court the organiser opened (its name kept to say so if it leaves the list); null until one is. */
  const [opened, setOpened] = useState<Opened | null>(() => {
    const court = focusCourtId === null ? undefined : initial.courts.find((c) => c.court_id === focusCourtId);
    return court === undefined ? null : { kind: "court", id: court.court_id, name: court.court_name };
  });
  /** On a phone: the list (false) or one court full-screen (true). Desktop shows both and ignores it. A `?court=` that names a
   *  court on the list opens it full-screen, as tapping it would. */
  const [phoneOpen, setPhoneOpen] = useState(() => opened !== null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ courtId: string; message: string } | null>(null);
  /** The Needs-you list, open under the header. */
  const [needsOpen, setNeedsOpen] = useState(false);
  const needsId = useId();

  const refresh = useCallback(async () => {
    try {
      const next = await apiV1<unknown>(`/api/v1/competitions/${competitionId}/match-day`);
      if (isMatchDayView(next)) setView(next);
    } catch {
      // Keep the last view; the next tick tries again.
    }
  }, [competitionId]);

  const live = isLive(view);
  useEffect(() => startBandPolling(live, () => void refresh(), browserBandPollDeps()), [live, refresh]);

  const filter = chosen.size === 0 ? null : chosen;
  const courts = useMemo(() => filterCourts(view.courts, filter), [view.courts, filter]);
  const noCourt = useMemo(() => filterNoCourt(view.playing_no_court, filter), [view.playing_no_court, filter]);
  const focus = resolveFocus(courts, noCourt, opened);
  const focused = focus.kind === "court" ? focus.court : null;
  const focusedMatch = focus.kind === "match" ? focus.fixture : null;
  // A phone whose court left the list is back on the list (review M6b): it stays there when the court returns, rather than
  // jumping back into a court the organiser was told had gone. React's render-phase adjustment, not an effect.
  if (phoneOpen && focus.kind === "lost") setPhoneOpen(false);
  // Same adjustment for the Needs-you list (fix round 1, m5): once a poll empties it, the button goes and the list is CLOSED,
  // so rows arriving later bring the button back closed rather than reopening the list unasked. A view-only reader never has it.
  const needsYou = readOnly ? [] : view.needs_you;
  if (needsOpen && needsYou.length === 0) setNeedsOpen(false);
  /** A phone shows one court (or match) full-screen only while what it opened is still there. */
  const phoneCourt = phoneOpen && (focused !== null || focusedMatch !== null);
  const noun = sharedNoun(courts.length > 0 ? courts : view.courts);
  const ctx: MatchDayCtx = { competitionId, orgSlug, compSlug, locale, tz: view.tz, dict, scoreDict, viewerPlan, readOnly };
  const needsTone = needsYouTone(needsYou);
  const date = fmtPublicDate(locale, "UTC", `${view.date}T12:00:00Z`, { weekday: "long", day: "numeric", month: "short" });

  const toTop = () => {
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches) window.scrollTo({ top: 0 });
  };
  const open = (courtId: string) => {
    setOpened({ kind: "court", id: courtId, name: courts.find((c) => c.court_id === courtId)?.court_name ?? "" });
    setNotice((n) => (n !== null && n.courtId === courtId ? n : null));
    setPhoneOpen(true);
    toTop();
  };
  const openMatch = (f: MatchDayView["playing_no_court"][number]) => {
    setOpened({ kind: "match", id: f.id, name: matchLabel(dict, f) });
    setNotice(null);
    setPhoneOpen(true);
    toTop();
  };
  /** Needs you's "Find a court", in place (R2): the court the server chose — the first free one the division's ready match may
   *  be called onto — opened on its candidates, or the list when none is free. */
  const findCourt = (courtId: string | null) => {
    setNeedsOpen(false);
    if (courtId !== null) open(courtId);
    else {
      setPhoneOpen(false);
      toTop();
    }
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
      <header data-testid="md-header" className={`mb-5 min-w-0${phoneCourt ? " max-md:hidden" : ""}`}>
        <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
          <div className="min-w-0">
            <h1 className="page-title min-w-0 [overflow-wrap:anywhere]">{t(dict, "matchDay.title", { date })}</h1>
            {/* The competition on a line of its own and the counts on the next: a "·" between the two hung at the end of the
                line whenever a phone wrapped them (A3 carry-in). */}
            <p className="mt-2 min-w-0 text-sm">
              <Link
                href={routes.competition(orgSlug, compSlug)}
                aria-label={t(dict, "matchDay.backToCompetition", { competition: competitionName })}
                className="font-medium text-purple-800 underline-offset-2 [overflow-wrap:anywhere] hover:underline"
              >
                {competitionName}
              </Link>
            </p>
            <DotLine
              testId="md-counts"
              className="mt-0.5 text-sm text-slate-600"
              parts={headerCountParts(dict, locale, noun, courts, noCourt)}
            />
            {readOnly && (
              <p data-testid="md-read-only" className="mt-2 text-xs text-slate-600">
                {t(dict, "matchDay.readOnly")}
              </p>
            )}
          </div>
          {needsTone !== null && (
            <button
              type="button"
              data-testid="md-needs-you-toggle"
              data-severity={needsTone}
              aria-expanded={needsOpen}
              aria-controls={needsId}
              onClick={() => setNeedsOpen((o) => !o)}
              className={`inline-flex min-h-11 min-w-0 shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2 text-left text-sm font-semibold ring-1 ring-inset transition max-md:w-full md:max-w-[22rem] ${NEEDS_TONE[needsTone]}`}
            >
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${NEEDS_DOT[needsTone]}`} />
              <DotLine className="min-w-0 flex-1" parts={needsYouButtonParts(dict, { ...view, needs_you: needsYou }, locale)} />
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className={`h-4 w-4 shrink-0 fill-none stroke-current transition-transform motion-reduce:transition-none ${needsOpen ? "rotate-180" : ""}`}
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
          )}
        </div>
        {needsTone !== null && (
          <div id={needsId} data-testid="md-needs-you" hidden={!needsOpen} className="mt-4 min-w-0 [&_[data-testid=desk-needs-you]]:mb-0">
            {needsOpen && (
              <NeedsYou
                dict={dict}
                items={needsYouOrder(needsYou)}
                onAlt={(it) => findCourt(it.alt?.court_id ?? null)}
              />
            )}
          </div>
        )}
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

      {courts.length === 0 && noCourt.length === 0 ? (
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
          {focus.kind === "lost" && (
            <div data-testid="md-lost" role="status" className="card mb-4 min-w-0 p-5 md:col-start-2 md:row-start-1 md:mb-0">
              <p className="font-semibold text-slate-900 [overflow-wrap:anywhere]">{t(dict, "matchDay.focus.left", { court: focus.name })}</p>
              <p className="mt-1 text-sm text-slate-600">{t(dict, "matchDay.focus.pick")}</p>
            </div>
          )}
          <div data-testid="md-list" className={`grid min-w-0 gap-5 md:col-start-1 md:row-start-1${phoneCourt ? " max-md:hidden" : ""}`}>
            {courts.length > 0 && <CourtList courts={courts} selectedId={focused?.court_id ?? null} dict={dict} onSelect={open} />}
            <NoCourtList
              fixtures={noCourt}
              noun={noCourtNoun(noCourt)}
              selectedId={focusedMatch?.id ?? null}
              dict={dict}
              hrefOf={(f) => fixtureHref(ctx, f)}
              openLabel={t(dict, readOnly ? "matchDay.focus.openMatch" : "matchDay.focus.openPad")}
              onSelect={openMatch}
            />
          </div>
          {focused !== null && (
            <CourtFocus
              ctx={ctx}
              court={focused}
              backLabel={t(dict, `matchDay.back.${noun}`)}
              onBack={() => setPhoneOpen(false)}
              onChanged={() => {
                setNotice(null);
                void refresh();
              }}
              onRefused={(message) => {
                setNotice({ courtId: focused.court_id, message });
                void refresh();
              }}
              notice={notice !== null && notice.courtId === focused.court_id ? notice.message : null}
              onDismissNotice={() => setNotice(null)}
              refreshKey={view.now}
              divisions={filter}
              hiddenOnPhone={!phoneCourt}
            />
          )}
          {focusedMatch !== null && (
            <NoCourtFocus
              key={focusedMatch.id}
              ctx={ctx}
              fixture={focusedMatch}
              backLabel={t(dict, courts.length > 0 ? `matchDay.back.${noun}` : "matchDay.back.list")}
              onBack={() => setPhoneOpen(false)}
              onChanged={() => void refresh()}
              hiddenOnPhone={!phoneCourt}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The header button's tone, from its most urgent row (the Needs-you list's own severities). */
const NEEDS_TONE: Record<Severity, string> = {
  red: "bg-red-50 text-red-900 ring-red-200 hover:bg-red-100",
  amber: "bg-amber-50 text-amber-950 ring-amber-200 hover:bg-amber-100",
  slate: "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50",
};
const NEEDS_DOT: Record<Severity, string> = { red: "bg-red-600", amber: "bg-amber-600", slate: "bg-slate-500" };

/**
 * Words joined by a middle dot that never dangles (A3 carry-in: on a phone the header's "·" hung at the end of a wrapped line).
 * Each part carries its dot IN FRONT of it, and every part is pulled left by the dot's width inside a box that clips its left
 * edge: a part that starts a line has its dot in the clipped strip, a part beside another shows it. So a wrap — wherever the
 * reader's width and language put it — never ends or starts a line on a dot. The dot is decoration (aria-hidden).
 */
export function DotLine({ parts, className = "", testId }: { parts: readonly ReactNode[]; className?: string; testId?: string }) {
  return (
    <span data-testid={testId} className={`flex min-w-0 flex-wrap gap-x-[1.25em] overflow-hidden ${className}`}>
      {parts.map((p, i) => (
        <span key={i} data-dot-part className="-ml-[1.25em] inline-flex min-w-0">
          <span aria-hidden data-dot className="inline-block w-[1.25em] shrink-0 text-center">
            ·
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{p}</span>
        </span>
      ))}
    </span>
  );
}

function chipClass(on: boolean): string {
  return `inline-flex min-h-11 items-center rounded-full px-3 text-xs font-medium ring-1 ring-inset transition md:min-h-8 ${
    on ? "bg-purple-600 text-white ring-purple-600" : "bg-white text-purple-800 ring-purple-200 hover:bg-purple-50"
  }`;
}
