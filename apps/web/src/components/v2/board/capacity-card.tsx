"use client";

// D2 capacity pre-check card (design doc bench-product-value/designs/
// 2026-08-13-capacity-precheck-design.md) — a PURE presentational component:
// the caller (SettingsPanel) computes the CapacityReport via useMemo from its
// own live knob state and `@/lib/capacity-input` + `assessCapacity`, both
// client-safe leaf imports (no network, no server-only). This component
// itself does no computation, so it needs no hooks of its own beyond i18n —
// same "dumb component" split as RestFloorNote/its config object.
//
// Verdict colour carries the state (ok=emerald, tight=amber,
// impossible=red); the card's own container stays neutral so that signal
// isn't competing with a fixed accent, unlike FormatRecommendStrip's
// purple "always informational" tint — this card's whole point IS the
// state, not a constant suggestion.
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
   *  `capacityInputForFixtures`'s doc comment). The card renders nothing:
   *  an organiser who hasn't set an end date has no impossibility to warn
   *  about, and a permanently-visible "not applicable" card is noise. */
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
}

export function CapacityCard({ report, onApply, venueLabel = "court" }: CapacityCardProps) {
  const msg = useMsg();
  if (report === null) return null;

  const style = VERDICT_STYLE[report.verdict];
  const restViolations = report.restBound.filter((r) => r.violated).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4" data-capacity-verdict={report.verdict}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
          <Gauge className="h-4 w-4 text-slate-500" strokeWidth={1.75} />
          {msg("schedule.capacity.title")}
        </p>
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${style.chip}`}>
          {msg(style.key)}
        </span>
      </div>

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
