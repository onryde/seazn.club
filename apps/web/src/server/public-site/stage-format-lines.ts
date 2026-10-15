import "server-only";
// Per-stage match rules — one line per stage that PLAYS differently from its
// division (design 2026-09-17 §D3/T7; brief 2026-09-24; W2c Task 16).
//
// The hub's `HubDivision.stageFormatLines` and the division page's stage chips
// both come from here, and the line itself comes from `effectiveRulesLine` —
// the SAME describer the match-centre loader labels a fixture with — so a
// stage cannot read one format on the hub and another on its own matches.
//
// The effective config is `resolveFixtureCfg`'s own answer for a fixture of
// the stage with no events and no override: `division ⊕ stage.rules ⊕
// bracketDeciders(kind)`. That is the cfg the scorer folds with, and a copy of
// its "null inherits" rule or of the bracket overlay (carrom's extra board,
// whatever the division's tie board) is exactly the kind of thing that drifts.
import type { AnySportModule } from "@seazn/engine/sport";
import { pointsRuleAwardReachesTable, type PointsRule } from "@seazn/engine/competition";
import { forbidsLevelResult } from "@seazn/engine/core";
import { pointsLine } from "@/lib/points-line";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { describeDeciders, effectiveRulesLine, type RulesLineT } from "./describe-rules";

export interface StageFormatLine {
  stageId: string;
  stageName: string;
  /** Clauses — resolve and join with `rulesLineText` (`lib/rules-line.ts`). */
  line: RulesLineT;
}

/**
 * A line for each stage, in STAGE order (`seq`), that says something a
 * spectator needs — and nothing for the rest: an identical line per stage is
 * noise (brief decision). A stage says:
 *
 *  - its FORMAT, with how a tied match ends and any abandon policy it changed,
 *    when its effective rules differ from its division's (`effectiveRulesLine`).
 *    One whose rules differ ALWAYS gets the line, even where the describer's
 *    words are vague about the difference (badminton `winBy`) — never the
 *    division's preset, which would be false for it;
 *  - how a tied match ENDS alone, when it is a bracket stage whose format is the
 *    division's: a knockout cannot end level, so what happens to a level match
 *    is part of its rules whether or not the stage changed anything
 *    (`describeDeciders`; "level matches wait for the organiser" when every
 *    decider is off). A table stage never says so: a drawn league match is a
 *    result;
 *  - its OWN points rule (`points_rule`, X-PT-1), after the format; its walkover SCORE is part of it where the award
 *    reaches the sport's table (X-WO-1 B: the headline reads the same number).
 *
 * `stages[].rules` is the stored FRAGMENT (`PublicStage.rules`); since W2c the
 * deciders (`shootout`, `extraTime`, `overtime`, `superOver`, `tiebreakRungs`,
 * `tieBoard`) live INSIDE it — a top-level decider on a stage's config is
 * refused 400 (R-13b-1) — so a stage's decider override reaches the effective
 * config and, through `describeDeciders`, its line (batch-4 ruling M4).
 */
export function stageFormatLines(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  divisionCfg: unknown,
  stages: readonly { id: string; name: string; seq: number; kind?: string | null; rules?: unknown; points_rule?: unknown }[],
): StageFormatLine[] {
  const out: StageFormatLine[] = [];
  for (const stage of [...stages].sort((a, b) => a.seq - b.seq)) {
    const kind = stage.kind ?? null;
    let line: RulesLineT = [];
    if (module_) {
      // No rules is identity inside the resolver, so it needs no guard here.
      const effective = resolveFixtureCfg(
        { config_snapshot: null, rules_override: null },
        divisionCfg,
        { kind, config: { rules: stage.rules } },
        module_,
      );
      line = effectiveRulesLine(sportKey, module_, effective, divisionCfg, kind) ?? (forbidsLevelResult(kind) ? describeDeciders(module_, kind, effective) : []);
    }
    // X-WO-1 B: the rule's walkover score is said where the walkover headline reads it (the award reaches the sport's table);
    // a retired module (none to ask) says nothing of it.
    const points = pointsLine(stage.points_rule as PointsRule, { awardReaches: module_ ? pointsRuleAwardReachesTable(module_) : false });
    if (line.length + points.length > 0) out.push({ stageId: stage.id, stageName: stage.name, line: [...line, ...points] });
  }
  return out;
}
