import "server-only";
// v4 AI Schedule Architect. This folder replaces the single `schedule-ai.ts`
// module; importers keep `from "@/server/usecases/schedule-ai"` and land here.
// The barrel re-exports exactly the names that file exported, no more.
//
//   types.ts          the pack shape and a run's result (type-only)
//   helpers.ts        zoned ISO, the string comparator, ISO -> epoch ms
//   identity.ts       the scheduling-only same-person guard
//   pack.ts           buildSchedulePack: the deterministic context pack
//   model-payload.ts  what of the pack goes on the wire to the model
//   model-config.ts   model, effort, thinking and token/timeout settings
//   verify.ts         pack -> engine adapters, the referee config, the diff
//   run.ts            one architect run: model call, verify, repair rounds
//   ladder.ts         the model fallback ladder and its quality gate
//   orchestrator.ts   the endpoint: gates, pack, ladder, ledger, telemetry

export { zonedIso } from "./helpers";
export { personKeyResolver } from "./identity";
export {
  OTHER_DIVISION_LABEL,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_SESSION_HOURS,
  buildCourtDirectory,
  buildSchedulePack,
} from "./pack";
export type { BuildPackOptions, PackCourtInfo } from "./pack";
export type {
  PackStartWindow,
  PackConstraints,
  PackSettings,
  PackFixture,
  PackObstacle,
  PackEntrant,
  PackPerson,
  PackOfficial,
  PackAssignment,
  PackDraftAssignment,
  SchedulePack,
  AiPlanResult,
} from "./types";
export { toModelPayload } from "./model-payload";
export {
  ROUND_TIMEOUT_MS,
  MAX_REPAIR_ROUNDS,
  MAX_TOKENS,
  schedulingAiModel,
  schedulingAiEffort,
  parseAiEffort,
  schedulingAiThinking,
  schedulingAiThinkingBudget,
  aiReasoningParams,
  aiReasoning,
} from "./model-config";
export type { AiEffort, AiThinking } from "./model-config";
export {
  isBlocking,
  unschedulableRule,
  structuralCheck,
  toEngineAssignments,
  toObstacleAssignments,
  toSchedulableFixtures,
  toRuleFixture,
  packRuleFixtures,
  verifyConfig,
  windowBounds,
  packFeedDependencies,
} from "./verify";
export type { RuleFixtureSource } from "./verify";
export { resolveModelCourtLabels, runAiPlan } from "./run";
export {
  schedulingAiCheapModel,
  planIsAcceptable,
  parseLadderSpec,
  schedulingAiLadder,
  DEFAULT_LADDER,
  planRungs,
  runLadder,
} from "./ladder";
export type { LadderRung } from "./ladder";
export { aiPlanForDivision, releasePreviewQuietly } from "./orchestrator";
export type { PreviewClaim } from "./orchestrator";
