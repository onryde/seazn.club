// Schedule health score (D3) — design doc
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-schedule-health-design.md.
// After a schedule is proposed/applied: how GOOD is it, per metric, with
// named offenders — "lawful but ugly" made visible. Per-metric bars 0-100,
// NO composite grade (owner ruling: a composite hides which metric is bad
// and bakes a fairness opinion into one number).
//
// LEAF MODULE, zero imports — even leafer than capacity.ts (which needs one
// import, rest-floor.ts, for a shared rest-bound arithmetic). None of the
// five formulas below need an external rest floor, sport module or clock:
// restSpread's "achievable ideal" is derived entirely from the entrant's own
// observed fixture span, not from a configured rest rule.
//
// Day-bucketing is the CALLER's job, same split capacity.ts/capacity-input.ts
// use for the same reason: this module takes a caller-resolved `dayKey` per
// fixture (organiser tz, via scheduling/tz.ts's dayKeyInTz) rather than
// importing tz.ts itself — see health.test.ts's purity test, which fails if
// this file grows ANY import.
//
// Contract (bench-shared, design doc verbatim): pure, deterministic, no DB,
// no solver imports, no clock reads. The future bench consumes this EXACT
// function — API changes here are bench-plan changes.
//
// Metric functions below are being built up one at a time (TDD) — an
// unimplemented one returns NOT_IMPLEMENTED, an obviously-wrong sentinel, so
// a test for a DIFFERENT metric cannot pass by accident against it.

export type HealthMetricKey =
  | "restSpread"
  | "courtBalance"
  | "gapDispersion"
  | "homeAwayAlternation"
  | "primeSlotFairness";

/** One applied/proposed fixture — the caller has already resolved a court,
 *  an instant and (for gapDispersion/primeSlotFairness) a calendar-day
 *  bucket. `home`/`away` are undefined for an unresolved bracket side (a
 *  "TBD" slot that already holds a court+time reservation) — such a fixture
 *  still counts toward gapDispersion/primeSlotFairness's court-day grouping
 *  (which don't key off entrants) but contributes to no per-entrant metric
 *  on its unresolved side. */
export interface HealthFixture {
  fixtureId: string;
  court: string;
  start: number; // epoch ms
  end: number; // epoch ms, > start
  /** Caller-resolved calendar day (organiser tz) this fixture's court-day
   *  bucket belongs to — see module header. */
  dayKey: string;
  home?: string;
  away?: string;
  roundNo?: number;
  poolId?: string;
  divisionId?: string;
}

export interface HealthWindow {
  from: number;
  to: number; // exclusive
}

export interface HealthConfig {
  /** Gates homeAwayAlternation (round-robin only). false OMITS the metric
   *  from the report entirely — see assessHealth's doc comment — it is
   *  never scored 0 for a bracket stage. */
  isRoundRobin: boolean;
  /** Per-court-day operating window (session hours), keyed
   *  `${court}::${dayKey}` — the span gapDispersion's idle_edges measures
   *  against. A court-day with no entry here falls back to the SPAN of its
   *  own placed fixtures (idle_edges defaults to 0 for it) — see
   *  gapDispersionMetric's computation. */
  courtWindows?: Readonly<Record<string, HealthWindow>>;
}

export interface HealthOffender {
  kind: "entrant" | "court" | "courtDay";
  /** Raw id (entrant id, court label, or `${court}::${dayKey}`) — D5 adds
   *  resolved display names later (design doc's own sequencing note); this
   *  module and the route stay at raw labels for now. */
  id: string;
  label: string;
  value: number;
}

export interface HealthExplanation {
  /** i18n dictionary key (namespace `schedule.health.explain.*`) — this
   *  module never emits literal English prose (standing i18n rule: every
   *  user-facing string routes through the four dictionaries). The UI
   *  resolves this key against the active locale, same split CapacityCard
   *  uses for its own text (structured data out of the lib, all copy owned
   *  by the component). */
  key: string;
  params?: Record<string, number>;
}

export interface HealthMetric {
  key: HealthMetricKey;
  /** 0-100, integer. Clamped to [0,100] as a float, THEN rounded half-up
   *  (design doc's Rounding note, verbatim order). */
  score: number;
  explanation: HealthExplanation;
  offenders: HealthOffender[];
}

export interface HealthReport {
  /** 5 entries, or 4 when `config.isRoundRobin` is false —
   *  homeAwayAlternation is ABSENT then, never a present entry scored 0. */
  metrics: HealthMetric[];
}

/** Prime = last PRIME_N slots per court-day (design doc's declared default).
 *  A module constant, not re-derived — health.test.ts's regression test
 *  asserts against THIS export, never a re-typed literal. */
export const PRIME_N = 2;

/** C_min (courtBalance): an entrant needs at least this many fixtures before
 *  "which courts did they land on" is a meaningful question at all. */
export const COURT_BALANCE_MIN_FIXTURES = 3;

/** r >= this many consecutive same-side fixtures makes an entrant a
 *  homeAwayAlternation offender (design doc's threshold, verbatim). */
export const HOME_AWAY_RUN_THRESHOLD = 4;

const MS_PER_MIN = 60_000;

/** Lexicographic tie-break (design doc's Rounding/Determinism note,
 *  verbatim: "ties in offender ordering break by entrant id lexicographic"
 *  — applied here to every offender kind's own `id`, not just entrants). */
function lex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every fixture an entrant appears in (home OR away), ascending by start —
 *  every formula below that walks "F_e" (the design notation) reads this. */
function entrantFixtures(fixtures: readonly HealthFixture[]): Map<string, HealthFixture[]> {
  const byEntrant = new Map<string, HealthFixture[]>();
  const add = (id: string | undefined, f: HealthFixture): void => {
    if (id === undefined) return;
    const list = byEntrant.get(id);
    if (list !== undefined) list.push(f);
    else byEntrant.set(id, [f]);
  };
  for (const f of fixtures) {
    add(f.home, f);
    add(f.away, f);
  }
  for (const list of byEntrant.values()) list.sort((a, b) => a.start - b.start);
  return byEntrant;
}

function clampScore(x: number): number {
  return Math.max(0, Math.min(100, x));
}

function roundScore(x: number): number {
  return Math.round(clampScore(x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Sort descending by `cmpDesc`, tie-break by `id` ascending, keep the first
 *  `n` — the shared "worst/bottom/top-N" shape every metric's offender list
 *  uses (design doc: "bottom-3"/"worst-3"/"top-3", each descending by badness). */
function topOffenders<T>(items: readonly T[], id: (t: T) => string, cmpDesc: (a: T, b: T) => number, n: number): T[] {
  return [...items].sort((a, b) => cmpDesc(a, b) || lex(id(a), id(b))).slice(0, n);
}

/**
 * Dispersion of inter-match rest per entrant vs THIS entrant's own achievable
 * ideal (design doc, verbatim): ḡ*_e = (span_e − Σ durations_e) / (|F_e|−1),
 * p_e = Σ max(0, (ḡ*_e − g_i) / ḡ*_e) / (|F_e|−1), score = 100·(1 − mean_e(p_e)).
 *
 * Note (worth recording — it is easy to misjudge by eye): span_e decomposes
 * exactly into Σ durations_e + Σ g_i (fixtures tile the entrant's own span
 * with no other idle time in between, by construction of "span"), so ḡ*_e is
 * ALGEBRAICALLY the mean of the entrant's own gaps. That is why an entrant
 * with exactly 2 NON-OVERLAPPING fixtures (one non-negative gap) always
 * scores p_e = 0 here regardless of how tight that single gap is: the
 * "ideal" IS that one gap. Only 3+ fixtures (2+ gaps) can show any
 * dispersion at all — health.test.ts asserts this explicitly so it reads as
 * intended, not as an accident. A genuinely OVERLAPPING pair (a negative
 * gap — this entrant double-booked) is the one exception, at any fixture
 * count: see the `hasOverlap` branch below (review finding #3) — it scores
 * the worst penalty, never the "only one gap, always perfect" shortcut.
 */
function restSpreadMetric(fixtures: readonly HealthFixture[]): HealthMetric {
  const byEntrant = entrantFixtures(fixtures);
  const penalties: { id: string; p: number; worstGapMin: number }[] = [];
  for (const [id, list] of byEntrant) {
    if (list.length < 2) continue;
    const span = list[list.length - 1]!.end - list[0]!.start;
    const durSum = list.reduce((s, f) => s + (f.end - f.start), 0);
    const idealGap = (span - durSum) / (list.length - 1);
    const gaps: number[] = [];
    for (let i = 0; i < list.length - 1; i++) gaps.push(list[i + 1]!.start - list[i]!.end);
    // A non-positive idealGap has TWO distinct causes, and they score
    // oppositely — review finding #3, an earlier version of this comment
    // claimed "every gap is also <= 0 then", which is false in general (a
    // non-positive MEAN does not imply every term is non-positive: e.g.
    // gaps=[-10, 10] means idealGap=0 while one gap is genuinely negative).
    // So the two causes are told apart directly, not inferred from
    // idealGap's sign:
    //  - hasOverlap (some gap < 0): this entrant is double-booked somewhere
    //    — the WORST case a board can produce, never scored as perfect.
    //  - no overlap, idealGap === 0: every gap is EXACTLY 0 (a sum of
    //    non-negative numbers is 0 only if each term is 0) — a legitimately
    //    perfect, fully back-to-back board with zero wasted time.
    const hasOverlap = gaps.some((g) => g < 0);
    const p = hasOverlap
      ? 1
      : idealGap > 0
        ? gaps.reduce((s, g) => s + Math.max(0, (idealGap - g) / idealGap), 0) / gaps.length
        : 0;
    penalties.push({ id, p, worstGapMin: Math.min(...gaps) / MS_PER_MIN });
  }
  const meanP = penalties.length > 0 ? penalties.reduce((s, x) => s + x.p, 0) / penalties.length : 0;
  // The TRUE count of affected entrants (p_e > 0) — review finding #2:
  // `offenders.length` is truncated by `topOffenders(...,3)` below, so on a
  // board with more than 3 affected entrants it under-reports (e.g. "3
  // entrants..." on a board where 9 actually have compressed rest). Counted
  // BEFORE truncation, never derived from the capped list.
  const affectedCount = penalties.filter((x) => x.p > 0).length;
  const offenders: HealthOffender[] = topOffenders(penalties, (x) => x.id, (a, b) => b.p - a.p, 3).map((x) => ({
    kind: "entrant",
    id: x.id,
    label: x.id,
    value: round2(x.worstGapMin),
  }));
  return {
    key: "restSpread",
    score: roundScore(100 * (1 - meanP)),
    explanation: { key: "schedule.health.explain.restSpread", params: { count: affectedCount } },
    offenders,
  };
}

/**
 * Per entrant with |F_e| >= C_min: Shannon entropy H_e of its court
 * distribution / H_max = log(min(|courts|, |F_e|)). Score = 100 · mean_e(H_e
 * / H_max) (design doc, verbatim). |courts| is the board-wide distinct court
 * count, not a per-entrant count.
 */
function courtBalanceMetric(fixtures: readonly HealthFixture[]): HealthMetric {
  const byEntrant = entrantFixtures(fixtures);
  const courtsTotal = new Set(fixtures.map((f) => f.court)).size;
  const ratios: { id: string; ratio: number; distinctCourts: number }[] = [];
  for (const [id, list] of byEntrant) {
    if (list.length < COURT_BALANCE_MIN_FIXTURES) continue;
    const counts = new Map<string, number>();
    for (const f of list) counts.set(f.court, (counts.get(f.court) ?? 0) + 1);
    const n = list.length;
    let h = 0;
    for (const c of counts.values()) {
      const p = c / n;
      h -= p * Math.log(p);
    }
    const hMax = Math.log(Math.min(courtsTotal, n));
    // hMax === 0 only when there is nowhere TO spread (one court total, or
    // min(courtsTotal, n) === 1) — every fixture necessarily lands on the
    // same court then, which is not a defect: full marks rather than 0/0.
    const ratio = hMax > 0 ? h / hMax : 1;
    ratios.push({ id, ratio, distinctCourts: counts.size });
  }
  const mean = ratios.length > 0 ? ratios.reduce((s, x) => s + x.ratio, 0) / ratios.length : 1;
  // TRUE count of affected entrants (ratio < 1, i.e. not perfectly uniform)
  // — see restSpread's identical note (review finding #2). Counted before
  // `topOffenders(...,3)` truncates the list below.
  const affectedCount = ratios.filter((x) => x.ratio < 1).length;
  const offenders: HealthOffender[] = topOffenders(ratios, (x) => x.id, (a, b) => a.ratio - b.ratio, 3).map((x) => ({
    kind: "entrant",
    id: x.id,
    label: x.id,
    value: x.distinctCourts,
  }));
  return {
    key: "courtBalance",
    score: roundScore(100 * mean),
    explanation: { key: "schedule.health.explain.courtBalance", params: { count: affectedCount } },
    offenders,
  };
}

function courtDayKey(f: HealthFixture): string {
  return `${f.court}::${f.dayKey}`;
}

/** Every fixture sharing a (court, day) bucket, ascending by start —
 *  gapDispersion and primeSlotFairness both group this way. */
function courtDayFixtures(fixtures: readonly HealthFixture[]): Map<string, HealthFixture[]> {
  const map = new Map<string, HealthFixture[]>();
  for (const f of fixtures) {
    const key = courtDayKey(f);
    const list = map.get(key);
    if (list !== undefined) list.push(f);
    else map.set(key, [f]);
  }
  for (const list of map.values()) list.sort((a, b) => a.start - b.start);
  return map;
}

/**
 * Per court-day: idle = window_len − Σ busy; frag f = idle_inside /
 * (idle_inside + idle_edges). Score = 100 · (1 − mean(f)) over court-days
 * with >= 2 fixtures (design doc, verbatim).
 */
function gapDispersionMetric(fixtures: readonly HealthFixture[], config: HealthConfig): HealthMetric {
  const byCourtDay = courtDayFixtures(fixtures);
  const frags: { id: string; f: number; largestHoleMin: number }[] = [];
  for (const [key, list] of byCourtDay) {
    if (list.length < 2) continue;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const busy = list.reduce((s, f) => s + (f.end - f.start), 0);
    let idleInside = 0;
    let largestHole = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const gap = Math.max(0, list[i + 1]!.start - list[i]!.end);
      idleInside += gap;
      if (gap > largestHole) largestHole = gap;
    }
    const window = config.courtWindows?.[key];
    const windowLen = window !== undefined ? window.to - window.from : last.end - first.start;
    const idle = Math.max(0, windowLen - busy);
    const idleEdges = Math.max(0, idle - idleInside);
    const denom = idleInside + idleEdges;
    const f = denom > 0 ? idleInside / denom : 0;
    frags.push({ id: key, f, largestHoleMin: largestHole / MS_PER_MIN });
  }
  const mean = frags.length > 0 ? frags.reduce((s, x) => s + x.f, 0) / frags.length : 0;
  // TRUE count of affected court-days (f > 0, i.e. some fragmentation) —
  // see restSpread's identical note (review finding #2). Counted before
  // `topOffenders(...,3)` truncates the list below.
  const affectedCount = frags.filter((x) => x.f > 0).length;
  const offenders: HealthOffender[] = topOffenders(frags, (x) => x.id, (a, b) => b.f - a.f, 3).map((x) => {
    const [court, dayKey] = x.id.split("::");
    return { kind: "courtDay", id: x.id, label: `${court} ${dayKey}`, value: round2(x.largestHoleMin) };
  });
  return {
    key: "gapDispersion",
    score: roundScore(100 * (1 - mean)),
    explanation: { key: "schedule.health.explain.gapDispersion", params: { count: affectedCount } },
    offenders,
  };
}

/**
 * Round-robin divisions only — the CALLER gates this (config.isRoundRobin);
 * assessHealth omits the metric entirely rather than scoring a bracket
 * stage's non-existent home/away pattern. Per entrant: r = longest same-side
 * run, a = alternation rate = flips / (|F_e|−1). Score = 100 · mean_e(a) −
 * 10 · max(0, max_e(r) − 3), clamped (design doc, verbatim). Entrants with
 * |F_e| < 2 excluded — same reason as restSpread: a is undefined with zero
 * gaps to flip across.
 */
function homeAwayAlternationMetric(fixtures: readonly HealthFixture[]): HealthMetric {
  const byEntrant = entrantFixtures(fixtures);
  const stats: { id: string; a: number; r: number }[] = [];
  for (const [id, list] of byEntrant) {
    if (list.length < 2) continue;
    const sides = list.map((f) => (f.home === id ? "home" : "away"));
    let flips = 0;
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < sides.length; i++) {
      if (sides[i] !== sides[i - 1]) {
        flips++;
        run = 1;
      } else {
        run++;
        if (run > maxRun) maxRun = run;
      }
    }
    stats.push({ id, a: flips / (sides.length - 1), r: maxRun });
  }
  const meanA = stats.length > 0 ? stats.reduce((s, x) => s + x.a, 0) / stats.length : 1;
  const maxR = stats.length > 0 ? Math.max(...stats.map((x) => x.r)) : 0;
  const offenders: HealthOffender[] = stats
    .filter((x) => x.r >= HOME_AWAY_RUN_THRESHOLD)
    .sort((a, b) => b.r - a.r || lex(a.id, b.id))
    .map((x) => ({ kind: "entrant", id: x.id, label: x.id, value: x.r }));
  return {
    key: "homeAwayAlternation",
    score: roundScore(100 * meanA - 10 * Math.max(0, maxR - 3)),
    explanation: { key: "schedule.health.explain.homeAwayAlternation", params: { count: offenders.length } },
    offenders,
  };
}

/**
 * Prime = last PRIME_N slots per court-day. Expected share per entrant =
 * |F_e| · P / |F|. Deviation d_e = |actual_e − expected_e| / max(expected_e,
 * 1). Score = 100 · (1 − mean_e(min(d_e, 1))) (design doc, verbatim). No
 * |F_e| exclusion — unlike restSpread/courtBalance/homeAwayAlternation, the
 * design states none for this metric, and a 1-fixture entrant still has a
 * well-defined expected share.
 */
function primeSlotFairnessMetric(fixtures: readonly HealthFixture[]): HealthMetric {
  const byCourtDay = courtDayFixtures(fixtures);
  const primeFixtureIds = new Set<string>();
  for (const list of byCourtDay.values()) {
    const primeCount = Math.min(PRIME_N, list.length);
    for (let i = list.length - primeCount; i < list.length; i++) primeFixtureIds.add(list[i]!.fixtureId);
  }
  const totalFixtures = fixtures.length;
  const totalPrime = primeFixtureIds.size;
  const byEntrant = entrantFixtures(fixtures);
  const devs: { id: string; d: number; signed: number }[] = [];
  for (const [id, list] of byEntrant) {
    const expected = totalFixtures > 0 ? (list.length * totalPrime) / totalFixtures : 0;
    const actual = list.filter((f) => primeFixtureIds.has(f.fixtureId)).length;
    const d = Math.abs(actual - expected) / Math.max(expected, 1);
    devs.push({ id, d, signed: actual - expected });
  }
  const meanD = devs.length > 0 ? devs.reduce((s, x) => s + Math.min(x.d, 1), 0) / devs.length : 0;
  // TRUE count of affected entrants (d > 0, i.e. any deviation from their
  // expected prime share) — see restSpread's identical note (review finding
  // #2). Counted before `topOffenders(...,3)` truncates the list below.
  const affectedCount = devs.filter((x) => x.d > 0).length;
  const offenders: HealthOffender[] = topOffenders(devs, (x) => x.id, (a, b) => b.d - a.d, 3).map((x) => ({
    kind: "entrant",
    id: x.id,
    label: x.id,
    value: round2(x.signed),
  }));
  return {
    key: "primeSlotFairness",
    score: roundScore(100 * (1 - meanD)),
    explanation: { key: "schedule.health.explain.primeSlotFairness", params: { count: affectedCount } },
    offenders,
  };
}

/**
 * assessHealth (D3) — the one function every consumer calls: the stage
 * health route server-side today, the future bench's believability report
 * later (same function, per the module header's bench-shared contract).
 * Pure: same inputs, same report, always. No DB, no solver, no clock, no
 * logging — see health.test.ts's purity test.
 */
export function assessHealth(fixtures: readonly HealthFixture[], config: HealthConfig): HealthReport {
  const metrics: HealthMetric[] = [
    restSpreadMetric(fixtures),
    courtBalanceMetric(fixtures),
    gapDispersionMetric(fixtures, config),
    ...(config.isRoundRobin ? [homeAwayAlternationMetric(fixtures)] : []),
    primeSlotFairnessMetric(fixtures),
  ];
  return { metrics };
}
