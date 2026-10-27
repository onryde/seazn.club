// W2d Task 9 — a stage's table rules exactly as the one loader serves them (`stageTableRulesDocOf`, the mapping
// `stageTableRulesDocs` uses), for the tests of the pure readers that are handed a stage: the public page, the embed, the
// hub, the console, the qualification builder. Built from the stage's rows through the loader's own pure resolution, so
// a fixture can never carry a shape or an order the loader would not serve. An UNPINNED (pending) stage's rules: the
// live layers own ?? division ?? sport — a pinned stage's doc differs only in `pinnedAt` and `sources`.
import type { AnySportModule } from "@seazn/engine/sport";
import { stageTableRulesDocOf, type StageTableRulesDoc } from "@/server/engine-db/table-rules";

export function unpinnedRulesDoc(opts: {
  module: AnySportModule;
  kind?: string;
  divisionConfig: unknown;
  divisionTiebreakers?: readonly string[] | null;
  stageConfig?: Record<string, unknown> | null;
}): StageTableRulesDoc {
  return stageTableRulesDocOf(
    {
      stageId: "fixture-stage",
      kind: opts.kind ?? "league",
      status: "pending",
      stageConfig: opts.stageConfig ?? null,
      pin: null,
      pinnedAt: null,
      divisionConfig: opts.divisionConfig,
      divisionTiebreakers: opts.divisionTiebreakers ?? null,
    },
    opts.module,
  );
}
