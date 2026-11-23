// Blog batch 6: the pooled twin of `playAndRank` (tie-break-play.ts), for the posts that start from a group stage. Every match is
// played through the engine's own event stream and refolded by the app's read fold (`playMeeting`), each result is paid by the stage's
// table rule, and the stage is folded as the standings snapshot folds a pooled stage: the app's `toTableStage` over a SEATED group
// (`seating: seated`, every line carrying its pool) and the engine's `completeTableStage`. What comes back is what the seeding
// resolver reads of a finished group stage: each pool's ranked rows and its counted results, and the stage's cross-group rules
// (`crossGroupRulesOf`), exactly the three things the app hands `resolveProgression` (`bestNthSourceOf`).
import { completeTableStage, crossGroupRulesOf, type FixtureResult, type SourceTables, type StandingsRow, type TableFixture } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { tableRulesOf } from "@/server/engine-db/table-rules";
import { toTableStage } from "@/server/engine-db/competition/stage-inputs";
import type { FixtureRow, StageInputs } from "@/server/engine-db/competition/types";
import { playMeeting, type Entrant, type Meeting, type PlayedMeeting } from "./tie-break-play";

export interface GroupSpec {
  module: AnySportModule;
  /** The division's cfg (a declared variant's). */
  cfg: unknown;
  entrants: readonly Entrant[];
  /** The pools, by key, each with its members (entrant ids), as the draw dealt them. */
  pools: ReadonlyMap<string, readonly string[]>;
  /** Every meeting of the stage: both sides must be members of one pool. A `bye` meeting is not allowed here. */
  meetings: readonly Meeting[];
}

export interface PlayedGroups {
  /** What the seeding resolver is handed of the finished stage. */
  tables: SourceTables;
  /** Each pool's rows, ranked, by pool key. */
  rows: ReadonlyMap<string, readonly StandingsRow[]>;
  played: PlayedMeeting[];
  /** The pool's counted results, by pool key (what a best-Nth compares a larger pool's candidate against). */
  results: ReadonlyMap<string, readonly FixtureResult[]>;
}

/** A group stage's rules as the web reads them: a new division on this cfg, a group stage not yet started. */
function groupRules(module: AnySportModule, cfg: unknown) {
  return tableRulesOf(
    { stageId: `blog-example:${module.key}:group`, kind: "group", status: "pending", stageConfig: null, pin: null, pinnedAt: null, divisionConfig: cfg, divisionTiebreakers: null },
    module,
  );
}

export function playGroups(spec: GroupSpec): PlayedGroups {
  const { module, cfg } = spec;
  const rules = groupRules(module, cfg);
  const poolOf = new Map<string, string>();
  for (const [key, members] of spec.pools) for (const id of members) poolOf.set(id, key);
  const gamePoints = new Map<FixtureResult, readonly [number, number]>();
  const played: PlayedMeeting[] = [];
  const fixtures: FixtureRow[] = [];
  const tableFixtures: TableFixture[] = [];
  spec.meetings.forEach((m, i) => {
    if (m.bye === true || m.pending === true) throw new Error("blog example: a group meeting is played (no bye, no pending)");
    const pool = poolOf.get(m.home);
    if (pool === undefined || pool !== poolOf.get(m.away)) throw new Error(`blog example: ${m.home} and ${m.away} are not in one pool`);
    const id = `blog-fixture-${i + 1}`;
    // `playMeeting` folds the match under the league kind: a match plays the same in a pool as in a league.
    const p = playMeeting(module, cfg, "league", rules, m);
    played.push({ meeting: p.meeting, view: p.view, result: p.result, played: p.played });
    gamePoints.set(p.result, p.gamePoints);
    fixtures.push({ id, status: "decided", round_no: m.round ?? 1, pool_id: pool, home_entrant_id: m.home, away_entrant_id: m.away } as FixtureRow);
    tableFixtures.push({ id, status: "decided", roundNo: m.round ?? 1, poolId: pool, result: p.result } as TableFixture);
  });
  const seeds = new Map(spec.entrants.filter((e) => e.seed !== undefined).map((e) => [e.id, e.seed!] as const));
  const inputs: StageInputs = {
    stage: { id: `blog-stage:${module.key}:group`, division_id: "blog-division", kind: "group", config: {}, status: "pending", table_rules_pinned: null, table_rules_pinned_at: null },
    kind: "group",
    division: { config: cfg, sport_key: module.key, module_version: "blog", tiebreakers: null, seq: 1 },
    module,
    rules,
    gamePoints,
    fixtures,
    tableFixtures,
    entrants: spec.entrants.map((e) => e.id),
    seeds,
    field: new Set(spec.entrants.map((e) => e.id)),
    swissAbsentRounds: new Map(),
    seating: { kind: "seated", pools: poolOf },
    adjustments: [],
  };
  const stage = toTableStage(inputs, new Map());
  const done = completeTableStage(stage, tableFixtures);
  const crossGroup = crossGroupRulesOf(stage);
  const rows = new Map(done.tables.pools.map((p) => [p.pool, [...p.rows]] as const));
  const results = new Map(done.tables.pools.map((p) => [p.pool, [...(p.results ?? [])]] as const));
  return { tables: { pools: done.tables.pools, crossGroup }, rows, played, results };
}
