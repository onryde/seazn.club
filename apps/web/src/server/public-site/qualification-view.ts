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
  FOR_KEYS,
  PointsRule,
  SETTLED_FIXTURE_STATUSES,
  isTableStageComplete,
  metricKeyOf,
  pointsRuleBounds,
  qualificationStatus,
  tieDecidingKey,
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

/** Does a walkover in this division's PINNED module add goals to the ledger?
 *  True exactly when its config declares a forfeit score (`awardScore`):
 *  football's and the period kernel's `core.forfeit` score `cfg.awardScore`
 *  as the match's goals, and `standingsDelta` folds them into gf/ga like any
 *  other match. Every other sport's award leaves the ledger alone. A cfg that
 *  does not parse gives false (and no bounds, so no status either). */
export function divisionAwardAddsToLedger(module_: AnySportModule | null | undefined, cfg: unknown): boolean {
  if (!module_) return false;
  const parsed = module_.configSchema.safeParse(cfg ?? {});
  if (!parsed.success || parsed.data === null || typeof parsed.data !== "object") return false;
  const award = (parsed.data as { awardScore?: { goals?: unknown } | null }).awardScore;
  return typeof award?.goals === "number" && award.goals > 0;
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
  /** The division's walkover writes goals into the ledger
   *  (`divisionAwardAddsToLedger`) — then a two-sided award counts toward the
   *  what-if's average match. The SPORT's forfeit score never reaches a
   *  one-sided bye. A stage PointsRule's `forfeit.awardScore` scores every
   *  walkover and bye, but only into `for`/`against`/`diff`: where the what-if
   *  reads those, the builder counts the award whatever this flag says
   *  (`ruleScoreInAverage`, read off `stage.meta.pointsRule`); elsewhere this
   *  flag decides. */
  awardAddsToLedger: boolean;
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

/** A counted match that adds nothing to the ledger the what-if reads
 *  (T3-⚠3): a no-result; and, unless a stage rule's forfeit score is in what
 *  the average reads (`ruleInAverage`, from `ruleScoreInAverage`), a one-sided
 *  bye (the adapter folds it from a fresh 0–0 state) or a two-sided award — a
 *  walkover — in a sport whose forfeit writes no score (`awardAddsToLedger`
 *  false; ice hockey's writes `awardScore` goals, so its walkover is an
 *  ordinary match here). The what-if's average match leaves these out. */
function ledgerless(f: QualFixture, awardAddsToLedger: boolean, ruleInAverage: boolean): boolean {
  const kind = outcomeKind(f);
  if (kind === "no_result") return true;
  if (kind !== "award") return false;
  if (ruleInAverage) return false;
  return isOneSidedAwardBye(f) || !awardAddsToLedger;
}

/** A stage PointsRule with a non-zero `forfeit.awardScore`: `applyPointsRule`
 *  adds it to for/against/diff on every forfeit, and the adapter applies the
 *  rule to a one-sided bye's delta as well (engine-db/competition.ts
 *  `awardByeDelta`) — so every award carries it, though only where the what-if
 *  reads those three keys does it count (`ruleScoreInAverage`). Read here, not
 *  by the caller: V414 publishes the rule as `meta.pointsRule`, and a caller
 *  cannot forget it. (A rule that does not parse never gets this far —
 *  `boundsInForce` refuses it.) */
function ruleScoresForfeits(meta: StageQualMeta): boolean {
  if (meta.pointsRule === null || meta.pointsRule === undefined) return false;
  const parsed = PointsRule.safeParse(meta.pointsRule);
  const score = parsed.success ? parsed.data.forfeit?.awardScore : undefined;
  return score !== undefined && (score[0] !== 0 || score[1] !== 0);
}

/** Whether a rule-scored award is in the what-if's average match for `row`
 *  (fix round 2): an award counts only if it changed the ledger the deciding
 *  key reads. The rule writes `for`/`against`/`diff` alone, so (1) the key
 *  must be `diff` or `for` — a ratio key reads its own won/lost counters —
 *  and (2) the row's goals must resolve to the rule's `for`, not a sport's
 *  own `gf` that `metricOf` reads first. For both keys the average match is
 *  for + against (tie-what-if.ts `marginFor`); `diff` only sets the margin,
 *  which `played` never touches — so (2) asks where FOR_KEYS lands. */
function ruleScoreInAverage(row: StandingsRow, key: TiebreakerKey | null): boolean {
  if (key !== "diff" && key !== "for") return false;
  return metricKeyOf(row, FOR_KEYS) === "for";
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

/** What losing the next match leaves — one sentence per post-loss status
 *  (owner copy fix, 2026-09-23), never a status chip's words glued into a
 *  sentence ("If you lose your next match: Win and in."). `left` is the
 *  matches left AFTER that loss — the engine's own `r - 1` — so win_k reads as
 *  the engine means it: win `k` of those. Where `k` is all of them the
 *  sentence says so ("your last one", "all of your last 2"); otherwise it
 *  names both numbers, because "your last one" would claim a particular match.
 *
 *  `through` is unreachable from `buildQualificationView`: a loss moves the
 *  floor by the per-match min and takes one match away, so the worst case the
 *  through test reads is unchanged, and it was already not through (only the
 *  two open statuses get a loss case). It has a sentence all the same, so an
 *  engine change could never print a key. */
export function ifYouLoseSentence(
  s: QualStatus,
  left: number,
  i: Pick<QualificationViewInput, "msg" | "plural">,
): string {
  switch (s.kind) {
    case "through":
      return i.msg("table.qual.ifYouLose.through");
    case "win_k":
      return s.k >= left
        ? i.plural("table.qual.ifYouLose.winAll", left)
        : i.plural("table.qual.ifYouLose.winKOf", s.k, { r: left });
    case "needs_help":
      return i.msg("table.qual.ifYouLose.needsHelp");
    case "out":
      return i.msg("table.qual.ifYouLose.out");
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
      // Pluralised on N (final review COPY): "…in the top 1" read badly.
      return i.plural("table.qual.headline.out", n, { n });
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
 *  can be trusted. Award mode only walks pending matches over: each is one of
 *  the departed row's unplayed fixtures, which its `remaining` already bounds
 *  with the per-match [min, max] (and each rival's likewise), so the walkover
 *  moves nobody outside their bounds. An expunge with nothing played left to
 *  void changes nothing. */
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
  const ruleScored = ruleScoresForfeits(meta);

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
  // (a carry-over opening is folded only with results), so no status. That
  // includes a DEPARTED member: a status-only leaver (a registrant's
  // self-cancel moves only the entrant status) keeps its place, and its
  // carried points fold in the moment any of its fixtures gets a result — so
  // a frozen guess could turn a Through false. Pools fail closed until every
  // member has a result (owner-accepted, fix round 2).
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
  //
  // A DEPARTED entrant is not frozen (final review I1): a status-only
  // departure (a DQ by PATCH with no cascade, a registrant's self-cancel)
  // leaves its fixtures scheduled, and a later forfeit pays it the loser's
  // points — above 0 where a loss pays, below 0 under `forfeit.loserPoints`.
  // So its remaining is its unplayed fixtures here, which the engine bounds
  // with the full per-match [min, max] like any row's (the organiser may also
  // score them). Once they are walked over or voided it is 0. In Swiss that is
  // the boards it already sits on, never the rounds formula: pairing seats
  // only the field (usecases/stages.ts generateStageFixturesWrite's `active`
  // read), so no later round will seat it.
  const unplayed = (id: string): number => tableFx.filter((f) => !settled(f) && seats(f, id)).length;
  const remainingOf = (id: string): number =>
    isSwiss && active.get(id) === true
      ? Math.max(0, meta.swissRounds! - new Set(tableFx.filter((f) => settled(f) && seats(f, id)).map((f) => f.round_no)).size)
      : unplayed(id);

  const ordered = [...i.rows].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
  const engineFx: TableFixture[] = tableFx.map((f) => ({
    id: f.id,
    status: engineFixtureStatus(f.status),
    roundNo: f.round_no,
    ...(f.pool_id ? { poolId: f.pool_id } : {}),
  }));
  // Departed rows stay in `rows` as rivals (active: false), so the engine's
  // Out counts them among the entrants already beyond a row (final review
  // M3). That rests on a product rule decided elsewhere: a departed qualifier
  // still takes her place above the line — her seat is left empty and nobody
  // below is promoted into it (usecases/stages.ts computeSeedProposal, the
  // "owner decision pending" comment on the departed filter). If that changes
  // and the next entrant is promoted, a departed row above the line no longer
  // takes a place, and Out must stop counting departed rows or it prints a
  // false Out. (Through stays sound either way: an extra rival only makes it
  // more cautious.)
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
  const decidingKey = tieDecidingKey(cascade, { winsOnly });

  /** The entrant's next match has no opponent seat (T2-C1): a bye it cannot lose. */
  const nextIsBye = (id: string): boolean => {
    const upcoming = tableFx.filter((f) => !settled(f) && seats(f, id)).sort((a, b) => a.round_no - b.round_no);
    const first = upcoming[0];
    return first !== undefined && (first.home_entrant_id === null || first.away_entrant_id === null);
  };

  function whatIf(r: StandingsRow, status: QualStatus, ifYouLose: QualStatus | null): { text: string; assumption: string | null } | null {
    // A rival still playing (review fix 1): a departed row across the line is
    // skipped, and when only departed rows are in reach there is no what-if.
    const rivalId = tieRival({ ...engine, rows: engine.rows.filter((x) => x.active) }, orderedIds, r.entrantId);
    const rival = rivalId === null ? undefined : byId.get(rivalId);
    if (!rival) return null;
    // The average match counts only matches with a ledger (T3-⚠3).
    const ruleInAverage = ruleScored && ruleScoreInAverage(r, decidingKey);
    const noLedger = tableFx.filter((f) => seats(f, r.entrantId) && counted(f) && ledgerless(f, i.awardAddsToLedger, ruleInAverage)).length;
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
    // Every reading below is ONE match's worth (the average match, one heavy
    // defeat). With two or more left the tying result is no single match, so
    // the rule and today's values only (review fix 1).
    if (engine.remaining.get(r.entrantId) !== 1) return rule();
    // The target assumes the rival's figures stay put — false when the two
    // meet next, so only the rule and today's values.
    const meetNext = tableFx.some((f) => !settled(f) && seats(f, r.entrantId) && seats(f, rival.entrantId));
    if (meetNext) return rule();
    if (w.kind === "safe") return { text: i.msg("table.qual.whatIf.safe", vars), assumption };
    // Which result leaves the two level on points: a win-and-in row ties only
    // by losing; a row a loss puts out ties only by winning. Otherwise unknown.
    // (With one match left, the gate above, a Win k row is always k = 1.)
    const scenario = nextIsBye(r.entrantId)
      ? null
      : status.kind === "win_k"
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
          ? ifYouLoseSentence(res.ifYouLose, (engine.remaining.get(r.entrantId) ?? 0) - 1, i)
          : null,
      whatIf: w?.text ?? null,
      whatIfAssumption: w?.assumption ?? null,
    };
  });

  const roundsLeft = Math.max(
    0,
    ...engine.rows.filter((r) => r.active).map((r) => engine.remaining.get(r.entrantId) ?? 0),
  );
  // Two plurals, two keys (final review COPY): the cut sentence agrees with N
  // ("First place goes…" / "Top 2 go…"), the rounds left with the rounds.
  // One key pluralised on the rounds printed "Top 1 go through".
  const cutLine = i.plural("table.qual.cut", cut, { n: cut, next });
  return {
    table: {
      cutIndex: cut,
      label: roundsLeft > 0 ? `${cutLine} · ${i.plural("table.qual.roundsLeft", roundsLeft)}` : cutLine,
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
