// The unified progression field (design doc §2.1/§3, F2). Neither the OLD
// `qualification` vocabulary nor the OLD `seeding` vocabulary was a superset
// of the other — qualification alone could express multiple SOURCE stages
// with dedupe; seeding alone could express a group-count-agnostic take
// pattern and a real DRAW (snake/seeded_map). This module is the union: one
// TakeRule type covering every prior spec shape, one placement algorithm,
// one resolver. Pure — no DB, no tenant, idempotent.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

export interface PoolRankPick {
  pool: string;
  rank: number;
}

// The union table (design doc §2.1, F2 prompt): rankRange survives topN
// (topN:n IS rankRange{from:1,to:n} — the design doc names this directly);
// bestNth survives bestOfRank (bestNth already has the real cross-group
// cascade + tie-flagging + unequal-pools refusal two shipped catalogue
// templates depend on; bestOfRank's only extra field,
// normaliseUnequalPools, is absorbed here — see this repo's F2 plan
// Decision 2b for why it is carried forward rather than newly wired to a
// real per-pool match ledger). picks/roundLosers are qualification's
// TakePicks/RoundLosers, unchanged in meaning, given the kind-tagged shape
// the rest of this union already uses.
export type TakeRule =
  | { kind: "rankRange"; from: number; to: number }
  | { kind: "topNPerGroup"; n: number }
  | { kind: "bestNth"; nth: number; count: number; normaliseUnequalPools?: boolean }
  | { kind: "picks"; picks: readonly PoolRankPick[] }
  | { kind: "roundLosers"; round: number; count: number };

export interface ProgressionSource {
  stage: "previous" | { stageId: string };
  take: readonly TakeRule[];
}

export interface SeededMapEntry {
  slot: string;
  source: string;
}

// Deliberately WITHOUT a "when do these fixtures appear" field — that is an
// apps/web orchestration decision (createStages / generateStageFixtures),
// not something take-rule/placement/resolution math needs. apps/web's wire
// ProgressionSchema is this shape plus `timing`.
export interface ProgressionSpec {
  sources: readonly ProgressionSource[];
  placement: "rank_order" | "snake" | "seeded_map";
  map?: readonly SeededMapEntry[];
}

// WHO a not-yet-filled slot represents, independent of whether the source
// stage has finished (shape) or has real standings (resolution).
// `descriptorKey` is the wire identity `seeded_map.source` matches against;
// `descriptorLabel` is the i18n pattern ref persisted onto
// fixtures.home/away_slot_label.
export type SlotDescriptor =
  | { kind: "group_rank"; pool: string; rank: number }
  | { kind: "rank_range"; rank: number }
  | { kind: "best_nth"; nth: number; position: number; normaliseUnequalPools?: boolean }
  | { kind: "round_loser"; round: number; position: number };

export interface SlotLabel {
  key: string;
  params: Record<string, unknown>;
}

export interface SourceShape {
  poolKeys: string[];
}

/** A descriptor tagged with which `ProgressionSpec.sources[]` entry produced
 *  it. Index 0 for every single-source progression — every progression this
 *  session's writers emit is single-source; multi-source is new capability
 *  (Finding 1: it never worked before this module). */
export interface SourcedSlot {
  sourceIndex: number;
  descriptor: SlotDescriptor;
}

export function descriptorKey(d: SlotDescriptor): string {
  switch (d.kind) {
    case "group_rank":
      return `${d.pool}${d.rank}`;
    case "rank_range":
      return `rank:${d.rank}`;
    case "best_nth":
      return `best:${d.position}`;
    case "round_loser":
      return `loser:${d.round}:${d.position}`;
  }
}

export function descriptorLabel(d: SlotDescriptor): SlotLabel {
  switch (d.kind) {
    case "group_rank":
      if (d.rank === 1) return { key: "slot.winner_group", params: { g: d.pool } };
      if (d.rank === 2) return { key: "slot.runner_up_group", params: { g: d.pool } };
      return { key: "slot.nth_group", params: { n: d.rank, g: d.pool } };
    case "rank_range":
      return { key: "slot.rank_range", params: { rank: d.rank } };
    case "best_nth":
      return { key: "slot.best_nth", params: { rank: d.position, nth: d.nth } };
    case "round_loser":
      return { key: "slot.round_loser", params: { round: d.round, n: d.position } };
  }
}

function expandOne(rule: TakeRule, shape: SourceShape): SlotDescriptor[][] {
  switch (rule.kind) {
    case "rankRange": {
      const pot: SlotDescriptor[] = [];
      for (let r = rule.from; r <= rule.to; r++) pot.push({ kind: "rank_range", rank: r });
      return [pot];
    }
    case "topNPerGroup": {
      const pools = shape.poolKeys.length > 0 ? shape.poolKeys : [""];
      const pots: SlotDescriptor[][] = [];
      // WAVE-major, not pool-major: every group's winner (wave 1) before any
      // group's runner-up (wave 2) — the standard tournament convention, and
      // what makes "snake" meaningful.
      for (let wave = 1; wave <= rule.n; wave++) {
        pots.push(pools.map((pool) => ({ kind: "group_rank", pool, rank: wave })));
      }
      return pots;
    }
    case "bestNth": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) {
        pot.push({
          kind: "best_nth",
          nth: rule.nth,
          position: i,
          ...(rule.normaliseUnequalPools !== undefined
            ? { normaliseUnequalPools: rule.normaliseUnequalPools }
            : {}),
        });
      }
      return [pot];
    }
    case "picks":
      // Declaration order is data — one singleton pot PER pick so no
      // placement (snake included) can ever reorder a literal enumeration.
      return rule.picks.map((p) => [{ kind: "group_rank", pool: p.pool, rank: p.rank }]);
    case "roundLosers": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) pot.push({ kind: "round_loser", round: rule.round, position: i });
      return [pot];
    }
  }
}

export function expandTake(take: readonly TakeRule[], shape: SourceShape): SlotDescriptor[][] {
  return take.flatMap((rule) => expandOne(rule, shape));
}

/** Total qualifier count across every rule, every kind — never throws (a
 *  read path, previewDivisionFixtures, sizes a stage graph with it). */
export function progressionSize(take: readonly TakeRule[]): number {
  return take.reduce((n, rule) => {
    if (rule.kind === "rankRange") return n + Math.max(0, rule.to - rule.from + 1);
    if (rule.kind === "topNPerGroup") return n; // group-count-dependent; callers with a real shape use expandTake instead
    if (rule.kind === "bestNth") return n + rule.count;
    if (rule.kind === "picks") return n + rule.picks.length;
    return n + rule.count; // roundLosers
  }, 0);
}

/** Flatten every source's pots, IN SOURCE DECLARATION ORDER, tagging each
 *  descriptor with which source produced it. `shapeOf` is a callback rather
 *  than an array because callers resolve shape lazily (a source stage's
 *  pool count may need its own DB read, per source). */
export function expandSources(
  sources: readonly ProgressionSource[],
  shapeOf: (sourceIndex: number) => SourceShape,
): SourcedSlot[][] {
  return sources.flatMap((source, sourceIndex) =>
    expandTake(source.take, shapeOf(sourceIndex)).map((pot) =>
      pot.map((descriptor) => ({ sourceIndex, descriptor })),
    ),
  );
}

function snakeMerge(pots: readonly SourcedSlot[][]): SourcedSlot[] {
  return pots.flatMap((pot, i) => (i % 2 === 0 ? pot : [...pot].reverse()));
}

/** Resolve `sources[].take`'s pots + `placement` into the final seed 1..N
 *  order. `seeded_map` entries are validated here (unknown source /
 *  out-of-range or duplicate slot) — the "422 at rule save, not at proposal
 *  time" contract carried forward from stage-seeding.ts.
 *
 *  KNOWN LIMITATION, not fixed here: `seeded_map`'s `source` string matches
 *  against `descriptorKey`, which does not encode which SOURCE a descriptor
 *  came from. A seeded_map entry against a multi-source progression whose
 *  two sources happen to emit the same descriptor key (e.g. both have a
 *  "group_rank A1") resolves to whichever pot's copy `flat()` visits first.
 *  This is the same single-source assumption stage-seeding.ts always made;
 *  F2 does not test or fix the seeded_map + multi-source combination — no
 *  shipped writer produces it. */
export function placeDescriptors(
  pots: readonly SourcedSlot[][],
  placement: "rank_order" | "snake" | "seeded_map",
  map?: readonly SeededMapEntry[],
): SourcedSlot[] {
  const flat = placement === "snake" ? snakeMerge(pots) : pots.flat();
  if (placement !== "seeded_map" || !map || map.length === 0) return flat;

  const total = flat.length;
  const byKey = new Map(flat.map((s) => [descriptorKey(s.descriptor), s] as const));
  const seats: (SourcedSlot | undefined)[] = new Array(total).fill(undefined);
  const claimed = new Set<string>();

  for (const entry of map) {
    const seat = Number(entry.slot);
    if (!Number.isInteger(seat) || seat < 1 || seat > total) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map slot "${entry.slot}" is outside the 1..${total} seed range`,
        { slot: entry.slot, total },
      );
    }
    const slot = byKey.get(entry.source);
    if (!slot) {
      throw new EngineError(
        "SEEDING_MAP_SOURCE_INVALID",
        `seeded_map source "${entry.source}" does not match any qualifier this stage's rules produce`,
        { source: entry.source, available: [...byKey.keys()] },
      );
    }
    if (seats[seat - 1] !== undefined) {
      throw new EngineError("SEEDING_MAP_SLOT_INVALID", `seeded_map assigns seed ${seat} more than once`, {
        slot: seat,
      });
    }
    seats[seat - 1] = slot;
    claimed.add(entry.source);
  }

  const remaining = flat.filter((s) => !claimed.has(descriptorKey(s.descriptor)));
  let ri = 0;
  for (let i = 0; i < total; i++) {
    if (seats[i] === undefined) seats[i] = remaining[ri++];
  }
  return seats as SourcedSlot[];
}

/** The full "does this progression actually resolve" check every WRITER
 *  must run before trusting it (createStages/replaceStages, and
 *  templates.ts's instantiateTemplate): expand every source's take against
 *  its real shape, let placeDescriptors validate a seeded_map's
 *  slot/source references, then require at least 2 qualifiers total. */
export function validateProgressionAgainstShapes(
  shapes: readonly SourceShape[],
  progression: Pick<ProgressionSpec, "sources" | "placement" | "map">,
): void {
  const pots = expandSources(progression.sources, (i) => shapes[i]!);
  placeDescriptors(pots, progression.placement, progression.map); // throws on a bad seeded_map
  const total = pots.reduce((n, p) => n + p.length, 0);
  if (total < 2) {
    throw new EngineError("SEEDING_RULES_MISSING", "this stage's progression rules produce fewer than 2 qualifiers");
  }
}
