import "server-only";
// D4a/P5 design doc — DB-reading half of stage progression. The pure half
// (take-rule expansion, placement, resolution) moved to
// @seazn/engine/competition (progression.ts) in F2; this file now owns only
// what genuinely needs a transaction: resolving a source-stage REFERENCE
// into a concrete stage row, reading its real shape/standings, and the
// proposal bookkeeping (hash, destination-slot lookup) that only makes sense
// against live fixture rows. Every DB-facing caller (createStages,
// replaceStages, templates.ts's instantiateTemplate, stages.ts's own
// generation/proposal flows) goes through this file rather than querying
// `pools`/`standings_snapshots`/`fixtures` directly, so the two callers can
// never drift apart.
import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  progressionSize,
  resolveProgression,
  validateProgressionAgainstShapes,
  type ProgressionSource,
  type ProgressionSpec,
  type SlotDescriptor,
  type SlotLabel,
  type SourceShape,
  type SourceTables,
  type SourcedSlot,
  type StandingsRow,
  type TakeRule,
} from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { HttpError } from "@/lib/errors";
import { poolCount, POOL_KEYS, BRACKET_KINDS, loadBracketFixtures } from "./stages";

type Tx = postgres.TransactionSql;

// Re-export the engine's pure surface — existing `import ... from
// "./stage-seeding"` call sites in stages.ts need no import-path churn even
// though the actual logic now lives in @seazn/engine/competition.
export {
  descriptorKey,
  descriptorLabel,
  expandSources,
  expandTake,
  placeDescriptors,
  progressionSize,
  resolveProgression,
  type ProgressionSource,
  type ProgressionSpec,
  type SlotDescriptor,
  type SlotLabel,
  type SourceShape,
  type SourceTables,
  type SourcedSlot,
  type TakeRule,
};

/** Pool key + its standings rows, the apps/web-facing shape `standingsHash`/
 *  `sourceStandingsTables` traffic in — structurally the engine's `PoolTable`
 *  minus the `results` field neither DB caller populates today (Decision 2b:
 *  no caller in this codebase populates a per-pool match-result ledger). */
export interface PoolTableRows {
  pool: string;
  rows: readonly StandingsRow[];
}

/** Resolve a `ProgressionSource.stage` reference to a concrete, EARLIER
 *  stage in the same division. `"previous"` = the immediately-preceding
 *  stage by seq; an explicit `{stageId}` may name any earlier stage. */
export async function resolveProgressionSource(
  tx: Tx,
  target: { division_id: string; seq: number },
  stage: ProgressionSource["stage"],
): Promise<{ id: string; kind: string; status: string }> {
  if (stage === "previous") {
    const [prev] = await tx<{ id: string; kind: string; status: string }[]>`
      select id, kind, status from stages
      where division_id = ${target.division_id} and seq < ${target.seq}
      order by seq desc limit 1`;
    if (!prev) {
      throw new HttpError(
        422,
        "progression.sources[].stage is 'previous' but this is the division's first stage",
        "SEEDING_RULES_MISSING",
      );
    }
    return prev;
  }
  const [row] = await tx<{ id: string; seq: number; kind: string; status: string }[]>`
    select id, seq, kind, status from stages where id = ${stage.stageId} and division_id = ${target.division_id}`;
  if (!row) {
    throw new HttpError(
      422,
      "progression.sources[].stage names a stage that isn't in this division",
      "SEEDING_RULES_MISSING",
      { stageId: stage.stageId },
    );
  }
  if (row.seq >= target.seq) {
    throw new HttpError(
      422,
      "progression.sources[].stage must be an earlier stage (by seq) than the stage declaring it",
      "SEEDING_RULES_MISSING",
      { stageId: stage.stageId },
    );
  }
  return row;
}

/** The source stage's pool KEYS in stable order — [] for an ungrouped
 *  (league/swiss/…) source, where `topNPerGroup` degenerates to a single
 *  implicit pool (key ""), the same overall-snapshot convention getStandings/
 *  seedNextStage already use. Reads `pools` if the source already generated
 *  them, else derives the count from its OWN config the way
 *  generateStageFixtures' poolCount() does — so shape is knowable from the
 *  moment the source stage is CREATED, no generation required there either.
 *
 *  Accepts a PRESET source (`{kind, config}`, no live id) for
 *  templates.ts's instantiateTemplate: no stage in that transaction has any
 *  pools/fixtures generated yet (no live id's `pools` query could ever
 *  return rows), so a preset skips the DB round-trip and derives straight
 *  from the config it already has in hand — the same derivation, just
 *  without a redundant SELECT. This absorbs what used to be templates.ts's
 *  own private `sourceShapeOfRow` duplicate of this exact logic. */
export async function sourceShapeOf(
  tx: Tx,
  source: { id: string; kind: string } | { kind: string; config: Record<string, unknown> },
): Promise<SourceShape> {
  if (source.kind !== "group") return { poolKeys: [] };
  if ("id" in source) {
    const pools = await tx<{ key: string }[]>`select key from pools where stage_id = ${source.id} order by key`;
    if (pools.length > 0) return { poolKeys: pools.map((p) => p.key) };
    const [row] = await tx<{ config: Record<string, unknown> }[]>`select config from stages where id = ${source.id}`;
    const count = poolCount(row?.config ?? {});
    return { poolKeys: POOL_KEYS.slice(0, count).split("") };
  }
  const count = poolCount(source.config);
  return { poolKeys: POOL_KEYS.slice(0, count).split("") };
}

/** Validate a progression rule at SAVE time (createStages/replaceStages,
 *  templates.ts's instantiateTemplate) — a bad `seeded_map` reference or a
 *  too-small shape 422s here, never discovered later at proposal/generate
 *  time (design's Edge inventory). Cheap: only needs every source's SHAPE
 *  (pool keys / count), not its standings.
 *
 *  `presetSources[i]`, when given, is used INSTEAD of resolving
 *  `progression.sources[i].stage` against the DB — templates.ts already has
 *  the just-inserted sibling stage's `{kind, config}` in hand (from the SAME
 *  transaction, a moment ago) and passes it directly rather than re-querying
 *  for a row it already has. Absent entries (or an absent array entirely)
 *  fall back to the normal DB resolution. */
export async function validateStageProgression(
  tx: Tx,
  target: { division_id: string; seq: number },
  progression: Pick<ProgressionSpec, "sources" | "placement" | "map">,
  presetSources?: readonly ({ kind: string; config: Record<string, unknown> } | undefined)[],
): Promise<void> {
  const shapes: SourceShape[] = [];
  for (let i = 0; i < progression.sources.length; i++) {
    const preset = presetSources?.[i];
    const source = preset ?? (await resolveProgressionSource(tx, target, progression.sources[i]!.stage));
    shapes.push(await sourceShapeOf(tx, source));
  }
  try {
    validateProgressionAgainstShapes(shapes, progression);
  } catch (err) {
    if (EngineError.is(err)) throw new HttpError(422, err.message, err.code, err.data as never);
    throw err;
  }
}

/** Standings fingerprint — changes iff any qualifying rank/entrant changes,
 *  so confirmSeedProposal can detect "standings moved since this proposal
 *  was drafted" (design's Fill algorithm step 1) without re-deriving the
 *  whole proposal. Unchanged from its original body (was stages.ts-private),
 *  just relocated alongside the tables it hashes. */
export function standingsHash(tables: readonly PoolTableRows[]): string {
  const material = [...tables]
    .sort((a, b) => a.pool.localeCompare(b.pool))
    .map((t) => `${t.pool}:${[...t.rows].map((r) => `${r.entrantId}=${r.rank ?? 0}`).join(",")}`)
    .join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Flatten N sources' PoolTableRows into ONE list for hashing, prefixing
 *  each pool's key with its source index so two sources that happen to key a
 *  pool identically (e.g. both have a "" overall table) can never collide.
 *  Single-source callers (every proposal in this codebase today — Decision
 *  4 scopes multi-source's DB integration to seedNextStage's on_complete
 *  path) get an unprefixed-in-spirit `0:`-prefixed list; the prefix is
 *  invisible to callers, which only ever compare two hashes for equality. */
export function poolTableRowsAcrossSources(tables: readonly SourceTables[]): PoolTableRows[] {
  return tables.flatMap((t, i) => t.pools.map((p) => ({ pool: `${i}:${p.pool}`, rows: p.rows })));
}

/** The source stage's standings, as PoolTableRows keyed by pool KEY ('A'…,
 *  "" for the overall/ungrouped table) — mirrors seedNextStage's own
 *  pool-uuid -> key translation. Throws SEEDING_SOURCE_INCOMPLETE if nothing
 *  has been snapshotted yet (the source stage may exist but have no
 *  results). */
export async function sourceStandingsTables(tx: Tx, source: { id: string }): Promise<PoolTableRows[]> {
  const poolRows = await tx<{ id: string; key: string }[]>`
    select id, key from pools where stage_id = ${source.id}`;
  const keyOf = new Map(poolRows.map((p) => [p.id, p.key]));
  const snapshots = await tx<{ pool_id: string | null; rows: StandingsRow[] }[]>`
    select pool_id, rows from standings_snapshots where stage_id = ${source.id}`;
  if (snapshots.length === 0) {
    throw new HttpError(409, "the source stage has no standings snapshots yet", "SEEDING_SOURCE_INCOMPLETE", {
      sourceStageId: source.id,
    });
  }
  return snapshots.map((s) => ({ pool: s.pool_id ? (keyOf.get(s.pool_id) ?? s.pool_id) : "", rows: s.rows }));
}

/** Resolve EVERY source a progression names into engine-ready
 *  SourceShape/SourceTables, requiring each to be status='complete' before
 *  reading its standings — the same single-source check computeSeedProposal
 *  always ran, generalised to N (Decision 4: propose/confirm's own
 *  resolution is genuinely multi-source too, even though no writer emits a
 *  multi-source `timing:"setup"` progression today). Throws 409
 *  SEEDING_SOURCE_INCOMPLETE naming the first source stage that isn't ready
 *  — same contract computeSeedProposal has always had.
 *
 *  Bracket fixtures (needed only by a `roundLosers` take rule) ARE fetched
 *  here (F3 review item 5, RESOLVED) — a prior comment said they weren't,
 *  reasoning "no `timing:"setup"` writer emits `roundLosers` today (`ko_plate`
 *  is `on_complete`)". That premise died when F3 flipped every picker
 *  template's `timing` to `"setup"` (day-one fixtures): `ko_plate`'s plate
 *  stage IS a `roundLosers` take under `timing:"setup"` now, so this function
 *  needed `SourceTables.bracket` for real — without it, `resolveProgression`'s
 *  `loserAt` always threw `STAGE_NOT_READY`, silently swallowed by
 *  completeStage's best-effort catch (stages.ts), leaving an organiser's
 *  plate stuck on TBD forever with no visible error. Mirrors
 *  `tablesForCompletedStage`'s (stages.ts, the `on_complete` flow's own table
 *  builder) `BRACKET_KINDS.has(kind) ? loadBracketFixtures(...) : undefined`
 *  exactly — same condition, same helper, now shared rather than forked. */
export async function sourcesToTables(
  tx: Tx,
  target: { division_id: string; seq: number },
  sources: readonly ProgressionSource[],
): Promise<{
  shapes: SourceShape[];
  tables: SourceTables[];
  resolved: { id: string; kind: string; status: string }[];
}> {
  const shapes: SourceShape[] = [];
  const tables: SourceTables[] = [];
  const resolved: { id: string; kind: string; status: string }[] = [];
  for (const s of sources) {
    const source = await resolveProgressionSource(tx, target, s.stage);
    if (source.status !== "complete") {
      throw new HttpError(409, "the source stage isn't complete yet", "SEEDING_SOURCE_INCOMPLETE", {
        sourceStageId: source.id,
      });
    }
    resolved.push(source);
    shapes.push(await sourceShapeOf(tx, source));
    const pools = await sourceStandingsTables(tx, source);
    const bracket = BRACKET_KINDS.has(source.kind) ? await loadBracketFixtures(tx, source.id) : undefined;
    tables.push({ pools, ...(bracket ? { bracket } : {}) });
  }
  return { shapes, tables, resolved };
}

/** seed -> every "<fixtureId>:home" | "<fixtureId>:away" slot carrying that
 *  seed's label, read off the TBD fixtures' own slot_label
 *  (generateProgressionSetupFixtures stamps an internal `seed` alongside
 *  {key,params} for exactly this lookup — renderers destructure
 *  {key,params} and ignore it). Usually a singleton list, but a BYE seed
 *  owns TWO: its own bye fixture's slot AND the winner-feed target's slot
 *  (both get the SAME seed stamped). #554: this used to collapse to a
 *  single `Map<number,string>` (last-write-wins over an unordered SELECT),
 *  which silently stranded whichever slot the DB didn't return last.
 *  `order by id` makes the returned list's order — not just its membership —
 *  reproducible across calls against the same fixture rows. */
export async function destinationSlotsBySeed(tx: Tx, stageId: string): Promise<Map<number, string[]>> {
  const fixtures = await tx<
    { id: string; home_slot_label: { seed?: number } | null; away_slot_label: { seed?: number } | null }[]
  >`select id, home_slot_label, away_slot_label from fixtures where stage_id = ${stageId} order by id`;
  const bySeed = new Map<number, string[]>();
  const add = (seed: number, slot: string) => {
    const list = bySeed.get(seed);
    if (list) list.push(slot);
    else bySeed.set(seed, [slot]);
  };
  for (const f of fixtures) {
    if (typeof f.home_slot_label?.seed === "number") add(f.home_slot_label.seed, `${f.id}:home`);
    if (typeof f.away_slot_label?.seed === "number") add(f.away_slot_label.seed, `${f.id}:away`);
  }
  return bySeed;
}
