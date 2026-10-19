// The capacity load run's arithmetic (spec §5.6.8, the metrics "defined once"): pure functions over the harness's OWN observations,
// shared by e2e/load/chess-30-boards.load.ts and proved by hand-counted cases in src/server/external-play/__tests__/line-load.test.ts.
// Times are epoch milliseconds unless the name says seconds. Every function that looks at a set reports HOW MANY it looked at: the
// run refuses a report that checked nothing (TEST-STRATEGY, anti-vacuity).
//
// A Playwright runner cannot import the server's modules (`server-only` neighbours), so the numbers it needs are COPIED here as
// `LINE_LOAD` and PINNED, one by one, to the server's own declarations in line-load.test.ts. A copy nothing pins would let the line
// move and the run keep measuring yesterday's.
import type { StayFacts } from "./line-checks";

export const LINE_LOAD = {
  /** window.ts: a board's rank divides by the batch size; each batch starts one gap after the last. */
  batchSize: 10,
  batchGapMs: 120_000,
  windowLeadMs: 600_000,
  deadlineAfterMs: 600_000,
  /** window.ts LINE_DEADLINE_GRACE_MS: the line's grace past the deadline (the board's cap). */
  lineGraceMs: 300_000,
  /** seat-line.ts: what one stay reserves, and the re-verify held beside it while it could complete its board. */
  reservation: 21,
  recheckCost: 3,
  /** seat-line.ts: when a stay stops counting - a held one silent this long, a passed one silent this long, an admitted one past its hold. */
  abandonAfterMs: 20_000,
  releaseGraceMs: 35_000,
  admitHoldMs: 54_500,
  /** sweep.ts: the cron cadence and the stranded-create arm's wait. */
  sweepCadenceMs: 300_000,
  strandedCreateAfterMs: 10_000,
  /** The spec's own thresholds (§5.6.8), declared there and nowhere in the product: a game seen later than this after both seats is a LATE create. */
  createPromptMs: 30_000,
  /** Two arrivals closer than this are network reordering, not a decision (an inversion excuse, §5.6.8). */
  arrivalJitterMs: 50,
  /** use-room.ts BATCH_REREAD_JITTER_MS: where a batch-waiting card re-reads. */
  batchRereadJitterMs: 2_000,
  /** room-snapshot.ts: the clamp a `queued` answer's `pollMs` meets on the client. */
  pollMinMs: 2_000,
  pollMs: 3_000,
} as const;

// ───────────────────────────────────────────────────────────────────────────────────────────────────── a board's times

export type BoardTimes = { batch: number; anchorAt: number; opensAt: number; deadlineAt: number; capAt: number };

/** A board's window (window.ts `boardAnchor` + `windowFor` + `boardCap`): batch 0 opens `windowLeadMs` before its anchor, a later batch AT
 *  it; every batch closes `deadlineAfterMs` after its own start; the cap is the deadline plus the line's grace. */
export function boardTimes(openedAtMs: number, rank: number, staggered: boolean): BoardTimes {
  if (!Number.isInteger(rank) || rank < 0) throw new RangeError(`a board's rank is a non-negative integer, got ${rank}`);
  const batch = staggered ? Math.floor(rank / LINE_LOAD.batchSize) : 0;
  const anchorAt = openedAtMs + batch * LINE_LOAD.batchGapMs;
  const deadlineAt = anchorAt + LINE_LOAD.deadlineAfterMs;
  return { batch, anchorAt, opensAt: batch === 0 ? anchorAt - LINE_LOAD.windowLeadMs : anchorAt, deadlineAt, capAt: deadlineAt + LINE_LOAD.lineGraceMs };
}

// ─────────────────────────────────────────────────────────────────────────────────── late / never-created boards (§5.6.8)

export type BoardCreate = {
  id: string;
  /** The later of the two players' seated instants; null when a player was never seated. */
  bothSeatedAt: number | null;
  /** The first instant the harness read the board's room and saw its game; null when it never did. */
  gameSeenAt: number | null;
  capAt: number;
};

export type CreateReport = {
  boards: number;
  /** Both seated and no game at the EARLIER of the cap and two sweep cadences after the last seat. */
  neverCreated: string[];
  /** A board whose game was first seen more than `promptMs` after both seated (the old harness called this "stranded"). */
  lateCreates: string[];
  /** A late create beyond the stranded arm's declared bound (cadence + STRANDED_CREATE_AFTER_MS): a defect even though it is not "never". */
  beyondStrandedBound: string[];
  /** Both seated, no game, and the run ended before the board's own judgement instant: the run proved nothing about it. */
  unresolved: string[];
  /** Boards with a player never seated (a walkover candidate, counted apart: they are neither late nor never-created). */
  notBothSeated: number;
  prompt: number;
  /** both-seated-to-game, ms, for the boards that got a game. */
  afterSeatMs: number[];
};

/** Classify every board by the spec's words. `endMs` is the instant the harness stopped watching. */
export function classifyCreates(boards: readonly BoardCreate[], endMs: number): CreateReport {
  const out: CreateReport = { boards: boards.length, neverCreated: [], lateCreates: [], beyondStrandedBound: [], unresolved: [], notBothSeated: 0, prompt: 0, afterSeatMs: [] };
  for (const b of boards) {
    if (b.bothSeatedAt === null) {
      out.notBothSeated += 1;
      continue;
    }
    if (b.gameSeenAt === null) {
      const judgedAt = Math.min(b.capAt, b.bothSeatedAt + 2 * LINE_LOAD.sweepCadenceMs);
      (endMs >= judgedAt ? out.neverCreated : out.unresolved).push(b.id);
      continue;
    }
    const after = b.gameSeenAt - b.bothSeatedAt;
    out.afterSeatMs.push(after);
    if (after > LINE_LOAD.createPromptMs) out.lateCreates.push(b.id);
    else out.prompt += 1;
    if (after > LINE_LOAD.sweepCadenceMs + LINE_LOAD.strandedCreateAfterMs) out.beyondStrandedBound.push(b.id);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────── realized calls per stay (§5.6.8)

export type VendorCall = { at: number; meetingId: string | null; route: string };

/** The fixture server's own count for one meeting inside [from, to]: both ends inclusive. A call with no meeting is nobody's. */
export function callsOf(calls: readonly VendorCall[], meetingId: string, from: number, to: number): VendorCall[] {
  return calls.filter((c) => c.meetingId === meetingId && c.at >= from && c.at <= to);
}

export type StayCost = {
  id: string;
  /** The stay's own meeting, from its first claim to its serve. */
  own: number;
  /** The OPPONENT's meeting, after the opponent was served and up to this stay's serve: the re-verify this stay's seat pays. */
  recheck: number;
  /** What the stay did that its reservation did not price: re-claims after a verdict, more than one stay, a re-press. */
  unreserved: string[];
};

export type StayCostInput = {
  id: string;
  ownMeeting: string;
  opponentMeeting: string | null;
  firstClaimAt: number;
  seatedAt: number;
  opponentSeatedAt: number | null;
  unreserved: string[];
};

export function stayCosts(calls: readonly VendorCall[], stays: readonly StayCostInput[]): StayCost[] {
  return stays.map((s) => ({
    id: s.id,
    own: callsOf(calls, s.ownMeeting, s.firstClaimAt, s.seatedAt).length,
    // The re-verify reads the OTHER player's camera: only the part of it after that player was already served is this stay's.
    recheck:
      s.opponentMeeting !== null && s.opponentSeatedAt !== null && s.opponentSeatedAt < s.seatedAt
        ? callsOf(calls, s.opponentMeeting, s.opponentSeatedAt + 1, s.seatedAt).length
        : 0,
    unreserved: s.unreserved,
  }));
}

export type CostVerdict = {
  stays: number;
  over: StayCost[];
  overRecheck: StayCost[];
  /** The distribution of `own`, one entry per distinct count: { calls: how many stays } - sorted by calls. */
  distribution: Record<number, number>;
  max: number;
};

/** Every stay's own spend against the reservation and its re-verify against the recheck cost. */
export function judgeCosts(costs: readonly StayCost[], reservation: number, recheckCost: number): CostVerdict {
  const distribution: Record<number, number> = {};
  for (const c of costs) distribution[c.own] = (distribution[c.own] ?? 0) + 1;
  return {
    stays: costs.length,
    over: costs.filter((c) => c.own > reservation),
    overRecheck: costs.filter((c) => c.recheck > recheckCost),
    distribution: Object.fromEntries(Object.entries(distribution).sort(([a], [b]) => Number(a) - Number(b))) as Record<number, number>,
    max: costs.reduce((m, c) => Math.max(m, c.own), 0),
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────── which bars a scenario owes

/** The pass bars a capacity scenario owes, by the SHAPE of its run (spec §5.6.8). Three families:
 *  - `cost`: the stays' realized spend against their reservation, and no gate-lock refusal - every burst run (B, B-honest, B-slow-*).
 *  - `order`: admission pairs, inversions, positions - bars about the LINE, so they are owed only where the line forms with two or more
 *    stays waiting (B-honest measured 210 pairs, the B-slow legs 780 and 1,377). At B's instant cameras the bucket runs dry once and the
 *    line holds ONE stay, so there is no pair to order: zero checked is a failure (TEST-STRATEGY), which is why B does not owe these bars
 *    rather than owing them conditionally.
 *  - `held`: B's own shape - the dry bucket must have been MET, and a completing claim held for it (heldStays >= 1). Without it the
 *    run's late-create bar would be vacuous: a bucket that never ran dry proves nothing about the re-verify.
 *  Any other name is a label (A, A-slow, B-end, regress, mixed) and owes none of these. */
export type ScenarioBars = { cost: boolean; order: boolean; held: boolean };
export function barsOf(scenario: string): ScenarioBars {
  const slow = scenario.startsWith("B-slow");
  return { cost: scenario === "B" || scenario === "B-honest" || slow, order: scenario === "B-honest" || slow, held: scenario === "B" };
}

/** Stays the budget held: a `queued_at` stamp is the line's own word for it (a stay admitted straight away was never held). */
export function heldStays(stays: readonly StayFacts[]): number {
  return stays.filter((s) => s.queuedAt !== null).length;
}

// ───────────────────────────────────────────────────────────────────────────────────────────── admission-order excuses

export type StayInLine = StayFacts & { /** A later stay of a player who already had one (left the line, silent, came back). */ rejoiner: boolean };

export type InversionReport = {
  /** Pairs of two stays that were both held and then admitted. */
  pairs: number;
  /** What is left after the three excuses: the number that must be 0. */
  unexcused: [string, string][];
  /** Each excuse, counted apart: (a) the earlier arrival is a rejoiner; (b) it was not yet held when the later one was admitted;
   *  (c) the two arrivals are under ARRIVAL_JITTER_MS apart. */
  excused: { rejoiner: number; notYetInLine: number; jitter: number };
};

/** Admission follows arrival (§5.6.8). An inversion is X arrived before Y, and Y was admitted before X. Excused: X is a rejoiner; X was
 *  first held only after Y was admitted; the arrivals are under `jitterMs` apart. A pair is counted under the FIRST excuse that
 *  applies, in that order. A stay admitted without ever being held is not in line and is out of the pairs. */
export function classifyInversions(stays: readonly StayInLine[], jitterMs: number = LINE_LOAD.arrivalJitterMs): InversionReport {
  const admitted = stays.filter((s) => s.queuedAt !== null && s.admittedAt !== null);
  const out: InversionReport = { pairs: 0, unexcused: [], excused: { rejoiner: 0, notYetInLine: 0, jitter: 0 } };
  for (let i = 0; i < admitted.length; i += 1) {
    for (let j = i + 1; j < admitted.length; j += 1) {
      const a = admitted[i]!;
      const b = admitted[j]!;
      if (a.firstClaimAt === b.firstClaimAt) continue; // a tie has no order to invert
      out.pairs += 1;
      const [early, late] = a.firstClaimAt < b.firstClaimAt ? [a, b] : [b, a];
      if (!(early.admittedAt! > late.admittedAt!)) continue;
      if (early.rejoiner) out.excused.rejoiner += 1;
      else if (early.queuedAt! > late.admittedAt!) out.excused.notYetInLine += 1;
      else if (late.firstClaimAt - early.firstClaimAt < jitterMs) out.excused.jitter += 1;
      else out.unexcused.push([early.id, late.id]);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────── the pool, in flight, drain

/** One sample of the ledger and the bucket (the harness reads both at least every 500 ms). */
export type LineSample = {
  at: number;
  /** The bucket's level as of the sample, refilled to the sample's instant (budget.ts `refilledTokens`). */
  tokens: number;
  /** Stays admitted, not served or ended, not lapsed: each holds a reservation. */
  inFlight: number;
  /** Of those, the ones that could complete their board (they hold the recheck cost too). */
  completing: number;
  /** Stays the budget is holding (queued, not admitted, not served or ended). */
  waiting: number;
};

/** The pool (§5.7.3): the bucket's level less every held reservation. */
export const poolOf = (s: LineSample, reservation: number = LINE_LOAD.reservation, recheck: number = LINE_LOAD.recheckCost): number =>
  s.tokens - s.inFlight * reservation - s.completing * recheck;

export type DrainReport = {
  /** The first sample at which a waiting stay stood and the pool held less than one reservation: the bucket has drained. */
  drainedAt: number | null;
  /** The most stays in flight at any sample from then on. */
  maxInFlightDrained: number;
  samplesChecked: number;
};

export function drainOf(samples: readonly LineSample[], reservation: number = LINE_LOAD.reservation, recheck: number = LINE_LOAD.recheckCost): DrainReport {
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const first = ordered.find((s) => s.waiting > 0 && poolOf(s, reservation, recheck) < reservation);
  if (!first) return { drainedAt: null, maxInFlightDrained: 0, samplesChecked: ordered.length };
  return {
    drainedAt: first.at,
    maxInFlightDrained: ordered.filter((s) => s.at >= first.at).reduce((m, s) => Math.max(m, s.inFlight), 0),
    samplesChecked: ordered.length,
  };
}

export type AdmissionPace = { admissions: number; intervals: number; meanS: number | null; p50S: number | null };

/** The interval between consecutive admissions from `from` on (seconds). A stay admitted before `from` is out of it. */
export function admissionPace(admittedAts: readonly number[], from: number): AdmissionPace {
  const ts = admittedAts.filter((t) => t >= from).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let k = 1; k < ts.length; k += 1) gaps.push((ts[k]! - ts[k - 1]!) / 1_000);
  if (gaps.length === 0) return { admissions: ts.length, intervals: 0, meanS: null, p50S: null };
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    admissions: ts.length,
    intervals: gaps.length,
    meanS: gaps.reduce((a, g) => a + g, 0) / gaps.length,
    p50S: sorted[Math.max(1, Math.ceil(0.5 * sorted.length)) - 1]!,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────── B-slow's bound

export type SlowBound = {
  /** D̄: the run's vendor calls per player. */
  perPlayer: number;
  /** `s`: one camera's warm-up plus the room's longest next-read wait. */
  s: number;
  /** The over-hold's UPPER bound, with every in-flight stay priced at its reservation PLUS the recheck cost (the brief's P3). */
  lag: number;
  /** The spec's own lag (reservation alone), reported beside it. */
  lagSpec: number;
  bound: number;
  /** What a build that holds each camera through its warm-up would take. */
  sumModel: number;
  /** The run FAILS at 10 s if this is false: a bound the sum model also meets proves nothing. */
  discriminates: boolean;
};

/** `bound = (D_run - burst) / refill + s + poll + lag` (§5.6.8 B-slow, 1). Every term from the run and the constants, never typed. */
export function slowBound(i: {
  callsRun: number;
  players: number;
  warmupS: number;
  maxInFlightDrained: number;
  burst: number;
  refillPerS: number;
  pollMs: number;
  maxBackoffMs: number;
  reservation?: number;
  recheckCost?: number;
}): SlowBound {
  if (!(i.players > 0)) throw new RangeError("slowBound: a run with no players has no bound");
  const reservation = i.reservation ?? LINE_LOAD.reservation;
  const recheck = i.recheckCost ?? LINE_LOAD.recheckCost;
  const perPlayer = i.callsRun / i.players;
  const s = i.warmupS + i.maxBackoffMs / 1_000;
  const lagOf = (hold: number) => (i.maxInFlightDrained * hold + Math.max(0, hold - perPlayer)) / i.refillPerS;
  const lag = lagOf(reservation + recheck);
  const bound = (i.callsRun - i.burst) / i.refillPerS + s + i.pollMs / 1_000 + lag;
  const sumModel = i.players * i.warmupS;
  return { perPlayer, s, lag, lagSpec: lagOf(reservation), bound, sumModel, discriminates: sumModel > bound };
}

/** §5.7.3 / §12: admission more than half again slower than the budget's own pace means netting a stay's metered spend out of its
 *  reservation is owed. Judged on the MEAN interval, not the p50, because stays released together admit in clumps. */
export function nettingOwed(meanIntervalS: number | null, perPlayer: number, refillPerS: number): boolean {
  if (meanIntervalS === null) return false;
  return meanIntervalS > (1.5 * perPlayer) / refillPerS;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────── ETA shown

/** The ETA a player was first shown against the wait that happened (both seconds; the ETA ends at ADMISSION and is an upper bound by
 *  construction, §5.7.9). `ratios` is shown / actual for the players whose actual wait was above zero. */
export function etaStats(items: readonly { shownS: number; actualS: number }[]): {
  players: number;
  medianShownOverActual: number | null;
  exceeded: number;
} {
  const ratios = items.filter((x) => x.actualS > 0).map((x) => x.shownS / x.actualS).sort((a, b) => a - b);
  return {
    players: items.length,
    medianShownOverActual: ratios.length === 0 ? null : ratios[Math.max(1, Math.ceil(0.5 * ratios.length)) - 1]!,
    // The ETA is an UPPER bound: a wait longer than it was shown is a violation, reported.
    exceeded: items.filter((x) => x.actualS > x.shownS).length,
  };
}

/** Requests per second: the busiest second and how many requests it held. */
export function peakPerSecond(timesMs: readonly number[]): { peak: number; seconds: number } {
  const bySecond = new Map<number, number>();
  for (const t of timesMs) bySecond.set(Math.floor(t / 1_000), (bySecond.get(Math.floor(t / 1_000)) ?? 0) + 1);
  return { peak: Math.max(0, ...bySecond.values()), seconds: bySecond.size };
}
