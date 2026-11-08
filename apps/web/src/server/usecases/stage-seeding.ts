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
  type NewLotsDraw,
} from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { HttpError } from "@/lib/errors";
import { luckyLoserOrder } from "@/lib/lucky-loser";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { CUT_SKIPS_DEPARTED_KINDS } from "@/lib/table-withdrawal";
import { bracketStageIsDecided, loadCrossGroupRules } from "@/server/engine-db/competition";
import { persistLotsDraws } from "@/server/engine-db/table-rules";
import { LUCKY_LOSER_SOURCE_KINDS, luckyLoserPool, qualifiersOfCut, rankCutOf } from "./lucky-loser";
import { poolCount, POOL_KEYS, BRACKET_KINDS, REAL_TABLE_KINDS, loadBracketFixtures, americanoPlacementTables, departedEntrantIds } from "./stages";

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

/** The tables a progression's CUT reads from one source (W3 T15 Carry A, controller rulings 2026-11-02, fix round 1 I3):
 *  for a source kind in `CUT_SKIPS_DEPARTED_KINDS` (lib/table-withdrawal.ts — Swiss, and since W4 T13 league and group,
 *  RB4-V6; the scope guard), every
 *  departed row moves to the BOTTOM of its table: the eligible rows first, renumbered 1..m in their table order, then
 *  the departed ones, renumbered m+1..n in theirs. So the cut takes every eligible entrant before any departed one —
 *  the next eligible entrant backfills a departed qualifier's place — and only a true shortfall (fewer eligible
 *  entrants than the cut) reaches a departed row, whose seat then resolves as any departed qualifier's does today
 *  (setup: the proposal leaves her seat vacant; on_complete: generation's `walkoverDepartedQualifiers`). Never DROPPED:
 *  a table shorter than the cut is the engine's STAGE_NOT_READY, which completion's on_complete branch reads as
 *  "another source is not ready yet" and swallows — a shortfall would seed nothing and say nothing (review I3).
 *  A tie that named a departed entrant names only the eligible ones left, and a tie with nobody left is no tie, so its
 *  flag goes too (the engine flags a seat from `tieUnbroken` and `tieBreak.with`, progression.ts); a departed row
 *  carries no tie at all — her place below every eligible entrant is the rule's, not a tie to break. Any other kind, or
 *  a table with no departed row, is returned as it was. The stored standings are never touched: the public table keeps
 *  her row in her place, marked as departed; only the cut moves her. */
export function cutEligiblePools<P extends PoolTableRows>(
  sourceKind: string,
  pools: readonly P[],
  departed: ReadonlySet<string>,
): P[] {
  if (!CUT_SKIPS_DEPARTED_KINDS.has(sourceKind)) return [...pools];
  const byRank = (a: StandingsRow, b: StandingsRow) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  return pools.map((p) => {
    if (!p.rows.some((r) => departed.has(r.entrantId))) return p;
    const kept = p.rows.filter((r) => !departed.has(r.entrantId)).sort(byRank);
    const gone = p.rows.filter((r) => departed.has(r.entrantId)).sort(byRank);
    const eligibleRows = kept.map((r, i): StandingsRow => {
      const { tieBreak, tieUnbroken, ...rest } = r;
      const row: StandingsRow = { ...rest, rank: i + 1 };
      if (tieBreak === undefined) return tieUnbroken === undefined ? row : { ...row, tieUnbroken };
      const others = tieBreak.with.filter((id) => !departed.has(id));
      if (others.length === 0) return row;
      return { ...row, tieBreak: { ...tieBreak, with: others }, ...(tieUnbroken === undefined ? {} : { tieUnbroken }) };
    });
    const departedRows = gone.map((r, i): StandingsRow => {
      const row: StandingsRow = { ...r, rank: kept.length + i + 1 };
      delete row.tieBreak;
      delete row.tieUnbroken;
      return row;
    });
    return { ...p, rows: [...eligibleRows, ...departedRows] };
  });
}

/** W4 T13 (K9; RB4-V2, RB4-E7; X-LL-1): a KNOCKOUT source's cut, `cut` wide, with every departed qualifier's place taken
 *  by the next lucky loser — `lucky` is the source's eligible losers in lucky-loser order (lib/lucky-loser.ts,
 *  `luckyLoserOrder`). The lucky loser takes her RANK, so every other qualifier keeps the seed the table gave them (the
 *  seat she would have had, RB4-V2 "takes the slot"); a table source instead closes the gap (`cutEligiblePools`,
 *  RB4-V6). Below the cut: the rest of the table in its order, then the departed, renumbered. A departed qualifier
 *  with nobody left to replace her keeps her place (RB4-E7: her seat resolves as a departed qualifier's does — the
 *  proposal leaves it empty and the confirm walks the opponent over). Tie flags on a moved row go; nothing else of a
 *  row changes. A table with no departed qualifier is returned as it was. */
export function luckyLoserCut<P extends PoolTableRows>(
  pools: readonly P[],
  cut: number,
  departed: ReadonlySet<string>,
  lucky: readonly string[],
): P[] {
  const byRank = (a: StandingsRow, b: StandingsRow) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  const untied = (r: StandingsRow): StandingsRow => {
    const row = { ...r };
    delete row.tieBreak;
    delete row.tieUnbroken;
    return row;
  };
  return pools.map((p) => {
    const ordered = [...p.rows].sort(byRank);
    const top = ordered.slice(0, cut);
    if (!top.some((r) => departed.has(r.entrantId))) return p;
    const qualifiers = new Set(top.map((r) => r.entrantId));
    const rowOf = new Map(p.rows.map((r) => [r.entrantId, r] as const));
    const queue = lucky.filter((id) => !departed.has(id) && !qualifiers.has(id) && rowOf.has(id));
    const promoted = new Set<string>();
    const sunk: StandingsRow[] = [];
    const head = top.map((r) => {
      if (!departed.has(r.entrantId)) return r;
      const id = queue.shift();
      if (id === undefined) return r;
      promoted.add(id);
      sunk.push(r);
      return { ...untied(rowOf.get(id)!), rank: r.rank };
    });
    const below = ordered.slice(cut).filter((r) => !promoted.has(r.entrantId));
    const rest = [...below.filter((r) => !departed.has(r.entrantId)), ...sunk, ...below.filter((r) => departed.has(r.entrantId))].map(
      (r, i): StandingsRow => (promoted.size === 0 ? r : { ...untied(r), rank: cut + i + 1 }),
    );
    return { ...p, rows: [...head, ...rest] };
  });
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
 *  templates.ts's instantiateTemplate) — a bad `seeded_map` reference, an
 *  illegal snake-into-a-bracket-target combo (F3 round-3 review, Task 1,
 *  ruling 13), or a too-small shape 422s here, never discovered later at
 *  proposal/generate time (design's Edge inventory). Cheap: only needs every
 *  source's SHAPE (pool keys / count), not its standings.
 *
 *  `presetSources[i]`, when given, is used INSTEAD of resolving
 *  `progression.sources[i].stage` against the DB — templates.ts already has
 *  the just-inserted sibling stage's `{kind, config}` in hand (from the SAME
 *  transaction, a moment ago) and passes it directly rather than re-querying
 *  for a row it already has. Absent entries (or an absent array entirely)
 *  fall back to the normal DB resolution.
 *
 *  `target.kind` (optional — see progression.ts's `placeDescriptors` doc
 *  comment for the "unknown => don't refuse" default) is THIS progression's
 *  OWN stage's kind, forwarded to the engine as the snake/bracket-target
 *  check's `targetKind`. Both call sites already have it in hand (createStages'
 *  freshly-inserted row, instantiateTemplate's TemplateStage) — passed
 *  straight through, no DB read added. */
export async function validateStageProgression(
  tx: Tx,
  target: { division_id: string; seq: number; kind?: string },
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
    validateProgressionAgainstShapes(shapes, progression, target.kind);
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
  target: { id: string; division_id: string; seq: number },
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
    // W4 T14 (X-QM-4): a completed knockout with a decision taken back still reads `complete` (nothing reopens a stage), and
    // its stored ranks are the ones the correction is about to change: nothing is seeded from them until it is decided again.
    if (source.status !== "complete" || (source.kind === "knockout" && !(await bracketStageIsDecided(tx, source.id)))) {
      throw new HttpError(409, "the source stage isn't complete yet", "SEEDING_SOURCE_INCOMPLETE", {
        sourceStageId: source.id,
      });
    }
    resolved.push(source);
    shapes.push(await sourceShapeOf(tx, source));
    // americano is NOT readable from `standings_snapshots` — its snapshot
    // folds over ephemeral per-round PAIR entrants, so reading it here seats
    // ids the next stage's roster does not contain. Shares the on_complete
    // path's reader rather than re-deriving it (see its doc comment,
    // stages.ts).
    const read =
      source.kind === "americano"
        ? await americanoPlacementTables(tx, source.id, target.division_id)
        : await sourceStandingsTables(tx, source);
    // W3 T15 Carry A: a Swiss source's departed entrants leave its cut (the next eligible entrant backfills) — and since
    // W4 T13 a league's or a group's (RB4-V6). A knockout source's departed qualifier takes a lucky loser in her place
    // (RB4-V2, `luckyLoserCut`). The hash the proposal stores is over these tables, so a departure or a return after a
    // draft stales it.
    const departed = await departedEntrantIds(tx, target.division_id);
    const cut = LUCKY_LOSER_SOURCE_KINDS.has(source.kind) ? rankCutOf(s.take) : null;
    const pools =
      cut === null
        ? cutEligiblePools(source.kind, read, departed)
        : luckyLoserCut(read, cut, departed, await luckyLoserOrderFor(tx, source.id, target.id, read, cut));
    const bracket = BRACKET_KINDS.has(source.kind) ? await loadBracketFixtures(tx, source.id) : undefined;
    // W2d T12 (spec §5.9, X-TB-7): the source's pinned cross-group order and stored draws — as tablesForCompletedStage.
    const crossGroup = REAL_TABLE_KINDS.has(source.kind) ? await loadCrossGroupRules(tx, source.id) : undefined;
    tables.push({ pools, ...(bracket ? { bracket } : {}), ...(crossGroup ? { crossGroup } : {}) });
  }
  return { shapes, tables, resolved };
}

/** The source's losers below its cut, in lucky-loser order with the destination's draw seed (RB4-V5); `luckyLoserCut`
 *  skips the departed. */
async function luckyLoserOrderFor(
  tx: Tx,
  sourceId: string,
  destinationId: string,
  pools: readonly PoolTableRows[],
  cut: number,
): Promise<string[]> {
  return luckyLoserOrder(await luckyLoserPool(tx, sourceId, qualifiersOfCut(pools, cut)), swissDrawSeed(destinationId));
}

/** W2d T12 (spec §5.9, X-TB-7): store the cross-group draws best-Nth made, each under its source stage's pool null
 *  (`stage_lots_draws.pool_id` null; a pooled stage has no "" table of its own, and a one-pool source never ties across
 *  groups), where `loadCrossGroupRules` reads them back — so a re-proposal or a re-complete seats the same order. The
 *  caller holds the division lock. */
export async function persistCrossGroupDraws(
  tx: Tx,
  sources: readonly { id: string }[],
  draws: readonly (NewLotsDraw & { readonly sourceIndex: number })[],
): Promise<void> {
  for (const { sourceIndex, ...draw } of draws) {
    const source = sources[sourceIndex];
    if (source === undefined) throw new Error(`a cross-group draw names source ${sourceIndex}, which the progression does not have`);
    await persistLotsDraws(tx, source.id, null, [draw]);
  }
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
