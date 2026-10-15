import "server-only";
// Per-stage match rules — one line per stage whose EFFECTIVE rules differ from
// its division's (design 2026-09-17 §D3/T7; brief 2026-09-24).
//
// The hub's `HubDivision.stageFormatLines` and the division page's stage chips
// both come from here, and the line itself comes from `effectiveRulesLine` —
// the SAME describer the match-centre loader labels a fixture with — so a
// stage cannot read one format on the hub and another on its own matches.
//
// The effective config is `stageScopedCfg`'s own overlay, never a second merge
// written here: that function is the one the scorer folds with, and a copy of
// its "null inherits" rule is exactly the kind of thing that drifts.
import type { AnySportModule } from "@seazn/engine/sport";
import { stageScopedCfg } from "@/server/engine-db/stage-cfg";
import { effectiveRulesLine, type RulesLineT } from "./describe-rules";

export interface StageFormatLine {
  stageId: string;
  stageName: string;
  /** Clauses — resolve and join with `rulesLineText` (`lib/rules-line.ts`). */
  line: RulesLineT;
}

/**
 * A line for each stage, in STAGE order (`seq`), whose rule keys DIFFER from
 * the division's — and nothing for the rest: an identical line per stage is
 * noise (brief decision). A stage whose stored rules merely restate the
 * division's own values gets no line; one whose rules differ ALWAYS gets one,
 * even where the describer's words are vague about the difference (badminton
 * `winBy`) — never the division's preset, which would be false for it
 * (`effectiveRulesLine`, review round 2).
 *
 * `stages[].rules` is the stored FRAGMENT (`PublicStage.rules`); only it is
 * overlaid. Since W2c the deciders (`shootout`, `extraTime`, `overtime`,
 * `superOver`, `tiebreakRungs`, `tieBoard`) live INSIDE that fragment — a
 * top-level decider on a stage's config is refused 400 (R-13b-1) — so a stage's
 * own decider override DOES reach the effective config. It does not reach the
 * LINE yet: the describer answers for the four set/nested sports only
 * (`STAGE_RULES_SPORTS`), none of which declares a decider, and it compares on
 * their format keys (`configKeysFor`). So a stage that differs from its
 * division only by how a tie ends gets no line today, though spectators read
 * that difference (ruling M4). Naming it is W2c Task 16 (`describeDeciders`,
 * which also replaces this paragraph). `__tests__/stage-format-lines.test.ts`
 * pins the premise, so the first described sport to declare a decider is seen.
 */
export function stageFormatLines(
  sportKey: string,
  module_: AnySportModule | null | undefined,
  divisionCfg: unknown,
  stages: readonly { id: string; name: string; seq: number; rules?: unknown }[],
): StageFormatLine[] {
  const out: StageFormatLine[] = [];
  for (const stage of [...stages].sort((a, b) => a.seq - b.seq)) {
    // No rules is identity inside `stageScopedCfg`, so it needs no guard here.
    const effective = stageScopedCfg(divisionCfg, { rules: stage.rules }, module_ ?? null);
    const line = effectiveRulesLine(sportKey, module_, effective, divisionCfg);
    if (line !== null) out.push({ stageId: stage.id, stageName: stage.name, line });
  }
  return out;
}
