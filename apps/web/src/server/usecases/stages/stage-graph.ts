import "server-only";
// Define the stage graph: list stages (with their table rules), create, replace
// (with the format-change preview and lock) and delete.

import { createHash } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertStageKindsAllowed, isChessSport } from "@/lib/chess-individual-only";
import { assertWithinLimit, getLimit, requireFeature } from "@/lib/entitlements";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "../format-gates";
import { validatedStageConfig } from "../stage-defaults";
import { refuseNewStageTable } from "../table-rule-guards";
import { knockoutRefusal } from "../knockout-refusal";
import { standaloneStageRefusal } from "@/lib/stage-standalone";
import { validateFeedGraph } from "@seazn/engine/scheduling";
import type { TiebreakerKey } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";
import { stageTableRulesDocs, type StageTableRulesDoc } from "@/server/engine-db/table-rules";
import { FIXTURE_DELETED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "../external-play/cancel-invites";
import { SWISS_ROUNDS_REQUIRED_CODE, SWISS_ROUNDS_REQUIRED_MESSAGE } from "@/lib/swiss-shell";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStages } from "@/server/api-v1/schemas";
// #14: `courtNamesById` is the venue-qualified label map (via
// `buildCourtDirectory`) — a bare joined `courts.name` can't tell apart two
// venues that legally share one court name.
import { afterScheduleWrite, divisionLockState } from "../schedule";
import { schedulePlayerStatsRefresh } from "../player-stats-refresh";
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
import { validateStageProgression } from "../stage-seeding";
import { fixtureHoldsStandingResultSql } from "../fixture-results-sql";
import { matchName, refuseOwnFormatLoss } from "../fixture-override-guards";
import { FORMAT_CHANGE_REFUSALS, type FormatChangePreview } from "@/lib/format-change";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { STAGE_COLS, type Tx, type StageInput, type StageRow } from "./types";
import { lockBoardsRefusingOnlineGames, lockSwissBoardAppends } from "./swiss-boards";

export async function listStages(auth: AuthCtx, divisionId: string): Promise<StageRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where division_id = ${divisionId} order by seq`;
  });
}

/** W2d Task 13 (spec §7): a stage's table rules on the API's stage document (`StageTableRules` on the wire). */
export interface StageTableRulesWire {
  tiebreakers: { keys: TiebreakerKey[]; source: StageTableRulesDoc["sources"]["tiebreakers"]; pinnedAt: string | null; sportDefault: TiebreakerKey[] };
  crossGroup: { keys: TiebreakerKey[] };
  points: { rule: StageTableRulesDoc["points"]; source: StageTableRulesDoc["sources"]["points"]; pinnedAt: string | null };
  reachableOutcomes: StageTableRulesDoc["reachable"][number][];
}

export type StageWithTableRulesRow = StageRow & { tableRules: StageTableRulesWire | null };

/** The loader's document (`stageTableRulesDocs`) as the API serves it: the order with the layer it came from, its pin and
 *  the sport's own default for the stage (PS-7b: read off the sport, never the winning order), the cross-group order, the
 *  points with theirs, and the outcomes they range over. One pin date: a stage is pinned whole. */
function tableRulesWireOf(doc: StageTableRulesDoc): StageTableRulesWire {
  return {
    tiebreakers: { keys: [...doc.tiebreakers], source: doc.sources.tiebreakers, pinnedAt: doc.pinnedAt, sportDefault: [...doc.sportDefault] },
    crossGroup: { keys: [...doc.crossGroup] },
    points: { rule: doc.points, source: doc.sources.points, pinnedAt: doc.pinnedAt },
    reachableOutcomes: [...doc.reachable],
  };
}

/** Each stage row with its table rules, in one read (`stageTableRulesDocs`): null where the loader refuses the stage's
 *  rules (logged there) — the API shows no order rather than a guessed one (R3). */
async function withTableRules(tx: Tx, rows: readonly StageRow[]): Promise<StageWithTableRulesRow[]> {
  const docs = await stageTableRulesDocs(tx, rows.map((r) => r.id));
  return rows.map((r) => {
    const doc = docs[r.id];
    return { ...r, tableRules: doc === undefined ? null : tableRulesWireOf(doc) };
  });
}

/** GET /divisions/{id}/stages (W2d Task 13): `listStages` with each stage's table rules. The pages keep `listStages`. */
export async function listStagesWithTableRules(auth: AuthCtx, divisionId: string): Promise<StageWithTableRulesRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const rows = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where division_id = ${divisionId} order by seq`;
    return withTableRules(tx, rows);
  });
}

/** GET /stages/{id} (W2d Task 13): one stage with its table rules. */
export async function getStageWithTableRules(auth: AuthCtx, stageId: string): Promise<StageWithTableRulesRow> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (rows.length === 0) throw new HttpError(404, "stage not found");
    return (await withTableRules(tx, rows))[0]!;
  });
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
 * are TEMPLATE keys (lib/format-templates.ts) that each BUILD a
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

/** The division facts a new stage's rules are judged against (`stage-defaults.ts`): its sport at the pinned module
 *  version, its variant and its config. */
interface StageRulesScope {
  sport_key: string;
  module_version: string;
  variant_key: string;
  config: Record<string, unknown> | null;
}

/** What a stage SLOT keeps across `replaceStages`' delete-and-recreate, keyed `seq:kind`: its stored rules (R-T12-4,
 *  `{}` for a cleared slot), its own points rule when it has one (R-T13-1), and (W2d Task 10) its own tie-break and
 *  cross-group orders when it has them — the organiser's choices on the same screen as its points, re-asked with them. */
export interface StageCarry {
  rules: Record<string, unknown>;
  points?: unknown;
  tiebreakers?: unknown;
  crossGroupTiebreakers?: unknown;
  /** W3 T12 (T8 review m6): a Swiss slot's chess colours switch (`PATCH /stages/{id}`, BG-SW-1) — the organiser's
   *  choice, so a re-Apply of the template (which names no `chess`) keeps it instead of re-seeding the boardgame default. */
  chess?: boolean;
}

/** W2c Task 12 — the config each stage of a batch is inserted with: its rules validated on the stage PUT's terms and
 *  laid over its kind's preset (`validatedStageConfig`) or, for a slot `replaceStages` matched (`carried`, keyed
 *  `seq:kind`), over that slot's carried rules in the preset's place (R-T12-4). In input order; throws before anything
 *  is written.
 *
 *  R-T13-1: a matched slot also keeps its own POINTS, unless the body sends its own (a rule is one sentence: the body's
 *  replaces the carry whole). The carried rule is asked the stage PUT's points questions like any other
 *  (`refuseStagePoints`, inside `validatedStageConfig`), so a rule the division can no longer express refuses the Apply
 *  inside `replaceStages`' one transaction, which rolls its delete back (R-T13-3). A new slot, or one whose kind
 *  changed, carries none. */
function stageConfigsAtCreate(
  division: StageRulesScope,
  inputs: readonly StageInput[],
  carried: ReadonlyMap<string, StageCarry> = new Map(),
): Record<string, unknown>[] {
  const sportModule = resolveModule(division.sport_key, division.module_version);
  return inputs.map((s) => {
    const carry = carried.get(`${s.seq}:${s.kind}`);
    const sent = (s.config ?? {}) as Record<string, unknown>;
    // Each own table value the body does not send is the slot's carry (a body's own replaces it whole; null drops it).
    const config: Record<string, unknown> = { ...sent };
    for (const key of ["points", "tiebreakers", "crossGroupTiebreakers", "chess"] as const) {
      if (carry?.[key] !== undefined && sent[key] === undefined) config[key] = carry[key];
    }
    // UI5 fix round 1 (ruling Q2): the old desk switch's off is not carried onto a chess Swiss. The door below refuses
    // an off (SWISS_CHESS_ALWAYS_ON), and a replaced slot is unpaired, so it would pair in colour anyway (ruling I1):
    // the slot takes the default instead. A body's own off is still sent, and still refused.
    if (sent.chess === undefined && config.chess === false && isChessSport(division.sport_key)) delete config.chess;
    return validatedStageConfig(
      sportModule,
      division.sport_key,
      s.kind,
      division.variant_key,
      division.config,
      config,
      carry?.rules ?? null,
    );
  });
}

/**
 * W2c Task 13 fix round 1 (R-T13-2) — every refusal a stage BATCH earns from its input alone, before anything is written:
 * the sport's refused stage kinds (chess is individual-only: no americano or mexicano, which mint pair entrants — owner
 * ruling 2026-10-26, follow-up to #1027; asked FIRST, so a chess organiser is never offered a plan upgrade for a format
 * chess cannot play), the entitlement gates (`formats.double_elim`, `formats.advanced`, `standings.carry_over`), the feed graph, the stage cap counted against the batch, and a seq the
 * batch names twice. Pooled reads (`requireFeature`, `getLimit`), so both callers ask it before their transaction opens,
 * never inside one (lib/db.ts): `createStages` before its inserts, `replaceStages` before the one transaction that
 * deletes and recreates (R-T13-3), so a 402 or a 409 here writes nothing. It is not the only refusal a batch can earn —
 * the rules and points questions, the stage cap against the stages that stand, the database's CHECKs and an unresolvable
 * progression all answer inside the transaction, and roll it back. Returns the stage cap (`insertStageBatch` re-counts it
 * inside the insert transaction against the stages that stand then).
 */
export async function assertStageBatchGates(
  auth: AuthCtx,
  divComp: { competition_id: string; sport_key: string } | undefined,
  inputs: readonly StageInput[],
): Promise<number | null> {
  // A division's sport never changes after create (PatchDivision carries no sport_key), so the caller's read decides it.
  // The read is not an org check: `createStages` reads through the pooled `sql`, which bypasses RLS, so another org's
  // division IS read here; only `replaceStages` reads under `withTenant` (and 404s a division it cannot see). Other
  // orgs are kept out before either is called, by the route's `requireResourceAuth(req, "division", id, "write")`.
  // A division that does not exist reads undefined and refuses nothing here; the insert transaction answers it 404.
  if (divComp !== undefined) assertStageKindsAllowed(divComp.sport_key, inputs.map((s) => s.kind));
  // W4 T16 (X-SP-6 / RB4-S6, ruling 269): a stepladder or page playoff that names no progression has no table to seed
  // from — refused by name, the whole batch, before any plan gate (a format the product refuses is never an upgrade
  // prompt). Both writers ask it here: the create, and the Format dialog's replace, the one write that can take a stage's
  // progression away (pre-flight D11). A stage that already stands without one (stg held 11) keeps playing: only a new
  // write is refused. Fed from a league or Swiss (RB4-S7), neither kind is refused.
  for (const s of inputs) {
    const refusal = standaloneStageRefusal({ kind: s.kind, progression: s.progression ?? null });
    if (refusal !== null) throw knockoutRefusal(refusal, { seq: s.seq, kind: s.kind });
  }
  // Doc 10 §1: `formats.double_elim` is Pro — gate before any insert.
  if (inputs.some((s) => stageNeedsDoubleElimGate(s.kind))) {
    await requireFeature(auth.orgId, "formats.double_elim", divComp?.competition_id);
  }
  // The advanced-formats layer (Pro and the Event Pass) is the americano and
  // ladder KINDS. Custom byes, cross-stage feeds and placements were part of it
  // (Jul3/08 §8) until V471 ("all stages are free", owner ruling 2026-10-20).
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
  // Jul3/05 §7: bonuses + forfeit points + circular-H2H + carry-over were the Pro layer. A stage's own points and its
  // head-to-head scope ask no gate at all (W2d T10 fix round 1, I4: the owner's standing rule, all scoring is free — the
  // `standings.custom_points` and `tiebreakers.custom` reads are deleted; `overrideStandings` keeps the latter). Carry-over
  // is granted on every plan since V471, so its call refuses only on an explicit staff `org_entitlement_overrides` deny —
  // kept for exactly that lever.
  for (const s of inputs) {
    if (s.progression?.carry !== undefined && s.progression.carry !== "none") {
      await requireFeature(auth.orgId, "standings.carry_over");
    }
  }
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  // V471 ("all stages are free", owner ruling 2026-10-20) made this cap
  // unlimited on every plan; before it, V393 lifted it on an Event Pass
  // (community 2 -> event_pass 4). The read is kept, competition-scoped with
  // the `divComp` id the format gates already resolved, because a staff
  // `org_entitlement_overrides` row can still cap one organisation.
  const stageCap = await getLimit(auth.orgId, "stages.per_division.max", divComp?.competition_id);
  // The batch alone must fit (a lower bound of the in-transaction count: the stages that already stand add to it).
  assertWithinLimit(stageCap, "stages.per_division.max", inputs.length);
  // A seq the batch names twice can never insert: refused here, not by the second insert after a delete.
  const seen = new Set<number>();
  for (const s of inputs) {
    if (seen.has(s.seq)) throw new HttpError(409, `stage seq ${s.seq} already exists`);
    seen.add(s.seq);
  }
  return stageCap;
}

/** Define (part of) the stage graph for a division. Each stage is written with its kind's preset match rules
 *  (`stage-defaults.ts`, X-SR-6) under any `config.rules` sent with it, validated as `PUT /stages/{id}/rules` validates
 *  a save (SC-P8). The pooled gates first, then the inserts in one transaction (`insertStageBatch`). */
export async function createStages(auth: AuthCtx, divisionId: string, input: CreateStages): Promise<StageRow[]> {
  const inputs: StageInput[] = Array.isArray(input) ? input : [input];
  assertSwissRoundsDeclared(inputs);
  // Format gates honour an Event Pass on this division's competition
  // (v3/07 §3), so resolve the competition before gating.
  const [divComp] = await sql<{ competition_id: string; sport_key: string }[]>`
    select competition_id, sport_key from divisions where id = ${divisionId}`;
  const stageCap = await assertStageBatchGates(auth, divComp, inputs);
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  return withTenant(auth.orgId, (tx) => insertStageBatch(tx, divisionId, inputs, stageCap, frozen));
}

/** The write half of a stage batch, inside the CALLER's transaction: the division lock, the division (404), each stage's
 *  config, the frozen competition, the stage cap against the stages that stand, the inserts, the progression rules, the
 *  reopen. Every refusal it raises rolls back with that transaction — which is what lets `replaceStages` run its delete
 *  in the same one (R-T13-3). No pooled reads in here (lib/db.ts): the caller asks the gates (`assertStageBatchGates`)
 *  and the frozen set before opening `withTenant` and hands them in. `carried` is replaceStages' own: what a slot kept
 *  across its delete-and-recreate (`StageCarry`).
 *
 *  Batch 4 I1: the division lock comes FIRST, and the division's variant and config are read after it. The presets each
 *  stage is seeded from, and every rules and points question it is asked, depend on that variant; `patchDivision` takes
 *  the same lock to change it and to re-seed the stages that stand, so a create that read the variant before waiting
 *  could store a preset the variant no longer takes (cricket `t20` -> `test` with a stored super over). The key is the
 *  one `patchDivision` and `replaceStages` take; `replaceStages` already holds it in this transaction, and a second
 *  `pg_advisory_xact_lock` by the same session on the same key is re-entrant.
 *
 *  The division is read `for no key update`, so this transaction holds the row BEFORE its first insert. A stage INSERT
 *  takes `for key share` on the division through its foreign key, and the reopen below wants the row `for no key update`;
 *  a save that renames the division (slug regenerated: an update of the unique index (competition_id, slug) takes the row
 *  `for update`, which waits for every key share) and names a masking field (it already holds the row `for no key update`)
 *  crossed the two on a completed division: 40P01. Taking the row first makes them queue on it instead. Same order as
 *  `patchDivision`'s format path (advisory lock, then row); `putStageRules` takes no division row lock. */
async function insertStageBatch(
  tx: Tx,
  divisionId: string,
  inputs: readonly StageInput[],
  stageCap: number | null,
  frozen: ReadonlySet<string>,
  carried?: ReadonlyMap<string, StageCarry>,
): Promise<StageRow[]> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  const [division] = await tx<({ competition_id: string; tiebreakers: string[] | null } & StageRulesScope)[]>`
    select competition_id, sport_key, module_version, variant_key, config, tiebreakers from divisions where id = ${divisionId}
    for no key update`;
  if (!division) throw new HttpError(404, "division not found");
  // Before any insert: a refused rules fragment (or a preset the division cannot take) writes nothing, the whole batch.
  // The same door asks each stage's points the stage PUT's questions (W2c Task 13, `refuseStagePoints`), the old
  // fail-closed metrics check (Jul3/05 §8: a rule needing metrics the sport doesn't emit never reaches play) among them.
  const configs = stageConfigsAtCreate(division, inputs, carried);
  // W2d Task 10 (spec §5.5) — the order each new stage will rank by (its own, else the division's, else the sport's) is
  // `validateCascade`d on its kind, an inherited one the kind refuses refused with "set this stage's own order"; and the
  // points it will pay must pay every outcome its rules reach (`coverage`). Before any insert, the whole batch.
  const sportModule = resolveModule(division.sport_key, division.module_version);
  for (const [i, s] of inputs.entries()) {
    refuseNewStageTable(sportModule, { kind: s.kind, name: s.name, config: configs[i]! }, { config: division.config, tiebreakers: division.tiebreakers });
  }
  assertNotFrozen(frozen, division.competition_id);

  // Doc 10 §1: `stages.per_division.max` (∞ on every plan since V471; an
  // override can still set one) — the batch must fit,
  // counted in the same tx as the inserts (doc 10 §2 rule 1).
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from stages where division_id = ${divisionId}`;
  assertWithinLimit(stageCap, "stages.per_division.max", n + inputs.length);

  const rows: StageRow[] = [];
  for (const [i, s] of inputs.entries()) {
    const [dupe] = await tx`
      select 1 from stages where division_id = ${divisionId} and seq = ${s.seq}`;
    if (dupe) throw new HttpError(409, `stage seq ${s.seq} already exists`);
    const [row] = await tx<StageRow[]>`
      insert into stages (division_id, seq, kind, name, config, progression)
      values (${divisionId}, ${s.seq}, ${s.kind}, ${s.name}, ${tx.json(configs[i] as never)},
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
}

/** FMT5: a fixture of the division's stages that holds a result that STANDS (`fixtureHoldsStandingResultSql`: a status
 *  of play, an abandonment with an outcome, an event no void took back, an event-less award, a report, a mark or a
 *  suspension; a generation-time bye and the F14 walkover are none). Fix round 1 (controller ruling I2): a board whose
 *  only events were all voided is no result, so the format opens again - unlike history's played set
 *  (`fixtureHasResultSql`), which keeps it. Scoped through the stages, the set the change replaces. */
function formatResultSql(tx: Tx, divisionId: string) {
  return tx`
    select 1 from fixtures f join stages s on s.id = f.stage_id
     where s.division_id = ${divisionId} and ${fixtureHoldsStandingResultSql(tx)}
     limit 1`;
}

/** FORMAT_LOCKED (409): a result exists in the division, so its stage graph is the format being played (FMT5: the lock
 *  used to be ANY fixture row; generated and scheduled fixtures alone no longer lock it, they are cleared on confirm). */
async function assertFormatUnlocked(tx: Tx, divisionId: string): Promise<void> {
  const [locked] = await formatResultSql(tx, divisionId);
  if (locked) {
    const r = FORMAT_CHANGE_REFUSALS.FORMAT_LOCKED;
    throw new HttpError(r.status, r.message, "FORMAT_LOCKED");
  }
}

/** Is the division's format locked (a standing result exists)? The Division rules card's Format button reads it (the
 *  division page, `formatCard`); the same predicate `replaceStages` refuses on. */
export async function divisionFormatLocked(auth: AuthCtx, divisionId: string): Promise<boolean> {
  return withTenant(auth.orgId, async (tx) => (await formatResultSql(tx, divisionId)).length > 0);
}

/** What the change would clear, read under the division lock from the rows the delete takes. The token is a digest of
 *  exactly those rows (stages, fixtures with their slot and court, and the setup counted), so a confirm made against an
 *  older board is refused FORMAT_CHANGE_STALE instead of clearing something it never named. */
async function formatChangePreview(tx: Tx, divisionId: string): Promise<FormatChangePreview> {
  const stages = await tx<{ id: string; name: string }[]>`
    select id, name from stages where division_id = ${divisionId} order by seq`;
  const fixtures = await tx<{ id: string; scheduled_at: Date | null; court_id: string | null }[]>`
    select f.id, f.scheduled_at, f.court_id from fixtures f join stages s on s.id = f.stage_id
     where s.division_id = ${divisionId} order by f.id`;
  const counts = { officials: 0, lineups: 0, device_links: 0, calls: 0, voided_scores: 0 };
  if (fixtures.length > 0) {
    const ids = fixtures.map((f) => f.id);
    // Fix round 1 (controller ruling I1): `device_links` counts the LIVE remote-scoring links only - not revoked, not
    // expired (device-links.ts `getActiveDeviceLink`). Every link cascades with its board; a dead one stops nothing, so
    // the confirm does not name it. Re-review r1-m1: `voided_scores` counts the recorded entries a void took back (a voided
    // Start or score; never the void rows themselves). It counts every non-void entry: the lock asked above (same tx,
    // `fixtureHoldsStandingResultSql`) refuses any entry no void took back, so past it every one IS voided - a second
    // "and a void names it" clause would be an equivalent mutant nothing can kill. These are the only recorded play the
    // clear deletes, and the confirm must not call that "nothing played".
    const [c] = await tx<typeof counts[]>`
      select
        (select count(*) from fixture_officials where fixture_id in ${tx(ids)})::int as officials,
        (select count(*) from lineups where fixture_id in ${tx(ids)})::int as lineups,
        (select count(*) from device_links
          where fixture_id in ${tx(ids)} and revoked_at is null and (expires_at is null or expires_at > now()))::int as device_links,
        (select count(*) from fixture_calls where fixture_id in ${tx(ids)})::int as calls,
        (select count(*) from score_events where fixture_id in ${tx(ids)} and type <> 'core.void')::int as voided_scores`;
    Object.assign(counts, c);
  }
  const slots = fixtures.filter((f) => f.scheduled_at !== null).length;
  const courts = new Set(fixtures.flatMap((f) => (f.court_id === null ? [] : [f.court_id]))).size;
  const token =
    fixtures.length === 0
      ? null
      : createHash("sha256")
          .update(
            JSON.stringify({
              stages: stages.map((st) => st.id),
              fixtures: fixtures.map((f) => [f.id, f.scheduled_at?.toISOString() ?? null, f.court_id]),
              counts,
            }),
          )
          .digest("hex")
          .slice(0, 32);
  return { dry_run: true, stages, fixtures: fixtures.length, slots, courts, ...counts, token };
}

/** The rollback a dry run ends in, carrying its answer out of the transaction. */
class FormatChangeDryRun extends Error {
  constructor(readonly preview: FormatChangePreview) {
    super("format change dry run");
  }
}

/** Replace the division's whole stage graph (FMT5: the Format dialog on the Fixtures tab's Division rules card).
 *  Refused FORMAT_LOCKED, division-wide, once a result exists (`assertFormatUnlocked`). That is the STRUCTURE's lock only:
 *  patchDivision's variant/config guard is a different, narrower one (per field and per STARTED stage that inherits it -
 *  `divisionRefusals`, rule-locks.ts), so a division with fixtures and no started stage can still change its rules.
 *
 *  Fixtures but no result (FMT5): the change CLEARS them - the fixtures, their schedule and the setup that cascades with
 *  them (officials, lineups, device links, Match Day calls) - and rebuilds the stages, in this one transaction, but only
 *  with the token of a preview (`opts.clear`, `previewReplaceStages`): without it 409 FORMAT_CHANGE_CONFIRM, with an
 *  older board's 409 FORMAT_CHANGE_STALE (a sent token is checked even when nothing is left to clear), each carrying the
 *  fresh preview. A live remote-scoring link is not refused (controller ruling I1, the owner's one-confirm mock): it
 *  goes with its board, and the preview counts the live ones so the confirm names them. Refused outright while a stream session is
 *  active on a board (FORMAT_STREAM_LIVE), an online game stands behind one (ONLINE_GAME_EXISTS), a match carries its own
 *  format (FIXTURE_HAS_OWN_FORMAT) or the schedule is frozen (422 SCHEDULE_LOCKED). No fixtures: the stages are replaced
 *  as before, with no token and no freeze check.
 *
 *  The delete and every insert run in ONE transaction (R-T13-3): any refusal
 *  the recreate raises — a rules or points fragment (`stageConfigsAtCreate`),
 *  the frozen competition, the stage cap, a database CHECK, a progression
 *  source that resolves to nothing — rolls the delete back with it, and the
 *  division keeps the stages it had. The pooled gates (`assertStageBatchGates`,
 *  R-T13-2) and the frozen lookup are asked before that transaction opens,
 *  after one short tenant read that answers a missing (or another org's)
 *  division 404 and a locked one FORMAT_LOCKED ahead of any 402. The token is asked LAST, after the rebuild, so every
 *  refusal the change can raise answers before a confirm is asked for (and the preview, which is this same path rolled
 *  back, raises them at Save). */
export async function replaceStages(
  auth: AuthCtx,
  divisionId: string,
  input: CreateStages,
  opts: { clear?: string } = {},
): Promise<StageRow[]> {
  const out = await runReplaceStages(auth, divisionId, input, { dryRun: false, clear: opts.clear });
  return out as StageRow[];
}

/** FMT5 (`PUT /divisions/{id}/stages?dry_run=1`): the whole change, every refusal included, rolled back - answering what
 *  it would clear. The counts are read from the rows the delete takes, so the confirm never says a number the client
 *  computed. */
export async function previewReplaceStages(auth: AuthCtx, divisionId: string, input: CreateStages): Promise<FormatChangePreview> {
  const out = await runReplaceStages(auth, divisionId, input, { dryRun: true });
  return out as FormatChangePreview;
}

async function runReplaceStages(
  auth: AuthCtx,
  divisionId: string,
  input: CreateStages,
  mode: { dryRun: true } | { dryRun: false; clear: string | undefined },
): Promise<StageRow[] | FormatChangePreview> {
  const inputs: StageInput[] = Array.isArray(input) ? input : [input];
  // The swiss round-count guard: pure, asked before any read. This is the PUT
  // the Format dialog's Save calls, so a bad round count refuses before anything.
  assertSwissRoundsDeclared(inputs);
  // Fix round 2 (c): one short tenant read before the gates. RLS scopes it to the caller's org, so another org's
  // division is a missing one (404 — a gate's 402 would confirm it exists). A division holding a result answers
  // FORMAT_LOCKED, the refusal the organiser can act on, ahead of any plan gate or frozen 402. The lock is asked
  // again under the advisory lock below: this read decides the ORDER of the refusals, that one is the guard.
  const divComp = await withTenant(auth.orgId, async (tx) => {
    const [head] = await tx<{ competition_id: string; sport_key: string }[]>`
      select competition_id, sport_key from divisions where id = ${divisionId}`;
    if (!head) throw new HttpError(404, "division not found");
    await assertFormatUnlocked(tx, divisionId);
    return head;
  });
  // R-T13-2: every gate `createStages` asks of the batch. Pooled reads, so between the two transactions, never in one.
  const stageCap = await assertStageBatchGates(auth, divComp, inputs);
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  let write: { rows: StageRow[]; clearedIds: string[] };
  // FMT5: the board being streamed, read in the privileged prelude - `fixture_stream_sessions` is sealed (no app_user
  // grant), and a pooled read would be a second connection. Under the division lock, which the transaction's own
  // `pg_advisory_xact_lock` below then re-enters. Org-scoped by hand: RLS does not run here.
  let streaming: { fixture_id: string; fixture_no: number | null } | undefined;
  const streamGate = async (tx: Tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    [streaming] = await tx<{ fixture_id: string; fixture_no: number | null }[]>`
      select f.id as fixture_id, f.fixture_no
        from fixture_stream_sessions ss join fixtures f on f.id = ss.fixture_id join stages s on s.id = f.stage_id
       where s.division_id = ${divisionId} and f.org_id = ${auth.orgId} and ss.state = any(${[...ACTIVE_STATES]}::text[])
       order by f.fixture_no nulls last, f.id limit 1`;
  };
  try {
    write = await withTenant(auth.orgId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      // FMT5: the append lock of every board the clear would take, BEFORE the result read (the one lock order,
      // `division:` -> `fixture:`, append-event.ts). Scoring serialises on the fixture, never the division, so without it
      // a first score committing between the read and the delete would be cascaded away with its board. With it a scorer
      // in flight either commits first (and the read below refuses FORMAT_LOCKED) or waits and finds the board gone.
      // Generation holds the division lock, so no board appears after this read.
      const boardIds = (
        await tx<{ id: string }[]>`
          select f.id from fixtures f join stages s on s.id = f.stage_id where s.division_id = ${divisionId}`
      ).map((r) => r.id);
      await lockSwissBoardAppends(tx, boardIds);
      await assertFormatUnlocked(tx, divisionId);
      const preview = await formatChangePreview(tx, divisionId);
      let clearedIds: string[] = [];
      if (preview.fixtures > 0) {
        // The clear is the widest board write there is, so a frozen schedule refuses it on the same terms and with the same
        // code as every other board write (deleteStage, rebuild, applySchedule), read under the same lock.
        if ((await divisionLockState(tx, divisionId)).frozen) {
          throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
        }
        // A board being streamed is a match the audience is watching: its session would be unbound (SET NULL) mid-stream
        // (`streamGate`, above).
        if (streaming) {
          const r = FORMAT_CHANGE_REFUSALS.FORMAT_STREAM_LIVE;
          throw new HttpError(r.status, r.message.replace("{match}", matchName(streaming.fixture_no)), "FORMAT_STREAM_LIVE", {
            fixture_id: streaming.fixture_id,
            fixture_no: streaming.fixture_no,
          });
        }
        // The delete CASCADEs into fixture_external_play, and no result guard can see an online game in progress.
        await lockBoardsRefusingOnlineGames(tx, boardIds);
        // W2c Task 14: a match's own format would vanish with its row — refused by name instead, as a rebuild refuses it.
        await refuseOwnFormatLoss(tx, tx`id in ${tx(boardIds)}`);
        // Phase 3 wave 1 (G-1): the boards go, and their queued invites with them.
        await cancelBoardInvites(tx, boardIds, FIXTURE_DELETED_REASON);
        clearedIds = (
          await tx<{ id: string }[]>`delete from fixtures where id in ${tx(boardIds)} returning id`
        ).map((r) => r.id);
        // Structural ledger + division watermark (deleteStage's pattern; a non-registry type, so history neither undoes nor
        // replays it — an older step of the cleared board restores nothing: its stage is gone, `restoreFixtures`).
        const [{ seq: last }] = await tx<{ seq: number }[]>`
          select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
        await tx`
          insert into division_events (division_id, seq, type, payload)
          values (${divisionId}, ${last + 1}, 'stages_replaced',
                  ${tx.json({ stages: preview.stages, fixtures: clearedIds.length, slots: preview.slots, courts: preview.courts } as never)})`;
        await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
      }
      // Per-stage match-rules overrides survive the delete (design 2026-09-17,
      // owner ruling 2026-09-18). The Format tab's Apply is a delete-and-recreate
      // from the template body, which carries no rules, so the carry-forward has
      // to happen HERE, server-side, rather than by asking the client to re-issue
      // a PUT afterwards: it then holds for every caller of this function, not
      // just the one screen we happened to fix. W2c Task 12 (Review Focus 5): the
      // body's own rules are laid over the carry, key by key (`withStageDefaults`).
      // Fix round 2 (R-T12-4): a matched slot's stored rules are its WHOLE format,
      // so the carry REPLACES the slot's preset rather than sitting over it: a
      // preset key the organiser removed stays removed, and a slot with no stored
      // rules ("Same as division") is carried as `{}`, never re-seeded. Only a
      // genuinely new slot (no entry here) starts from its preset.
      const rows = await tx<{ seq: number; kind: string; config: Record<string, unknown> }[]>`
        select seq, kind, config from stages where division_id = ${divisionId}`;
      const keep = new Map<string, StageCarry>();
      for (const r of rows) {
        const rules = r.config?.rules;
        // Keyed on seq AND kind. A format override belongs to a stage SLOT, and
        // "the knockout is Best-of-5" does not mean "whatever now sits at seq 2
        // is Best-of-5" — an Apply that turns seq 2 from knockout into league is
        // a different competition shape, and silently dressing the new stage in
        // the old stage's format is the kind of invisible carry nobody audits.
        // A slot whose kind changed starts from ITS OWN kind's preset instead,
        // which is a visible, correctable state; carrying it wrongly is not. Note
        // this is a JUDGEMENT, not a validity constraint: the allowlist is per
        // sport, kind and variant, and none of them changes for a matched slot.
        // No stored rules object is the organiser's clear: carried as `{}`.
        const cleared = rules === null || rules === undefined || typeof rules !== "object" || Array.isArray(rules);
        // R-T13-1: the slot's own points ride the same carry (an organiser's choice on the same screen, not the
        // template's), and are re-asked below with the body; a slot that has none carries none.
        const points = r.config?.points;
        // W2d Task 10: and its own orders, the same way (a slot with none carries none, and inherits).
        const tiebreakers = r.config?.tiebreakers;
        const crossGroupTiebreakers = r.config?.crossGroupTiebreakers;
        // W3 T12 (T8 review m6): a Swiss slot's chess switch, the organiser's (the default is re-seeded only for a slot
        // that stores none — `withSwissChessDefault`).
        const chess = r.config?.chess;
        keep.set(`${r.seq}:${r.kind}`, {
          rules: cleared ? {} : (rules as Record<string, unknown>),
          ...(points !== undefined && points !== null ? { points } : {}),
          ...(tiebreakers !== undefined && tiebreakers !== null ? { tiebreakers } : {}),
          ...(crossGroupTiebreakers !== undefined && crossGroupTiebreakers !== null ? { crossGroupTiebreakers } : {}),
          ...(typeof chess === "boolean" ? { chess } : {}),
        });
      }
      await tx`delete from stages where division_id = ${divisionId}`;
      // R-T13-3: the recreate runs in THIS transaction, so every refusal it raises — the body's and the carry's rules and
      // points, the 404, the frozen 402, the cap, a CHECK, SEEDING_RULES_MISSING — rolls the delete above back with it.
      const created = await insertStageBatch(tx, divisionId, inputs, stageCap, frozen, keep);
      // FMT5: the dry run ends here, rolled back, with every refusal above already asked.
      if (mode.dryRun) throw new FormatChangeDryRun(preview);
      // The confirm, asked last: a change that clears fixtures goes through only with the token of the board it named.
      // Fix round 1 (review m2): a token sent is checked even when the board now has nothing to clear - a confirm made
      // against fixtures someone else's change has since removed would otherwise replace THEIR stages with a body whose
      // confirm named different ones.
      if (mode.clear === undefined ? preview.token !== null : mode.clear !== preview.token) {
        const code = mode.clear === undefined ? "FORMAT_CHANGE_CONFIRM" : "FORMAT_CHANGE_STALE";
        const r = FORMAT_CHANGE_REFUSALS[code];
        throw new HttpError(r.status, r.message, code, { preview });
      }
      return { rows: created, clearedIds };
    }, { privilegedPrelude: streamGate });
  } catch (err) {
    if (err instanceof FormatChangeDryRun) return err.preview;
    throw err;
  }
  // After the commit: the cleared boards leave the hub and any open match centre (deleteStage's publish).
  if (write.clearedIds.length > 0) afterScheduleWrite(divisionId, divComp.competition_id, "schedule", write.clearedIds);
  return write.rows;
}

/**
 * Delete a stage (organiser added it by mistake). Only the last stage of the
 * graph is deletable — removing a middle stage would orphan the qualification
 * chain — and never one with played fixtures (in_play / decided / finalized).
 * Bye/walkover awards ('forfeited') don't block: every fresh knockout with a
 * non-power-of-two field holds them. Pools, fixtures, snapshots go via
 * ON DELETE CASCADE.
 */
/** A stage that is not the last in the graph cannot be deleted (the graph would lose its middle). FMT5: the way to change the
 *  stages before it is the division's Format (the Division rules card), which rebuilds the whole graph until the first result;
 *  the sentence sends the organiser there, never to delete stage after stage from the end. */
export const DELETE_STAGE_NOT_LAST_MESSAGE =
  "only the last stage can be deleted — to change the stages before it, change the division's format on the Fixtures tab";

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
      throw new HttpError(409, DELETE_STAGE_NOT_LAST_MESSAGE);
    }
    const [played] = await tx`
      select 1 from fixtures
      where stage_id = ${stageId} and status in ('in_play', 'decided', 'finalized', 'needs_decision') limit 1`;
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
    // Phase 3 wave 1 (G-1): the invites still queued for the boards just deleted end with them. Named from the rows the delete
    // returned, in the same transaction.
    await cancelBoardInvites(tx, removed.map((row) => row.id), FIXTURE_DELETED_REASON);
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