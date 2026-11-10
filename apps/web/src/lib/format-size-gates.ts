// W4 app-A Task 15 (FX-G14's gate half, QM-2; rules X-PL-1, X-QM-2, X-QM-5; owner pick 5A): which fields a stage graph can be
// played on, read off the GRAPH rather than a template key, so a division built through the API is gated like one built in the
// builder. The server refuses at every door that draws the root (`refuseFormatTooSmall`, usecases/stages/swiss-gen.ts) and the builder shows the card
// disabled with the same reason (format-choice.ts); both ask this file. Pure and client-safe.
import type { KnockoutRefusalCode } from "@/lib/knockout-refusals";

/** X-PL-1 (spec §5.1): a plate needs two round-one losers to play, so a field of 4 (a field of 3 has one). */
export const PLATE_MIN = 4;

/** X-QM-5: the smallest field from which qualifying_main completes at the q the builder sends (4, format-choice.ts), named by the
 *  driving sweep (qualifying-main-sizes.test.ts): 2 and 3 play the whole qualifying stage and then fail at Complete, "the previous
 *  stage takes rank 4, but only 3 entrants are available"; every n from 4 to 17 completes. In general a cut needs a field that fills
 *  it, and the graph's own read below says so for an API-built q.
 *
 *  A PINNED FACT for the builder's template pin and the tests, NOT what enforcement reads: `stageGraphSizeGate` takes its bound from
 *  the stored cut's own `rule.to`, so a q of 2 runs on 2 and a q of 8 is refused below 8 whatever this says. It equals `rule.to` at
 *  the builder's q (4) and is pinned against it: that pin is what keeps the two from drifting apart unseen. */
export const QUALIFYING_MAIN_MIN = 4;

/** T26c fix round 1 (I1, controller ruling 2026-11-09): a page playoff's own size. It seats exactly four (Q1 1 v 2, the
 *  Eliminator 3 v 4, then Q2 and the final; the engine's `generatePagePlayoff` refuses any other count), so a page playoff fed
 *  from a smaller field has a seat no stage can fill — and that seat's lines took a time and a court. Pinned against the engine's
 *  generator in lib/__tests__/format-size-gates.test.ts (the one place it is read from, client bundles kept off the engine). */
export const PAGE_PLAYOFF_SIZE = 4;

export interface StageGraphStage {
  /** Absent on a template's drafts: they only name their source as `previous`. */
  id?: string;
  kind: string;
  progression: unknown;
}

export interface SizeRefusal {
  code: KnockoutRefusalCode;
  min: number;
}

interface TakeShape {
  kind?: unknown;
  to?: unknown;
}

interface SourceShape {
  stage?: unknown;
  take?: readonly TakeShape[];
}

/** The stage a progression source names, in `stages` (seq order): the one before for `previous`, else by id. */
function sourceOf(stages: readonly StageGraphStage[], at: number, stage: unknown): StageGraphStage | undefined {
  if (stage === "previous") return stages[at - 1];
  const id = (stage as { stageId?: unknown } | null | undefined)?.stageId;
  return typeof id === "string" ? stages.find((s) => s.id === id) : undefined;
}

/** What `stages` (in seq order) refuses a field of `n` for, or null. EMPTY CASE FIRST: no stages, nothing to refuse. Only a ROOT
 *  knockout's feed is sized here: a fed knockout's losers depend on the feed, and a table ranks everyone it has. The one
 *  exception is a fed page playoff, whose size is its own (`PAGE_PLAYOFF_SIZE`), wherever it is fed from. Where several rules
 *  apply the larger bound is the one that says what would fix it. */
export function stageGraphSizeGate(stages: readonly StageGraphStage[], n: number): SizeRefusal | null {
  let gate: SizeRefusal | null = null;
  const needs = (code: KnockoutRefusalCode, min: number) => {
    if (gate === null || min > gate.min) gate = { code, min };
  };
  stages.forEach((stage, at) => {
    // A FED page playoff (group_playoffs, swiss_playoff, an API-built one) seats PAGE_PLAYOFF_SIZE from what it is fed, and no
    // stage ranks more entrants than the field holds. A standalone (legacy) one is not this rule's: its own Generate draws the
    // field it has, and the engine refuses any count but four by name.
    if (stage.kind === "page_playoff" && (stage.progression ?? null) !== null) needs("PAGE_PLAYOFF_TOO_FEW", PAGE_PLAYOFF_SIZE);
    const sources = (stage.progression as { sources?: readonly SourceShape[] } | null | undefined)?.sources ?? [];
    for (const source of sources) {
      const from = sourceOf(stages, at, source.stage);
      if (from === undefined || from.kind !== "knockout" || (from.progression ?? null) !== null) continue;
      for (const rule of source.take ?? []) {
        if (rule.kind === "roundLosers" || rule.kind === "firstLosses") needs("KO_PLATE_TOO_FEW", PLATE_MIN);
        else if (rule.kind === "rankRange" && stage.kind === "knockout" && typeof rule.to === "number") needs("QUALIFYING_MAIN_TOO_FEW", rule.to);
      }
    }
  });
  const found = gate as SizeRefusal | null;
  return found !== null && n < found.min ? found : null;
}

/** The refusal's code alone: see `stageGraphSizeGate`. */
export function stageGraphSizeRefusal(stages: readonly StageGraphStage[], n: number): KnockoutRefusalCode | null {
  return stageGraphSizeGate(stages, n)?.code ?? null;
}

/** X-QM-2 (RB4-Q2, ruling 273): a rank cut from a knockout covers WHOLE finishing bands. The places a bracket decides are 1st, 2nd,
 *  3rd-4th (the two semi-final losers share 3rd), 5th-8th, 9th-16th ...; the ranks inside a band are not played off, so a cut that
 *  starts or ends inside one would be decided by seed. A rank rule `from`..`to` is whole when `from` is the first place of a band
 *  (1, 2, 3, 5, 9, 17 ...) and `to` the last of one (1, 2, 4, 8, 16 ...); bands may join (1-4, 2-4, 3-8 are whole, 2-3 and 4-5 are
 *  not). A bracket that plays a third-place match ranks 3rd and 4th apart, so there 3 and 4 are bands of their own: 3-3, 4-4, 1-3
 *  and 2-3 are whole. Each rank rule is judged ALONE: 1-1 beside 3-3 is refused at 3-3. */
export function isWholeRoundCut(from: number, to: number, thirdPlaceMatch = false): boolean {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return false;
  const startsABand = from <= 2 || isPowerOfTwo(from - 1) || (thirdPlaceMatch && from === 4);
  const endsABand = isPowerOfTwo(to) || (thirdPlaceMatch && to === 3);
  return startsABand && endsABand;
}

const isPowerOfTwo = (n: number): boolean => n >= 1 && (n & (n - 1)) === 0;
