// W2d Task 8 (spec §5.4 "Resolution", §5.9; rule row X-TB-1; PS-7c) — the ONE resolver of a table stage's rules: the
// points it pays, the tie-break order it ranks by, and the order it is compared across groups by (best-Nth progression).
//
//   pinned ?? { points:      stage own ?? the sport's rule (`tablePointsRule`) under the merged cfg, for the stage kind,
//               tiebreakers: stage own ?? the division's ?? the sport's default (`defaultTiebreakers`) for the stage kind,
//               crossGroup:  stage own ?? the winning order with its head-to-head steps removed }
//
// `sources` names the layer that won each of points and order (the badge, spec §9). A pin is returned whole: the engine
// never merges into one — a stage's own save after activation is re-pinned by the web (Task 9's `repinStageOwnRules`).
// The merged cfg is read only when a sport layer answers, and then as the sport's schema parses it, so a stored partial
// cfg reads the defaults the schema declares. A cfg the schema refuses is read AS GIVEN, as the fold reads it
// (`fixture-cfg.ts`: every module tolerates a cfg its schema rejects) and as `validateCascade` does (D8), so this is never
// stricter than the fold: a stored cfg that scores is never refused here. A cfg the sport cannot read even so (generic's
// `{}`), or one it refuses itself (a set map that prices no set score, `tablePointsRule`), is a CONFIG_INVALID refusal —
// typed, never a crash; a stage whose own values (or pin) answer every layer never asks, so it is never refused for it.
import { EngineError } from "../core/errors.ts";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "../sport/module.ts";
import { isHeadToHeadKey } from "./cascade-rules.ts";
import type { PointsRule } from "./points.ts";

/** The layer a rule came from: this stage's own value, its division's, its sport's default, or — in a pin only — the
 *  rules the W2d migration found the stage ranking by (B1). */
export type TableRulesSource = "stage" | "division" | "sport" | "migrated";

/** What a table stage pays and ranks by (spec §5.4). `crossGroup` compares entrants from different groups (§5.9). */
export interface TableRules {
  readonly points: PointsRule;
  readonly tiebreakers: readonly TiebreakerKey[];
  readonly crossGroup: readonly TiebreakerKey[];
}

/** The rules a stage was fixed to when it became active (D9, OC2; `stages.table_rules_pinned`), with the layer each came
 *  from. The cross-group order follows the order's source. */
export interface TableRulesPin extends TableRules {
  readonly sources: { readonly points: TableRulesSource; readonly tiebreakers: TableRulesSource };
}

export interface TableRulesInput {
  readonly module: AnySportModule;
  readonly stageKind: TableStageKind;
  /** The stage's merged cfg: its division's cfg with the stage's rules over it (W2c). */
  readonly mergedCfg: unknown;
  /** The stage's own values (`stages.config.points`, `.tiebreakers`, the cross-group order); null = inherit. */
  readonly stageOwn: {
    readonly points: PointsRule | null;
    readonly tiebreakers: readonly TiebreakerKey[] | null;
    readonly crossGroup: readonly TiebreakerKey[] | null;
  };
  /** `divisions.tiebreakers`; null = inherit. */
  readonly divisionTiebreakers: readonly TiebreakerKey[] | null;
  /** The stage's pin; null while the stage is not active (a pending stage reads the live layers, OC2). */
  readonly pinned: TableRulesPin | null;
}

/** §5.9: the stage's order with every head-to-head step removed — `h2h_*`, `h2h_two`, `direct` and the block modifiers
 *  (rule 4's keys, `isHeadToHeadKey`) — in the order's own order. Entrants from different groups never met. */
export function defaultCrossGroup(tiebreakers: readonly TiebreakerKey[]): readonly TiebreakerKey[] {
  return tiebreakers.filter((key) => !isHeadToHeadKey(key));
}

// The sport's answer under the merged cfg as the sport reads it. Called only by a sport layer that answers. On a parsed
// cfg every throw is the sport's own (its typed refusals stand; anything else is a defect and is not dressed up). On a cfg
// the schema refuses, the sport is asked with it as given; one it cannot read at all is the typed refusal.
function askSport<T>(input: TableRulesInput, ask: (cfg: unknown) => T): T {
  const parsed = input.module.configSchema.safeParse(input.mergedCfg);
  if (parsed.success) return ask(parsed.data);
  try {
    return ask(input.mergedCfg);
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError(
      "CONFIG_INVALID",
      `the stage's ${input.module.key} settings do not parse, so its sport's table rules cannot be read`,
      // The reading's own failure rides along for the log; the issues are the schema's.
      { sport: input.module.key, stageKind: input.stageKind, issues: parsed.error.issues, reading: String(cause) },
    );
  }
}

// null or absent = inherit: a stored config that never had the key reads as unset, never as an order or rule of its own.
function pointsOf(input: TableRulesInput): { readonly points: PointsRule; readonly source: TableRulesSource } {
  const own = input.stageOwn.points;
  if (own != null) return { points: own, source: "stage" };
  return { points: askSport(input, (cfg) => input.module.tablePointsRule(cfg, input.stageKind)), source: "sport" };
}

function orderOf(input: TableRulesInput): { readonly tiebreakers: readonly TiebreakerKey[]; readonly source: TableRulesSource } {
  const own = input.stageOwn.tiebreakers;
  if (own != null) return { tiebreakers: own, source: "stage" };
  const division = input.divisionTiebreakers;
  if (division != null) return { tiebreakers: division, source: "division" };
  return { tiebreakers: askSport(input, (cfg) => input.module.defaultTiebreakers(input.stageKind, cfg)), source: "sport" };
}

/** X-TB-1: a stage ranks by its pin, else its own order, else its division's default, else its sport's default for its
 *  stage kind — and pays its pin, else its own rule, else its sport's rule under its merged cfg. Throws CONFIG_INVALID
 *  when a sport layer must answer and cannot read the merged cfg, or when an order holds a key outside the vocabulary. */
export function resolveTableRules(input: TableRulesInput): TableRulesPin {
  if (input.pinned != null) return input.pinned;
  const points = pointsOf(input);
  const order = orderOf(input);
  return {
    points: points.points,
    tiebreakers: order.tiebreakers,
    crossGroup: input.stageOwn.crossGroup ?? defaultCrossGroup(order.tiebreakers),
    sources: { points: points.source, tiebreakers: order.source },
  };
}
