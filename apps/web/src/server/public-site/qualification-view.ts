import "server-only";
// Standings qualification status — the ONE builder behind every standings
// surface (division page, embed, organiser console, competition hub). Spec
// docs/superpowers/specs/2026-09-22-standings-qualification-status-design.md
// §4; plan Task 5. It derives the engine's input from what each surface already
// holds (snapshot rows, the division's fixtures, entrant statuses, the stage's
// V414 meta) and resolves every string in the caller's locale.
//
// It returns null whenever a status could be wrong (plan P7): no status beats
// a wrong one (R3). Every `return null` below names the fact it cannot trust;
// each has its own test in __tests__/qualification-view.test.ts.
import {
  PointsRule,
  SETTLED_FIXTURE_STATUSES,
  isTableStageComplete,
  pointsRuleBounds,
  qualificationStatus,
  tieKeyValue,
  tieRival,
  tieWhatIf,
  withdrawTableEntrant,
  type QualStatus,
  type QualificationInput,
  type StandingsRow,
  type TableFixture,
  type TieWhatIf,
} from "@seazn/engine/competition";
import type { AnySportModule, MatchPointsBounds, TiebreakerKey } from "@seazn/engine/sport";
import { inTheField } from "@/lib/entrant-field";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";
import { engineFixtureStatus } from "@/lib/fixture-engine-status";
import type { TKey } from "@/lib/i18n-runtime";
import { tableWithdrawalInputs } from "@/lib/table-withdrawal";
import type { QualRowT, QualTableT } from "./competition-hub-schema";
import { tieBreakRule } from "./standings-view";

export const QUAL_TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);

export interface StageQualMeta {
  qualifyCount: number | null;
  qualifyPerGroup: boolean;
  nextStageName: string | null;
  swissRounds: number | null;
  pointsRule: unknown;
  /** V414 (ruling M1): the organiser pinned ranks on this stage. NOT a row's
   *  `rankLocked`, which the engine also sets on every tie settled by lots. */
  hasRankOverrides: boolean;
}

/** snake→camel for `stage_qualification_meta`'s columns — the public view row
 *  and the console usecase row both come through here. */
export function stageQualMeta(row: {
  qualify_count: number | null;
  qualify_per_group: boolean | null;
  next_stage_name: string | null;
  swiss_rounds: number | null;
  points_rule: unknown;
  has_rank_overrides: boolean | null;
}): StageQualMeta {
  return {
    qualifyCount: row.qualify_count,
    qualifyPerGroup: row.qualify_per_group === true,
    nextStageName: row.next_stage_name,
    swissRounds: row.swiss_rounds,
    pointsRule: row.points_rule ?? null,
    hasRankOverrides: row.has_rank_overrides === true,
  };
}

/** The fixture columns the builder reads — `PublicFixture` satisfies it. */
export interface QualFixture {
  id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

/** The division's per-match bounds from its PINNED module and live cfg. Future
 *  matches score under live cfg (V347 freezes only already-scored ones), and
 *  `stage.config.rules` cannot carry points (engine-db/competition.ts). */
export function divisionPointsBounds(
  module_: AnySportModule | null | undefined,
  cfg: unknown,
): MatchPointsBounds | null {
  if (!module_) return null;
  const parsed = module_.configSchema.safeParse(cfg ?? {});
  return parsed.success ? module_.matchPointsBounds(parsed.data) : null;
}

export interface QualificationView {
  table: QualTableT;
  /** A plain object, never a Map: the hub caches it through `unstable_cache`,
   *  which serialises a Map to `{}`. */
  rows: Record<string, QualRowT>;
}

export interface QualificationViewInput {
  stage: { id: string; kind: string; meta: StageQualMeta };
  /** The pool this table is (null = the stage's one table). */
  poolId: string | null;
  /** The table's standings snapshot, ranked (rankStandings output). */
  rows: readonly StandingsRow[];
  /** The division's fixtures (any stage — the builder filters). */
  fixtures: readonly QualFixture[];
  /** entrant id → entrants.status, for every entrant in the division. */
  entrantStatuses: Readonly<Record<string, string>>;
  bounds: MatchPointsBounds | null;
  cascade: readonly string[];
  entrantNames: Readonly<Record<string, string>>;
  msg: (key: TKey, vars?: Record<string, string | number>) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
}

const seats = (f: QualFixture, id: string) => f.home_entrant_id === id || f.away_entrant_id === id;
const settled = (f: QualFixture) => SETTLED_FIXTURE_STATUSES.has(engineFixtureStatus(f.status));
const outcomeKind = (f: QualFixture): string | undefined =>
  f.outcome && typeof f.outcome === "object" ? (f.outcome as { kind?: string }).kind : undefined;

/** A fixture the standings fold counts as a match played by its entrants: a
 *  settled, non-void result between two seats, or a one-sided bye (the fold's
 *  `awardDelta` path). */
function counted(f: QualFixture): boolean {
  if (!settled(f) || engineFixtureStatus(f.status) === "void") return false;
  if (isOneSidedAwardBye(f)) return true;
  return f.outcome !== null && f.outcome !== undefined && f.home_entrant_id !== null && f.away_entrant_id !== null;
}

/** A counted match that adds nothing to the goal/set ledger (T3-⚠3): an award
 *  (a bye or a walkover — `core.forfeit` writes one for both) or a no-result.
 *  The what-if's average match leaves these out. */
function ledgerless(f: QualFixture): boolean {
  const kind = outcomeKind(f);
  return kind === "award" || kind === "no_result";
}

function statusLabel(s: QualStatus, i: QualificationViewInput): string {
  switch (s.kind) {
    case "through":
      return i.msg("table.qual.status.through");
    case "win_k":
      return i.plural("table.qual.status.winK", s.k);
    case "needs_help":
      return i.msg("table.qual.status.needsHelp");
    case "out":
      return i.msg("table.qual.status.out");
  }
}

function headline(s: QualStatus, i: QualificationViewInput, next: string, n: number): string {
  switch (s.kind) {
    case "through":
      return i.msg("table.qual.headline.through", { next });
    case "win_k":
      return i.plural("table.qual.headline.winK", s.k, { next });
    case "needs_help":
      return i.msg("table.qual.headline.needsHelp");
    case "out":
      return i.msg("table.qual.headline.out", { n });
  }
}

/** The per-match bounds in force: a stage PointsRule replaces the sport's. A
 *  rule that does not parse gives none — never the sport's bounds instead. */
function boundsInForce(i: QualificationViewInput): MatchPointsBounds | null {
  const rule = i.stage.meta.pointsRule;
  if (rule === null || rule === undefined) return i.bounds;
  const parsed = PointsRule.safeParse(rule);
  return parsed.success ? pointsRuleBounds(parsed.data) : null;
}

/** F1 — would this departed entrant's table withdrawal VOID results the table
 *  counts? The policy (usecases/withdrawal.ts) expunges an entrant under 50%
 *  played; applied now or later it rewrites every rival's points, so no status
 *  can be trusted. Award mode only walks pending matches over (within bounds);
 *  an expunge with nothing played left to void changes nothing. */
function withdrawalVoidsResults(stageId: string, kind: string, entrantId: string, fixtures: readonly QualFixture[]): boolean {
  const mine = fixtures.filter((f) => f.stage_id === stageId && seats(f, entrantId));
  const { played, pending } = tableWithdrawalInputs(entrantId, mine);
  const result = withdrawTableEntrant(
    { id: stageId, kind: kind as "league" | "group" | "swiss", entrants: [entrantId], cascade: [] },
    entrantId,
    { played, pending },
  );
  const event = result.events[0];
  const mode = event?.type === "entrant_withdrawn" ? event.mode : undefined;
  if (mode === "award") return false;
  // Expunge — or a verdict the policy did not give: unreadable, so fail closed.
  return mode !== "expunge" || played.length > 0;
}

export function buildQualificationView(i: QualificationViewInput): QualificationView | null {
  const { meta } = i.stage;
  if (!QUAL_TABLE_KINDS.has(i.stage.kind)) return null;
  if (meta.qualifyCount === null || meta.qualifyCount < 1 || meta.nextStageName === null) return null;
  if (meta.hasRankOverrides) return null; // M1: the organiser, not the cascade, orders this table
  if (!meta.qualifyPerGroup && i.poolId !== null) return null; // Review Focus 5: an overall cut
  if (i.rows.length === 0) return null;
  if (i.cascade[0] !== "points") return null; // Review Focus 4: points do not decide places
  const perMatch = boundsInForce(i);
  if (perMatch === null) return null;

  const isSwiss = i.stage.kind === "swiss";
  if (isSwiss && (meta.swissRounds === null || meta.swissRounds < 1)) return null;
  const tableFx = i.fixtures.filter((f) => f.stage_id === i.stage.id && (f.pool_id ?? null) === i.poolId);
  if (tableFx.length === 0) return null;
  // Review Focus 3: a league seat still TBD cannot be counted per entrant.
  // (A Swiss round's unseated boards are shells; its remaining is round-based.)
  if (!isSwiss && tableFx.some((f) => !settled(f) && (f.home_entrant_id === null || f.away_entrant_id === null))) {
    return null;
  }

  // F2: the table's members are its snapshot rows AND everyone seated in its
  // fixtures. A seated member the snapshot never folded has unknown points
  // (a carry-over opening is folded only with results), so no status.
  const byId = new Map(i.rows.map((r) => [r.entrantId, r]));
  for (const f of tableFx) {
    for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id !== null && !byId.has(id)) return null;
  }
  // Snapshot lag: standings recompute after the scoring write commits, so a
  // row can trail its own fixtures. A row that has played fewer matches than
  // the table's fixtures say reads stale points. (More is fine: a "full"
  // carry-over folds prior matches into `played`.)
  for (const r of i.rows) {
    if (r.played < tableFx.filter((f) => seats(f, r.entrantId) && counted(f)).length) return null;
  }

  // F1 — departed entrants; an unreadable status fails closed.
  const active = new Map<string, boolean>();
  for (const r of i.rows) {
    const status = i.entrantStatuses[r.entrantId];
    if (status === undefined) return null;
    const inField = inTheField({ status });
    if (!inField && withdrawalVoidsResults(i.stage.id, i.stage.kind, r.entrantId, i.fixtures)) return null;
    active.set(r.entrantId, inField);
  }
  const cut = meta.qualifyCount;
  // F3: a cut that takes every row still playing is no contest.
  if (cut >= [...active.values()].filter(Boolean).length) return null;

  // P2: Swiss remaining = rounds declared − rounds with a SETTLED fixture
  // seating the entrant (a bye is one); seated-but-unplayed rounds are not
  // played. League/group: the unsettled fixtures seating the entrant.
  const remainingOf = (id: string): number =>
    isSwiss
      ? Math.max(0, meta.swissRounds! - new Set(tableFx.filter((f) => settled(f) && seats(f, id)).map((f) => f.round_no)).size)
      : tableFx.filter((f) => !settled(f) && seats(f, id)).length;

  const ordered = [...i.rows].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
  const engineFx: TableFixture[] = tableFx.map((f) => ({
    id: f.id,
    status: engineFixtureStatus(f.status),
    roundNo: f.round_no,
    ...(f.pool_id ? { poolId: f.pool_id } : {}),
  }));
  const engine: QualificationInput = {
    rows: ordered.map((r) => ({ entrantId: r.entrantId, points: r.points, active: active.get(r.entrantId) === true })),
    remaining: new Map(ordered.map((r) => [r.entrantId, remainingOf(r.entrantId)])),
    perMatch,
    cut,
    anyPlayed: tableFx.some(
      (f) => engineFixtureStatus(f.status) === "decided" && f.home_entrant_id !== null && f.away_entrant_id !== null,
    ),
    complete: isTableStageComplete(
      {
        id: i.stage.id,
        kind: i.stage.kind as "league" | "group" | "swiss",
        entrants: [],
        cascade: [],
        ...(isSwiss ? { rounds: meta.swissRounds! } : {}),
      },
      engineFx,
    ),
  };
  const result = qualificationStatus(engine);
  if (result === null) return null;

  const next = meta.nextStageName;
  const orderedIds = ordered.map((r) => r.entrantId);
  const cascade = i.cascade as readonly TiebreakerKey[];
  // What-if OQ1: `wins` cannot split a points tie when every point came from
  // wins at one rate — read from the bounds IN FORCE, and confirmed on the
  // table itself, since a carry-over opening pays points no match paid (the
  // carry mode is not public; `points = winFloor × won` on every row is).
  const winsOnly = perMatch.winsOnly && i.rows.every((r) => r.points === r.won * perMatch.winFloor);

  /** The entrant's next match has no opponent seat (T2-C1): a bye it cannot lose. */
  const nextIsBye = (id: string): boolean => {
    const upcoming = tableFx.filter((f) => !settled(f) && seats(f, id)).sort((a, b) => a.round_no - b.round_no);
    const first = upcoming[0];
    return first !== undefined && (first.home_entrant_id === null || first.away_entrant_id === null);
  };

  function whatIf(r: StandingsRow, status: QualStatus, ifYouLose: QualStatus | null): { text: string; assumption: string | null } | null {
    const rivalId = tieRival(engine, orderedIds, r.entrantId);
    const rival = rivalId === null ? undefined : byId.get(rivalId);
    if (!rival) return null;
    // The average match counts only matches with a ledger (T3-⚠3).
    const noLedger = tableFx.filter((f) => seats(f, r.entrantId) && counted(f) && ledgerless(f)).length;
    const w: TieWhatIf | null = tieWhatIf({ ...r, played: r.played - noLedger }, rival, cascade, { winsOnly });
    if (w === null) return null;
    const name = i.entrantNames[rival.entrantId] ?? rival.entrantId;
    const vars = { rival: name, rule: tieBreakRule(w.key, i.msg) };
    const assumption = i.msg("table.qual.whatIf.assumption", { rival: name });
    const rule = (): { text: string; assumption: null } => {
      const mine = tieKeyValue(r, w.key);
      const theirs = tieKeyValue(rival, w.key);
      return {
        text:
          mine !== null && theirs !== null
            ? i.msg("table.qual.whatIf.ruleValues", { ...vars, mine, theirs })
            : i.msg("table.qual.whatIf.rule", vars),
        assumption: null,
      };
    };
    if (w.kind === "rule") return rule();
    // The target assumes the rival's figures stay put — false when the two
    // meet next, so only the rule and today's values.
    const meetNext = tableFx.some((f) => !settled(f) && seats(f, r.entrantId) && seats(f, rival.entrantId));
    if (meetNext) return rule();
    if (w.kind === "safe") return { text: i.msg("table.qual.whatIf.safe", vars), assumption };
    // Which result leaves the two level on points: a win-and-in row ties only
    // by losing; a row a loss puts out ties only by winning. Otherwise unknown.
    const scenario = nextIsBye(r.entrantId)
      ? null
      : status.kind === "win_k" && status.k === 1
        ? "loss"
        : status.kind === "needs_help" && ifYouLose?.kind === "out"
          ? "win"
          : null;
    if (scenario === "win") {
      return w.margin >= 1
        ? { text: i.msg("table.qual.whatIf.winBy", { ...vars, m: w.margin }), assumption }
        : { text: i.msg("table.qual.whatIf.anyWin", vars), assumption };
    }
    if (scenario === "loss" && w.margin < 0) {
      return { text: i.msg("table.qual.whatIf.loseByAtMost", { ...vars, m: -w.margin }), assumption };
    }
    return rule();
  }

  const rows: Record<string, QualRowT> = {};
  ordered.forEach((r, position) => {
    const res = result.get(r.entrantId);
    if (!res) return;
    const label = statusLabel(res.status, i);
    const open = res.status.kind === "win_k" || res.status.kind === "needs_help";
    const w = open ? whatIf(r, res.status, res.ifYouLose) : null;
    rows[r.entrantId] = {
      status: res.status.kind,
      label,
      ariaLabel: i.msg("table.qual.rankLabel", { rank: r.rank ?? position + 1, status: label }),
      headline: headline(res.status, i, next, cut),
      ifYouLose:
        res.ifYouLose && !nextIsBye(r.entrantId)
          ? i.msg("table.qual.ifYouLose", { status: statusLabel(res.ifYouLose, i) })
          : null,
      whatIf: w?.text ?? null,
      whatIfAssumption: w?.assumption ?? null,
    };
  });

  const roundsLeft = Math.max(
    0,
    ...engine.rows.filter((r) => r.active).map((r) => engine.remaining.get(r.entrantId) ?? 0),
  );
  return {
    table: {
      cutIndex: cut,
      label:
        roundsLeft > 0
          ? i.plural("table.qual.cut", roundsLeft, { n: cut, next })
          : i.msg("table.qual.cutNoRounds", { n: cut, next }),
      legend: {
        through: i.msg("table.qual.legend.through"),
        open: i.msg("table.qual.legend.open"),
        out: i.msg("table.qual.legend.out"),
        hint: i.msg("table.qual.legend.hint"),
      },
    },
    rows,
  };
}
