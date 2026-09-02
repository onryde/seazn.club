import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { ATTENTION_SEVERITY, type Attention, type DivisionPhase } from "@/lib/division-phase";

const PHASE_CLASS: Record<DivisionPhase | "in_play" | "next", string> = {
  setting_up: "bg-purple-50 text-purple-700",
  scheduled: "bg-slate-100 text-slate-600",
  match_day: "bg-amber-50 text-amber-700",
  in_play: "bg-[#170b3b] text-lime-400",
  finished: "bg-green-50 text-green-700",
  // competitionPhase minor fix: the masthead's "earliest next fixture date"
  // ladder step (competition-desk.ts's `competitionPhase`) — a dated but
  // not-yet-live fact, so it reads the same slate as a division's own
  // "scheduled" pill.
  next: "bg-slate-100 text-slate-600",
};

export function PhasePill({
  dict, phase, inPlay = 0, when, attention = [], className = "", testId,
}: {
  dict: Dict;
  phase: DivisionPhase | "in_play" | "next";
  inPlay?: number;
  /** Pre-formatted date label for `phase === "next"` (competition-desk.ts's
   *  `nextFutureAt` + division-status-line.ts's `nextDateLabel` — this
   *  component stays presentation-only, no Intl/tz logic of its own). */
  when?: string;
  attention?: Attention[];
  className?: string;
  /** Optional stable hook. The masthead pill needs one: it is the only
   *  rendering of the competition-level ladder, and no unit test can reach it
   *  (server component, node-env vitest). */
  testId?: string;
}) {
  // Spec: a RED attention outranks the phase on the pill; amber/slate do not.
  const red = attention.find((a) => ATTENTION_SEVERITY[a.kind] === "red");
  const label = red
    ? t(dict, red.kind === "needs_draw" ? "desk.pill.needs_draw" : "desk.pill.no_scorer")
    : phase === "in_play"
      ? t(dict, "desk.phase.in_play", { n: inPlay })
      : phase === "next"
        ? t(dict, "desk.phase.next", { when: when ?? "" })
        : t(dict, `desk.phase.${phase}`);
  const cls = red ? "bg-red-50 text-red-700" : PHASE_CLASS[phase];
  return (
    <span
      data-testid={testId}
      data-phase={phase}
      data-pill={red ? red.kind : phase}
      className={`badge inline-flex items-center gap-1.5 normal-case ${cls} ${className}`}
    >
      <i aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
