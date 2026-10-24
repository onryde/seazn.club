// W2c Task 18 (S3, ST-G8) - the decisions the stage points section makes, as pure functions with unit killers
// (`__tests__/stage-points-model.test.ts`). The section itself (`stage-points-section.tsx`) renders what these answer.
//
// Client-safe like `stage-row-model.ts`: no "use client", no JSX, no `@/server` import.
//
// WHERE EVERY ANSWER COMES FROM. The section offers only what the server's PUT accepts, and the server's questions are
// the engine's: `pointsRuleExpressible` (Q1: which divisions a stage rule can stand in for), `pointsRuleAwardReachesTable`
// (batch-3 I3: which sports read a walkover SCORE), `validatePointsRule` (which bonus kinds the sport's metrics can feed),
// `DRAW_KINDS` (which stages have a table). The web keeps no list of sports, kinds or metrics: a sport added to the
// engine is offered exactly what the engine says it takes.
import {
  PointsRule,
  parseStoredPointsRule,
  pointsRuleAwardReachesTable,
  pointsRuleExpressible,
  validatePointsRule,
  type Expressible,
} from "@seazn/engine/competition";
import { DRAW_KINDS } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { pointsLine, type PointsClause } from "@/lib/points-line";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Which state the section is in.
// ---------------------------------------------------------------------------

export type PointsSectionState = "inexpressible" | "editor";

/**
 * The section's state (review I9): a division whose points a stage rule cannot say is `inexpressible` (the reason, and no
 * boxes); every other division gets the `editor`. There is no plan state: scoring is free on every plan (owner, 2026-10-19),
 * so the section asks nothing of the org's entitlements.
 */
export function pointsSectionState(expressible: boolean): PointsSectionState {
  return expressible ? "editor" : "inexpressible";
}

/** Does this stage have a table its own points could rank? The server refuses a bracket kind (`refuseStagePoints`). */
export function stageTakesPoints(kind: string): boolean {
  return (DRAW_KINDS as ReadonlySet<string>).has(kind);
}

/** The division's config AS THE SPORT PARSES IT (defaults applied), else as stored: the server asks Q1 of exactly this
 *  (`stage-rules-merge.ts parsedDivisionCfg`), so the section pre-checks what the PUT would answer. */
export function divisionPointsCfg(module: AnySportModule, divisionConfig: unknown): Record<string, unknown> {
  const raw = isObj(divisionConfig) ? divisionConfig : {};
  const parsed = module.configSchema.safeParse(raw);
  return (parsed.success ? parsed.data : raw) as Record<string, unknown>;
}

/** Q1 for this division (the engine's `pointsRuleExpressible`): ok, or the split keys the stage rule cannot say. */
export function divisionExpressible(module: AnySportModule, divisionConfig: unknown): Expressible {
  return pointsRuleExpressible(divisionPointsCfg(module, divisionConfig));
}

// ---------------------------------------------------------------------------
// The division's own base points: what an unchecked "Use the division's points" starts from.
// ---------------------------------------------------------------------------

export interface DivisionBase {
  readonly win: number | null;
  /** Null when the sport cannot draw (a set sport's points table pays win and loss only): the section shows no draw box. */
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
 * boardgame keeps `scoring`), else a set sport's `pointsMap` when it pays ONE pair (the only shape Q1 lets through).
 * A part the sport has no word for is null, never a made-up 0 or 3.
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
// Bonus kinds.
// ---------------------------------------------------------------------------

/** Every bonus kind the engine's PointsRule takes (its own zod enum, never a list typed here). */
export type BonusWhen = PointsRule["bonuses"][number]["when"];
export const BONUS_KINDS: readonly BonusWhen[] = (
  PointsRule.shape.bonuses.unwrap().element as unknown as { shape: { when: { options: readonly BonusWhen[] } } }
).shape.when.options;

/** The kinds that read a threshold (`param`): the margin and ratio bonuses. Every other kind pays on the result alone. */
export const PARAM_BONUS_KINDS: ReadonlySet<BonusWhen> = new Set<BonusWhen>(["loss_margin_lte", "win_margin_gte", "score_ratio_gte"]);

/** W2d: the editor's three boxes as an outcome-keyed rule, read as the W2c rule read them (`legacyPointsRule`): every
 *  win pays `win`, every loss `loss`, a draw `draw`, a tie and a no result 0, a shoot-out as a result. The per-outcome
 *  fields (overtime, shoot-out, set score) are not the editor's yet. */
const legacyEquivalent = (win: number, draw: number, loss: number) =>
  ({ win: { regulation: win }, loss: { regulation: loss }, draw, tie: 0, noResult: 0, shootoutAs: "result", unit: "whole" }) as const;
const ZERO_RULE = legacyEquivalent(0, 0, 0);

/**
 * The bonus kinds worth offering for this sport: those the server's `validatePointsRule` accepts for the sport's metrics (a
 * margin bonus needs the sport to emit for/against or a difference; the server answers CONFIG_INVALID otherwise), minus
 * the two that can never fire here - a draw bonus where the sport cannot draw, and a no-result bonus where the sport
 * records no no-results (cricket's `no_results` metric; cricket's points are not expressible, so none of the sports that
 * reach this editor has one). A kind a stage ALREADY stores stays on screen whatever this answers (see the section).
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

export interface PointsDraft {
  /** True: the stage stores no points of its own and plays the division's (`points: null`). */
  useDivision: boolean;
  win: string;
  draw: string;
  loss: string;
  /** The walkover row's points (`forfeit.winnerPoints` / `loserPoints`), both blank = no walkover row. */
  walkoverW: string;
  walkoverL: string;
  /** The walkover SCORE (`forfeit.awardScore`), both blank = no score recorded. */
  awardW: string;
  awardL: string;
  bonuses: BonusDraft[];
}

const text = (n: number | null): string => (n === null ? "" : String(n));

/** The stored rule if it is one the engine's schema takes, else null (absent, `null`, or a hand-edited row). W2d: either
 *  stored shape — a W2c `{base, …}` row reads through `legacyPointsRule` (`parseStoredPointsRule`). */
export function storedPointsRule(stored: unknown): PointsRule | null {
  return parseStoredPointsRule(stored);
}

/** The draft a stage opens with: its own rule when it stores one, else the division's base numbers behind a checked
 *  "Use the division's points". */
export function draftFromStored(module: AnySportModule, divisionConfig: unknown, stored: unknown): PointsDraft {
  const rule = storedPointsRule(stored);
  if (rule === null) {
    const b = divisionBasePoints(module, divisionConfig);
    return {
      useDivision: true,
      win: text(b.win),
      draw: text(b.draw ?? 0),
      loss: text(b.loss),
      walkoverW: "",
      walkoverL: "",
      awardW: "",
      awardL: "",
      bonuses: [],
    };
  }
  return {
    useDivision: false,
    win: String(rule.win.regulation),
    // A rule with no draw pays none; the box shows the 0 a sport that cannot draw sends (`ruleFromDraft`).
    draw: String(rule.draw ?? 0),
    loss: String(rule.loss.regulation),
    walkoverW: rule.forfeit === undefined ? "" : String(rule.forfeit.winnerPoints),
    walkoverL: rule.forfeit === undefined ? "" : String(rule.forfeit.loserPoints),
    awardW: rule.forfeit?.awardScore === undefined ? "" : String(rule.forfeit.awardScore[0]),
    awardL: rule.forfeit?.awardScore === undefined ? "" : String(rule.forfeit.awardScore[1]),
    bonuses: rule.bonuses.map((b) => ({ when: b.when, param: b.param === undefined ? "" : String(b.param), points: String(b.points) })),
  };
}

/** A number typed in a box: blank is NOT zero (`Number("")` is 0, which would store a rule nobody wrote). */
export function parseNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type DraftProblem = "number" | "walkover" | "score" | "bonus";
export type RuleFromDraft = { ok: true; rule: PointsRule | null } | { ok: false; problem: DraftProblem };

/**
 * The rule a Save would send, or the first problem with the draft. `rule: null` is "use the division's points" (the PUT's
 * `points: null`). Only what the PUT accepts leaves here:
 *  - the three base numbers must be numbers; a sport that cannot draw sends draw 0 (the rule has no word for "none");
 *  - the walkover row is both numbers or neither; a walkover SCORE without them pays the base win and loss, which is what
 *    the box shows as its placeholder;
 *  - the score leaves only where the sport's table reads it (`offersWalkoverScore`), whatever the draft holds;
 *  - every bonus has its points, and a kind that reads a threshold has it. A kind that reads none sends no `param`.
 */
export function ruleFromDraft(module: AnySportModule, draft: PointsDraft): RuleFromDraft {
  if (draft.useDivision) return { ok: true, rule: null };
  const win = parseNumber(draft.win);
  const draw = parseNumber(draft.draw);
  const loss = parseNumber(draft.loss);
  if (win === null || draw === null || loss === null) return { ok: false, problem: "number" };

  const ww = parseNumber(draft.walkoverW);
  const wl = parseNumber(draft.walkoverL);
  if ((ww === null) !== (wl === null)) return { ok: false, problem: "walkover" };

  const scoreW = parseNumber(draft.awardW);
  const scoreL = parseNumber(draft.awardL);
  if ((scoreW === null) !== (scoreL === null)) return { ok: false, problem: "score" };

  const bonuses: PointsRule["bonuses"] = [];
  for (const b of draft.bonuses) {
    const points = parseNumber(b.points);
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
  return { ok: true, rule: { ...legacyEquivalent(win, draw, loss), bonuses, ...(forfeit === undefined ? {} : { forfeit }) } };
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

/**
 * The words of the rule a Save would store (or, for "Use the division's points", the division's own base), in the public
 * line's clauses (`pointsLine`, Task 16): the walkover SCORE is said only where the sport's table reads it. Empty when the
 * draft is not a rule yet.
 */
export function previewClauses(module: AnySportModule, divisionConfig: unknown, draft: PointsDraft): PointsClause[] {
  const next = ruleFromDraft(module, draft.useDivision ? { ...draftFromStored(module, divisionConfig, null), useDivision: false } : draft);
  if (!next.ok || next.rule === null) return [];
  return pointsLine(next.rule, { awardReaches: offersWalkoverScore(module) });
}
