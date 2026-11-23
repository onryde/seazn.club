import "server-only";
// The stage-completion and standings adapter (was competition.ts, split 2026-11-21 per MODULARIZATION.md):
//   kinds.ts         TABLE_KINDS, BRACKET_KINDS and the raw-kind parse every branch reads
//   types.ts         the row shapes, the loaded StageInputs, Tx, SnapshotCause
//   stage-inputs.ts  loadStageInputs (a stage's fixtures paid by its rules), the bye award, the table-stage fold input
//   standings.ts     snapshot writes, recompute, ranked/points reads, best-Nth source, Adjust points target
//   bracket-stage.ts ext_key parse, a bracket's engine shape, decided/placement reads and refresh
//   complete.ts      completeStageIfReady, the stage_completed wire event, appendDivisionEvent
export {
  TABLE_KINDS,
  BRACKET_KINDS,
  parseStageKind,
} from "./kinds";
export {
  type SnapshotCause,
} from "./types";
export {
  awardByeDelta,
  foldedAdjustments,
  gamePointsReader,
  scheduledPairsOf,
} from "./stage-inputs";
export {
  adjustmentTarget,
  loadBestNthSource,
  recomputeStandings,
  rankedStageStandings,
  stageTablePoints,
  stageTablePointsBefore,
  tableStageCompletable,
} from "./standings";
export {
  parseExtKey,
  bracketWinnerLoser,
  bracketStageIsDecided,
  refreshCompletedBracketPlacement,
  refreshCompletedBracketPlacementTx,
} from "./bracket-stage";
export {
  appendDivisionEvent,
  type WireTitle,
  type WireDivisionEvent,
  toWireEvent,
  type CompleteResult,
  completeStageIfReady,
} from "./complete";
