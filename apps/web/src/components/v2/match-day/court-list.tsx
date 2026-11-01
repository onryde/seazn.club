"use client";
// Match Day's court list (spec 2026-10-31 §6.1, task A3): one row per court — its name, what is on it now, and a stream badge
// ONLY while that court's match is live (§6.2: no badge otherwise, so a venue that never streams never sees one). On a phone
// this list is the home screen and a row opens its court full-screen; from md it is the left column and a row focuses its
// court on the right.
//
// A court whose playing match nobody is scoring carries the desk's mark for it (task A4, §9: "`no_scorer` / `not_recording` also
// mark the affected court's row"), the same fact as the Needs-you row, so the organiser sees WHICH court from the list.
//
// Under the courts, "Playing, no court" (task B4, owner ruling Q1): every match in play with no court — an untimed bracket
// match, an online board — one row each: the match, its division and stage, its score in the court rows' own form, a Live
// badge while its stream is, the scorer mark, and "Open pad" straight to its console. The row opens the match's panel beside
// (or, on a phone, over) the list, as a court row does. With no courts at all, the group is the whole list.
import { useId } from "react";
import Link from "@/components/ui/console-link";
import { ATTENTION_SEVERITY } from "@/lib/division-phase";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchDayCourt, MatchDayFixture } from "@/lib/match-day/types";
import { compactScore, courtScorerAttention, matchLabel, scoreLine } from "@/lib/match-day/view";
import { ScorerMark } from "./scorer-mark";

/** The state dot: green while playing, amber while called, an open ring while free, grey while another competition has it. */
const DOT: Record<MatchDayCourt["state"], string> = {
  playing: "bg-emerald-500",
  called: "bg-amber-500",
  free: "border-2 border-purple-400 bg-white",
  in_use_elsewhere: "bg-slate-300",
};

export function CourtList({
  courts,
  selectedId,
  dict,
  onSelect,
}: {
  courts: MatchDayCourt[];
  selectedId: string | null;
  dict: Dict;
  onSelect: (courtId: string) => void;
}) {
  return (
    <ul aria-label={t(dict, "matchDay.list.label")} className="card divide-y divide-purple-50 overflow-hidden">
      {courts.map((c) => {
        const selected = c.court_id === selectedId;
        const score = c.state === "playing" && c.current !== null ? scoreLine(c.current) : null;
        const scorer = courtScorerAttention(c);
        return (
          <li key={c.court_id}>
            <button
              type="button"
              data-testid="md-court-row"
              data-court-id={c.court_id}
              data-state={c.state}
              data-scorer={scorer ?? undefined}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(c.court_id)}
              className={`grid min-h-14 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 text-left transition hover:bg-purple-50/60 ${
                selected ? "md:bg-purple-50 md:shadow-[inset_3px_0_0_var(--color-purple-600)]" : ""
              } ${c.state === "in_use_elsewhere" ? "text-slate-500" : "text-slate-900"}`}
            >
              <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.state]}`} />
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold">{c.court_name}</span>
                  {c.current?.stream === "live" && <LiveBadge dict={dict} />}
                </span>
                <span className="block truncate text-xs text-slate-600">{rowLine(dict, c)}</span>
                {/* The score on its own line (beside the name a real score squeezed the court's own name to "Cour…"), in the row's
                    own sans with tabular figures: games won and the current game's points for a set sport, the sport's own
                    headline otherwise (`scoreLine`, the panel's rule; review V4). */}
                {score !== null ? (
                  <span data-md-row-score className="mt-0.5 block text-xs font-semibold tabular-nums text-purple-900 [overflow-wrap:anywhere]">
                    {compactScore(score)}
                  </span>
                ) : null}
                {scorer !== null && (
                  <span className="mt-1 flex min-w-0">
                    <ScorerMark dict={dict} kind={scorer} severity={ATTENTION_SEVERITY[scorer]} />
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                {c.state === "called" ? (
                  <span className="text-xs font-semibold text-amber-700">{t(dict, "matchDay.state.called")}</span>
                ) : c.state === "free" ? (
                  <span className="text-xs font-semibold text-purple-700">{t(dict, "matchDay.state.free")}</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Live" beside a row's name while its match's stream is. */
function LiveBadge({ dict }: { dict: Dict }) {
  return (
    <span
      data-md-stream="live"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-100"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-600" />
      {t(dict, "matchDay.stream.live")}
    </span>
  );
}

/** "Playing, no court" (B4): the matches in play on no court, under the courts. Nothing when there is none. */
export function NoCourtList({
  fixtures,
  selectedId,
  dict,
  hrefOf,
  openLabel,
  onSelect,
}: {
  fixtures: readonly MatchDayFixture[];
  /** The match whose panel is open, when it is one of these. */
  selectedId: string | null;
  dict: Dict;
  /** The match's console page (`fixtureHref`). */
  hrefOf: (f: MatchDayFixture) => string;
  /** "Open pad", or "Open match" for a view-only reader. */
  openLabel: string;
  onSelect: (fixture: MatchDayFixture) => void;
}) {
  const headingId = useId();
  if (fixtures.length === 0) return null;
  return (
    <section data-testid="md-no-court" aria-labelledby={headingId} className="min-w-0">
      <h2 id={headingId} className="mb-2 px-1 text-xs font-semibold text-slate-600">
        {t(dict, "matchDay.noCourt.title")}
      </h2>
      <ul className="card divide-y divide-purple-50 overflow-hidden">
        {fixtures.map((f) => {
          const selected = f.id === selectedId;
          const score = scoreLine(f);
          const scorer = f.scorer_attention;
          return (
            <li
              key={f.id}
              className={`flex min-w-0 items-stretch transition ${
                selected ? "md:bg-purple-50 md:shadow-[inset_3px_0_0_var(--color-purple-600)]" : ""
              }`}
            >
              <button
                type="button"
                data-testid="md-no-court-row"
                data-fixture-id={f.id}
                data-scorer={scorer ?? undefined}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(f)}
                className="grid min-h-14 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 py-3 pl-4 pr-2 text-left text-slate-900 transition hover:bg-purple-50/60"
              >
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold">{matchLabel(dict, f)}</span>
                    {f.stream === "live" && <LiveBadge dict={dict} />}
                  </span>
                  <span className="block truncate text-xs text-slate-600">
                    {f.division_name} · {f.stage_label}
                  </span>
                  {score !== null ? (
                    <span data-md-row-score className="mt-0.5 block text-xs font-semibold tabular-nums text-purple-900 [overflow-wrap:anywhere]">
                      {compactScore(score)}
                    </span>
                  ) : null}
                  {scorer !== null && (
                    <span className="mt-1 flex min-w-0">
                      <ScorerMark dict={dict} kind={scorer} severity={ATTENTION_SEVERITY[scorer]} />
                    </span>
                  )}
                </span>
              </button>
              {/* A sibling of the row, never inside its button: one control per target. */}
              <Link
                href={hrefOf(f)}
                data-testid="md-no-court-open"
                // Every row's link reads the same word: the match names which one (the visible words lead, label-in-name).
                aria-label={`${openLabel}: ${matchLabel(dict, f)}`}
                className="inline-flex min-h-11 shrink-0 items-center self-center rounded-lg px-4 text-xs font-semibold text-purple-700 underline-offset-2 hover:underline"
              >
                {openLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The row's second line: the match on it, or who has it. A free court's word sits on the right, so its line names the
 *  next match planned here when there is one. */
function rowLine(dict: Dict, c: MatchDayCourt): string {
  if (c.state === "in_use_elsewhere") return t(dict, "matchDay.state.inUse", { competition: c.in_use_by ?? "" });
  if (c.current !== null) return matchLabel(dict, c.current);
  const next = c.queue[0];
  return next === undefined ? "" : matchLabel(dict, next);
}
