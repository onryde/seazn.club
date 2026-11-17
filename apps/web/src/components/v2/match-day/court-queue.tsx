"use client";
// A court's queue, as Match Day's court focus and its free court both draw it (court stream spec §5.2, ruling O14 and the controller's
// 2026-11-16 B2): the court's next matches in planned order, each with its read-time estimate and, on a LINKED court, its Stream switch.
// Its own file so the free court (candidate-list.tsx) and the focus (court-focus.tsx) share ONE list without importing each other's values.
import { fmtPublicTime } from "@/lib/format";
import { t } from "@/lib/i18n-runtime";
import type { MatchDayCourt } from "@/lib/match-day/types";
import { matchLabel } from "@/lib/match-day/view";
import { canWriteCourtStream, switchSpec } from "@/lib/match-day/court-stream";
import type { MatchDayCtx } from "./court-focus";
import { CourtStreamSwitch } from "./court-stream-switch";
import { MatchRoundChip } from "./round-chip";

/** The court's next matches, in planned order, each with its read-time estimate ("~12:20") and, when that is later, its plan. */
export function Queue({
  ctx,
  court,
  onChanged,
  onRefused,
  exclude,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  onChanged: () => void;
  onRefused: (message: string) => void;
  /** Matches the page already shows above this list (a free court's candidates, "Due here next"): left out so none appears twice,
   *  the rest keeping their place numbers. Given, the list also says nothing at all when none is left. */
  exclude?: ReadonlySet<string>;
}) {
  const { dict } = ctx;
  const time = (iso: string) => fmtPublicTime(ctx.locale, ctx.tz, iso);
  const rows = court.queue.map((q, i) => ({ q, place: i + 1 })).filter(({ q }) => exclude === undefined || !exclude.has(q.id));
  if (exclude !== undefined && rows.length === 0) return null;
  return (
    <section aria-label={t(dict, "matchDay.queue.title")} className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold text-slate-600">{t(dict, "matchDay.queue.title")}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t(dict, "matchDay.queue.empty")}</p>
      ) : (
        <ol className="card divide-y divide-purple-50">
          {rows.map(({ q, place }) => {
            const estimate = time(q.estimated_at);
            const planned = time(q.planned_at);
            const spec = switchSpec(q, court.stream_link !== null, canWriteCourtStream(ctx));
            return (
              <li key={q.id} data-testid="md-queue-row" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2.5">
                <span className="font-mono text-xs text-slate-400">{place}</span>
                <span className="min-w-0 text-sm text-slate-900 [overflow-wrap:anywhere]">
                  <MatchRoundChip round={q.round} /> {matchLabel(dict, q)} <span className="text-xs text-slate-500">· {q.division_name}</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-sm tabular-nums text-slate-700">{t(dict, "matchDay.queue.estimate", { time: estimate })}</span>
                  {estimate !== planned && (
                    <span className="block text-[11px] text-slate-500">{t(dict, "matchDay.queue.planned", { time: planned })}</span>
                  )}
                </span>
                {spec !== null && (
                  <div className="col-span-2 col-start-2">
                    <CourtStreamSwitch key={q.id} ctx={ctx} fixture={q} spec={spec} onChanged={onChanged} onRefused={onRefused} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
