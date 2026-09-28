// Applicability over (row, sport, variant) — design §4. Each atomic case has a
// predicate over one cell's FACTS (the row's real stage bodies, the sport's
// resolved cfg, its entrant kinds, the row's format gate) and the reason a
// cell is dropped. A predicate that reads the cfg binds to the first committed,
// SCORABLE variant case that satisfies it before it drops anything. Trap 1's
// guards live in applicability.test.ts. Pure and deterministic (R11).
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { StageKind } from "@seazn/engine/core";
import { STAGE_RULES_SPORTS, showsOnePointsField } from "../../../apps/web/src/lib/match-rules.ts";
import { ROW_KEYS, SPORT_KEYS, cellId, stagesForRow, type RowKey } from "./catalogue.ts";
import { expectedGate, type FormatGate } from "./format-gates-copy.ts";
import { ATOMIC, LIFECYCLE_ID, l3Atomic } from "./scenario-catalogue.ts";
import { drawsAllowed, entrantKindsFor, resolveSportCfg, sportModule } from "./sport-cfg.ts";
import { buildVariant, offlineBuilderDefault, type SportVariants } from "./variants.ts";

export interface StageFact { readonly kind: string; readonly config: Readonly<Record<string, unknown>>; readonly takes: readonly string[] }
export interface CellFacts {
  readonly row: RowKey;
  readonly sport: string;
  readonly preset: string;
  readonly cfg: Readonly<Record<string, unknown>>;
  readonly stages: readonly StageFact[];
  readonly entrantKinds: readonly string[];
  readonly gate: FormatGate | null;
}

export class WitnessValuesInvalid extends Error {
  readonly sport: string;
  readonly preset: string;
  constructor(sport: string, preset: string, reason: string) {
    super(`applicability: witness values invalid for ${sport}/${preset}: ${reason}`);
    this.name = "WitnessValuesInvalid";
    this.sport = sport;
    this.preset = preset;
  }
}

const stageFactsMemo = new Map<string, readonly StageFact[]>();
function stageFacts(row: RowKey): readonly StageFact[] {
  let out = stageFactsMemo.get(row);
  if (out === undefined) {
    out = Object.freeze(stagesForRow(row).map((s): StageFact => Object.freeze({
      kind: s.kind,
      config: s.config,
      takes: Object.freeze((s.progression?.sources ?? []).flatMap((x) => x.take.map((t) => t.kind))),
    })));
    stageFactsMemo.set(row, out);
  }
  return out;
}

// A cell's facts are a pure function of (row, sport, preset, overrides): the
// zod parse behind the cfg is memoised on the JSON of the overrides, which is
// how they cross the wire (variants.ts buildVariant).
const factsMemo = new Map<string, CellFacts>();
export function cellFacts(row: RowKey, sport: string, preset: string = offlineBuilderDefault(sport), overrides: Readonly<Record<string, unknown>> = {}, values?: Readonly<Record<string, string>>): CellFacts {
  let o: Readonly<Record<string, unknown>> = overrides;
  if (values !== undefined) {
    const b = buildVariant(sport, preset, { ...values });
    if (!b.ok) throw new WitnessValuesInvalid(sport, preset, b.reason);
    o = b.overrides;
  }
  const key = `${row}|${sport}|${preset}|${JSON.stringify(o)}`;
  let f = factsMemo.get(key);
  if (f === undefined) {
    const cfg = resolveSportCfg(sport, preset, { ...o }) as Record<string, unknown>;
    const stages = stageFacts(row);
    f = Object.freeze({ row, sport, preset, cfg, stages, entrantKinds: Object.freeze(entrantKindsFor(sport, cfg)), gate: expectedGate(stages) });
    factsMemo.set(key, f);
  }
  return f;
}

// --- combinators -------------------------------------------------------------
export type Predicate = (f: CellFacts) => boolean;
const always: Predicate = () => true;
const and = (...ps: Predicate[]): Predicate => (f) => ps.every((p) => p(f));
const or = (...ps: Predicate[]): Predicate => (f) => ps.some((p) => p(f));
const not = (p: Predicate): Predicate => (f) => !p(f);
const hasKind = (...kinds: readonly string[]): Predicate => (f) => f.stages.some((s) => kinds.includes(s.kind));
const multiStage: Predicate = (f) => f.stages.length > 1;
const entrant = (...kinds: string[]): Predicate => (f) => f.entrantKinds.some((k) => kinds.includes(k));

/** Text-pinned copy of the product's points-table kinds
 *  (apps/web/src/server/engine-db/competition.ts `TABLE_KINDS`, server-only):
 *  americano rides the league fold. Ladder is NOT one — its order is
 *  `config.ladder_order` (engine core/types.ts StageKind note), so nothing in
 *  a ladder can tie or lose points. Pinned by applicability.test.ts. */
export const TABLE_KINDS: readonly string[] = Object.freeze(["league", "group", "swiss", "americano"]);
const table = hasKind(...TABLE_KINDS);
/** A finishing ORDER exists: a points table, or a ladder's positions. */
const ranked = hasKind(...TABLE_KINDS, "ladder");
/** The engine's own bracket-shaped kinds (competition/progression.ts). */
const bracket = hasKind(...BRACKET_STAGE_KINDS);
/** Some later stage takes its entrants from a points-table stage before it. */
const tableFed: Predicate = (f) => f.stages.some((s, i) => i > 0 && s.takes.length > 0 && TABLE_KINDS.includes(f.stages[i - 1]?.kind ?? ""));
const plate: Predicate = (f) => f.stages.some((s) => s.takes.includes("roundLosers"));
const thirdPlace: Predicate = (f) => f.stages.some((s) => s.kind === "knockout" && s.config.thirdPlace === true);
const losersContinue = or(hasKind(...TABLE_KINDS, "ladder", "double_elim", "page_playoff"), plate);
const ALL_KINDS: readonly string[] = StageKind.options;
const drawIn = (f: CellFacts, kind: string): boolean => drawsAllowed(f.sport, f.cfg, kind as StageKind);
/** M5: some stage of the row refuses a level result, and the sport CAN end level somewhere under this cfg. */
const levelRefusedHere: Predicate = (f) => f.stages.some((s) => !drawIn(f, s.kind)) && ALL_KINDS.some((k) => drawIn(f, k));
/** Scoreless: generic's win_loss mode records a winner only (match-rules.ts resultMode options). */
const scoreless: Predicate = (f) => f.sport === "generic" && f.cfg.resultMode === "win_loss";
/** The product's own condition for the Bo1 points editor (match-rules.ts showsOnePointsField). */
const bestOfOneEditor: Predicate = (f) => showsOnePointsField(f.sport, {}, { ...f.cfg });

/** A decider switched on in the resolved cfg. The keys each reads are
 *  recorded by a Proxy and pinned against each sport's committed
 *  <sport>.schema.json (applicability.test.ts). boardgame has none: KO chess
 *  ties resolve at the fixture layer (boardgame.ts:767-769) — false premise 9,
 *  routed to W4. */
export const DECIDERS: Readonly<Record<string, (cfg: Readonly<Record<string, unknown>>) => boolean>> = Object.freeze({
  football: (c) => (c.extraTime as { enabled?: unknown } | undefined)?.enabled === true || c.shootout === true,
  cricket: (c) => c.superOver === true,
  icehockey: (c) => c.overtime != null || c.shootout != null,
  hockey: (c) => c.overtime != null || c.shootout != null,
  carrom: (c) => c.tieBoard === "extra",
});
const decider: Predicate = (f) => DECIDERS[f.sport]?.(f.cfg) ?? false;

/** Ruling 30, M4b: the cfg lets an abandon YIELD A RESULT (engine applyAbandon).
 *  football/hockey/icehockey only under abandonPolicy "award" (football.ts:1657,
 *  period/kernel.ts:1450; every schema defaults to "replay"). Cricket when DLS
 *  is on (a chase past minOversForResult, cricket.ts:1152-1161) or at two
 *  innings a side (a draw, cricket.ts:1143). Every other sport's abandon
 *  replays (null) or records no_result. Keys recorded and pinned against each
 *  schema.json; each arm witnessed, and every committed variant checked, by a
 *  real fold (applicability.test.ts). */
export const ABANDON_RESULTS: Readonly<Record<string, (cfg: Readonly<Record<string, unknown>>) => boolean>> = Object.freeze({
  football: (c) => c.abandonPolicy === "award",
  hockey: (c) => c.abandonPolicy === "award",
  icehockey: (c) => c.abandonPolicy === "award",
  cricket: (c) => (c.dls as { enabled?: unknown } | undefined)?.enabled === true || c.inningsPerSide === 2,
});
const abandonWithResult: Predicate = (f) => ABANDON_RESULTS[f.sport]?.(f.cfg) ?? false;
/** Ruling 30, M12c: read from the module's own event declarations
 *  (module.ts `eventSchemas`), not a typed sport list. */
const declaresEvent = (type: string): Predicate => (f) => Object.hasOwn(sportModule(f.sport).eventSchemas ?? {}, type);

// --- rules -------------------------------------------------------------------
export interface WitnessCell { readonly cell: string; readonly preset?: string; readonly values?: Readonly<Record<string, string>> }
export interface Witness {
  readonly keep: WitnessCell;
  /** One more keep witness per further ARM of a disjunctive predicate (a stage
   *  kind, the plate, the ladder): with one keep witness, deleting any other
   *  arm stays green. Found by mutation (task-6 report). */
  readonly alsoKeep: readonly WitnessCell[];
  readonly drop: WitnessCell;
}
export interface Rule {
  readonly when: Predicate;
  /** The drop reason; "" for a rule that never drops. */
  readonly reason: string;
  /** Reads the cfg: bind to a committed variant before dropping. A rule NOT
   *  marked so answers the same under every committed variant (guarded by
   *  applicability.test.ts). */
  readonly variantDependent: boolean;
  readonly witness: Witness | null;
}
const ALWAYS: Rule = Object.freeze({ when: always, reason: "", variantDependent: false, witness: null });
type W = string | WitnessCell;
const cellOf = (w: W): WitnessCell => (typeof w === "string" ? { cell: w } : w);
/** `keep` may list several cells: the first is THE keep witness, the rest are
 *  one per further arm of the predicate. */
const rule = (when: Predicate, reason: string, keep: W | readonly [W, ...W[]], drop: W, variantDependent = false): Rule => {
  const [first, ...rest]: readonly [W, ...W[]] = typeof keep === "string" || !Array.isArray(keep) ? [keep as W] : (keep as readonly [W, ...W[]]);
  return Object.freeze({ when, reason, variantDependent, witness: Object.freeze({ keep: cellOf(first), alsoKeep: Object.freeze(rest.map(cellOf)), drop: cellOf(drop) }) });
};

const T = "league|generic";
const KO = "knockout|generic";
const LADDER = "ladder|generic";
const NO_TEAM = "no team entrants in this sport's model";
const NO_PAIR = "no pair entrants in this sport's model";
const NO_TABLE = "no points-table stage in this row (brackets place by elimination; a ladder orders by position)";

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  [LIFECYCLE_ID]: ALWAYS,
  R1: ALWAYS, R2: ALWAYS, R3: ALWAYS, R4a: ALWAYS,
  R4b: rule(hasKind("league", "group"), "only a league or group stage expunges an early withdrawal (engine withdrawTableEntrant: Swiss always walks over; no bracket stage has a threshold), so 'half or more played' is not a distinct input here — R4a covers the withdrawal", [T, "group_only|generic"], "swiss|generic"),
  R4c: ALWAYS, R5: ALWAYS,
  R6: rule(multiStage, "single-stage row: there is no later stage (bracket or playoff) to be drawn into; a withdrawal between rounds of one stage is R4a's input", "league_ko|generic", KO),
  R7: ALWAYS, R8: ALWAYS,
  // Drop witness is boardgame, NOT T: generic has no entrantModel, so
  // effectiveEntrantModel gives it every kind and R9a applies there (R-PF4;
  // boardgame is individual-only under all three presets, checked offline).
  R9a: rule(entrant("pair", "team"), "the sport's entrant model allows neither pairs nor teams: nothing to rename as a pair/team", ["league|football", "league|badminton"], "league|boardgame"),
  R9b: rule(entrant("team"), `${NO_TEAM}: there is no lineup to change`, "league|football", "league|badminton"),
  R10: ALWAYS,
  R11a: ALWAYS,
  R11b: rule(entrant("pair"), `${NO_PAIR}: nobody can be in two partnerships`, "league|badminton", "league|football"),
  R12a: rule(entrant("pair"), `${NO_PAIR}: there is no doubles partner`, "league|badminton", "league|football"),
  R12b: rule(entrant("pair"), `${NO_PAIR}: there is no pair to dissolve`, "league|badminton", "league|football"),
  R13: ALWAYS,
  R14: rule(losersContinue, "every stage is single-loss elimination: a retirement ends the entrant's event", [T, "ko_plate|generic", "double_elim|generic", "page_playoff_only|generic", LADDER], KO),
  R15: rule(hasKind("swiss", "americano"), "no round-paired stage (swiss, americano/mexicano): a league's fixtures all exist from Generate and a bracket pairs only its winners, so nobody is 'still paired next round' after their last match", ["swiss|generic", "americano|generic"], T),
  R16: rule(entrant("team"), `${NO_TEAM}: no team lineup to substitute into`, "league|football", "league|badminton"),
  M1: ALWAYS, M2: ALWAYS, M3: ALWAYS,
  // Ruling 30. M4a: every sport can abandon with no result at its builder
  // default (replay → null, or no_result below cricket's minimum overs) —
  // a guard in applicability.test.ts folds it for every sport.
  M4a: ALWAYS,
  M4b: rule(abandonWithResult, "no organiser-reachable config lets an abandon yield a result here: football/hockey/icehockey need abandonPolicy \"award\", which no editor field sets (configKeysFor; false premise 10); cricket needs DLS on or two innings a side; every other sport's abandon replays or records no result (ABANDON_RESULTS)", { cell: "league|cricket", values: { dls: "on" } }, "league|badminton", true),
  M5: rule(levelRefusedHere, "either every stage of the row accepts a level result, or the sport never ends level under this config (supportsDraws)", "knockout|football", "knockout|badminton", true),
  M6: rule(decider, "the sport declares no tie decider (DECIDERS: it never finishes level, or — boardgame — KO ties resolve at the fixture layer, false premise 9, W4), or none is switched on under this config", "knockout|icehockey", "knockout|badminton", true),
  M7a: ALWAYS, M7b: ALWAYS,
  M8a: rule(not(scoreless), "generic win_loss records a winner only: there is no score to correct while keeping the winner", T, { cell: T, preset: "win_loss" }, true),
  M8b: ALWAYS, M9a: ALWAYS, M9b: ALWAYS, M10: ALWAYS, M11: ALWAYS,
  // Ruling 30. M12a/M12b follow R16's rule (team entrants). M12c is cricket's retired hurt.
  M12a: rule(entrant("team"), `${NO_TEAM}: no substitute can come on for an injured player`, "league|football", "league|badminton"),
  M12b: rule(entrant("team"), `${NO_TEAM}: there is no team to play short`, "league|football", "league|badminton"),
  M12c: rule(declaresEvent("cricket.retire"), "the sport declares no retired-hurt event (module eventSchemas has no cricket.retire; ruling 30: cricket only)", "league|cricket", "league|football"),
  F1: ALWAYS, F2: ALWAYS,
  F3: rule(hasKind("knockout", "double_elim"), "no knockout or double-elimination bracket in this row: nothing to size to a power of two", [KO, "double_elim|generic"], T),
  F4: rule(hasKind("group"), "no pooled (group) stage in this row", "groups_ko|generic", T),
  F5a: rule(table, `${NO_TABLE}: no points to tie on`, T, LADDER),
  F5b: rule(table, `${NO_TABLE}: no points to tie on`, T, KO),
  F6: rule(table, `${NO_TABLE}: nobody can be level on points`, T, LADDER),
  F7: rule(table, `${NO_TABLE}: no points tiebreak can fall through to lots`, T, KO),
  F8: rule(hasKind(...BRACKET_STAGE_KINDS, "group", "swiss"), "no seeded placement in this row: everyone meets everyone, or pairing follows standings only", [KO, "group_only|generic", "swiss|generic"], T),
  D1: ALWAYS, D2: ALWAYS, D3: ALWAYS, D4a: ALWAYS, D4b: ALWAYS, D5a: ALWAYS, D5b: ALWAYS, D6: ALWAYS, D7: ALWAYS,
  P1: ALWAYS,
  P2: rule(tableFed, "no later stage fed by a points table: nothing qualifies from a table", "groups_ko|generic", "qualifying_main|generic"),
  P3: ALWAYS, P4: ALWAYS, P5a: ALWAYS,
  P5b: rule(hasKind("swiss"), "Pair next round (and its undo, /unpair) exists only for swiss stages", "swiss|generic", T),
  P6: rule((f) => STAGE_RULES_SPORTS.has(f.sport), "the sport has no per-stage rules (STAGE_RULES_SPORTS)", "knockout|badminton", "knockout|football"),
  P7: rule(ranked, "bracket-only row: there is no rank table to override", T, KO),
  Q1a: rule(tableFed, "no later stage fed by a points table: no qualifier is decided by lots", "groups_ko|generic", "ko_plate|generic"),
  Q1b: rule(tableFed, "no later stage fed by a points table: no qualifier is decided by the organiser", "groups_ko|generic", KO),
  Q2: rule(tableFed, "no later stage fed by a points table: nobody qualifies from a group or table", "groups_ko|generic", "qualifying_main|generic"),
  Q3: rule(thirdPlace, "no third-place match in this row (knockout config.thirdPlace)", "knockout_third_place|generic", KO),
  Q4a: rule(bracket, "no final in this row: league/swiss/rotation/ladder formats end on a table or order", KO, T),
  Q4b: rule(and(bracket, tableFed), "no table to fall back on: the final is not fed by a points-table stage", "league_ko|generic", "qualifying_main|generic"),
  Q5a: rule(plate, "no plate stage in this row", "ko_plate|generic", KO),
  Q5b: rule(plate, "no plate stage in this row", "ko_plate|generic", KO),
  X1a: ALWAYS, X1b: ALWAYS,
  X2: rule(ranked, "bracket-only row: a cut-short event has no table to take standings from", [T, LADDER], KO),
  X3: ALWAYS, X4a: ALWAYS, X4b: ALWAYS, X4c: ALWAYS,
  C1: rule(not(scoreless), "generic win_loss records a winner only: there are no scores to swap", T, { cell: T, preset: "win_loss" }, true),
  C2: ALWAYS, C3a: ALWAYS, C3b: ALWAYS,
  C4: rule(ranked, "bracket-only row: there is no table for retroactive forfeits to rewrite", [T, LADDER], KO),
  C5: rule(table, `${NO_TABLE}: no points to deduct`, T, LADDER),
  C6a: ALWAYS, C6b: ALWAYS, C7: ALWAYS,
  // Ruling 26 (O9): E stays its own scenarios.
  E1: ALWAYS, E2: ALWAYS,
  E3: rule(bestOfOneEditor, "not best of 1 under this config and no committed variant makes it best of 1 (showsOnePointsField)", { cell: "league|badminton", values: { bestOf: "1" } }, "league|badminton", true),
  E4a: ALWAYS, E4b: ALWAYS,
});

export interface Decision {
  readonly applies: boolean;
  readonly bound: string | null;
  readonly preset: string;
  /** Committed variants that enable the rule but the harness cannot score
   *  (VariantCase.scorable !== null): skipped, and named in the drop. */
  readonly unscorable: readonly string[];
}

/** Applies at the builder default, else (variant-dependent rules only) bound
 *  to the first committed variant case that satisfies it AND the harness can
 *  score, else dropped. */
export function decide(r: Rule, row: RowKey, sport: string, variants: readonly SportVariants[]): Decision {
  const def = offlineBuilderDefault(sport);
  if (r.when(cellFacts(row, sport, def))) return { applies: true, bound: null, preset: def, unscorable: [] };
  const unscorable: string[] = [];
  if (r.variantDependent) {
    for (const vc of variants.find((v) => v.sport === sport)?.cases ?? []) {
      if (!r.when(cellFacts(row, sport, vc.preset, vc.overrides))) continue;
      if (vc.scorable !== null) { unscorable.push(vc.id); continue; }
      return { applies: true, bound: vc.id, preset: vc.preset, unscorable };
    }
  }
  return { applies: false, bound: null, preset: def, unscorable };
}

export interface PlannedCase { readonly cell: string; readonly row: RowKey; readonly sport: string; readonly scenario: string; readonly preset: string; readonly bound: string | null }
export interface Drop { readonly cell: string; readonly row: RowKey; readonly sport: string; readonly scenario: string; readonly reason: string }

export class MissingRule extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`applicability: no rule for scenario '${id}'`);
    this.name = "MissingRule";
    this.id = id;
  }
}

export class UnknownScenario extends Error {
  readonly ids: readonly string[];
  constructor(ids: readonly string[]) {
    super(`applicability: 'only' names ids that are not L3 scenarios: ${ids.join(", ")} — a typo would plan nothing`);
    this.name = "UnknownScenario";
    this.ids = ids;
  }
}

const dropReason = (r: Rule, d: Decision): string => {
  if (!r.variantDependent) return r.reason;
  if (d.unscorable.length === 0) return `${r.reason} — no committed variant enables it`;
  const shown = d.unscorable.slice(0, 3).join(", ");
  return `${r.reason} — the committed variants that enable it (${d.unscorable.length}: ${shown}${d.unscorable.length > 3 ? ", …" : ""}) cannot be scored by the harness`;
};

export function planL3(input: { rules?: Readonly<Record<string, Rule>>; variants: readonly SportVariants[]; only?: readonly string[] }): { cases: PlannedCase[]; drops: Drop[] } {
  const rules = input.rules ?? RULES;
  const all = [LIFECYCLE_ID, ...l3Atomic().map((a) => a.id)];
  const only = input.only;
  if (only !== undefined) {
    const bad = only.filter((id) => !all.includes(id));
    if (bad.length > 0) throw new UnknownScenario(bad);
  }
  const ids = only === undefined ? all : all.filter((id) => only.includes(id));
  const cases: PlannedCase[] = [];
  const drops: Drop[] = [];
  for (const row of ROW_KEYS) for (const sport of SPORT_KEYS) {
    const cell = cellId(row, sport);
    for (const id of ids) {
      const r = rules[id];
      if (r === undefined) throw new MissingRule(id);
      const d = decide(r, row, sport, input.variants);
      if (d.applies) cases.push({ cell, row, sport, scenario: id, preset: d.preset, bound: d.bound });
      else drops.push({ cell, row, sport, scenario: id, reason: dropReason(r, d) });
    }
  }
  return { cases, drops };
}

export function rowCounts(cases: readonly PlannedCase[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of cases) m[c.row] = (m[c.row] ?? 0) + 1;
  return m;
}
export function scenarioCounts(cases: readonly { scenario: string }[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of cases) m[c.scenario] = (m[c.scenario] ?? 0) + 1;
  return m;
}

/** Every atomic id has a rule (guarded again by the test). */
for (const a of ATOMIC) if (!Object.hasOwn(RULES, a.id)) throw new MissingRule(a.id);
