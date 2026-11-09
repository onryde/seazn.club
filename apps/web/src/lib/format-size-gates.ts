// W4 app-A Task 15 (FX-G14's gate half, QM-2; rules X-PL-1, X-QM-2, X-QM-5; owner pick 5A): which fields a stage graph can be
// played on, read off the GRAPH rather than a template key, so a division built through the API is gated like one built in the
// builder. The server refuses at every door that draws the root (`refuseFormatTooSmall`, stages.ts) and the builder shows the card
// disabled with the same reason (format-choice.ts); both ask this file. Pure and client-safe.
import type { KnockoutRefusalCode } from "@/lib/knockout-refusals";

/** X-PL-1 (spec §5.1): a plate needs two round-one losers to play, so a field of 4 (a field of 3 has one). */
export const PLATE_MIN = 4;

/** X-QM-5: the smallest field from which qualifying_main completes at the q the builder sends (4, format-choice.ts), named by the
 *  driving sweep (qualifying-main-sizes.test.ts): 2 and 3 play the whole qualifying stage and then fail at Complete, "the previous
 *  stage takes rank 4, but only 3 entrants are available"; every n from 4 to 17 completes. In general a cut needs a field that fills
 *  it, and the graph's own read below says so for an API-built q. */
export const QUALIFYING_MAIN_MIN = 4;

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
 *  knockout's feed is sized here: a fed knockout's losers depend on the feed, and a table ranks everyone it has. Where both rules
 *  apply the larger bound is the one that says what would fix it. */
export function stageGraphSizeGate(stages: readonly StageGraphStage[], n: number): SizeRefusal | null {
  let gate: SizeRefusal | null = null;
  const needs = (code: KnockoutRefusalCode, min: number) => {
    if (gate === null || min > gate.min) gate = { code, min };
  };
  stages.forEach((stage, at) => {
    const sources = (stage.progression as { sources?: readonly SourceShape[] } | null | undefined)?.sources ?? [];
    for (const source of sources) {
      const from = sourceOf(stages, at, source.stage);
      if (from === undefined || from.kind !== "knockout" || (from.progression ?? null) !== null) continue;
      for (const rule of source.take ?? []) {
        if (rule.kind === "roundLosers") needs("KO_PLATE_TOO_FEW", PLATE_MIN);
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

/** X-QM-2: a cut from a knockout is a whole round, 1, 2, 4, 8 …: the ranks inside a round are not played off, so a cut through one
 *  would be decided by seed. */
export function isWholeRoundCut(width: number): boolean {
  return Number.isInteger(width) && width >= 1 && (width & (width - 1)) === 0;
}
