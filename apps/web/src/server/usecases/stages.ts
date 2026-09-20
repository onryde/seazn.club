import "server-only";
// Stage use-cases (doc 08 §3): define the stage graph, generate fixtures
// (idempotent — regeneration diffs against what exists, keyed by the pure
// generator's stable ids), guarded completion, standings reads.
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, withTenant } from "@/lib/db";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { HttpError } from "@/lib/errors";
import { ROSTER_DRIFT_INELIGIBLE_KINDS, isRosterDriftEligible } from "@/lib/roster-drift-eligibility";
import { assertWithinLimit, getLimit, requireFeature } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { assertNotFrozen, frozenCompetitionIds } from "./entitlement-freeze";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "./format-gates";
import { EngineError } from "@seazn/engine/core";
import {
  generateRoundRobin,
  generateSingleElim,
  generateDoubleElim,
  generatePagePlayoff,
  generateStepladder,
  type BracketFixtureGen,
  type GeneratedBracket,
  validateFeedGraph,
  generateAmericano,
  pairMexicanoRound,
  pairRound,
  pairKey,
  type AmericanoRound,
  type SwissStanding,
  type Colour,
} from "@seazn/engine/scheduling";
import {
  PointsRule,
  carryDeltas,
  placementTable,
  progressionSize,
  resolveProgression,
  validatePointsRule,
  type BracketFixture,
  type FixtureStatus,
  type PoolTable,
  type ProgressionSpec,
  type SourceShape,
  type SourceTables,
  type StandingsRow,
  type TakeRule,
} from "@seazn/engine/competition";
import { completeStageIfReady, recomputeStandings, type CompleteResult } from "@/server/engine-db";
import { resolveModule } from "@/server/engine-db";
// L3/#414 pass 3 — not re-exported through the engine-db barrel (index.ts),
// but these two ARE exported from the module itself (pass 2); reuse them
// rather than re-deriving lane/thirdPlace from round/position (never
// arithmetic — see parseExtKey's own comment).
import { parseExtKey, bracketWinnerLoser, rankedStageStandings } from "@/server/engine-db/competition";
import {
  isSwissBoardSeated,
  latestSeatedSwissRound,
  nextUnseatedSwissRound,
  planSwissShells,
  swissRoundHasPlayedResult,
  SWISS_ROUNDS_REQUIRED_CODE,
  SWISS_ROUNDS_REQUIRED_MESSAGE,
} from "@/lib/swiss-shell";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";
import { personalPointsLeaderboard } from "./americano";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages, ProgressionInput } from "@/server/api-v1/schemas";
import { z } from "zod";
import { CreateStage } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { msg } from "@/lib/messages";
import { resolveSlotLabel } from "@/lib/slot-label";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { afterScheduleWrite, validateSchedule, courtNamesById, courtVenueIds, divisionLockState } from "./schedule";
import { schedulePlayerStatsRefresh } from "./player-stats-refresh";
// The division freeze (`divisions.schedule_locked`), said the same way here as
// at every other refusing site. IMPORT the constants, never retype the
// sentence: `lib/schedule-lock.ts`'s own comment makes the import graph the
// live enumeration of which paths refuse, so a hand-copied literal here would
// be invisible to `grep -rn SCHEDULE_LOCKED_MESSAGE apps/web/src`.
//
// NOT to be confused with either of the two other "frozen"s this file already
// carries: `assertNotFrozen`/`frozenCompetitionIds` above is the BILLING
// freeze on a competition, and every `schedule_locked` in the select lists and
// row types below is `fixtures.schedule_locked`, the per-FIXTURE pin. Three
// unrelated meanings, one word.
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
// #8 sibling fix: reuse the SAME not-found codes `venues.ts` already
// throws for a bad court_id/venue_id, instead of minting new ones, so
// addFixture's error is indistinguishable from every other "not a real
// court/venue in this org" 404 in the product.
import { VENUE_NOT_FOUND_CODE, COURT_NOT_FOUND_CODE } from "./venues";
import {
  descriptorKey,
  descriptorLabel,
  destinationSlotsBySeed,
  expandSources,
  expandTake,
  placeDescriptors,
  resolveProgressionSource,
  sourceShapeOf,
  sourcesToTables,
  standingsHash,
  poolTableRowsAcrossSources,
  validateStageProgression,
  type SlotDescriptor,
  type SlotLabel,
} from "./stage-seeding";

type Tx = postgres.TransactionSql;
type StageInput = z.infer<typeof CreateStage>;

export interface StageRow {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  /** F2 — the union of the old `qualification` (auto-seed-on-complete) and
   *  `seeding` (propose/confirm-at-setup) columns; `null` for a stage with no
   *  upstream source (a division's first stage). `progression.timing`
   *  ("setup" | "on_complete") is the axis that used to be implicit in
   *  "which column is set" — see @seazn/engine/competition's ProgressionSpec
   *  and this session's F2 plan, Decision 1. */
  progression: Record<string, unknown> | null;
  status: string;
}

const STAGE_COLS = ["id", "division_id", "seq", "kind", "name", "config", "progression", "status"] as const;

// P9 pass 3c-2: `court_id`/`venue_id` added as the real identity, documented
// here for parity with BOARD_FIXTURE_COLS below. The three `FIXTURE_COLS`
// readers in this file (and the two in usecases/fixtures.ts) no longer
// interpolate this array directly with `tx(FIXTURE_COLS)` — `court_name`/
// `venue_name` are DERIVED (left join courts/venues), which a flat
// unaliased column list can't express — so each of those selects is
// hand-written instead. This array stays the source-of-truth column list.
export const FIXTURE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "fixture_no",
  "home_entrant_id", "away_entrant_id", "home_slot_label", "away_slot_label",
  "scheduled_at", "venue", "court_label", "court_id", "venue_id",
  "officials", "status", "outcome", "schedule_source", "schedule_locked", "created_at",
  "ext_key", "lane", "is_final", "third_place", "conditional",
] as const;

/** F1 follow-up (2026-08-17, payload-budget regression — board-v3.spec.ts
 *  "gap 15" reds on PR #606, expect flightBytes-dictBytes < 250000, got
 *  279043): the schedule board (competition-wide AND single-division)
 *  never renders ext_key/lane/is_final/third_place/conditional — only the
 *  division page's bracket/stages panel does (StagesPanel/BracketPanel,
 *  fed by the full FIXTURE_COLS read via listDivisionFixtures above).
 *  Shipping those five columns to a board that reads none of them cost
 *  ~88 escaped bytes/fixture on the RSC flight — invisible on one
 *  division, ~29KB over budget at a 5-division x 66-fixture board.
 *  listDivisionFixturesForBoard (fixtures.ts) selects this instead.
 *  ext_key's exclusion isn't new scope creep, either — board/settings-
 *  panel.tsx already documented (pre-dating this branch) that "the page's
 *  fetched fixture list never carries ext_key" as a design invariant for
 *  its capacity precheck; this restores that invariant rather than
 *  breaking new ground. Same as FIXTURE_COLS minus those five columns —
 *  keep the two in sync by hand if FIXTURE_COLS's other columns change. */
/** P9: what the BOARD actually receives — identity, no derived names and no
 *  frozen legacy text. The board resolves display names client-side from the
 *  venues prop; sending them per row duplicated ~330 rows' worth of bytes.
 *  Distinct from `FixtureRow` (GET/PATCH /fixtures/{id}), which DOES carry the
 *  derived names because its consumers have no venue list to resolve from. */
export type BoardFixtureRow = Omit<
  FixtureRow,
  "venue" | "court_label" | "court_name" | "venue_name" | "venue_id"
>;

export const BOARD_FIXTURE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "fixture_no",
  "home_entrant_id", "away_entrant_id", "home_slot_label", "away_slot_label",
  "scheduled_at", "venue", "court_label", "court_id", "venue_id",
  "officials", "status", "outcome", "schedule_source", "schedule_locked", "created_at",
] as const;

export interface FixtureRow {
  id: string;
  stage_id: string;
  division_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  /** Per-division ordinal (PROMPT-30) — the /f/[no] URL segment. */
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4a (P5) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null; cleared on fill. */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  /** P9 pass 3c-2: DERIVED from `courts`/`venues` via `court_id`/`venue_id` —
   *  the real identity. `venue`/`court_label` above are the FROZEN text
   *  columns (no longer written anywhere since pass 3a); they stay on this
   *  general row shape only for callers not yet migrated off them. Never
   *  render `venue`/`court_label` in new code — render `venue_name`/
   *  `court_name` (fall back to the id if a lookup somehow misses). */
  court_id: string | null;
  court_name: string | null;
  venue_id: string | null;
  venue_name: string | null;
  officials: unknown[];
  status: string;
  outcome: unknown;
  schedule_source: "none" | "auto" | "manual" | "ai";
  schedule_locked: boolean;
  created_at: string;
  /** Generator-stable id (idempotent regeneration key). Also the ONE place
   *  a page-playoff fixture's Qualifier-1-vs-Eliminator identity survives —
   *  both share a round and a match count (F1 Task 4). Optional (like the
   *  four fields below), not because a real row can lack one — FIXTURE_COLS
   *  always selects it — but because dozens of pre-existing tests hand-build
   *  a FixtureRow-shaped literal that predates this field (the same
   *  precedent ScheduleSolverInfo's later fields already established:
   *  required would break every one of those literals without a full
   *  apps/web typecheck to find them all). */
  ext_key?: string | null;
  /** F1 (2026-08-17): the engine's bracket-position role, persisted instead
   *  of re-derived per consumer (db/migration/deltas/V368__fixture_round_role.sql).
   *  `lane` is null for single-lane brackets and non-bracket stages. */
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
}

export async function listStages(auth: AuthCtx, divisionId: string): Promise<StageRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where division_id = ${divisionId} order by seq`;
  });
}

/** Define (part of) the stage graph for a division. */
/**
 * D2a (design 2026-09-17 §T3) — `rules` is NOT settable through a stage-config
 * body. `PUT /stages/{id}/rules` is the only writer, and it is the only path
 * carrying the per-sport allowlist, the sets-based sport gate and the
 * merged-config parse. This door has to be shut explicitly because
 * `createStages` never parses stage config through any `configSchema`, and the
 * custom-points paywall reads `s.config.points`, never `s.config.rules.points`
 * — so a football division could otherwise smuggle shoot-out points (a shape
 * `SPORT_RULES.football` genuinely emits) straight past the entitlement.
 */
export function assertConfigCarriesNoRules(config: Record<string, unknown> | null | undefined): void {
  if (config && "rules" in config)
    throw new HttpError(
      400,
      "per-stage match rules are set through PUT /stages/{id}/rules",
      "RULES_NOT_ACCEPTED_HERE",
    );
}

function assertNoRulesKey(inputs: readonly StageInput[]): void {
  for (const s of inputs) assertConfigCarriesNoRules(s.config);
}

/**
 * A swiss stage declares its round budget at create time, or it is not created
 * (owner ruling 2026-09-20).
 *
 * `swissGen` (this file, the `CONFIG_INVALID` throw) refuses the same shapes,
 * and correctly so — a Swiss round count is a format decision fixed before
 * play, never something the system guesses mid-tournament. But it fires at
 * GENERATE, so before this guard an invalid stage was creatable over the API
 * and the organiser met a 500 later, on a screen that had nothing to do with
 * the mistake. This is the same refusal at the door; the engine throw stays as
 * the last line of defence for a row written around the usecase.
 *
 * `swiss` is the only `StageKind` involved. `swiss_playoff` / `swiss_knockout`
 * are TEMPLATE keys (components/v2/format-templates.ts) that each BUILD a
 * `swiss` stage plus a bracket stage — checking them here would test a value
 * `kind` can never hold.
 *
 * The predicate is spelled out rather than shared with `swissGen`'s: that one
 * is an engine-layer `EngineError` on a persisted config, this one an
 * `HttpError` on request input, and a test in swiss-shell-fixtures.test.ts
 * enumerates every refused shape against both so they cannot drift.
 */
function assertSwissRoundsDeclared(inputs: readonly StageInput[]): void {
  for (const s of inputs) {
    if (s.kind !== "swiss") continue;
    const rounds = (s.config as { rounds?: unknown } | null | undefined)?.rounds;
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
      throw new HttpError(422, SWISS_ROUNDS_REQUIRED_MESSAGE, SWISS_ROUNDS_REQUIRED_CODE);
    }
  }
}

export async function createStages(
  auth: AuthCtx,
  divisionId: string,
  input: CreateStages,
): Promise<StageRow[]> {
  const inputs: StageInput[] = Array.isArray(input) ? input : [input];
  assertNoRulesKey(inputs);
  assertSwissRoundsDeclared(inputs);
  // Format gates honour an Event Pass on this division's competition
  // (v3/07 §3), so resolve the competition before gating.
  const [divComp] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  // Doc 10 §1: `formats.double_elim` is Pro — gate before any insert.
  if (inputs.some((s) => stageNeedsDoubleElimGate(s.kind))) {
    await requireFeature(auth.orgId, "formats.double_elim", divComp?.competition_id);
  }
  // Jul3/08 §8: new kinds + custom byes + cross-stage feeds + placements are
  // the advanced-formats Pro layer; basic RR/KO/group+KO stays Community.
  // Shared with createFromTemplate (usecases/templates.ts, D1a) via
  // usecases/format-gates.ts — see that file's header for why it's a
  // standalone module rather than this usecase calling the other.
  const advanced = inputs.some((s) => stageNeedsAdvancedFormatsGate({ kind: s.kind, config: s.config }));
  if (advanced) await requireFeature(auth.orgId, "formats.advanced", divComp?.competition_id);
  // Jul3/08 §9: the cross-stage feed graph must be a DAG (fail closed).
  {
    const edges: { from: string; to: string }[] = [];
    for (const s of inputs) {
      const feeds = (s.config as { cross_feeds?: { to_stage_seq: number }[] } | undefined)
        ?.cross_feeds;
      for (const f of feeds ?? []) {
        edges.push({ from: String(s.seq), to: String(f.to_stage_seq) });
      }
      if (s.progression !== undefined && s.progression !== null) {
        // progression always flows from an earlier stage (every source names one)
        edges.push({ from: String(s.seq - 1), to: String(s.seq) });
      }
    }
    validateFeedGraph(edges);
  }
  // Jul3/05 §7: base win/draw/loss numbers are free; bonuses + forfeit points
  // + circular-H2H + carry-over are the Pro layer.
  for (const s of inputs) {
    const cfg = s.config as { points?: unknown; h2h_scope?: string } | undefined;
    if (cfg?.points !== undefined) {
      const rule = PointsRule.parse(cfg.points);
      if (rule.bonuses.length > 0 || rule.forfeit !== undefined) {
        await requireFeature(auth.orgId, "standings.custom_points");
      }
    }
    if (cfg?.h2h_scope === "overall") {
      await requireFeature(auth.orgId, "tiebreakers.custom");
    }
    if (s.progression?.carry !== undefined && s.progression.carry !== "none") {
      await requireFeature(auth.orgId, "standings.carry_over");
    }
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  // V393 lifts this cap on an Event Pass (community 2 -> event_pass 4), and the
  // pass overlay only applies when a competition is in scope — `divComp` is
  // already resolved above for the format gates, so the same id gates the cap.
  const stageCap = await getLimit(auth.orgId, "stages.per_division.max", divComp?.competition_id);
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string; sport_key: string; module_version: string }[]>`
      select competition_id, sport_key, module_version from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // fail closed (Jul3/05 §8): a points rule needing metrics the sport
    // doesn't emit never reaches play
    for (const s of inputs) {
      const cfg = s.config as { points?: unknown } | undefined;
      if (cfg?.points !== undefined) {
        const sportModule = resolveModule(division.sport_key, division.module_version);
        validatePointsRule(PointsRule.parse(cfg.points), sportModule.metrics);
      }
    }
    assertNotFrozen(frozen, division.competition_id);

    // Doc 10 §1: `stages.per_division.max` (2/4/∞) — the batch must fit,
    // counted in the same tx as the inserts (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from stages where division_id = ${divisionId}`;
    assertWithinLimit(stageCap, "stages.per_division.max", n + inputs.length);

    const rows: StageRow[] = [];
    for (const s of inputs) {
      const [dupe] = await tx`
        select 1 from stages where division_id = ${divisionId} and seq = ${s.seq}`;
      if (dupe) throw new HttpError(409, `stage seq ${s.seq} already exists`);
      const [row] = await tx<StageRow[]>`
        insert into stages (division_id, seq, kind, name, config, progression)
        values (${divisionId}, ${s.seq}, ${s.kind}, ${s.name}, ${tx.json(s.config as never)},
                ${s.progression ? tx.json(s.progression as never) : null})
        returning ${tx(STAGE_COLS)}`;
      rows.push(row);
    }
    // Progression rules validated AFTER every stage in this batch is
    // inserted, so `source: "previous"` / `{stageId}` resolves against
    // sibling stages in THIS batch too, regardless of input array order (resolution is by seq,
    // not insertion order) — a bad seeded_map or an unreachable source 422s
    // here at rule-save time, never discovered later at proposal time
    // (design's Edge inventory).
    for (const s of inputs) {
      if (!s.progression) continue;
      const row = rows.find((r) => r.seq === s.seq)!;
      await validateStageProgression(tx, row, s.progression);
    }
    // Adding a stage to a completed division (e.g. finals after the league
    // wrapped the graph) reopens it — 'completed' must mean "nothing left".
    await tx`
      update divisions set status = 'active'
      where id = ${divisionId} and status = 'completed'`;
    return rows;
  });
}

/** Replace the division's whole stage graph (v8 Settings → Format: League /
 *  Knockout / Groups + Knockout…). Allowed only while no stage owns fixtures
 *  — the same FORMAT_LOCKED rule as patchDivision's variant/config guard.
 *  Delete + recreate runs as two steps (createStages owns its validation and
 *  tx); a failed create leaves the division stage-less, recoverable exactly
 *  like the manual Fixtures-tab delete-then-add flow. */
export async function replaceStages(
  auth: AuthCtx,
  divisionId: string,
  input: CreateStages,
): Promise<StageRow[]> {
  // BEFORE the delete below, not merely inside the `createStages` this
  // delegates to: that call runs in its own transaction, so a refusal there
  // would land after this function had already dropped every stage in the
  // division. The swiss round-count guard rides along for the same reason —
  // this is the PUT the Format tab's Apply calls, so a bad round count would
  // otherwise cost the organiser their whole stage graph.
  assertNoRulesKey(Array.isArray(input) ? input : [input]);
  assertSwissRoundsDeclared(Array.isArray(input) ? input : [input]);
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const carried = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [locked] = await tx`
      select 1 from fixtures f join stages s on s.id = f.stage_id
      where s.division_id = ${divisionId} limit 1`;
    if (locked) {
      throw new HttpError(409, "Format is locked — fixtures exist", "FORMAT_LOCKED");
    }
    // Per-stage match-rules overrides survive the delete (design 2026-09-17,
    // owner ruling 2026-09-18). The Format tab's Apply is a delete-and-recreate
    // from the template body, and that body cannot carry `rules` — the guard
    // above refuses it, because a stage-config body is not a path that
    // validates one. So the carry-forward has to happen HERE, server-side,
    // rather than by asking the client to re-issue a PUT afterwards: it then
    // holds for every caller of this function, not just the one screen we
    // happened to fix.
    const rows = await tx<{ seq: number; kind: string; config: Record<string, unknown> }[]>`
      select seq, kind, config from stages where division_id = ${divisionId}`;
    const keep = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const rules = r.config?.rules;
      // Keyed on seq AND kind. A format override belongs to a stage SLOT, and
      // "the knockout is Best-of-5" does not mean "whatever now sits at seq 2
      // is Best-of-5" — an Apply that turns seq 2 from knockout into league is
      // a different competition shape, and silently dressing the new stage in
      // the old stage's format is the kind of invisible carry nobody audits.
      // Dropping it makes the organiser set it again, which is a visible,
      // correctable state; carrying it wrongly is not. Note this is a
      // JUDGEMENT, not a validity constraint: the allowlist is per SPORT and
      // the sport cannot change here, so a carried fragment would still pass
      // every guard. That is exactly why the rule has to be written down.
      if (rules !== null && rules !== undefined) keep.set(`${r.seq}:${r.kind}`, rules as Record<string, unknown>);
    }
    await tx`delete from stages where division_id = ${divisionId}`;
    return keep;
  });
  const created = await createStages(auth, divisionId, input);
  if (carried.size > 0) {
    await withTenant(auth.orgId, async (tx) => {
      for (const stage of created) {
        const rules = carried.get(`${stage.seq}:${stage.kind}`);
        if (rules === undefined) continue;
        // Server-side merge (§T2), same shape as every other writer of this
        // column: the row was just inserted by createStages, so this adds the
        // key back without re-writing anything createStages decided.
        await tx`
          update stages set config = config || ${tx.json({ rules } as never)}
           where id = ${stage.id}`;
        stage.config = { ...stage.config, rules };
      }
    });
  }
  return created;
}

/**
 * Delete a stage (organiser added it by mistake). Only the last stage of the
 * graph is deletable — removing a middle stage would orphan the qualification
 * chain — and never one with played fixtures (in_play / decided / finalized).
 * Bye/walkover awards ('forfeited') don't block: every fresh knockout with a
 * non-power-of-two field holds them. Pools, fixtures, snapshots go via
 * ON DELETE CASCADE.
 */
export async function deleteStage(auth: AuthCtx, stageId: string): Promise<{ deleted: true }> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const divisionId = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { id: string; division_id: string; seq: number; kind: string; name: string; competition_id: string }[]
    >`
      select s.id, s.division_id, s.seq, s.kind, s.name, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    assertNotFrozen(frozen, stage.competition_id);
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // Deleting a stage is the widest board write in this file: pools, fixtures
    // and snapshots go with it via ON DELETE CASCADE. A frozen division
    // refuses it, on the same terms and with the same code as every other
    // board write (applySchedule, moveFixture, clearScheduleScoped, …).
    //
    // AFTER the existence check, deliberately: `divisionLockState` returns
    // `frozen: row?.schedule_locked ?? false`, so a missing row reads as
    // UNFROZEN — a guard placed above the 404 would not refuse an unknown
    // stage, it would merely turn its 404 into a 422 on the divisions this
    // one happens to belong to. AFTER the advisory lock too, matching
    // `applySchedule`/`moveFixture`: the freeze is read under the same lock
    // the delete below runs under, so a concurrent unfreeze cannot land
    // between the read and the write.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    const [later] = await tx`
      select 1 from stages where division_id = ${stage.division_id} and seq > ${stage.seq} limit 1`;
    if (later) {
      throw new HttpError(409, "only the last stage can be deleted — remove later stages first");
    }
    const [played] = await tx`
      select 1 from fixtures
      where stage_id = ${stageId} and status in ('in_play', 'decided', 'finalized') limit 1`;
    if (played) {
      throw new HttpError(409, "stage has played fixtures and cannot be deleted");
    }

    // R10e (found): the stage's fixtures go in their own statement, ahead of
    // the stage row, so this write names the fixtures it removed. Left to the
    // stage's ON DELETE CASCADE they went unnamed; the rows removed are the
    // same either way (pools and snapshots still cascade from the stage).
    // `scored`: the fixture carried score events (an abandoned or cancelled
    // match, or a walkover), which cascade away with it. Every part of a
    // data-modifying WITH reads the same snapshot, so the outer select still
    // sees the rows the delete removes.
    const removed = await tx<{ id: string; scored: boolean }[]>`
      with gone as (delete from fixtures where stage_id = ${stageId} returning id)
      select gone.id, exists (select 1 from score_events se where se.fixture_id = gone.id) as scored
      from gone`;
    await tx`delete from stages where id = ${stageId}`;

    // Structural ledger + division watermark (same pattern as stage_seeded).
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${stage.division_id}, ${last + 1}, 'stage_deleted',
              ${tx.json({ stageId, kind: stage.kind, name: stage.name, seq: stage.seq } as never)})`;
    await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;

    return {
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
      fixtureIds: removed.map((row) => row.id),
      scoredFixtureRemoved: removed.some((row) => row.scored),
    };
  });
  // R10e (found): a stage delete takes its fixtures off the hub and out of any
  // open match centre. `afterScheduleWrite` fires the division revalidate this
  // call used to fire alone, then drops the hub key and the removed fixtures'
  // keys in one DEL after the commit and pushes after it. Always sent: the
  // stage itself is gone from the hub even when it held no fixture.
  afterScheduleWrite(divisionId.divisionId, divisionId.competitionId, "schedule", divisionId.fixtureIds);
  // A removed fixture's score events went with it, so the division's player
  // stats still count them until they are refolded (review m3).
  if (divisionId.scoredFixtureRemoved) schedulePlayerStatsRefresh(auth.orgId, { divisionId: divisionId.divisionId });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Fixture generation (doc 08 §3 — idempotent, returns diff)
// ---------------------------------------------------------------------------

// A generator fixture normalised for persistence, identity = ext_key (the pure
// generator's stable id, spec 05 §6 — regeneration is byte-identical).
// ---------------------------------------------------------------------------
// Americano / Mexicano (Jul3/08 §3, 21 May): individuals rotate partners; the
// stage creates `pair` entrants on the fly for each fixture. Americano is a
// fixed seeded rotation generated upfront; mexicano derives each next round
// from the current per-person points (rank-quartet pairing).
// ---------------------------------------------------------------------------

/**
 * Resolve (or create) the `pair` entrants for a set of person pairs in one
 * batch — an americano stage references dozens of pairs per generate, so a
 * per-pair lookup/insert is a round-trip storm over a pooled connection.
 * Returns a map keyed by the sorted person ids joined with "," → entrant id.
 */
async function pairEntrantsFor(
  tx: Tx,
  divisionId: string,
  pairs: [string, string][],
): Promise<Map<string, string>> {
  const byPair = new Map<string, string>();
  const wanted = new Map<string, [string, string]>();
  for (const p of pairs) {
    const sorted = [...p].sort() as [string, string];
    wanted.set(sorted.join(","), sorted);
  }
  if (wanted.size === 0) return byPair;

  const existing = await tx<{ id: string; members: string[] }[]>`
    select e.id, array_agg(em.person_id order by em.person_id) as members
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId} and e.kind = 'pair'
    group by e.id`;
  for (const row of existing) {
    const key = row.members.join(",");
    if (wanted.has(key) && !byPair.has(key)) byPair.set(key, row.id);
  }

  const missing = [...wanted.entries()].filter(([key]) => !byPair.has(key));
  if (missing.length === 0) return byPair;

  const personIds = [...new Set(missing.flatMap(([, pair]) => pair))];
  const names = await tx<{ id: string; full_name: string }[]>`
    select id, full_name from persons where id in ${tx(personIds)}`;
  const nameOf = new Map(names.map((n) => [n.id, n.full_name]));

  // Ids are generated client-side so both inserts go out as one multi-row
  // statement each, without relying on RETURNING order.
  const entrantRows = missing.map(([, sorted]) => ({
    id: randomUUID(),
    division_id: divisionId,
    kind: "pair",
    display_name: sorted.map((id) => nameOf.get(id) ?? id).join(" / "),
  }));
  await tx`insert into entrants ${tx(entrantRows)}`;
  const memberRows = missing.flatMap(([, sorted], i) =>
    sorted.map((personId) => ({
      entrant_id: entrantRows[i].id,
      person_id: personId,
      is_captain: false,
    })),
  );
  await tx`insert into entrant_members ${tx(memberRows)}`;
  missing.forEach(([key], i) => byPair.set(key, entrantRows[i].id));
  return byPair;
}

async function americanoGen(
  tx: Tx,
  divisionId: string,
  stageId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
): Promise<GenFixture[]> {
  // players = the PERSONS behind the individual entrants
  const entrantIds = entrants.map((e) => e.id);
  if (entrantIds.length === 0) return [];
  const memberRows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members
    where entrant_id in ${tx(entrantIds)}`;
  const personOf = new Map(memberRows.map((r) => [r.entrant_id, r.person_id]));
  const players = entrantIds
    .map((id) => personOf.get(id))
    .filter((p): p is string => p !== undefined);
  if (players.length < 4) {
    throw new EngineError("STAGE_NOT_READY", "americano needs at least 4 individual players with linked persons", {
      players: players.length,
    });
  }
  const mode = cfg.mode === "mexicano" ? "mexicano" : "americano";
  const courtCount =
    typeof cfg.courtCount === "number" ? cfg.courtCount : Math.max(1, Math.floor(players.length / 4));
  const rounds = typeof cfg.rounds === "number" ? cfg.rounds : Math.max(3, players.length - 1);

  let planned: AmericanoRound[];
  if (mode === "americano") {
    planned = generateAmericano(players, { mode, courtCount, rounds });
  } else {
    // mexicano: next round only once every prior fixture decided
    const existing = await tx<{ round_no: number; status: string }[]>`
      select round_no, status from fixtures where stage_id = ${stageId}`;
    const playedRounds = existing.length > 0 ? Math.max(...existing.map((f) => f.round_no)) : 0;
    if (existing.some((f) => f.status !== "decided")) return []; // wait
    if (playedRounds >= rounds) return [];
    // per-person points: sum of each player's pair score across decided games
    const scores = await tx<{ person_id: string; pts: number }[]>`
      select em.person_id, coalesce(sum(
        case when f.home_entrant_id = em.entrant_id
             then (m.state->'score'->>'home')::numeric
             else (m.state->'score'->>'away')::numeric end), 0) as pts
      from fixtures f
      join match_states m on m.fixture_id = f.id
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      where f.stage_id = ${stageId} and f.status = 'decided'
      group by em.person_id`;
    const pts = new Map(scores.map((r) => [r.person_id, Number(r.pts)]));
    planned = [
      pairMexicanoRound(
        players.map((p) => ({ playerId: p, points: pts.get(p) ?? 0 })),
        { courtCount },
        playedRounds + 1,
      ),
    ];
  }

  const pairIds = await pairEntrantsFor(
    tx,
    divisionId,
    planned.flatMap((r) => r.matches.flatMap((m) => [m.team1, m.team2])),
  );
  const idFor = (p: [string, string]) => pairIds.get([...p].sort().join(","))!;
  const gen: GenFixture[] = [];
  for (const round of planned) {
    for (const m of round.matches) {
      gen.push({
        extKey: m.id,
        roundNo: m.roundNo,
        seqInRound: m.court,
        home: idFor(m.team1),
        away: idFor(m.team2),
      });
    }
  }
  return gen;
}

interface GenFixture {
  extKey: string;
  roundNo: number;
  seqInRound: number;
  home: string | null;
  away: string | null;
  homeFrom?: { extKey: string; side: "winner" | "loser" };
  awayFrom?: { extKey: string; side: "winner" | "loser" };
  award?: string; // bye: auto-advancing entrant
  poolId?: string; // group stages: which pool this fixture belongs to
  // F1 (round-role persistence): carried straight from BracketFixtureGen so
  // the generated round's ROLE survives insertion instead of being
  // re-derived from round_no/match-count by each consumer (design §2.3).
  lane?: "WB" | "LB" | "GF";
  isFinal?: boolean;
  thirdPlace?: boolean;
  conditional?: boolean;
}

interface ActiveEntrant {
  id: string;
  seed: number | null;
}

function bracketToGen(bracket: GeneratedBracket, laneDepth: number): GenFixture[] {
  // Per-(lane, round) counters give a stable seq_in_round in emission order.
  const counters = new Map<string, number>();
  const laneOffset = (f: BracketFixtureGen): number =>
    f.bracket === "LB" ? laneDepth : f.bracket === "GF" ? laneDepth * 2 : 0;
  return bracket.fixtures.map((f) => {
    const roundNo = laneOffset(f) + f.round + 1;
    const n = (counters.get(`${f.bracket ?? "WB"}:${roundNo}`) ?? 0) + 1;
    counters.set(`${f.bracket ?? "WB"}:${roundNo}`, n);
    return {
      extKey: f.id,
      roundNo,
      seqInRound: n,
      home: f.home ?? f.award ?? null,
      away: f.away ?? null,
      ...(f.homeFrom ? { homeFrom: { extKey: f.homeFrom.fixtureId, side: f.homeFrom.side } } : {}),
      ...(f.awayFrom ? { awayFrom: { extKey: f.awayFrom.fixtureId, side: f.awayFrom.side } } : {}),
      ...(f.award ? { award: f.award } : {}),
      ...(f.bracket ? { lane: f.bracket } : {}),
      ...(f.isFinal ? { isFinal: true } : {}),
      ...(f.thirdPlace ? { thirdPlace: true } : {}),
      ...(f.conditional ? { conditional: true } : {}),
    };
  });
}

const DECIDED = new Set(["decided", "finalized", "forfeited"]);

/** The slot label stamped on a bye's PHANTOM side — the seat the bracket pads
 *  out and nobody ever occupies. One authority, shared by the two generation
 *  paths (`generateStageFixtures`' own insert and the `timing: "setup"`
 *  progression path's label pass) and by `awardSeededByes` below, which reads
 *  it back as the marker that says "this line is a walkover, not a match still
 *  waiting on an opponent". The public hub already keys its own bye detection
 *  on the same string (public-site/competition-hub.ts's BYE_SLOT_KEY). */
const BYE_SLOT_LABEL = { key: "bracket.slot.bye", params: {} } as const;

type SwissExistingFixture = {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
};

type SwissGenResult = { gen: GenFixture[]; seatedCount: number };

// Swiss shell fixtures (2026-09-18 programme): first Generate mints empty rows for
// every round the organiser declared in `config.rounds`; Pair next (a later
// Generate when shells already exist) seats one round at a time onto those
// shells. The organiser-set round budget is the only authority — nothing here
// derives or persists `rounds` from field size.
async function swissGen(
  tx: Tx,
  stageId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  existing: SwissExistingFixture[],
): Promise<SwissGenResult> {
  const rounds = cfg.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new EngineError("CONFIG_INVALID", "swiss stage requires config.rounds >= 1", { stageId });
  }

  if (existing.length === 0) {
    return {
      gen: planSwissShells(rounds, entrants.length).map((shell) => ({
        extKey: shell.extKey,
        roundNo: shell.roundNo,
        seqInRound: shell.seqInRound,
        home: null,
        away: null,
      })),
      seatedCount: 0,
    };
  }

  const target = nextUnseatedSwissRound(existing);
  if (target === null) {
    return { gen: [], seatedCount: 0 };
  }

  if (target > 1) {
    const seatedPrev = existing.filter(
      (f) =>
        f.round_no === target - 1 &&
        isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
    );
    if (seatedPrev.some((f) => !DECIDED.has(f.status))) {
      throw new EngineError("STAGE_NOT_READY", "current swiss round has undecided fixtures", { stageId });
    }
  }

  const rankAdjacent = cfg.pairing === "rank_adjacent";
  const score = new Map<string, number>(entrants.map((e) => [e.id, 0]));
  const played = new Set<string>();
  const colours = new Map<string, Colour[]>();
  const byes = new Set<string>();
  const inRound = new Map<number, Set<string>>();
  for (const f of existing) {
    const o = f.outcome as { kind?: string; winner?: string } | null;
    if (o?.kind === "award" && o.winner) {
      const forRound = inRound.get(f.round_no) ?? new Set<string>();
      forRound.add(o.winner);
      inRound.set(f.round_no, forRound);
      byes.add(o.winner);
      score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
      continue;
    }
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    played.add(pairKey(f.home_entrant_id, f.away_entrant_id));
    const forRound = inRound.get(f.round_no) ?? new Set<string>();
    forRound.add(f.home_entrant_id).add(f.away_entrant_id);
    inRound.set(f.round_no, forRound);
    (colours.get(f.home_entrant_id) ?? colours.set(f.home_entrant_id, []).get(f.home_entrant_id)!).push("W");
    (colours.get(f.away_entrant_id) ?? colours.set(f.away_entrant_id, []).get(f.away_entrant_id)!).push("B");
    if (o?.kind === "win" && o.winner) score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
    else if (o?.kind === "draw" || o?.kind === "tie") {
      score.set(f.home_entrant_id, (score.get(f.home_entrant_id) ?? 0) + 0.5);
      score.set(f.away_entrant_id, (score.get(f.away_entrant_id) ?? 0) + 0.5);
    }
  }
  const latestSeated = latestSeatedSwissRound(existing);
  for (let r = 1; r <= (latestSeated ?? 0); r++) {
    const inRoundR = existing.filter((f) => f.round_no === r);
    if (
      !inRoundR.every((f) =>
        isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
      )
    ) {
      continue;
    }
    // This round already carries an explicit bye row, so the award loop above
    // has credited whoever sat out; inferring a second one here would
    // double-count. (C1: this used to fire for a two-sided forfeit as well,
    // which silently suppressed the implicit-bye inference for that round.)
    if (inRoundR.some((f) => isOneSidedAwardBye(f))) continue;
    const seen = inRound.get(r) ?? new Set();
    for (const e of entrants) {
      if (!seen.has(e.id)) {
        byes.add(e.id);
        score.set(e.id, (score.get(e.id) ?? 0) + 1);
      }
    }
  }

  const cascadeRank = new Map<string, number>();
  if (rankAdjacent && existing.some((f) => isSwissBoardSeated(f) && DECIDED.has(f.status))) {
    const rows = await rankedStageStandings(tx, stageId);
    for (const [i, row] of rows.entries()) {
      cascadeRank.set(row.entrantId, row.rank ?? i + 1);
    }
  }
  const seedRank = (e: ActiveEntrant, i: number): number => e.seed ?? 1000 + i;
  const standings: SwissStanding[] = entrants.map((e, i) => ({
    entrantId: e.id,
    score: score.get(e.id) ?? 0,
    rank: cascadeRank.get(e.id) ?? cascadeRank.size + seedRank(e, i),
  }));
  const round = pairRound(
    standings,
    { played, colours, byes },
    { chess: cfg.chess === true, ...(rankAdjacent ? { pairing: "rank_adjacent" as const } : {}) },
  );

  const roundShells = existing
    .filter((f) => f.round_no === target)
    .sort((a, b) => a.seq_in_round - b.seq_in_round);
  const boardShells = roundShells.filter((f) => !f.ext_key?.endsWith("-bye"));
  const byeShell = roundShells.find((f) => f.ext_key?.endsWith("-bye"));

  let seatedCount = 0;
  for (let i = 0; i < round.pairings.length; i++) {
    const p = round.pairings[i]!;
    const shell = boardShells[i];
    if (!shell) {
      throw new EngineError("CONFIG_INVALID", "swiss shell count mismatch for pairing", { stageId, target });
    }
    await tx`
      update fixtures set
        home_entrant_id = ${p.home},
        away_entrant_id = ${p.away},
        status = 'scheduled',
        outcome = null,
        home_slot_label = null,
        away_slot_label = null
      where id = ${shell.id}`;
    seatedCount++;
  }
  if (round.bye !== undefined) {
    if (!byeShell) {
      throw new EngineError("CONFIG_INVALID", "swiss bye shell missing for pairing", { stageId, target });
    }
    await tx`
      update fixtures set
        home_entrant_id = ${round.bye},
        away_entrant_id = null,
        status = 'forfeited',
        outcome = ${tx.json({ kind: "award", winner: round.bye } as never)},
        home_slot_label = null,
        away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)}
      where id = ${byeShell.id}`;
    seatedCount++;
  }

  return { gen: [], seatedCount };
}

// Distribute seed-ordered entrants into `count` pools by seeded snake
// (doc 05 §1: assignment seeded_snake) — 1..N, then N..1, repeating.
export function snakeDistribute<T>(ordered: readonly T[], count: number): T[][] {
  const pools: T[][] = Array.from({ length: count }, () => []);
  for (const [i, entrant] of ordered.entries()) {
    const lap = Math.floor(i / count);
    const pos = i % count;
    const pool = lap % 2 === 0 ? pos : count - 1 - pos;
    pools[pool].push(entrant);
  }
  return pools;
}

// Exported: stage-seeding.ts's sourceShapeOf (relocated there, F2 Task 6)
// needs the same pool-count derivation this file's own generation path uses,
// so the two can never drift onto different pool-count rules.
export const POOL_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function poolCount(cfg: Record<string, unknown>): number {
  const pools = cfg.pools as { count?: unknown } | undefined;
  const count = typeof pools?.count === "number" ? pools.count : 1;
  if (!Number.isInteger(count) || count < 1 || count > POOL_KEYS.length) {
    throw new EngineError("CONFIG_INVALID", `invalid pool count ${String(count)}`, { count });
  }
  return count;
}

function roundRobinGen(
  entrants: ActiveEntrant[],
  legs: number,
  extPrefix = "",
  poolId?: string,
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  const schedule = generateRoundRobin({ entrants: ids, seeds, config: { legs } });
  return schedule.fixtures.map((f) => ({
    extKey: extPrefix + f.id,
    roundNo: f.roundNo,
    seqInRound: f.court,
    home: f.home,
    away: f.away,
    ...(poolId ? { poolId } : {}),
  }));
}

function generate(
  kind: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  poolIds: Map<string, string>, // pool key ('A'…) → pools.id
): GenFixture[] {
  const ids = entrants.map((e) => e.id);
  const seeds = new Map(entrants.filter((e) => e.seed != null).map((e) => [e.id, e.seed as number]));
  switch (kind) {
    case "league":
    case "group": {
      // Jul3/08 §2: legs > 2 allowed (triple/quad RR), capped at 8
      const rawLegs = typeof cfg.legs === "number" ? Math.trunc(cfg.legs) : 1;
      const legs = Math.min(Math.max(rawLegs, 1), 8);
      const count = kind === "group" ? poolCount(cfg) : 1;
      if (count === 1) return roundRobinGen(entrants, legs);
      // Seeded-snake pools, each playing its own round robin (doc 05 §1).
      const ordered = [...entrants].sort(
        (a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
      );
      return snakeDistribute(ordered, count).flatMap((poolEntrants, i) => {
        const key = POOL_KEYS[i];
        return roundRobinGen(poolEntrants, legs, `p${key}-`, poolIds.get(key));
      });
    }
    case "knockout": {
      const bracket = generateSingleElim({
        entrants: ids,
        seeds,
        thirdPlace: cfg.thirdPlace === true,
        // Jul3/08 §4 (7 Jan): organiser-chosen bye recipients
        ...(Array.isArray(cfg.byes) ? { byeEntrants: cfg.byes as string[] } : {}),
        // PROMPT-59 §2: explicit published slot map (seed numbers index into
        // the resolved qualification order); engine validates the shape.
        ...(Array.isArray(cfg.slotOrder)
          ? { slotOrder: (cfg.slotOrder as unknown[]).map((s) => (s === null ? null : Number(s))) }
          : {}),
      });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "page_playoff": {
      const bracket = generatePagePlayoff({ entrants: ids, seeds });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "double_elim": {
      const bracket = generateDoubleElim({ entrants: ids, seeds, bracketReset: cfg.bracketReset === true });
      return bracketToGen(bracket, bracket.rounds);
    }
    case "stepladder": {
      const bracket = generateStepladder({ entrants: ids, seeds });
      return bracketToGen(bracket, bracket.rounds);
    }
    default:
      throw new EngineError("CONFIG_INVALID", `cannot generate fixtures for stage kind '${kind}'`, { kind });
  }
}

// ---------------------------------------------------------------------------
// Example preview (division builder "Show example"). Runs the SAME `generate()`
// the real draw uses, over synthetic seeded entrants, so the shape is identical
// to what the server will produce — only the names are placeholders. No DB.
// ---------------------------------------------------------------------------

export interface PreviewMatch {
  home: string;
  away: string;
}
export interface PreviewSection {
  title: string;
  matches: PreviewMatch[];
}
export interface PreviewPhase {
  title: string;
  note?: string;
  sections: PreviewSection[];
}
export interface PreviewStageInput {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: unknown;
}

/** 0 → A, 25 → Z, 26 → AA … */
function alphaLabel(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// F2 — delegates to the engine's `progressionSize` (TOTAL across every
// TakeRule kind, never throws) instead of re-deriving per-shape counts by
// hand. This is a READ path fed straight from a DB column — never let a
// malformed value reach `progressionSize`.
//
// F3 Task 2b (regression fix, commit 6351fd2ce): `progressionSize`
// deliberately contributes 0 for `topNPerGroup` (its own comment:
// "group-count-dependent; callers with a real shape use expandTake
// instead") — groups_ko's switch to `topNPerGroup` made every
// group-into-knockout preview collapse through the `|| 4` guard below
// regardless of the real qualifier count (4 pools x 4 qualifiers/pool
// previewed a 4-team bracket, not 16). `previewDivisionFixtures` has the
// whole stage array, so the previous stage's real pool count is knowable
// with no DB read — `previewSourceShape` derives it the same way
// stage-seeding.ts's `sourceShapeOf` does for a preset (non-DB) source.
// Only a take that actually contains `topNPerGroup` pays for this: every
// rankRange/bestNth/picks/roundLosers-only take (league_ko,
// group_stepladder, group_playoffs, ko_plate, qualifying_main) still goes
// straight through `progressionSize`, unchanged — `expandTake` would
// compute the identical total for those kinds, so there is no reason to
// risk it on the common path.
function previewSourceShape(prev: PreviewStageInput | undefined): SourceShape {
  // A non-"group" (or absent) previous stage has no pools. Matches
  // sourceShapeOf's own convention: topNPerGroup then degenerates to one
  // implicit pool (expandOne's `pools.length > 0 ? shape.poolKeys : [""]`),
  // the same "ungrouped source" fallback getStandings/seedNextStage use.
  if (!prev || prev.kind !== "group") return { poolKeys: [] };
  const cfg = (prev.config ?? {}) as { pools?: { count?: unknown } };
  const raw = cfg.pools?.count;
  // Mirrors poolCount()'s own default-to-1, but never throws on an
  // out-of-range value — this is a preview read path (malformed knob data
  // must fall back to 1 pool, not 422 a gallery render).
  const count = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= POOL_KEYS.length ? raw : 1;
  return { poolKeys: POOL_KEYS.slice(0, count).split("") };
}

// F3 review item 3 (RESOLVED) — was `spec.sources?.[0]?.take` only: complete
// while previewDivisionFixtures never saw a multi-source progression, but
// item 1's fix makes multi-source a genuinely reachable `setup` spec
// (progression-multi-source.test.ts creates one end to end), and this preview
// undersized the downstream stage for one exactly the way commit 0ec159e52
// fixed for `topNPerGroup` — the "preview that lies" class this programme
// exists to end. Sums every source, each sized by the SAME per-source rule
// this function always applied to `sources[0]` alone (topNPerGroup needs the
// previous stage's real shape; everything else is a plain progressionSize),
// so single-source behaviour is byte-identical (a one-source sum reduces to
// the same single term). "Summing every source's count would double-count
// entrants a REAL resolve would dedupe" (the old comment here) does not apply
// to a preview: this sizes SLOTS from static take-rule counts, never real
// entrant ids, and multiple sources describe entrants from DIFFERENT earlier
// stages by construction — there is nothing to dedupe.
function qualifierCount(progression: unknown, prevStage?: PreviewStageInput): number {
  if (!progression || typeof progression !== "object") return 0;
  const spec = progression as { sources?: { take?: unknown }[] };
  const sources = spec.sources;
  if (!Array.isArray(sources)) return 0;
  return sources.reduce((total, source) => {
    const take = source?.take;
    if (!Array.isArray(take)) return total;
    const rules = take as TakeRule[];
    if (rules.some((r) => (r as { kind?: unknown } | null)?.kind === "topNPerGroup")) {
      try {
        return total + expandTake(rules, previewSourceShape(prevStage)).reduce((sum, pot) => sum + pot.length, 0);
      } catch {
        // A malformed sibling rule despite the topNPerGroup check above —
        // fall through to progressionSize's own graceful degradation; this
        // read path must never throw.
      }
    }
    return total + progressionSize(rules);
  }, 0);
}

/** Preview a whole stage graph. Stage 1 uses A,B,C… entrants; later (qualifier)
 *  stages use "Seed 1…q". Score-dependent formats (swiss/americano/ladder)
 *  can't be drawn before results, so they return an explanatory note. */
export function previewDivisionFixtures(
  stages: PreviewStageInput[],
  count: number,
): PreviewPhase[] {
  const n = Math.min(Math.max(2, Math.trunc(count) || 2), 64);
  const poolIds = new Map(POOL_KEYS.split("").map((k) => [k, k]));

  return stages.map((stage, stageIdx) => {
    const firstStage = stageIdx === 0;
    // `|| 4` is now genuinely unknowable only: an absent/malformed
    // progression, or a take whose rules all resolve to 0 real qualifiers.
    // A real topNPerGroup/rankRange/bestNth/picks/roundLosers take is sized
    // exactly by qualifierCount (shape-aware for topNPerGroup via the
    // previous array entry, progressionSize otherwise — see its comment).
    const entrantCount = firstStage
      ? n
      : Math.max(2, qualifierCount(stage.progression, stages[stageIdx - 1]) || 4);
    const label = (i: number) => (firstStage ? alphaLabel(i) : `Seed ${i + 1}`);

    // Formats whose pairings depend on live results — no static draw exists.
    if (stage.kind === "swiss" || stage.kind === "americano" || stage.kind === "ladder") {
      const note =
        stage.kind === "ladder"
          ? "No fixed fixtures — players challenge others within range and climb over a long window."
          : stage.kind === "swiss"
            ? `Round 1 is seeded; the remaining rounds pair players on equal scores from the live standings.`
            : "Individuals rotate partners each round; pairings are drawn live from the running points.";
      return { title: stage.name, note, sections: [] };
    }

    let gen: GenFixture[];
    try {
      const entrants: ActiveEntrant[] = Array.from({ length: entrantCount }, (_, i) => ({
        id: `e${i + 1}`,
        seed: i + 1,
      }));
      gen = generate(stage.kind, stage.config, entrants, poolIds);
    } catch {
      return { title: stage.name, note: "Preview isn't available for this format.", sections: [] };
    }

    // id → label; and extKey → the SOURCE fixture's {round, seq} — numbers,
    // never a rendered fragment (P7/F1) — so feeds resolve through the
    // design's slot.winner_match/slot.loser_match pair via the SAME
    // resolveSlotLabel() every real renderer uses (A1/A2), which composes
    // "R2·1" from slot.match_ref internally. Never a hand-built template.
    // This preview has no locale in scope (it backs the marketing gallery +
    // /help/formats, always English before and after), so it resolves
    // through the client-safe English msg(). Mirrors the exact map
    // generateStageFixtures's own INSERT builds for the live path below, so
    // the two cannot drift onto different ref formats.
    const idLabel = new Map<string, string>();
    for (let i = 0; i < entrantCount; i++) idLabel.set(`e${i + 1}`, label(i));
    const refByExt = new Map(gen.map((f) => [f.extKey, { round: f.roundNo, seq: f.seqInRound }]));

    const slot = (id: string | null, from?: { extKey: string; side: "winner" | "loser" }): string => {
      if (id) return idLabel.get(id) ?? id;
      if (from) {
        const params = refByExt.get(from.extKey);
        if (!params) return resolveSlotLabel(null, msg, "schedule.tbd");
        const key = from.side === "loser" ? "slot.loser_match" : "slot.winner_match";
        return resolveSlotLabel({ key, params }, msg, "schedule.tbd");
      }
      return resolveSlotLabel(null, msg, "schedule.tbd");
    };

    // Group by pool (group stages) or by round (everything else).
    const grouped = new Map<string, GenFixture[]>();
    const byPool = gen.some((f) => f.poolId);
    for (const f of gen) {
      const key = byPool ? `pool:${f.poolId}` : `round:${f.roundNo}`;
      (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(f);
    }

    // F1 Task 4: name each round by its POSITION (roundRole), never by match
    // count — a double-elim's losers bracket has repeated round sizes, so a
    // count-based namer produces several "Semi-finals" and several "Final"s
    // in one bracket (design §2.3). Ranked per LANE (laneRoundRank), not
    // across the whole stage. Non-bracket kinds (league/group round robins)
    // keep the plain "Round N" — roundRole()'s fromEnd arithmetic assumes a
    // bracket shape and is meaningless outside BRACKET_KINDS.
    const laneFixtures = gen.map((f) => ({ round_no: f.roundNo, lane: f.lane ?? null }));

    const sections: PreviewSection[] = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([key, fixtures]) => {
        const matches = fixtures
          .sort((a, b) => a.roundNo - b.roundNo || a.seqInRound - b.seqInRound)
          .map((f) => ({
            home: slot(f.home, f.homeFrom),
            // Task 5: a bye is known at setup and never resolves to anyone —
            // "TBD" tells an organiser to wait for something that isn't
            // coming. BracketFixtureGen.award marks the whole fixture; the
            // engine always lands the award on `home` (buildSingleElim), so
            // `away` is unconditionally the phantom slot here.
            away: f.award !== undefined ? msg("bracket.slot.bye") : slot(f.away, f.awayFrom),
          }));
        const first = fixtures[0]!;
        const title = byPool
          ? `Group ${key.slice(5)}`
          : BRACKET_KINDS.has(stage.kind)
            ? roundRoleLabel(
                msg,
                roundRoleFor(
                  laneFixtures,
                  {
                    round_no: first.roundNo,
                    lane: first.lane ?? null,
                    is_final: first.isFinal === true,
                    third_place: first.thirdPlace === true,
                    conditional: first.conditional === true,
                  },
                  stage.kind,
                  first.extKey,
                ),
              )
            : msg("bracket.round.plain", { n: first.roundNo });
        return { title, matches };
      });

    return { title: stage.name, sections };
  });
}

export interface GenerateOutcome {
  created: number;
  existing: number;
  fixtures: FixtureRow[];
}

/**
 * Generate a stage's fixtures (doc 08 §3). Idempotent: the generator's stable
 * ids are persisted as fixtures.ext_key, so a re-run inserts only what's
 * missing and reports the diff. Feed wiring (winner_to/loser_to) and bye
 * awards are applied after insert, under the division advisory lock.
 */
// Fixture-shape changes (generation, stage completion) must refresh the public
// dashboard's ISR pages just like scoring writes do (doc 09 §3).
async function fireStageRevalidate(orgId: string, stageId: string): Promise<void> {
  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    return r ?? null;
  });
  if (row) fireDivisionRevalidate(row.division_id, row.competition_id);
}

/** A generate's committed write (R10e): the wire outcome, plus the division
 *  and competition its own transaction wrote into. */
interface GenerateWrite {
  outcome: GenerateOutcome;
  divisionId: string;
  competitionId: string;
  /** Swiss Pair next: how many shells were seated this pass (0 on mint). */
  swissSeatedCount?: number;
}

/** R10e (review-r10d m1): generate a stage's fixtures and publish the write.
 *  New fixtures change the hub (their kick-offs and courts), so the hub key
 *  drops in one DEL after the commit and the division push follows it
 *  (`afterScheduleWrite`). A generate deletes nothing, so it names no fixture
 *  key and sends no fixture push: every id it created is new, and nobody can
 *  be watching a match centre for it. A generate that created nothing sends
 *  nothing.
 *
 *  Callers that publish their own write use `generateStageFixturesUnpublished`
 *  instead: `startDivision` (one publish naming every fixture of the division),
 *  `rebuildStageFixtures` (one publish naming the fixtures it deleted), and
 *  `completeStage` (R10g: it publishes the whole completion, the draw
 *  included, once in its own `finally`, unless scoring's auto-advance opts
 *  out because scoring's post-commit `finally` publishes). */
export async function generateStageFixtures(auth: AuthCtx, stageId: string): Promise<GenerateOutcome> {
  const write = await generateStageFixturesWrite(auth, stageId);
  if (write.outcome.created > 0) {
    afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  }
  return write.outcome;
}

/** `generateStageFixtures` without its publish, for a caller that publishes
 *  the whole write itself (see above). */
export async function generateStageFixturesUnpublished(auth: AuthCtx, stageId: string): Promise<GenerateOutcome> {
  return (await generateStageFixturesWrite(auth, stageId)).outcome;
}

/**
 * The result-evidence tables EVERY destructive fixture path must consult,
 * as one SQL fragment. `f` must be the `fixtures` alias in the enclosing
 * query; the caller supplies its own status clause and its own row scope.
 *
 * Shared deliberately (2026-09-20 review, C1): `unpairSwissRound` shipped
 * with a subset of this list — `score_events` only — and a bye predicate that
 * excluded real results from even that. A subset guard on a destructive path
 * is exactly how the defect happened, so the list is written once and both
 * callers read it.
 *
 * Why `config_snapshot` is in here and not only the event tables: V347 freezes
 * the resolved cfg onto the fixture when the FIRST event lands
 * (`append-event.ts`), and `fixture-cfg.ts`'s own header states that
 * `config_snapshot is null` is precisely "not scored yet". It is monotonic,
 * which `fixtures.status` is NOT — `fixtureStatusFromFold` walks a fixture
 * back to `scheduled` when a `core.start` is voided, so a status test alone
 * can silently stop refusing.
 */
function fixtureEvidenceSql(tx: Tx) {
  return tx`
    f.config_snapshot is not null
    or exists (select 1 from score_events se where se.fixture_id = f.id)
    or exists (select 1 from match_states ms where ms.fixture_id = f.id)
    or exists (select 1 from match_reports mr where mr.fixture_id = f.id)
    or exists (select 1 from official_marks om where om.fixture_id = f.id)
    or exists (select 1 from suspensions s where s.fixture_id = f.id)`;
}

/** Clear the latest fully seated Swiss round back onto its shells (2026-09-18). */
export async function unpairSwissRound(
  auth: AuthCtx,
  stageId: string,
): Promise<{ cleared: number; round: number }> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "swiss") {
      throw new HttpError(422, "unpair only exists on swiss stages");
    }
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const existing = await tx<SwissExistingFixture[]>`
      select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome
      from fixtures where stage_id = ${stageId}`;

    const round = latestSeatedSwissRound(existing);
    if (round === null) {
      throw new EngineError("STAGE_NOT_READY", "no seated swiss round to unpair", { stageId });
    }
    if (swissRoundHasPlayedResult(existing, round)) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has played results — unpair refused",
        { stageId, round },
      );
    }

    const inRound = existing.filter((f) => f.round_no === round);

    // C1 (2026-09-20 review). This check runs over EVERY row in the round —
    // it used to run over a "non-bye" subset computed by a predicate that
    // called any award outcome a bye, so a played board carrying a real
    // forfeit or retirement was excluded from the one guard that could still
    // have caught it after the status guard above had also been fooled.
    // Nothing is exempt here: a genuine bye never goes through appendEvent,
    // so it has no events, no state and no frozen cfg, and the exemption
    // belongs in the STATUS test above where `forfeited` would otherwise
    // block every odd-field round.
    const ids = inRound.map((f) => f.id);
    const [blocked] = await tx<{ id: string }[]>`
      select f.id from fixtures f
      where f.id in ${tx(ids)} and (${fixtureEvidenceSql(tx)})
      limit 1`;
    if (blocked) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has recorded match data — unpair refused",
        { stageId, round, fixtureId: blocked.id },
      );
    }

    await tx`
      update fixtures set
        home_entrant_id = null,
        away_entrant_id = null,
        status = 'scheduled',
        outcome = null,
        home_slot_label = null,
        away_slot_label = null
      where id in ${tx(ids)}`;

    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    return {
      cleared: ids.length,
      round,
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
    };
  });

  // Bye awards (and their removal) never go through appendEvent, so the
  // standings snapshot would otherwise keep the unpaired bye's points until
  // the next scored match — Dan after Unpair R3. Fold from the cleared rows.
  await recomputeStandings(auth.orgId, stageId);

  void fireStageRevalidate(auth.orgId, stageId);
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return { cleared: write.cleared, round: write.round };
}

async function generateStageFixturesWrite(auth: AuthCtx, stageId: string): Promise<GenerateWrite> {
  // A qualification stage must draw from the previous stage's final table
  // (config.qualified), never from the whole entrant list. If it isn't seeded
  // yet: seed it now when the previous stage is complete (stage added after
  // the fact), otherwise refuse — generating early would bracket everyone.
  //
  // F2 (Decision 1) — a `timing: "setup"` progression is a DIFFERENT
  // mechanism (see stage-seeding.ts) — it generates fully-TBD placeholder
  // fixtures at division SETUP time, with NO wait on its source stage's
  // completion (owner ruling: "ALL stages' fixtures are generated at setup
  // time with placeholder slots"), so it short-circuits before this gate
  // rather than going through it. `timing: "on_complete"` reproduces the OLD
  // `.qualification` behaviour exactly.
  {
    const pre = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<StageRow[]>`
        select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
      if (!stage) throw new HttpError(404, "stage not found");
      // Generating a stage's fixtures IS writing the timetable — the widest
      // schedule write there is — so a frozen division refuses it.
      //
      // `startDivision` (schedule.ts) already refuses on this exact predicate
      // immediately before its own call to this function, and history.ts's
      // undo/redo refuses far earlier in the same call, so neither of them can
      // reach this guard and neither changes behaviour. What could not refuse
      // was the ROUTE — `POST /api/v1/stages/{id}/generate` calls this
      // directly, at the same `requireResourceAuth(..., "write")`, bypassing
      // `startDivision` entirely. An organiser who could not Start a frozen
      // empty board could simply press Generate instead, which is the same
      // walk-around shape #230 item 2 found on the publish gate.
      //
      // HERE, in the pre-flight block, rather than in the write transaction
      // below: two of this function's paths never reach that transaction —
      // a `timing: "setup"` progression short-circuits into
      // `generateProgressionSetupFixtures`, and an `on_complete` one runs
      // `seedNextStage` first. Both write fixtures. A guard in the main
      // transaction would leave both unrefused.
      //
      // AFTER the existence check: `divisionLockState` reads a missing row as
      // `frozen: false`, so an unknown stage id must still 404 here rather
      // than depend on a lock state there is no row to read.
      const lockState = await divisionLockState(tx, stage.division_id);
      if (lockState.frozen) {
        throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
      }
      if (!stage.progression) return null;
      const progression = stage.progression as unknown as ProgressionSpec & { timing: "setup" | "on_complete" };
      if (progression.timing === "setup") return { seeded: true as const };
      if (Array.isArray(stage.config.qualified)) return null;
      const [prev] = await tx<{ id: string; status: string }[]>`
        select id, status from stages
        where division_id = ${stage.division_id} and seq < ${stage.seq}
        order by seq desc limit 1`;
      return prev ? { seeded: false as const, prev } : null;
    });
    if (pre?.seeded) {
      const write = await generateProgressionSetupFixtures(auth, stageId);
      const outcome = write.outcome;
      void fireStageRevalidate(auth.orgId, stageId);
      if (outcome.created > 0) {
        await captureServer({
          event: EVENTS.SCHEDULE_GENERATED,
          distinctId: auth.userId ?? `org:${auth.orgId}`,
          orgId: auth.orgId,
          properties: { stage_id: stageId, fixtures_created: outcome.created },
        });
      }
      return write;
    }
    if (pre) {
      if (pre.prev.status !== "complete") {
        throw new EngineError(
          "STAGE_NOT_READY",
          "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
          { stageId, previousStageId: pre.prev.id },
        );
      }
      await seedNextStage(auth, pre.prev.id);
    }
  }
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const active = await tx<ActiveEntrant[]>`
      select id, seed from entrants
      where division_id = ${stage.division_id} and status in ('registered', 'confirmed')
      order by seed nulls last, created_at, id`;

    // A seeded stage (qualification resolved at the previous stage's completion,
    // stored as config.qualified) draws from that ordered list — its order IS
    // the seeding. Otherwise: every active division entrant.
    const qualified = Array.isArray(stage.config.qualified)
      ? (stage.config.qualified as string[])
      : null;
    let entrants: ActiveEntrant[];
    if (qualified) {
      const activeIds = new Set(active.map((e) => e.id));
      entrants = qualified
        .filter((id) => activeIds.has(id))
        .map((id, i) => ({ id, seed: i + 1 }));
    } else {
      entrants = active;
    }
    if (entrants.length < 2) {
      throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", {
        stageId,
        entrants: entrants.length,
      });
    }

    // Group stages with pools: materialise the pools rows first (idempotent),
    // so generated fixtures can reference them.
    const poolIds = new Map<string, string>();
    if (stage.kind === "group" && poolCount(stage.config) > 1) {
      const existing = await tx<{ id: string; key: string }[]>`
        select id, key from pools where stage_id = ${stageId}`;
      for (const pool of existing) poolIds.set(pool.key, pool.id);
      for (let i = 0; i < poolCount(stage.config); i++) {
        const key = POOL_KEYS[i];
        if (poolIds.has(key)) continue;
        const [row] = await tx<{ id: string }[]>`
          insert into pools (stage_id, key, name)
          values (${stageId}, ${key}, ${"Pool " + key}) returning id`;
        poolIds.set(key, row.id);
      }
    }

    const existing = await tx<SwissExistingFixture[]>`
      select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome
      from fixtures where stage_id = ${stageId}`;

    let swissSeatedCount = 0;
    let gen: GenFixture[];
    if (stage.kind === "swiss") {
      const swiss = await swissGen(tx, stageId, stage.config, entrants, existing);
      gen = swiss.gen;
      swissSeatedCount = swiss.seatedCount;
    } else if (stage.kind === "americano") {
      gen = await americanoGen(tx, stage.division_id, stageId, stage.config, entrants);
    } else if (stage.kind === "ladder") {
      gen = []; // Jul3/08 §6: ladder fixtures come from challenges, on demand
    } else {
      gen = generate(stage.kind, stage.config, entrants, poolIds);
    }

    // Guard against the misleading "nothing new — up to date" success shape
    // (design/fix-ui/03 §"misleading success message"): a `group` stage with
    // enough TOTAL entrants to pass the `entrants.length < 2` check above can
    // still produce zero pairings once those entrants are split across N
    // configured groups (e.g. 2 entrants snake-distributed into 4 groups —
    // every group ends up with 0 or 1 entrant, so roundRobinGen has nothing to
    // pair). Before this guard, that returned `created: 0, existing: 0` — the
    // exact same shape as "already generated, run again, nothing changed" —
    // so the UI showed a green "up to date" banner while zero fixtures ever
    // existed. Distinguish the two: this is a precondition failure, not a
    // no-op success, so it must throw (a real reason), not return quietly.
    if ((stage.kind === "group" || stage.kind === "league") && gen.length === 0 && existing.length === 0) {
      const groups = stage.kind === "group" ? poolCount(stage.config) : 1;
      const required = Math.max(2, groups * 2);
      throw new EngineError(
        "STAGE_NOT_READY",
        groups > 1
          ? `not enough entrants to fill ${groups} groups — each group needs at least 2 (have ${entrants.length}, need ${required})`
          : "not enough entrants to generate any matches",
        { stageId, reason: "group_too_few_entrants", groups, entrants: entrants.length, required },
      );
    }

    const byKey = new Map<string, string>(); // ext_key → fixture uuid
    for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

    // Cross-stage fill unification (D4a/P5 scope item 3): when `entrants`
    // came from `stage.config.qualified` (the OLD auto-seed-on-complete
    // flow — see seedNextStage below), the two REAL sides of a fixture must
    // land through the SAME slot-fill pathway as intra-bracket advancement
    // (fillSlot), not baked into this INSERT — one pathway, not two. A bye
    // AWARD stays a direct bake: it is an immediate, self-contained
    // walkover decision made at generation time (same as it always was for
    // the plain/registered-entrant path), not a "fill a slot with a
    // qualified entrant" concern, so it is out of scope for this
    // unification and untouched.
    const viaFillSlot = qualified !== null;
    const bakeDirect = (g: GenFixture) => !viaFillSlot || g.award !== undefined;

    // Match-sourced slot labels (P7/F1): a slot with no baked entrant, fed by
    // an earlier fixture in THIS generation (g.homeFrom/g.awayFrom), gets an
    // i18n pattern ref persisted alongside the null entrant id — { key:
    // "slot.winner_match" | "slot.loser_match", params: { round, seq } },
    // numbers, NEVER a rendered fragment (resolveSlotLabel composes the ref
    // text at render time via slot.match_ref, so every locale/surface can
    // differ). This is the SAME {key,params} shape the `timing:"setup"` path
    // (descriptorLabel, stage-seeding.ts — untouched) already writes for its
    // own kind of TBD slot; only the descriptor differs. `refByExt` mirrors
    // the preview helper's own map above (extKey → the SOURCE fixture's
    // {round, seq}) — built from the FULL `gen`, not just the new rows below,
    // so a homeFrom/awayFrom pointing at an already-existing fixture still
    // resolves. Gated on the ACTUAL entrant id about to be inserted (not
    // `bakeDirect(g)` alone) — `bakeDirect` is a constant `true` for every
    // fixture on the common, non-cross-stage-fill path, so a round-2+
    // intra-bracket slot (g.home already null there) needs its OWN nullness
    // check, not a proxy that never fires in that path.
    //
    // EXCEPT a bye: `byeExtKeys` names every source whose "match" resolves to
    // an immediate award, not a real fixture ever played. Its winner is
    // propagated into the fed slot synchronously below (the "Third pass"),
    // inside this SAME transaction — no user ever sees that slot render as
    // TBD, so labelling it would only create a label this call is about to
    // strand. The Third pass's own invariant guard (P5 review finding, right
    // below) exists precisely to catch a stale label reaching that update
    // path; skipping the label here for a bye source is what keeps this
    // task's own new label-writing from being the thing that trips it.
    const refByExt = new Map(gen.map((f) => [f.extKey, { round: f.roundNo, seq: f.seqInRound }]));
    const byeExtKeys = new Set(gen.filter((f) => f.award !== undefined).map((f) => f.extKey));
    const matchSlotLabel = (
      from?: { extKey: string; side: "winner" | "loser" },
    ): { key: string; params: { round: number; seq: number } } | null => {
      if (!from) return null;
      if (byeExtKeys.has(from.extKey)) return null;
      const params = refByExt.get(from.extKey);
      if (!params) return null;
      const key = from.side === "loser" ? "slot.loser_match" : "slot.winner_match";
      return { key, params };
    };
    // Review finding (defect 1): a bye is known at setup and never resolves
    // to anyone — "TBD" tells an organiser to wait for something that is not
    // coming (same rationale previewDivisionFixtures already applies at its
    // own bye branch above). The engine always lands the award on `home`
    // (buildSingleElim), so in practice this only ever fires for `away`, but
    // both sides are guarded symmetrically rather than assuming that engine
    // detail here. Stored at INSERT time, not derived at render time: this
    // is the ONE place a bye's phantom side is decided, so every renderer
    // that already goes through resolveSlotLabel (public bracket, console
    // stages/bracket panels, …) picks it up for free, the same way every
    // other slot label on this row already does.
    const byeSlotLabel = (isBye: boolean): { key: string; params: Record<string, never> } | null =>
      isBye ? BYE_SLOT_LABEL : null;

    // First pass: all new fixtures in one multi-row insert. Ids are generated
    // client-side so the feed/bye passes can reference them without relying
    // on RETURNING order.
    const newRows = gen
      .filter((g) => !byKey.has(g.extKey))
      .map((g) => {
        const home_entrant_id = bakeDirect(g) ? g.home : null;
        const away_entrant_id = bakeDirect(g) ? g.away : null;
        return {
          id: randomUUID(),
          stage_id: stageId,
          division_id: stage.division_id,
          pool_id: g.poolId ?? null,
          round_no: g.roundNo,
          seq_in_round: g.seqInRound,
          home_entrant_id,
          away_entrant_id,
          home_slot_label: home_entrant_id ? null : (byeSlotLabel(g.award !== undefined) ?? matchSlotLabel(g.homeFrom)),
          away_slot_label: away_entrant_id ? null : (byeSlotLabel(g.award !== undefined) ?? matchSlotLabel(g.awayFrom)),
          ext_key: g.extKey,
          status: g.award !== undefined ? "forfeited" : "scheduled",
          // Every other outcome writer in this codebase uses tx.json(...), never
          // JSON.stringify — the latter double-encodes a jsonb column (the driver
          // then stores a JSON STRING SCALAR, not an object), so every reader
          // doing `outcome?.kind` / `outcome?.winner` silently saw undefined for
          // every generated bye. Found 2026-09-05, walkthrough gate 1 finding 1.
          outcome: g.award !== undefined ? tx.json({ kind: "award", winner: g.award } as never) : null,
          // F1: the bracket ROLE the engine already computed (BracketFixtureGen
          // via bracketToGen) — always present with a concrete value (never
          // `undefined`) so every row in this batch insert shares one column
          // set; a non-bracket/single-lane fixture keeps lane null, same as
          // every row does today, so no existing render changes.
          lane: g.lane ?? null,
          is_final: g.isFinal === true,
          third_place: g.thirdPlace === true,
          conditional: g.conditional === true,
        };
      });
    if (newRows.length > 0) await tx`insert into fixtures ${tx(newRows)}`;
    for (const r of newRows) byKey.set(r.ext_key, r.id);
    // Pair next reports seated shell rows as `created` for UI notices.
    const created = newRows.length + swissSeatedCount;
    const createdIds = newRows.map((r) => r.id);

    // 1b pass — cross-stage fill, through fillSlot (see viaFillSlot above).
    // Runs over the FULL `gen` (not just newRows): fillSlot's own
    // `and *_entrant_id is null` guard makes an already-filled fixture a
    // no-op, so a resumed/partial regeneration also fills anything a prior
    // run left open.
    if (viaFillSlot) {
      for (const g of gen) {
        if (g.award !== undefined) continue; // byes: see bakeDirect above
        const fixtureId = byKey.get(g.extKey);
        if (fixtureId === undefined) continue;
        if (g.home) await fillSlot(tx, fixtureId, 1, g.home);
        if (g.away) await fillSlot(tx, fixtureId, 2, g.away);
      }
    }

    // Second pass: feeds, batched per side. A target's homeFrom/awayFrom
    // becomes the SOURCE fixture's winner_to/loser_to (+slot 1=home, 2=away).
    const feedUpdates = { winner: [], loser: [] } as Record<
      "winner" | "loser",
      { source: string; target: string; slot: number }[]
    >;
    for (const g of gen) {
      const targetId = byKey.get(g.extKey);
      if (!targetId) continue;
      for (const [feed, slot] of [
        [g.homeFrom, 1],
        [g.awayFrom, 2],
      ] as const) {
        if (!feed) continue;
        const sourceId = byKey.get(feed.extKey);
        if (!sourceId) continue;
        feedUpdates[feed.side].push({ source: sourceId, target: targetId, slot });
      }
    }
    if (feedUpdates.winner.length > 0) {
      const u = feedUpdates.winner;
      await tx`
        update fixtures f
        set winner_to_fixture = v.target_id, winner_to_slot = v.slot
        from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                     unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                     unnest(${u.map((x) => x.slot)}::int[])    as slot) v
        where f.id = v.source_id and f.winner_to_fixture is null`;
    }
    if (feedUpdates.loser.length > 0) {
      const u = feedUpdates.loser;
      await tx`
        update fixtures f
        set loser_to_fixture = v.target_id, loser_to_slot = v.slot
        from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                     unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                     unnest(${u.map((x) => x.slot)}::int[])    as slot) v
        where f.id = v.source_id and f.loser_to_fixture is null`;
    }

    // Third pass: propagate bye awards into their winner feeds (one lookup
    // for all byes, then one fill per slot side).
    const awarded = gen.filter((g) => g.award !== undefined && byKey.has(g.extKey));
    if (awarded.length > 0) {
      const sources = await tx<
        { id: string; winner_to_fixture: string | null; winner_to_slot: number | null }[]
      >`
        select id, winner_to_fixture, winner_to_slot from fixtures
        where id in ${tx(awarded.map((g) => byKey.get(g.extKey)!))}`;
      const srcOf = new Map(sources.map((s) => [s.id, s]));
      const fills: Record<1 | 2, { fixture: string; entrant: string }[]> = { 1: [], 2: [] };
      for (const g of awarded) {
        const source = srcOf.get(byKey.get(g.extKey)!);
        if (source?.winner_to_fixture && (source.winner_to_slot === 1 || source.winner_to_slot === 2)) {
          fills[source.winner_to_slot].push({ fixture: source.winner_to_fixture, entrant: g.award! });
        }
      }
      // Invariant guard (P5 review finding): this is the ONE other
      // home/away_entrant_id writer in this file that bypasses fillSlot, so
      // unlike every other entrant-write here it does NOT clear a matching
      // *_slot_label. Verified harmless today only because a PLAIN
      // (non-`timing:"setup"`) stage's fixtures never carry a label to begin
      // with — only generateProgressionSetupFixtures' own third pass (above) stamps
      // one, and that path never reaches this bulk UPDATE. Nothing enforces
      // that stays true, so refuse loudly if it ever stops holding, rather
      // than silently filling the entrant and leaving the label stale
      // (which would make a filled slot render as if it were still TBD).
      if (fills[1].length > 0) {
        const stale = await tx<{ id: string }[]>`
          select id from fixtures
          where id in ${tx(fills[1].map((x) => x.fixture))} and home_slot_label is not null`;
        if (stale.length > 0) {
          throw new Error(
            `generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label on fixture(s) ${stale.map((f) => f.id).join(",")} instead of clearing it (fillSlot's job) — this path is not supposed to be reachable with a label present`,
          );
        }
        await tx`
          update fixtures f
          set home_entrant_id = v.entrant_id
          from (select unnest(${fills[1].map((x) => x.fixture)}::uuid[]) as fixture_id,
                       unnest(${fills[1].map((x) => x.entrant)}::uuid[]) as entrant_id) v
          where f.id = v.fixture_id and f.home_entrant_id is null`;
      }
      if (fills[2].length > 0) {
        const stale = await tx<{ id: string }[]>`
          select id from fixtures
          where id in ${tx(fills[2].map((x) => x.fixture))} and away_slot_label is not null`;
        if (stale.length > 0) {
          throw new Error(
            `generateStageFixtures: bye-award bulk UPDATE would strand away_slot_label on fixture(s) ${stale.map((f) => f.id).join(",")} instead of clearing it (fillSlot's job) — this path is not supposed to be reachable with a label present`,
          );
        }
        await tx`
          update fixtures f
          set away_entrant_id = v.entrant_id
          from (select unnest(${fills[2].map((x) => x.fixture)}::uuid[]) as fixture_id,
                       unnest(${fills[2].map((x) => x.entrant)}::uuid[]) as entrant_id) v
          where f.id = v.fixture_id and f.away_entrant_id is null`;
      }
    }

    if (stage.status === "pending") {
      await tx`update stages set status = 'active' where id = ${stageId}`;
    }

    const fixtureRows = await tx<Omit<FixtureRow, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.venue, f.court_label, f.court_id,
             f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
    // #14: venue-qualified label (a bare joined `courts.name` can't tell two
    // same-named courts in different venues apart) — same fallback
    // convention as FixtureRow's own doc comment: fall back to the id
    // itself on a miss (should not happen; FK-restricted).
    const courtNames = await courtNamesById(tx);
    const fixtures = fixtureRows.map((f) => ({
      ...f,
      court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
    }));
    // Cross-format feeds (Jul3/08 §4): winner_to/loser_to may target another
    // stage (CL loser → EL slot). Wire every entry whose source and target
    // both exist; the per-decided-fixture fillSlot then follows them like any
    // other feed.
    await wireCrossFeeds(tx, stage.division_id);

    // Undoable generation (Jul3/03 §3): the ledger records which fixtures this
    // pass created so undo can remove exactly them (results-guarded).
    if (created > 0) {
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'fixtures_generated',
                ${tx.json({ stage_id: stageId, fixture_ids: createdIds } as never)})`;
      await tx`update divisions set seq = ${last + 1}, edit_watermark = null
               where id = ${stage.division_id}`;
    }
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    return {
      outcome: { created, existing: gen.length - newRows.length, fixtures },
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
      swissSeatedCount,
    };
  });
  const outcome = write.outcome;
  // Pair next seats bye awards without score_events — same snapshot trap as
  // Unpair. Recompute whenever a Swiss round was seated so the table shows
  // the bye win immediately (Finn/Gus), not after the next real match.
  if ((write.swissSeatedCount ?? 0) > 0) {
    await recomputeStandings(auth.orgId, stageId);
  }
  void fireStageRevalidate(auth.orgId, stageId);
  // Activation funnel (feature 1): fixtures exist → the tournament is playable.
  if (outcome.created > 0) {
    await captureServer({
      event: EVENTS.SCHEDULE_GENERATED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { stage_id: stageId, fixtures_created: outcome.created },
    });
  }
  return write;
}

// ---------------------------------------------------------------------------
// Roster drift (F3 Task 5, 2026-08-18 plan — supersedes ruling 7's framing;
// see the plan's "Corrected premise"). Only a stage with NO progression
// source draws fixtures directly from the live active roster — the exact
// same condition `generateStageFixtures`'s own `pre` gate above tests
// (`if (!stage.progression) return null`, which falls through to the plain
// `select ... from entrants where status in (...)` path). A later stage
// either reads a FROZEN qualified list at completion (`timing:"on_complete"`
// — intentionally excludes non-qualifiers, that's not drift) or generates
// pure-topology placeholders with no entrant reference at all
// (`timing:"setup"` — structurally insulated, stage-seeding.ts's
// sourceShapeOf reads pool shape, never entrant rows). `ladder` and
// `americano` are excluded for a different reason: a ladder's fixtures come
// from individual challenges (issueChallenge), never a bulk generate
// (generateStageFixtures returns `[]` for it above), and americano mints its
// own `pair` entrants on the fly per fixture (americanoGen above) rather
// than referencing the division's registered entrants directly — this
// signal would misreport ~100% of entrants "unplaced" for both.
// ---------------------------------------------------------------------------
// Re-exported so existing `import { … } from "./stages"` call sites need no
// churn; the rule itself lives in a DB-free module (lib/roster-drift-
// eligibility.ts) so the division page and its tests can import the REAL
// function rather than restating it in a mock of this server-only file.
export { ROSTER_DRIFT_INELIGIBLE_KINDS, isRosterDriftEligible };

const NO_ATTACHMENTS = { officials: 0, lineups: 0, deviceLinks: 0 } as const;

export interface StageRosterDriftEntrant {
  id: string;
  display_name: string;
}

export interface StageRosterDrift {
  /** Referenced by a fixture in this stage (home or away) but no longer in
   *  the active roster (withdrawn/disqualified) — a wrong name still on a
   *  board an organiser may have already shared publicly. */
  ghosts: StageRosterDriftEntrant[];
  /** Active in the division (registered/confirmed) but referenced by no
   *  fixture in this stage — registered after the last Generate, or Generate
   *  has never run since. */
  unplaced: StageRosterDriftEntrant[];
  /** Organiser WORK attached to this stage's fixtures that a rebuild would
   *  take with them (F3 ultrareview finding 5). `delete from fixtures`
   *  CASCADEs into all three, and unlike a result none of them BLOCKS the
   *  rebuild: an organiser who has already appointed referees is exactly the
   *  organiser most likely to need a rebuild before match day, so refusing
   *  would make the feature useless when it matters most. Refusing is wrong,
   *  but so is destroying it silently — these counts let the confirm dialog
   *  name what the rebuild clears, so the choice is made with the cost
   *  visible. Zero for a stage with no board. */
  attachments: {
    /** `fixture_officials` — referee/umpire appointments (officials.ts). */
    officials: number;
    /** `lineups` — team sheets (fixtures.ts). */
    lineups: number;
    /** `device_links` — paired scoring devices (device-links.ts). */
    deviceLinks: number;
  };
}

/** Derived, never stored (ruling 7) — a plain join over `entrants` and
 *  `fixtures`, computed fresh on every call. No migration: `entrants` keeps
 *  `created_at` only (no `updated_at`) because "since when" is not needed to
 *  answer "does the board match the roster" (plan, 5a). */
export async function getStageRosterDrift(auth: AuthCtx, stageId: string): Promise<StageRosterDrift> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { division_id: string; kind: string; progression: Record<string, unknown> | null }[]
    >`select division_id, kind, progression from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.progression !== null || ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)) {
      return { ghosts: [], unplaced: [], attachments: NO_ATTACHMENTS };
    }

    // A stage with NO fixtures has no BOARD, and drift is defined against a
    // board — "the names on your fixtures no longer match your roster".
    // Without this, a freshly-created stage (the single most common state a
    // stage is ever in: created, not yet generated) reported EVERY active
    // entrant as "unplaced", so the banner fired on a division where nothing
    // had gone wrong and the one-click rebuild it offers would have been a
    // no-op regenerate. F3 ultrareview finding 6. `Generate` is the call to
    // action there, and stages-panel already renders it prominently.
    const [{ count: fixtureCount }] = await tx<{ count: number }[]>`
      select count(*)::int as count from fixtures where stage_id = ${stageId}`;
    if (fixtureCount === 0) return { ghosts: [], unplaced: [], attachments: NO_ATTACHMENTS };

    // Odd-Swiss sit-out (W3 item 6) — CLOSED by the bye-row follow-up.
    // Two suppression heuristics were tried and reviewed out (2026-09-06):
    // a `created_at` predicate that silently hid genuine withdraw→reinstate
    // drift, and a round-membership rule that was vacuous while `swissGen`
    // wrote no fixture for `pairRound`'s `bye`. `swissGen` now persists that
    // bye as a forfeited award row (home set / away null), so the sit-out is
    // in `referencedIds` and does not land in `unplaced`. Late registrations
    // between rounds still appear as unplaced-only; the UI softens that via
    // `swissAwaitingPairing` (no destructive rebuild). Pre-fix stages that
    // never wrote a bye row still score via the absence fallback in swissGen.
    const [active, referenced] = await Promise.all([
      tx<StageRosterDriftEntrant[]>`
        select id, display_name from entrants
        where division_id = ${stage.division_id} and status in ('registered', 'confirmed')
        order by display_name`,
      tx<StageRosterDriftEntrant[]>`
        select distinct e.id, e.display_name
        from entrants e
        where e.id in (
          select home_entrant_id from fixtures where stage_id = ${stageId} and home_entrant_id is not null
          union
          select away_entrant_id from fixtures where stage_id = ${stageId} and away_entrant_id is not null
        )
        order by e.display_name`,
    ]);
    const activeIds = new Set(active.map((e) => e.id));
    const referencedIds = new Set(referenced.map((e) => e.id));
    // One round trip for all three — each is a plain count over the stage's
    // own fixture ids, and none of them is large enough to want three.
    const [counts] = await tx<{ officials: number; lineups: number; device_links: number }[]>`
      select
        (select count(*) from fixture_officials fo
           join fixtures f on f.id = fo.fixture_id where f.stage_id = ${stageId})::int as officials,
        (select count(*) from lineups l
           join fixtures f on f.id = l.fixture_id where f.stage_id = ${stageId})::int as lineups,
        (select count(*) from device_links dl
           join fixtures f on f.id = dl.fixture_id where f.stage_id = ${stageId})::int as device_links`;
    return {
      ghosts: referenced.filter((e) => !activeIds.has(e.id)),
      unplaced: active.filter((e) => !referencedIds.has(e.id)),
      attachments: {
        officials: counts?.officials ?? 0,
        lineups: counts?.lineups ?? 0,
        deviceLinks: counts?.device_links ?? 0,
      },
    };
  });
}

export interface RebuildOutcome extends GenerateOutcome {
  /** Fixtures deleted before regenerating (0 only when the stage had none). */
  removed: number;
}

/**
 * Replace a root stage's fixtures wholesale — the fix for the defect the
 * roster-drift signal surfaces: `generateStageFixtures` is additive only
 * (idempotent via `fixtures.ext_key`, doc comment above), so a withdrawn
 * entrant's name never comes off the board on its own (F3 Task 5 plan,
 * "The defect this uncovers"). Two transactions, same pattern as
 * `replaceStages` above (delete, then re-`createStages`): the delete commits
 * under its own advisory lock, then `generateStageFixtures` — completely
 * unmodified, so every invariant it already holds (ext_key stability, feed
 * rewiring, slot labels, the division-events ledger, analytics) applies to
 * the rebuild for free — runs as an ordinary regenerate against the
 * now-empty stage.
 *
 * Refuses outright — never a partial rebuild (owner ruling, plan 5b) — the
 * moment ANY fixture in the stage carries a real result: a partial rebuild
 * would silently change who plays whom in a stage that's already half
 * played, which is unrecoverable once the organiser has acted on it.
 */
export async function rebuildStageFixtures(auth: AuthCtx, stageId: string): Promise<RebuildOutcome> {
  const removed = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      {
        id: string;
        division_id: string;
        kind: string;
        progression: Record<string, unknown> | null;
        competition_id: string;
      }[]
    >`select s.id, s.division_id, s.kind, s.progression, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.progression !== null || ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)) {
      throw new HttpError(
        422,
        "rebuild only applies to a stage that draws its fixtures directly from the active roster — a stage with a progression rule, a ladder stage, or an americano stage is not eligible",
        "STAGE_NOT_ROOT",
      );
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // A frozen division refuses the rebuild. Strictly wider than the
    // `clearScheduleScoped` the freeze already refuses: this HARD-DELETES
    // every fixture on the stage, cascading into score_events, match_states,
    // match_reports, lineups, official_marks, fixture_officials and
    // device_links (see the guard's own comment below).
    //
    // AND IT HAS TO BE HERE, not merely on `generateStageFixtures`. This
    // delete commits in its OWN transaction, and the regenerate runs after it
    // returns — so a rebuild that relied on the generator's guard would let
    // the delete land and only then refuse, handing the organiser an EMPTY
    // frozen board. That is the case
    // `stages-schedule-lock.test.ts`'s `fixtureCount` assertion pins, and it
    // is what separates this guard from the generator's: remove this one and
    // the refusal still arrives with the right status and code, from the
    // wrong side of the delete.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    // Never destroy a real result (hard constraint 1). Mirrors deleteStage's
    // guard above (same three statuses), with one refinement: 'forfeited'
    // alone doesn't distinguish a generation-time BYE (structural — one side
    // never had an opponent, isBye in stages-panel.tsx) from a mid-tournament
    // WITHDRAWAL WALKOVER (withdrawal.ts's core.forfeit — append-event.ts:116
    // maps it to this SAME 'forfeited' status). A walkover has two real
    // entrants and a real winner; destroying it would erase the reason the
    // opponent advanced. Only a two-sided 'forfeited' fixture blocks — a bye
    // (one side null by construction) does not.
    // Status alone is NOT a sufficient test, because `delete from fixtures`
    // CASCADEs into score_events, match_states, match_reports, lineups,
    // official_marks, fixture_officials and device_links, and SET NULLs
    // suspensions.fixture_id. Two holes a status-only guard leaves:
    //   - 'abandoned' is a match that was PLAYED and stopped. match-reports.ts
    //     (:40 REPORTABLE) accepts a report on exactly this status, so a
    //     status-only guard deletes the report along with the fixture.
    //   - any fixture carrying evidence rows under a status this list does not
    //     name — the scoring pad writes score_events/match_states, and nothing
    //     here should depend on WHEN a status flips relative to the first
    //     event landing.
    // So block on the evidence itself as well as on status: if a fixture has
    // anything recorded against it, it is not ours to delete.
    //
    // What this deliberately does NOT block on (F3 ultrareview finding 5):
    // `lineups`, `fixture_officials` and `device_links` also CASCADE away
    // with the fixtures, but they are organiser SETUP, not a result. An
    // organiser who has already appointed referees is the one most likely to
    // need a rebuild before match day, so blocking would disable the feature
    // exactly when it earns its keep. Destroying them silently is equally
    // wrong, so `getStageRosterDrift` counts all three and the confirm
    // dialog names them before the click (progression.rosterDrift.confirm*).
    // If a future table holds real RESULT data, it belongs in the guard
    // below, not in that count.
    //
    // One latent trapdoor, checked and currently INERT (2026-08-19): fixtures
    // .parent_fixture_id is a self-FK declared ON DELETE CASCADE (V214:18), so
    // a fixture that is someone's parent takes its children with it. Nothing
    // in apps/web writes that column today (zero rows), and its only intended
    // use — table-tennis rubbers under a tie (sports/setbased/tabletennis.ts)
    // — is same-stage, where taking the children with the parent is correct.
    // If a writer ever creates CROSS-STAGE parent links, this delete would
    // silently remove another stage's board and the guard below would not see
    // it. Note the cascade RECURSES on a self-FK: a chain deeper than one
    // level takes the whole subtree, not just direct children, so the blast
    // radius is not bounded at one hop. Verify with
    //   select count(*) from fixtures c join fixtures p
    //     on c.parent_fixture_id = p.id where c.stage_id <> p.stage_id;
    // (fixtures.court_id is RESTRICT but points OUT at courts, so it
    // constrains deleting a COURT, never this delete.)
    // The evidence-table list itself lives in `fixtureEvidenceSql` — ONE
    // literal, shared with `unpairSwissRound`'s guard, because the
    // 2026-09-20 review found Unpair shipping a SUBSET of this list and
    // destroying real results through the gap. Only the status clause is
    // per-caller. (`config_snapshot is not null` joins the list there; it is
    // implied by `exists(score_events)` for this guard — nothing in apps/web
    // ever deletes a score event — so it adds no refusal here, only
    // monotonicity where status is unreliable.)
    const [blocked] = await tx<{ id: string }[]>`
      select f.id from fixtures f
      where f.stage_id = ${stageId}
        and (
          f.status in ('in_play', 'decided', 'finalized', 'abandoned')
          or (f.status = 'forfeited' and f.home_entrant_id is not null and f.away_entrant_id is not null)
          or (${fixtureEvidenceSql(tx)})
        )
      limit 1`;
    if (blocked) {
      throw new HttpError(
        409,
        "this stage has fixtures with a recorded result — rebuild refuses to touch a stage that has already been played, even partly; complete it as it stands, or use Generate to add missing entrants without disturbing what's already been decided",
        "STAGE_HAS_RESULTS",
      );
    }

    const deleted = await tx<{ id: string }[]>`
      delete from fixtures where stage_id = ${stageId} returning id`;
    return {
      fixtureIds: deleted.map((row) => row.id),
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
    };
  });

  // R10e (review-r10d m1): ONE publish for the rebuild, naming the fixtures its
  // delete removed (their match centres refetch and find them gone) and never
  // the ids the regenerate created. In `finally`, because the delete has
  // already committed: a regenerate that throws must not leave the hub showing
  // the deleted board.
  let created = 0;
  try {
    const outcome = await generateStageFixturesUnpublished(auth, stageId);
    created = outcome.created;
    log.info(
      { event: "stage_fixtures_rebuilt", stageId, removed: removed.fixtureIds.length, created: outcome.created },
      "stage_fixtures_rebuilt",
    );
    return { ...outcome, removed: removed.fixtureIds.length };
  } finally {
    if (removed.fixtureIds.length > 0 || created > 0) {
      afterScheduleWrite(removed.divisionId, removed.competitionId, "schedule", removed.fixtureIds);
    }
  }
}

interface CrossFeed {
  from_ext_key: string;
  side: "winner" | "loser";
  to_stage_seq: number;
  to_ext_key: string;
  slot: 1 | 2;
}

async function wireCrossFeeds(tx: Tx, divisionId: string): Promise<void> {
  const stages = await tx<{ id: string; seq: number; config: Record<string, unknown> }[]>`
    select id, seq, config from stages where division_id = ${divisionId}`;
  const bySeq = new Map(stages.map((s) => [s.seq, s]));
  for (const stage of stages) {
    const feeds = stage.config.cross_feeds as CrossFeed[] | undefined;
    if (!Array.isArray(feeds)) continue;
    for (const feed of feeds) {
      const target = bySeq.get(feed.to_stage_seq);
      if (!target) continue;
      const [source] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${stage.id} and ext_key = ${feed.from_ext_key}`;
      const [dest] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${target.id} and ext_key = ${feed.to_ext_key}`;
      if (!source || !dest) continue; // wired once both stages generated
      if (feed.side === "winner") {
        await tx`update fixtures set winner_to_fixture = ${dest.id}, winner_to_slot = ${feed.slot}
                 where id = ${source.id} and winner_to_fixture is null`;
      } else {
        await tx`update fixtures set loser_to_fixture = ${dest.id}, loser_to_slot = ${feed.slot}
                 where id = ${source.id} and loser_to_fixture is null`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// D4a (P5) / F2 — TBD-shape generation for a `timing: "setup"` progression.
// Runs at division setup time, independent of the source stage's
// completion; count/shape derive purely from the progression's take rules
// (@seazn/engine/competition). See generateStageFixtures'
// `timing === "setup"` short-circuit above.
// ---------------------------------------------------------------------------

// Persisted labels carry an internal `seed` alongside the rendered
// {key, params} — destinationSlotsBySeed() (read by both computeSeedProposal
// and confirmSeedProposal) is the only reader; renderers destructure
// {key, params} and ignore it (see the design's "Renderers receive
// {key, params}" — this is bookkeeping, not wire contract).
type StoredSlotLabel = SlotLabel & { seed: number };

type SeededGenFixture = GenFixture & {
  homeLabel?: StoredSlotLabel;
  awayLabel?: StoredSlotLabel;
  awardLabel?: StoredSlotLabel;
};

/** "slot:7" -> 7 — the synthetic entrant id generateProgressionSetupFixtures
 *  mints for placement seat i (1-based), and the only place that format is parsed. */
function seedOfSlotId(id: string): number {
  return Number(id.slice("slot:".length));
}

// F2 — the source-resolution/shape/validation helpers this file used to
// define privately now live in stage-seeding.ts (resolveProgressionSource,
// sourceShapeOf, validateStageProgression), imported at the top of this
// file, so createStages/replaceStages/templates.ts's instantiateTemplate
// share ONE implementation instead of two.

async function generateProgressionSetupFixtures(auth: AuthCtx, stageId: string): Promise<GenerateWrite> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // `timing` is read by the CALLER (generateStageFixtures' pre-check) —
    // this function only ever runs for timing === "setup", so it is not
    // needed again here.
    const progression = stage.progression as unknown as ProgressionSpec;

    const shapes: SourceShape[] = [];
    for (const s of progression.sources) {
      const source = await resolveProgressionSource(tx, stage, s.stage);
      shapes.push(await sourceShapeOf(tx, source));
    }
    const pots = expandSources(progression.sources, (i) => shapes[i]!);
    // F3 round-3 review, Task 1 — `stage.kind` is THIS stage's own kind (the
    // progression's target), threaded through so placeDescriptors can refuse
    // an illegal snake-into-a-bracket-target combo (ruling 13) here too, not
    // just at createStages/replaceStages' save-time validateStageProgression
    // call — a `.setup` progression generates from a synthetic seed order
    // with no live standings, so this direct call is the day-one path ruling
    // 13's self-pairing draw actually reaches.
    const placed = placeDescriptors(pots, progression.placement, progression.map, stage.kind);
    if (placed.length < 2) {
      throw new EngineError("STAGE_NOT_READY", "this stage's progression rules produce fewer than 2 qualifiers", {
        stageId,
        count: placed.length,
      });
    }

    // P6 (F3 Task 3) verified: this map does NOT need sourceIndex-qualified
    // keys. It's keyed by the synthetic per-SEAT id `slot:${i+1}` (i = array
    // position in `placed`, already unique — never `descriptorKey`), so two
    // same-keyed descriptors from different sources (the multi-source
    // collision placeDescriptors now guards, progression.ts) already survive
    // here untouched: each gets its own seat regardless of what its
    // descriptor's key is. The actual fix for that collision lives entirely
    // in placeDescriptors (SEEDING_MAP_SOURCE_AMBIGUOUS) — see its doc
    // comment and _INDEX.md's P6 entry.
    const slotOf = new Map<string, SlotDescriptor>();
    const entrants: ActiveEntrant[] = placed.map((slot, i) => {
      const id = `slot:${i + 1}`;
      slotOf.set(id, slot.descriptor);
      return { id, seed: i + 1 };
    });

    // Group-kind target (e.g. a "Super 8" round robin fed by group-stage
    // qualifiers): materialise ITS pools rows first, same as the plain path.
    const poolIds = new Map<string, string>();
    if (stage.kind === "group" && poolCount(stage.config) > 1) {
      const existingPools = await tx<{ id: string; key: string }[]>`
        select id, key from pools where stage_id = ${stageId}`;
      for (const pool of existingPools) poolIds.set(pool.key, pool.id);
      for (let i = 0; i < poolCount(stage.config); i++) {
        const key = POOL_KEYS[i];
        if (poolIds.has(key)) continue;
        const [row] = await tx<{ id: string }[]>`
          insert into pools (stage_id, key, name)
          values (${stageId}, ${key}, ${"Pool " + key}) returning id`;
        poolIds.set(key, row.id);
      }
    }

    const existing = await tx<{ id: string; ext_key: string | null }[]>`
      select id, ext_key from fixtures where stage_id = ${stageId}`;

    // A `timing: "setup"` progression generates off SYNTHETIC entrants —
    // score-dependent formats (swiss/americano/ladder) have no seed-order
    // shape to draw before results exist, same restriction the plain path
    // has; `generate()` covers every bracket/table kind that DOES have one.
    const gen: SeededGenFixture[] = generate(stage.kind, stage.config, entrants, poolIds);

    // F2a (P7 follow-up, 2026-08-14): the plain path's `group_too_few_entrants`
    // guard (:990-999) only fires when `gen.length === 0` — but a
    // `timing: "setup"` group stage's `entrants` here are the PLACED SEEDS, snake-distributed
    // into `pools.count` pools the same way the plain path distributes real
    // entrants. Too few seeds for the configured pool count doesn't
    // necessarily zero out `gen` overall — it can leave INDIVIDUAL pools with
    // 0 or 1 seed (roundRobinGen emits nothing for those) while OTHER pools
    // still generate fine, so `gen.length > 0`. Those stranded seeds never
    // appear as home/away/award in any `gen` entry, so they never get a
    // home_slot_label/away_slot_label written below — and because `newRows`
    // is keyed by ext_key and `generate()` is deterministic, a second call
    // reproduces the identical (still-partial) `gen` and inserts nothing new.
    // The only symptom is computeSeedProposal 422ing SEEDING_RULES_MISSING
    // forever ("regenerate them first" — advice that cannot work, see
    // destinationSlotsBySeed below). Catch the real condition — a placed seed
    // with nowhere to land — BEFORE any row is inserted, so the transaction
    // fails cleanly instead of committing a stage that can never be seeded.
    const referenced = new Set<string>();
    for (const g of gen) {
      if (typeof g.home === "string") referenced.add(g.home);
      if (typeof g.away === "string") referenced.add(g.away);
      if (typeof g.award === "string") referenced.add(g.award);
    }
    const stranded = entrants.filter((e) => !referenced.has(e.id));
    if (stranded.length > 0) {
      const groups = stage.kind === "group" ? poolCount(stage.config) : 1;
      const required = Math.max(2, groups * 2);
      throw new EngineError(
        "STAGE_NOT_READY",
        groups > 1
          ? `not enough qualifiers to fill ${groups} groups — each group needs at least 2 (have ${placed.length}, need ${required}); ${stranded.length} would never receive a fixture`
          : // Reaching here means fixtures WERE generated and some qualifier
            // still got none — a partial fill, never "no matches at all". Saying
            // the latter would repeat the unactionable-advice defect this guard
            // exists to remove. Unreachable today (with one pool stages.ts:655-656
            // runs a full-field round robin that strands nobody, and every bracket
            // generator places every seed or throws), so this is the shape a future
            // generator regression would surface through, not live copy.
            `${stranded.length} of ${placed.length} qualifiers would never receive a fixture`,
        {
          stageId,
          reason: "seeded_pool_too_few_qualifiers",
          groups,
          qualifiers: placed.length,
          required,
          stranded: stranded.length,
        },
      );
    }

    // Convert synthetic slot refs into labels. A bye AWARD line propagates
    // its label into the winner feed too (both resolve to the SAME
    // descriptor at confirm time) — see the third pass below. A bye seed
    // therefore legitimately owns TWO destination slots: the bye fixture's
    // own `home` slot (stamped right here) AND the winner-feed target's slot
    // (stamped by the third pass). destinationSlotsBySeed() returns every
    // slot for a given seed, and confirmSeedProposal fills all of them
    // through fillSlot — #554 fixed a bug where collapsing a seed's slots to
    // ONE (last-write-wins, no ORDER BY) silently stranded whichever slot
    // wasn't picked.
    //
    // The bye-line fixture itself cannot be auto-decided HERE the way a
    // live/registered-entrant bye is: there is no real entrant yet to record
    // the walkover for. It is written 'scheduled' like any other TBD slot and
    // decided at the moment its seat is filled — confirmSeedProposal's
    // `awardSeededByes` call, keyed off the `bracket.slot.bye` label stamped
    // below. Leaving it 'scheduled' after the fill is what shipped the defect
    // `progression-bye-is-decided.test.ts` pins: unplayable by construction
    // (one side is empty forever), so the stage never completes, and `isBye`
    // reads false, so it renders as an open match awaiting a draw.
    for (const g of gen) {
      if (typeof g.home === "string" && slotOf.has(g.home)) {
        g.homeLabel = { ...descriptorLabel(slotOf.get(g.home)!), seed: seedOfSlotId(g.home) };
        g.home = null;
      }
      if (typeof g.away === "string" && slotOf.has(g.away)) {
        g.awayLabel = { ...descriptorLabel(slotOf.get(g.away)!), seed: seedOfSlotId(g.away) };
        g.away = null;
      }
      if (typeof g.award === "string" && slotOf.has(g.award)) {
        g.awardLabel = g.homeLabel ?? { ...descriptorLabel(slotOf.get(g.award)!), seed: seedOfSlotId(g.award) };
      }
    }

    const byKey = new Map<string, string>();
    for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

    const newRows = gen
      .filter((g) => !byKey.has(g.extKey))
      .map((g) => ({
        id: randomUUID(),
        stage_id: stageId,
        division_id: stage.division_id,
        pool_id: g.poolId ?? null,
        round_no: g.roundNo,
        seq_in_round: g.seqInRound,
        home_entrant_id: null,
        away_entrant_id: null,
        ext_key: g.extKey,
        status: "scheduled",
        outcome: null,
        // F1: same role columns as the plain generateStageFixtures path —
        // seeded (placeholder) brackets must persist a role too, or the
        // day-one preview path F3 depends on renders with no role at all.
        lane: g.lane ?? null,
        is_final: g.isFinal === true,
        third_place: g.thirdPlace === true,
        conditional: g.conditional === true,
      }));
    if (newRows.length > 0) await tx`insert into fixtures ${tx(newRows)}`;
    for (const r of newRows) byKey.set(r.ext_key, r.id);
    const created = newRows.length;
    const createdIds = newRows.map((r) => r.id);

    // Labels via a direct per-row update with tx.json() (the pattern proven
    // everywhere else in this file, e.g. wireCrossFeeds/config writes) —
    // NOT folded into the bulk array-insert above: that helper's per-column
    // type inference binds a JSON.stringify'd JS string as `text`, and
    // Postgres has no implicit text->jsonb PARSE cast in that bound-
    // parameter context, so it lands double-encoded (a jsonb STRING
    // containing escaped JSON text, not the parsed object) — confirmed
    // empirically against this exact insert, not assumed.
    for (const g of gen) {
      const fixtureId = byKey.get(g.extKey);
      if (fixtureId === undefined) continue;
      if (g.homeLabel) {
        await tx`update fixtures set home_slot_label = ${tx.json(g.homeLabel as never)} where id = ${fixtureId}`;
      }
      if (g.awayLabel) {
        await tx`update fixtures set away_slot_label = ${tx.json(g.awayLabel as never)} where id = ${fixtureId}`;
      }
      // A bye's phantom side resolves to nobody, ever — padding the bracket
      // out to a power of two is the entire reason the seat exists. Without a
      // label there, resolveSlotLabel falls through to a generic TBD, which
      // tells the organiser to wait for an opponent who is not coming; the
      // plain (non-progression) path has stored `bracket.slot.bye` there since
      // the P5 review (`byeSlotLabel` at its own insert) and this is the same
      // store on the seeded path, so every renderer already going through
      // resolveSlotLabel picks it up for free.
      //
      // It is also the MARKER `awardSeededByes` reads at confirm time to tell
      // a walkover line apart from a slot still waiting on a feeder — which is
      // why it is stamped here, at the one place that knows `g.award`, rather
      // than re-derived later from a row shape that cannot distinguish them.
      //
      // Deliberately carries NO `seed`: destinationSlotsBySeed keys on that
      // field to decide which slots a qualifier fills, and this seat is not a
      // destination. Both sides are guarded rather than assuming the engine
      // always lands the award on `home` (buildSingleElim does today), same
      // symmetry the plain path keeps.
      if (g.award !== undefined) {
        if (g.home === null && !g.homeLabel) {
          await tx`update fixtures set home_slot_label = ${tx.json(BYE_SLOT_LABEL as never)} where id = ${fixtureId}`;
        }
        if (g.away === null && !g.awayLabel) {
          await tx`update fixtures set away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)} where id = ${fixtureId}`;
        }
      }
    }

    // Feed wiring — identical shape to generateStageFixtures' second pass.
    const feedUpdates = { winner: [], loser: [] } as Record<
      "winner" | "loser",
      { source: string; target: string; slot: number }[]
    >;
    for (const g of gen) {
      const targetId = byKey.get(g.extKey);
      if (!targetId) continue;
      for (const [feed, slot] of [
        [g.homeFrom, 1],
        [g.awayFrom, 2],
      ] as const) {
        if (!feed) continue;
        const sourceId = byKey.get(feed.extKey);
        if (!sourceId) continue;
        feedUpdates[feed.side].push({ source: sourceId, target: targetId, slot });
      }
    }
    if (feedUpdates.winner.length > 0) {
      const u = feedUpdates.winner;
      await tx`
        update fixtures f
        set winner_to_fixture = v.target_id, winner_to_slot = v.slot
        from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                     unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                     unnest(${u.map((x) => x.slot)}::int[])    as slot) v
        where f.id = v.source_id and f.winner_to_fixture is null`;
    }
    if (feedUpdates.loser.length > 0) {
      const u = feedUpdates.loser;
      await tx`
        update fixtures f
        set loser_to_fixture = v.target_id, loser_to_slot = v.slot
        from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                     unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                     unnest(${u.map((x) => x.slot)}::int[])    as slot) v
        where f.id = v.source_id and f.loser_to_fixture is null`;
    }

    // Third pass — TBD-aware bye propagation: writes the SAME label into the
    // winner feed's slot instead of a real entrant id.
    const awardedLabelled = gen.filter((g) => g.awardLabel !== undefined && byKey.has(g.extKey));
    if (awardedLabelled.length > 0) {
      const sources = await tx<
        { id: string; winner_to_fixture: string | null; winner_to_slot: number | null }[]
      >`select id, winner_to_fixture, winner_to_slot from fixtures
        where id in ${tx(awardedLabelled.map((g) => byKey.get(g.extKey)!))}`;
      const srcOf = new Map(sources.map((s) => [s.id, s]));
      for (const g of awardedLabelled) {
        const source = srcOf.get(byKey.get(g.extKey)!);
        if (!source?.winner_to_fixture) continue;
        if (source.winner_to_slot === 1) {
          await tx`update fixtures set home_slot_label = ${tx.json(g.awardLabel as never)}
                   where id = ${source.winner_to_fixture} and home_entrant_id is null`;
        } else if (source.winner_to_slot === 2) {
          await tx`update fixtures set away_slot_label = ${tx.json(g.awardLabel as never)}
                   where id = ${source.winner_to_fixture} and away_entrant_id is null`;
        }
      }
    }

    if (stage.status === "pending") {
      await tx`update stages set status = 'active' where id = ${stageId}`;
    }

    const fixtureRows = await tx<Omit<FixtureRow, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.venue, f.court_label, f.court_id,
             f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
    // #14: venue-qualified label (a bare joined `courts.name` can't tell two
    // same-named courts in different venues apart) — same fallback
    // convention as FixtureRow's own doc comment: fall back to the id
    // itself on a miss (should not happen; FK-restricted).
    const courtNames = await courtNamesById(tx);
    const fixtures = fixtureRows.map((f) => ({
      ...f,
      court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
    }));

    if (created > 0) {
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'fixtures_generated',
                ${tx.json({ stage_id: stageId, fixture_ids: createdIds } as never)})`;
      await tx`update divisions set seq = ${last + 1}, edit_watermark = null
               where id = ${stage.division_id}`;
    }
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    return {
      outcome: { created, existing: gen.length - created, fixtures },
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
    };
  });
}

/** Fill one side of a fixture (slot 1=home, 2=away) if still open. The ONE
 *  real mutation point for putting an entrant into a fixture slot — every
 *  cross-stage or intra-bracket advancement routes through this (D4a/P5
 *  scope item 3: "one pathway, not two"). Also clears the matching
 *  `*_slot_label` (D4a design's Fill algorithm step 4: "clear its
 *  *_slot_label params" — label text is derivable post-fill, and the
 *  proposal row keeps it for history); a no-op for the pre-existing
 *  intra-bracket callers, whose fixtures never had a label set. */
export async function fillSlot(
  tx: Tx,
  fixtureId: string,
  slot: number,
  entrantId: string,
): Promise<string | null> {
  // R10g: the id the update actually touched (null when the slot was already
  // filled), so a caller that publishes names exactly what its own write
  // filled, never a list re-read or re-derived after the fact.
  const [row] = slot === 1
    ? await tx<{ id: string }[]>`update fixtures set home_entrant_id = ${entrantId}, home_slot_label = null
             where id = ${fixtureId} and home_entrant_id is null returning id`
    : await tx<{ id: string }[]>`update fixtures set away_entrant_id = ${entrantId}, away_slot_label = null
             where id = ${fixtureId} and away_entrant_id is null returning id`;
  return row?.id ?? null;
}

/** Decide every bye line in `stageId` whose real side is now occupied, and
 *  return the fixture ids this call actually changed.
 *
 *  A `timing: "setup"` progression draws its bracket before anyone has
 *  qualified, so the walkover the plain path bakes straight into its INSERT
 *  (`status: 'forfeited'` + `{kind: 'award', winner}`) cannot be written at
 *  generation time — there is nobody to award it to yet. It has to be written
 *  at the moment the seat is filled, and nothing did: the row stayed
 *  `scheduled` with a null outcome for the whole life of the competition.
 *  Two things follow from that, and they are the defect this exists to close:
 *  the line is unplayable by construction (its other side is empty forever),
 *  so the stage can never complete; and `isBye` (lib/run-sheet-groups — the
 *  ONE predicate the run sheet row and the bracket panel both gate their bye
 *  branch on) reads false, so it renders as an ordinary open match "awaiting
 *  a draw". Every progression-bearing template in the catalogue declares
 *  `timing: "setup"`, so it reached league_ko, groups_ko, group_stepladder,
 *  ko_plate, qualifying_main and both swiss composites alike.
 *
 *  A bye is identified by the `bracket.slot.bye` label its own generation
 *  stamped on the phantom side — NEVER by "one side is null", which is also
 *  every later-round slot still waiting on a feeder, and every half-filled
 *  final. Idempotent: `status = 'scheduled'` makes a second call a no-op, and
 *  a line whose real seat has not been filled yet is left alone until it is. */
async function awardSeededByes(tx: Tx, stageId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    update fixtures set
      status = 'forfeited',
      outcome = jsonb_build_object(
        'kind', 'award', 'winner', coalesce(home_entrant_id, away_entrant_id))
    where stage_id = ${stageId}
      and status = 'scheduled'
      and outcome is null
      and (
        (away_entrant_id is null and home_entrant_id is not null
           and away_slot_label->>'key' = ${BYE_SLOT_LABEL.key})
        or
        (home_entrant_id is null and away_entrant_id is not null
           and home_slot_label->>'key' = ${BYE_SLOT_LABEL.key})
      )
    returning id`;
  return rows.map((r) => r.id);
}

// L3/#414 pass 3 — REAL_TABLE_KINDS are the kinds a carry-over may source
// from: league/group/swiss. Carry-over (seedNextStage below, and
// computeSeedProposal's propose-time guard since F6) refuses every other kind,
// because what a progression actually READS from a source is the PoolTable
// that tablesForCompletedStage / sourcesToTables builds — and for every OTHER
// kind that table comes from `placementTable`, which zeroes played/won/drawn/
// lost/points and metrics (engine competition/progression.ts). Carrying from
// one would seed the next stage with fabricated zeros instead of refusing
// outright.
//
// Corrected 2026-09-15 (F6 review round 1) — this used to claim
// REAL_TABLE_KINDS were "the only kinds whose standings snapshot carries
// actual points/metrics (folded via completeTableStage)" and lumped americano
// in with the bracket kinds as snapshotting placements. Both halves were wrong
// about americano, and the error propagated out of here into F6's organiser
// copy before review caught it. What is actually true:
//
//   - americano IS in engine-db/competition.ts's TABLE_KINDS, so its own
//     completion snapshot folds REAL points via completeTableStage — but over
//     the EPHEMERAL per-round PAIR entrants (Jul3/08 §3). That is precisely why
//     the progression path never reads that snapshot: americanoPlacementTables
//     (below) re-derives personal points, maps them onto the division's
//     individual entrants, and returns `placementTable(ordered)`. Both the
//     on_complete and the setup path go through it. So americano does reach a
//     carry as zeroed placements like the rest — by a different ROUTE than the
//     old comment described, which is the part that was wrong.
//   - ladder is `placementTable(config.ladder_order)` and the bracket kinds are
//     `placementTable(bracketRanks(...))`, both written at completion time by
//     completeStageIfReady — those two the old comment had right.
//
// The refusal set is therefore correct as shipped; only its stated reason was
// not. Do not "simplify" this back to a claim about completeTableStage.
//
// BRACKET_KINDS mirrors engine-db/competition.ts's own list — losersOfRound
// only makes sense sourced from one of these.
const REAL_TABLE_KINDS = new Set(["league", "group", "swiss"]);
// Exported (F3 review item 5): stage-seeding.ts's sourcesToTables needs the
// SAME set to know when a source needs bracket data for a roundLosers take
// rule — see loadBracketFixtures' own export note below.
export const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

// F6 (#625) — carry-over has TWO application paths now: seedNextStage (below,
// `timing:"on_complete"`) and the propose/confirm pair (computeSeedProposal /
// confirmSeedProposal, `timing:"setup"`). The three helpers here are what both
// read, so the pair cannot drift on WHICH sources may be carried from, WHAT
// the refusal says, or WHICH rows fold into the deltas.
//
// They deliberately stop short of throwing, because the two paths surface from
// DIFFERENT endpoints whose error vocabularies differ, and sharing the throw
// would have to pick one and break the other:
//
//   - seedNextStage's refusal leaves POST /stages/{id}/complete. It keeps its
//     EngineError CONFIG_INVALID — completeStage's catch swallows only
//     STAGE_NOT_READY, so this one propagates and reaches the client through
//     ENGINE_HTTP (api-v1/http.ts) as a 422. That is a shipped contract
//     qualification-from-any-stage.test.ts pins on all three non-real kinds.
//   - computeSeedProposal's refusal answers POST /stages/{id}/seed-proposal,
//     whose whole error vocabulary is SEEDING_* HttpErrors that
//     seeding-error.ts renders into localised organiser copy. An EngineError
//     raised there would reach the panel as raw English, the way
//     STAGE_NOT_READY's own unwired fallback still does.
//
// Sharing the SENTENCE gets the drift protection without either compromise.

/** The first carry source whose kind offers no points table to carry from, or
 *  `undefined` when every source is a REAL_TABLE_KINDS stage. */
function nonRealCarrySource(
  resolved: readonly { id: string; kind: string }[],
): { id: string; kind: string } | undefined {
  return resolved.find((s) => !REAL_TABLE_KINDS.has(s.kind));
}

/** The one sentence both refusal sites raise. Named `kind` is the offending
 *  source's stage kind, not the target's.
 *
 *  Says "offers a finishing order" rather than the "completion has no real
 *  points" this carried from Jul3/05 until the F6 round-1 review: that older
 *  wording is false for an americano source, whose own completion snapshot
 *  DOES fold real points (over pair entrants) — see REAL_TABLE_KINDS above.
 *  What is true of every refused kind is the finishing order a progression
 *  reads from it. */
function carrySourceRefusal(kind: string): string {
  return `carry-over needs a table-stage source (league/group/swiss) — a "${kind}" source offers a finishing order, not a points table`;
}

/** Opening deltas for a target stage: every source-table row belonging to an
 *  entrant that actually qualified, folded by the engine's own `carryDeltas`
 *  (competition/points.ts) — never re-implemented here. The filter is the
 *  load-bearing half: without it a knocked-out entrant's points would arrive
 *  in the next stage's opening table. */
function buildCarryDeltas(
  tables: readonly SourceTables[],
  entrantIds: readonly string[],
  mode: "points" | "full",
): unknown[] {
  const qualified = new Set(entrantIds);
  const rows = tables.flatMap((t) => t.pools.flatMap((p) => p.rows)).filter((r) => qualified.has(r.entrantId));
  return carryDeltas(rows, mode);
}

/** One auditable `standings_carried` row — shared by seedNextStage and
 *  confirmSeedProposal so the two paths cannot drift on payload shape. */
async function insertStandingsCarriedEvent(
  tx: Tx,
  divisionId: string,
  seq: number,
  payload: { stageId: string; from: string; mode: "points" | "full"; entrants: string[] },
): Promise<void> {
  await tx`
    insert into division_events (division_id, seq, type, payload)
    values (${divisionId}, ${seq}, 'standings_carried', ${tx.json(payload as never)})`;
}

// Mirrors engine-db/competition.ts's private toEngineStatus (not exported):
// DB fixtures.status -> engine FixtureStatus (spec 05 §1 vocabulary). Needed
// only to satisfy BracketFixture's required `status` field when rebuilding a
// completed bracket's own fixtures for `losersOfRound` below —
// resolveProgression's round_loser branch never actually reads status
// (round + loser only), but the type does.
function toBracketFixtureStatus(dbStatus: string): FixtureStatus {
  switch (dbStatus) {
    case "decided":
    case "finalized":
      return "decided";
    case "forfeited":
      return "walkover";
    case "abandoned":
    case "cancelled":
      return "void";
    case "in_play":
      return "in_play";
    default:
      return "scheduled";
  }
}

// Rebuild the completed bracket's own BracketFixture[] for `roundLosers`
// (@seazn/engine/competition's progression.ts) — never re-derived from `standings_snapshots`, which
// only ever carries FINAL ranks, not which round a fixture belongs to.
// Before F1 (2026-08-17), `ext_key` was the only place a bracket fixture's
// lane/thirdPlace survived persistence, so this parsed it via engine-db/
// competition.ts's own parseExtKey (pass 2) rather than reading a column.
// `fixtures.lane`/`fixtures.third_place` now carry the same information
// directly (db/migration/deltas/V368__fixture_round_role.sql) — this
// function still derives from ext_key below because it hasn't been migrated
// to the new columns, not because ext_key is still the only source. Either
// way, never re-derive bracket position from round/seq_in_round: a
// bracket's rounds number sparsely (1,2,3 winners' side, 7-10 losers' side,
// 14 grand final).
// resolveProgression's round_loser branch trusts ITS CALLER for bracket-position
// order (there is nothing left for it to sort by) — `order by round_no,
// seq_in_round` below is what makes THIS the ordering authority.
// F3 review item 5 (RESOLVED) — exported so stage-seeding.ts's
// sourcesToTables (the `timing:"setup"` propose/confirm path's own table
// builder) can populate SourceTables.bracket too, not just this file's own
// seedNextStage/tablesForCompletedStage (the `timing:"on_complete"` path).
// Before this, sourcesToTables NEVER fetched bracket data at all — a
// roundLosers take rule under `timing:"setup"` (ko_plate's real catalogue
// shape once F3 flipped every picker template to day-one fixtures) could
// never resolve: progression.ts's loserAt throws STAGE_NOT_READY without
// `bracket`, silently swallowed by completeStage's best-effort catch, so an
// organiser's plate stage stayed on TBD forever with no visible error.
export async function loadBracketFixtures(tx: Tx, stageId: string): Promise<BracketFixture[]> {
  const rows = await tx<
    {
      id: string;
      round_no: number;
      status: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      outcome: unknown;
      ext_key: string | null;
    }[]
  >`
    select id, round_no, status, home_entrant_id, away_entrant_id, outcome, ext_key
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
  return rows.map((f) => {
    const { bracket, thirdPlace } = parseExtKey(f.ext_key);
    const { winner, loser } = bracketWinnerLoser(f.outcome, f.home_entrant_id, f.away_entrant_id);
    return {
      id: f.id,
      round: f.round_no,
      status: toBracketFixtureStatus(f.status),
      ...(bracket !== undefined ? { bracket } : {}),
      ...(thirdPlace ? { thirdPlace: true } : {}),
      ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
      ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
      ...(winner !== undefined ? { winner } : {}),
      ...(loser !== undefined ? { loser } : {}),
    };
  });
}

export interface SeededStage {
  stage_id: string;
  entrants: string[];
}

export interface CompleteStageResult extends CompleteResult {
  /** Set when completion resolved the next stage's progression (a
   *  `timing: "on_complete"` progression — the OLD `stages.qualification`
   *  auto-seed flow). */
  qualified?: SeededStage;
  /** Fixtures auto-generated for the seeded next stage. */
  next_stage_fixtures?: number;
  /** True when this was the last stage — the division is now completed. */
  division_completed?: boolean;
  /** D4a (P5) — set when completion computed a draft seed proposal for a
   *  `timing: "setup"` next stage's progression. Propose + confirm, never
   *  fully automatic (owner ruling): unlike `qualified` above, this never
   *  fills anything by itself. */
  seed_proposal?: { id: string; status: string };
}

/**
 * Guarded progression (doc 08 §3): no-op unless the completion predicate
 * holds. On completion:
 *  - a `timing: "setup"` next stage (D4a/P5) gets a DRAFT seed proposal
 *    computed (never auto-filled — propose + confirm); its fixtures already
 *    exist as TBD placeholders, generated at division setup time.
 *  - a `timing: "on_complete"` next stage (the OLDER `.qualification`
 *    mechanism) keeps its existing auto-seed-then-generate behaviour,
 *    idempotent — an already-seeded stage is not re-seeded.
 *
 * `publish` (R10f; on by default since R10g): once the stage is complete,
 * the call publishes the hub key ONCE after everything it did, the next
 * stage's draw included, however it ends (the `finally` below). A caller that
 * publishes the whole write itself opts out with `{ publish: false }`, and
 * today only scoring's auto-advance does. On by default because a redundant
 * publish costs one hub refetch, while a missed one leaves every subscribed
 * hub stale with every test still green.
 */
export async function completeStage(
  auth: AuthCtx,
  stageId: string,
  opts: { publish?: boolean } = {},
): Promise<CompleteStageResult> {
  const current = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; seq: number; competition_id: string }[]>`
      select s.division_id, s.seq, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    return stage;
  });
  const result = await completeStageIfReady(auth.orgId, stageId);
  if (!result.completed) return result;

  // R10g (review-r10f m2): from here the stage is complete (its completion
  // committed), and the hub shows stage and division status (its standings
  // tables order by stage status). So every way out of this call publishes
  // the hub key once, after all of it: a draw, a seed proposal, the division
  // completing, nothing drawn at all (the last stage, or a freeze refusing
  // the draw), or a later step throwing after the completion stood. The one
  // publish covers the draw too (its fixture ids are all new, so no fixture
  // key is owed), which is why the next stage is drawn unpublished. A refused
  // completion (not ready, or a 404 / engine error before the commit) has
  // already returned or thrown above, and sends nothing.
  try {
    return await progressCompletedStage(auth, stageId, current, result);
  } finally {
    if (opts.publish ?? true) {
      afterScheduleWrite(current.division_id, current.competition_id, "schedule", []);
    }
  }
}

/** What a complete stage does next (see `completeStage`): seed and draw the
 *  next stage, compute its seed proposal, or complete the division. It
 *  publishes nothing itself. */
async function progressCompletedStage(
  auth: AuthCtx,
  stageId: string,
  current: { division_id: string; seq: number },
  result: CompleteResult,
): Promise<CompleteStageResult> {
  const next = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; progression: Record<string, unknown> | null }[]>`
      select id, progression from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    return row ?? null;
  });
  const nextProgression = next?.progression as (ProgressionSpec & { timing: "setup" | "on_complete" }) | null | undefined;

  void fireStageRevalidate(auth.orgId, stageId);

  if (nextProgression?.timing === "setup") {
    // Best-effort, same spirit as the on_complete path's generation step
    // below: completion stands even if the proposal compute trips (e.g. the
    // source stage this points at isn't THIS one and isn't ready yet).
    // Narrowed the same INTENT as the on_complete branch just below (A4,
    // round-4 review): this used to be a bare `catch { return result }`, no
    // narrowing, no logging, despite this comment already claiming
    // "best-effort, same spirit" — so a genuine progression-config bug (e.g.
    // A1's SEEDING_BESTNTH_UNEQUAL_POOLS, or QUALIFICATION_INVALID) reached
    // an organiser as "nothing happened": the stage completed, no
    // seed_proposal, no error anywhere.
    //
    // The exact TYPE this checks differs from the on_complete sibling below
    // on purpose, not by oversight: that branch's own completeness gate
    // (seedNextStage, this file) throws EngineError STAGE_NOT_READY
    // directly, but THIS path's completeness gate is computeSeedProposal ->
    // sourcesToTables (stage-seeding.ts), which throws HttpError 409
    // SEEDING_SOURCE_INCOMPLETE instead — confirmed by a real red test
    // (progression-multi-source.test.ts) that first tried mirroring the
    // sibling's EngineError check verbatim and broke the legitimate
    // "another named source isn't complete yet" case, which is exactly the
    // regression this fix must not introduce. By the time resolveProgression
    // runs in this path, sourcesToTables has already gated every source on
    // DB-status "complete", so an EngineError STAGE_NOT_READY reaching this
    // catch (e.g. rowAtRank's "not enough entrants ranked yet") is a genuine
    // misconfiguration, not a "wait for it" case, and must propagate — same
    // as QUALIFICATION_INVALID does.
    try {
      const proposal = await computeSeedProposal(auth, next!.id);
      return { ...result, seed_proposal: { id: proposal.id, status: proposal.status } };
    } catch (err) {
      // F3 ultrareview finding 4 — this stage's completion committed in its
      // OWN transaction, several statements ago. A bare re-throw therefore
      // reached the organiser as a plain failure for an action that actually
      // SUCCEEDED: the board still showed the stage as active (the client's
      // catch has nothing to refresh on an error), so the next click hit an
      // already-complete stage. Re-throwing is still right — A4 above added
      // it precisely so a genuine progression misconfiguration stops being
      // silent — but it has to say WHICH half failed. Wrapped in a code the
      // panel classifies into "completed, but the next stage's seeding
      // couldn't be prepared", so the organiser gets the real reason AND a
      // refreshed board.
      if (
        !(err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") &&
        !(err instanceof HttpError && err.code === "STAGE_COMPLETED_SEEDING_FAILED")
      ) {
        log.warn(
          { event: "seed_proposal_compute_failed", stageId, nextStageId: next!.id, err: String(err) },
          "stage completed, but computing the next stage's seed proposal failed",
        );
        throw new HttpError(
          409,
          err instanceof Error ? err.message : String(err),
          "STAGE_COMPLETED_SEEDING_FAILED",
          { stageId, nextStageId: next!.id },
        );
      }
      if (!(err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE")) throw err;
      log.warn(
        { event: "seed_proposal_compute_skipped", stageId, nextStageId: next!.id, err: String(err) },
        "seed proposal compute skipped: a named progression source is not ready yet",
      );
      return result;
    }
  }

  let qualified: SeededStage | null = null;
  if (nextProgression?.timing === "on_complete") {
    try {
      qualified = await seedNextStage(auth, stageId);
    } catch (err) {
      // Best-effort ONLY for "a named source isn't complete yet"
      // (STAGE_NOT_READY) — same spirit as the setup-timing branch above:
      // Decision 4's multi-source progressions can legitimately have OTHER
      // named sources still incomplete when THIS stage completes, and
      // completeStageIfReady already committed this stage's own completion
      // above, so a downstream seed attempt tripping on that must not read
      // back to the caller as "the completion failed" (F2 Task 6 review,
      // finding 1 — this call had NO catch at all, while the comment a few
      // lines below already, wrongly, claimed one existed). Every OTHER
      // EngineError still propagates — QUALIFICATION_INVALID in particular
      // is a genuine progression-config bug (an entrant qualifying through
      // two sources), and progression-multi-source.test.ts's "rejects an
      // entrant qualifying through two sources" case depends on that NOT
      // being swallowed here.
      if (!EngineError.is(err, "STAGE_NOT_READY")) throw err;
      qualified = null;
    }
  }
  if (!qualified) {
    // No stage follows: the division itself is done (doc 02 lifecycle
    // setup → active → completed). Idempotent — re-completing is a no-op.
    const divisionCompleted = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<{ division_id: string }[]>`
        select division_id from stages where id = ${stageId}`;
      if (!stage) return false;
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
      const [remaining] = await tx`
        select 1 from stages
        where division_id = ${stage.division_id} and status <> 'complete' limit 1`;
      if (remaining) return false;
      const [row] = await tx<{ id: string }[]>`
        update divisions set status = 'completed'
        where id = ${stage.division_id} and status <> 'completed'
        returning id`;
      if (!row) return false;
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'division_completed',
                ${tx.json({ lastStageId: stageId } as never)})`;
      await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
      return true;
    });
    return divisionCompleted ? { ...result, division_completed: true } : result;
  }
  // Best-effort: completion stands even if generation trips (e.g. paywall, or
  // — since the freeze guard at the top of `generateStageFixtures` — a frozen
  // division refusing the write). The completion above has ALREADY committed;
  // undoing it because the next stage could not be drawn would be worse than
  // leaving that stage empty, and refusing the completion itself would make
  // the freeze bind a lifecycle TRANSITION, which is exactly the line
  // `startDivision` was built to hold (see schedule-start-gate.test.ts).
  //
  // WHY THIS STILL SWALLOWS EVERYTHING. Narrowing it to re-throw non-freeze
  // faults is not a free change: the paywall case this comment has always
  // named reaches here as a `PaymentRequiredError` (402), and an incomplete
  // multi-source progression reaches it as `STAGE_NOT_READY` — both are
  // legitimate, expected trips that must not fail a committed completion.
  // Deciding which of the remaining causes SHOULD fail it is a product call,
  // not a guard's to make, so the shape is deliberately unchanged.
  //
  // WHAT DID CHANGE: it no longer swallows SILENTLY. This was a bare
  // `catch { generated = undefined; }` that logged nothing at all, so a real
  // generator fault — a bad bracket, a DB error — was exactly as invisible as
  // a freeze refusal, and an organiser's next stage stayed empty with no
  // record anywhere of why. The freeze did not create that hole; it revealed
  // it. So the record NAMES the error, and flags the freeze case specifically
  // (`locked`) so the two can be told apart without parsing prose.
  //
  // WHO PUBLISHES THE DRAW (R10f, R10g): `completeStage` does, once, in its
  // `finally` after this returns, unless its caller opted out. So the draw
  // goes through the unpublished generate: publishing here as well would
  // cost the hub a second refetch. Scoring's auto-advance opts out
  // (`{ publish: false }`) because it runs inside a decided fixture's
  // post-commit hooks (`onDecided`). Reached from `scoreEvent`, that write's
  // `finally` already drops the same hub key and pushes the division once
  // the hooks are done. Reached from the batch importer (`event-import.ts`),
  // its `finally` DELs the hub key but sends no push, by design (a backfill
  // of finished results, not a live pad).
  let generated: number | undefined;
  try {
    generated = (await generateStageFixturesUnpublished(auth, qualified.stage_id)).created;
  } catch (err) {
    const code = err instanceof HttpError ? err.code : undefined;
    const locked = code === SCHEDULE_LOCKED_CODE;
    log.warn(
      {
        event: "next_stage_generate_skipped",
        stageId,
        nextStageId: qualified.stage_id,
        locked,
        code,
        status: err instanceof HttpError ? err.status : undefined,
        err: String(err),
      },
      locked
        ? "next stage not generated: the division schedule is locked"
        : "next stage not generated: the generator failed",
    );
    generated = undefined;
  }
  return { ...result, qualified, ...(generated !== undefined ? { next_stage_fixtures: generated } : {}) };
}

// Resolve the next pending stage's progression against its source(s)' real
// placements. L3/#414 pass 3 — every stage kind now completes with a
// placement snapshot (pass 2's completeStageIfReady): table kinds (league/
// group/swiss) write REAL per-pool standings; bracket/ladder write a single
// placementTable-wrapped row (pool_id null). Both read the SAME way below —
// a null pool_id resolves to the unnamed pool "" / `overall`, so rankRange/
// topNPerGroup/bestNth/picks/roundLosers all just work. Americano is the one
// exception: its OWN standings_snapshot folds over ephemeral per-round PAIR
// entrants (Jul3/08 §3), not the persistent individual entrants the next
// stage draws from, so it re-ranks fresh from the personal-points
// leaderboard instead (usecases/americano.ts). Pool names in specs are the
// pools.key letters ('A'…); a single-table stage is the unnamed pool '' /
// `overall`.

/** An americano stage's ranked table, as the DOWNSTREAM stage must read it.
 *
 *  Rank by personal points, then map each ranked person to the division's
 *  persistent INDIVIDUAL entrant — never the ephemeral `pair` entrant a
 *  fixture actually ran on (pairEntrantsFor above); the next stage's
 *  generator only ever draws from real, registered division entrants
 *  (generateStageFixtures's `active` query).
 *
 *  Exported (F3 ultrareview finding 11) because this is NOT an optimisation
 *  — it is the only correct way to read an americano source, and it was
 *  forked. `tablesForCompletedStage` (the `on_complete` path, below) had it;
 *  `sourcesToTables` (stage-seeding.ts, the `timing:"setup"` propose/confirm
 *  path this session introduced) went straight to `sourceStandingsTables`,
 *  which reads `standings_snapshots` verbatim. An americano stage's own
 *  snapshot folds over the EPHEMERAL per-round pair entrants (Jul3/08 §3),
 *  so the setup path resolved qualifiers to pair-entrant ids that the next
 *  stage's roster does not contain — a silent wrong draw, the same class of
 *  defect as ruling 10's groups_ko pools-C/D miss, reachable the moment an
 *  organiser puts a `timing:"setup"` stage behind an americano. Two readers
 *  of one rule is the recurring bug in this area; now there is one. */
export async function americanoPlacementTables(
  tx: Tx,
  stageId: string,
  divisionId: string,
): Promise<PoolTable[]> {
  const leaderboard = await personalPointsLeaderboard(tx, stageId);
  const memberRows = await tx<{ entrant_id: string; person_id: string }[]>`
    select e.id as entrant_id, em.person_id
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId} and e.kind = 'individual'`;
  const entrantOf = new Map(memberRows.map((r) => [r.person_id, r.entrant_id]));
  const ordered = leaderboard
    .map((row) => entrantOf.get(row.person_id))
    .filter((id): id is string => id !== undefined);
  return [placementTable(ordered)];
}

/** Build the SourceTables (pools + bracket) a COMPLETED stage offers a
 *  downstream progression — factored out of seedNextStage's own inline
 *  construction (unchanged logic: the americano/table/bracket branches
 *  below are byte-identical to what this function replaces) so it can run
 *  once per DISTINCT source a multi-source progression names (Decision 4),
 *  not just the one stage that just completed. */
async function tablesForCompletedStage(
  tx: Tx,
  stage: { id: string; kind: string },
  divisionId: string,
): Promise<SourceTables> {
  let pools: PoolTable[];
  if (stage.kind === "americano") {
    pools = await americanoPlacementTables(tx, stage.id, divisionId);
  } else {
    // Ranked tables from the completion snapshot(s); translate pool uuids
    // back to their spec-facing keys.
    const poolRows = await tx<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${stage.id}`;
    const keyOf = new Map(poolRows.map((p) => [p.id, p.key]));
    const snapshots = await tx<{ pool_id: string | null; rows: StandingsRow[] }[]>`
      select pool_id, rows from standings_snapshots where stage_id = ${stage.id}`;
    if (snapshots.length === 0) {
      throw new EngineError("STAGE_NOT_READY", "completed stage has no standings snapshots", {
        stageId: stage.id,
      });
    }
    pools = snapshots.map((s) => ({
      pool: s.pool_id ? (keyOf.get(s.pool_id) ?? s.pool_id) : "",
      rows: s.rows,
    }));
  }
  // roundLosers (a bracket-kind source's take rule) reads the completed
  // bracket's OWN fixtures, never the standings_snapshot (final ranks only,
  // not per-round results) — only a bracket-kind source has any, so this is
  // a cheap no-op query result for every other kind.
  const bracket = BRACKET_KINDS.has(stage.kind) ? await loadBracketFixtures(tx, stage.id) : undefined;
  return { pools, ...(bracket ? { bracket } : {}) };
}

async function seedNextStage(auth: AuthCtx, completedStageId: string): Promise<SeededStage | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [current] = await tx<{ division_id: string; seq: number; kind: string }[]>`
      select division_id, seq, kind from stages where id = ${completedStageId}`;
    if (!current) return null;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + current.division_id}))`;

    const [next] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    if (!next || !next.progression) return null;
    const progression = next.progression as unknown as ProgressionSpec & {
      timing: "setup" | "on_complete";
      carry?: "none" | "points" | "full";
    };
    if (progression.timing !== "on_complete") return null;
    if (Array.isArray(next.config.qualified)) {
      // Already seeded (idempotent re-complete).
      return { stage_id: next.id, entrants: next.config.qualified as string[] };
    }

    // The just-completed stage's OWN tables — built once, reused below if
    // it's named as (one of) the progression's sources, never re-queried.
    const currentTables = await tablesForCompletedStage(
      tx,
      { id: completedStageId, kind: current.kind },
      current.division_id,
    );

    const shapes: SourceShape[] = [];
    const sourceTables: SourceTables[] = [];
    const resolvedSources: { id: string; kind: string }[] = [];
    for (const s of progression.sources) {
      const source = await resolveProgressionSource(tx, next, s.stage);
      resolvedSources.push(source);
      shapes.push(await sourceShapeOf(tx, source));
      // ANY OTHER named source must be complete NOW too, or this throws
      // STAGE_NOT_READY — caught by completeStage's existing best-effort
      // try/catch (Decision 4), same as today's single-source contract.
      if (source.id === completedStageId) {
        sourceTables.push(currentTables);
      } else {
        const [srcRow] = await tx<{ status: string }[]>`select status from stages where id = ${source.id}`;
        if (srcRow?.status !== "complete") {
          throw new EngineError("STAGE_NOT_READY", "a progression source stage is not complete yet", {
            stageId: source.id,
          });
        }
        sourceTables.push(await tablesForCompletedStage(tx, source, current.division_id));
      }
    }
    // A2 (round-4 review) — `next` here IS the progression's own target
    // (seedNextStage seeds INTO it), so `next.kind` is the real targetKind
    // ruling 13's snake/bracket-target guard needs on this resolution path
    // too, not just at createStages' save-time validateStageProgression call.
    const { qualifiers } = resolveProgression(progression, shapes, sourceTables, next.kind);
    const entrants = qualifiers.map((q) => q.entrantId);
    log.info(
      { event: "qualification_resolved", stageId: completedStageId, nextStageId: next.id, kind: current.kind, count: entrants.length },
      "qualification_resolved",
    );

    // Carry-over (Jul3/05 §3): seed the next stage with opening deltas from
    // its source(s)' tables — prior points/metrics arrive as data, prior H2H
    // is never replayed. Only a REAL table source has real points to carry
    // (REAL_TABLE_KINDS); a bracket/ladder/americano source is refused
    // outright rather than silently carrying fabricated zeros. Generalised
    // from "the one implicit source" to "every named source" (Decision 4).
    //
    // NOT deleted despite this plan's Decision (Task 5 Step 3 / Task 6 Step
    // 6): grounding said "no shipped writer sets `.carry`", true for
    // format-templates.ts/the catalogue but not for the whole codebase —
    // custom-points.test.ts exercises it end to end against a hand-built
    // stage graph, and it backs a MARKETED Pro entitlement
    // (standings.carry_over — feature-copy.ts's paywall copy,
    // pricing.matrix.standings.carry_over in all 4 marketing dictionaries).
    // Deleting it would silently break a paid, advertised feature. `carry`
    // is, like `timing`, an apps/web/DB-orchestration concept the engine's
    // pure ProgressionSpec has no notion of — see ProgressionSchema.
    //
    // The kind check and the delta fold moved to nonRealCarrySource /
    // carrySourceRefusal / buildCarryDeltas (above, beside REAL_TABLE_KINDS) in
    // F6, unchanged in behaviour — the `timing:"setup"` propose path reads the
    // same helpers, so the two cannot drift on which sources are refusable, the
    // sentence, or which rows fold in. The EngineError stays HERE: see those
    // helpers' comment for why each path keeps its own error type.
    const carryMode = progression.carry ?? "none";
    let carriedDeltas: unknown[] | undefined;
    // Narrowed separately from `carryMode` — the event write sits outside the
    // `!== "none"` block (after `stage_seeded`), and TS does not retain the
    // narrowing across that gap (`carriedDeltas !== undefined` alone is not
    // enough to prove mode is points|full).
    let carriedMode: "points" | "full" | undefined;
    if (carryMode !== "none") {
      const nonReal = nonRealCarrySource(resolvedSources);
      if (nonReal) {
        throw new EngineError("CONFIG_INVALID", carrySourceRefusal(nonReal.kind), {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
      carriedMode = carryMode;
      carriedDeltas = buildCarryDeltas(sourceTables, entrants, carryMode);
    }
    // Server-side merge, not a spread of `next.config` read earlier in this
    // transaction (design §T2): any other key written between that read and
    // this write — a per-stage `rules` override, most immediately — would
    // otherwise be silently reverted. Not `stages.ts`'s write-once `rounds`
    // pattern: that one is guarded `and config->>'rounds' is null`, which is
    // right for a key set once and wrong for one that must stay replaceable.
    await tx`
      update stages set config = config || ${tx.json({
        qualified: entrants,
        ...(carriedDeltas !== undefined ? { carry_deltas: carriedDeltas } : {}),
      } as never)}
      where id = ${next.id}`;

    // Structural ledger + division watermark (same pattern as stage_completed).
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${current.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${current.division_id}, ${last + 1}, 'stage_seeded',
              ${tx.json({ stageId: next.id, from: completedStageId, entrants } as never)})`;
    let seq = last + 1;
    if (carriedDeltas !== undefined && carriedMode !== undefined) {
      // auditable carry (Jul3/05 §3)
      seq += 1;
      await insertStandingsCarriedEvent(tx, current.division_id, seq, {
        stageId: next.id,
        from: completedStageId,
        mode: carriedMode,
        entrants,
      });
    }
    await tx`update divisions set seq = ${seq} where id = ${current.division_id}`;

    return { stage_id: next.id, entrants };
  });
}

export interface StandingsOut {
  stage_id: string;
  pool_id: string | null;
  rows: unknown[];
  computed_through_seq: number;
  updated_at: string | null;
}

/** Standings snapshot for a stage (recomputed on demand when absent). */
export async function getStandings(auth: AuthCtx, stageId: string, poolId?: string): Promise<StandingsOut> {
  const snapshot = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx`select 1 from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const [snap] = await tx<StandingsOut[]>`
      select stage_id, pool_id, rows, computed_through_seq, updated_at
      from standings_snapshots
      where stage_id = ${stageId} and pool_id is not distinct from ${poolId ?? null}`;
    return snap ?? null;
  });
  if (snapshot) return snapshot;
  const rows = await recomputeStandings(auth.orgId, stageId, poolId);
  return {
    stage_id: stageId,
    pool_id: poolId ?? null,
    rows: rows as unknown[],
    computed_through_seq: 0,
    updated_at: null,
  };
}

// ---------------------------------------------------------------------------
// Manual rank override (Jul3/05 §4) — placement games decide final positions
// without faking points. Stored on stages.config.rank_overrides; the fold's
// rank pass pins them (applyRankLocks) on every recompute.
// ---------------------------------------------------------------------------

export async function overrideStandings(
  auth: AuthCtx,
  stageId: string,
  input: { rows: { entrant_id: string; rank: number; reason: string }[] },
): Promise<{ overridden: number }> {
  await requireFeature(auth.orgId, "tiebreakers.custom");
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; config: Record<string, unknown> }[]>`
      select division_id, config from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    const ids = input.rows.map((r) => r.entrant_id);
    const known = await tx<{ id: string }[]>`
      select id from entrants where id in ${tx(ids)} and division_id = ${stage.division_id}`;
    if (known.length !== ids.length) {
      throw new HttpError(422, "override references an entrant outside this division");
    }
    const ranks = new Set(input.rows.map((r) => r.rank));
    if (ranks.size !== input.rows.length) throw new HttpError(422, "duplicate ranks in override");

    // Server-side merge (design §T2). `stage.config` was read BEFORE the
    // advisory lock above, so a writer that committed while this transaction
    // waited is already invisible to it; spreading that stale object back
    // reverts the other writer's key with no error.
    await tx`
      update stages set config = config || ${tx.json({
        rank_overrides: input.rows.map((r) => ({ entrant_id: r.entrant_id, rank: r.rank })),
      } as never)}
      where id = ${stageId}`;

    // audit (actor + reason, hash-chained per the 011 pattern)
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${stage.division_id}, ${last + 1}, 'rank_overridden',
              ${tx.json({ stage_id: stageId, rows: input.rows } as never)}, ${auth.userId})`;
    await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
    return { overridden: input.rows.length };
  });
  // pinned ranks land in the snapshots immediately
  await recomputeStandings(auth.orgId, stageId);
  // D4a (P5): a correction here invalidates any dependent `timing:"setup"`
  // stage's draft proposal — mark it stale and recompute a fresh one.
  await markDependentSeedProposalsStale(auth, stageId);
  return out;
}

// ---------------------------------------------------------------------------
// D4a (P5) — seed proposals: propose + confirm cross-stage fill. See
// stage-seeding.ts for the pure shape/placement/tie-detection logic this
// wraps with DB reads (standings, TBD fixtures) and the fillSlot write.
// ---------------------------------------------------------------------------

// F2 — standingsHash/destinationSlotsBySeed (and sourcesToTables, which
// wraps the source-standings read this file used to call directly) moved
// to stage-seeding.ts (unchanged bodies), imported at the top of this file.

export interface SeedProposalOut {
  id: string;
  stageId: string;
  status: "draft" | "confirmed" | "stale";
  computed: {
    qualifiers: {
      rank: number;
      source: { stageId: string; group?: string; rank: number };
      entrantId: string;
      destinationSlot: string;
    }[];
    ties: { slots: string[]; entrantIds: string[]; reason: string }[];
    standingsHash: string;
  };
}

/** F3 round-3 review, Task 2 (MAJOR) — engine `descriptorKey` renders
 *  `best_nth` as `best:${position}`, deliberately dropping `nth` (it is also
 *  the `seeded_map.source` wire vocabulary, which stays narrow on purpose —
 *  see progression.ts's own doc comment; NOT widened here). Two bestNth take
 *  rules on the SAME source at the same position but a DIFFERENT nth (e.g.
 *  `{nth:3,count:2}` and `{nth:4,count:2}`, both producing positions 1,2)
 *  therefore collide on that bare key within one source index — a `Map`
 *  keyed by it silently keeps whichever qualifier was inserted LAST. This
 *  local, wider key folds `nth` in for `best_nth` only (every other
 *  descriptor kind is unaffected — `descriptorKey` already fully determines
 *  them); used on BOTH the seedOfKey build and the tie-lookup read below so
 *  the two sides can never drift apart. */
function seedProposalKey(sourceIndex: number, d: SlotDescriptor): string {
  const base = d.kind === "best_nth" ? `best:${d.nth}:${d.position}` : descriptorKey(d);
  return `${sourceIndex}:${base}`;
}

/**
 * Compute (or recompute) a DRAFT seed proposal for a `timing: "setup"`
 * stage (design's API contract: POST /stages/{id}/seed-proposal). Never
 * fills anything — propose + confirm, owner ruling. At most one 'draft' row
 * per stage (DB partial unique index backs this too): any existing draft is
 * marked 'stale' first.
 *
 * Errors: 422 SEEDING_RULES_MISSING (no progression, or its rules can't
 * resolve against this stage's generated TBD fixtures — generate them
 * first); 409 SEEDING_SOURCE_INCOMPLETE (a source stage not complete, or has
 * no standings yet); 409 SEEDING_ALREADY_CONFIRMED (this stage's slots are
 * already filled — recompute is refused, not just a no-op, so the caller
 * doesn't mistake a stale draft for something actionable); 422
 * SEEDING_CARRY_SOURCE_INVALID (F6 — `carry` set against a source that offers
 * a downstream stage a finishing order rather than a points table, i.e. any
 * kind outside REAL_TABLE_KINDS).
 */
export async function computeSeedProposal(auth: AuthCtx, stageId: string): Promise<SeedProposalOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (!stage.progression) {
      throw new HttpError(422, "this stage has no seeding rules declared", "SEEDING_RULES_MISSING");
    }
    const progression = stage.progression as unknown as ProgressionSpec;

    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const [confirmed] = await tx<{ id: string }[]>`
      select id from stage_seed_proposals where stage_id = ${stageId} and status = 'confirmed' limit 1`;
    if (confirmed) {
      throw new HttpError(
        409,
        "this stage's slots are already filled from a confirmed proposal",
        "SEEDING_ALREADY_CONFIRMED",
      );
    }

    // sourcesToTables resolves EVERY named source (Decision 4 — genuinely
    // multi-source, though no writer in this session emits a multi-source
    // `timing:"setup"` progression), requiring each complete before reading
    // its standings — same 409 SEEDING_SOURCE_INCOMPLETE contract this
    // function has always had, generalised from one source to N.
    const { shapes, tables, resolved } = await sourcesToTables(tx, stage, progression.sources);

    // F6 (#625) — carry-over refuses a source that offers only a finishing
    // order, raised at PROPOSE rather than only where carry is applied. Before this,
    // the refusal existed on the `timing:"on_complete"` path alone
    // (seedNextStage), so a setup-timing organiser was handed a draft they
    // could confirm into a stage whose carry could never be honoured. `carry`
    // is an apps/web/DB-orchestration concept the engine's pure
    // ProgressionSpec has no notion of — hence the cast, same as
    // seedNextStage's own widened read. Shared refusal sentence, deliberately
    // NOT a shared throw: see nonRealCarrySource's comment for why this side
    // is an HttpError and that side an EngineError.
    const carryMode = (progression as { carry?: string }).carry ?? "none";
    if (carryMode !== "none") {
      const nonReal = nonRealCarrySource(resolved);
      if (nonReal) {
        throw new HttpError(422, carrySourceRefusal(nonReal.kind), "SEEDING_CARRY_SOURCE_INVALID", {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
    }
    // A2 (round-4 review) — `stage` here IS the progression's own target
    // (computeSeedProposal proposes seeds INTO it), so `stage.kind` is the
    // real targetKind ruling 13's snake/bracket-target guard needs to fire
    // on this resolution path too, not just at createStages' save-time
    // validateStageProgression call.
    const { qualifiers, ties } = resolveProgression(progression, shapes, tables, stage.kind);

    const slotBySeed = await destinationSlotsBySeed(tx, stageId);
    if (slotBySeed.size === 0) {
      throw new HttpError(
        422,
        "this stage has no generated TBD fixtures yet — generate its fixtures first",
        "SEEDING_RULES_MISSING",
        { stageId },
      );
    }
    // P6 (F3 review item 1, RESOLVED) — was keyed by bare descriptorKey,
    // colliding across two sources that emit the same descriptor (trivially:
    // two rankRange sources, or two group_rank sources sharing a pool letter
    // — the default pool naming). The Map construction's last-write-wins
    // meant a tie flagged on one source's slot could resolve to a DIFFERENT
    // source's slot instead — the rightful qualifier silently dropped there
    // while the real tie's slot kept the engine's unconfirmed default pick,
    // exactly the "a tie is FLAGGED, never silently ordered" invariant
    // confirmSeedProposal's own tie-resolution check below exists to uphold.
    // Keyed by `${sourceIndex}:${descriptorKey}` instead, now that
    // `ProgressionTieFlag.descriptors` carries sourceIndex (widened to
    // SourcedSlot — progression.ts). Reachable today: createStages/
    // replaceStages persist a multi-source `setup` progression with no
    // progression-aware gate (format-gates.ts checks kind/byes/cross_feeds/
    // placements only); progression-multi-source.test.ts exercises it end to
    // end.
    //
    // F3 round-3 review, Task 2 — that alone still collides for two bestNth
    // rules on the SAME source at the same position but a different nth
    // (descriptorKey's `best:${position}` drops `nth`); seedProposalKey folds
    // `nth` in for best_nth so this map (and the tie lookup below) can tell
    // them apart. See its own doc comment.
    const seedOfKey = new Map(qualifiers.map((q) => [seedProposalKey(q.sourceIndex, q.descriptor), q.seed] as const));

    const computedQualifiers = qualifiers.map((q) => ({
      rank: q.seed,
      source: {
        stageId: resolved[q.sourceIndex]!.id,
        ...(q.descriptor.kind === "group_rank" ? { group: q.descriptor.pool } : {}),
        rank: q.rank,
      },
      entrantId: q.entrantId,
      // Wire contract: ONE slot, for display (design's "Renderers receive
      // {key,params}" convention extends here — first of the deterministic,
      // order-by-id list). A bye seed's OTHER slot isn't dropped — it's
      // filled too at confirm time via a fresh destinationSlotsBySeed() call
      // keyed off this same `rank`; see confirmSeedProposal.
      destinationSlot: slotBySeed.get(q.seed)?.[0] ?? "",
    }));
    if (computedQualifiers.some((q) => q.destinationSlot === "")) {
      throw new HttpError(
        422,
        "this stage's generated TBD fixtures don't match its current seeding rules — regenerate them first",
        "SEEDING_RULES_MISSING",
        { stageId },
      );
    }
    const computedTies = ties.map((t) => ({
      slots: t.descriptors.map((sourced) => {
        // seedProposalKey on the read side too (Task 2) — must match the
        // build side above exactly, or a best_nth tie resolves to whichever
        // OTHER same-position/different-nth qualifier happened to be
        // inserted last.
        const seed = seedOfKey.get(seedProposalKey(sourced.sourceIndex, sourced.descriptor));
        return (seed !== undefined ? slotBySeed.get(seed)?.[0] : undefined) ?? descriptorKey(sourced.descriptor);
      }),
      entrantIds: t.entrantIds,
      reason: t.reason,
    }));

    const computed = {
      qualifiers: computedQualifiers,
      ties: computedTies,
      standingsHash: standingsHash(poolTableRowsAcrossSources(tables)),
    };

    await tx`update stage_seed_proposals set status = 'stale' where stage_id = ${stageId} and status = 'draft'`;
    const [row] = await tx<{ id: string }[]>`
      insert into stage_seed_proposals (org_id, stage_id, computed, status)
      values (${auth.orgId}, ${stageId}, ${tx.json(computed as never)}, 'draft')
      returning id`;

    return { id: row!.id, stageId, status: "draft", computed };
  });
}

/**
 * Read-only: the latest seed proposal for `stageId` (any status —
 * draft/confirmed/stale), or null if none has been computed yet (P6/D4b task
 * B ruling — see docs/superpowers/plans/2026-08-13-p6-progression-ui-plan.md
 * "There is no read path for a proposal"). `stage_seed_proposals` is
 * otherwise touched only inside compute/confirm/stale-marking; a panel that
 * renders on page load must not POST to discover its own state (recompute
 * marks prior drafts stale and inserts a row — a real side effect). This
 * function issues one `select`, nothing else — never call computeSeedProposal
 * from here to paper over a null.
 *
 * Consumed by the division page (server component) and handed to
 * ProgressionPanel as a prop; fresh state after a recompute or confirm comes
 * from `router.refresh()`, not a re-call of this function reacting to state.
 */
export async function getSeedProposal(auth: AuthCtx, stageId: string): Promise<SeedProposalOut | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<
      { id: string; stage_id: string; status: SeedProposalOut["status"]; computed: SeedProposalOut["computed"] }[]
    >`
      select id, stage_id, status, computed from stage_seed_proposals
      where stage_id = ${stageId}
      order by created_at desc, id desc
      limit 1`;
    if (!row) return null;
    return { id: row.id, stageId: row.stage_id, status: row.status, computed: row.computed };
  });
}

export interface ConfirmSeedProposalOut {
  proposalId: string;
  filled: number;
  fixtures: FixtureRow[];
}

/**
 * Confirm a draft seed proposal (design's Fill algorithm, verbatim):
 * 1. freshness (standingsHash) — else 409 stale.
 * 2. apply edits + tiePicks over `computed` -> final slot map.
 * 3. validate: bijection destinationSlot<->entrant, entrant ∈ division, no
 *    slot already filled.
 * 4. single transaction: fill via fillSlot (the SAME pathway intra-bracket
 *    advancement uses — D4a/P5 scope item 3), mark the proposal confirmed.
 * 5. post-commit: re-run schedule validation, pino `stage_seeded`.
 */
export async function confirmSeedProposal(
  auth: AuthCtx,
  stageId: string,
  input: {
    proposalId: string;
    edits?: { destinationSlot: string; entrantId: string }[];
    tiePicks?: { slots: string[]; order: string[] }[];
  },
): Promise<ConfirmSeedProposalOut> {
  const committed = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (!stage.progression) throw new HttpError(422, "this stage has no seeding rules declared", "SEEDING_RULES_MISSING");
    const progression = stage.progression as unknown as ProgressionSpec;

    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const [proposal] = await tx<{ id: string; status: string; computed: SeedProposalOut["computed"] }[]>`
      select id, status, computed from stage_seed_proposals where id = ${input.proposalId} and stage_id = ${stageId}`;
    if (!proposal) throw new HttpError(404, "seed proposal not found");
    if (proposal.status === "confirmed") {
      throw new HttpError(
        409,
        "this stage's slots are already filled from a confirmed proposal",
        "SEEDING_ALREADY_CONFIRMED",
      );
    }
    if (proposal.status === "stale") {
      throw new HttpError(409, "standings changed since this proposal was computed — recompute it first", "SEEDING_PROPOSAL_STALE");
    }

    // Step 1 — freshness. A standings override could have landed between the
    // draft's compute and this request; re-derive the hash rather than trust
    // the row's status alone.
    const { tables, resolved } = await sourcesToTables(tx, stage, progression.sources);
    if (standingsHash(poolTableRowsAcrossSources(tables)) !== proposal.computed.standingsHash) {
      await tx`update stage_seed_proposals set status = 'stale' where id = ${proposal.id}`;
      throw new HttpError(409, "standings changed since this proposal was computed — recompute it first", "SEEDING_PROPOSAL_STALE");
    }

    // Step 2 — apply edits + tiePicks over the computed slate.
    const bySlot = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId] as const));
    for (const edit of input.edits ?? []) {
      if (!bySlot.has(edit.destinationSlot)) {
        throw new HttpError(
          422,
          `edit references a slot this proposal doesn't have: ${edit.destinationSlot}`,
          "SEEDING_EDIT_UNKNOWN_SLOT",
        );
      }
      bySlot.set(edit.destinationSlot, edit.entrantId);
    }
    // Every flagged tie must be resolved by an edit or a tiePick covering
    // every one of its slots — never silently confirmed on the engine's
    // deterministic (seed/id) fallback (design: "a tie is FLAGGED, never
    // silently ordered").
    const editedSlots = new Set((input.edits ?? []).map((e) => e.destinationSlot));
    const pickedGroups = new Set((input.tiePicks ?? []).map((p) => [...p.slots].sort().join(",")));
    for (const tie of proposal.computed.ties) {
      const coveredByEdit = tie.slots.every((slot) => editedSlots.has(slot));
      const coveredByPick = pickedGroups.has([...tie.slots].sort().join(","));
      if (!coveredByEdit && !coveredByPick) {
        throw new HttpError(
          422,
          "a flagged tie is not resolved — supply an edit or a tiePick for every tied slot",
          "SEEDING_TIE_UNRESOLVED",
          { slots: tie.slots, entrantIds: tie.entrantIds },
        );
      }
    }
    for (const pick of input.tiePicks ?? []) {
      pick.slots.forEach((slot, i) => {
        const entrantId = pick.order[i];
        if (entrantId) bySlot.set(slot, entrantId);
      });
    }

    // Step 3 — validate: bijection destinationSlot<->entrant, entrant ∈
    // division, no slot already filled.
    const finalSlots = [...bySlot.entries()];
    const entrantIds = finalSlots.map(([, id]) => id);
    if (new Set(entrantIds).size !== entrantIds.length) {
      throw new HttpError(422, "the same entrant is assigned to more than one slot", "SEEDING_SLOT_DOUBLE_ASSIGNED");
    }
    const known = await tx<{ id: string }[]>`
      select id from entrants where id in ${tx(entrantIds)} and division_id = ${stage.division_id}`;
    if (known.length !== new Set(entrantIds).size) {
      throw new HttpError(422, "a qualifier does not belong to this division", "SEEDING_ENTRANT_FOREIGN");
    }
    // #554 — a bye seed owns TWO destination slots (its own bye fixture's
    // slot AND the winner-feed target's slot), but the wire-level
    // `destinationSlot` above names only one of them (computeSeedProposal's
    // single-slot display convention — see its comment). Expand every wire
    // slot into every slot sharing its seed so BOTH get filled, through the
    // SAME fillSlot pathway used everywhere else (D4a/P5 scope item 3), not
    // a second one. Re-derive fresh rather than trust the draft's persisted
    // `computed` (which, by the same wire convention, only ever recorded one
    // slot per seed) — `rank` on each persisted qualifier IS the seed
    // destinationSlotsBySeed keys on, so this is an exact re-lookup, not a
    // re-derivation of the proposal itself.
    const seedByWireSlot = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.rank] as const));
    const freshSlotsBySeed = await destinationSlotsBySeed(tx, stageId);
    const expandedSlots = new Map<string, string>();
    for (const [wireSlot, entrantId] of finalSlots) {
      const seed = seedByWireSlot.get(wireSlot);
      const siblings = seed !== undefined ? freshSlotsBySeed.get(seed) : undefined;
      for (const slot of siblings && siblings.length > 0 ? siblings : [wireSlot]) {
        expandedSlots.set(slot, entrantId);
      }
    }
    const expandedEntries = [...expandedSlots.entries()];

    const fixtureIds = [...new Set(expandedEntries.map(([slot]) => slot.split(":")[0] as string))];
    const fixtureRows = await tx<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select id, home_entrant_id, away_entrant_id from fixtures
      where id in ${tx(fixtureIds)} and stage_id = ${stageId}`;
    const fixtureById = new Map(fixtureRows.map((f) => [f.id, f]));
    for (const [slot] of expandedEntries) {
      const [fixtureId, side] = slot.split(":");
      const fixture = fixtureId ? fixtureById.get(fixtureId) : undefined;
      if (!fixture) {
        throw new HttpError(422, `destinationSlot names a fixture outside this stage: ${slot}`, "SEEDING_SLOT_FOREIGN_FIXTURE");
      }
      const already = side === "home" ? fixture.home_entrant_id : fixture.away_entrant_id;
      if (already !== null) {
        throw new HttpError(409, `slot ${slot} is already filled`, "SEEDING_FIXTURES_ALREADY_FILLED");
      }
    }

    // Step 4 — single transaction: fill through fillSlot, mark confirmed.
    const filledFixtureIds = new Set<string>();
    for (const [slot, entrantId] of expandedEntries) {
      const [fixtureId, side] = slot.split(":");
      const filledId = await fillSlot(tx, fixtureId as string, side === "home" ? 1 : 2, entrantId);
      if (filledId !== null) filledFixtureIds.add(filledId);
    }
    // A bye seat just became a real entrant's, so the walkover the plain path
    // bakes at generation time can finally be recorded — see awardSeededByes.
    // AFTER the fills, in the SAME transaction: it reads the entrant ids they
    // just wrote. The decided lines join `filledFixtureIds` so the post-commit
    // publish below drops and re-pushes them too — their match centre now
    // shows a settled walkover rather than a fixture waiting on a draw.
    for (const id of await awardSeededByes(tx, stageId)) filledFixtureIds.add(id);
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    await tx`update stage_seed_proposals set status = 'confirmed', confirmed_at = now() where id = ${proposal.id}`;

    const carryMode = (progression as { carry?: "none" | "points" | "full" }).carry ?? "none";
    if (carryMode !== "none") {
      // Belt beside propose-time guard — stale drafts from before Task 2 may
      // still reach confirm; re-check against the same freshness-verified
      // `resolved` sourcesToTables just read for the hash.
      const nonReal = nonRealCarrySource(resolved);
      if (nonReal) {
        throw new HttpError(422, carrySourceRefusal(nonReal.kind), "SEEDING_CARRY_SOURCE_INVALID", {
          stageId: nonReal.id,
          kind: nonReal.kind,
          carry: carryMode,
        });
      }
      const entrants = [...new Set(expandedEntries.map(([, id]) => id))];
      const carriedDeltas = buildCarryDeltas(tables, entrants, carryMode);
      // Server-side merge (design §T2) — see seedNextStage's write.
      await tx`
        update stages set config = config || ${tx.json({ carry_deltas: carriedDeltas } as never)}
        where id = ${stageId}`;
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      const nextSeq = last + 1;
      await insertStandingsCarriedEvent(tx, stage.division_id, nextSeq, {
        stageId,
        from: resolved[resolved.length - 1]!.id,
        mode: carryMode,
        entrants,
      });
      await tx`update divisions set seq = ${nextSeq} where id = ${stage.division_id}`;
    }

    const fixturesRaw = await tx<Omit<FixtureRow, "court_name">[]>`
      select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
             f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
             f.scheduled_at, f.venue, f.court_label, f.court_id,
             f.venue_id, ven.name as venue_name,
             f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
             f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
      from fixtures f
      left join venues ven on ven.id = f.venue_id
      where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
    // #14: venue-qualified label (a bare joined `courts.name` can't tell two
    // same-named courts in different venues apart) — same fallback
    // convention as FixtureRow's own doc comment: fall back to the id
    // itself on a miss (should not happen; FK-restricted).
    const courtNames = await courtNamesById(tx);
    const fixtures = fixturesRaw.map((f) => ({
      ...f,
      court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
    }));
    return {
      filled: expandedEntries.length,
      fixtures,
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
      filledFixtureIds: [...filledFixtureIds],
    };
  });

  log.info(
    { event: "stage_seeded", stageId, proposalId: input.proposalId, edits: input.edits?.length ?? 0 },
    "stage_seeded",
  );
  void fireStageRevalidate(auth.orgId, stageId);
  // R10g (review-r10f G1): the confirm names entrants into the bracket, and the
  // hub and each filled fixture's match centre show those names. So after the
  // commit, ONE `afterScheduleWrite` drops the hub key plus exactly the
  // fixtures this write filled (from fillSlot's own `returning id`), pushes the
  // division once that DEL settles, then pushes each filled fixture (capped,
  // same contract as every schedule write). A refused confirm throws out of
  // the transaction above and never reaches this line, so it sends nothing.
  afterScheduleWrite(committed.divisionId, committed.competitionId, "schedule", committed.filledFixtureIds);

  // Step 5 — post-commit: re-run schedule validation so newly-real person
  // clashes surface as warnings, run not blocked (design's Fill algorithm;
  // crossPersonClash already skips TBD slots — usecases/schedule.ts
  // peopleOf()). Best-effort: a validation hiccup must not undo a fill that
  // already committed.
  try {
    await validateSchedule(auth, committed.divisionId);
  } catch {
    // best-effort, see above
  }

  return { proposalId: input.proposalId, filled: committed.filled, fixtures: committed.fixtures };
}

/** A standings change on `sourceStageId` invalidates any dependent
 *  `timing: "setup"` stage's draft proposal — mark it stale and recompute a
 *  fresh one against the corrected table (design: overrideStandings "marks
 *  dependent draft proposals stale and recomputes"). Best-effort throughout:
 *  a dependent whose recompute now trips (e.g. rules unsatisfiable, or
 *  already confirmed) is left as-is rather than blocking the write that
 *  already committed.
 *
 *  Exported (P5 review finding): `overrideStandings` is not the only
 *  standings-mutating path a COMPLETE source stage can still take.
 *  `LOCKED_FIXTURE_STATUSES` (append-event.ts) is only {finalized,
 *  cancelled} — "decided" is not locked — so a correction to an
 *  already-decided fixture via the live scoring path (usecases/scoring.ts
 *  onDecided) is permitted too, and must call this the same way. */
export async function markDependentSeedProposalsStale(auth: AuthCtx, sourceStageId: string): Promise<void> {
  const dependents = await withTenant(auth.orgId, async (tx) => {
    const [src] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${sourceStageId}`;
    if (!src) return [];
    // Restricted to timing==='setup' in SQL (not just `progression is not
    // null`): an `on_complete` stage never has a stage_seed_proposals row,
    // so including it here would only cost wasted resolveProgressionSource
    // calls below, never a real match.
    const rows = await tx<{ id: string; seq: number; progression: Record<string, unknown> | null }[]>`
      select id, seq, progression from stages
      where division_id = ${src.division_id}
        and progression is not null
        and progression ->> 'timing' = 'setup'`;
    const matches: string[] = [];
    for (const row of rows) {
      const progression = row.progression as unknown as ProgressionSpec;
      // A dependent may name MULTIPLE sources (Decision 4) — it depends on
      // sourceStageId if ANY of them resolves to it.
      for (const s of progression.sources) {
        try {
          const source = await resolveProgressionSource(tx, { division_id: src.division_id, seq: row.seq }, s.stage);
          if (source.id === sourceStageId) {
            matches.push(row.id);
            break;
          }
        } catch {
          // an unresolvable source can't depend on this stage
        }
      }
    }
    if (matches.length > 0) {
      await tx`update stage_seed_proposals set status = 'stale' where stage_id in ${tx(matches)} and status = 'draft'`;
    }
    return matches;
  });
  for (const dependentStageId of dependents) {
    try {
      await computeSeedProposal(auth, dependentStageId);
    } catch {
      // best-effort, see docstring
    }
  }
}

// ---------------------------------------------------------------------------
// Ladder challenges (Jul3/08 §6): no pre-generated fixtures — players issue
// challenges within range; the result reorders the ladder (scoring hook).
// ---------------------------------------------------------------------------

export async function issueChallenge(
  auth: AuthCtx,
  stageId: string,
  input: { challenger_id: string; opponent_id: string },
): Promise<{ fixture_id: string; ladder_order: string[] }> {
  const [ladderComp] = await sql<{ competition_id: string }[]>`
    select d.competition_id from stages s
    join divisions d on d.id = s.division_id
    where s.id = ${stageId}`;
  await requireFeature(auth.orgId, "formats.advanced", ladderComp?.competition_id);
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { division_id: string; kind: string; config: Record<string, unknown>; competition_id: string }[]
    >`
      select s.division_id, s.kind, s.config, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "ladder") throw new HttpError(422, "challenges only exist on ladder stages");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // A frozen division refuses a challenge. A ladder has no pre-generated
    // timetable — its fixtures are created on demand, one per challenge — but
    // a challenge still INSERTS a fixture onto the division's board, and on
    // first use also writes `stage.config.ladder_order`. Both happen below,
    // under this lock; both are board writes, and the freeze binds board
    // writes wherever they come from.
    //
    // AFTER the 404 and the ladder-kind 422 (an unknown stage still 404s —
    // `divisionLockState` reads a missing row as UNFROZEN), and after the
    // advisory lock, matching every other refusing site.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    // ladder order initialises from seed order on first use
    let order = stage.config.ladder_order as string[] | undefined;
    if (!Array.isArray(order) || order.length === 0) {
      const entrants = await tx<{ id: string }[]>`
        select id from entrants
        where division_id = ${stage.division_id} and status in ('registered','confirmed')
        order by seed nulls last, created_at, id`;
      order = entrants.map((e) => e.id);
      // Server-side merge (design §T2): `stage.config` was read before the
      // advisory lock, so anything written while this transaction waited must
      // not be spread back over.
      await tx`update stages set config = config || ${tx.json({ ladder_order: order } as never)}
               where id = ${stageId}`;
    }
    const ci = order.indexOf(input.challenger_id);
    const oi = order.indexOf(input.opponent_id);
    if (ci < 0 || oi < 0) throw new HttpError(422, "both players must be on the ladder");
    if (oi >= ci) throw new HttpError(422, "you can only challenge upward");
    const range = typeof stage.config.challengeRange === "number" ? stage.config.challengeRange : 3;
    if (ci - oi > range) {
      throw new HttpError(422, `challenges reach at most ${range} places up the ladder`);
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    const [fixture] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, ext_key, status)
      values (${stageId}, ${stage.division_id}, ${n + 1}, 1,
              ${input.challenger_id}, ${input.opponent_id}, ${"ch-" + String(n + 1)}, 'scheduled')
      returning id`;
    if (stage.config.ladder_order === undefined) stage.config.ladder_order = order;
    return {
      out: { fixture_id: fixture!.id, ladder_order: order },
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
    };
  });
  // R10e (found): a challenge puts a fixture on the division's board, so the
  // hub drops in one DEL after the commit and the division push follows it.
  // The fixture is new: no fixture key to drop, nobody watching its centre.
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return write.out;
}

// ---------------------------------------------------------------------------
// Ad-hoc single fixture (PROMPT-66): a replay, a friendly, a manual
// tie-breaker or a missing match, added to an already-running stage. League /
// group / swiss standings fold every fixture, so the added match is a real
// result; bracket kinds have no slot for a loose fixture and reject it.
// ---------------------------------------------------------------------------

const ADHOC_STAGE_KINDS = new Set(["league", "group", "swiss"]);

export async function addFixture(
  auth: AuthCtx,
  stageId: string,
  input: {
    home_entrant_id: string;
    away_entrant_id: string;
    round_no?: number;
    scheduled_at?: string | null;
    // P9 pass 3c-2: this writer was the one cutover pass 3a missed — it still
    // accepted and inserted the free-text `venue` column. Real venue/court by
    // id, matching every other fixture-touching writer (moveFixture et al.).
    venue_id?: string | null;
    court_id?: string | null;
  },
): Promise<{ fixture_id: string }> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; kind: string; status: string; competition_id: string }[]>`
      select s.division_id, s.kind, s.status, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind === "ladder") {
      throw new HttpError(422, "ladder matches are created with challenges, not ad-hoc fixtures");
    }
    if (stage.kind === "americano") {
      throw new HttpError(422, "americano matches are generated round by round — generate another round instead");
    }
    if (!ADHOC_STAGE_KINDS.has(stage.kind)) {
      throw new HttpError(422, "can't add a loose fixture to a bracket — it has no slot in the tree");
    }
    if (stage.status === "complete") {
      throw new HttpError(422, "this stage is complete — a completed table doesn't take new matches");
    }
    if (input.home_entrant_id === input.away_entrant_id) {
      throw new HttpError(422, "an entrant cannot play itself");
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // An ad-hoc fixture carries client-supplied `scheduled_at` and `court_id`
    // straight into the board — a timetable write by another name, and one a
    // frozen division refuses on the same terms as `moveFixture`, which is the
    // path the board's own drag uses to write those two columns.
    //
    // AFTER the existence check and the advisory lock, matching every other
    // site; an unknown stage id still 404s.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const entrants = await tx<{ id: string }[]>`
      select id from entrants
      where division_id = ${stage.division_id}
        and id in (${input.home_entrant_id}, ${input.away_entrant_id})`;
    if (entrants.length !== 2) {
      throw new HttpError(422, "both entrants must belong to this stage's division");
    }
    // #14 sibling fix: `court_id`/`venue_id` are FK-restricted but the FK is
    // `deferrable initially deferred` (V367) — an id that isn't a real court/
    // venue of this org would otherwise only fail at COMMIT time, as a raw
    // Postgres foreign_key_violation (500), not a clean 4xx. `tx` is already
    // RLS-scoped to this org, so existence here IS the ownership check —
    // same pattern venues.ts's own writers use for the same tables.
    if (input.court_id) {
      const [court] = await tx<{ id: string }[]>`select id from courts where id = ${input.court_id}`;
      if (!court) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    }
    if (input.venue_id) {
      const [venue] = await tx<{ id: string }[]>`select id from venues where id = ${input.venue_id}`;
      if (!venue) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    }
    // Group stages: the match must land in the entrants' pool so the right
    // table folds it. Inferred from the stage's existing fixtures — no
    // separate pool-membership lookup exists or is needed.
    let poolId: string | null = null;
    if (stage.kind === "group") {
      const pools = await tx<{ pool_id: string | null }[]>`
        select distinct pool_id from fixtures
        where stage_id = ${stageId}
          and (home_entrant_id in (${input.home_entrant_id}, ${input.away_entrant_id})
            or away_entrant_id in (${input.home_entrant_id}, ${input.away_entrant_id}))`;
      const ids = [...new Set(pools.map((p) => p.pool_id))];
      if (ids.length !== 1 || ids[0] == null) {
        throw new HttpError(422, "both entrants must be in the same pool of this stage");
      }
      poolId = ids[0];
    }
    const [{ maxRound }] = await tx<{ maxRound: number }[]>`
      select coalesce(max(round_no), 0)::int as "maxRound" from fixtures where stage_id = ${stageId}`;
    const round = input.round_no ?? maxRound + 1;
    const [{ nextSeq }] = await tx<{ nextSeq: number }[]>`
      select coalesce(max(seq_in_round), 0)::int + 1 as "nextSeq"
      from fixtures where stage_id = ${stageId} and round_no = ${round}`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    // Review wave 2: the venue is DERIVED from the court, exactly as
    // `applySchedule`/`moveFixture`/the joint apply now do. Accepting both
    // independently let a caller post Venue A's court with Venue B's
    // `venue_id` and create a fixture whose venue contradicts the court it
    // sits on — the FK only checks each id belongs to the org, never that the
    // two agree. A court with no resolvable venue falls back to the supplied
    // value, so a venue-only ad-hoc fixture still works.
    const adhocVenueId =
      input.court_id != null
        ? ((await courtVenueIds(tx)).get(input.court_id) ?? input.venue_id ?? null)
        : (input.venue_id ?? null);
    const [fixture] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, pool_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, ext_key, status, scheduled_at,
                            venue_id, court_id)
      values (${stageId}, ${stage.division_id}, ${poolId}, ${round}, ${nextSeq},
              ${input.home_entrant_id}, ${input.away_entrant_id}, ${"adhoc-" + String(n + 1)},
              'scheduled', ${input.scheduled_at ?? null},
              ${adhocVenueId}, ${input.court_id ?? null})
      returning id`;
    return { out: { fixture_id: fixture!.id }, divisionId: stage.division_id, competitionId: stage.competition_id };
  });
  // R10e (found): an ad-hoc fixture lands on the hub with its kick-off and
  // court, so the hub drops in one DEL after the commit and the division push
  // follows it. The fixture is new: no fixture key, no fixture push.
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return write.out;
}
