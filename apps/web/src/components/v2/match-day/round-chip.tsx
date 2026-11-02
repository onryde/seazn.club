// A match's round code on Match Day (E2 item 7): "R2", "QF", "SF", "F", "3rd" — the same chip the schedule board prints, in front
// of the names, so a glance at the list says which round is on court. The text is the board's (`lib/match-day/rounds.ts` asks the
// board's own `boardRoundCodes`); this file only paints it.
//
// The code alone is a poor label ("F" is not a word), so the chip carries the full name twice over: a tooltip (`title`) for the
// pointer, and a screen-reader-only copy of the name beside the code, which is itself hidden from assistive tech — one name read,
// not "QF Quarter-finals". Emphasis is one step, as on the board: a bracket role reads in the purple the page already uses for
// its own marks, a plain "R{n}" in quiet slate. A `dark` chip sits on the called panel's court-green card.
import type { MatchDayRound } from "@/lib/match-day/types";

const BASE = "inline-flex shrink-0 items-center rounded px-1.5 align-baseline text-xs font-semibold leading-5 tabular-nums";
const TONE = {
  light: { coded: "bg-purple-100 text-purple-900 ring-1 ring-inset ring-purple-200", plain: "bg-slate-100 text-slate-700" },
  dark: { coded: "bg-white/15 text-court-ink ring-1 ring-inset ring-white/25", plain: "bg-white/10 text-court-ink" },
} as const;

export function MatchRoundChip({ round, tone = "light" }: { round: MatchDayRound; tone?: keyof typeof TONE }) {
  return (
    <span
      data-testid="md-round-chip"
      data-round-code={round.code}
      data-round-coded={round.coded ? "true" : "false"}
      title={round.label}
      className={`${BASE} ${round.coded ? TONE[tone].coded : TONE[tone].plain}`}
    >
      <span aria-hidden>{round.code}</span>
      <span className="sr-only">{round.label}</span>
    </span>
  );
}
