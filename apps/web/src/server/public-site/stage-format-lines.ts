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
import { effectiveRulesLine } from "./describe-rules";
import type { MsgT } from "./match-centre-schema";

export interface StageFormatLine {
  stageId: string;
  stageName: string;
  line: MsgT;
}

/**
 * A line for each stage, in STAGE order (`seq`), whose rules make it play a
 * different format from the division — and nothing for the rest: an identical
 * line per stage is noise (brief decision), and a stage whose stored rules
 * merely restate the division's own values plays the division's format.
 *
 * `stages[].rules` is the stored FRAGMENT (`PublicStage.rules`); only it is
 * overlaid, so the decider keys (`shootout`/`extraTime`) that also live on a
 * stage's config play no part — they are not format rules (`configKeysFor`).
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
    const effective = stageScopedCfg(divisionCfg, { rules: stage.rules });
    const line = effectiveRulesLine(sportKey, module_, effective, divisionCfg);
    if (line !== null) out.push({ stageId: stage.id, stageName: stage.name, line });
  }
  return out;
}
