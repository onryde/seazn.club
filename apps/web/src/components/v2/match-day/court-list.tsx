"use client";
// Match Day's court list (spec 2026-10-31 §6.1, task A3): one row per court — its name, what is on it now, and a stream badge
// ONLY while that court's match is live (§6.2: no badge otherwise, so a venue that never streams never sees one). On a phone
// this list is the home screen and a row opens its court full-screen; from md it is the left column and a row focuses its
// court on the right.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchDayCourt } from "@/lib/match-day/types";
import { matchLabel } from "@/lib/match-day/view";

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
        return (
          <li key={c.court_id}>
            <button
              type="button"
              data-testid="md-court-row"
              data-court-id={c.court_id}
              data-state={c.state}
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
                  {c.current?.stream === "live" && (
                    <span
                      data-md-stream="live"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-100"
                    >
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-600" />
                      {t(dict, "matchDay.stream.live")}
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-slate-600">{rowLine(dict, c)}</span>
                {/* The score on its own line: a real headline ("0 — 1 · 4–21 (19–19)", a cricket innings pair) is long, and
                    beside the name it squeezed the court's own name to "Cour…" (fix round 1, from the prod-server shots). */}
                {c.state === "playing" && c.current?.headline ? (
                  <span className="mt-0.5 block font-mono text-xs font-semibold tabular-nums text-purple-900 [overflow-wrap:anywhere]">
                    {c.current.headline}
                  </span>
                ) : null}
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

/** The row's second line: the match on it, or who has it. A free court's word sits on the right, so its line names the
 *  next match planned here when there is one. */
function rowLine(dict: Dict, c: MatchDayCourt): string {
  if (c.state === "in_use_elsewhere") return t(dict, "matchDay.state.inUse", { competition: c.in_use_by ?? "" });
  if (c.current !== null) return matchLabel(dict, c.current);
  const next = c.queue[0];
  return next === undefined ? "" : matchLabel(dict, next);
}
