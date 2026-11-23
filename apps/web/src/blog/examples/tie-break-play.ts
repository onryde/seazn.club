// Blog batch 2 (tie-break posts #7 to #12): the one way these examples play a small stage and rank it. Every match is
// played through the engine's own event stream (the testkit's seeded walk) and refolded by the app's own read fold
// (`foldFrom`: the outcome and headline are outcomeOf / summaryOf, as every stored fixture's are). Each result is paid
// by the stage's table rule, read where every standings read reads it (`tableRulesOf`), and the stage is ranked by the
// app's own producer of the ranker's input (`toTableStage`) and the engine's `completeTableStage`, exactly as the
// standings snapshot is. So a place in a post's table is what a division would show, not a typed number.
//
// A meeting names the result it wants ("Hawks win 1-0"); the first seeded walk, in seed order, whose refolded result
// satisfies it is the match. The search is deterministic, so the example holds no typed score.
import type { MatchOutcome, StageCtx } from "@seazn/engine/core";
import { playRecorded } from "@seazn/engine/core";
import { completeTableStage, decidedInFor, forfeitShaped, payout, setsToWinOf, unplayedSidesOf, type FixtureResult, type MembersKey, type NewLotsDraw, type StoredLotsDraw, type TableFixture } from "@seazn/engine/competition";
import type { StandingsRow } from "@seazn/engine/competition";
import { resolvePositions, type AnySportModule, type TiebreakerKey } from "@seazn/engine/sport";
import { buildWalk, lineupFromCatalog, makeEnvelope } from "@seazn/engine/testkit";
import { byeAward } from "@/lib/fixture-bye";
import { foldFrom } from "@/server/engine-db/fold";
import { tableRulesOf, type LoadedTableRules } from "@/server/engine-db/table-rules";
import { awardByeDelta, toTableStage } from "@/server/engine-db/competition/stage-inputs";
import type { FixtureRow, StageInputs } from "@/server/engine-db/competition/types";
import { tableLayoutFor, type DisplayLayout } from "@/server/public-site/standings-view";

/** The seeded search's bounds: far past what any wanted result needs, so a miss is a real fault and not a short budget. */
const MAX_SEEDS = 20000;
const MAX_EVENTS = 3000;

export interface Entrant {
  id: string;
  name: string;
  seed?: number;
}

/** What a meeting's predicate sees: the refolded outcome and the paid pair, home first, plus the headline. */
export interface MatchView {
  outcome: MatchOutcome;
  home: FixtureResult[number];
  away: FixtureResult[number];
  headline: string;
}

export interface Meeting {
  home: string;
  away: string;
  /** 1-based round (a Swiss stage pairs by round; a league leaves it at 1). */
  round?: number;
  /** How the result is described in an error when no walk reaches it. */
  what: string;
  /** The result wanted. Absent with `walkoverBy`: the meeting is a walkover. */
  want?: (m: MatchView) => boolean;
  /** The side that did not turn up: the match is a walkover with nothing played (`core.forfeit`, reason walkover). */
  walkoverBy?: string;
  /** Why the side did not turn up: "walkover" (the default) or "withdrew", the reason the withdrawal cascade records. */
  walkoverReason?: "walkover" | "withdrew";
  /**
   * Scheduled and not played yet: the stage holds the fixture and nothing is decided, which is what a head-to-head step reads
   * as an incomplete mini-schedule. Such a meeting is not in `played`; it is in `pending`.
   */
  pending?: true;
  /**
   * A Swiss round the player `home` sits out: a one-sided award bye, paid and read as the app's own producer does
   * (`awardByeDelta`). `away` is "" (nobody). Not in `played`; it is in `byes`.
   */
  bye?: true;
  /**
   * Where the search starts: the walk seed that reached `want` when the example was written, so a build does not
   * replay every seed before it. Only a speed-up: the walk is still played, folded and checked against `want`, and a
   * seed that no longer reaches it falls back to the full search from seed 1.
   */
  seed?: number;
}

export interface PlayedMeeting {
  meeting: Meeting;
  view: MatchView;
  result: FixtureResult;
  played: boolean;
  /** The walk seed that produced the match (absent for a walkover). */
  seed?: number;
}

export interface StageSpec {
  module: AnySportModule;
  /** The division's cfg (a declared variant's). */
  cfg: unknown;
  kind: "league" | "swiss";
  entrants: readonly Entrant[];
  meetings: readonly Meeting[];
  /** The stage's own tie-break order (a preset the organiser picked); absent = the sport's order. */
  stageOrder?: readonly TiebreakerKey[];
  /** The stage's stored rngSeed, which the drawing of lots folds in. */
  rngSeed?: number;
  /** A Swiss stage's rounds. */
  rounds?: number;
  /** Lots draws already stored for the stage, by pool ("" for a stage with one table), as the app reads them. */
  lotsDraws?: ReadonlyMap<string, ReadonlyMap<MembersKey, StoredLotsDraw>>;
}

export interface RankedStage {
  rows: StandingsRow[];
  rules: LoadedTableRules;
  layout: DisplayLayout;
  played: PlayedMeeting[];
  /** The lots this ranking drew (none were stored for their tied set), for the caller to store. */
  newLotsDraws: readonly NewLotsDraw[];
  /** The meetings that were scheduled and not played (`Meeting.pending`). */
  pending: Meeting[];
  /** The rounds somebody sat out (`Meeting.bye`). */
  byes: Meeting[];
}

/** A stage's rules as the web reads them: a new division on this cfg, a stage not yet started, its own order if any. */
export function stageRules(module: AnySportModule, cfg: unknown, kind: "league" | "swiss", stageOrder?: readonly TiebreakerKey[], rngSeed?: number): LoadedTableRules {
  const stageConfig: Record<string, unknown> = {};
  if (stageOrder !== undefined) stageConfig.tiebreakers = [...stageOrder];
  if (rngSeed !== undefined) stageConfig.rngSeed = rngSeed;
  return tableRulesOf(
    {
      stageId: `blog-example:${module.key}:${kind}`,
      kind,
      status: "pending",
      stageConfig: Object.keys(stageConfig).length === 0 ? null : stageConfig,
      pin: null,
      pinnedAt: null,
      divisionConfig: cfg,
      divisionTiebreakers: null,
    },
    module,
  );
}

function view(outcome: MatchOutcome, result: FixtureResult, home: string, headline: string): MatchView {
  const h = result.find((d) => d.entrantId === home);
  const a = result.find((d) => d.entrantId !== home);
  if (h === undefined || a === undefined) throw new Error(`the paid pair does not name the home side ${home}`);
  return { outcome, home: h, away: a, headline };
}

/** One meeting, played: the first seeded walk whose refolded, paid result the meeting wants, or a walkover. */
export function playMeeting(module: AnySportModule, cfg: unknown, kind: "league" | "swiss", rules: LoadedTableRules, m: Meeting): PlayedMeeting & { gamePoints: readonly [number, number] } {
  const catalog = resolvePositions(module, cfg);
  const lineups = { home: lineupFromCatalog(catalog, m.home), away: lineupFromCatalog(catalog, m.away) };
  const settle = (envelopes: ReturnType<typeof buildWalk>["events"], tag: string) => {
    const folded = foldFrom(`blog-example:${module.key}:${tag}`, { sportKey: module.key, module, cfg, lineups, envelopes, stageKind: kind });
    const outcome = folded.outcome;
    if (outcome === null) return null;
    // "Was anything played": the engine's one reader of a ledger, asked only of a forfeit-shaped result (as the app does).
    const played = forfeitShaped(outcome) ? playRecorded(envelopes.map((e) => ({ id: e.id, type: e.type })), module) : false;
    const delta = module.standingsDelta(outcome, cfg as never, { kind }, folded.state);
    const pair: FixtureResult = [delta[0], delta[1]];
    const result = payout(outcome, decidedInFor(module, outcome), pair, played, rules.points, module.awardScoreKeys, setsToWinOf(module, cfg));
    return { outcome, result, played, gamePoints: [pair[0].points, pair[1].points] as const, headline: folded.summary.headline, state: folded.state };
  };
  if (m.walkoverBy !== undefined) {
    const s = settle([makeEnvelope(1, { type: "core.forfeit", payload: { by: m.walkoverBy, reason: m.walkoverReason ?? "walkover" } } as never)], `${m.home}-${m.away}-walkover`);
    if (s === null) throw new Error(`${module.key}: a walkover by ${m.walkoverBy} decided nothing (${m.what})`);
    return { meeting: m, view: view(s.outcome, s.result, m.home, s.headline), result: s.result, played: s.played, gamePoints: s.gamePoints };
  }
  const want = m.want;
  if (want === undefined) throw new Error(`${m.what}: a meeting names the result it wants or the side that walked over`);
  const seeds = m.seed === undefined ? [] : [m.seed];
  for (const seed of [...seeds, ...Array.from({ length: MAX_SEEDS }, (_, i) => i + 1)]) {
    const { events, states } = buildWalk(module, cfg, lineups, seed, MAX_EVENTS);
    const last = states[states.length - 1];
    if (last === undefined) continue;
    const s = settle(events, `${m.home}-${m.away}-${seed}`);
    if (s === null) continue;
    if (JSON.stringify(s.state) !== JSON.stringify(last)) throw new Error(`${module.key}: seed ${seed}: the app's fold and the walk disagree on the state`);
    // Only a match decided by play is wanted: a forfeit or an abandon is not the result a tie-break post describes.
    if (forfeitShaped(s.outcome) || !["win", "draw", "tie"].includes(s.outcome.kind)) continue;
    const v = view(s.outcome, s.result, m.home, s.headline);
    if (!want(v)) continue;
    return { meeting: m, view: v, result: s.result, played: s.played, gamePoints: s.gamePoints, seed };
  }
  throw new Error(`${module.key}: no seed up to ${MAX_SEEDS} gives ${m.what}`);
}

/**
 * Plays every meeting and ranks the stage the way the standings snapshot does: the app's `toTableStage` over the stage's
 * inputs (its rules, the sport's `winsCount`, each result's game points, the seeds, the stage's rngSeed and rounds, the
 * schedule the head-to-head steps need), then the engine's `completeTableStage`. A tie that reaches lots reads the stage's
 * stored draw for that set (`lotsDraws`), else is drawn with the stage's rngSeed, as a first ranking draws it.
 */
export function playAndRank(spec: StageSpec): RankedStage {
  const { module, cfg, kind } = spec;
  const rules = stageRules(module, cfg, kind, spec.stageOrder, spec.rngSeed);
  const gamePoints = new Map<FixtureResult, readonly [number, number]>();
  const played: PlayedMeeting[] = [];
  const fixtures: FixtureRow[] = [];
  const tableFixtures: TableFixture[] = [];
  const pending: Meeting[] = [];
  const byes: Meeting[] = [];
  spec.meetings.forEach((m, i) => {
    const id = `blog-fixture-${i + 1}`;
    const round = m.round ?? 1;
    if (m.pending === true) {
      // The fixture exists and nothing is decided: the schedule counts it, the table does not.
      fixtures.push({ id, status: "scheduled", round_no: round, pool_id: null, home_entrant_id: m.home, away_entrant_id: m.away } as FixtureRow);
      tableFixtures.push({ id, status: "scheduled", roundNo: round });
      pending.push(m);
      return;
    }
    if (m.bye === true) {
      const award = byeAward(m.home) as MatchOutcome;
      const ctx: StageCtx = { kind, roundNo: round };
      fixtures.push({ id, status: "decided", round_no: round, pool_id: null, home_entrant_id: m.home, away_entrant_id: null, outcome: award } as FixtureRow);
      tableFixtures.push({ id, status: "decided", roundNo: round, awardDelta: awardByeDelta(module, award, cfg, ctx, rules.points, m.home) });
      byes.push(m);
      return;
    }
    const p = playMeeting(module, cfg, kind, rules, m);
    played.push({ meeting: p.meeting, view: p.view, result: p.result, played: p.played });
    gamePoints.set(p.result, p.gamePoints);
    fixtures.push({ id, status: "decided", round_no: round, pool_id: null, home_entrant_id: m.home, away_entrant_id: m.away } as FixtureRow);
    tableFixtures.push({
      id,
      status: "decided",
      roundNo: round,
      result: p.result,
      ...(kind === "swiss" ? { unplayed: unplayedSidesOf(p.view.outcome, p.played, p.result) } : {}),
    });
  });
  const seeds = new Map(spec.entrants.filter((e) => e.seed !== undefined).map((e) => [e.id, e.seed!] as const));
  const stageConfig: StageInputs["stage"]["config"] = {
    ...(spec.rngSeed === undefined ? {} : { rngSeed: spec.rngSeed }),
    ...(spec.rounds === undefined ? {} : { rounds: spec.rounds }),
    ...(spec.stageOrder === undefined ? {} : ({ tiebreakers: [...spec.stageOrder] } as Record<string, unknown>)),
  };
  const inputs: StageInputs = {
    stage: { id: `blog-stage:${module.key}`, division_id: "blog-division", kind, config: stageConfig, status: "pending", table_rules_pinned: null, table_rules_pinned_at: null },
    kind,
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
    seating: { kind: "unpooled" },
    adjustments: [],
  };
  const done = completeTableStage(toTableStage(inputs, spec.lotsDraws ?? new Map()), tableFixtures);
  const pools = done.tables.pools;
  if (pools.length !== 1) throw new Error(`${module.key}: one table expected, got ${pools.length}`);
  return { rows: [...pools[0]!.rows], rules, layout: tableLayoutFor({ points: rules.points, reachable: [...rules.reachable], ...(rules.ballsPerOver === undefined ? {} : { ballsPerOver: rules.ballsPerOver }) }, kind), played, newLotsDraws: done.newLotsDraws, pending, byes };
}

/** A row's entrant, by id; throws on an id the stage does not hold (never a silent blank). */
export function rowOf(rows: readonly StandingsRow[], id: string): StandingsRow {
  const r = rows.find((x) => x.entrantId === id);
  if (r === undefined) throw new Error(`no row for ${id}`);
  return r;
}

/** An ordinal place as a reader says it: 1st, 2nd, 3rd, 4th. */
export function placeText(rank: number): string {
  const tens = rank % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : rank % 10 === 1 ? "st" : rank % 10 === 2 ? "nd" : rank % 10 === 3 ? "rd" : "th";
  return `${rank}${suffix}`;
}

/** A goal-difference style number as a table prints it: +2, 0, -1. */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

// ---- strict readers for claims: a claim that parses leniently ("1st?" reads as 1) cannot see a corrupted cell ----

/** The place a "1st" / "2nd" cell names, or NaN unless the text is exactly what `placeText` prints for that place. */
export function placeOf(text: unknown): number {
  const m = /^(\d+)(st|nd|rd|th)$/.exec(String(text));
  if (m === null) return Number.NaN;
  const n = Number(m[1]);
  return placeText(n) === String(text) ? n : Number.NaN;
}

/** The two sides' figures of a headline "2 — 1" (a set sport's " · 21–15, ..." tail allowed), or null. */
export function scoreOf(text: unknown): [number, number] | null {
  const m = /^(\d+) — (\d+)(?: · \d+–\d+(?:, \d+–\d+)*)?$/.exec(String(text));
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

/**
 * A claim that every per-entrant fact is the table cell it repeats: `${entrant.id}${suffix}` against the cell of
 * column `col` in the row whose `nameCol` is the entrant's name. So a post that cites a fact cites the table, and a
 * claim on the cell covers the fact.
 */
export function factsRepeatTheTable(entrants: readonly Entrant[], nameCol: number, cols: Record<string, number>): { says: string; source: string; check: (r: { facts: Record<string, string | number>; table?: { rows: (string | number)[][] } }) => true | string } {
  return {
    says: "every per-entrant fact is the table cell it repeats",
    source: "the example's own table (a fact is the cell a post cites in its prose)",
    check(r) {
      let checked = 0;
      for (const e of entrants) {
        const row = (r.table?.rows ?? []).find((x) => x[nameCol] === e.name);
        if (row === undefined) return `no row for ${e.name}`;
        for (const [suffix, col] of Object.entries(cols)) {
          const key = `${e.id}${suffix}`;
          if (r.facts[key] !== row[col]) return `${key} is '${String(r.facts[key])}', the cell is '${String(row[col])}'`;
          checked++;
        }
      }
      return checked > 0 || "nothing checked";
    },
  };
}
