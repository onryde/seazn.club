// The /start funnel's formats (start-wizard redesign, 2026-11-13): ONE layer for what each format card counts, which
// card wears Best fit (`rankFormats` / `bestFitSlug`, lib/format-recommend.ts) and the stages the emailed claim builds
// (lib/funnel.ts `createFromDraft`), so the card the organiser picked and the event they land on cannot disagree.
//
// Every count below is read off the SAME knobs the stage graph is built at (`funnelFormatKnobs`), never a second model;
// lib/__tests__/funnel-formats.test.ts proves each against the engine's own draw.
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
 *  in the test. */
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

const ceilLog2 = (n: number): number => Math.ceil(Math.log2(Math.max(2, n)));

/**
 * The knobs `f`'s template is built at for a field of `n`. One set for every format (each template reads only its own):
 * - pools: about four to a pool, at least two pools, within FORMAT_BOUNDS.pools;
 * - qualified: the top two of every pool, within FORMAT_BOUNDS.qualify and never more than the field;
 * - Swiss rounds: ⌈log2 n⌉ + 1, within FORMAT_BOUNDS.swissRounds and never above the rulebook's SAFE maximum ⌊n/2⌋
 *   (rulebook-W3-swiss §3.1, `swissRoundsGuidance`): above it a rematch can be forced and the desk warns; the organiser
 *   who claims from the funnel never set the round count, so the claim stays where every round is guaranteed to pair.
 *   The hard maximum (n − 1, or n for an odd field), above which Start refuses, is therefore never reached either;
 * - legs: once.
 */
export function funnelFormatKnobs(f: FunnelFormat, n: number): TemplateKnobs {
  assertFormat(f);
  assertField(n);
  const poolCount = clampKnob(Math.max(2, Math.ceil(n / 4)), FORMAT_BOUNDS.pools.min, FORMAT_BOUNDS.pools.max);
  const qualified = Math.min(clampKnob(2 * poolCount, FORMAT_BOUNDS.qualify.min, FORMAT_BOUNDS.qualify.max), n);
  const swissRounds = Math.min(ceilLog2(n) + 1, FORMAT_BOUNDS.swissRounds.max, swissRoundsGuidance(n).safeMax);
  return { qualified, swissRounds, poolCount, legs: 1 };
}

/** The stages the claim builds for `f` at `n` (seq is the caller's). Refused below the format's minimum: a graph the
 *  first draw would refuse is never built. */
export function funnelFormatStages(f: FunnelFormat, n: number): StageDraft[] {
  const knobs = funnelFormatKnobs(f, n);
  if (n < MIN_FIELD[f]) throw new RangeError(`${f} needs at least ${MIN_FIELD[f]} entrants (got ${n})`);
  return buildTemplateStages(TEMPLATE_KEY[f], knobs);
}

const pairs = (k: number): number => (k * (k - 1)) / 2;

/** Matches a round robin over `n` split into `pools` pools plays: the pools are as even as the draw makes them (sizes
 *  differ by at most one). */
function poolMatches(n: number, pools: number): number {
  const size = Math.floor(n / pools);
  const larger = n % pools;
  return larger * pairs(size + 1) + (pools - larger) * pairs(size);
}

/** Matches PLAYED by `f`'s graph at `n` — a bracket's byes and a Swiss's bye are not matches. */
export function funnelFormatMatches(f: FunnelFormat, n: number): number {
  const k = funnelFormatKnobs(f, n);
  switch (f) {
    case "league":
      return k.legs * pairs(n);
    case "groups-knockout":
      return k.legs * poolMatches(n, k.poolCount) + (k.qualified - 1);
    case "knockout":
      return n - 1;
    case "swiss":
      return k.swissRounds * Math.floor(n / 2);
    case "double_elim":
      // Everyone but the champion loses twice; the champion's possible loss in the final is not drawn (no reset).
      return 2 * n - 2;
  }
}

/** Roughly how many matches an entrant plays — the "how much do people play" number Best fit ranks by: the whole league;
 *  a full pool plus a bracket match; every Swiss round; one knockout match, two in double elimination. */
export function funnelFormatPerEntrant(f: FunnelFormat, n: number): number {
  const k = funnelFormatKnobs(f, n);
  switch (f) {
    case "league":
      return k.legs * (n - 1);
    case "groups-knockout":
      return k.legs * (Math.ceil(n / k.poolCount) - 1) + 1;
    case "knockout":
      return 1;
    case "swiss":
      return k.swissRounds;
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
