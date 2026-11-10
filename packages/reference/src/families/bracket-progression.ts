// Reference family `bracket-progression` (W4 app B, Task 14; design §6.4): the knockout family's draw, late entry, plate
// field, lucky loser, final ranks and ladder seats, in the signed rulebook's terms
// (docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md, rows RB4-*).
//
// Written FROM THE RULEBOOK by an agent that read no engine source (R8): the engine is not imported at all, not even a
// type. Pure functions. It is never a second bracket generator: `draw` answers the first-round slot order, not a fixture
// graph; `ranks` and `ladderSeats` answer the places a finished result implies. Where the rows are silent it throws
// (R6) — `ProgressionRuledOut` for an input the rows exclude, `ProgressionOutOfScope` for one they leave to later work —
// naming the row; it never guesses. (These are this family's own classes: bracket-finish's reasons are a closed table of
// its own rows.)
//
// Rulings this file takes where a row leaves a choice, each flagged where it is used:
//  - seeds must be exactly 1..k (RB4-D1 places "seeded entrants by the fold"; a gapped list is silent → refused);
//  - the unseeded are shuffled with mulberry32 (RB4-D4 names it) and a Fisher-Yates walk; the row says only "a seeded
//    shuffle that replays", so a consumer compares properties of the shuffle, never an exact order;
//  - the four semi-finalists hold places 1..4 whatever the shape (shared 3rd leaves 4th empty, a play-off neither side
//    played leaves 3rd empty), so the entrants below start at 5th (RB4-R2 "below the semi-finals").

export type EntrantKey = string;

export const PROGRESSION_RULED_OUT = {
  "too-few-entrants": "RB4-E1 / E2: a knockout needs at least 2 entrants; it never answers an empty bracket",
  "seed-list": "RB4-D1: seeds are 1..k with no gap and no repeat; the rows are silent on any other list",
  "no-lines": "RB4-L1: late entry reads the round-1 lines of an entry stage; a bracket with none has no case",
  "line-position": "RB4-L3 … L7: each round-1 line is one position; two lines at one position are not a bracket",
  "playoff-needs-four": "RB4-T4 / E5: a third-place play-off needs two real semi-finals (a bracket of at least 4)",
  "playoff-under-shared": "RB4-T1 / T2: a play-off result under Third place Shared is a different stage setting",
  "playoff-undecided": "RB4-T3: a stage with a play-off is not complete until it is decided or settled",
  "entrant-repeat": "RB4-R1: every entrant appears exactly once in the final ranks",
  "semi-count": "RB4-T2 / E5: a completed bracket has 0, 1 or 2 semi-final losers",
  "playoff-sides": "RB4-T3: a play-off is between the two semi-final losers",
  "ladder-size": "RB4-S1 / S2: a stepladder needs k >= 2 seeds; a page playoff exactly 4",
  "ladder-withdrawn": "RB4-S3: a withdrawn entrant must be one of the ladder's seeds",
  "ladder-undecided": "RB4-S1 / S2: a match between two present entrants needs a decided result to go on",
} as const;
export type ProgressionRuledOutReason = keyof typeof PROGRESSION_RULED_OUT;

export class ProgressionRuledOut extends Error {
  readonly reason: ProgressionRuledOutReason;
  constructor(reason: ProgressionRuledOutReason, detail: string) {
    super(`bracket-progression: ${detail} (${PROGRESSION_RULED_OUT[reason]})`);
    this.name = "RuledOut";
    this.reason = reason;
  }
}

export const PROGRESSION_OUT_OF_SCOPE = {
  "ladder-rung-one-double-walkover": "RB4-S3 / S4: both sides of a stepladder's first rung out leaves no climber, and S4's one-loser-per-rung ranking is silent on it",
  "page-playoff-two-withdrawn": "RB4-S5: only one withdrawn entrant is ruled; where two leave, the order of their last places is silent",
} as const;
export type ProgressionOutOfScopeReason = keyof typeof PROGRESSION_OUT_OF_SCOPE;

export class ProgressionOutOfScope extends Error {
  readonly reason: ProgressionOutOfScopeReason;
  constructor(reason: ProgressionOutOfScopeReason) {
    super(`bracket-progression: out of scope (${reason}): ${PROGRESSION_OUT_OF_SCOPE[reason]}`);
    this.name = "OutOfScope";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// draw — RB4-D1, D2, D3, D4, D5 (D6 is API-only; D7, D8 and E8 are DEFERRED by ruling 272)
// ---------------------------------------------------------------------------------------------------------------------

/** 32-bit multiply without a global (the boundary gate bans `Math`; this is the standard polyfill). */
function imul(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff;
  const al = a & 0xffff;
  const bh = (b >>> 16) & 0xffff;
  const bl = b & 0xffff;
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

/** RB4-D4 names `mulberry32`: the same seed, the same stream. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = imul(a ^ (a >>> 15), 1 | a);
    t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher-Yates walk: replays from the seed alone. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = (next() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The standard fold (RB4-D1: "1 top, 2 bottom, 3-4 and onward by the standard fold"): the seed number at each round-1
 * position, so that the seeds meeting in round r sum to 2^r + 1. Built by doubling, each seed s of the half-size list
 * putting its complement (2m + 1 - s) beside it, the order alternating down the list so seed 2 lands in the LAST position
 * (size 8: 1v8, 4v5, 3v6, 7v2 — the classic draw sheet; size 16: 1v16, 9v8, 5v12, 13v4, 3v14, 11v6, 7v10, 15v2).
 */
function fold(size: number): number[] {
  let p = [1, 2];
  while (p.length < size) {
    const m = p.length * 2;
    p = p.flatMap((s, i) => (i % 2 === 0 ? [s, m + 1 - s] : [m + 1 - s, s]));
  }
  return p.slice(0, size);
}

export interface DrawAnswer {
  /** The bracket's round-1 positions: 2 per match. */
  readonly size: number;
  /** Entrants in the seed number the draw gave them (1..n): the seeded first, then the unseeded as drawn. */
  readonly order: readonly EntrantKey[];
  /** The entrant at each round-1 position, `null` a bye line (RB4-D2: a bye is an award, never a fixture). */
  readonly slots: readonly (EntrantKey | null)[];
  /** Whose opponent is a bye, in seed order. */
  readonly byeHolders: readonly EntrantKey[];
}

function draw(entrants: readonly EntrantKey[], seeds: ReadonlyMap<EntrantKey, number>, drawSeed: number): DrawAnswer {
  const n = entrants.length;
  if (n < 2) throw new ProgressionRuledOut("too-few-entrants", `${n} entrant${n === 1 ? "" : "s"}`);
  const seeded = entrants.filter((e) => seeds.has(e)).sort((a, b) => seeds.get(a)! - seeds.get(b)!);
  seeded.forEach((e, i) => {
    if (seeds.get(e) !== i + 1) throw new ProgressionRuledOut("seed-list", `seeds ${seeded.map((s) => seeds.get(s)).join(",")} are not 1..${seeded.length}`);
  });
  const order = [...seeded, ...shuffled(entrants.filter((e) => !seeds.has(e)), drawSeed)];
  let size = 2;
  while (size < n) size *= 2;
  const slots = fold(size).map((s) => (s <= n ? order[s - 1]! : null));
  // A bye line is the position of a seed number above n; its opposite number is the holder.
  const byeHolders: EntrantKey[] = [];
  for (let i = 0; i < size; i += 2) {
    const [a, b] = [slots[i] ?? null, slots[i + 1] ?? null];
    if ((a === null) !== (b === null)) byeHolders.push((a ?? b)!);
  }
  byeHolders.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return { size, order, slots, byeHolders };
}

// ---------------------------------------------------------------------------------------------------------------------
// lateEntryCase — RB4-L3 … L8
// ---------------------------------------------------------------------------------------------------------------------

/** One round-1 line of the entry stage, in the rulebook's terms. */
export type LateLine =
  | { kind: "bye"; position: number; seed: number | null; /** the holder has started their round-2 match */ holderStarted: boolean }
  | { kind: "withdrawn"; position: number; /** the slot's first match, or the walkover winner's next match, has started */ started: boolean }
  | { kind: "played"; position: number };

export type LateEntryCase = { case: "bye"; position: number } | { case: "withdrawn_slot"; position: number } | { case: "refused" } | { case: "rebuild_offered" };

/**
 * RB4-L3 (a bye whose holder has not started round 2 is reversed), L4 (several: the LOWEST-seeded holder, ties by draw
 * position, an unseeded holder lowest of all), L5 (else a withdrawn slot before its first match), L6 (else refused; Rebuild
 * is offered while nothing in the stage has started — `started` is the stage-level K4 predicate, RB4-L9), L8 (a stepladder
 * or page playoff takes case (2) only). RB4-L7 — a late entrant never joins round 2 — holds by the input's type: lines are
 * round-1 lines.
 */
function lateEntryCase(lines: readonly LateLine[], started: boolean, stageKind: "knockout" | "stepladder" | "page_playoff" = "knockout"): LateEntryCase {
  if (lines.length === 0) throw new ProgressionRuledOut("no-lines", "no round-1 lines");
  if (new Set(lines.map((l) => l.position)).size !== lines.length) throw new ProgressionRuledOut("line-position", "two lines share a position");
  if (stageKind === "knockout") {
    const open = lines.filter((l): l is Extract<LateLine, { kind: "bye" }> => l.kind === "bye" && !l.holderStarted);
    if (open.length > 0) {
      const rankOf = (l: Extract<LateLine, { kind: "bye" }>) => l.seed ?? Number.POSITIVE_INFINITY;
      const lowest = [...open].sort((a, b) => rankOf(b) - rankOf(a) || a.position - b.position)[0]!;
      return { case: "bye", position: lowest.position };
    }
  }
  const slot = lines.filter((l) => l.kind === "withdrawn" && !l.started).sort((a, b) => a.position - b.position)[0];
  if (slot) return { case: "withdrawn_slot", position: slot.position };
  return started ? { case: "refused" } : { case: "rebuild_offered" };
}

// ---------------------------------------------------------------------------------------------------------------------
// plateField — RB4-P1, P2, P3, E6
// ---------------------------------------------------------------------------------------------------------------------

/** An entrant's FIRST match: what happened in it. A bye is not a match, and neither is a win by walkover — an entrant who
 *  reached round 2 "by a bye or default" has their round-2 match as the first (A4, RB4-P1). `pending`: that match is not
 *  played yet, or not yet seated. */
export interface FirstMatch {
  entrant: EntrantKey;
  /** 0-based round of the first match. */
  round: number;
  /** Position within the round. */
  position: number;
  result: "won" | "lost" | "lost_by_forfeit" | "pending";
}
export interface PlateFieldAnswer {
  /** The main draw exists and no first match is pending: the field is final (RB4-P3). */
  complete: boolean;
  /** `field`: the plate has its entrants; `waiting`: a first match is still to play (or no draw yet); `not_enough`: a complete field under 2 (RB4-E6). */
  outcome: "field" | "waiting" | "not_enough";
  losers: EntrantKey[];
  excluded: EntrantKey[];
  pending: EntrantKey[];
}

function plateField(results: readonly FirstMatch[]): PlateFieldAnswer {
  const byPlace = [...results].sort((a, b) => a.round - b.round || a.position - b.position);
  const losers = byPlace.filter((r) => r.result === "lost").map((r) => r.entrant);
  const excluded = byPlace.filter((r) => r.result === "lost_by_forfeit").map((r) => r.entrant); // RB4-P2: a disqualification is a withdrawal
  const pending = byPlace.filter((r) => r.result === "pending").map((r) => r.entrant);
  const complete = results.length > 0 && pending.length === 0;
  const outcome = !complete ? "waiting" : losers.length < 2 ? "not_enough" : "field";
  return { complete, outcome, losers, excluded, pending };
}

// ---------------------------------------------------------------------------------------------------------------------
// luckyLoser — RB4-V2, V3, V5, E7
// ---------------------------------------------------------------------------------------------------------------------

export interface LuckyCandidate {
  entrant: EntrantKey;
  /** Final rank in the qualifying stage (below the cut). */
  rank: number;
  seed: number | null;
  lostBy: "play" | "walkover" | "withdrawal" | "disqualification";
}
export type LuckyAnswer = { kind: "lucky_loser"; entrant: EntrantKey } | { kind: "walkover" };

/**
 * RB4-V2: the highest-ranked eligible qualifying entrant below the cut, ties by seed (an unseeded entrant after every
 * seed), then random by the DESTINATION stage's draw seed (V5). V5: a loser by walkover, withdrawal or disqualification is
 * not eligible. V3 / E7: once the qualifier's first main-draw match has started, or with no eligible entrant, the vacancy
 * walks over.
 */
function luckyLoser(pool: readonly LuckyCandidate[], drawSeed: number, qualifierStarted: boolean): LuckyAnswer {
  if (qualifierStarted) return { kind: "walkover" };
  const eligible = pool.filter((c) => c.lostBy === "play");
  if (eligible.length === 0) return { kind: "walkover" };
  const key = (c: LuckyCandidate) => [c.rank, c.seed ?? Number.POSITIVE_INFINITY] as const;
  const best = [...eligible].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  const top = best.filter((c) => key(c)[0] === key(best[0]!)[0] && key(c)[1] === key(best[0]!)[1]);
  // The tie is broken at random, replayably: sort the tied by id first so the walk does not depend on pool order.
  const tied = top.map((c) => c.entrant).sort();
  return { kind: "lucky_loser", entrant: shuffled(tied, drawSeed)[0]! };
}

// ---------------------------------------------------------------------------------------------------------------------
// ranks — RB4-T2, T3, T4, T6, C1, C3, C4, R1, R2
// ---------------------------------------------------------------------------------------------------------------------

export type RankTitle =
  | { kind: "champion"; champion: EntrantKey; runnerUp: EntrantKey }
  | { kind: "joint"; winners: readonly [EntrantKey, EntrantKey] }
  | { kind: "vacant"; finalists: readonly [EntrantKey, EntrantKey] };
export type PlayoffResult = { kind: "decided"; winner: EntrantKey; loser: EntrantKey } | { kind: "walkover"; winner: EntrantKey; loser: EntrantKey } | { kind: "both_out" };
export interface RankInput {
  thirdPlace: "shared" | "playoff";
  title: RankTitle;
  /** The semi-final losers: none (two entrants), one (three: the other semi is a bye), or two. */
  semiLosers: readonly EntrantKey[];
  /** The third-place match's outcome, only under `playoff` with two semi-final losers. */
  playoff?: PlayoffResult;
  /** Everyone else, with the (0-based) round they were eliminated in and their seed. */
  others: readonly { entrant: EntrantKey; eliminatedRound: number; seed: number | null }[];
}
export interface Place {
  entrant: EntrantKey;
  rank: number;
}

function ranks(input: RankInput): Place[] {
  const { title, thirdPlace, semiLosers, playoff, others } = input;
  const finalists = title.kind === "champion" ? [title.champion, title.runnerUp] : title.kind === "joint" ? [...title.winners] : [...title.finalists];
  const everyone = [...finalists, ...semiLosers, ...others.map((o) => o.entrant)];
  if (new Set(everyone).size !== everyone.length) throw new ProgressionRuledOut("entrant-repeat", "an entrant is named twice");
  if (semiLosers.length > 2) throw new ProgressionRuledOut("semi-count", `${semiLosers.length} semi-final losers`);
  if (thirdPlace === "playoff" && semiLosers.length < 2) throw new ProgressionRuledOut("playoff-needs-four", `${semiLosers.length} semi-final losers`);
  if (thirdPlace === "shared" && playoff) throw new ProgressionRuledOut("playoff-under-shared", "a play-off result was given");
  if (thirdPlace === "playoff" && !playoff) throw new ProgressionRuledOut("playoff-undecided", "no play-off result");
  if (playoff && playoff.kind !== "both_out" && !(semiLosers.includes(playoff.winner) && semiLosers.includes(playoff.loser) && playoff.winner !== playoff.loser)) {
    throw new ProgressionRuledOut("playoff-sides", "the play-off sides are not the two semi-final losers");
  }
  const out: Place[] = [];
  // Title (RB4-C1, C3, C4): positions 1 and 2.
  if (title.kind === "champion") out.push({ entrant: title.champion, rank: 1 }, { entrant: title.runnerUp, rank: 2 });
  else if (title.kind === "joint") out.push({ entrant: title.winners[0], rank: 1 }, { entrant: title.winners[1], rank: 1 });
  else out.push({ entrant: title.finalists[0], rank: 2 }, { entrant: title.finalists[1], rank: 2 });
  // Third place (RB4-T2, T3, T6; E5): positions 3 and 4.
  if (semiLosers.length === 1) out.push({ entrant: semiLosers[0]!, rank: 3 });
  else if (semiLosers.length === 2) {
    if (thirdPlace === "shared") out.push({ entrant: semiLosers[0]!, rank: 3 }, { entrant: semiLosers[1]!, rank: 3 });
    else if (playoff!.kind === "both_out") out.push({ entrant: semiLosers[0]!, rank: 4 }, { entrant: semiLosers[1]!, rank: 4 });
    else out.push({ entrant: playoff!.winner, rank: 3 }, { entrant: playoff!.loser, rank: 4 });
  }
  // Below the semi-finals (RB4-R2): strict — a later elimination round first, then the better seed (unseeded after every
  // seed), then the entrant id.
  const below = [...others].sort(
    (a, b) => b.eliminatedRound - a.eliminatedRound || (a.seed ?? Number.POSITIVE_INFINITY) - (b.seed ?? Number.POSITIVE_INFINITY) || (a.entrant < b.entrant ? -1 : a.entrant > b.entrant ? 1 : 0),
  );
  const first = 3 + semiLosers.length;
  below.forEach((o, i) => out.push({ entrant: o.entrant, rank: first + i }));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// ladderSeats — RB4-S1 … S5
// ---------------------------------------------------------------------------------------------------------------------

export type LadderDecision = "home" | "away";
export interface LadderInput {
  kind: "stepladder" | "page_playoff";
  /** Entrants in seed order, seed 1 first. */
  seeds: readonly EntrantKey[];
  /** Entrants out before their next match begins: any match they are in is walked over to the other side (RB4-S3). */
  withdrawn: readonly EntrantKey[];
  /** The winning side of each match between two PRESENT entrants: a stepladder's by rung number (1..k-1), a page playoff's by label (Q1, E, Q2, F). A walked-over match ignores its entry. */
  decide: Readonly<Record<string, LadderDecision>>;
}
export interface LadderMatch {
  label: string;
  home: EntrantKey;
  away: EntrantKey;
  /** The side that WALKED OVER the other (the other withdrew), else null. */
  walkover: LadderDecision | null;
  winner: EntrantKey;
  loser: EntrantKey;
}
export interface LadderAnswer {
  matches: LadderMatch[];
  ranks: Place[];
}

function ladderSeats(input: LadderInput): LadderAnswer {
  const { kind, seeds, withdrawn, decide } = input;
  const k = seeds.length;
  if (kind === "stepladder" ? k < 2 : k !== 4) throw new ProgressionRuledOut("ladder-size", `${kind} of ${k} seeds`);
  for (const w of withdrawn) if (!seeds.includes(w)) throw new ProgressionRuledOut("ladder-withdrawn", `${w} is not a seed`);
  const out = new Set(withdrawn);
  const play = (label: string, home: EntrantKey, away: EntrantKey): LadderMatch => {
    if (out.has(home) && out.has(away)) throw new ProgressionOutOfScope("ladder-rung-one-double-walkover");
    if (out.has(home)) return { label, home, away, walkover: "away", winner: away, loser: home };
    if (out.has(away)) return { label, home, away, walkover: "home", winner: home, loser: away };
    const d = decide[label];
    if (d === undefined) throw new ProgressionRuledOut("ladder-undecided", `match ${label} (${home} v ${away})`);
    return { label, home, away, walkover: null, winner: d === "home" ? home : away, loser: d === "home" ? away : home };
  };
  const matches: LadderMatch[] = [];
  if (kind === "stepladder") {
    // RB4-S1: the lowest two first; each winner meets the next seed up; the last rung is against seed 1.
    let climber = seeds[k - 1]!;
    for (let j = 1; j < k; j++) {
      const m = play(String(j), seeds[k - 1 - j]!, climber);
      matches.push(m);
      climber = m.winner;
    }
    // RB4-S4: the loser of rung j is 1 + (k - j)th; a withdrawn seed is the loser of the rung it was due to enter.
    const places: Place[] = [{ entrant: climber, rank: 1 }];
    matches.forEach((m, i) => places.push({ entrant: m.loser, rank: k - i }));
    return { matches, ranks: places };
  }
  // RB4-S2 / S5: page playoff.
  if (out.size > 1) throw new ProgressionOutOfScope("page-playoff-two-withdrawn");
  const q1 = play("Q1", seeds[0]!, seeds[1]!);
  const e = play("E", seeds[2]!, seeds[3]!);
  const q2 = play("Q2", q1.loser, e.winner); // the loser edge: a withdrawn Q1 loser has no second life (S5)
  const f = play("F", q1.winner, q2.winner);
  matches.push(q1, e, q2, f);
  // Final, then Q2's loser (3rd), then E's loser (4th); a withdrawn entrant ranks below everyone still in the stage (S5).
  const order = [f.winner, f.loser, q2.loser, e.loser];
  const staying = order.filter((x) => !out.has(x));
  const gone = order.filter((x) => out.has(x));
  return { matches, ranks: [...staying, ...gone].map((entrant, i) => ({ entrant, rank: i + 1 })) };
}

export const bracketProgression = { draw, lateEntryCase, plateField, luckyLoser, ranks, ladderSeats } as const;
export type BracketProgressionFamily = typeof bracketProgression;
