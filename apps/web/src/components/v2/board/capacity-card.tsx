"use client";

// D2 capacity pre-check card (design doc bench-product-value/designs/
// 2026-08-13-capacity-precheck-design.md) — a PURE presentational component:
// the caller (SettingsPanel) reads the CapacityReport off useCapacityReport
// (P10 §4/Task 6 — a debounced server round trip, @/lib/use-capacity-report),
// not a local computation. This component itself does no computation, so it
// needs no hooks of its own beyond i18n — same "dumb component" split as
// RestFloorNote/its config object.
//
// Verdict colour carries the state (ok=emerald, tight=amber,
// impossible=red); the card's own container stays neutral so that signal
// isn't competing with a fixed accent, unlike FormatRecommendStrip's
// purple "always informational" tint — this card's whole point IS the
// state, not a constant suggestion. `stale` (below) deliberately borrows
// THAT purple "informational" language instead: it is not a verdict, so it
// must never look like one — a stale-marked "impossible" card must still
// read as impossible first, catching-up second.
import { Gauge } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { CapacityReport, CapacitySuggestion, CapacitySuggestionKind } from "@seazn/engine/scheduling/capacity";

const VERDICT_STYLE: Record<CapacityReport["verdict"], { chip: string; bar: string; track: string; key: MessageKey }> = {
  ok: {
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    bar: "bg-emerald-500",
    track: "bg-emerald-100",
    key: "schedule.capacity.verdict.ok",
  },
  tight: {
    chip: "bg-amber-50 text-amber-700 ring-amber-600/20",
    bar: "bg-amber-500",
    track: "bg-amber-100",
    key: "schedule.capacity.verdict.tight",
  },
  impossible: {
    chip: "bg-red-50 text-red-700 ring-red-600/20",
    bar: "bg-red-500",
    track: "bg-red-100",
    key: "schedule.capacity.verdict.impossible",
  },
};

function Bar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="presentation">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface CapacityCardProps {
  /** `null` = nothing to assess yet (no bounded window — see
   *  `capacityInputForFixtures`'s doc comment) OR a real check FAILED before
   *  any report ever arrived (`failed` below). The first case renders
   *  nothing — an organiser who hasn't set an end date has no impossibility
   *  to warn about, and a permanently-visible "not applicable" card is
   *  noise. The second case still renders (just with no numbers): a failed
   *  check with zero prior data must stay VISIBLE, never silently absent —
   *  see `failed`'s own doc comment. */
  report: CapacityReport | null;
  /** One handler per suggestion kind THIS panel can act on locally (design
   *  doc: "one-click apply where the knob is local, e.g. extend endAt").
   *  `raise_cap` has no entry here — that knob lives on the Constraints
   *  tab, not this panel — so its row renders with no Apply button. */
  onApply?: Partial<Record<CapacitySuggestionKind, (s: CapacitySuggestion) => void>>;
  /** "Court" / "Field" / "Pitch" — the sport-specific venue word the rest of
   *  this panel already uses (`venueCap` prop), so the add_court suggestion
   *  says the same word the courts list above it does. */
  venueLabel?: string;
  /** P10 §4/Task 6 (useCapacityReport): true while `report` is the last
   *  RESOLVED number set, but a debounced edit is pending or its refetch is
   *  in flight — `report` itself is never blanked or swapped for a
   *  spinner while this is true, it is simply marked as catching up.
   *  Defaulted to `false` so every pre-existing caller (and this file's
   *  own pre-P10 tests) keeps rendering exactly as before. */
  stale?: boolean;
  /** Review fix (Finding 1): true when useCapacityReport's own `failed` is
   *  true — the latest check for the current inputs failed for real (not a
   *  superseded abort) and its one retry also failed. Takes over the badge
   *  slot `stale` would otherwise use: a check that has STOPPED running
   *  must never ALSO claim to be "Updating…" — the two are mutually
   *  exclusive on screen even though the hook can technically report both
   *  true at once (a failed key is, definitionally, also not the resolved
   *  key). Defaulted to `false` so every pre-existing caller keeps
   *  rendering exactly as before. */
  failed?: boolean;
}

export function CapacityCard({ report, onApply, venueLabel = "court", stale = false, failed = false }: CapacityCardProps) {
  const msg = useMsg();
  // Nothing to assess AND nothing failed either — the pre-existing "not
  // applicable" contract (see `report`'s own doc comment). A FAILED check
  // still renders below, even with zero numbers ever received: a silently
  // absent card is exactly the "no visible reason" failure mode this fix
  // exists to close (paired with stages-panel.tsx's capacityGateBlocks on
  // the gate side).
  if (report === null && !failed) return null;

  const style = report ? VERDICT_STYLE[report.verdict] : null;
  const restViolations = report ? report.restBound.filter((r) => r.violated).length : 0;

  return (
    <div
      className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
      data-capacity-verdict={report?.verdict}
      data-capacity-stale={stale || undefined}
      data-capacity-failed={failed || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
          <Gauge className="h-4 w-4 text-slate-500" strokeWidth={1.75} />
          {msg("schedule.capacity.title")}
        </p>
        <div className="flex items-center gap-2">
          {failed ? (
            // Gray and static — never the purple pulsing dot, which means
            // "live" (stages-panel.tsx's now-playing pulse idiom). This is
            // the opposite: the check is NOT running.
            <span className="flex items-center gap-1 text-[11px] font-medium text-slate-600">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-slate-400" />
              {msg("schedule.capacity.checkFailed")}
            </span>
          ) : (
            stale && (
              // Purple, not the verdict palette: staleness is a SEPARATE axis
              // from ok/tight/impossible (a stale "impossible" card is still
              // impossible first) — reusing FormatRecommendStrip's "always
              // informational" purple keeps the two from reading as one
              // signal. The dot borrows this repo's own "live/waiting"
              // idiom (stages-panel.tsx's now-playing pulse).
              <span className="flex items-center gap-1 text-[11px] font-medium text-purple-600">
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500" />
                {msg("schedule.capacity.stale")}
              </span>
            )
          )}
          {style && (
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${style.chip}`}>
              {msg(style.key)}
            </span>
          )}
        </div>
      </div>
      {/* Screen-reader announcement of the SAME state the dot+label give
          sighted users — a persistent node with changing text content (not
          conditionally mounted), so an aria-live region actually fires. */}
      <span className="sr-only" aria-live="polite">
        {failed ? msg("schedule.capacity.checkFailed") : stale ? msg("schedule.capacity.stale") : ""}
      </span>

      {/* Everything quantitative dims slightly while stale OR failed — never
          blanks, never a spinner in its place — so a live edit reads as
          "catching up" and a real failure reads as "showing the last known
          numbers", never as fresh data. The verdict chip and title above
          stay at full strength: which STATE we're in must never itself go
          fuzzy. Only rendered when a report actually exists — a failed
          check with no report yet has nothing quantitative to show at all. */}
      {report && style && (
        <div className={`transition-opacity duration-300 ${stale || failed ? "opacity-60" : ""}`}>
          <p className="mt-2 text-xs text-slate-500">
            {msg("schedule.capacity.summary", { demand: report.slotDemand, supply: report.slotSupply })}
            {restViolations > 0 ? " · " + msg("schedule.capacity.restViolations", { n: restViolations }) : ""}
          </p>
          <div className="mt-1.5">
            <Bar value={report.slotDemand} max={Math.max(report.slotSupply, report.slotDemand)} tone={style.bar} />
          </div>

          {report.perDay.length > 0 && (
            <div className="scroll-x mt-3 flex gap-3 overflow-x-auto pb-1">
              {report.perDay.map((d) => {
                const cap = Math.min(d.supply, d.demandCeiling);
                return (
                  <div key={d.date} className="w-20 shrink-0">
                    <p className="truncate text-[11px] text-slate-500">{d.date.slice(5)}</p>
                    <div className="mt-1">
                      <Bar value={Math.min(cap, d.supply)} max={Math.max(d.supply, 1)} tone={style.bar} />
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-400">{d.supply}</p>
                  </div>
                );
              })}
            </div>
          )}

          {report.suggestions.length > 0 && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <p className="text-xs font-medium text-slate-600">{msg("schedule.capacity.suggestions.title")}</p>
              <ul className="mt-1.5 space-y-1">
                {report.suggestions.map((s) => {
                  const apply = onApply?.[s.kind];
                  return (
                    <li key={s.kind} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                      <span className="flex items-center gap-1.5">
                        {s.flipsVerdict && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
                        {suggestionLabel(msg, s, venueLabel)}
                      </span>
                      {apply && (
                        <button
                          type="button"
                          onClick={() => apply(s)}
                          className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-purple-700 hover:bg-purple-50"
                        >
                          {msg("schedule.capacity.apply")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function suggestionLabel(
  msg: (key: MessageKey, params?: Record<string, string | number>) => string,
  s: CapacitySuggestion,
  venueLabel: string,
): string {
  switch (s.kind) {
    case "add_day":
      return msg("schedule.capacity.suggestion.addDay");
    case "add_court":
      return msg("schedule.capacity.suggestion.addCourt", { venue: venueLabel });
    case "shorten_match":
      return msg("schedule.capacity.suggestion.shortenMatch", { n: s.amount });
    case "shrink_gap":
      return msg("schedule.capacity.suggestion.shrinkGap", { n: s.amount });
    case "raise_cap":
      return msg("schedule.capacity.suggestion.raiseCap");
  }
}
