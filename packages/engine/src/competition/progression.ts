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
 *  P6 (F3 Task 3) — RESOLVED, was a KNOWN LIMITATION: `seeded_map`'s
 *  `source` string matches against `descriptorKey`, which does not encode
 *  which SOURCE a descriptor came from. A multi-source progression whose two
 *  sources happen to emit the same descriptor key (e.g. both have a
 *  "group_rank A1") is now a genuine ambiguity: if a `seeded_map` entry
 *  names that key, this throws `SEEDING_MAP_SOURCE_AMBIGUOUS` naming the key
 *  and every colliding source index, rather than silently resolving to
 *  whichever source's copy happened to be visited last (the old `Map`
 *  construction's last-write-wins behaviour — the wrong team's placeholder
 *  in the wrong bracket seat, every test green). A shared key that is NOT
 *  referenced by any `seeded_map` entry is not an error — both copies flow
 *  through untouched, same as `rank_order`/`snake` (plain array
 *  concatenation/reversal, never keyed by `descriptorKey`, so they never had
 *  this bug). This was unreachable from the picker before F3: every writer
 *  in this codebase emits a single-source progression; multi-source is new
 *  capability this module unlocked (SourcedSlot's own doc comment). */
// Bracket-kind targets — mirrors apps/web's BRACKET_KINDS
// (server/usecases/stages.ts:1813, server/engine-db/competition.ts:37) and
// BracketStage.kind's Extract union (./stage.ts). Kept as a loose
// `ReadonlySet<string>`, not core's `StageKind`, so BOTH apps/web callers
// (stages.ts, stage-seeding.ts) can pass their DB row's `kind: string`
// verbatim — no cast, no new parse/throw path. An unrecognised value simply
// isn't in the set, which is the same "don't refuse" outcome as omitting
// `targetKind` altogether (see placeDescriptors' doc comment) — this module
// stays tolerant of loose caller data the way progressionSize/
// previewSourceShape already are elsewhere. Keep the four names in sync with
// those two apps/web sites if a new bracket stage kind ever ships.
// Exported (round-4 review, B) so apps/web's bracket-kinds-sync.test.ts can
// pin this literal against its two hand-copied siblings — see that test's
// own header comment for why an unsynced 5th bracket kind is a silent,
// fail-open hazard rather than a loud one.
export const BRACKET_STAGE_KINDS: ReadonlySet<string> = new Set([
  "knockout",
  "double_elim",
  "stepladder",
  "page_playoff",
]);

export function placeDescriptors(
  pots: readonly SourcedSlot[][],
  placement: "rank_order" | "snake" | "seeded_map",
  map?: readonly SeededMapEntry[],
  // F3 round-3 review, Task 1 — the target stage's raw `kind` (apps/web's
  // stages.kind column), OPTIONAL: absent/unrecognised means "unknown,
  // don't refuse" rather than "always refuse", so a caller that hasn't been
  // taught to pass it yet (or is validating a shape with no real target in
  // hand) doesn't regress into an always-throwing guard.
  targetKind?: string,
): SourcedSlot[] {
  // Ruling 13 (F3 programme index, round-3 review): snake is chosen by the
  // TARGET stage's kind, not the source's. Rule of record: "snake for a
  // group/pool target, rank_order for a bracket target." Two refusals
  // enforce it, both snake-specific:
  //
  // (1) The bestNth corollary (caught in the same review as ruling 13):
  // snakeMerge reverses a pot's ARRAY ORDER but never touches each
  // descriptor's own `position` (its cross-group strength rank), so
  // reversing a bestNth pot would seed the WEAKEST wildcard into the
  // STRONGEST bracket slot. There is no target for which that reversal is
  // ever correct, so this refuses unconditionally — target-kind known or
  // not.
  if (placement === "snake") {
    const potIndex = pots.findIndex((pot) => pot.some((s) => s.descriptor.kind === "best_nth"));
    if (potIndex !== -1) {
      throw new EngineError(
        "CONFIG_INVALID",
        `placement "snake" cannot be combined with a bestNth-sourced pot (pot ${potIndex}) — snakeMerge reverses a pot's array order without moving each descriptor's cross-group strength rank ("position"), so the weakest wildcard would seed into the strongest slot; use "rank_order" for a bestNth take`,
        { placement, potIndex },
      );
    }
    // (2) The rule itself (Task 1 — the corollary above is not the rule,
    // it's one instance of it). A WAVE-major pot (topNPerGroup's shape —
    // expandOne's own comment: "every group's winner (wave 1) before any
    // group's runner-up (wave 2)"; >1 descriptor, every one `group_rank`;
    // `picks`' singleton group_rank pots are immune — reversing a 1-element
    // pot is a no-op) placed into a bracket-kind TARGET is refused: snakeMerge
    // reverses alternate waves, and a single-elimination seed fold then pairs
    // seed i against seed N+1-i (scheduling/bracket.ts:52-63,156-163) — which
    // lands every pool's OWN wave-1 qualifier against its OWN wave-2
    // qualifier in round 1 (ruling 13's worked example: 4 pools,
    // topNPerGroup(2) => round 1 is A1 v A2, B1 v B2 — every group replaying
    // its own final). `targetKind` unknown/not a bracket kind => this check
    // is skipped entirely (see the param's own doc comment); t20-super8's
    // real usage (a GROUP target) is exactly the skip case.
    if (targetKind !== undefined && BRACKET_STAGE_KINDS.has(targetKind)) {
      const waveIndex = pots.findIndex(
        (pot) => pot.length > 1 && pot.every((s) => s.descriptor.kind === "group_rank"),
      );
      if (waveIndex !== -1) {
        throw new EngineError(
          "CONFIG_INVALID",
          `placement "snake" cannot target a bracket-kind stage ("${targetKind}") together with a multi-pool wave (pot ${waveIndex}) — snakeMerge reverses alternate waves, and a single-elimination seed fold then pairs each pool's OWN qualifiers against each other in round 1 (e.g. group A's winner meets group A's runner-up); use "rank_order" for a bracket target — snake is only correct for a group/pool target`,
          { placement, targetKind, potIndex: waveIndex },
        );
      }
    }
  }
  const flat = placement === "snake" ? snakeMerge(pots) : pots.flat();
  if (placement !== "seeded_map" || !map || map.length === 0) return flat;

  const total = flat.length;
  // Grouped by key (never collapsed to one) — a multi-source progression can
  // legitimately produce the same descriptorKey from two different sources,
  // and `seeded_map.source` is a bare key with no source qualifier, so
  // resolving it can be genuinely ambiguous (see this function's own doc
  // comment above).
  const byKey = new Map<string, SourcedSlot[]>();
  for (const s of flat) {
    const key = descriptorKey(s.descriptor);
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }
  const seats = new Array<SourcedSlot | undefined>(total).fill(undefined);
  // Claimed by OBJECT identity, not by key string: two flat entries can
  // share a descriptorKey without being the same slot (the ambiguous-but-
  // unreferenced case above), and only the ONE explicitly-mapped slot may be
  // removed from the auto-fill pool — a key-based claim would silently drop
  // its unclaimed sibling too.
  const claimed = new Set<SourcedSlot>();

  for (const entry of map) {
    const seat = Number(entry.slot);
    if (!Number.isInteger(seat) || seat < 1 || seat > total) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map slot "${entry.slot}" is outside the 1..${total} seed range`,
        { slot: entry.slot, total },
      );
    }
    const candidates = byKey.get(entry.source);
    if (!candidates || candidates.length === 0) {
      throw new EngineError(
        "SEEDING_MAP_SOURCE_INVALID",
        `seeded_map source "${entry.source}" does not match any qualifier this stage's rules produce`,
        { source: entry.source, available: [...byKey.keys()] },
      );
    }
    if (candidates.length > 1) {
      const sourceIndexes = candidates.map((c) => c.sourceIndex);
      const distinctSources = new Set(sourceIndexes);
      // F3 review item 2 (RESOLVED) — was `candidates.length > 1` alone, so
      // a SINGLE source with two overlapping take rules (e.g. two
      // overlapping rankRanges) also threw here, with `sourceIndexes: [0,
      // 0]` while the message claimed ">1 progression source" — a
      // same-source collision is a different condition and (for every
      // descriptorKey EXCEPT best_nth's) a harmless one: descriptorKey fully
      // determines every other kind's descriptor, so a same-key match within
      // one source can only be the identical descriptor twice — an
      // overlapping/duplicate take rule that resolveProgression's own
      // entrant-dedupe guard (QUALIFICATION_INVALID) already refuses the
      // moment BOTH copies are placed, whichever one `seeded_map` picks
      // here. best_nth's key (`best:${position}`) is the one exception —
      // it drops `nth`, so two bestNth rules at the same position but a
      // DIFFERENT nth collide on key while resolving to different entrants;
      // that is genuinely ambiguous even within a single source, so it still
      // refuses rather than silently picking the wrong nth-tier entrant.
      const distinctDescriptors = new Set(candidates.map((c) => JSON.stringify(c.descriptor)));
      if (distinctSources.size > 1 || distinctDescriptors.size > 1) {
        throw new EngineError(
          "SEEDING_MAP_SOURCE_AMBIGUOUS",
          distinctSources.size > 1
            ? `seeded_map source "${entry.source}" matches qualifiers from more than one progression source (indexes ${[...distinctSources].join(", ")}) — seeded_map cannot tell them apart; use rank_order/snake placement instead, or make each source's pool keys distinct`
            : `seeded_map source "${entry.source}" matches more than one qualifier within the same progression source (source ${sourceIndexes[0]}) — its take rules produce this key more than once (e.g. two bestNth rules at the same position with a different nth); remove the overlap or duplicate rule`,
          { source: entry.source, sourceIndexes },
        );
      }
      // Same source, identical descriptor: interchangeable — fall through
      // and let `candidates[0]` claim the seat, same as any other match.
    }
    const slot = candidates[0]!;
    if (seats[seat - 1] !== undefined) {
      throw new EngineError("SEEDING_MAP_SLOT_INVALID", `seeded_map assigns seed ${seat} more than once`, {
        slot: seat,
      });
    }
    // B (round-4 review) — two DIFFERENT entries naming the SAME source both
    // resolve `candidates[0]` to this identical SourcedSlot object; `claimed`
    // already exists to keep it out of the auto-fill pool below, so it also
    // doubles as the duplicate-source check here for free: a second entry
    // reusing an already-claimed source would otherwise silently duplicate
    // that seat's descriptor into a second seed and leave the real qualifier
    // for the now-orphaned seat unplaced — surfacing far downstream as a
    // confusing QUALIFICATION_INVALID at resolve time instead of refusing
    // the malformed map right here.
    if (claimed.has(slot)) {
      throw new EngineError(
        "SEEDING_MAP_SLOT_INVALID",
        `seeded_map source "${entry.source}" is already assigned to another seed — each source may be named by at most one seeded_map entry`,
        { source: entry.source, slot: seat },
      );
    }
    seats[seat - 1] = slot;
    claimed.add(slot);
  }

  const remaining = flat.filter((s) => !claimed.has(s));
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
 *  slot/source references AND (F3 round-3 review, Task 1) an illegal
 *  snake-into-a-bracket-target combo, then require at least 2 qualifiers
 *  total. `targetKind` is this progression's OWN stage's raw `kind` —
 *  optional, forwarded verbatim to placeDescriptors (see its doc comment for
 *  the "unknown => don't refuse" default). */
export function validateProgressionAgainstShapes(
  shapes: readonly SourceShape[],
  progression: Pick<ProgressionSpec, "sources" | "placement" | "map">,
  targetKind?: string,
): void {
  const pots = expandSources(progression.sources, (i) => shapes[i]!);
  placeDescriptors(pots, progression.placement, progression.map, targetKind); // throws on a bad seeded_map or an illegal snake/bracket-target combo
  const total = pots.reduce((n, p) => n + p.length, 0);
  if (total < 2) {
    throw new EngineError("SEEDING_RULES_MISSING", "this stage's progression rules produce fewer than 2 qualifiers");
  }
}

// ---------------------------------------------------------------------------
// Resolution — a completed source stage's real standings/bracket, resolved
// against a ProgressionSpec into an ordered seed list (spec 05 §3 successor).
// ---------------------------------------------------------------------------

export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[];
  // Only consulted when a best_nth descriptor carries
  // normaliseUnequalPools:true (Decision 2b) — absent for every caller in
  // this codebase today, matching production behaviour before this session.
  results?: readonly FixtureResult[];
}
export interface BracketFixtureRow {
  round: number;
  loser?: EntrantId;
}
export interface SourceTables {
  pools: readonly PoolTable[];
  // Carried from the old qualification.ts's StageTables.overall — written by
  // stage.ts's completeTableStage exactly when pools.length === 1 (its only
  // write site, confirmed by grep), and read directly by stage.test.ts.
  // No longer consulted by THIS module's own resolution: rankRange falls
  // back to "the sole pool, whatever its key" instead (rankRangeSource
  // below), which covers every case `overall` ever did — the two
  // conditions were always equivalent, since nothing else ever wrote
  // `overall`. The field stays only so completeTableStage's return shape
  // and its existing test are unaffected by this module superseding
  // qualification.ts.
  overall?: readonly StandingsRow[];
  bracket?: readonly BracketFixtureRow[]; // only present for a bracket-kind source; only roundLosers reads it
}
export interface ResolvedProgressionEntry {
  seed: number;
  sourceIndex: number;
  descriptor: SlotDescriptor;
  entrantId: EntrantId;
  rank: number;
  tieUnbroken: boolean;
}
export interface ProgressionTieFlag {
  // Widened from SlotDescriptor[] (F3 review item 1): a tie descriptor with
  // no sourceIndex is indistinguishable from an identically-keyed descriptor
  // on a DIFFERENT source (trivially: two rankRange sources, or two
  // group_rank sources sharing a pool letter) — exactly the collision
  // apps/web's computeSeedProposal (stages.ts) used to mis-seat a confirmed
  // tie pick against, because its seedOfKey Map could only key by bare
  // descriptorKey. SourcedSlot already carries sourceIndex — reuse it rather
  // than invent a parallel shape.
  descriptors: SourcedSlot[];
  entrantIds: EntrantId[];
  reason: string;
}

// Pools carry both a key ("A") and a display name ("Pool A"); progression
// picks match the KEY, but accept the name form too (strip a leading
// "Pool " prefix, case-insensitive) so neither silently resolves nothing.
const normPool = (s: string): string => s.trim().toLowerCase().replace(/^pool\s+/, "");

function findPool(pools: readonly PoolTable[], pool: string): PoolTable {
  const want = normPool(pool);
  const table = pools.find((p) => normPool(p.pool) === want);
  if (!table) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `no pool "${pool || "overall"}" in the source stage — available pools: ${pools.map((p) => p.pool).join(", ")}`,
      { pool, available: pools.map((p) => p.pool) },
    );
  }
  return table;
}

/** rankRange's source table: the SOLE pool when there is exactly one —
 *  regardless of its key — otherwise the pool explicitly keyed "".
 *  Mirrors the old qualification.ts's isTopN fallback (`tables.overall ??
 *  (tables.pools.length === 1 ? tables.pools[0].rows : undefined)`) without
 *  needing the `overall` field: `overall` was written by completeTableStage
 *  (stage.ts) ONLY when pools.length === 1 — its only write site — so the
 *  two conditions were always equivalent. A single-pool source's key varies
 *  by caller: a bare league/swiss stage names it "" (no poolId on its
 *  fixtures), but e.g. testkit/simulation.ts's group_knockout format always
 *  assigns a real id ("P1") even when poolCount collapses to 1 for a small
 *  entrant count — matching on "" alone would regress that shape (verified:
 *  simulation.test.ts's SIM_RUNS property sweep hits it routinely, since
 *  drawEntrantCount skews toward low counts). */
function rankRangeSource(pools: readonly PoolTable[]): PoolTable {
  if (pools.length === 1) return pools[0]!;
  return findPool(pools, "");
}

// F2 Task 6 review (defect 4): `rankRange` replaced `topN`, whose old
// message told an organiser what to DO ("takes the top N, only M
// available — lower the qualifier count or add entrants" —
// qualification.ts's isTopN branch, pre-F2). This function is the ONLY
// place a shortfall like that can be discovered now (both `group_rank` via
// findPool+rowAtRank and `rank_range` via rankRangeSource+rowAtRank funnel
// through it), and a generic "no entrant ranked N yet" regressed that —
// restored here, generalised to name the pool when there is one (the
// group_rank case) the way topN's flat single-table message never needed
// to. Still STAGE_NOT_READY (same code topN always used — this message was
// never in seeding-error.ts's 13-code allowlist either, before or after
// F2, so it has always reached the organiser via the raw-message fallback,
// not a wired locale key; wiring one is a separate, scoped effort per
// lib/seeding-error.ts's own "Do NOT audit or wire other unwired codes"
// note).
function rowAtRank(table: PoolTable, rank: number): StandingsRow {
  const row = table.rows.find((r) => r.rank === rank);
  if (!row) {
    const available = table.rows.length;
    const label = table.pool ? `pool "${table.pool}"` : "the previous stage";
    throw new EngineError(
      "STAGE_NOT_READY",
      `${label} takes rank ${rank}, but only ${available} entrant${available === 1 ? "" : "s"} ${available === 1 ? "is" : "are"} available — lower the qualifier count or add entrants`,
      { pool: table.pool, rank, available },
    );
  }
  return row;
}

// UEFA "drop the lowest-ranked pool member's results" normalisation
// (Decision 2b) — unchanged from qualification.ts's normalisedRow, moved
// verbatim. A no-op when `results` is absent or empty, which is every
// caller in this codebase today.
function normalisedRow(table: PoolTable, candidateId: EntrantId): StandingsRow {
  const results = table.results ?? [];
  const bottom = table.rows[table.rows.length - 1];
  if (bottom === undefined || bottom.entrantId === candidateId || results.length === 0) {
    const full = table.rows.find((row) => row.entrantId === candidateId);
    if (full === undefined) {
      throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, { candidateId });
    }
    return full;
  }
  const survivors = table.rows.map((row) => row.entrantId).filter((id) => id !== bottom.entrantId);
  const kept = resultsAmong(new Set(survivors), results);
  const refolded = foldResults(survivors, kept);
  const row = refolded.find((entry) => entry.entrantId === candidateId);
  if (!row) {
    throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, { candidateId });
  }
  return row;
}

// Same cascade both prior implementations already used verbatim
// (orderCandidates in qualification.ts, crossGroupOrder in
// stage-seeding.ts) — unifying it is a rename, not a behaviour change.
function crossGroupOrder(rows: StandingsRow[]): StandingsRow[] {
  return rankStandings(rows, { cascade: ["points", "diff", "for", "wins"] }).rows;
}

function loserAt(bracket: readonly BracketFixtureRow[] | undefined, round: number, position: number): StandingsRow {
  if (!bracket) {
    throw new EngineError("STAGE_NOT_READY", "roundLosers needs the completed stage's bracket fixtures", { round });
  }
  // Equality-filter only — never arithmetic on `round` (rounds number
  // sparsely: 1,2,3 on a winners' side, 7-10 on a losers' side). The
  // filtered array's order IS bracket position; the CALLER that assembled
  // `bracket` is the ordering authority, not this function.
  const losers = bracket.filter(
    (f): f is BracketFixtureRow & { loser: EntrantId } => f.round === round && f.loser !== undefined,
  );
  const row = losers[position - 1];
  if (!row) {
    throw new EngineError(
      "QUALIFICATION_INVALID",
      `bracket round ${round} has no loser at position ${position} (found ${losers.length})`,
      { round, position, available: losers.length },
    );
  }
  return { entrantId: row.loser, rank: position } as StandingsRow;
}

export function resolveProgression(
  spec: ProgressionSpec,
  shapes: readonly SourceShape[],
  tables: readonly SourceTables[],
  // A2 (round-4 review, MAJOR) — this stage's own raw `kind`, forwarded
  // verbatim to placeDescriptors so ruling 13's bracket-target snake guard
  // can fire on the actual seed-RESOLUTION path, not just at save-time
  // validation (validateProgressionAgainstShapes). OPTIONAL, same "unknown,
  // don't refuse" default as placeDescriptors' own targetKind param (see its
  // doc comment) — an old caller that hasn't been taught to pass one yet
  // does not regress into an always-throwing guard.
  targetKind?: string,
): { qualifiers: ResolvedProgressionEntry[]; ties: ProgressionTieFlag[] } {
  const pots = expandSources(spec.sources, (i) => shapes[i]!);
  const placed = placeDescriptors(pots, spec.placement, spec.map, targetKind);

  const qualifiers: ResolvedProgressionEntry[] = [];
  const tieGroups = new Map<string, ProgressionTieFlag>();
  const seen = new Set<EntrantId>();
  const bestNthCache = new Map<string, StandingsRow[]>();

  placed.forEach((slot, i) => {
    const seed = i + 1;
    const src = tables[slot.sourceIndex];
    if (!src) {
      throw new EngineError("STAGE_NOT_READY", `progression source ${slot.sourceIndex} has no tables yet`, {
        sourceIndex: slot.sourceIndex,
      });
    }
    let row: StandingsRow;
    const d = slot.descriptor;
    if (d.kind === "group_rank") {
      row = rowAtRank(findPool(src.pools, d.pool), d.rank);
    } else if (d.kind === "rank_range") {
      row = rowAtRank(rankRangeSource(src.pools), d.rank);
    } else if (d.kind === "round_loser") {
      row = loserAt(src.bracket, d.round, d.position);
    } else {
      // best_nth — every pool's nth-place row, compared together (once per
      // distinct nth), exactly like resolveQualification.bestOfRank used to
      // — never one candidate at a time.
      const cacheKey = `${slot.sourceIndex}:${d.nth}`;
      let ordered = bestNthCache.get(cacheKey);
      if (!ordered) {
        const candidates = src.pools.map((p) => {
          const picked = rowAtRank(p, d.nth);
          return d.normaliseUnequalPools === true ? normalisedRow(p, picked.entrantId) : picked;
        });
        if (d.normaliseUnequalPools !== true) {
          const sizes = new Set(src.pools.map((p) => p.rows.length));
          if (sizes.size > 1) {
            throw new EngineError(
              "SEEDING_BESTNTH_UNEQUAL_POOLS",
              `bestNth cannot compare rank-${d.nth} finishers across pools of different sizes (${[...sizes]
                .sort((a, b) => a - b)
                .join(",")}) without normaliseUnequalPools — set normaliseUnequalPools: true on this take rule to compare them via UEFA drop-the-bottom-result normalisation`,
              { nth: d.nth, poolSizes: src.pools.map((p) => ({ pool: p.pool, size: p.rows.length })) },
            );
          }
        }
        ordered = crossGroupOrder(candidates);
        bestNthCache.set(cacheKey, ordered);
      }
      const candidate = ordered[d.position - 1];
      if (!candidate) {
        throw new EngineError(
          "QUALIFICATION_INVALID",
          `bestNth needs ${d.position} pools with a rank-${d.nth} finisher, found ${ordered.length}`,
          { nth: d.nth, position: d.position },
        );
      }
      row = candidate;
    }

    if (seen.has(row.entrantId)) {
      throw new EngineError(
        "QUALIFICATION_INVALID",
        `entrant ${row.entrantId} qualifies through more than one source or take rule`,
        { entrantId: row.entrantId },
      );
    }
    seen.add(row.entrantId);

    qualifiers.push({
      seed,
      sourceIndex: slot.sourceIndex,
      descriptor: d,
      entrantId: row.entrantId,
      rank: row.rank ?? 0,
      tieUnbroken: row.tieUnbroken === true,
    });

    if (row.tieUnbroken === true) {
      const group = [row.entrantId, ...(row.tieBreak?.with ?? [])].sort();
      const key = group.join(",");
      const existing = tieGroups.get(key);
      // Push the whole SourcedSlot (sourceIndex + descriptor), not just `d`
      // — see ProgressionTieFlag's own doc comment.
      if (existing) existing.descriptors.push(slot);
      else tieGroups.set(key, { descriptors: [slot], entrantIds: group, reason: row.tieBreak?.key ?? "seed" });
    }
  });

  return { qualifiers, ties: [...tieGroups.values()] };
}

// L3/#414 — wraps any finish order as a single-pool PoolTable, unchanged
// from qualification.ts.
export function placementTable(finalRanks: readonly EntrantId[]): PoolTable {
  return {
    pool: "",
    rows: finalRanks.map((entrantId, i) => ({
      entrantId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      points: 0,
      metrics: {},
      rank: i + 1,
    })),
  };
}
