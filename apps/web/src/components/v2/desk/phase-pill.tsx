import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import type { DictionaryKey } from "@/lib/i18n-keys";
import { ATTENTION_SEVERITY, type Attention, type DivisionPhase } from "@/lib/division-phase";

/**
 * The pill word for a RED attention, per kind. K1 (fix round G) replaced a
 * TERNARY here — `red.kind === "needs_draw" ? … : "desk.pill.no_scorer"` —
 * which silently labelled any red kind that was not `needs_draw` "No
 * scorer". A full `Record` over every kind (amber/slate ones map to `null`)
 * makes adding a kind a COMPILE error instead of a mislabelled pill.
 *
 * Fix round I, minor: this map and the severity filter below were two guards
 * covering for each other — mutate either ALONE and the suite stayed green,
 * because a broken filter still landed on a `null` here and a broken `null`
 * here was still filtered out there. They cannot be collapsed into one (the
 * ONE authority for which kinds are red is `ATTENTION_SEVERITY`, and
 * restating it here would be a second one), so each is given a test that
 * dies on its own instead:
 *   - the filter: an UNSORTED attention list whose first member is amber and
 *     whose second is red — only the filter can reach the red one;
 *   - this map's red entries: the pill WORD asserted per kind;
 *   - this map's null entries: pinned against `ATTENTION_SEVERITY` itself,
 *     so a null becoming a key contradicts the severity table it must agree
 *     with. All three live in desk-ssr.test.tsx.
 */
export const RED_PILL_KEY: Record<Attention["kind"], DictionaryKey | null> = {
  needs_draw: "desk.pill.needs_draw",
  needs_fixtures: "desk.pill.needs_fixtures",
  no_scorer: "desk.pill.no_scorer",
  unscheduled: null,
  result_missing: null,
  registrations_waiting: null,
};

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
  const redKey = red ? RED_PILL_KEY[red.kind] : null;
  const label = redKey
    ? t(dict, redKey)
    : phase === "in_play"
      ? t(dict, "desk.phase.in_play", { n: inPlay })
      : phase === "next"
        ? t(dict, "desk.phase.next", { when: when ?? "" })
        : t(dict, `desk.phase.${phase}`);
  const cls = redKey ? "bg-red-50 text-red-700" : PHASE_CLASS[phase];
  return (
    <span
      data-testid={testId}
      data-phase={phase}
      data-pill={redKey && red ? red.kind : phase}
      className={`badge inline-flex items-center gap-1.5 normal-case ${cls} ${className}`}
    >
      <i aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
