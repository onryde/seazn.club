// Capacity pre-check (D2) — design doc
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-capacity-precheck-design.md.
// Instant, pre-solve arithmetic: can this schedule request possibly fit, and
// if not, what's the cheapest fix. One pure function, every consumer (the
// setup card computes it client-side on every knob change; the auto/AI-plan
// routes re-run it server-side as the 422 authority) — the placer/verifier
// fork is the recurring bug in this subsystem, and a second implementation
// of "is there enough room" would be exactly that.
//
// LEAF MODULE, on purpose, like rest-floor.ts and grid-step.ts: the setup
// card imports this directly into the browser bundle (no network — see the
// design's UI section), so it may import nothing that drags the solvers,
// zod schemas, DB or pino along. `restFloor` is the one exception, and only
// because IT is also a total leaf (zero imports) — reusing it here is what
// keeps the rest-bound arithmetic from becoming a second implementation of
// `rest-floor.ts`'s own reason to exist. See capacity.test.ts's purity test,
// which reads both files' source and fails if either grows an import this
// comment doesn't already name.
import { restFloor } from "./rest-floor.ts";

const MS_PER_MIN = 60_000;

/** Epoch ms, half-open [from, to) — the same convention `SlotConfig`/
 *  `Assignment` use elsewhere in this package. */
export interface CapacityWindow {
  from: number;
  to: number;
}

export interface CapacityCourtWindows {
  /** Informational only — nothing below keys arithmetic off the name. */
  court: string;
  /** Usable windows on this court, THIS day, blackouts already subtracted
   *  (today: `ScheduleConfig.sessionWindows` − `blackouts`; D5 swaps in
   *  court-calendar-derived windows later — additive input, this shape is
   *  unchanged). A day with no usable time is `[]`, not omitted. */
  windows: CapacityWindow[];
}

export interface CapacityDay {
  /** YYYY-MM-DD, the organiser's zone. Caller supplies days ASCENDING —
   *  the day-walk below reads them in the order given. */
  date: string;
  courts: CapacityCourtWindows[];
  /** The day's rule-driven demand ceiling — Σ across whatever divisions/
   *  `max_fixtures_per_day` hard rules apply to this day (already resolved
   *  by the caller; this module stays free of `HardConstraint`'s shape on
   *  purpose, see the header comment). Undefined = no rule caps this day at
   *  all, which defaults to the report's total fixture count: unconstrained
   *  by RULES, the day is still bounded by its own court `supply` in the
   *  feasibility walk below. */
  demandCap?: number;
  /** The day's FLOOR: how many fixtures can go on this day and no other,
   *  because a rule nails them here — a `pin`, a `fixture_on_date`, or a
   *  `fixture_on_weekday` that only one date in the window satisfies. The
   *  caller resolves those (this module still never sees `HardConstraint`).
   *
   *  `demandCap` is a maximum and this is a minimum, and the two answer
   *  different questions. Without this, a board could be declared feasible
   *  on total supply while eleven fixtures were all nailed to a Tuesday
   *  with four slots — the precheck reported "fits" and the solver then
   *  proved otherwise, which is the one outcome this whole feature exists
   *  to pre-empt.
   *
   *  Deliberately conservative: the caller counts a fixture here only when
   *  it is pinned to EXACTLY one day. A weekday rule matching several dates
   *  is a subset restriction, not a floor, and proving infeasibility over
   *  subsets is a Hall condition this module does not attempt — see the
   *  walk below. Undercounting only ever costs a missed warning; it can
   *  never manufacture a false "impossible", which is the direction this
   *  precheck must never be wrong in. */
  forcedDemand?: number;
}

export interface CapacityEntrant {
  entrantId: string;
  /** k_e — this entrant's own remaining/unscheduled fixture count. */
  fixtures: number;
  /** Subset of `days[].date` this entrant may play (weekday/earliest-latest
   *  hard rules already applied by the caller). Undefined = every day in
   *  `days` is available — the common case when no such rule targets them. */
  availableDays?: string[];
  /** A `constraints.restByGroup` key (pool or division id) for this entrant,
   *  if any — resolved through `restFloor` exactly like the placer and
   *  verifier resolve it, so a group-scoped rest rule cannot silently miss
   *  this precheck the way a second implementation would. */
  groupId?: string;
}

export interface CapacityInput {
  matchMinutes: number;
  gapMinutes: number;
  perEntrantMinRest: number;
  constraints?: {
    restMin?: number;
    restByGroup?: Record<string, number>;
    noBackToBack?: boolean;
  };
  /** slotDemand — total fixtures needing a slot. Independent of
   *  `entrants[].fixtures`, which counts per-entrant PARTICIPATIONS (two per
   *  fixture, typically) rather than fixtures themselves. */
  fixtureCount: number;
  /** Ascending by date. */
  days: CapacityDay[];
  entrants: CapacityEntrant[];
}

export type CapacityVerdict = "impossible" | "tight" | "ok";

export interface CapacityPerDay {
  date: string;
  supply: number;
  demandCeiling: number;
}

export interface CapacityRestBound {
  entrantId: string;
  need: number;
  available: number;
  violated: boolean;
}

export type CapacitySuggestionKind =
  | "add_day"
  | "add_court"
  | "shorten_match"
  | "shrink_gap"
  | "raise_cap";

export interface CapacitySuggestion {
  kind: CapacitySuggestionKind;
  amount: number;
  /** Proven by re-running the arithmetic with the candidate delta applied —
   *  never guessed, never a literal. See capacity.test.ts's suggestion
   *  tests, which independently rebuild each delta and re-assess rather
   *  than trusting this field. */
  flipsVerdict: boolean;
}

export interface CapacityReport {
  verdict: CapacityVerdict;
  slotSupply: number;
  slotDemand: number;
  perDay: CapacityPerDay[];
  restBound: CapacityRestBound[];
  suggestions: CapacitySuggestion[];
}

/** tight iff not impossible and slotSupply < TIGHT_RATIO · slotDemand, or
 *  any entrant's slack is under one slot (design's Arithmetic section,
 *  normative). */
export const TIGHT_RATIO = 1.15;

/** Suggestions never propose a match length below this floor. This module
 *  has no sport-specific minimum duration to consult (that would be an
 *  import this leaf may not carry — see the header comment), so the guard
 *  is a generic sanity floor rather than "2x the sport's own minimum" the
 *  design's prose names; a caller with sport-specific knowledge may filter
 *  the suggestion list further. */
const MIN_SANE_MATCH_MINUTES = 10;

/** The single-unit step every `shorten_match`/`shrink_gap` candidate tries
 *  (design's Arithmetic section: "m′ = m−5", "g′ = max(0, g−5)"). */
const SUGGESTION_STEP_MINUTES = 5;

function windowMinutes(w: CapacityWindow): number {
  return (w.to - w.from) / MS_PER_MIN;
}

/** supply_{c,d} summed over every court on the day: Σ_w ⌊(len(w) + g) / slot⌋
 *  — the "+g" credits the last match of a window needing no trailing gap
 *  (design's Arithmetic section, verbatim). */
function daySupply(day: CapacityDay, slot: number, gapMinutes: number): number {
  let total = 0;
  for (const c of day.courts) {
    for (const w of c.windows) {
      const len = windowMinutes(w);
      if (len <= 0) continue;
      total += Math.floor((len + gapMinutes) / slot);
    }
  }
  return total;
}

/** The union length, in minutes, of every court's windows on a day — an
 *  entrant needs SOME court open, not all of them, so their available
 *  horizon is bounded by the union of open time, not the sum (which would
 *  double-count two courts open at the same hour). */
function dayUnionMinutes(day: CapacityDay): number {
  const windows = day.courts.flatMap((c) => c.windows).filter((w) => w.to > w.from);
  if (windows.length === 0) return 0;
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  let total = 0;
  let curFrom = sorted[0]!.from;
  let curTo = sorted[0]!.to;
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]!;
    if (w.from <= curTo) {
      if (w.to > curTo) curTo = w.to;
    } else {
      total += curTo - curFrom;
      curFrom = w.from;
      curTo = w.to;
    }
  }
  total += curTo - curFrom;
  return total / MS_PER_MIN;
}

interface CapacityCore {
  verdict: CapacityVerdict;
  slotSupply: number;
  slotDemand: number;
  perDay: CapacityPerDay[];
  restBound: CapacityRestBound[];
}

/** The arithmetic without suggestions — split out so suggestion candidates
 *  can re-assess cheaply (via THIS, not `assessCapacity`) without each
 *  candidate recursively generating its own suggestion list. */
function computeCore(input: CapacityInput): CapacityCore {
  const { matchMinutes: m, gapMinutes: g } = input;
  const slot = m + g;
  const slotDemand = input.fixtureCount;

  const perDay: CapacityPerDay[] = input.days.map((day) => ({
    date: day.date,
    supply: daySupply(day, slot, g),
    // No rule cap this day defaults to the TOTAL fixture count: unconstrained
    // by rules, the day is still bounded by its own `supply` below — see
    // CapacityDay.demandCap's doc comment.
    demandCeiling: day.demandCap ?? slotDemand,
  }));
  const slotSupply = perDay.reduce((sum, d) => sum + d.supply, 0);

  // Hall-style walk over the ORDERED days (design's Arithmetic section):
  // each day can absorb at most min(its own court supply, its rule-driven
  // ceiling) — a rule cap below the court's own supply is what makes a day
  // bind tighter than its courts alone would. Demand not absorbed by an
  // earlier day rolls forward; what's left after the last day is what
  // cannot be placed at all. This is what catches a front-loaded board
  // whose TOTAL supply looks ample but whose caps starve the early days —
  // condition ① of the design ("slotDemand > slotSupply") falls out of this
  // same walk as the case where no day carries a rule cap at all.
  //
  // Order does not change the final remainder in THIS model — the only
  // per-fixture day eligibility represented is `forcedDemand`, and that is
  // subtracted from its own day BEFORE the walk, so no ordering of the
  // remaining free fixtures can change the outcome. The walk stays
  // day-ordered because that is the natural reading of "an organiser's
  // timetable", per the design's own non-goal ("no soft-constraint
  // prediction — that's the solver's job"): this precheck proves
  // impossibility, it does not attempt the solver's placement choice.
  //
  // Two passes, because a floor and a ceiling fail differently:
  //
  //  1. Forced fixtures cannot move. If a day is nailed with more than it
  //     can hold, the excess is unplaceable no matter how much slack the
  //     rest of the week has — a total-supply check cannot see this, and
  //     that blind spot is what let a board pass the precheck and then come
  //     back infeasible from the solver.
  //  2. Whatever capacity each day has LEFT after its forced fixtures is
  //     what the free ones can use.
  let forcedOverflow = 0;
  let freeCapacity = 0;
  let totalForced = 0;
  for (const [i, d] of perDay.entries()) {
    const placeable = Math.min(d.supply, d.demandCeiling);
    const forced = Math.max(0, input.days[i]?.forcedDemand ?? 0);
    totalForced += forced;
    forcedOverflow += Math.max(0, forced - placeable);
    freeCapacity += Math.max(0, placeable - forced);
  }
  // `slotDemand` counts every fixture, forced ones included, so the free
  // demand is what is left after they take their own days' capacity. Guarded
  // at zero: a caller that over-counts `forcedDemand` past the board's total
  // must not wrap into a negative that silently cancels a real shortfall.
  const freeDemand = Math.max(0, slotDemand - totalForced);
  const remaining = forcedOverflow + Math.max(0, freeDemand - freeCapacity);
  const hallViolation = remaining > 0;

  const restBound: CapacityRestBound[] = [];
  let anyRestViolated = false;
  let minSlackMinutes = Number.POSITIVE_INFINITY;
  const dayByDate = new Map(input.days.map((d) => [d.date, d]));
  for (const e of input.entrants) {
    if (e.fixtures <= 0) continue;
    // THE placer/verifier rest floor, not a re-derivation of it (header
    // comment) — MAX across perEntrantMinRest / restMin / restByGroup /
    // noBackToBack, exactly as build-encode.ts and calendar.ts resolve it.
    const r = restFloor(
      {
        perEntrantMinRest: input.perEntrantMinRest,
        gapMinutes: g,
        matchMinutes: m,
        constraints: input.constraints,
      },
      { poolId: e.groupId, divisionId: e.groupId },
    ).minutes;
    const need = e.fixtures * m + Math.max(0, e.fixtures - 1) * Math.max(r, g);
    const availableDays = e.availableDays ?? input.days.map((d) => d.date);
    let available = 0;
    for (const date of availableDays) {
      const day = dayByDate.get(date);
      if (day !== undefined) available += dayUnionMinutes(day);
    }
    const violated = need > available;
    if (violated) anyRestViolated = true;
    const slack = available - need;
    if (slack < minSlackMinutes) minSlackMinutes = slack;
    restBound.push({ entrantId: e.entrantId, need, available, violated });
  }

  let verdict: CapacityVerdict;
  if (hallViolation || anyRestViolated) {
    verdict = "impossible";
  } else {
    const ratioTight = slotDemand > 0 && slotSupply < TIGHT_RATIO * slotDemand;
    const slackTight = restBound.length > 0 && minSlackMinutes < slot;
    verdict = ratioTight || slackTight ? "tight" : "ok";
  }

  return { verdict, slotSupply, slotDemand, perDay, restBound };
}

function severity(v: CapacityVerdict): number {
  return v === "impossible" ? 2 : v === "tight" ? 1 : 0;
}

/** `ymd` (YYYY-MM-DD) + one calendar day, in UTC — a pure string→string
 *  calendar step over an EXPLICIT input, never the ambient clock. Callers
 *  that need this in the organiser's own zone (DST-aware) do that
 *  conversion themselves; this module has no `tz` import to do it here
 *  (leaf constraint, header comment). */
function addOneCalendarDay(ymd: string): string {
  const parts = ymd.split("-").map(Number);
  const y = parts[0]!;
  const mo = parts[1]!;
  const d = parts[2]!;
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const yyyy = String(next.getUTCFullYear()).padStart(4, "0");
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** The day whose EXPLICIT rule cap is below its own court supply — the true
 *  bottleneck a `raise_cap` suggestion can act on. A day defaulted to the
 *  fixture count (no rule cap at all) has nothing to raise: its limit is
 *  court supply, which `add_court`/`add_day` address instead. Ties break on
 *  the largest (supply − cap) deficit, the day where a rule is costing the
 *  most placeable room. */
function bindingCapDay(input: CapacityInput): string | undefined {
  const slot = input.matchMinutes + input.gapMinutes;
  let bestDate: string | undefined;
  let bestDeficit = -1;
  for (const day of input.days) {
    if (day.demandCap === undefined) continue;
    const supply = daySupply(day, slot, input.gapMinutes);
    if (day.demandCap >= supply) continue;
    const deficit = supply - day.demandCap;
    if (deficit > bestDeficit) {
      bestDeficit = deficit;
      bestDate = day.date;
    }
  }
  return bestDate;
}

function suggestionsFor(input: CapacityInput, currentVerdict: CapacityVerdict): CapacitySuggestion[] {
  const currentSeverity = severity(currentVerdict);
  const flips = (candidate: CapacityInput): boolean =>
    severity(computeCore(candidate).verdict) < currentSeverity;
  const out: CapacitySuggestion[] = [];

  // +1 day: clone the LAST day's court/window shape onto the next calendar
  // date. Only entrants with NO explicit `availableDays` restriction gain
  // it automatically (their horizon is recomputed from the new `days` list);
  // an entrant with an explicit list is left untouched, which is exactly
  // the design's caveat ("never emit a suggestion that violates a hard
  // rule, e.g. +1 day past a weekday-only constraint") — nothing here adds
  // the new date to a restricted entrant's own list.
  const lastDay = input.days[input.days.length - 1];
  if (lastDay !== undefined) {
    const dayMs = 24 * 60 * MS_PER_MIN;
    const newDay: CapacityDay = {
      date: addOneCalendarDay(lastDay.date),
      courts: lastDay.courts.map((c) => ({
        court: c.court,
        windows: c.windows.map((w) => ({ from: w.from + dayMs, to: w.to + dayMs })),
      })),
      ...(lastDay.demandCap !== undefined ? { demandCap: lastDay.demandCap } : {}),
    };
    const candidate: CapacityInput = { ...input, days: [...input.days, newDay] };
    out.push({ kind: "add_day", amount: 1, flipsVerdict: flips(candidate) });
  }

  // +1 court: duplicate the first court's window shape on every day that has
  // at least one court already (a day with zero courts has nothing to copy).
  if (input.days.some((d) => d.courts.length > 0)) {
    const candidate: CapacityInput = {
      ...input,
      days: input.days.map((d) => {
        const first = d.courts[0];
        if (first === undefined) return d;
        return {
          ...d,
          courts: [...d.courts, { court: `${first.court} (extra)`, windows: first.windows.map((w) => ({ ...w })) }],
        };
      }),
    };
    out.push({ kind: "add_court", amount: 1, flipsVerdict: flips(candidate) });
  }

  // shorten_match: m' = m - 5, floored at a generic sanity minimum.
  const shortened = input.matchMinutes - SUGGESTION_STEP_MINUTES;
  if (shortened >= MIN_SANE_MATCH_MINUTES) {
    const candidate: CapacityInput = { ...input, matchMinutes: shortened };
    out.push({ kind: "shorten_match", amount: SUGGESTION_STEP_MINUTES, flipsVerdict: flips(candidate) });
  }

  // shrink_gap: g' = max(0, g - 5).
  if (input.gapMinutes > 0) {
    const amount = Math.min(SUGGESTION_STEP_MINUTES, input.gapMinutes);
    const candidate: CapacityInput = { ...input, gapMinutes: input.gapMinutes - amount };
    out.push({ kind: "shrink_gap", amount, flipsVerdict: flips(candidate) });
  }

  // raise_cap: identify the binding rule-capped day, if any, and raise it by 1.
  const binding = bindingCapDay(input);
  if (binding !== undefined) {
    const candidate: CapacityInput = {
      ...input,
      days: input.days.map((d) => (d.date === binding ? { ...d, demandCap: (d.demandCap ?? 0) + 1 } : d)),
    };
    out.push({ kind: "raise_cap", amount: 1, flipsVerdict: flips(candidate) });
  }

  // Verdict-flippers first, then smallest amount (design's Arithmetic
  // section, verbatim ordering).
  out.sort((a, b) => {
    if (a.flipsVerdict !== b.flipsVerdict) return a.flipsVerdict ? -1 : 1;
    return a.amount - b.amount;
  });
  return out;
}

/**
 * assessCapacity (D2) — the one function every consumer of this precheck
 * calls: the setup card client-side, the auto/AI-plan route guards server-
 * side. Pure: same inputs, same report, always. No DB, no solver, no clock,
 * no logging — see capacity.test.ts's purity test.
 */
export function assessCapacity(input: CapacityInput): CapacityReport {
  const core = computeCore(input);
  const suggestions = core.verdict === "ok" ? [] : suggestionsFor(input, core.verdict);
  return { ...core, suggestions };
}
