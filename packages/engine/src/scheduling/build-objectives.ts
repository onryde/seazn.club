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
  // that here keeps this function honest for a caller with no grid, and it has
  // a second effect worth stating because a test caught it: with one day,
  // `daySpanMinutes` IS the whole-board span, so the ladder's third rung
  // degrades into exactly the whole-board comparison that used to sit at rung
  // two. A window pass with no day view therefore keeps its old protection —
  // `improveByWindows` still refuses a candidate that stretches the board from
  // 90 minutes to 210 to buy a flatter court split — rather than going blind
  // on every day term and falling through to court balance.
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
 *  THIS ORDER MUST MIRROR THE SOLVER'S TIER CHAIN, rung for rung. It is not a
 *  second opinion about what a good board is — it is the gate that decides
 *  whether the solver's board ships at all (`build.ts`'s `improved`) and which
 *  LNS windows are kept (`build-lns.ts`), so a term here that the placer does
 *  not optimise silently throws away boards the placer just proved optimal.
 *
 *  That is not hypothetical; it is what this function did between the day-aware
 *  rungs landing in the service and this change. `makespanMinutes` ranked
 *  second while the solver had stopped computing a whole-board span at all, and
 *  the new `day_start` rung deliberately WORSENS the idle gap (measured on the
 *  production board: 132 600 000 -> 170 400 000 ms) because it outranks it. A
 *  day-anchored board could therefore lose here, be discarded for the greedy
 *  seed, and — with all six rungs proved — be reported `already_optimal`: the
 *  organiser told a greedy board was lexicographically optimal on a ladder the
 *  solver had just proved it was not optimal on.
 *
 *  So: `placed` -> `days` -> `day_span` -> `day_start` -> `idle_gap` ->
 *  `imbalance`, which is `placement/objective.py`'s `TIER_ORDER` exactly.
 *  `makespanMinutes` is still MEASURED and published; it is simply no longer
 *  the thing that decides. If a rung is ever added, removed or reordered in the
 *  service, it moves here in the same change. */
export function isStrictlyBetter(a: BoardMetrics, b: BoardMetrics): boolean {
  if (a.placed !== b.placed) return a.placed > b.placed;
  if (a.daysUsed !== b.daysUsed) return a.daysUsed < b.daysUsed;
  if (a.daySpanMinutes !== b.daySpanMinutes) return a.daySpanMinutes < b.daySpanMinutes;
  if (a.dayStartOffsetMinutes !== b.dayStartOffsetMinutes)
    return a.dayStartOffsetMinutes < b.dayStartOffsetMinutes;
  if (a.worstIdleGapMinutes !== b.worstIdleGapMinutes) return a.worstIdleGapMinutes < b.worstIdleGapMinutes;
  if (a.courtImbalanceMinutes !== b.courtImbalanceMinutes)
    return a.courtImbalanceMinutes < b.courtImbalanceMinutes;
  // BELOW the ladder, not in it. The solver's chain ends at `imbalance` and has
  // no opinion past it, so a deterministic last tie-break costs the mirror
  // nothing and buys two things. It keeps `improveByWindows` able to tell a
  // board that got longer from one that did not — window acceptance has no day
  // view, so every day term ties there and dropping the span outright would
  // have made a window that stretches the board 90 -> 210 minutes look like an
  // improvement. And on a board where all six rungs genuinely tie it prefers
  // the shorter one rather than flipping a coin.
  return a.makespanMinutes < b.makespanMinutes;
}
