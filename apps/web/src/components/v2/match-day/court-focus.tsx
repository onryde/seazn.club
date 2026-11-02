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
// it never kills a printed sheet. The organiser can Hide it to one row (E2 item 6): open by default whenever the match has no device
// link (a called court's hand-over is next, and a playing match scored without one still wants it - fix round 1, m4: the link decides,
// never the desk's score events), hidden only while a live link exists (the scoreboard comes first), the No-scorer mark staying on
// the heading in both shapes; the choice is remembered per court in this tab. Keyed by the match, so
// another court's match never shows the last one's link.
//
// Task B4 (owner ruling Q1):
//  - a match playing on NO court (an untimed bracket match, an online board) opens `NoCourtFocus`: the playing court's own
//    panel — the match, its scoreboard or live stream, the scorer's QR — with no queue and nothing to call;
//  - a view-only reader (`ctx.readOnly`: an org member who may view but not edit) sees every panel with nothing that writes:
//    no Undo call, no Call (candidate-list.tsx), no scorer QR (showing it mints a link), no "+ Connect a stream" and no stream
//    settings; "Open pad" reads "Open match", since the console decides what that reader may do there. The server refuses
//    every one of those writes on its own (read-only-staff.test.ts); hiding them is the page being honest, not the guard.
//  - a billing-frozen competition (`ctx.frozen`, task F1) offers no Undo call and no Call: the server refuses both (402). It
//    still SCORES (Match Day PB2, owner 2026-11-02, option A — scoring.ts asks no freeze), so the scorer QR and "Open pad" stay.
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
import { closureText, courtScorerAttention, matchLabel, matchMeta, scorerMemoryKey, streamPreviewOf } from "@/lib/match-day/view";
import { venueNoun } from "@/lib/venue";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { FreeCourt } from "./candidate-list";
import { ClosureLine } from "./court-list";
import { failureMessage } from "./call-sheet";
import { CourtScoreboard } from "./court-scoreboard";
import { CourtStreamPreview } from "./court-stream-preview";
import { MatchRoundChip } from "./round-chip";
import { ScorerMark } from "./scorer-mark";
import { MatchFormatEditor } from "@/components/v2/rules/match-format-editor";

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
  /** A view-only reader (B4, owner ruling Q1b): every panel shows, nothing that writes does. */
  readOnly: boolean;
  /** The competition is BILLING-frozen (over its organisation's `competitions.max_active`; task F1): the server refuses a call
   *  and its Undo with a 402, so neither is offered. The fact the competition page reads (`getCompetition(…).frozen`). Only the
   *  call path: the scorer QR, the pad and the stream links are not Match Day's to withhold. */
  frozen: boolean;
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
      <BackButton label={backLabel} onBack={onBack} />

      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-purple-950">{court.court_name}</h2>
          <p className="truncate text-xs text-slate-600">
            <span>{t(dict, `matchDay.noun.${court.sport_noun}`)}</span> · <span>{court.venue_name}</span>
          </p>
          {court.closure !== null && (
            <ClosureLine kind={court.closure.kind} text={closureText(dict, court.closure, ctx.locale, ctx.tz) ?? ""} className="mt-1" />
          )}
        </div>
        {f !== null && (court.state === "playing" || court.state === "called") && <OpenPadLink ctx={ctx} fixture={f} />}
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
              label={t(dict, "matchDay.preview.label", { court: court.court_name })}
              streamHref={`${fixtureHref(ctx, f)}?stream=open`}
              dict={dict}
              scoreDict={ctx.scoreDict}
              readOnly={ctx.readOnly}
            />
          ) : (
            <CourtScoreboard
              fixture={f}
              label={t(dict, "matchDay.focus.scoreboard", { court: court.court_name })}
              streamHref={`${fixtureHref(ctx, f)}?stream=open`}
              dict={dict}
              scoreDict={ctx.scoreDict}
              readOnly={ctx.readOnly}
            />
          )}
        </>
      )}
      {court.state === "called" && f !== null && <CalledPanel ctx={ctx} fixture={f} onChanged={onChanged} onRefused={onRefused} />}
      {f !== null && (court.state === "playing" || court.state === "called") && !ctx.readOnly && (
        <ScorerPanel
          ctx={ctx}
          fixture={f}
          attention={courtScorerAttention(court)}
          memoryKey={court.court_id}
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

/**
 * A match playing on NO court (task B4, owner ruling Q1: an untimed bracket match, an online board). The playing court's own
 * panel — the match, its scoreboard (or its live stream's preview), the scorer's QR (hideable, as on a court) — with no queue
 * and nothing to call: there is no court to queue on, or to call onto. On a phone it is a full screen of its own, like a court.
 */
export function NoCourtFocus({
  ctx,
  fixture: f,
  backLabel,
  onBack,
  onChanged,
  hiddenOnPhone = false,
}: {
  ctx: MatchDayCtx;
  fixture: MatchDayFixture;
  backLabel: string;
  onBack: () => void;
  /** A scorer link made or revoked here: refresh the view now (a live link is a scorer, so the mark goes). */
  onChanged: () => void;
  hiddenOnPhone?: boolean;
}) {
  const { dict } = ctx;
  const match = matchLabel(dict, f);
  const preview = streamPreviewOf(f);
  const streamHref = `${fixtureHref(ctx, f)}?stream=open`;
  // Fix round 1, R3: its own sport's word ("Playing, no board" for an online chess match).
  const title = t(dict, `matchDay.noCourt.title.${venueNoun(f.sport_key)}`);
  return (
    <section
      data-testid="md-focus"
      data-state="playing"
      data-no-court="true"
      data-fixture-id={f.id}
      aria-label={title}
      className={`grid min-w-0 content-start gap-4${hiddenOnPhone ? " max-md:hidden" : ""}`}
    >
      <BackButton label={backLabel} onBack={onBack} />
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 className="min-w-0 truncate text-xl font-semibold text-purple-950">{title}</h2>
        <OpenPadLink ctx={ctx} fixture={f} />
      </header>
      <MatchLine ctx={ctx} fixture={f} />
      {preview !== null ? (
        <CourtStreamPreview
          fixture={f}
          part={preview}
          label={t(dict, "matchDay.noCourt.preview", { match })}
          streamHref={streamHref}
          dict={dict}
          scoreDict={ctx.scoreDict}
          readOnly={ctx.readOnly}
        />
      ) : (
        <CourtScoreboard
          fixture={f}
          label={t(dict, "matchDay.noCourt.scoreboard", { match })}
          streamHref={streamHref}
          dict={dict}
          scoreDict={ctx.scoreDict}
          readOnly={ctx.readOnly}
        />
      )}
      {!ctx.readOnly && (
        <ScorerPanel ctx={ctx} fixture={f} attention={f.scorer_attention} memoryKey={`fixture-${f.id}`} onChanged={onChanged} />
      )}
    </section>
  );
}

/** "‹ All courts": a phone's way back to the list. */
function BackButton({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      type="button"
      data-testid="md-back"
      onClick={onBack}
      className="-ml-2 inline-flex min-h-11 items-center gap-1 justify-self-start rounded-lg px-2 text-sm font-medium text-purple-700 hover:bg-purple-50 md:hidden"
    >
      <span aria-hidden>‹</span>
      {label}
    </button>
  );
}

/** The match's console page: "Open pad" for an organiser, "Open match" for a view-only reader (the console decides what they
 *  may do there — an accepted official among them still scores). A billing-frozen competition still scores (PB2), so it is
 *  "Open pad" there too. */
function OpenPadLink({ ctx, fixture }: { ctx: MatchDayCtx; fixture: MatchDayFixture }) {
  return (
    <Link
      href={fixtureHref(ctx, fixture)}
      data-testid="md-open-pad"
      className="btn btn-ghost min-h-11 shrink-0 text-sm lg:min-h-0 lg:py-1.5"
    >
      {t(ctx.dict, ctx.readOnly ? "matchDay.focus.openMatch" : "matchDay.focus.openPad")}
    </Link>
  );
}

/** The match on court: who, which division and stage, when it started, and the format it plays (Match Day C2: the one Match
 *  format component, read-only — the fixture page's own line, set on a playing match). */
function MatchLine({ ctx, fixture }: { ctx: MatchDayCtx; fixture: MatchDayFixture }) {
  const { dict } = ctx;
  return (
    <div className="min-w-0">
      <p className="text-lg font-semibold text-slate-900 [overflow-wrap:anywhere]">
        <MatchRoundChip round={fixture.round} /> {matchLabel(dict, fixture)}
      </p>
      <p className="text-xs text-slate-600 [overflow-wrap:anywhere]">
        {matchMeta(fixture)}
        {fixture.started_at !== null && (
          <> · {t(dict, "matchDay.focus.started", { time: fmtPublicTime(ctx.locale, ctx.tz, fixture.started_at) })}</>
        )}
      </p>
      {fixture.format_line !== null && (
        <div className="mt-2" data-testid="md-match-format">
          <MatchFormatEditor scope="fixture" mode="locked" line={fixture.format_line} />
        </div>
      )}
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
      <p className="mt-3 font-display text-2xl font-semibold [overflow-wrap:anywhere] sm:text-3xl">
        <MatchRoundChip round={fixture.round} tone="dark" /> {matchLabel(dict, fixture)}
      </p>
      <p className="mt-1 text-sm text-court-muted [overflow-wrap:anywhere]">{matchMeta(fixture)}</p>
      {fixture.called_at !== null && (
        <p className="mt-3 text-sm text-court-muted">
          {t(dict, "matchDay.called.at", { time: fmtPublicTime(ctx.locale, ctx.tz, fixture.called_at) })}
        </p>
      )}
      {!ctx.readOnly && !ctx.frozen && (
        <button
          type="button"
          data-testid="md-undo-call"
          disabled={busy}
          onClick={() => void undo()}
          className="btn mt-4 min-h-11 border border-white/30 text-court-ink hover:bg-white/10"
        >{busy ? t(dict, "matchDay.called.undoing") : t(dict, "matchDay.called.undo")}</button>
      )}
    </div>
  );
}

/** The match's scorer link as a QR (the console's Remote scoring panel, embedded), under the court's own heading for it — with the
 *  court's scorer mark beside the heading while the desk says nobody is scoring (§9). The organiser can Hide it to one row
 *  (E2 item 6): open by default only where the match has no device link, hidden while a live one exists (the panel's own first
 *  read decides, fix round 1, m4) — and the choice is remembered for this tab, per court. */
function ScorerPanel({
  ctx,
  fixture,
  attention,
  memoryKey,
  onChanged,
}: {
  ctx: MatchDayCtx;
  fixture: MatchDayFixture;
  attention: ReturnType<typeof courtScorerAttention>;
  /** What the choice is remembered under: the court (the next match on it inherits the choice) or, with no court, the match. */
  memoryKey: string;
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
  return (
    <section data-testid="md-scorer" aria-labelledby={`md-scorer-${fixture.id}`} className="min-w-0">
      <DeviceLinkPanel
        // Keyed by the match: the panel's own state (a shown QR, an open question) is that match's, not the next court's.
        key={fixture.id}
        fixtureId={fixture.id}
        sportKey={fixture.sport_key}
        embedded
        compact
        onChanged={onChanged}
        viewerPlan={ctx.viewerPlan}
        // The default is the match's LINK, not the desk's score events (fix round 1, m4): open when the match has no device link,
        // hidden only while a live one exists - decided by the panel's first read. `initiallyOpen` shows only if that read fails.
        hide={{ storageKey: scorerMemoryKey(memoryKey), heading, initiallyOpen: true, followLink: true }}
      />
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
                  <MatchRoundChip round={q.round} /> {matchLabel(dict, q)} <span className="text-xs text-slate-500">· {q.division_name}</span>
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
