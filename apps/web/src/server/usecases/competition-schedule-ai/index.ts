import "server-only";
// Barrel: the public surface of the former usecases/competition-schedule-ai.ts, unchanged.
export {
  JOINT_ASSIGNMENT_UNKNOWN,
  jointFeedDependencies,
  toJointEngineAssignments,
  toJointObstacleAssignments,
  toJointSchedulableFixtures,
} from "./joint-assignments";
export { JOINT_SYSTEM_PROMPT, runCompetitionAiPlan, runCompetitionAiPlanLadder } from "./joint-run";
export {
  jointSolverConfig,
  jointStructuralCheck,
  partitionConflicts,
  verifyConfigFor,
  verifyJoint,
} from "./joint-verify";
export { JOINT_APPLY_EVENT, lastCompetitionAiApply } from "./last-apply";
export { toJointModelPayload } from "./model-payload";
export { aiPlanForCompetition } from "./orchestrator";
export { COMPETITION_MOVABLE_CAP, buildCompetitionPack } from "./pack";
export type { BuildCompetitionPackOptions } from "./pack";
export type {
  AiCompetitionPlanRequest,
  AiCompetitionPlanResponse,
  CompetitionPack,
  CompetitionPackAssignment,
  CompetitionPackDivision,
  CompetitionPackDraftAssignment,
  CompetitionPackFixture,
  CompetitionPackObstacle,
  CompetitionPlanResult,
} from "./types";
