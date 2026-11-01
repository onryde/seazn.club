// W2c Task 18 (S3, ST-G8) - the decisions the stage points section makes, as pure functions with unit killers
// (`__tests__/stage-points-model.test.ts`, `__tests__/stage-points-w2d-model.test.ts`). The section itself
// (`stage-points-section.tsx`) renders what these answer.
//
// Client-safe like `stage-row-model.ts`: no "use client", no JSX, no `@/server` import.
//
// W2d Task 16 (spec §9 "Points section, widened", §5.3, B2, D6, D10(a), X-PT-3): the section shows ONE ROW PER OUTCOME
// THE STAGE CAN REACH (`reachableOutcomes`, the engine's, over the stage's merged cfg) — overtime and shoot-out rows where
// the stage reaches them, the shoot-out row by `shootoutAs` (B2: "counts as a draw; the winner gets +soBonus"), a row per
// reachable set score where the rule pays a set table (D10(a)), a loss not played where the sport declares one (D6), a
// tie and a no result where the stage reaches them — and its draft SAYS EVERY SPLIT. That retires Task 10 fix round 1
// I2's "can't be set per stage yet" state (`pointsEditorFits`, deleted here): the boxes are no longer a flat rule, so a
// Save of the sport's own points pays every outcome as the sport does (the round-trip sweep in the w2d test), and the
// server's flat-over-split guard (POINTS_SPLIT_FLATTENED) is said INLINE before Save, with coverage's gaps
// (POINTS_OUTCOME_UNCOVERED), in the server's own words (`draftRefusal`).
//
// WHERE EVERY ANSWER COMES FROM. The section offers only what the server's PUT accepts, and the server's questions are
// the engine's: `reachableOutcomes` (the rows), `coverage` (which row is uncovered), `flattenedSplits` (lib, the server's
// own N2 guard), `tablePresets` (the preset chips), `pointsRuleAwardReachesTable` (batch-3 I3: which sports read a
// walkover SCORE), `validatePointsRule` (which bonus kinds the sport's metrics can feed), `DRAW_KINDS` (which stages have
// a table). The draft a stage opens with is the rule it PLAYS: its own, its pin's (I1), else the sport's own rule for the
// stage (`tablePointsRule` under the merged cfg — what `resolveTableRules` falls back to: a stage's points layer is
// "stage" or "sport", never the division's cfg read by hand, which opened a volleyball indoor editor blank: its two-pair
// `pointsMap` has no one win and loss). The web keeps no list of sports, kinds, outcomes or metrics.
import {
  PointsRule,
  coverage,
  parseStoredPointsRule,
  pointsRuleAwardReachesTable,
  reachableOutcomes,
  validatePointsRule,
  type OutcomeKey,
} from "@seazn/engine/competition";
import { DRAW_KINDS, type StageKind } from "@seazn/engine/core";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import { pointsLine, type PointsClause } from "@/lib/points-line";
import type { SplitReason } from "@/lib/rule-errors";
import { liveStageCfg } from "@/lib/stage-decider-off";
import { flattenedSplits, sportStageRule, splitsLost } from "@/lib/stage-points-splits";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// What the section offers.
// ---------------------------------------------------------------------------

/** Does this stage have a table its own points could rank? The server refuses a bracket kind (`refuseStagePoints`). */
export function stageTakesPoints(kind: string): boolean {
  return (DRAW_KINDS as ReadonlySet<string>).has(kind);
}

/** A stage as the section reads it: its kind and its own config (its `rules` move the outcomes it reaches). */
export interface StageShape {
  readonly kind: string;
  readonly config: unknown;
}

/** What the section asks of a stage: its merged cfg as the sport parses it, its kind, the outcomes it can reach (the
 *  engine's `reachableOutcomes`, in the engine's order) and the sport's own rule for it (`tablePointsRule`: what a stage
 *  with no rule of its own and no pin plays). Null — fail-closed, the section shows no editor — for a kind with no table
 *  and for a cfg the sport refuses (no rule to read, no outcome to ask). */
export interface StagePointsContext {
  readonly cfg: unknown;
  readonly kind: StageKind;
  readonly reachable: readonly OutcomeKey[];
  readonly rule: PointsRule;
}
export function stagePointsContext(module: AnySportModule, divisionConfig: unknown, stage: StageShape): StagePointsContext | null {
  const config = isObj(stage.config) ? stage.config : null;
  const sport = sportStageRule(module, liveStageCfg(divisionConfig, { kind: stage.kind, config }, module), stage.kind);
  if (sport === null) return null;
  return { cfg: sport.cfg, kind: sport.kind, reachable: [...reachableOutcomes(module, sport.cfg, sport.kind)], rule: sport.rule };
}

/** The division's config AS THE SPORT PARSES IT (defaults applied), else as stored: what the section reads the division's
 *  own points from. */
export function divisionPointsCfg(module: AnySportModule, divisionConfig: unknown): Record<string, unknown> {
  const raw = isObj(divisionConfig) ? divisionConfig : {};
  const parsed = module.configSchema.safeParse(raw);
  return (parsed.success ? parsed.data : raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The division's own base points (the bonus offer's "can this sport draw" question).
// ---------------------------------------------------------------------------

export interface DivisionBase {
  readonly win: number | null;
  /** Null when the sport cannot draw (a set sport's points table pays win and loss only). */
  readonly draw: number | null;
  readonly loss: number | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const firstFinite = (obj: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const k of keys) if (finite(obj[k])) return obj[k];
  return null;
};

/**
 * The division's win / draw / loss as the sport pays them: `points` under either spelling (generic writes w/d/l,
 * boardgame keeps `scoring`), else a set sport's `pointsMap` when it pays ONE pair. A part the sport has no word for is
 * null, never a made-up 0 or 3. W2d T16: no longer what the editor opens with (that is the rule the stage plays,
 * `draftFromStored`); it answers only whether the division can draw (`offeredBonusKinds`).
 */
export function divisionBasePoints(module: AnySportModule, divisionConfig: unknown): DivisionBase {
  const cfg = divisionPointsCfg(module, divisionConfig);
  const pts = isObj(cfg.points) ? cfg.points : isObj(cfg.scoring) ? cfg.scoring : {};
  let win = firstFinite(pts, ["win", "w"]);
  const draw = firstFinite(pts, ["draw", "d"]);
  let loss = firstFinite(pts, ["loss", "l"]);
  if (win === null && loss === null && isObj(cfg.pointsMap)) {
    const pairs = Object.values(cfg.pointsMap).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]));
    const distinct = new Set(pairs.map((p) => JSON.stringify(p)));
    if (distinct.size === 1) [win, loss] = pairs[0]!;
  }
  return { win, draw, loss };
}

// ---------------------------------------------------------------------------
// The rows (X-PT-3) and the presets (spec §5.10).
// ---------------------------------------------------------------------------

/** The display order of the outcome rows; set scores follow, by score. */
const ROW_ORDER: readonly OutcomeKey[] = [
  "win.regulation",
  "win.ot",
  "win.so",
  "loss.regulation",
  "loss.ot",
  "loss.so",
  "loss.unplayed",
  "draw",
  "tie",
  "noResult",
];
const SET_KEY = /^set:(\d+)-(\d+)$/;
const rank = (key: OutcomeKey): [number, number, number] => {
  const set = SET_KEY.exec(key);
  if (set !== null) return [ROW_ORDER.length, Number(set[1]), Number(set[2])];
  // An outcome key this app has no row for sorts last; `pointsRows` then refuses it by name (its one guard).
  const at = ROW_ORDER.indexOf(key);
  return [at === -1 ? ROW_ORDER.length + 1 : at, 0, 0];
};

/** One outcome row. Numbers are in the rule's STORED unit (half-points under `unit: "half"`; the draft shows points). */
export interface PointsRow {
  readonly key: OutcomeKey;
  /** What the row pays the winner (a level result: each side); null where the rule leaves it uncovered (`coverage`). */
  readonly value: number | null;
  /** A set score's pair, the winner's then the loser's; null for every other row, and where uncovered. */
  readonly pair: readonly [number, number] | null;
  /** Paid through a declared fallback, not a field of its own: an absent ot (→ regulation), so (→ ot → regulation),
   *  loss not played (→ the loss), no result (→ 0, D14), shoot-out bonus (→ 1, B2), a set score through "*", or a set
   *  score with no set table (the win and the loss). */
  readonly fallback: boolean;
  /** B2: a shoot-out booked as a draw — the winner's bonus on top of the draw (absent ⇒ 1); null otherwise. */
  readonly drawPlusBonus: number | null;
  /** On screen. Off for the loser's half of a draw-plus-bonus shoot-out (the win row says both), for a plain win or loss
   *  under a set table (never paid: the pair is the whole payout), and for a set score with no set table. */
  readonly shown: boolean;
}

const chain = (side: PointsRule["win"] | PointsRule["loss"], d: "regulation" | "ot" | "so"): { value: number; fallback: boolean } => {
  if (d === "so" && side.so !== undefined) return { value: side.so, fallback: false };
  if (d !== "regulation" && side.ot !== undefined) return { value: side.ot, fallback: d === "so" };
  return { value: side.regulation, fallback: d !== "regulation" };
};

/**
 * X-PT-3: exactly one row per reachable outcome, none other, in display order — each with what `rule` pays it and
 * whether the rule covers it (the engine's `coverage`: an absent draw or tie, a set score a two-pair map does not name, a
 * draw-plus-bonus shoot-out with no draw).
 */
export function pointsRows(reachable: readonly OutcomeKey[], rule: PointsRule): PointsRow[] {
  const cov = coverage(rule, new Set(reachable));
  const uncovered = new Set<OutcomeKey>(cov.ok ? [] : cov.uncovered);
  const map = rule.bySetScore;
  const dpb = rule.shootoutAs === "draw_plus_bonus";
  const rowOf = (key: OutcomeKey): PointsRow => {
    const plain = (value: number | null, fallback: boolean, shown = true): PointsRow => ({
      key,
      value: uncovered.has(key) ? null : value,
      pair: null,
      fallback,
      drawPlusBonus: null,
      shown,
    });
    const set = SET_KEY.exec(key);
    if (set !== null) {
      const score = key.slice("set:".length);
      if (map === undefined) return { key, value: rule.win.regulation, pair: [rule.win.regulation, rule.loss.regulation], fallback: true, drawPlusBonus: null, shown: false };
      const own = Object.hasOwn(map, score);
      const pair = own ? map[score]! : Object.hasOwn(map, "*") ? map["*"]! : null;
      const covered = pair !== null && !uncovered.has(key);
      return { key, value: covered ? pair[0] : null, pair: covered ? [pair[0], pair[1]] : null, fallback: !own, drawPlusBonus: null, shown: true };
    }
    const underMap = map !== undefined;
    switch (key) {
      case "win.so":
      case "loss.so":
        if (dpb) {
          // B2: one row, the draw each side is booked plus the winner's bonus; coverage names a missing draw as `draw`.
          const draw = uncovered.has("draw") || rule.draw === undefined ? null : rule.draw;
          return {
            key,
            value: draw,
            pair: null,
            fallback: rule.soBonus === undefined,
            drawPlusBonus: key === "win.so" ? (rule.soBonus ?? 1) : null,
            shown: key === "win.so" && !underMap,
          };
        }
      // falls through: a shoot-out booked as a result pays down the so → ot → regulation chain.
      case "win.regulation":
      case "win.ot":
      case "loss.regulation":
      case "loss.ot": {
        const [side, d] = key.split(".") as ["win" | "loss", "regulation" | "ot" | "so"];
        const paid = chain(rule[side], d);
        return plain(paid.value, paid.fallback, !underMap);
      }
      case "loss.unplayed":
        return rule.loss.unplayed === undefined ? plain(rule.loss.regulation, true) : plain(rule.loss.unplayed, false);
      case "draw":
      case "tie":
        return plain(rule[key] ?? null, false);
      case "noResult":
        return rule.noResult === undefined ? plain(0, true) : plain(rule.noResult, false);
    }
    // Assumptions are guards: an outcome key this app has no row for is refused by name, never dropped from the list.
    throw new Error(`stage points: no row for the outcome "${key}"`);
  };
  return [...reachable]
    .sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .map(rowOf);
}

/** Spec §5.10: the sport's named points for a table stage of `kind` (`tablePresets`: chess's 1/½/0 and, off Swiss, 3/1/0;
 *  hockey's Pro League), each parsed through the engine's schema. None for a kind with no table or a sport with none. */
export function pointsPresets(module: AnySportModule, kind: string): { id: string; rule: PointsRule }[] {
  if (!stageTakesPoints(kind) || module.tablePresets === undefined) return [];
  return module.tablePresets(kind as TableStageKind).points.map((p) => ({ id: p.id, rule: PointsRule.parse(p.rule) }));
}

// ---------------------------------------------------------------------------
// Bonus kinds.
// ---------------------------------------------------------------------------

/** Every bonus kind the engine's PointsRule takes (its own zod enum, never a list typed here). */
export type BonusWhen = PointsRule["bonuses"][number]["when"];
export const BONUS_KINDS: readonly BonusWhen[] = (
  PointsRule.shape.bonuses.unwrap().element as unknown as { shape: { when: { options: readonly BonusWhen[] } } }
).shape.when.options;

/** The kinds that read a threshold (`param`): the margin and ratio bonuses. Every other kind pays on the result alone. */
export const PARAM_BONUS_KINDS: ReadonlySet<BonusWhen> = new Set<BonusWhen>(["loss_margin_lte", "win_margin_gte", "score_ratio_gte"]);

/** A rule that pays nothing: what a bonus kind is asked against (`validatePointsRule` reads only its bonuses). */
const ZERO_RULE = { win: { regulation: 0 }, loss: { regulation: 0 }, draw: 0, tie: 0, noResult: 0, shootoutAs: "result", unit: "whole" } as const;

/**
 * The bonus kinds worth offering for this sport: those the server's `validatePointsRule` accepts for the sport's metrics (a
 * margin bonus needs the sport to emit for/against or a difference; the server answers CONFIG_INVALID otherwise), minus
 * the two that can never fire here - a draw bonus where the sport cannot draw, and a no-result bonus where the sport
 * records no no-results (cricket's `no_results` metric). A kind a stage ALREADY stores stays on screen whatever this
 * answers (see the section).
 */
export function offeredBonusKinds(module: AnySportModule, divisionConfig: unknown): BonusWhen[] {
  const hasDraw = divisionBasePoints(module, divisionConfig).draw !== null;
  const recordsNoResult = module.metrics.some((m) => m.key === "no_results");
  return BONUS_KINDS.filter((when) => {
    if (when === "draw" && !hasDraw) return false;
    if (when === "no_result" && !recordsNoResult) return false;
    try {
      validatePointsRule(PointsRule.parse({ ...ZERO_RULE, bonuses: [{ when, param: 0, points: 0 }] }), module.metrics);
      return true;
    } catch {
      return false;
    }
  });
}

/** Does the walkover SCORE reach this sport's table? Where it does not, the server REFUSES it (400 RULE_NOT_SETTABLE,
 *  `points.forfeit.awardScore`), so the section must not offer the input (batch-3 I3). */
export function offersWalkoverScore(module: AnySportModule): boolean {
  return pointsRuleAwardReachesTable(module);
}

// ---------------------------------------------------------------------------
// The draft the section edits, and the rule it becomes.
// ---------------------------------------------------------------------------

export interface BonusDraft {
  when: BonusWhen;
  /** The threshold, raw. Ignored (and not sent) for a kind that reads none. */
  param: string;
  points: string;
}

/** The section's boxes, raw. Every points box is in POINTS (a `unit: "half"` rule stores half-points: chess's 1 / ½ / 0 is
 *  2 / 1 / 0 stored and 1 / 0.5 / 0 here). A blank optional box is ABSENT from the rule: it pays its declared fallback
 *  (an overtime the regulation, a shoot-out the overtime, a loss not played the loss, a no result 0, a shoot-out bonus
 *  1), and a blank draw or tie covers none (`coverage` names it). */
export interface PointsDraft {
  /** True: the stage stores no points of its own and plays its pin's or the sport's (`points: null`). */
  useDivision: boolean;
  win: string;
  draw: string;
  loss: string;
  winOt: string;
  lossOt: string;
  /** A shoot-out booked as a result: each side's own pay. */
  winSo: string;
  lossSo: string;
  /** A shoot-out booked as a draw: the winner's bonus (B2). */
  soBonus: string;
  /** D6: a loss not played (table tennis's walkover loss). */
  lossUnplayed: string;
  tie: string;
  noResult: string;
  /** One row per reachable set score where the rule pays a set table: the winner's and the loser's points. Empty: no
   *  set table (the win and the loss pay every score). */
  sets: Record<string, [string, string]>;
  /** The source map paid its scores through "*" (the flat set table, D10(a)): a Save of one pair keeps that shape. */
  setsStar: boolean;
  shootoutAs: PointsRule["shootoutAs"];
  unit: PointsRule["unit"];
  /** The walkover row's points (`forfeit.winnerPoints` / `loserPoints`), both blank = no walkover row. */
  walkoverW: string;
  walkoverL: string;
  /** The walkover SCORE (`forfeit.awardScore`), both blank = no score recorded. Goals, never points: no unit. */
  awardW: string;
  awardL: string;
  bonuses: BonusDraft[];
}

/** The stored rule if it is one the engine's schema takes, else null (absent, `null`, or a hand-edited row). W2d: the
 *  outcome-keyed shape only (`parseStoredPointsRule`, PS-9f) — the W2d migration converted every W2c `{base, …}` row. */
export function storedPointsRule(stored: unknown): PointsRule | null {
  return parseStoredPointsRule(stored);
}

/**
 * W2d final review I1 (controller ruling, 2026-10-26) - the rule a stage PINNED at generate pays while it stores no rule of
 * its own: its pin's points (`stages.table_rules_pinned.points`, read by the page through the one loader). A division points
 * save after the pin lands but never reaches the stage (`rule-locks.ts`), so the live division is NOT what it plays. Null
 * when the stage stores its own rule (that rule is what it plays), when it is not pinned (it reads the live layers), and
 * for a pin the schema refuses (never half-read).
 */
export function pinInForce(stored: unknown, pinned: unknown): PointsRule | null {
  return storedPointsRule(stored) === null ? storedPointsRule(pinned) : null;
}

/** Whose points a stage plays: its own rule, its pin's (I1), else the live layers'. */
export type PointsBasis = "own" | "pin" | "division";
export function pointsBasis(stored: unknown, pinned: unknown): PointsBasis {
  if (storedPointsRule(stored) !== null) return "own";
  return pinInForce(stored, pinned) === null ? "division" : "pin";
}

/**
 * Match Day C3 (spec §12 item 12, "a stage that differs says so"): does this stage pay something other than what the division's
 * live layers would pay it? It plays its own rule, else its pin's (I1), else the live layers' (`pointsBasis`); it differs when
 * that is not the rule a stage with neither would play (`StagePointsContext.rule`, the sport's own for the stage). An own rule
 * that pays what the division pays does not differ. A kind with no table, and a cfg the sport refuses, say nothing.
 */
export function pointsDiffer(module: AnySportModule, divisionConfig: unknown, stage: StageShape, stored: unknown, pinned: unknown): boolean {
  if (!stageTakesPoints(stage.kind)) return false;
  const ctx = stagePointsContext(module, divisionConfig, stage);
  if (ctx === null) return false;
  const playing = storedPointsRule(stored) ?? pinInForce(stored, pinned) ?? ctx.rule;
  return canonical(playing) !== canonical(ctx.rule);
}

/** Points ↔ the rule's stored unit. */
const shownOf = (unit: PointsRule["unit"]) => (n: number): string => String(unit === "half" ? n / 2 : n);
const storedOf = (unit: PointsRule["unit"], n: number): number => (unit === "half" ? n * 2 : n);
const opt = (show: (n: number) => string, n: number | undefined): string => (n === undefined ? "" : show(n));

/** The boxes of a rule, a set row for each set score the stage reaches. */
function draftOfRule(rule: PointsRule, useDivision: boolean, reachable: readonly OutcomeKey[]): PointsDraft {
  const show = shownOf(rule.unit);
  const sets: Record<string, [string, string]> = {};
  const map = rule.bySetScore;
  if (map !== undefined) {
    for (const key of reachable) {
      const set = SET_KEY.exec(key);
      if (set === null) continue;
      const score = key.slice("set:".length);
      const pair = Object.hasOwn(map, score) ? map[score] : Object.hasOwn(map, "*") ? map["*"] : undefined;
      sets[score] = pair === undefined ? ["", ""] : [show(pair[0]), show(pair[1])];
    }
  }
  return {
    useDivision,
    win: show(rule.win.regulation),
    draw: opt(show, rule.draw),
    loss: show(rule.loss.regulation),
    winOt: opt(show, rule.win.ot),
    lossOt: opt(show, rule.loss.ot),
    winSo: opt(show, rule.win.so),
    lossSo: opt(show, rule.loss.so),
    soBonus: opt(show, rule.soBonus),
    lossUnplayed: opt(show, rule.loss.unplayed),
    tie: opt(show, rule.tie),
    noResult: opt(show, rule.noResult),
    sets,
    setsStar: map !== undefined && Object.hasOwn(map, "*"),
    shootoutAs: rule.shootoutAs,
    unit: rule.unit,
    walkoverW: rule.forfeit === undefined ? "" : show(rule.forfeit.winnerPoints),
    walkoverL: rule.forfeit === undefined ? "" : show(rule.forfeit.loserPoints),
    awardW: rule.forfeit?.awardScore === undefined ? "" : String(rule.forfeit.awardScore[0]),
    awardL: rule.forfeit?.awardScore === undefined ? "" : String(rule.forfeit.awardScore[1]),
    bonuses: rule.bonuses.map((b) => ({ when: b.when, param: b.param === undefined ? "" : String(b.param), points: show(b.points) })),
  };
}

/** The draft of an empty editor: a stage whose sport rule cannot be read (fail-closed; the section shows no inputs). */
const BLANK_DRAFT: PointsDraft = {
  useDivision: true,
  win: "",
  draw: "",
  loss: "",
  winOt: "",
  lossOt: "",
  winSo: "",
  lossSo: "",
  soBonus: "",
  lossUnplayed: "",
  tie: "",
  noResult: "",
  sets: {},
  setsStar: false,
  shootoutAs: "result",
  unit: "whole",
  walkoverW: "",
  walkoverL: "",
  awardW: "",
  awardL: "",
  bonuses: [],
};

/** The draft a stage opens with: the rule it PLAYS. Its own rule when it stores one; else, behind a checked "Use the
 *  division's points", its PIN's points once pinned (I1: `pinInForce`), else the sport's own rule for the stage (the
 *  points layer `resolveTableRules` falls back to). */
export function draftFromStored(module: AnySportModule, divisionConfig: unknown, stored: unknown, pinned: unknown, stage: StageShape): PointsDraft {
  const ctx = stagePointsContext(module, divisionConfig, stage);
  const reachable = ctx?.reachable ?? [];
  const own = storedPointsRule(stored);
  if (own !== null) return draftOfRule(own, false, reachable);
  const pin = storedPointsRule(pinned);
  if (pin !== null) return draftOfRule(pin, true, reachable);
  return ctx === null ? { ...BLANK_DRAFT, sets: {} } : draftOfRule(ctx.rule, true, reachable);
}

/** A preset chip's draft: the preset's rule as the boxes, the stage's own (no longer the division's). */
export function draftOfPreset(module: AnySportModule, divisionConfig: unknown, stage: StageShape, rule: PointsRule): PointsDraft {
  return draftOfRule(rule, false, stagePointsContext(module, divisionConfig, stage)?.reachable ?? []);
}

/** A number typed in a box: blank is NOT zero (`Number("")` is 0, which would store a rule nobody wrote). */
export function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type DraftProblem = "number" | "walkover" | "score" | "bonus" | "set";
export type RuleFromDraft = { ok: true; rule: PointsRule | null } | { ok: false; problem: DraftProblem };

/** An optional box: blank is absent, a number is the number (in the stored unit), anything else is a problem. */
type Optional = { ok: true; value: number | undefined } | { ok: false };
const optional = (raw: string, unit: PointsRule["unit"]): Optional => {
  if (raw.trim() === "") return { ok: true, value: undefined };
  const n = parseNumber(raw);
  return n === null ? { ok: false } : { ok: true, value: storedOf(unit, n) };
};

/**
 * The rule a Save would send, or the first problem with the draft. `rule: null` is "use the division's points" (the PUT's
 * `points: null`). Only what the PUT accepts leaves here:
 *  - the win and the loss must be numbers; every other outcome box may be blank (absent: its declared fallback, or — a
 *    draw, a tie — uncovered, which `draftRefusal` says before Save);
 *  - a set table names every set score the stage reaches (D10(a)): a row is both numbers or neither, and a blank row pays
 *    the win and the loss its placeholder shows, written out (the "*" guard: "*" never counts toward a two-pair map). A
 *    table of one pair whose source paid through "*" is saved as `{"*": pair}` again;
 *  - the walkover row is both numbers or neither; a walkover SCORE without them pays the base win and loss, which is what
 *    the box shows as its placeholder; the score leaves only where the sport's table reads it (`offersWalkoverScore`);
 *  - every bonus has its points, and a kind that reads a threshold has it. A kind that reads none sends no `param`;
 *  - every points number is stored in the rule's unit (half-points ×2), and the rule passes the engine's own schema.
 */
export function ruleFromDraft(module: AnySportModule, draft: PointsDraft): RuleFromDraft {
  if (draft.useDivision) return { ok: true, rule: null };
  const unit = draft.unit;
  const num = (raw: string): number | null => {
    const n = parseNumber(raw);
    return n === null ? null : storedOf(unit, n);
  };
  const win = num(draft.win);
  const loss = num(draft.loss);
  if (win === null || loss === null) return { ok: false, problem: "number" };
  const fields = {
    draw: optional(draft.draw, unit),
    winOt: optional(draft.winOt, unit),
    lossOt: optional(draft.lossOt, unit),
    winSo: optional(draft.winSo, unit),
    lossSo: optional(draft.lossSo, unit),
    soBonus: optional(draft.soBonus, unit),
    lossUnplayed: optional(draft.lossUnplayed, unit),
    tie: optional(draft.tie, unit),
    noResult: optional(draft.noResult, unit),
  };
  const v: Partial<Record<keyof typeof fields, number>> = {};
  for (const [name, f] of Object.entries(fields) as [keyof typeof fields, Optional][]) {
    if (!f.ok) return { ok: false, problem: "number" };
    if (f.value !== undefined) v[name] = f.value;
  }

  let bySetScore: Record<string, [number, number]> | undefined;
  const scores = Object.keys(draft.sets);
  if (scores.length > 0) {
    const pairs: [string, [number, number]][] = [];
    for (const score of scores) {
      const [rw, rl] = draft.sets[score]!;
      const [w, l] = [num(rw), num(rl)];
      const blank = rw.trim() === "" && rl.trim() === "";
      if (blank) pairs.push([score, [win, loss]]);
      else if (w === null || l === null) return { ok: false, problem: "set" };
      else pairs.push([score, [w, l]]);
    }
    const one = new Set(pairs.map(([, [w, l]]) => `${w}:${l}`)).size === 1;
    bySetScore = draft.setsStar && one ? { "*": pairs[0]![1] } : Object.fromEntries(pairs);
  }

  const ww = num(draft.walkoverW);
  const wl = num(draft.walkoverL);
  if ((ww === null) !== (wl === null)) return { ok: false, problem: "walkover" };

  const scoreW = parseNumber(draft.awardW);
  const scoreL = parseNumber(draft.awardL);
  if ((scoreW === null) !== (scoreL === null)) return { ok: false, problem: "score" };

  const bonuses: PointsRule["bonuses"] = [];
  for (const b of draft.bonuses) {
    const points = num(b.points);
    if (points === null) return { ok: false, problem: "bonus" };
    if (PARAM_BONUS_KINDS.has(b.when)) {
      const param = parseNumber(b.param);
      if (param === null) return { ok: false, problem: "bonus" };
      bonuses.push({ when: b.when, param, points });
    } else {
      bonuses.push({ when: b.when, points });
    }
  }

  const reaches = offersWalkoverScore(module);
  const score: [number, number] | undefined = reaches && scoreW !== null && scoreL !== null ? [scoreW, scoreL] : undefined;
  const winnerPoints = ww ?? (score === undefined ? null : win);
  const loserPoints = wl ?? (score === undefined ? null : loss);
  const forfeit =
    winnerPoints === null || loserPoints === null
      ? undefined
      : { winnerPoints, loserPoints, ...(score === undefined ? {} : { awardScore: score }) };
  const dpb = draft.shootoutAs === "draw_plus_bonus";
  const parsed = PointsRule.safeParse({
    win: { regulation: win, ...(v.winOt === undefined ? {} : { ot: v.winOt }), ...(dpb || v.winSo === undefined ? {} : { so: v.winSo }) },
    loss: {
      regulation: loss,
      ...(v.lossOt === undefined ? {} : { ot: v.lossOt }),
      ...(dpb || v.lossSo === undefined ? {} : { so: v.lossSo }),
      ...(v.lossUnplayed === undefined ? {} : { unplayed: v.lossUnplayed }),
    },
    ...(v.draw === undefined ? {} : { draw: v.draw }),
    ...(!dpb || v.soBonus === undefined ? {} : { soBonus: v.soBonus }),
    shootoutAs: draft.shootoutAs,
    ...(v.tie === undefined ? {} : { tie: v.tie }),
    ...(v.noResult === undefined ? {} : { noResult: v.noResult }),
    ...(bySetScore === undefined ? {} : { bySetScore }),
    unit,
    bonuses,
    ...(forfeit === undefined ? {} : { forfeit }),
  });
  // Assumptions are guards: the draft builds only what the schema takes; a refusal here is a box this file let through.
  if (!parsed.success) return { ok: false, problem: "number" };
  return { ok: true, rule: parsed.data };
}

/** Why the server would refuse the rule a Save would send, asked BEFORE Save with the server's own questions: coverage's
 *  gaps (POINTS_OUTCOME_UNCOVERED: a blank draw or tie the stage reaches, a set score left out of a two-pair table) and
 *  the flat-over-split guard (POINTS_SPLIT_FLATTENED: the rule states no split where the sport pays one apart — every
 *  split box left blank on IIHF, ITTF, ICC…). Null when the server takes it, when the draft is not a rule yet (its
 *  problem says why), and for "use the division's points" (`points: null` flattens nothing). */
export type DraftRefusal =
  | { readonly code: "POINTS_OUTCOME_UNCOVERED"; readonly uncovered: readonly OutcomeKey[] }
  | { readonly code: "POINTS_SPLIT_FLATTENED"; readonly splits: readonly SplitReason[] };
export function draftRefusal(module: AnySportModule, divisionConfig: unknown, stage: StageShape, draft: PointsDraft): DraftRefusal | null {
  const built = ruleFromDraft(module, draft);
  if (!built.ok || built.rule === null) return null;
  const ctx = stagePointsContext(module, divisionConfig, stage);
  if (ctx === null) return null;
  const cov = coverage(built.rule, new Set(ctx.reachable));
  if (!cov.ok && cov.uncovered.length > 0) return { code: "POINTS_OUTCOME_UNCOVERED", uncovered: cov.uncovered };
  const splits = flattenedSplits(module, ctx.cfg, ctx.kind, built.rule);
  return splits.length > 0 ? { code: "POINTS_SPLIT_FLATTENED", splits } : null;
}

/** A value with its object keys sorted, for comparing a rule to what jsonb gave back (jsonb reorders keys). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Does the draft differ from what the stage stores? A Save is offered only then (an untouched section sends nothing). */
export function draftIsDirty(module: AnySportModule, draft: PointsDraft, stored: unknown): boolean {
  const next = ruleFromDraft(module, draft);
  if (!next.ok) return true;
  return canonical(next.rule) !== canonical(storedPointsRule(stored));
}

/** Is the draft's rule exactly `preset` (its chip shows pressed)? A draft that is not a rule yet is no preset. */
export function presetActive(module: AnySportModule, draft: PointsDraft, preset: PointsRule): boolean {
  const next = ruleFromDraft(module, { ...draft, useDivision: false });
  return next.ok && next.rule !== null && canonical(next.rule) === canonical(PointsRule.parse(preset));
}

/**
 * W2d final review m5 (controller ruling, 2026-10-28) - is a preset chip worth offering? Not when it pays what the stage
 * PLAYS (`playing`: its own rule, its pin's, else the sport's) on every outcome the stage can reach: `splitsLost`, the
 * engine's `payout` over its `reachableOutcomes` for the stage's merged cfg (the server's own comparison), so a click
 * would change nothing. Hockey's Pro League on an FIH outdoor stage is that chip, with or without a stage shoot-out (B2
 * pays FIH outdoor's absent bonus 1, the chip's declared 1). A chip the draft already IS stays, pressed: it says the
 * state. Compared against what the stage plays rather than the draft, so a chip never appears or vanishes above the
 * boxes while they are typed.
 */
export function presetOffered(module: AnySportModule, ctx: StagePointsContext, playing: PointsRule, draft: PointsDraft, preset: PointsRule): boolean {
  return presetActive(module, draft, preset) || splitsLost(module, { cfg: ctx.cfg, kind: ctx.kind, rule: playing }, preset).differs;
}

/** `rule` in points rather than its stored unit (a half-points rule's numbers halved), for words that print numbers. */
export function displayRule(rule: PointsRule): PointsRule {
  if (rule.unit !== "half") return rule;
  const h = (n: number) => n / 2;
  const hOpt = (n: number | undefined) => (n === undefined ? undefined : n / 2);
  const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
  return strip({
    ...rule,
    win: strip({ regulation: h(rule.win.regulation), ot: hOpt(rule.win.ot), so: hOpt(rule.win.so) }),
    loss: strip({ regulation: h(rule.loss.regulation), ot: hOpt(rule.loss.ot), so: hOpt(rule.loss.so), unplayed: hOpt(rule.loss.unplayed) }),
    draw: hOpt(rule.draw),
    soBonus: hOpt(rule.soBonus),
    tie: hOpt(rule.tie),
    noResult: hOpt(rule.noResult),
    bySetScore: rule.bySetScore === undefined ? undefined : Object.fromEntries(Object.entries(rule.bySetScore).map(([k, [w, l]]) => [k, [h(w), h(l)]])),
    bonuses: rule.bonuses.map((b) => ({ ...b, points: h(b.points) })),
    forfeit: rule.forfeit === undefined ? undefined : { ...rule.forfeit, winnerPoints: h(rule.forfeit.winnerPoints), loserPoints: h(rule.forfeit.loserPoints) },
  }) as PointsRule;
}

/**
 * The words of the rule a Save would store (or, for "Use the division's points", what the stage plays without a rule of
 * its own: its pin, I1, else the sport's own rule for the stage), in the public line's clauses (`pointsLine`, Task 16), in
 * points (`displayRule`): the walkover SCORE is said only where the sport's table reads it. Empty when the draft is not a
 * rule yet.
 */
export function previewClauses(module: AnySportModule, divisionConfig: unknown, draft: PointsDraft, pinned: unknown, stage: StageShape): PointsClause[] {
  const next = ruleFromDraft(module, draft.useDivision ? { ...draftFromStored(module, divisionConfig, null, pinned, stage), useDivision: false } : draft);
  if (!next.ok || next.rule === null) return [];
  return pointsLine(displayRule(next.rule), { awardReaches: offersWalkoverScore(module) });
}
