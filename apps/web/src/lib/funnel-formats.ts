// The /start funnel's formats (start-wizard redesign, 2026-11-13): ONE layer for what each format card counts, which
// card wears Best fit (`rankFormats` / `bestFitSlug`, lib/format-recommend.ts) and the stages the emailed claim builds
// (lib/funnel.ts `createFromDraft`), so the card the organiser picked and the event they land on cannot disagree.
//
// Every count below is read off the SAME knobs the stage graph is built at (`funnelFormatKnobs`), never a second model;
// lib/__tests__/funnel-formats.test.ts proves each against the engine's own draw, round by round.
//
// Pure and client-safe: format-templates.ts, format-bounds.ts and swiss-rounds.ts, each importable by the client.
import { buildTemplateStages, clampKnob, type StageDraft, type TemplateKnobs } from "./format-templates";
import { FORMAT_BOUNDS } from "./format-bounds";
import { swissRoundsGuidance } from "./swiss-rounds";

/** The four cards, in the order the page shows them (fixed: no reordering under the thumb, plan D2). */
export const FUNNEL_FORMATS = ["league", "groups-knockout", "knockout", "swiss"] as const;
/** Behind "More formats". Ladder is not offered: it is a `formats.advanced` kind, so a free claim would be refused. */
export const FUNNEL_MORE_FORMATS = ["double_elim"] as const;
export type FunnelFormat = (typeof FUNNEL_FORMATS)[number] | (typeof FUNNEL_MORE_FORMATS)[number];

const ALL: readonly string[] = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];

/** The one-click template (lib/format-templates.ts STAGE_TEMPLATES) each format builds. */
const TEMPLATE_KEY: Record<FunnelFormat, string> = {
  league: "league",
  "groups-knockout": "groups_ko",
  knockout: "knockout",
  swiss: "swiss",
  double_elim: "double_elim",
};

/** The smallest field each format's graph can be drawn for. Groups + knockout needs two pools of two: a third entrant
 *  in two pools leaves one alone, which the first group draw refuses (C38, `group_too_few_entrants`). Every other format
 *  draws from two (the Swiss and the brackets refuse only a field under two). Pinned against the engine's draw, n 2..64,
 *  and against the house's size gate (`stageGraphSizeGate`) in the test. */
const MIN_FIELD: Record<FunnelFormat, number> = {
  league: 2,
  "groups-knockout": 4,
  knockout: 2,
  swiss: 2,
  double_elim: 2,
};

export function isFunnelFormat(x: unknown): x is FunnelFormat {
  return typeof x === "string" && ALL.includes(x);
}

/** The smallest field the claim can build `f` for. */
export function funnelFormatMin(f: FunnelFormat): number {
  assertFormat(f);
  return MIN_FIELD[f];
}

/**
 * The knobs `f`'s template is built at for a field of `n`. One set for every format (each template reads only its own):
 * - pools: about four to a pool, at least two pools, within FORMAT_BOUNDS.pools;
 * - qualified: the top two of every pool, within FORMAT_BOUNDS.qualify and never more than the field;
 * - Swiss rounds: the house's recommendation for the field (`swissRoundsGuidance(n).recommended`: the owner's band table
 *   in swiss-rounds.ts, capped at the rulebook's SAFE maximum ⌊n/2⌋), so the claimed Swiss plays what its Rules card
 *   recommends, and every round is guaranteed to pair;
 * - legs: once.
 */
export function funnelFormatKnobs(f: FunnelFormat, n: number): TemplateKnobs {
  assertFormat(f);
  assertField(n);
  const poolCount = clampKnob(Math.max(2, Math.ceil(n / 4)), FORMAT_BOUNDS.pools.min, FORMAT_BOUNDS.pools.max);
  const qualified = Math.min(clampKnob(2 * poolCount, FORMAT_BOUNDS.qualify.min, FORMAT_BOUNDS.qualify.max), n);
  const swissRounds = swissRoundsGuidance(n).recommended;
  return { qualified, swissRounds, poolCount, legs: 1 };
}

/** The stages the claim builds for `f` at `n` (seq is the caller's). Refused below the format's minimum: a graph the
 *  first draw would refuse is never built. */
export function funnelFormatStages(f: FunnelFormat, n: number): StageDraft[] {
  const knobs = funnelFormatKnobs(f, n);
  if (n < MIN_FIELD[f]) throw new RangeError(`${f} needs at least ${MIN_FIELD[f]} entrants (got ${n})`);
  return buildTemplateStages(TEMPLATE_KEY[f], knobs);
}

/** Matches per round of a round robin over `n` split into `pools` pools (one pool = a league), played in parallel: the
 *  pools are as even as the draw makes them (sizes differ by at most one); a pool of s plays s − 1 rounds (s even) or s
 *  (odd, one sits out each round) of ⌊s/2⌋ matches. */
function roundRobinRounds(n: number, pools: number, legs: number): number[] {
  const small = Math.floor(n / pools);
  const sizes = [small, small + 1];
  const count = [pools - (n % pools), n % pools];
  const roundsOf = (s: number) => (s < 2 ? 0 : s % 2 === 0 ? s - 1 : s);
  const leg: number[] = [];
  const total = Math.max(roundsOf(sizes[0]!), count[1]! > 0 ? roundsOf(sizes[1]!) : 0);
  for (let r = 1; r <= total; r++) {
    let matches = 0;
    for (const i of [0, 1]) if (count[i]! > 0 && r <= roundsOf(sizes[i]!)) matches += count[i]! * Math.floor(sizes[i]! / 2);
    leg.push(matches);
  }
  return Array.from({ length: legs }, () => leg).flat();
}

/** A single-elimination bracket over `n`, padded to the next power of two B: round one plays n − B/2 (the top seeds'
 *  byes are not matches), then B/4, B/8 … 1. */
function bracketRounds(n: number): number[] {
  const size = 2 ** Math.ceil(Math.log2(n));
  const rounds = [n - size / 2];
  for (let m = size / 4; m >= 1; m /= 2) rounds.push(m);
  return rounds;
}

/** A double-elimination bracket over `n` in the engine's round order: the winners' bracket (as `bracketRounds`), the
 *  losers' bracket, the final (drawn once: no reset). Losers' round one pairs round one's losers, so it plays only what
 *  B/4 boards cannot absorb as walkovers (max(0, r1 − B/4)); round two meets each of round two's losers against a
 *  round-one survivor (min(r1, B/4)); then two rounds of each B/8 … 1. */
function doubleElimRounds(n: number): number[] {
  const size = 2 ** Math.ceil(Math.log2(n));
  const winners = bracketRounds(n);
  const r1 = winners[0]!;
  const losers: number[] = [];
  if (size >= 4) {
    losers.push(Math.max(0, r1 - size / 4), Math.min(r1, size / 4));
    for (let m = size / 8; m >= 1; m /= 2) losers.push(m, m);
  }
  return [...winners, ...losers, 1];
}

/** Matches PLAYED in each round of `f`'s graph at `n`, in the order the rounds are played — a bracket's byes, its
 *  walkovers and a Swiss's bye are not matches. A round with nothing to play is a 0. */
export function funnelFormatRounds(f: FunnelFormat, n: number): number[] {
  const k = funnelFormatKnobs(f, n);
  switch (f) {
    case "league":
      return roundRobinRounds(n, 1, k.legs);
    case "groups-knockout":
      return [...roundRobinRounds(n, k.poolCount, k.legs), ...bracketRounds(k.qualified)];
    case "knockout":
      return bracketRounds(n);
    case "swiss":
      return Array.from({ length: k.swissRounds }, () => Math.floor(n / 2));
    case "double_elim":
      return doubleElimRounds(n);
  }
}

/** Matches PLAYED by `f`'s graph at `n`: the sum of its rounds. */
export function funnelFormatMatches(f: FunnelFormat, n: number): number {
  return funnelFormatRounds(f, n).reduce((sum, m) => sum + m, 0);
}

/** The fewest matches any entrant is sure to play — the "how much does everyone play" number Best fit ranks by: the whole
 *  league; a pool's round robin, plus a bracket match only for a pool small enough that all of it qualifies (the top
 *  ⌊qualified / pools⌋ of each go through); every Swiss round, less the round an odd field's bye sits out; one knockout
 *  match, two in double elimination. */
export function funnelFormatPerEntrant(f: FunnelFormat, n: number): number {
  const k = funnelFormatKnobs(f, n);
  switch (f) {
    case "league":
      return k.legs * (n - 1);
    case "groups-knockout": {
      const small = Math.floor(n / k.poolCount);
      const sizes = n % k.poolCount === 0 ? [small] : [small, small + 1];
      const throughPerPool = Math.floor(k.qualified / k.poolCount);
      return Math.min(...sizes.map((s) => k.legs * (s - 1) + (s <= throughPerPool ? 1 : 0)));
    }
    case "knockout":
      return 1;
    case "swiss":
      return k.swissRounds - (n % 2);
    case "double_elim":
      return 2;
  }
}

function assertFormat(f: string): asserts f is FunnelFormat {
  if (!isFunnelFormat(f)) throw new RangeError(`not a funnel format: ${String(f)}`);
}

function assertField(n: number): void {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`a funnel field is a whole number of at least 2 (got ${n})`);
}
