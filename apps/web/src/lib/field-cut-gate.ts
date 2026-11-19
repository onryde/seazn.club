// W5 Task 12b (X-BD-8, RB5-E6): a cut larger than the field, or a best-Nth cut no pool can supply, is refused by name.
//
// A stage that takes "the top N" of a table can only take what the table holds. The engine's `resolveProgression` says so at the
// end (`rowAtRank`'s STAGE_NOT_READY "pool B takes rank 4, but only 3 entrants are available"), after the whole source stage was
// played - and on the `on_complete` path completion swallowed it best-effort. This asks the same question up front, off the take
// rules the stage will resolve (`expandTake`, the engine's own expansion) and the table's SHAPE: the builder's Next and the
// format dialog's Save ask it of a plan, the server's pre-Start doors ask it of the stored stage graph (`stageGraphCutIssue`) and
// its resolve paths ask it of the real tables (`takeCutIssue`). One function, so every caller says the same numbers.
//
// Pure and client-safe. The shapes it reads are the ones the generators make: a league or Swiss is one table of the whole field, and
// a group stage snakes the field into `pools.count` pools of floor(n / pools) or one more (`snakeSizes`, pool-size-gate.ts's rule).
import { expandTake, type SlotDescriptor, type TakeRule } from "@seazn/engine/competition";
import { buildTemplateStages } from "@/lib/format-templates";
import { sourceOf, type StageGraphStage } from "@/lib/format-size-gates";

export type CutReason = "cut_exceeds_field" | "bestnth_unsuppliable";

export interface CutIssue {
  reason: CutReason;
  /** What the take asks for: the slots its rules expand to. */
  qualified: number;
  /** The largest cut the field and the pool shape can supply. */
  max: number;
}

/** The source kinds whose cut reads a standings TABLE of the field: a league, a Swiss or a group stage. A knockout's cut is its
 *  own whole-round rule (`KO_CUT_NOT_WHOLE_ROUND`, `stageGraphSizeGate`), an Americano or a ladder places by its own order. */
const CUT_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "swiss", "group"]);

/** Whether a stage of `kind` ranks the field in a table a cut can overrun (the kinds this gate judges). */
export function isCutTableKind(kind: string): boolean {
  return CUT_TABLE_KINDS.has(kind);
}

const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The pool sizes `entrants` snaked into `pools` leave, pool A first: floor(entrants / pools), the first `entrants % pools` one more. */
export function snakeSizes(entrants: number, pools: number): number[] {
  if (!Number.isInteger(entrants) || entrants < 0) throw new RangeError(`snakeSizes: entrants must be a whole number >= 0, got ${entrants}`);
  if (!Number.isInteger(pools) || pools < 1 || pools > POOL_KEYS.length) throw new RangeError(`snakeSizes: pools must be a whole number from 1 to ${POOL_KEYS.length}, got ${pools}`);
  const base = Math.floor(entrants / pools);
  const extra = entrants % pools;
  return Array.from({ length: pools }, (_, i) => base + (i < extra ? 1 : 0));
}

/** How many slots of one pot the table shape can fill. A pot of group-rank or best-Nth slots is all or nothing: a wave of
 *  `topNPerGroup` needs every pool to hold that rank, and a best-Nth reads the rank of EVERY pool before it compares (the
 *  engine's `rowAtRank` on each, so one short pool refuses the whole rule). A rank range is a prefix: it fills as far as the table
 *  has rows. Any other descriptor is not read off a table and is not this gate's to judge (counted as filled). */
function potSupply(pot: readonly SlotDescriptor[], sizes: readonly number[]): number {
  const total = sizes.reduce((a, b) => a + b, 0);
  const smallest = Math.min(...sizes);
  const filled = pot.filter((d): boolean => {
    switch (d.kind) {
      case "group_rank": {
        const at = POOL_KEYS.indexOf(d.pool === "" ? "A" : d.pool);
        return sizes[at] !== undefined && sizes[at]! >= d.rank;
      }
      case "rank_range":
        return d.rank <= total;
      case "best_nth":
        return d.nth <= smallest && d.position <= sizes.length;
      default:
        return true;
    }
  }).length;
  const prefix = pot.every((d) => d.kind === "rank_range");
  return prefix || filled === pot.length ? filled : 0;
}

/** Whether `take` asks a table of pools of `sizes` for more than it holds, or than any pool can supply. Null when the table fills
 *  it. EMPTY CASE FIRST: a take that asks for nothing (a plate's `firstLosses` is sized later) and a table with no pool have no
 *  cut to refuse. The reason is the first that applies: more than the field holds, else a shape the pools cannot fill. */
export function takeCutIssue(take: readonly TakeRule[], sizes: readonly number[]): CutIssue | null {
  if (sizes.length === 0) return null;
  // A single table (a league, a Swiss) is "pool A" to `topNPerGroup`, as the engine reads its one implicit pool.
  const pots = expandTake(take, { poolKeys: sizes.map((_, i) => POOL_KEYS[i]!) });
  const qualified = pots.reduce((n, pot) => n + pot.length, 0);
  if (qualified === 0) return null;
  const max = pots.reduce((n, pot) => n + potSupply(pot, sizes), 0);
  if (max >= qualified) return null;
  const field = sizes.reduce((a, b) => a + b, 0);
  return { reason: qualified > field ? "cut_exceeds_field" : "bestnth_unsuppliable", qualified, max };
}

/** The pool count a group stage's config asks for (`config.pools.count`, the generator's own reading), 1 when it names none. */
function poolsOf(config: Record<string, unknown> | undefined): number {
  const count = (config?.pools as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= POOL_KEYS.length ? count : 1;
}

export interface CutGraphStage extends StageGraphStage {
  config?: Record<string, unknown>;
}

/** What `stages` (in seq order) refuses a field of `entrants` for: the first source whose cut its table cannot supply, with the
 *  stage's index. Only a ROOT table feeds from the whole field (a fed stage's field is whatever it was fed). EMPTY CASE FIRST: no
 *  stage takes a cut, or the field is empty (nobody registered yet: the Start doors refuse that by their own name), and nothing is
 *  refused. A fed page playoff is the size gate's, not this one's. */
export function stageGraphCutIssue(stages: readonly CutGraphStage[], entrants: number): (CutIssue & { at: number }) | null {
  if (entrants <= 0) return null;
  for (let at = 0; at < stages.length; at++) {
    // A page playoff seats exactly four, whatever the organiser typed: its size is its own rule (`PAGE_PLAYOFF_TOO_FEW`,
    // `stageGraphSizeGate`), judged at the source's doors - and its own day-one Generate is deliberately not gated (T26c I1).
    if (stages[at]!.kind === "page_playoff") continue;
    const sources = (stages[at]!.progression as { sources?: readonly { stage?: unknown; take?: readonly TakeRule[] }[] } | null | undefined)?.sources ?? [];
    for (const source of sources) {
      const from = sourceOf(stages, at, source.stage) as CutGraphStage | undefined;
      if (from === undefined || !CUT_TABLE_KINDS.has(from.kind) || (from.progression ?? null) !== null) continue;
      const sizes = from.kind === "group" ? snakeSizes(entrants, poolsOf(from.config)) : [entrants];
      const issue = takeCutIssue(source.take ?? [], sizes);
      if (issue !== null) return { ...issue, at };
    }
  }
  return null;
}

/** The builder's question: does `template`, built at `qualified` qualifiers over `pools` pools, ask more of `entrants` than they
 *  can give? The graph is the template's own (`buildTemplateStages`), judged by the same function the server judges the stored one by. */
export function cutIssue(entrants: number, pools: number, qualified: number, template: string): CutIssue | null {
  const drafts = buildTemplateStages(template, { qualified, swissRounds: 3, poolCount: pools, legs: 1 });
  const issue = stageGraphCutIssue(drafts, entrants);
  return issue === null ? null : { reason: issue.reason, qualified: issue.qualified, max: issue.max };
}
