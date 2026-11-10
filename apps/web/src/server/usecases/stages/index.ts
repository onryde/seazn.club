import "server-only";
// Stage use-cases (doc 08 §3): define the stage graph, generate fixtures
// (idempotent — regeneration diffs against what exists, keyed by the pure
// generator's stable ids), guarded completion, standings reads. This folder
// replaces the single `stages.ts` module; importers keep
// `from "@/server/usecases/stages"` and land here. The barrel re-exports exactly
// the names that file exported, no more.
//
//   types.ts           row types, column lists, fixture shapes, outcomes, table/bracket kind sets
//   helpers.ts         division-started check, public revalidate, departed entrants, standings refold
//   generators.ts      americano rotation, bracket/round-robin generators, `generate`, pool/draw helpers
//   stage-graph.ts     list, create, replace (format-change preview and lock) and delete stages
//   swiss-reconcile.ts Swiss reshape counters and the round-shell reconcile
//   swiss-gen.ts       Swiss pairing: rounds judgement, refusals, history fold, `swissGen`
//   swiss-boards.ts    Swiss board seat locks, clearing, unseating, and un-pairing a round
//   preview.ts         the builder's example preview (`generate()` over synthetic entrants)
//   roster-drift.ts    roster drift, sealed-setup and attachment counts
//   bracket-seats.ts   bracket seat writes: fillSlot, departed seats, seeded byes, resolveBracketSeats
//   setup-fixtures.ts  TBD-shape fixtures for a `timing: "setup"` progression
//   generate-tx.ts     in-transaction generate/rebuild core, root-knockout reconcile, cross feeds
//   carry-over.ts      carry-over into the next stage: bracket losers, placement tables, seedNextStage
//   generate.ts        public generate/rebuild doors: write, commit + revalidate, Unpublished, rebuild
//   seed-proposal.ts   seed proposals: compute, read, confirm
//   seed-stale.ts      marking seed proposals stale on a source-stage or field change
//   completion.ts      guarded completion and its progression, standings reads, rank overrides
//   ad-hoc.ts          ladder challenges and ad-hoc single fixtures (writes outside bulk generation)

export { FIXTURE_COLS, BOARD_FIXTURE_COLS, REAL_TABLE_KINDS, BRACKET_KINDS } from "./types";
export type {
  StageRow,
  BoardFixtureRow,
  FixtureRow,
  ActiveEntrant,
  SwissExistingFixture,
  SwissGenResult,
  SwissReshape,
  GenerateOutcome,
  ReconcileOutcome,
  GenerateWrite,
  GenerateOptions,
  StageRosterDriftEntrant,
  StageRosterDrift,
  SealedSetupCounts,
} from "./types";
export { divisionHasStarted, refoldStageTable, departedEntrantIds } from "./helpers";
export {
  BRACKET_WALKOVER_KINDS,
  knockoutDraws,
  knockoutDrawOrder,
  readStageDrawSeed,
  snakeDistribute,
  POOL_KEYS,
  poolCount,
} from "./generators";
export {
  listStages,
  listStagesWithTableRules,
  getStageWithTableRules,
  assertStageBatchGates,
  createStages,
  divisionFormatLocked,
  replaceStages,
  previewReplaceStages,
  DELETE_STAGE_NOT_LAST_MESSAGE,
  deleteStage,
} from "./stage-graph";
export type { StageTableRulesWire, StageWithTableRulesRow, StageCarry } from "./stage-graph";
export { isEmptySwissReshape, reconcileSwissRoundShells } from "./swiss-reconcile";
export {
  DECIDED,
  judgeSwissRoundsAt,
  judgeSwissPairAt,
  refuseFormatTooSmall,
  refuseSwissRoundsAboveMaxAtStart,
  swissFieldForRound,
  swissActiveEntrants,
  refuseSwissFieldUnderTwo,
  buildSwissHistory,
  swissPairsInColour,
  swissGen,
} from "./swiss-gen";
export type { SwissHistoryState } from "./swiss-gen";
export {
  lockSwissBoardAppends,
  clearSwissFixtureSeats,
  unseatSwissRoundsSeatingEntrant,
  unpairSwissRound,
} from "./swiss-boards";
export { patchKnockoutStage } from "./third-place";
export type { PatchKnockoutStageResult } from "./third-place";
export { previewDivisionFixtures } from "./preview";
export type { PreviewMatch, PreviewSection, PreviewPhase, PreviewStageInput } from "./preview";
export {
  getStageRosterDrift,
  sealedStageSetupCounts,
  stageAttachmentCounts,
  ROSTER_DRIFT_INELIGIBLE_KINDS,
  isRosterDriftEligible,
} from "./roster-drift";
export { fillSlot, stampDepartedSeat, writeDepartedSeat, resolveBracketSeats } from "./bracket-seats";
export { writeProgressionSetupFixtures } from "./setup-fixtures";
export { generateStageFixturesTx, regenerateStageInTx, wireCrossFeeds } from "./generate-tx";
export { loadBracketFixtures, americanoPlacementTables } from "./carry-over";
export type { SeededStage } from "./carry-over";
export {
  generateStageFixtures,
  generateStageFixturesUnpublished,
  afterGenerateCommit,
  rebuildStageFixtures,
} from "./generate";
export type { RebuildOutcome } from "./generate";
export { computeSeedProposal, getSeedProposal, confirmSeedProposal } from "./seed-proposal";
export type { SeedProposalOut, ConfirmSeedProposalOut } from "./seed-proposal";
export {
  markDependentSeedProposalsStale,
  setupDependentsOf,
  markFieldChangeSeedProposalsStale,
} from "./seed-stale";
export { undecidedBracketFixtures, completeStage, getStandings, overrideStandings } from "./completion";
export type { CompleteStageResult, StandingsOut } from "./completion";
export { DEFAULT_LADDER_CHALLENGE_RANGE, issueChallenge, addFixture } from "./ad-hoc";
