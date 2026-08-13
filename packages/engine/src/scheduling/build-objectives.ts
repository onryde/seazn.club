// The three numbers that decide whether one board is better than another, and
// the lexicographic comparison over them (design D3: compact > fairness >
// balance, with placed-count above all three).
//
// PURE on purpose. No config, no rules, no z3. Four callers read these — the
// solver's tier bounds, the API response, the board's result strip, and the
// tests that assert the solver never returns a board worse than greedy — and a
// metric computed inside the solver would be one no test could reproduce.
import type { Assignment } from "./calendar.ts";

const MS_PER_MIN = 60_000;

/** How an instant resolves to a calendar day, and where that day OPENS.
 *
 *  Supplied by the caller rather than derived here because this module is pure
 *  and a day is a timezone question: `build.ts` already owns the one derivation
 *  the verifier agrees with (`buildDayIndexOf`, off `dayKeyInTz`), and a second
 *  one computed in here would be the placer/verifier fork this subsystem keeps
 *  producing.
 *
 *  OPTIONAL. A caller with no grid or no timezone (the repair path, the window
 *  pass, any board built without one) is measured as a SINGLE day — the same
 *  answer the placer gives itself, since `buildDayIndexOf(slots, undefined)`
 *  returns `() => 0`. See `boardMetrics` for why that fallback matters rather
 *  than merely being tidy.
 *
 *  What must never happen is one board measured WITH a view and the other
 *  WITHOUT. The two are different measurements of different quantities, and a
 *  board measured as one day scores a `daysUsed` of 1 against a real multi-day
 *  count it should never have been compared to. Both sides of every comparison
 *  come from the same call site for exactly that reason — see `build.ts`, which
 *  re-measures the greedy seed rather than reusing the metrics it arrived with.
 */
export interface DayView {
  /** Dense day index for an instant. Declared as a PROPERTY holding a function
   *  rather than a method so it can be read off the object and passed around
   *  without `this` coming with it — which is what this module does below. */
  dayOf: (startAt: number) => number;
  /** The first admissible START on that day — the day's own opening slot. */
  openOf: (dayIndex: number) => number;
}

export interface BoardMetrics {
  /** Distinct calendar days the board touches. The solver's T1a rung. */
  daysUsed: number;
  /** Summed per-day span (each used day's last end minus its first start), in
   *  minutes. The solver's T1b rung. */
  daySpanMinutes: number;
  /** Summed distance from each used day's opening slot to the first match
   *  actually played on it, in minutes. The solver's T1c rung. */
  dayStartOffsetMinutes: number;
  /** Earliest start to latest end, in minutes. 0 for an empty board.
   *
   *  REPORTED BUT NO LONGER RANKED as of 2026-08-13. It was T1 and the second
   *  term of `isStrictlyBetter`; the solver now optimises the three day metrics
   *  above instead, and a gate ranking on a term the placer does not optimise
   *  is what discards a proved board. Kept as a metric because the API response
   *  and the board's result strip both publish it. */
  makespanMinutes: number;
  /** The largest gap any single participant waits between two of its matches.
   *  Measured over entrants AND people: a human umpiring two divisions waits
   *  just as long as a team does, and `people` is what carries them. */
  worstIdleGapMinutes: number;
  /** Busiest court's minutes minus the quietest's, over the configured courts
   *  plus any court the board actually uses. A configured court nobody plays on
   *  counts as zero, which is the whole point of the metric. */
  courtImbalanceMinutes: number;
  placed: number;
  total: number;
}

export function boardMetrics(
  assignments: readonly Assignment[],
  courts: readonly string[],
  total: number,
  days?: DayView,
): BoardMetrics {
  if (assignments.length === 0) {
    return {
      daysUsed: 0,
      daySpanMinutes: 0,
      dayStartOffsetMinutes: 0,
      makespanMinutes: 0,
      worstIdleGapMinutes: 0,
      courtImbalanceMinutes: 0,
      placed: 0,
      total,
    };
  }

  let lo = Infinity;
  let hi = -Infinity;
  const byParticipant = new Map<string, Assignment[]>();
  const courtMinutes = new Map<string, number>(courts.map((c) => [c, 0]));

  for (const a of assignments) {
    if (a.startAt < lo) lo = a.startAt;
    if (a.endAt > hi) hi = a.endAt;
    courtMinutes.set(a.court, (courtMinutes.get(a.court) ?? 0) + (a.endAt - a.startAt) / MS_PER_MIN);
    // Namespaced so an entrant id can never collide with a person id — the
    // identity-seam defect shape this repo has hit eight times.
    for (const e of a.entrants) push(byParticipant, `e:${e}`, a);
    for (const p of a.people) push(byParticipant, `p:${p}`, a);
  }

  let worstIdleGapMinutes = 0;
  for (const rows of byParticipant.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((x, y) => x.startAt - y.startAt);
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i]!.startAt - sorted[i - 1]!.endAt) / MS_PER_MIN;
      if (gap > worstIdleGapMinutes) worstIdleGapMinutes = gap;
    }
  }

  // The three day metrics, mirroring `placement/model.py`'s T1 rungs term for
  // term. `Math.max(0, ...)` on the offset is the same guard the model states
  // as a non-negative variable DOMAIN: an off-lattice pin can sit before its
  // day's first admissible tick, and a negative offset here would read as a
  // board that started before the day opened.
  //
  // NO VIEW MEANS ONE DAY, never "no days", and that is not a convenience —
  // it is what the placer does. `buildDayIndexOf(slots, undefined)` returns
  // `() => 0`: without a timezone every slot is on day 0, the verifier skips
  // day-cap counting, and the model's day rungs see a single day. Mirroring
  // that here keeps this function honest for a caller with no grid: one day is
  // what the board IS to a caller that cannot resolve days, and reporting zero
  // days for a board that plainly has matches on it would be a lie rather than
  // an abstention. It also makes `daySpanMinutes` equal the whole-board span in
  // that case, which is the right number for a single day by definition.
  //
  // NONE OF THE THREE IS RANKED. `isStrictlyBetter` reads only `placed`,
  // `makespanMinutes`, `worstIdleGapMinutes` and `courtImbalanceMinutes`, and
  // is unchanged by the day-aware rungs — see its own note for why mirroring
  // the solver's ladder into it does not work, and the release-2 index
  // (`2026-08-12-release2-prompts/_INDEX.md`) for the four attempts that
  // proved it. These fields are for the response and the board's result strip.
  const dayOf = days?.dayOf ?? ((): number => 0);
  const byDay = new Map<number, { lo: number; hi: number }>();
  for (const a of assignments) {
    const d = dayOf(a.startAt);
    const cur = byDay.get(d);
    if (cur === undefined) byDay.set(d, { lo: a.startAt, hi: a.endAt });
    else {
      if (a.startAt < cur.lo) cur.lo = a.startAt;
      if (a.endAt > cur.hi) cur.hi = a.endAt;
    }
  }
  const daysUsed = byDay.size;
  let daySpanMinutes = 0;
  let dayStartOffsetMinutes = 0;
  for (const [d, { lo: dayLo, hi: dayHi }] of byDay) {
    daySpanMinutes += (dayHi - dayLo) / MS_PER_MIN;
    // With no view there is no grid to say when a day OPENS, so the board's own
    // first match is the only defensible answer and the offset is 0 — an
    // abstention, not a claim that the board started on time.
    const open = days?.openOf(d) ?? dayLo;
    dayStartOffsetMinutes += Math.max(0, dayLo - open) / MS_PER_MIN;
  }

  const mins = [...courtMinutes.values()];
  return {
    daysUsed,
    daySpanMinutes,
    dayStartOffsetMinutes,
    makespanMinutes: (hi - lo) / MS_PER_MIN,
    worstIdleGapMinutes,
    courtImbalanceMinutes: Math.max(...mins) - Math.min(...mins),
    placed: assignments.length,
    total,
  };
}

function push(map: Map<string, Assignment[]>, key: string, a: Assignment): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [a]);
  else rows.push(a);
}

/** Design D3's ordering, as one comparison. Lexicographic rather than weighted
 *  so a reviewer and an organiser can both say WHY one board won.
 *
 *  UNCHANGED by the 2026-08-13 day-aware rungs, deliberately, and the reason is
 *  worth recording because the obvious move is to mirror the solver's ladder
 *  here and it was tried and reverted.
 *
 *  Mirroring looks right — a gate ranking on terms the placer does not optimise
 *  can discard a board the placer proved optimal, which is a real defect this
 *  same change had to fix. But the two boards being compared are NOT both
 *  products of that ladder: the seed is greedy's, and greedy is rule-blind. It
 *  packs from the first admissible tick, which scores beautifully on `days`,
 *  `day_span` and `day_start` precisely BECAUSE it ignores the typed rules that
 *  would push a legal board later. Measured: on a division with a durable
 *  `not_before noon` rule, ranking the day terms here made the gate prefer
 *  greedy's 09:00 board — six cards proposed before noon on a board whose rule
 *  says none may be — and the same shape reached `assertNoNewBlocking` at apply
 *  on three other suites.
 *
 *  So the ladder is NOT the right question to ask of these two boards. The
 *  right question is asked in `build.ts`: refuse a candidate that is more
 *  conflicted or places fewer, and otherwise let the SOLVER's own proof decide,
 *  because the service is the authority on its own objective. This comparison
 *  survives as the tie-break for a reply that proved nothing, and as
 *  `improveByWindows`' acceptance rule, where both boards do come from the same
 *  producer and the comparison is meaningful.
 *
 *  The day metrics on `BoardMetrics` are REPORTED, not ranked here. */
export function isStrictlyBetter(a: BoardMetrics, b: BoardMetrics): boolean {
  if (a.placed !== b.placed) return a.placed > b.placed;
  if (a.makespanMinutes !== b.makespanMinutes) return a.makespanMinutes < b.makespanMinutes;
  if (a.worstIdleGapMinutes !== b.worstIdleGapMinutes) return a.worstIdleGapMinutes < b.worstIdleGapMinutes;
  return a.courtImbalanceMinutes < b.courtImbalanceMinutes;
}

