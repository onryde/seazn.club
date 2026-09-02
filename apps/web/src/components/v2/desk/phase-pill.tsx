import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { ATTENTION_SEVERITY, type Attention, type DivisionPhase } from "@/lib/division-phase";

const PHASE_CLASS: Record<DivisionPhase | "in_play", string> = {
  setting_up: "bg-purple-50 text-purple-700",
  scheduled: "bg-slate-100 text-slate-600",
  match_day: "bg-amber-50 text-amber-700",
  in_play: "bg-[#170b3b] text-lime-400",
  finished: "bg-green-50 text-green-700",
};

export function PhasePill({
  dict, phase, inPlay = 0, attention = [], className = "",
}: { dict: Dict; phase: DivisionPhase | "in_play"; inPlay?: number; attention?: Attention[]; className?: string }) {
  // Spec: a RED attention outranks the phase on the pill; amber/slate do not.
  const red = attention.find((a) => ATTENTION_SEVERITY[a.kind] === "red");
  const label = red
    ? t(dict, red.kind === "needs_draw" ? "desk.pill.needs_draw" : "desk.pill.no_scorer")
    : phase === "in_play"
      ? t(dict, "desk.phase.in_play", { n: inPlay })
      : t(dict, `desk.phase.${phase}`);
  const cls = red ? "bg-red-50 text-red-700" : PHASE_CLASS[phase];
  return (
    <span
      data-phase={phase}
      data-pill={red ? red.kind : phase}
      className={`badge inline-flex items-center gap-1.5 normal-case ${cls} ${className}`}
    >
      <i aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
