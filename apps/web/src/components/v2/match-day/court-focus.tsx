"use client";
// Match Day's focused court (spec 2026-10-31 §6.2, task A3), one panel per state:
//  - playing: the sport's scoreboard (court-scoreboard.tsx), its stream in the corner, Open pad, the queue;
//  - called: "Called: waiting for players", the match, Undo call (A1's DELETE …/call), the queue;
//  - free: "Court 5 is free" and the candidates (candidate-list.tsx);
//  - in use by another competition: greyed, named, nothing to press.
// On a phone it is a full screen of its own with "‹ All courts" back; from md it is the right-hand column.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicTime } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import type { MatchDayCourt, MatchDayFixture } from "@/lib/match-day/types";
import { matchLabel } from "@/lib/match-day/view";
import { FreeCourt } from "./candidate-list";
import { failureMessage } from "./call-sheet";
import { CourtScoreboard } from "./court-scoreboard";

/** What every Match Day panel reads: where it is, who reads it, and in which zone its times print. */
export interface MatchDayCtx {
  competitionId: string;
  orgSlug: string;
  compSlug: string;
  locale: Locale;
  /** The organisation's zone: the view's `tz`, which its date label is in. */
  tz: string;
  /** The `ui` dictionary's `matchDay.*` keys. */
  dict: Dict;
  /** The `public` dictionary's scoreboard keys, for `LiveScoreBody`. */
  scoreDict: Dict;
}

/** The match's console page: its pad and its per-match stream panel. */
export function fixtureHref(ctx: MatchDayCtx, f: MatchDayFixture): string {
  return routes.fixture(ctx.orgSlug, ctx.compSlug, f.division_slug, f.fixture_no);
}

export function CourtFocus({
  ctx,
  court,
  backLabel,
  onBack,
  onChanged,
  refreshKey,
  divisions,
  hiddenOnPhone = false,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  /** "All courts", in the courts' own noun. */
  backLabel: string;
  onBack: () => void;
  /** Something changed (a call, an undo, a refusal that proves the page stale): refresh the view now. */
  onChanged: () => void;
  /** Changes on every poll, so the free court's candidates follow the day. */
  refreshKey: string;
  divisions: ReadonlySet<string> | null;
  /** On a phone the list is home: the court opens over it only once tapped. */
  hiddenOnPhone?: boolean;
}) {
  const { dict } = ctx;
  const f = court.current;
  return (
    <section
      data-testid="md-focus"
      data-court-id={court.court_id}
      data-state={court.state}
      aria-label={court.court_name}
      className={`grid min-w-0 content-start gap-4${hiddenOnPhone ? " max-md:hidden" : ""}`}
    >
      <button
        type="button"
        data-testid="md-back"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-11 items-center gap-1 justify-self-start rounded-lg px-2 text-sm font-medium text-purple-700 hover:bg-purple-50 md:hidden"
      >
        <span aria-hidden>‹</span>
        {backLabel}
      </button>

      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-purple-950">{court.court_name}</h2>
          <p className="truncate text-xs text-slate-600">
            <span>{t(dict, `matchDay.noun.${court.sport_noun}`)}</span> · <span>{court.venue_name}</span>
          </p>
        </div>
        {f !== null && (court.state === "playing" || court.state === "called") && (
          <Link href={fixtureHref(ctx, f)} className="btn btn-ghost min-h-11 shrink-0 text-sm lg:min-h-0 lg:py-1.5">
            {t(dict, "matchDay.focus.openPad")}
          </Link>
        )}
      </header>

      {court.state === "playing" && f !== null && (
        <>
          <MatchLine ctx={ctx} fixture={f} />
          <CourtScoreboard
            fixture={f}
            courtName={court.court_name}
            streamHref={`${fixtureHref(ctx, f)}?stream=open`}
            dict={dict}
            scoreDict={ctx.scoreDict}
          />
        </>
      )}
      {court.state === "called" && f !== null && <CalledPanel ctx={ctx} fixture={f} onChanged={onChanged} />}
      {court.state === "free" && (
        <FreeCourt key={court.court_id} ctx={ctx} court={court} refreshKey={refreshKey} divisions={divisions} onChanged={onChanged} />
      )}
      {court.state === "in_use_elsewhere" && (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-100 p-5 text-slate-600">
          <p className="text-lg font-semibold text-slate-700">
            {t(dict, "matchDay.state.inUse", { competition: court.in_use_by ?? "" })}
          </p>
          <p className="mt-1 text-sm">{t(dict, "matchDay.inUse.body")}</p>
        </div>
      )}

      {court.state !== "free" && <Queue ctx={ctx} court={court} />}
    </section>
  );
}

/** The match on court: who, which division and stage, and when it started. */
function MatchLine({ ctx, fixture }: { ctx: MatchDayCtx; fixture: MatchDayFixture }) {
  const { dict } = ctx;
  return (
    <div className="min-w-0">
      <p className="text-lg font-semibold text-slate-900 [overflow-wrap:anywhere]">{matchLabel(dict, fixture)}</p>
      <p className="text-xs text-slate-600 [overflow-wrap:anywhere]">
        {fixture.division_name} · {fixture.stage_label}
        {fixture.started_at !== null && (
          <> · {t(dict, "matchDay.focus.started", { time: fmtPublicTime(ctx.locale, ctx.tz, fixture.started_at) })}</>
        )}
      </p>
    </div>
  );
}

/** A called match not started yet, and the way back: Undo call restores its old court and time (A1). Undo is refused
 *  NOT_CALLED once the scorer has started or the board has moved the match; the page then refreshes to what is true. */
function CalledPanel({ ctx, fixture, onChanged }: { ctx: MatchDayCtx; fixture: MatchDayFixture; onChanged: () => void }) {
  const { dict } = ctx;
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}/call`, { method: "DELETE" });
    } catch (err) {
      setRefusal(failureMessage(ctx, err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div data-testid="md-called-panel" className="rounded-2xl bg-court p-5 text-court-ink shadow-lg sm:p-6">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
        <span aria-hidden className="h-2 w-2 rounded-full bg-amber-400" />
        {t(dict, "matchDay.called.title")}
      </p>
      <p className="mt-3 font-display text-2xl font-semibold [overflow-wrap:anywhere] sm:text-3xl">{matchLabel(dict, fixture)}</p>
      <p className="mt-1 text-sm text-court-muted [overflow-wrap:anywhere]">
        {fixture.division_name} · {fixture.stage_label}
      </p>
      {fixture.called_at !== null && (
        <p className="mt-3 text-sm text-court-muted">
          {t(dict, "matchDay.called.at", { time: fmtPublicTime(ctx.locale, ctx.tz, fixture.called_at) })}
        </p>
      )}
      {refusal !== null && (
        <p role="alert" className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-sm text-court-ink">
          {refusal}
        </p>
      )}
      <button
        type="button"
        data-testid="md-undo-call"
        disabled={busy}
        onClick={() => void undo()}
        className="btn mt-4 min-h-11 border border-white/30 text-court-ink hover:bg-white/10"
      >{busy ? t(dict, "matchDay.called.undoing") : t(dict, "matchDay.called.undo")}</button>
    </div>
  );
}

/** The court's next matches, in planned order, each with its read-time estimate ("~12:20") and, when that is later, its plan. */
function Queue({ ctx, court }: { ctx: MatchDayCtx; court: MatchDayCourt }) {
  const { dict } = ctx;
  const time = (iso: string) => fmtPublicTime(ctx.locale, ctx.tz, iso);
  return (
    <section aria-label={t(dict, "matchDay.queue.title")} className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold text-slate-600">{t(dict, "matchDay.queue.title")}</h3>
      {court.queue.length === 0 ? (
        <p className="text-sm text-slate-500">{t(dict, "matchDay.queue.empty")}</p>
      ) : (
        <ol className="card divide-y divide-purple-50">
          {court.queue.map((q, i) => {
            const estimate = time(q.estimated_at);
            const planned = time(q.planned_at);
            return (
              <li key={q.id} data-testid="md-queue-row" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2.5">
                <span className="font-mono text-xs text-slate-400">{i + 1}</span>
                <span className="min-w-0 text-sm text-slate-900 [overflow-wrap:anywhere]">
                  {matchLabel(dict, q)} <span className="text-xs text-slate-500">· {q.division_name}</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-sm tabular-nums text-slate-700">{t(dict, "matchDay.queue.estimate", { time: estimate })}</span>
                  {estimate !== planned && (
                    <span className="block text-[11px] text-slate-500">{t(dict, "matchDay.queue.planned", { time: planned })}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
