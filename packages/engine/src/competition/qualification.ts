// Qualification resolution — spec 05 §3. When a stage completes the engine
// resolves the next stage's qualification spec into an ORDERED seed list that
// feeds the next stage's generator. Pure and idempotent: identical inputs yield
// an identical list (property test), so regeneration is deterministic.
import { EngineError } from "../core/errors.ts";
import type { EntrantId } from "../core/types.ts";
import type { BracketFixture } from "./stage.ts";
import {
  foldResults,
  resultsAmong,
  type FixtureResult,
  type StandingsRow,
} from "./standings.ts";
import { rankStandings } from "./tiebreakers.ts";

// spec 05 §3 — the three qualification shapes.
export interface PoolRankPick {
  pool: string;
  rank: number;
}
export interface TakePicks {
  from?: string;
  take: readonly PoolRankPick[];
}
export interface TopN {
  from?: string;
  topN: number;
}
export interface BestOfRank {
  from?: string;
  bestOfRank: {
    rank: number;
    count: number;
    // UEFA "best third-placed" across unequal pools: normalise by dropping each
    // candidate's results vs its pool's lowest-ranked member before comparing
    // (spec 05 §3). Default false ⇒ plain metric comparison.
    normaliseUnequalPools?: boolean;
  };
}
// PROMPT-59 §1 — several tiers concatenated into one ordered seed list
// ("all winners + all runners-up + the best N thirds"). Each child resolves
// against the same StageTables with its own logic (BestOfRank keeps
// normaliseUnequalPools), results concatenated in declaration order.
export interface CombinedQualification {
  from?: string;
  combine: QualificationSpec[];
}
// L3/#414 — losers of a completed bracket round (KO→plate, qualifying-KO
// wildcards). `round` is a bracket-wiring label, never an arithmetic
// quantity (spec 05 §2.3/§2.5: rounds number sparsely — 1,2,3 on a winners'
// side, 7-10 on a losers' side, 14 for a grand final). `count` omitted takes
// every loser of the round.
export interface RoundLosers {
  from?: string;
  losersOfRound: {
    round: number;
    count?: number;
  };
}
export type QualificationSpec = TakePicks | TopN | BestOfRank | CombinedQualification | RoundLosers;

// A completed stage's ranked tables. `results` (pool fixtures) is needed only
// for best-of-rank normalisation.
export interface PoolTable {
  pool: string;
  rows: readonly StandingsRow[]; // ranked: rank = 1..n, distinct
  results?: readonly FixtureResult[];
}
export interface StageTables {
  pools: readonly PoolTable[];
  overall?: readonly StandingsRow[]; // league / topN source
  // L3/#414 — the completed bracket stage's fixtures, present only when
  // qualification is sourced from a bracket (knockout / double_elim /
  // stepladder / page_playoff). Only `losersOfRound` reads this; every other
  // spec ignores it.
  bracket?: readonly BracketFixture[];
  // L3/#414 — entrant seeds, when the caller has them. `losersOfRound` uses
  // this as a tie-break BEHIND bracket position (the given fixture order);
  // with a plain array (always distinctly indexed) position alone is already
  // a total order, so this can't actually fire today — kept for parity with
  // bracketRanks's own position→seed cascade and as a documented contract.
  seeds?: ReadonlyMap<EntrantId, number>;
}

function isTake(spec: QualificationSpec): spec is TakePicks {
  return "take" in spec;
}
function isTopN(spec: QualificationSpec): spec is TopN {
  return "topN" in spec;
}
function isCombine(spec: QualificationSpec): spec is CombinedQualification {
  return "combine" in spec;
}
function isRoundLosers(spec: QualificationSpec): spec is RoundLosers {
  return "losersOfRound" in spec;
}

// The seed count a spec must produce — the next stage's generator input size
// (spec 05 §6 invariant: qualification output size matches next stage input).
// L3/#414 — a losersOfRound with no explicit `count` has no statically known
// size (unlike take/topN/bestOfRank, all of which encode their size in the
// spec alone): how many losers a round produces is stage data, not spec
// data. Callers sizing the next stage ahead of time must pass `count`
// explicitly; callers sizing AFTER the stage completes read
// resolveQualification's result length instead.
export function qualificationSize(spec: QualificationSpec): number {
  if (isCombine(spec)) return spec.combine.reduce((n, child) => n + qualificationSize(child), 0);
  if (isTake(spec)) return spec.take.length;
  if (isTopN(spec)) return spec.topN;
  if (isRoundLosers(spec)) {
    if (spec.losersOfRound.count !== undefined) return spec.losersOfRound.count;
    throw new EngineError(
      "QUALIFICATION_INVALID",
      "losersOfRound needs an explicit count to size the next stage ahead of resolution — omit it only when sizing after resolveQualification has run",
      { round: spec.losersOfRound.round },
    );
  }
  return spec.bestOfRank.count;
}

function rowAtRank(table: PoolTable, rank: number): StandingsRow {
  const row = table.rows.find((entry) => entry.rank === rank);
  if (row === undefined) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `pool "${table.pool}" has no entrant ranked ${rank} (table incomplete?)`,
      { pool: table.pool, rank },
    );
  }
  return row;
}

// PROMPT-59 §3 — pools carry both a key ("A") and a display name ("Pool A");
// qualification picks match the KEY, but accept the name form too (strip a
// leading "Pool " prefix, case-insensitive) so neither silently resolves
// nothing. A miss names the available pools instead of failing opaquely.
const normPool = (s: string): string => s.trim().toLowerCase().replace(/^pool\s+/, "");

function poolByName(tables: StageTables, name: string): PoolTable {
  const want = normPool(name);
  const table = tables.pools.find((pool) => normPool(pool.pool) === want);
  if (table === undefined) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `no pool "${name}" in the completed stage — available pools: ${tables.pools
        .map((p) => p.pool)
        .join(", ")}`,
      { pool: name, available: tables.pools.map((p) => p.pool) },
    );
  }
  return table;
}

// Recompute a candidate's row with its results vs the pool's lowest-ranked
// member dropped (UEFA normalisation, spec 05 §3). If the candidate *is* the
// bottom member (shouldn't happen for third-placed picks), nothing is dropped.
function normalisedRow(table: PoolTable, candidateId: EntrantId): StandingsRow {
  const results = table.results ?? [];
  const bottom = table.rows[table.rows.length - 1];
  if (bottom === undefined || bottom.entrantId === candidateId || results.length === 0) {
    const full = table.rows.find((row) => row.entrantId === candidateId);
    if (full === undefined) {
      throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, {
        candidateId,
      });
    }
    return full;
  }
  const survivors = table.rows
    .map((row) => row.entrantId)
    .filter((id) => id !== bottom.entrantId);
  const kept = resultsAmong(new Set(survivors), results);
  const refolded = foldResults(survivors, kept);
  const row = refolded.find((entry) => entry.entrantId === candidateId);
  if (row === undefined) {
    throw new EngineError("STAGE_NOT_READY", `candidate "${candidateId}" not in its pool table`, {
      candidateId,
    });
  }
  return row;
}

// Order candidates by a simple metric cascade (spec 05 §3 default: points →
// diff → for → wins), with a deterministic seed→id fallback. No head-to-head:
// candidates come from different pools and never met.
function orderCandidates(rows: StandingsRow[]): StandingsRow[] {
  return rankStandings(rows, {
    cascade: ["points", "diff", "for", "wins"],
  }).rows;
}

// Resolve a qualification spec against a completed stage's tables → ordered
// seed list (spec 05 §3).
export function resolveQualification(spec: QualificationSpec, tables: StageTables): EntrantId[] {
  if (isCombine(spec)) {
    const seeds = spec.combine.flatMap((child) => resolveQualification(child, tables));
    const seen = new Set<EntrantId>();
    for (const id of seeds) {
      if (seen.has(id)) {
        throw new EngineError(
          "QUALIFICATION_INVALID",
          `entrant ${id} qualifies through more than one combined tier`,
          { entrantId: id },
        );
      }
      seen.add(id);
    }
    return seeds;
  }

  if (isTake(spec)) {
    return spec.take.map((pick) => rowAtRank(poolByName(tables, pick.pool), pick.rank).entrantId);
  }

  if (isTopN(spec)) {
    const source =
      tables.overall ??
      (tables.pools.length === 1 ? (tables.pools[0] as PoolTable).rows : undefined);
    if (source === undefined) {
      throw new EngineError("STAGE_NOT_READY", "topN needs an overall table (or a single pool)", {
        topN: spec.topN,
      });
    }
    if (source.length < spec.topN) {
      // Surfaces verbatim in the organiser UI — keep it human-readable.
      throw new EngineError(
        "STAGE_NOT_READY",
        `This stage takes the top ${spec.topN}, but the previous stage has only ${source.length} entrant${source.length === 1 ? "" : "s"} — lower the qualifier count or add entrants`,
        { topN: spec.topN, available: source.length },
      );
    }
    return [...source]
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
      .slice(0, spec.topN)
      .map((row) => row.entrantId);
  }

  if (isRoundLosers(spec)) {
    const bracket = tables.bracket;
    if (bracket === undefined) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "losersOfRound needs the completed stage's bracket fixtures",
        { round: spec.losersOfRound.round },
      );
    }
    const { round, count } = spec.losersOfRound;
    // Equality-filter only — never arithmetic on `round` (spec 05 §2.3/§2.5,
    // sparse numbering). The filtered array's order IS bracket position: the
    // caller that assembled `tables.bracket` is the ordering authority, not
    // this function. `tables.seeds` only breaks a tie between two
    // same-position losers, which a distinctly-indexed array can't actually
    // produce — see the StageTables.seeds comment above.
    const seedOf = (id: EntrantId): number => tables.seeds?.get(id) ?? Number.MAX_SAFE_INTEGER;
    const decided = bracket.filter(
      (fixture): fixture is BracketFixture & { loser: EntrantId } =>
        fixture.round === round && fixture.loser !== undefined,
    );
    const losers = decided
      .map((fixture, position) => ({ id: fixture.loser, position }))
      .sort((a, b) => a.position - b.position || seedOf(a.id) - seedOf(b.id))
      .map((entry) => entry.id);

    if (losers.length === 0) {
      throw new EngineError(
        "QUALIFICATION_INVALID",
        `bracket round ${round} has no losers (not decided yet, or the round does not exist)`,
        { round },
      );
    }
    const want = count ?? losers.length;
    if (want > losers.length) {
      throw new EngineError(
        "QUALIFICATION_INVALID",
        `losersOfRound wants ${want} losers from round ${round}, found ${losers.length}`,
        { round, count: want, available: losers.length },
      );
    }
    return losers.slice(0, want);
  }

  // bestOfRank — "the N best rank-R finishers across pools".
  const { rank, count, normaliseUnequalPools } = spec.bestOfRank;
  const candidates = tables.pools.map((pool) => {
    const picked = rowAtRank(pool, rank);
    return normaliseUnequalPools === true ? normalisedRow(pool, picked.entrantId) : picked;
  });
  if (candidates.length < count) {
    throw new EngineError(
      "STAGE_NOT_READY",
      `bestOfRank needs ${count} pools with a rank-${rank} finisher, found ${candidates.length}`,
      { rank, count },
    );
  }
  return orderCandidates(candidates)
    .slice(0, count)
    .map((row) => row.entrantId);
}

// L3/#414 — wraps any finish order (a bracket's bracketRanks() output, a
// ladder's config.ladder_order — anything that is just an ordered
// EntrantId[], with no pool/bracket structure of its own) as a single-pool
// PoolTable, so `topN` (and any future rank-keyed spec) resolves over it with
// NO changes to resolveQualification. Ranks are POSITIONAL (1-based index
// into `finalRanks`); the counters below don't come from a fold and carry no
// meaning — only `entrantId` and `rank` are ever read from these rows.
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
