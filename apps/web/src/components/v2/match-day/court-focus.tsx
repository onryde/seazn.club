"use client";
// Match Day's focused court (spec 2026-10-31 §6.2, task A3), one panel per state:
//  - playing: its live stream's preview when it has one to show (court-stream-preview.tsx, task A4), else the sport's scoreboard
//    (court-scoreboard.tsx) with its stream in the corner; Open pad, the scorer's QR, the queue;
//  - called: "Called: waiting for players", the match, Undo call (A1's DELETE …/call), the scorer's QR, the queue;
//  - free: "Court 5 is free" and the candidates (candidate-list.tsx);
//  - in use by another competition: greyed, named, nothing to press.
// On a phone it is a full screen of its own with "‹ All courts" back; from md it is the right-hand column.
// A refused call or undo is held ABOVE the state panels (`notice`, kept by the shell per court): the refusal triggers a
// refresh, and the refresh can change the court's state and unmount the panel that was refused (review M5).
//
// The scorer's QR (spec §2, §9: "Match Day … now shows the scorer QR for a called or live match"; task A4) is the console's own
// Remote scoring panel (`DeviceLinkPanel`, embedded and COMPACT — fix round 1, V5): the same per-match link, ENSURE'd — showing
// it never kills a printed sheet. Open on a called court (the hand-over is next); folded behind its heading on a playing one (the
// scorer is on; the scoreboard comes first), the No-scorer mark staying on the heading. Keyed by the match, so another court's
// match never shows the last one's link.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicTime } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { ATTENTION_SEVERITY } from "@/lib/division-phase";
import type { MatchDayCourt, MatchDayFixture } from "@/lib/match-day/types";
import { courtScorerAttention, matchLabel, streamPreviewOf } from "@/lib/match-day/view";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { FreeCourt } from "./candidate-list";
import { failureMessage } from "./call-sheet";
import { CourtScoreboard } from "./court-scoreboard";
import { CourtStreamPreview } from "./court-stream-preview";
import { ScorerMark } from "./scorer-mark";

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
  /** The organisation's plan class: the scorer QR's paywall copy (`DeviceLinkPanel`). */
  viewerPlan: ViewerPlan;
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
  onRefused,
  notice = null,
  onDismissNotice = () => {},
  refreshKey,
  divisions,
  hiddenOnPhone = false,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  /** "All courts", in the courts' own noun. */
  backLabel: string;
  onBack: () => void;
  /** A call or an undo landed: refresh the view now. */
  onChanged: () => void;
  /** A call or an undo was refused, in the organiser's words: the shell keeps it for this court and refreshes. */
  onRefused: (message: string) => void;
  /** This court's last refusal, kept through refreshes until dismissed or another court is opened. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** Changes on every poll, so the free court's candidates follow the day. */
  refreshKey: string;
  divisions: ReadonlySet<string> | null;
  /** On a phone the list is home: the court opens over it only once tapped. */
  hiddenOnPhone?: boolean;
}) {
  const { dict } = ctx;
  const f = court.current;
  const preview = court.state === "playing" && f !== null ? streamPreviewOf(f) : null;
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

      {notice !== null && (
        <div
          role="alert"
          data-testid="md-notice"
          className="flex min-w-0 items-start justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-inset ring-red-100"
        >
          <p className="min-w-0 py-1 [overflow-wrap:anywhere]">{notice}</p>
          <button
            type="button"
            onClick={onDismissNotice}
            className="-my-1 inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-xs font-semibold text-red-800 hover:bg-red-100"
          >
            {t(dict, "matchDay.notice.dismiss")}
          </button>
        </div>
      )}

      {court.state === "playing" && f !== null && (
        <>
          <MatchLine ctx={ctx} fixture={f} />
          {preview !== null ? (
            <CourtStreamPreview
              fixture={f}
              part={preview}
              courtName={court.court_name}
              streamHref={`${fixtureHref(ctx, f)}?stream=open`}
              dict={dict}
              scoreDict={ctx.scoreDict}
            />
          ) : (
            <CourtScoreboard
              fixture={f}
              courtName={court.court_name}
              streamHref={`${fixtureHref(ctx, f)}?stream=open`}
              dict={dict}
              scoreDict={ctx.scoreDict}
            />
          )}
        </>
      )}
      {court.state === "called" && f !== null && <CalledPanel ctx={ctx} fixture={f} onChanged={onChanged} onRefused={onRefused} />}
      {f !== null && (court.state === "playing" || court.state === "called") && (
        <ScorerPanel
          ctx={ctx}
          fixture={f}
          attention={courtScorerAttention(court)}
          folded={court.state === "playing"}
          onChanged={onChanged}
        />
      )}
      {court.state === "free" && (
        <FreeCourt
          key={court.court_id}
          ctx={ctx}
          court={court}
          refreshKey={refreshKey}
          divisions={divisions}
          onChanged={onChanged}
          onRefused={onRefused}
        />
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
 *  NOT_CALLED once the scorer has started or the board has moved the match; the refusal's words go to the court focus
 *  (`onRefused`), which keeps them through the refresh that shows what is true now. */
function CalledPanel({
  ctx,
  fixture,
  onChanged,
  onRefused,
}: {
  ctx: MatchDayCtx;
  fixture: MatchDayFixture;
  onChanged: () => void;
  onRefused: (message: string) => void;
}) {
  const { dict } = ctx;
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}/call`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      onRefused(failureMessage(ctx, err));
    } finally {
      setBusy(false);
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

/** The match's scorer link as a QR (the console's Remote scoring panel, embedded), under the court's own heading for it — with the
 *  court's scorer mark beside the heading while the desk says nobody is scoring (§9). */
function ScorerPanel({
  ctx,
  fixture,
  attention,
  folded,
  onChanged,
}: {
  ctx: MatchDayCtx;
  fixture: MatchDayFixture;
  attention: ReturnType<typeof courtScorerAttention>;
  /** A PLAYING court (fix round 1, V5): the scorer is already on, so the QR sits behind its heading, closed at every width,
   *  and never outranks the scoreboard. A CALLED court shows it open — handing the phone over is the next thing to do. */
  folded: boolean;
  /** A link made, re-shown or revoked here re-reads the board: a live link IS a scorer (the desk, I1), so "No scorer" goes. */
  onChanged: () => void;
}) {
  const { dict } = ctx;
  const heading = (
    <>
      <h3 id={`md-scorer-${fixture.id}`} className="text-xs font-semibold text-slate-600">
        {t(dict, "dlink.title")}
      </h3>
      {attention !== null && <ScorerMark dict={dict} kind={attention} severity={ATTENTION_SEVERITY[attention]} />}
    </>
  );
  // Compact either way: Create / Show QR, then the QR and Copy; the rest behind the panel's own "More".
  const panel = (
    <DeviceLinkPanel
      key={fixture.id}
      fixtureId={fixture.id}
      sportKey={fixture.sport_key}
      embedded
      compact
      onChanged={onChanged}
      viewerPlan={ctx.viewerPlan}
    />
  );
  if (folded) {
    return (
      <details data-testid="md-scorer" data-folded="true" className="group min-w-0">
        <summary className="flex min-h-11 min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-lg [&::-webkit-details-marker]:hidden">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5 shrink-0 fill-none stroke-current text-slate-500 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            strokeWidth={1.8}
          >
            <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {heading}
        </summary>
        <div className="mt-2 min-w-0">{panel}</div>
      </details>
    );
  }
  return (
    <section data-testid="md-scorer" aria-labelledby={`md-scorer-${fixture.id}`} className="min-w-0">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{heading}</div>
      {panel}
    </section>
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
