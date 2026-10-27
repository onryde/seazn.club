import "server-only";
// W2d Task 10 (spec §5.4 "What changes after the pin", "Fixture override coverage", §5.5 "Write paths", §10; D3, D8, D9,
// D10(a); rule rows X-TB-2, X-TB-3, X-TB-5, X-PT-3, FB-TB-4) — the table-rule questions every writer asks, in one leaf
// module so the stage PUT (`stage-rules.ts`), the division create and save (`divisions.ts`), the stage doors
// (`stages.ts`, `templates.ts`) and the match override (`fixture-rules.ts`) read one definition and none imports another's
// usecase.
//
//  1. a tie-break order is the engine's `validateCascade`, refused as 422 TIEBREAK_KEY_INVALID with every refused step in
//     `extra.refusals`;
//  2. a stage's points must pay every outcome its matches can reach (`coverage(rule, reachableOutcomes(...))`): 422
//     POINTS_OUTCOME_UNCOVERED naming them in `extra.uncovered`. It replaces W2c's POINTS_MAP_INCOMPLETE, whose question
//     (does the division's `pointsMap` answer every set score a `bestOf` reaches) is one case of it;
//  2b. (fix round 1 I2, owner 2026-10-26) a FLAT rule — one amount per win and per loss — written to a stage whose sport
//     pays an outcome it reaches its own way (IIHF's overtime, FIVB's 3-2, ITTF's loss not played, FIH's shoot-out bonus;
//     `sportPointsSplits`, lib/stage-points-splits.ts, over the engine's payout) would pay that outcome as a plain win or
//     loss: 422 POINTS_SPLIT_FLATTENED naming the splits in `extra.splits`. The stage points editor never sends one (since
//     W2d Task 16 it states every split, and says this refusal inline before Save); this is the server holding the same
//     line for any caller. A rule that
//     states the outcome (`win.ot`, `loss.unplayed`, `bySetScore`, …) is the caller's choice and is never refused for it.
//     (Task 13, N2/N3) The rule sent or carried is asked too (`flattenedSplits`, the editor's own fit), with the award
//     after play among the outcomes (fix round 1 I1): no flat rule pays a split sport's every outcome, so it is refused;
//  3. which rules a stage reads is the loader's answer (`tableRulesOf`, engine-db/table-rules.ts), asked of the rows as they
//     stand and as the save would leave them. The write side never re-derives a layer (the single-resolver scan).
//
// Cause, not state: a save is refused for what IT does. A value the save writes is checked whole (the organiser chose it);
// anything else a save moves (a division config under a stage, a stage's rules under its points) is refused only for a
// refusal it ADDS, so a stage already in a state no door writes now (a legacy row) never blocks an unrelated edit.
import { DRAW_KINDS, EngineError, StageKind } from "@seazn/engine/core";
import {
  SET_SCORE_KEY,
  coverage,
  reachableOutcomes,
  validateCascade,
  type CascadeRefusal,
  type OutcomeKey,
  type PointsRule,
} from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, ruleErrorMessage, type TiebreakRefusalWire } from "@/lib/rule-errors";
import { flattenedSplits } from "@/lib/stage-points-splits";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { repinnedOf, tableRulesOf, type LoadedTableRules, type TableRulesRow } from "@/server/engine-db/table-rules";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The cfg an order and a rule are asked under: the sport's parse (its defaults applied), else as stored (the resolver's
 *  tolerance: never stricter than the fold). */
function parsedOr(module: AnySportModule, cfg: unknown): unknown {
  const parsed = module.configSchema.safeParse(cfg);
  return parsed.success ? parsed.data : cfg;
}

/** A stage's merged cfg (the division's under its rules), as its matches resolve it. */
const stageCfgOf = (module: AnySportModule, row: TableRulesRow): unknown =>
  liveCfg(row.divisionConfig, { kind: row.kind, config: row.stageConfig }, module);

/** `kind` as a stage kind, or null for a value no stage kind is (a stored row the vocabulary has since dropped). */
function stageKindOf(kind: string): StageKind | null {
  const parsed = StageKind.safeParse(kind);
  return parsed.success ? parsed.data : null;
}

const isTableKind = (kind: string): boolean => DRAW_KINDS.has(kind as StageKind);

// ── 1. Tie-break orders ──────────────────────────────────────────────────────────────────────────────────────────────

/** Every refusal of `order` on a stage of `stageKind` under `cfg` (`crossGroup`: the order compares entrants across
 *  groups, D3). Throws the engine's CONFIG_INVALID for a key outside the vocabulary (a typed 422; the zod enum refuses
 *  those at the edge). */
export function cascadeRefusals(
  module: AnySportModule,
  cfg: unknown,
  stageKind: StageKind,
  order: readonly TiebreakerKey[],
  crossGroup = false,
): readonly CascadeRefusal[] {
  return validateCascade(order, { module, cfg: parsedOr(module, cfg), stageKind, crossGroup });
}

/** 422 TIEBREAK_KEY_INVALID: every refused step in `extra.refusals`, the first in the sentence. `stage` names the stage a
 *  division save is refused for; `inherited` tells the organiser the order is one the stage would inherit. */
export function tiebreakRefusal(
  refusals: readonly CascadeRefusal[],
  extra: Record<string, unknown> = {},
  opts: { stage?: string; inherited?: boolean } = {},
): HttpError {
  const first = refusals[0];
  if (first === undefined) throw new EngineError("CONFIG_INVALID", "a tie-break refusal needs a refused step");
  return new HttpError(
    RULE_ERROR_STATUS.TIEBREAK_KEY_INVALID,
    ruleErrorMessage("TIEBREAK_KEY_INVALID", { refusal: first as TiebreakRefusalWire, stage: opts.stage, inherited: opts.inherited }),
    "TIEBREAK_KEY_INVALID",
    { ...extra, refusals: [...refusals] },
  );
}

/** The order against the SPORT alone, where no stage is asked (a division default, a template's): the rules that hold on
 *  every stage kind — the empty order, a repeat, a step the sport does not record, fair play the cfg does not track, a
 *  modifier out of place. Asked as a Swiss stage asks them, the one kind exempt from the first/last rule and from the
 *  Swiss-only steps (OC1, D10(d)): every inheriting stage is then asked its own kind's rules. */
export function refuseCascadeForSport(module: AnySportModule, cfg: unknown, order: readonly TiebreakerKey[]): void {
  const refusals = cascadeRefusals(module, cfg, "swiss", order);
  if (refusals.length > 0) throw tiebreakRefusal(refusals);
}

const refusalId = (r: CascadeRefusal): string => JSON.stringify([r.index, r.key, r.reason]);

/** The refusals of `after` that `before` did not have: what a save ADDS. */
const added = (after: readonly CascadeRefusal[], before: readonly CascadeRefusal[]): CascadeRefusal[] => {
  const had = new Set(before.map(refusalId));
  return after.filter((r) => !had.has(refusalId(r)));
};

// ── 2. Coverage ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a rule leaves unpaid among the outcomes `cfg` reaches on a stage of `kind`, or null when there is nothing to ask:
 *  a stage kind outside the vocabulary, a stage with no table (a bracket's points pay nothing: who advances is the
 *  bracket's `outcome.winner`, spec §5.3), or a cfg the sport refuses (the merged parse refuses that save by name, as
 *  CONFIG_INVALID, before or after this). */
function unpaid(
  module: AnySportModule,
  rule: PointsRule,
  cfg: unknown,
  kind: string,
): { uncovered: readonly OutcomeKey[]; inapplicable: readonly string[] } | null {
  const stageKind = stageKindOf(kind);
  if (stageKind === null || !isTableKind(stageKind) || !module.configSchema.safeParse(cfg).success) return null;
  const answer = coverage(rule, reachableOutcomes(module, cfg, stageKind));
  return answer.ok ? { uncovered: [], inapplicable: [] } : { uncovered: answer.uncovered, inapplicable: answer.inapplicable };
}

/** 422 POINTS_OUTCOME_UNCOVERED naming the outcomes, or — for a set-score table on a sport that keeps none (I1) — 400
 *  RULE_NOT_SETTABLE on `points.bySetScore`. */
function uncoveredRefusal(
  found: { uncovered: readonly OutcomeKey[]; inapplicable: readonly string[] },
  extra: Record<string, unknown>,
  stage?: string,
): HttpError {
  if (found.inapplicable.length > 0) {
    const field = `points.${found.inapplicable[0]}`;
    return new HttpError(
      RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
      ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason: "this sport keeps no set-score table", stage }),
      "RULE_NOT_SETTABLE",
      { ...extra, field },
    );
  }
  return new HttpError(
    RULE_ERROR_STATUS.POINTS_OUTCOME_UNCOVERED,
    ruleErrorMessage("POINTS_OUTCOME_UNCOVERED", { uncovered: found.uncovered, stage }),
    "POINTS_OUTCOME_UNCOVERED",
    { ...extra, uncovered: [...found.uncovered] },
  );
}

/** Refuse what `after` leaves unpaid — all of it when `whole` (the save wrote the rule), else only what `before` paid. */
function refuseUnpaid(
  module: AnySportModule,
  after: { rule: PointsRule; cfg: unknown; kind: string },
  before: { rule: PointsRule; cfg: unknown; kind: string } | null,
  extra: Record<string, unknown> = {},
  stage?: string,
): void {
  const now = unpaid(module, after.rule, after.cfg, after.kind);
  if (now === null) return;
  const was = before === null ? null : unpaid(module, before.rule, before.cfg, before.kind);
  const fresh = {
    uncovered: now.uncovered.filter((o) => !(was?.uncovered.includes(o) ?? false)),
    inapplicable: now.inapplicable.filter((f) => !(was?.inapplicable.includes(f) ?? false)),
  };
  if (fresh.uncovered.length > 0 || fresh.inapplicable.length > 0) throw uncoveredRefusal(fresh, extra, stage);
}

/** 2b. Refuse a flat `rule` the save writes onto a stage whose sport pays an outcome it reaches apart (under `cfg`, the
 *  stage's merged cfg as the save leaves it) — `flattenedSplits`, W2d Task 13 N2/N3: the caller's rule is asked, not only
 *  the sport, an award after play included (fix round 1 I1). Asked only of a rule the save WRITES (cause, not state). */
function refuseFlatOverSplit(module: AnySportModule, rule: PointsRule, cfg: unknown, kind: string, extra: Record<string, unknown> = {}, stage?: string): void {
  const splits = flattenedSplits(module, parsedOr(module, cfg), kind, rule);
  if (splits.length === 0) return;
  throw new HttpError(
    RULE_ERROR_STATUS.POINTS_SPLIT_FLATTENED,
    ruleErrorMessage("POINTS_SPLIT_FLATTENED", { splits, stage }),
    "POINTS_SPLIT_FLATTENED",
    { ...extra, splits },
  );
}

// ── 3. The writers ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What one save writes to a stage's own table layer (`stages.config`): each arm absent = kept, null = cleared. */
export interface StageTableArms {
  readonly points?: PointsRule | null;
  readonly tiebreakers?: readonly TiebreakerKey[] | null;
  readonly crossGroupTiebreakers?: readonly TiebreakerKey[] | null;
}

/** The rules a stage reads once a save lands, as the loader will read them. A pending stage reads its live layers under the
 *  config the save leaves; a pinned one reads the pin `repinStageOwnRules` will write (`repinnedOf`, PS-5d: every field
 *  the save did not write kept, a written one re-resolved over the new own layer). */
function rulesAfter(
  module: AnySportModule,
  before: TableRulesRow,
  afterConfig: Record<string, unknown>,
  arms: StageTableArms,
): Pick<LoadedTableRules, "points" | "tiebreakers" | "crossGroup" | "sources"> {
  const after: TableRulesRow = { ...before, stageConfig: afterConfig };
  if (before.pin === null || before.pin === undefined) return tableRulesOf({ ...after, status: "pending", pin: null, pinnedAt: null }, module);
  return repinnedOf(after, module, { points: arms.points, tiebreakers: arms.tiebreakers, crossGroup: arms.crossGroupTiebreakers });
}

/**
 * The stage PUT (`putStageRules`): its own order, cross-group order and points, and the rules arm under them. Asked BEFORE
 * anything is written, from the stage's row as it stands (`before`, read under the stage writers' lock) and the config the
 * save would leave (`afterConfig`):
 *  - a bracket stage has no table to rank: an own order is RULE_NOT_SETTABLE (field `tiebreakers` /
 *    `crossGroupTiebreakers`); clearing one is always allowed;
 *  - an order the save writes is validated whole on the stage's kind (`validateCascade`; the cross-group one with
 *    `crossGroup`); an order it does not write is refused only for a refusal the save adds (the rules arm moving the cfg);
 *  - the points the stage pays after the save must pay every outcome its matches can reach under the config after it — a
 *    rule the save writes, whole; otherwise what the save leaves newly unpaid (a `bestOf` past the pinned set-score table,
 *    VB-PT-3).
 */
export function refuseStageTableSave(
  module: AnySportModule,
  before: TableRulesRow,
  afterConfig: Record<string, unknown>,
  arms: StageTableArms,
): void {
  if (!isTableKind(before.kind)) {
    for (const field of ["tiebreakers", "crossGroupTiebreakers"] as const) {
      if (arms[field] !== undefined && arms[field] !== null)
        throw new HttpError(
          RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
          ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason: "a bracket stage has no table to rank" }),
          "RULE_NOT_SETTABLE",
          { field },
        );
    }
  }
  const kind = stageKindOf(before.kind);
  const table = kind !== null && isTableKind(kind) ? kind : null;
  const cfgWas = stageCfgOf(module, before);
  const cfgNow = stageCfgOf(module, { ...before, stageConfig: afterConfig });
  // An order the save writes is validated WHOLE, as sent, before anything reads it (the empty order is a refusal, never a
  // row the loader would then refuse to read).
  if (table !== null) {
    if (arms.tiebreakers !== undefined && arms.tiebreakers !== null) {
      const refusals = cascadeRefusals(module, cfgNow, table, arms.tiebreakers);
      if (refusals.length > 0) throw tiebreakRefusal(refusals);
    }
    if (arms.crossGroupTiebreakers !== undefined && arms.crossGroupTiebreakers !== null) {
      const refusals = cascadeRefusals(module, cfgNow, table, arms.crossGroupTiebreakers, true);
      if (refusals.length > 0) throw tiebreakRefusal(refusals, { field: "crossGroupTiebreakers" });
    }
  }
  // The rules as they stand, or null where they do not read (then nothing the save leaves is excused as already there),
  // and as the save leaves them.
  const was = readable(() => tableRulesOf(before, module));
  const now = rulesAfter(module, before, afterConfig, arms);
  if (table !== null) {
    // What the stage reads where the save did not write it — an order it now inherits (a clear), or one the rules arm moved
    // the cfg under (football `fairPlay`) — is refused for a refusal the save ADDS.
    if (arms.tiebreakers === undefined || arms.tiebreakers === null) {
      const order = cascadeRefusals(module, cfgNow, table, now.tiebreakers);
      const fresh = was === null ? order : added(order, cascadeRefusals(module, cfgWas, table, was.tiebreakers));
      if (fresh.length > 0) throw tiebreakRefusal(fresh, now.sources.tiebreakers === "stage" ? {} : { inherited: now.sources.tiebreakers }, { inherited: now.sources.tiebreakers !== "stage" });
    }
    // The cross-group order the stage names itself (an order derived from its order drops every step rule 4 refuses).
    if (now.sources.crossGroup === "stage" && (arms.crossGroupTiebreakers === undefined || arms.crossGroupTiebreakers === null)) {
      const cross = cascadeRefusals(module, cfgNow, table, now.crossGroup, true);
      const fresh =
        was === null || was.sources.crossGroup !== "stage" ? cross : added(cross, cascadeRefusals(module, cfgWas, table, was.crossGroup, true));
      if (fresh.length > 0) throw tiebreakRefusal(fresh, { field: "crossGroupTiebreakers" });
    }
  }
  const pointsWhole = arms.points !== undefined && arms.points !== null;
  refuseUnpaid(
    module,
    { rule: now.points, cfg: cfgNow, kind: before.kind },
    pointsWhole || was === null ? null : { rule: was.points, cfg: cfgWas, kind: before.kind },
  );
  if (arms.points !== undefined && arms.points !== null) refuseFlatOverSplit(module, arms.points, cfgNow, before.kind);
}

/**
 * A NEW stage (`createStages`, `replaceStages`, template apply; spec §5.5): the order it will read — its own if the door
 * carries one, else the division's, else the sport's — validated on its kind. An inherited order the kind refuses says
 * so: the organiser sets the stage's own order (`extra.inherited` names the layer). Its points must pay every outcome its
 * rules reach: a rule it carries, whole; otherwise what its rules add over the division's format (W2c's question, asked
 * only when a create moved `bestOf`, is the case this generalises).
 */
export function refuseNewStageTable(
  module: AnySportModule,
  stage: { kind: string; name: string; config: Record<string, unknown> },
  division: { config: unknown; tiebreakers: readonly string[] | null },
): void {
  const row: TableRulesRow = {
    stageId: `new:${stage.name}`,
    kind: stage.kind,
    status: "pending",
    stageConfig: stage.config,
    pin: null,
    pinnedAt: null,
    divisionConfig: division.config,
    divisionTiebreakers: division.tiebreakers,
  };
  const cfg = stageCfgOf(module, row);
  const kind = stageKindOf(stage.kind);
  // An order the door carries is validated as sent, first (the empty one is a refusal, never a row the loader refuses).
  for (const field of ["tiebreakers", "crossGroupTiebreakers"] as const) {
    const own = stage.config[field];
    if (!Array.isArray(own)) continue;
    if (kind === null || !isTableKind(kind)) {
      throw new HttpError(
        RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
        ruleErrorMessage("RULE_NOT_SETTABLE", { field, reason: "a bracket stage has no table to rank", stage: stage.name }),
        "RULE_NOT_SETTABLE",
        { field, stage_name: stage.name },
      );
    }
    const refusals = cascadeRefusals(module, cfg, kind, own as TiebreakerKey[], field === "crossGroupTiebreakers");
    if (refusals.length > 0) throw tiebreakRefusal(refusals, { stage_name: stage.name, stage_kind: stage.kind, field }, { stage: stage.name });
  }
  const rules = tableRulesOf(row, module);
  if (kind !== null && isTableKind(kind)) {
    const refusals = cascadeRefusals(module, cfg, kind, rules.tiebreakers);
    if (refusals.length > 0) {
      const inherited = rules.sources.tiebreakers !== "stage";
      throw tiebreakRefusal(
        refusals,
        { stage_name: stage.name, stage_kind: stage.kind, ...(inherited ? { inherited: rules.sources.tiebreakers } : {}) },
        inherited ? { inherited } : { stage: stage.name },
      );
    }
    if (rules.sources.crossGroup === "stage") {
      const cross = cascadeRefusals(module, cfg, kind, rules.crossGroup, true);
      if (cross.length > 0) throw tiebreakRefusal(cross, { stage_name: stage.name, stage_kind: stage.kind, field: "crossGroupTiebreakers" }, { stage: stage.name });
    }
  }
  const own = stage.config.points !== undefined && stage.config.points !== null;
  const bare = tableRulesOf({ ...row, stageConfig: {} }, module);
  refuseUnpaid(
    module,
    { rule: rules.points, cfg, kind: stage.kind },
    own ? null : { rule: bare.points, cfg: stageCfgOf(module, { ...row, stageConfig: {} }), kind: stage.kind },
    { stage_name: stage.name, stage_kind: stage.kind },
  );
  if (own && rules.sources.points === "stage") {
    refuseFlatOverSplit(module, rules.points, cfg, stage.kind, { stage_name: stage.name, stage_kind: stage.kind }, stage.name);
  }
}

/** One stage of a division save, as `tableRulesRowsOf` reads it. */
export interface DivisionStageRow {
  readonly row: TableRulesRow;
  readonly name: string;
}

/** A pinned stage that keeps its rules while a division save moves what its live layers would give (spec §5.4). */
export interface KeptPinned {
  stageId: string;
  name: string;
}

/**
 * A division create or save (spec §5.4, §5.5): the order and config it leaves (`next`) against every stage of the
 * division as it stands (`stages`, board order).
 *  - A new order (`orderSaved`, non-null) is asked against the sport first (`refuseCascadeForSport`).
 *  - Every UNPINNED table stage then reads the order and config the save leaves: an inheriting stage is asked the new
 *    division order whole on its own kind; anything else the save moves (a config flipping football `fairPlay` under an
 *    order that ranks on it, FB-TB-4; a cleared default) is refused for a refusal it adds. A refusal names the stage and
 *    its kind. A pinned stage is never asked: the save does not reach it.
 *  - Every stage's points must still pay what its matches can reach under the new config: refused for an outcome the save
 *    leaves newly unpaid (a pinned stage keeps its rule while the division's format moves under it).
 * Returns the pinned stages whose live layers the save moved (`stagesKeptPinned`), in board order — the ones this save
 * pinned first (`startedStagesToPin`, fix round 1 I1) among them, since their live layers are what reached them.
 */
export function refuseDivisionTableSave(
  module: AnySportModule,
  stages: readonly DivisionStageRow[],
  next: { config: unknown; tiebreakers: readonly TiebreakerKey[] | null; orderSaved: boolean },
): KeptPinned[] {
  if (next.orderSaved && next.tiebreakers !== null) refuseCascadeForSport(module, next.config, next.tiebreakers);
  const kept: KeptPinned[] = [];
  for (const { row, name } of stages) {
    const after: TableRulesRow = { ...row, divisionConfig: next.config, divisionTiebreakers: next.tiebreakers };
    // A stage whose rules do not read (a started stage never pinned, a pin or own value that does not parse) is not asked:
    // the read path refuses it by name, typed, and this save cannot make it read (never stricter than the fold).
    const was = readable(() => tableRulesOf(row, module));
    const now = readable(() => tableRulesOf(after, module));
    if (was === null || now === null) continue;
    const pinned = row.pin !== null && row.pin !== undefined;
    const extra = { stage_id: row.stageId, stage_name: name, stage_kind: row.kind };
    const cfgWas = stageCfgOf(module, row);
    const cfgNow = stageCfgOf(module, after);
    const kind = stageKindOf(row.kind);
    if (!pinned && kind !== null && isTableKind(kind)) {
      const order = cascadeRefusals(module, cfgNow, kind, now.tiebreakers);
      const whole = next.orderSaved && next.tiebreakers !== null && now.sources.tiebreakers === "division";
      const fresh = whole ? order : added(order, cascadeRefusals(module, cfgWas, kind, was.tiebreakers));
      if (fresh.length > 0) throw tiebreakRefusal(fresh, extra, { stage: name });
      if (now.sources.crossGroup === "stage") {
        const cross = added(cascadeRefusals(module, cfgNow, kind, now.crossGroup, true), cascadeRefusals(module, cfgWas, kind, was.crossGroup, true));
        if (cross.length > 0) throw tiebreakRefusal(cross, { ...extra, field: "crossGroupTiebreakers" }, { stage: name });
      }
    }
    refuseUnpaid(module, { rule: now.points, cfg: cfgNow, kind: row.kind }, { rule: was.points, cfg: cfgWas, kind: row.kind }, extra, name);
    if (pinned && liveMoved(module, row, after)) kept.push({ stageId: row.stageId, name });
  }
  return kept;
}

/**
 * W2d Task 10 fix round 1 (I1; spec §5.4 "active or complete ⇒ pinned", D9): the STARTED stages a division save would
 * reach while they still have no pin, to be pinned with their CURRENT rules before the save lands. A stage starts without
 * being activated when an ad-hoc match (`addFixture`) on a pending league, group or Swiss stage takes its first event (or
 * a round of it opens): it stays `pending`, so neither generate nor completion has pinned it, and a division order or
 * points edit would otherwise move the table under a played match (class 6: silently re-ranked).
 *
 * `started` is the lock's own answer (`lockedStageIdsAmong`) for the division's UNPINNED stages (a pinned stage's pin
 * answers; `pinStageTableRules` writes nothing over one). A started stage is reached when the points or the order it
 * reads live move (`liveMoved`, the question `stagesKeptPinned` asks of a pinned stage) — never when its rules do not read
 * today (the read path refuses it by name, typed, and this save cannot make it read). Only a `pending` stage: an active or
 * complete stage with no pin is a pre-W2d row, `scripts/w2d/post-deploy-pin.ts`'s to pin AFTER it converts the row's
 * config and rule (a pin taken here would carry the unconverted split), and the lock still refuses the points that would
 * reach it (`divisionRefusals`). A bracket stage takes no ad-hoc match
 * (`addFixture`) and is pinned when it is seeded. A `fairPlay` flip never reaches a started stage: it is match format,
 * refused by the lock while a started stage inherits it (`divisionRefusals`). Empty case first: none started pins nothing.
 */
export function startedStagesToPin(
  module: AnySportModule,
  stages: readonly DivisionStageRow[],
  started: ReadonlySet<string>,
  next: { config: unknown; tiebreakers: readonly TiebreakerKey[] | null },
): DivisionStageRow[] {
  if (started.size === 0) return [];
  return stages.filter(
    ({ row }) =>
      row.status === "pending" &&
      started.has(row.stageId) &&
      liveMoved(module, row, { ...row, divisionConfig: next.config, divisionTiebreakers: next.tiebreakers }),
  );
}

/** `read()`, or null where the engine refuses to read the rows (a typed EngineError); anything else is a defect. */
function readable<T>(read: () => T): T | null {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof EngineError) return null;
    throw cause;
  }
}

/** Whether the live layers of a pinned stage (what it would read were it pending) differ between two rows. A stage whose
 *  live layers do not read (a cfg its sport cannot read) is not listed: the list says what was kept, never a guess. */
function liveMoved(module: AnySportModule, before: TableRulesRow, after: TableRulesRow): boolean {
  const live = (row: TableRulesRow) => readable(() => tableRulesOf({ ...row, status: "pending", pin: null, pinnedAt: null }, module));
  const a = live(before);
  const b = live(after);
  if (a === null || b === null) return false;
  return JSON.stringify([a.points, a.tiebreakers]) !== JSON.stringify([b.points, b.tiebreakers]);
}

/**
 * A match's own format (`writeFixtureRulesOverride`, spec §5.4 "Fixture override coverage"): the fixture's merged format
 * against the stage's effective rule (its pin once active, as the loader reads it). Refused for an outcome the override
 * makes reachable that the rule does not pay; an override that only removes outcomes (football extra time off) is always
 * covered. A stage whose rules do not read is not asked (its table refuses by name on read).
 */
export function refuseOverrideUncovered(
  module: AnySportModule,
  stage: TableRulesRow,
  fixtureCfg: unknown,
  extra: Record<string, unknown>,
): void {
  const rules = readable(() => tableRulesOf(stage, module));
  if (rules === null) return;
  const stageCfg = stageCfgOf(module, stage);
  refuseUnpaid(module, { rule: rules.points, cfg: fixtureCfg, kind: stage.kind }, { rule: rules.points, cfg: stageCfg, kind: stage.kind }, extra);
}

/**
 * W2d Task 8 carry 2 — a set-score table (`pointsMap`) is keyed by set score ("W-L") or "*" (`SET_SCORE_KEY`). A key that
 * is neither is never paid (`tablePointsRule` skips it), yet the bounds would read its value: refused at WRITE, by name, as
 * CONFIG_INVALID; reads stay tolerant of a map already stored. A table that prices no set score at all pays nothing and is
 * refused too. Cause, not state: a save that keeps a stray key already stored is not refused for it (`current`).
 */
export function refuseStrayPointsMapKeys(next: unknown, current?: unknown): void {
  const map = isObj(next) ? next.pointsMap : undefined;
  if (!isObj(map)) return;
  const before = isObj(current) && isObj(current.pointsMap) ? current.pointsMap : {};
  const stray = Object.keys(map).filter((k) => !SET_SCORE_KEY.test(k) && !Object.hasOwn(before, k));
  if (stray.length > 0) {
    throw new EngineError("CONFIG_INVALID", `the points table's ${stray.map((k) => `"${k}"`).join(", ")} is not a set score ("W-L" or "*")`, {
      issues: stray.map((k) => ({ code: "custom", path: ["pointsMap", k], message: `"${k}" is not a set score ("W-L" or "*")` })),
    });
  }
  const priced = Object.keys(map).some((k) => SET_SCORE_KEY.test(k));
  const pricedBefore = current === undefined || Object.keys(before).length === 0 || Object.keys(before).some((k) => SET_SCORE_KEY.test(k));
  if (!priced && pricedBefore) {
    throw new EngineError("CONFIG_INVALID", "the points table prices no set score", {
      issues: [{ code: "custom", path: ["pointsMap"], message: "the points table prices no set score" }],
    });
  }
}
