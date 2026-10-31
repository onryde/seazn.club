"use client";
// Match Day's free court (spec 2026-10-31 §6.2, §7, task A3): "Court 5 is free", since when, how many matches could start
// here now, and the candidates themselves — fetched from GET …/match-day/candidates?court_id= whenever the court is focused
// and on every poll of the page. A candidate whose player is on court elsewhere is greyed with the reason and has no call
// button (§7.2's hard stop); every other one has "Call to Court N", which opens the call sheet's knock-on preview.
import { useCallback, useEffect, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicTime } from "@/lib/format";
import { plural, t } from "@/lib/i18n-runtime";
import type { MatchDayCandidate, MatchDayCandidateSource, MatchDayCourt } from "@/lib/match-day/types";
import { blockedReason, candidateWhere, filterCandidates, matchLabel } from "@/lib/match-day/view";
import type { MatchDayCtx } from "./court-focus";
import { CallSheet } from "./call-sheet";

export type CandidateLoad =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; candidates: MatchDayCandidate[] };

/** The candidates' groups, in the order the server ranks them (lib/match-day/estimate.ts `rankCandidates`). */
const GROUPS: readonly MatchDayCandidateSource[] = ["this_court", "other_court", "no_court"];

/** The free court, fetching its candidates. `refreshKey` changes on every poll of the page, so the list follows the day. */
export function FreeCourt({
  ctx,
  court,
  refreshKey,
  divisions,
  onChanged,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  refreshKey: string;
  divisions: ReadonlySet<string> | null;
  /** A call landed, or a refusal said the page is stale: refresh the whole view. */
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<CandidateLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [calling, setCalling] = useState<MatchDayCandidate | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    apiV1<MatchDayCandidate[]>(
      `/api/v1/competitions/${ctx.competitionId}/match-day/candidates?court_id=${encodeURIComponent(court.court_id)}`,
      { signal: ctl.signal },
    )
      .then((candidates) => setLoad({ status: "ready", candidates }))
      .catch(() => {
        if (ctl.signal.aborted) return;
        // A poll that raced a write can fail once (task A2 m1); keep what is on screen and let the next poll retry.
        setLoad((prev) => (prev.status === "ready" ? prev : { status: "failed" }));
      });
    return () => ctl.abort();
  }, [ctx.competitionId, court.court_id, refreshKey, attempt]);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const shown: CandidateLoad = load.status === "ready" ? { status: "ready", candidates: filterCandidates(load.candidates, divisions) } : load;
  return (
    <>
      <FreeCourtBody ctx={ctx} court={court} load={shown} onCall={setCalling} onRetry={retry} />
      {calling !== null && (
        <CallSheet
          ctx={ctx}
          court={court}
          candidate={calling}
          onClose={() => setCalling(null)}
          onCalled={() => {
            setCalling(null);
            onChanged();
          }}
          onStale={onChanged}
        />
      )}
    </>
  );
}

/** The free court's panel and its candidates, from a load already in hand (the SSR suite renders this directly). */
export function FreeCourtBody({
  ctx,
  court,
  load,
  onCall,
  onRetry,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  load: CandidateLoad;
  onCall: (candidate: MatchDayCandidate) => void;
  onRetry: () => void;
}) {
  const { dict } = ctx;
  return (
    <div className="grid gap-4">
      <div data-testid="md-free-panel" className="rounded-2xl bg-court p-5 text-court-ink shadow-lg sm:p-6">
        <p className="font-display text-2xl font-semibold sm:text-3xl">{t(dict, "matchDay.free.title", { court: court.court_name })}</p>
        <p className="mt-1 text-sm text-court-muted" aria-live="polite">
          {court.free_since !== null && <>{t(dict, "matchDay.free.since", { time: fmtPublicTime(ctx.locale, ctx.tz, court.free_since) })} </>}
          {load.status === "loading"
            ? t(dict, "matchDay.free.loading")
            : load.status === "failed"
              ? t(dict, "matchDay.free.failed")
              : load.candidates.length === 0
                ? t(dict, "matchDay.free.countNone")
                : plural(dict, "matchDay.free.count", load.candidates.length, ctx.locale)}
        </p>
        {load.status === "failed" && (
          <button type="button" onClick={onRetry} className="btn mt-3 min-h-11 border border-white/30 text-court-ink hover:bg-white/10">
            {t(dict, "matchDay.free.retry")}
          </button>
        )}
      </div>
      {load.status === "ready" && load.candidates.length > 0 && (
        <CandidateRows ctx={ctx} court={court} candidates={load.candidates} onCall={onCall} />
      )}
    </div>
  );
}

/** The candidates, grouped in rank order. */
export function CandidateRows({
  ctx,
  court,
  candidates,
  onCall,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  candidates: MatchDayCandidate[];
  onCall: (candidate: MatchDayCandidate) => void;
}) {
  const { dict } = ctx;
  return (
    <section aria-label={t(dict, "matchDay.candidate.label", { court: court.court_name })} className="card overflow-hidden">
      {GROUPS.map((group) => {
        const inGroup = candidates.filter((c) => c.source === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="border-b border-purple-50 bg-purple-50/40 px-4 py-2 text-xs font-semibold text-slate-600">
              {t(dict, `matchDay.candidate.group.${group}`)}
            </h3>
            <ul className="divide-y divide-purple-50">
              {inGroup.map((c) => (
                <li
                  key={c.fixture.id}
                  data-testid="md-candidate"
                  data-fixture-id={c.fixture.id}
                  data-blocked={c.blocked !== null ? "true" : undefined}
                  className={`grid min-w-0 gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center ${
                    c.blocked !== null ? "bg-slate-50/60" : ""
                  }`}
                >
                  <div className={`min-w-0 ${c.blocked !== null ? "opacity-60" : ""}`}>
                    <p className="text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">
                      {matchLabel(dict, c.fixture)}{" "}
                      <span className="font-normal text-slate-500">· {c.fixture.division_name}</span>
                    </p>
                    <p className="text-xs text-slate-600">{candidateWhere(dict, c)}</p>
                  </div>
                  {c.blocked !== null ? (
                    <p className="text-xs font-medium text-slate-700 md:text-right">{blockedReason(dict, c.blocked)}</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onCall(c)}
                      className="btn btn-primary min-h-11 w-full text-sm md:w-auto lg:min-h-0 lg:py-1.5"
                    >
                      {t(dict, "matchDay.candidate.call", { court: court.court_name })}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
