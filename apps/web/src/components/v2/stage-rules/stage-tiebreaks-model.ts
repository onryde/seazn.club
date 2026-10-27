// W2d Task 15 (spec §9, D3, D11, OC1, OC2; rule rows X-TB-1, X-TB-2, X-TB-3) — the decisions the stage editor's
// "Tie-breaks" section makes, as pure functions with unit killers (`__tests__/stage-tiebreaks-model.test.ts`). The section
// (`stage-tiebreaks-section.tsx`) renders what these answer and decides nothing of its own.
//
// Client-safe like `stage-points-model.ts`: no "use client", no JSX, no `@/server` value import (`StageTableRules` is a
// type, erased).
//
// WHERE EVERY ANSWER COMES FROM. The order, the layer it came from, its pin and the sport's own default are the server's
// (`GET tableRules`, Task 13: `StageTableRules`, the one loader's document); which steps a position takes and why a step is
// refused are the engine's (`offerableKeys`, `validateCascade` — the same function the PUT asks); the lock is the server's
// (`formatLockedStageIds`: W2c's monotonic "played" predicate, PF-9 / PS-6), never activation (OC2) and never a score the
// page guesses at. The web keeps no list of keys, sports or orders.
import {
  isHeadToHeadKey,
  offerableKeys,
  validateCascade,
  type CascadeContext,
  type CascadeRefusal,
  type TableRulesSource,
} from "@seazn/engine/competition";
import type { TablePresets, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import type { StageTableRules } from "@/server/api-v1/schemas";

/** The panel's stage row, reduced to what the models read (PS-9h). `pooled` and `bestNth` are `stagePooled` /
 *  `takesBestNthFrom`'s answers over the panel's stages. */
export interface StageLike {
  readonly id: string;
  readonly kind: TableStageKind;
  readonly pooled: boolean;
  readonly bestNth: boolean;
  readonly tableRules: StageTableRules;
}

/** The badge beside the section title (spec §9). `unknown`: a layer the wire cannot carry unpinned (`migrated` exists only
 *  in a pin) — refused by name, so the badge never claims an origin the server did not give. */
export type TiebreakBadge =
  | { kind: "inherited"; from: "division" | "sport" }
  | { kind: "overridden" }
  | { kind: "pinned"; from: TableRulesSource }
  | { kind: "unknown" };

/** One step of the order as the list shows it. */
export interface TiebreakRow {
  key: TiebreakerKey;
  /** D11: the sport's primary measure is pinned first, the drawing of lots last — non-Swiss only (OC1). */
  pinned: "first" | "last" | null;
  canUp: boolean;
  canDown: boolean;
  canRemove: boolean;
  /** The engine's first refusal of this step (`validateCascade`), shown inline beside it (spec §9 Errors). */
  refusal?: CascadeRefusal;
}

/**
 * The list: one row per step, in order. On a non-Swiss stage the first step is pinned when it IS the sport's primary measure
 * (`primaryTableKey`) and the last when it IS `lots` — a pinned row has no arrows and no remove, and the middle rows move only
 * between them (never past a pinned end). A Swiss order keeps its own shape (OC1: W3 owns it), so nothing is pinned. A
 * locked stage shows the list with no control and no refusal (its order is pinned; nothing is left to fix). Each row carries
 * the engine's first refusal of its step.
 */
export function tiebreakRows(keys: readonly TiebreakerKey[], ctx: CascadeContext, locked: boolean): TiebreakRow[] {
  const swiss = ctx.stageKind === "swiss";
  const last = keys.length - 1;
  const firstPinned = !swiss && keys.length > 0 && keys[0] === ctx.module.primaryTableKey;
  const lastPinned = !swiss && keys.length > 0 && keys[last] === "lots" && !(firstPinned && last === 0);
  const lo = firstPinned ? 1 : 0;
  const hi = lastPinned ? last - 1 : last;
  const refusals = locked ? [] : validateCascade(keys, ctx);
  return keys.map((key, i) => {
    const pinned = firstPinned && i === 0 ? "first" : lastPinned && i === last ? "last" : null;
    const free = pinned === null && !locked;
    const refusal = refusals.find((r) => r.index === i);
    return {
      key,
      pinned,
      canUp: free && i > lo,
      canDown: free && i < hi,
      canRemove: free,
      ...(refusal === undefined ? {} : { refusal }),
    };
  });
}

/** "+ Add step" (§9): exactly the keys the engine's `offerableKeys` accepts at that insertion point. */
export function addableAt(keys: readonly TiebreakerKey[], position: number, ctx: CascadeContext): readonly TiebreakerKey[] {
  return offerableKeys(keys, position, ctx);
}

/** Where "+ Add step" inserts: just before a non-Swiss order's closing `lots` (it stays last, §5.5 rule 1), else at the end. */
export function addPosition(keys: readonly TiebreakerKey[], kind: TableStageKind): number {
  return kind !== "swiss" && keys.length > 0 && keys[keys.length - 1] === "lots" ? keys.length - 1 : keys.length;
}

/** The order with `key` inserted at `position` (0..length). */
export function insertStep(keys: readonly TiebreakerKey[], position: number, key: TiebreakerKey): TiebreakerKey[] {
  return [...keys.slice(0, position), key, ...keys.slice(position)];
}

/** The order with the step at `index` moved one place (`by` -1 up, +1 down); the same order when the move would leave it. */
export function moveStep(keys: readonly TiebreakerKey[], index: number, by: -1 | 1): TiebreakerKey[] {
  const to = index + by;
  if (index < 0 || index >= keys.length || to < 0 || to >= keys.length) return [...keys];
  const next = [...keys];
  const [step] = next.splice(index, 1);
  next.splice(to, 0, step!);
  return next;
}

/** The order without the step at `index` (by position: `h2h_two` may repeat, OC3, and only that instance goes). */
export function removeStep(keys: readonly TiebreakerKey[], index: number): TiebreakerKey[] {
  return keys.filter((_, i) => i !== index);
}

/** X-TB-1: Pinned at start once the stage is active (OC2: `pinnedAt`), with the layer it was pinned from; else Overridden
 *  for the stage's own order, Inherited from the division or the sport default. */
export function tiebreakBadge(tableRules: StageTableRules): TiebreakBadge {
  const { source, pinnedAt } = tableRules.tiebreakers;
  if (pinnedAt !== null) return { kind: "pinned", from: source };
  if (source === "stage") return { kind: "overridden" };
  if (source === "division" || source === "sport") return { kind: "inherited", from: source };
  return { kind: "unknown" };
}

/** X-TB-2 (D3, OC2; PF-9, PS-6): the stage's own order is locked exactly when the SERVER lists the stage — W2c's monotonic
 *  "played" predicate (a first score, or an opened online round). Never activation: between the pin and the first score the
 *  order stays editable. Never a score the page guesses at (a fixture status is not monotonic). */
export function sectionLocked(stage: Pick<StageLike, "id" | "tableRules">, formatLockedStageIds: readonly string[]): boolean {
  return formatLockedStageIds.includes(stage.id);
}

/** The section's controls beside the list: "+ Add step" and Reset while the order is editable, and "Use the division's
 *  order" (clear the stage's own, `tiebreakers: null`) only for a stage that HAS one. */
export function sectionControls(locked: boolean, tableRules: StageTableRules): { add: boolean; reset: boolean; clear: boolean } {
  return { add: !locked, reset: !locked, clear: !locked && tableRules.tiebreakers.source === "stage" };
}

/** The section-level line under the list: the empty order (spec §10 `empty`, it has no step to mark), and an INHERITED order
 *  the engine refuses for this stage — the hint to set the stage's own order (spec §9 Errors). Null when neither. */
export function orderHint(tableRules: StageTableRules, ctx: CascadeContext): { empty: boolean; inherited: boolean } | null {
  const keys = tableRules.tiebreakers.keys;
  const refused = validateCascade(keys, ctx).length > 0;
  const inherited = refused && (tableRules.tiebreakers.source === "division" || tableRules.tiebreakers.source === "sport");
  const empty = keys.length === 0;
  return empty || inherited ? { empty, inherited } : null;
}

/** "Reset to sport default" (PS-7b): the server's `sportDefault` for this stage — never the current order, and never the
 *  web's own call of `defaultTiebreakers`. */
export function resetOrder(tableRules: StageTableRules): readonly TiebreakerKey[] {
  return tableRules.tiebreakers.sportDefault;
}

/** The Reset menu: the sport's named orders where it declares some (football: FIFA 2026 / UEFA / Classic, D5), else the one
 *  sport default. */
export function resetChoices(presets: TablePresets | undefined, tableRules: StageTableRules): { id: string; keys: readonly TiebreakerKey[] }[] {
  const named = presets?.tiebreakers ?? [];
  if (named.length > 0) return named.map((p) => ({ id: p.id, keys: [...p.keys] }));
  return [{ id: "sport_default", keys: resetOrder(tableRules) }];
}

/** §5.9: the read-only "Between groups" line — only for a pooled stage a later stage takes a best-Nth from. It never shows a
 *  head-to-head step (teams in different groups never played each other), whatever a pin holds. */
export function crossGroupLine(stage: StageLike): readonly TiebreakerKey[] | null {
  if (!stage.pooled || !stage.bestNth) return null;
  return stage.tableRules.crossGroup.keys.filter((key) => !isHeadToHeadKey(key));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Is the stage split into groups: a group stage, or any table stage with more than one pool (`config.pools.count`). */
export function stagePooled(stage: { kind: string; config: unknown }): boolean {
  if (stage.kind === "group") return true;
  const pools = isObj(stage.config) && isObj(stage.config.pools) ? stage.config.pools.count : undefined;
  return typeof pools === "number" && pools > 1;
}

/** Does a later stage take a best-Nth from `stage`: a source naming it (`{stageId}`), or `"previous"` on the stage directly
 *  after it by seq, with a `bestNth` take. Read off the panel's stage rows (`progression` as stored). */
export function takesBestNthFrom(
  stage: { id: string; seq: number },
  stages: readonly { id: string; seq: number; progression: unknown }[],
): boolean {
  const next = stages.filter((s) => s.seq > stage.seq).sort((a, b) => a.seq - b.seq)[0];
  return stages.some((s) => {
    const sources = isObj(s.progression) && Array.isArray(s.progression.sources) ? s.progression.sources : [];
    return sources.some((src: unknown) => {
      if (!isObj(src)) return false;
      const from = src.stage;
      const names = from === "previous" ? next?.id === s.id : isObj(from) && from.stageId === stage.id;
      return names && Array.isArray(src.take) && src.take.some((t: unknown) => isObj(t) && t.kind === "bestNth");
    });
  });
}
