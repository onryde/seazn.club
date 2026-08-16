import "server-only";
// StageSeeding resolution engine (D4a / P5, design doc
// bench-product-value/designs/2026-08-13-stage-progression-design.md,
// "Seeding rules" + "Fill algorithm" sections). Pure — no DB, no tenant — so
// the shape/placement/tie-detection logic is independently testable and
// reusable from both TBD-fixture generation (shape only, before the source
// stage completes) and seed-proposal computation (full resolution, after).
//
// Deliberately separate from the OLD `stages.qualification` /
// `@seazn/engine/competition` QualificationSpec mechanism (resolveQualification):
// that flow keeps its existing auto-seed-on-complete behaviour for stages that
// declare `qualification`. A stage that declares the NEW `.seeding` goes
// through propose/confirm instead (owner ruling: "propose + confirm, never
// fully automatic" — see the design doc's Purpose section). The two schemas
// differ in what they need to express: `.seeding.source` can name ANY earlier
// stage (not just seq-1) and `.seeding.placement` controls bracket SEEDING
// (snake / explicit map), neither of which the old QualificationSpec models.
//
// KNOWN GAP (reported, not silent): `bestNth` here does NOT implement the
// UEFA "drop the lowest-ranked pool member's results" normalisation for
// UNEQUAL group sizes (spec 05 §3 / this design's Edge inventory). The
// existing engine `resolveQualification`'s `bestOfRank.normaliseUnequalPools`
// implements it, but the helper it calls (`normalisedRow`) is not exported,
// and reproducing it needs each pool's raw FixtureResult ledger (a bigger
// integration than this module's pure-StandingsRow-in surface). EQUAL-sized
// pools (the acceptance criterion's "UEFA third-place table") are unaffected
// — normalisation is a no-op when every pool played the same number of games.
// UNEQUAL pools are not silently ranked on raw stats either (review finding,
// P5/#554 follow-up): `resolveQualifiers` REFUSES a bestNth cascade whose
// pools differ in size (422 SEEDING_BESTNTH_UNEQUAL_POOLS) rather than
// producing an order that looks legitimate — every pool has an nth-place row
// — but isn't, because a smaller pool's nth place and a larger pool's nth
// place aren't comparable without the normalisation this module doesn't have.
import { rankStandings, type StandingsRow } from "@seazn/engine/competition";
import { HttpError } from "@/lib/errors";

// ---------------------------------------------------------------------------
// Rule shapes (mirrors the zod StageSeeding in api-v1/schemas.ts — kept as a
// plain TS union here so this module has zero zod/schema dependency).
// ---------------------------------------------------------------------------

export type TakeRule =
  | { kind: "rankRange"; from: number; to: number }
  | { kind: "topNPerGroup"; n: number }
  | { kind: "bestNth"; nth: number; count: number };

export type Placement = "seeded_map" | "snake" | "rank_order";

export interface SeededMapEntry {
  slot: string;
  source: string;
}

export interface SourceShape {
  /** Pool KEYS in stable order ('A','B',…), or [] for an ungrouped/single-table source (league/swiss). */
  poolKeys: string[];
}

// ---------------------------------------------------------------------------
// Slot descriptors — WHO a not-yet-filled slot represents, independent of
// whether the source stage has finished (shape) or has real standings
// (resolution). `descriptorKey` is the wire identity `seeded_map.source`
// matches against; `descriptorLabel` is the i18n pattern ref persisted onto
// `fixtures.home/away_slot_label` (design's "Label vocabulary" section —
// renderers get {key, params}, never a prebuilt string).
// ---------------------------------------------------------------------------

export type SlotDescriptor =
  | { kind: "group_rank"; pool: string; rank: number }
  | { kind: "rank_range"; rank: number }
  | { kind: "best_nth"; nth: number; position: number };

export function descriptorKey(d: SlotDescriptor): string {
  switch (d.kind) {
    case "group_rank":
      return `${d.pool}${d.rank}`;
    case "rank_range":
      return `rank:${d.rank}`;
    case "best_nth":
      return `best:${d.position}`;
  }
}

export interface SlotLabel {
  key: string;
  params: Record<string, unknown>;
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
  }
}

// ---------------------------------------------------------------------------
// Shape: expand `take` into POTS (one array per "wave" — see below), in
// declaration order. A pot's OWN internal order never changes with
// placement; only which pots get reversed (snake) or overridden (seeded_map)
// does. This is the ONLY function that needs `SourceShape` (pool keys); it
// runs at rule-save time and at TBD-generation time, both before the source
// stage has any standings.
// ---------------------------------------------------------------------------

function expandOne(rule: TakeRule, shape: SourceShape): SlotDescriptor[][] {
  switch (rule.kind) {
    case "rankRange": {
      const pot: SlotDescriptor[] = [];
      for (let r = rule.from; r <= rule.to; r++) pot.push({ kind: "rank_range", rank: r });
      return [pot];
    }
    case "topNPerGroup": {
      // Ungrouped source (league/swiss): one implicit pool, key "" — the same
      // convention seedNextStage/getStandings already use for the overall
      // (non-pool) snapshot row.
      const pools = shape.poolKeys.length > 0 ? shape.poolKeys : [""];
      const pots: SlotDescriptor[][] = [];
      // WAVE-major, not pool-major: every group's WINNER (wave 1) comes
      // before any group's RUNNER-UP (wave 2) — the standard tournament
      // convention (World Cup: all 8 winners seed 1-8, all 8 runners-up seed
      // 9-16), and what makes "snake" meaningful (see placeDescriptors).
      for (let wave = 1; wave <= rule.n; wave++) {
        pots.push(pools.map((pool) => ({ kind: "group_rank", pool, rank: wave })));
      }
      return pots;
    }
    case "bestNth": {
      const pot: SlotDescriptor[] = [];
      for (let i = 1; i <= rule.count; i++) pot.push({ kind: "best_nth", nth: rule.nth, position: i });
      return [pot];
    }
  }
}

export function expandTake(take: readonly TakeRule[], shape: SourceShape): SlotDescriptor[][] {
  return take.flatMap((rule) => expandOne(rule, shape));
}

/** Total qualifier count — drives TBD fixture-shape generation before the
 *  source stage has standings (design: "count/shape derived from rules"). */
export function seedingSlotCount(take: readonly TakeRule[], shape: SourceShape): number {
  return expandTake(take, shape).reduce((n, pot) => n + pot.length, 0);
}

// ---------------------------------------------------------------------------
// Placement: pots -> one flat seed-ordered list (seed 1..N).
// ---------------------------------------------------------------------------

// Same lap-based reversal convention `snakeDistribute` (stages.ts) already
// uses for pool distribution, generalised to merging POTS instead of
// splitting a single list: pot 0 forward, pot 1 reversed, pot 2 forward, …
function snakeMerge(pots: readonly SlotDescriptor[][]): SlotDescriptor[] {
  return pots.flatMap((pot, i) => (i % 2 === 0 ? pot : [...pot].reverse()));
}

/** Resolve `take`'s pots + `placement` into the final seed 1..N order.
 *  `seeded_map` entries are validated here (unknown source / out-of-range or
 *  duplicate slot) — this is the "422 at rule save, not at proposal time"
 *  edge case the design calls out, since callers run this at save time too. */
export function placeDescriptors(
  pots: readonly SlotDescriptor[][],
  placement: Placement,
  map: readonly SeededMapEntry[] | undefined,
): SlotDescriptor[] {
  const flat = placement === "snake" ? snakeMerge(pots) : pots.flat();
  if (placement !== "seeded_map" || !map || map.length === 0) return flat;

  const total = flat.length;
  const byKey = new Map(flat.map((d) => [descriptorKey(d), d] as const));
  const seats: (SlotDescriptor | undefined)[] = new Array(total).fill(undefined);
  const claimed = new Set<string>();

  for (const entry of map) {
    const seat = Number(entry.slot);
    if (!Number.isInteger(seat) || seat < 1 || seat > total) {
      throw new HttpError(
        422,
        `seeded_map slot "${entry.slot}" is outside the 1..${total} seed range`,
        "SEEDING_MAP_SLOT_INVALID",
        { slot: entry.slot, total },
      );
    }
    const descriptor = byKey.get(entry.source);
    if (!descriptor) {
      throw new HttpError(
        422,
        `seeded_map source "${entry.source}" does not match any qualifier this stage's rules produce`,
        "SEEDING_MAP_SOURCE_INVALID",
        { source: entry.source, available: [...byKey.keys()] },
      );
    }
    if (seats[seat - 1] !== undefined) {
      throw new HttpError(422, `seeded_map assigns seed ${seat} more than once`, "SEEDING_MAP_SLOT_INVALID", {
        slot: seat,
      });
    }
    seats[seat - 1] = descriptor;
    claimed.add(entry.source);
  }

  // Unclaimed descriptors fill the remaining seats in their rank_order
  // (pot-flattened) relative order.
  const remaining = flat.filter((d) => !claimed.has(descriptorKey(d)));
  let ri = 0;
  for (let i = 0; i < total; i++) {
    if (seats[i] === undefined) seats[i] = remaining[ri++];
  }
  return seats as SlotDescriptor[];
}

/** The full "does this StageSeeding rule actually resolve" check every
 *  WRITER of a `.seeding` rule must run before trusting it: expand `take`
 *  against the source's real shape, let `placeDescriptors` validate a
 *  `seeded_map`'s slot/source references against what that shape actually
 *  produces (throws `SEEDING_MAP_SLOT_INVALID`/`SEEDING_MAP_SOURCE_INVALID`),
 *  then require at least 2 qualifiers (`SEEDING_RULES_MISSING`). A mismatch
 *  422s HERE — the "at save time, not proposal time" contract
 *  `placeDescriptors`' own doc comment above describes — rather than
 *  persisting silently and only surfacing downstream at TBD-fixture
 *  generation time (stages.ts's generateSeededStageFixtures).
 *
 *  Pure: every caller resolves the source stage and its shape itself (DB
 *  access differs per caller — stages.ts's tx-scoped resolveSeedingSource/
 *  sourceShapeOf against a live stage graph for createStages/replaceStages,
 *  or templates.ts's instantiateTemplate reading its own just-inserted
 *  sibling row) and passes the resolved `SourceShape` in. Two callers, one
 *  function — moved here (was stages.ts-private) specifically so they can't
 *  drift apart. */
export function validateSeedingAgainstShape(
  shape: SourceShape,
  seeding: { take: readonly TakeRule[]; placement: Placement; map?: readonly SeededMapEntry[] },
): void {
  const pots = expandTake(seeding.take, shape);
  placeDescriptors(pots, seeding.placement, seeding.map); // throws on a bad seeded_map
  if (pots.reduce((n, p) => n + p.length, 0) < 2) {
    throw new HttpError(422, "this stage's seeding rules produce fewer than 2 qualifiers", "SEEDING_RULES_MISSING");
  }
}

// ---------------------------------------------------------------------------
// Resolution: seed-ordered descriptors + the source stage's real standings
// tables -> resolved entrant ids + flagged ties. Runs only after the source
// stage has standings (proposal compute, not TBD shape generation).
// ---------------------------------------------------------------------------

export interface PoolTableRows {
  /** Pool KEY ('A'…), or '' for the ungrouped/overall table. */
  pool: string;
  rows: readonly StandingsRow[];
}

export interface ResolvedQualifier {
  seed: number;
  descriptor: SlotDescriptor;
  entrantId: string;
  rank: number;
  tieUnbroken: boolean;
}

export interface TieFlag {
  descriptors: SlotDescriptor[];
  entrantIds: string[];
  reason: string;
}

function findTable(tables: readonly PoolTableRows[], pool: string): PoolTableRows {
  const table = tables.find((t) => t.pool === pool);
  if (!table) {
    throw new HttpError(
      422,
      `no pool "${pool || "overall"}" in the source stage's standings — check the seeding rule's pool keys`,
      "SEEDING_RULES_MISSING",
      { pool },
    );
  }
  return table;
}

function rowAt(tables: readonly PoolTableRows[], pool: string, rank: number): StandingsRow {
  const table = findTable(tables, pool);
  const row = table.rows.find((r) => r.rank === rank);
  if (!row) {
    throw new HttpError(
      409,
      `pool "${pool || "overall"}" has no entrant ranked ${rank} yet — the source stage may not be complete`,
      "SEEDING_SOURCE_INCOMPLETE",
      { pool, rank },
    );
  }
  return row;
}

// Cross-group cascade for bestNth candidates — the SAME public cascade
// qualification.ts's (unexported) orderCandidates uses: points -> diff -> for
// -> wins, via the exported rankStandings, so tie flags land exactly where
// the engine's own qualification cascade would land them. No h2h: candidates
// come from different pools and never played each other (spec 05 §3).
function crossGroupOrder(rows: StandingsRow[]): StandingsRow[] {
  return rankStandings(rows, { cascade: ["points", "diff", "for", "wins"] }).rows;
}

export function resolveQualifiers(
  seedOrder: readonly SlotDescriptor[],
  tables: readonly PoolTableRows[],
): { qualifiers: ResolvedQualifier[]; ties: TieFlag[] } {
  const qualifiers: ResolvedQualifier[] = [];
  const tieGroups = new Map<string, TieFlag>();

  // bestNth resolves ALL pools' nth-place rows together (once per distinct
  // `nth` value), so the cascade compares the full candidate set exactly
  // like resolveQualification.bestOfRank — never one candidate at a time.
  const bestNthOrder = new Map<number, StandingsRow[]>();
  const candidatesForNth = (nth: number): StandingsRow[] => {
    let ordered = bestNthOrder.get(nth);
    if (ordered) return ordered;
    const candidates = tables.map((t) => rowAt(tables, t.pool, nth));
    // Refuse rather than silently rank raw stats across unequal-sized pools
    // — see the KNOWN GAP comment at the top of this file. Every pool here
    // already has an nth-place row (rowAt above didn't throw), so this is
    // specifically the "looks fine, isn't" case: without UEFA's drop-the-
    // extra-games normalisation, a smaller pool's nth place (its LAST place)
    // and a larger pool's nth place (a mid-table finish) are not the same
    // kind of result, and comparing them raw silently favours whichever
    // pool happens to have easier opposition. Scoped to exactly the pools
    // this bestNth draws from (== all of `tables`, same scope rowAt uses
    // above) — group_rank/rank_range never hit this, they rank one pool
    // at a time and unequal sizes don't affect them.
    const sizes = new Set(tables.map((t) => t.rows.length));
    if (sizes.size > 1) {
      throw new HttpError(
        422,
        `bestNth cannot compare rank-${nth} finishers across pools of different sizes (${[...sizes].sort((a, b) => a - b).join(",")}) — UEFA normalisation for unequal pools isn't implemented`,
        "SEEDING_BESTNTH_UNEQUAL_POOLS",
        { nth, poolSizes: tables.map((t) => ({ pool: t.pool, size: t.rows.length })) },
      );
    }
    ordered = crossGroupOrder(candidates);
    bestNthOrder.set(nth, ordered);
    return ordered;
  };

  seedOrder.forEach((descriptor, i) => {
    const seed = i + 1;
    let sourceRow: StandingsRow;
    if (descriptor.kind === "group_rank") {
      sourceRow = rowAt(tables, descriptor.pool, descriptor.rank);
    } else if (descriptor.kind === "rank_range") {
      sourceRow = rowAt(tables, "", descriptor.rank);
    } else {
      const ordered = candidatesForNth(descriptor.nth);
      const candidate = ordered[descriptor.position - 1];
      if (!candidate) {
        throw new HttpError(
          409,
          `bestNth needs ${descriptor.position} pools with a rank-${descriptor.nth} finisher, found ${ordered.length}`,
          "SEEDING_SOURCE_INCOMPLETE",
          { nth: descriptor.nth, position: descriptor.position },
        );
      }
      sourceRow = candidate;
    }

    qualifiers.push({
      seed,
      descriptor,
      entrantId: sourceRow.entrantId,
      rank: sourceRow.rank ?? 0,
      tieUnbroken: sourceRow.tieUnbroken === true,
    });

    // Never silently trust the engine's own deterministic (seed/id) tie
    // fallback for a seeding decision — flag it for the organiser instead.
    if (sourceRow.tieUnbroken === true) {
      const group = [sourceRow.entrantId, ...(sourceRow.tieBreak?.with ?? [])].sort();
      const key = group.join(",");
      const existing = tieGroups.get(key);
      if (existing) existing.descriptors.push(descriptor);
      else tieGroups.set(key, { descriptors: [descriptor], entrantIds: group, reason: sourceRow.tieBreak?.key ?? "seed" });
    }
  });

  return { qualifiers, ties: [...tieGroups.values()] };
}
