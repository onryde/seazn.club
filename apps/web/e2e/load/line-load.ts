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
  /** seat-line.ts lineReservation(kind, readCalls): what one stay reserves, by what its first claim meets (`none`: room and participant on file,
   *  `room`: the pre-mint job's room is waiting, `all`: nothing on file) and by the read the seat makes - `proof`, the one-read proof ON
   *  (EXTERNAL_PLAY_PRESENCE_PROOF=1: a read is LINE_READ_CALLS), `fallback`, the three-call read (LINE_FALLBACK_READ_CALLS). Typed from the
   *  owner's price table (check-in capacity plan 2, ruling R1) and pinned number by number to lineReservation in line-load.test.ts. */
  stayPrice: {
    proof: { none: 8, room: 8, all: 9 },
    fallback: { none: 21, room: 20, all: 21 },
  },
  /** seat-line.ts lineRecheckCost(readCalls): the re-verify held beside a stay's reservation while it could complete its board - one read with
   *  the proof, the three-call read without it. */
  recheckCost: { proof: 1, fallback: 3 },
  /** seat-line.ts lineCompletingLevel(LINE_FALLBACK_READ_CALLS): the bucket level at which an idle line lets a completing claim straight through (reads + token + re-verify). */
  completingLevel: 7,
  /** MEASURED, not declared anywhere: the report's `perPlayerCheckIn` of every instant-camera B run (426 check-in calls for 60 players). The pin test
   *  brackets it between the model's floor and ceiling made from seat-line.ts's own call counts, so a change under it cannot pass silently. */
  instantCallsPerPlayer: 7.1,
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

/** Which of `LINE_LOAD`'s two price sets a run is measured against: the server's read mode (EXTERNAL_PLAY_PRESENCE_PROOF). */
export type ReadMode = "proof" | "fallback";

/** `LOAD_PRESENCE_PROOF`, the runner's copy of the SERVER's flag (the server under test reads it from ITS env, and only the exact value "1"
 *  turns the proof on): "1" is the flag-on prices, unset / "" / "0" the flag-off ones. Any other spelling throws - the server would read it as
 *  OFF, and a run that picked the flag-on bars for a flag-off server would call every stay over its price. */
export function parseProofKnob(raw: string | undefined): ReadMode {
  if (raw === undefined || raw === "" || raw === "0") return "fallback";
  if (raw === "1") return "proof";
  throw new Error(`LOAD_PRESENCE_PROOF=${raw} is not "0" or "1"`);
}

/** The dearest price a stay of this read mode is stamped with: what a bar compares a stay's realised spend to (a stay is stamped with the price
 *  of what its first claim met, never above this). Flag on 9, flag off 21 - a bar written against 21 cannot see a flag-on overspend. */
export const stayPriceMax = (mode: ReadMode): number => Math.max(...Object.values(LINE_LOAD.stayPrice[mode]));

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

/** The floor of the run's wall clock: seeding, the arrivals, the games, teardown and the evidence wait of a round that opens in one batch.
 *  It was the run's whole clock (a flat 30 minutes) until a 128-board division needed more. */
export const RUN_FLOOR_MS = 30 * 60_000;

/** The run's wall clock (the test's timeout) for a run whose biggest division seats `largestDivisionBoards` boards: the floor plus where
 *  that division's LAST batch starts, (batches - 1) gaps after its first. Everything after a batch opens - its arrivals, its games, the
 *  teardown and the evidence wait behind the last result - runs from there, so a flat clock is a latent red (AGENTS.md #20): 128 boards
 *  are 13 batches, the last 24 minutes in - twelve minutes past the 64-board division's, whose real-lila run (45088539154) took 968 s
 *  after seeding, which puts 128 at about 29.5 of the flat 30 minutes. Derived from the batch constants, so a retuned gap moves it. */
export function runTimeoutMs(largestDivisionBoards: number): number {
  if (!Number.isInteger(largestDivisionBoards) || largestDivisionBoards < 1) {
    throw new RangeError(`a division's board count is a positive integer, got ${largestDivisionBoards}`);
  }
  return RUN_FLOOR_MS + boardTimes(0, largestDivisionBoards - 1, true).anchorAt;
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
 *  - `dry`: B-dry's own shape - the bucket must have been MET: a stay held for it (heldStays >= 1) and the gate must have SEEN a level under the
 *    completing level. Without it the run's late-create bar would be vacuous: a bucket that never ran dry proves nothing about the re-verify.
 *    B itself does NOT owe it: its demand (426 calls) sits a few tokens from its supply (about 430), so whether a stay is held is run to run
 *    (held in 5 of 6 runs) - B owes the product bars (0 never, late or beyond) and its held count and lowest gate level are only RECORDED.
 *    B-dry is B made short of tokens ON PURPOSE (dryArrivalSpreadS), so the bucket is dry by construction rather than by luck.
 *  Any other name is a label (A, A-slow, B-end, regress, mixed) and owes none of these. */
export type ScenarioBars = { cost: boolean; order: boolean; dry: boolean };
export function barsOf(scenario: string): ScenarioBars {
  const slow = scenario.startsWith("B-slow");
  return { cost: scenario === "B" || scenario === "B-honest" || slow, order: scenario === "B-honest" || slow, dry: scenario === "B-dry" };
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
export const poolOf = (s: LineSample, reservation: number = stayPriceMax("fallback"), recheck: number = LINE_LOAD.recheckCost.fallback): number =>
  s.tokens - s.inFlight * reservation - s.completing * recheck;

export type DrainReport = {
  /** The first sample at which a waiting stay stood and the pool held less than one reservation: the bucket has drained. */
  drainedAt: number | null;
  /** The most stays in flight at any sample from then on. */
  maxInFlightDrained: number;
  samplesChecked: number;
};

export function drainOf(samples: readonly LineSample[], reservation: number = stayPriceMax("fallback"), recheck: number = LINE_LOAD.recheckCost.fallback): DrainReport {
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
  const reservation = i.reservation ?? stayPriceMax("fallback");
  const recheck = i.recheckCost ?? LINE_LOAD.recheckCost.fallback;
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

/** The ETA a player was first shown against the wait that happened (both seconds; the ETA ends at ADMISSION and is a conservative
 *  estimate, not an upper bound by construction: §5.7.9, final review M-2). `ratios` is shown / actual for the players whose actual wait was above zero. */
export function etaStats(items: readonly { shownS: number; actualS: number }[]): {
  players: number;
  medianShownOverActual: number | null;
  exceeded: number;
} {
  const ratios = items.filter((x) => x.actualS > 0).map((x) => x.shownS / x.actualS).sort((a, b) => a - b);
  return {
    players: items.length,
    medianShownOverActual: ratios.length === 0 ? null : ratios[Math.max(1, Math.ceil(0.5 * ratios.length)) - 1]!,
    // A wait longer than the ETA shown is reported, not hidden: the ETA is conservative (§5.7.9), and these are the players it fell short for.
    exceeded: items.filter((x) => x.actualS > x.shownS).length,
  };
}

/** The `mayTimeOut` warning as the players were shown it (spec 5.7.9: it rides on the ETA, so an optimistic ETA delays it). `logs` is
 *  each player's answers in order; an answer with no `line` (the player was not held) is not counted. Reported with its denominators,
 *  so "0 warnings" over "0 answers" cannot pass for "0 warnings" over a run where the line formed. */
export function warningStats(logs: readonly (readonly { line: { mayTimeOut: boolean } | null }[])[]): {
  answersWithALine: number;
  warnedAnswers: number;
  playersWithALine: number;
  playersWarned: number;
} {
  let answersWithALine = 0;
  let warnedAnswers = 0;
  let playersWithALine = 0;
  let playersWarned = 0;
  for (const log of logs) {
    const lines = log.flatMap((c) => (c.line ? [c.line] : []));
    answersWithALine += lines.length;
    warnedAnswers += lines.filter((l) => l.mayTimeOut).length;
    if (lines.length > 0) playersWithALine += 1;
    if (lines.some((l) => l.mayTimeOut)) playersWarned += 1;
  }
  return { answersWithALine, warnedAnswers, playersWithALine, playersWarned };
}

/** Requests per second: the busiest second and how many requests it held. */
export function peakPerSecond(timesMs: readonly number[]): { peak: number; seconds: number } {
  const bySecond = new Map<number, number>();
  for (const t of timesMs) bySecond.set(Math.floor(t / 1_000), (bySecond.get(Math.floor(t / 1_000)) ?? 0) + 1);
  return { peak: Math.max(0, ...bySecond.values()), seconds: bySecond.size };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── B-dry: a dry bucket by derivation

/** What B-dry's demand must exceed the bucket's supply by, in calls. Made of the product's own declarations, one reason each:
 *   - `reservation + recheckCost`: a completing candidate that is NOT let straight through must be held for a whole claim (what it reserves) plus the
 *     re-verify beside it. A run short of less than that never forces the gate to hold one - the shortfall would be absorbed by a single admitted claim.
 *   - `completingLevel`: the level an idle line wants before it lets a completing claim by. A run that ends no lower than that level never stood
 *     below it, and the min-gate-level bar (< completingLevel) could not be met.
 *  The run's tail (the check-ins that still run after the last arrival, and the refill that keeps coming during it) is NOT modelled; this margin is
 *  what absorbs it, which is why it is the sum of three whole thresholds rather than a single token.
 *  Made of the FLAG-OFF numbers on purpose: `instantCallsPerPlayer` was measured with the one-read proof off, so B-dry is a flag-off leg (the
 *  harness refuses `LOAD_PRESENCE_PROOF=1` for it). */
export const DRY_MARGIN_CALLS = stayPriceMax("fallback") + LINE_LOAD.recheckCost.fallback + LINE_LOAD.completingLevel;

export type DryArrivalInput = { players: number; perPlayerCalls: number; burst: number; refillPerS: number; marginCalls: number };

/** The arrival spread, in seconds, at which `players` arrivals of `perPlayerCalls` check-in calls each EXCEED what the call budget can supply by
 *  `marginCalls`. The bucket supplies `burst + refillPerS * spreadS` over a spread (full at the start, refilling the whole time), so
 *      demand - supply = marginCalls
 *      players * perPlayerCalls - burst - refillPerS * spreadS = marginCalls
 *      spreadS = (players * perPlayerCalls - burst - marginCalls) / refillPerS
 *  At B's 60 s the same sum leaves demand (426) a handful of calls above supply, which is a knife edge; this spread is the one that moves it a whole
 *  margin past. null when there is no such spread (no demand, no refill, or a demand the burst plus the margin already covers): the run refuses to
 *  start rather than run a "dry" leg that cannot be dry. */
export function dryArrivalSpreadS(i: DryArrivalInput): number | null {
  if (!(i.players > 0) || !(i.perPlayerCalls > 0) || !(i.refillPerS > 0)) return null;
  const spread = (i.players * i.perPlayerCalls - i.burst - i.marginCalls) / i.refillPerS;
  return spread > 0 ? spread : null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────── the gate's lowest level

/** The lowest bucket level any gate decision saw, read from the server's log (`seat-line: gate decision`, field `tokens`). `decisions` is how
 *  many carried a level: zero is a run that looked at nothing, and the caller owes a failure for it (a null min proves nothing). A decision with
 *  no `tokens` field (an older build) is not counted. */
export function gateLevels(lines: readonly string[]): { decisions: number; min: number | null } {
  let decisions = 0;
  let min: number | null = null;
  for (const l of lines) {
    if (!l.includes("seat-line: gate decision")) continue;
    const m = /"tokens"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(l);
    if (!m) continue;
    const v = Number(m[1]);
    decisions += 1;
    if (min === null || v < min) min = v;
  }
  return { decisions, min };
}

// ──────────────────────────────────────────────────────────────────────────────────────────── presence webhooks (LOAD_WEBHOOKS)

/** What the fixture recorded of the webhooks it emitted, reduced to what the end-of-run presence checks need. `webhooks` is the fixture's own
 *  `video.webhooks` and `outcomes` its `video.webhookOutcomes` (read after `webhooksSettled()`); the shape is structural so this file need not
 *  import the fixture. `pending` is what is left once delivered, failed and down are taken out: a webhook with no recorded outcome, or one
 *  still "pending", is never counted delivered. `leftPeers` are the DISTINCT (meeting, peer) pairs of the participantLeft webhooks that were
 *  DELIVERED (a failed leave owes no closed row); `meetingIds` every meeting a webhook named, delivered or not (the scope of the table reads). */
export type WebhookDigest = {
  emitted: number;
  delivered: number;
  failed: number;
  down: number;
  deliveredUuids: string[];
  leftPeers: { meetingId: string; peerId: string }[];
  meetingIds: string[];
};

export function webhookDigest(
  webhooks: readonly { uuid: string; event: string; body: string }[],
  outcomes: ReadonlyMap<string, string>,
): WebhookDigest {
  const deliveredUuids: string[] = [];
  const leftPeers = new Map<string, { meetingId: string; peerId: string }>();
  const meetingIds = new Set<string>();
  let failed = 0;
  let down = 0;
  for (const w of webhooks) {
    const parsed = JSON.parse(w.body) as { meeting?: { id?: unknown }; participant?: { peerId?: unknown } };
    const meetingId = parsed.meeting?.id;
    if (typeof meetingId === "string") meetingIds.add(meetingId);
    const outcome = outcomes.get(w.uuid);
    if (outcome === "failed") failed += 1;
    else if (outcome === "down") down += 1;
    if (outcome !== "delivered") continue;
    deliveredUuids.push(w.uuid);
    if (w.event !== "meeting.participantLeft") continue;
    const peerId = parsed.participant?.peerId;
    if (typeof meetingId !== "string" || typeof peerId !== "string") {
      throw new Error(`webhookDigest: a delivered participantLeft (${w.uuid}) names no meeting or no peer`);
    }
    leftPeers.set(`${meetingId}|${peerId}`, { meetingId, peerId });
  }
  return {
    emitted: webhooks.length,
    delivered: deliveredUuids.length,
    failed,
    down,
    deliveredUuids,
    leftPeers: [...leftPeers.values()],
    meetingIds: [...meetingIds],
  };
}

/** The LOAD_WEBHOOKS knob: "1" on, "0" or unset (or empty, like every other knob here) off. Anything else ("true", "yes", "on") THROWS: a typo that
 *  silently ran the baseline would report a green run that measured no presence at all. */
export function parseWebhooksKnob(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`LOAD_WEBHOOKS=${raw} is not "0" or "1"`);
}

/** The end-of-run verdict of a `LOAD_WEBHOOKS=1` run, as failure messages (empty = green); without the knob nothing is asserted (the baseline
 *  delivers none). `allEnded`: every meeting of the run has ended - only then is an open presence row a phantom, so `openRows` (rows still open
 *  for the run's fixtures) is judged only when it is true; a run that did not end them (a non-STRICT scenario) says so by name instead of
 *  reporting phantoms. `leftClosed`: how many of `digest.leftPeers` have their row closed with left_by='left'; `recorded`: how many of
 *  `digest.deliveredUuids` are in realtimekit_webhook_deliveries; each of the three table counts is null when its read failed (the caller has
 *  recorded that failure by name, and a count that was never read is never compared). `shadowVerified`: the shadow report's verified seats
 *  (null = not read); zero means the coverage check looked at nothing. A check that looked at nothing (no delivery, no delivered leave) is a
 *  failure, never a pass. */
export function webhookVerdict(c: {
  enabled: boolean;
  digest: WebhookDigest;
  allEnded: boolean;
  openRows: number | null;
  leftClosed: number | null;
  recorded: number | null;
  shadowVerified?: number | null;
}): string[] {
  if (!c.enabled) return [];
  const d = c.digest;
  const out: string[] = [];
  if (d.delivered === 0) out.push(`LOAD_WEBHOOKS=1 delivered 0 of ${d.emitted} emitted webhooks: an inert run (the fixture's deliverer never reached the server)`);
  if (d.failed > 0) out.push(`${d.failed} webhook(s) failed delivery`);
  if (d.down > 0) out.push(`${d.down} webhook(s) were recorded down (emitted, never delivered)`);
  const pending = d.emitted - d.delivered - d.failed - d.down;
  if (pending !== 0) out.push(`${pending} webhook(s) never settled (neither delivered, failed nor down)`);
  if (!c.allEnded) out.push("meetings not all ended: the open-presence-row check was skipped (an open row is a phantom only once its meeting has ended)");
  else if (c.openRows !== null && c.openRows > 0) out.push(`${c.openRows} presence row(s) still open after every meeting ended (phantom peers)`);
  if (d.leftPeers.length === 0) out.push("no participantLeft was delivered: the left_by check looked at nothing");
  else if (c.leftClosed !== null && c.leftClosed !== d.leftPeers.length) out.push(`${c.leftClosed} of ${d.leftPeers.length} delivered participantLeft webhooks have their row closed with left_by='left'`);
  if (c.recorded !== null && c.recorded !== d.deliveredUuids.length) out.push(`${c.recorded} of ${d.deliveredUuids.length} delivered webhooks are in realtimekit_webhook_deliveries`);
  if (c.shadowVerified === 0) out.push("the shadow report verified 0 seats: its coverage check looked at nothing");
  return out;
}
