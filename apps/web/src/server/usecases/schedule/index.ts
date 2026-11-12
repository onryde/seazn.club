import "server-only";
// Scheduling console use-cases (doc 12, PROMPT-17): schedule-settings PUT,
// the pure auto pass (propose only), transactional apply, single-fixture move,
// full-board validation, publish, and the division start action. The engine
// stays pure — this module converts DB rows ↔ engine inputs (epoch ms) and
// owns every persist.
//
// This folder replaces the single `schedule.ts` module; importers keep
// `from "@/server/usecases/schedule"` and land here. The barrel re-exports
// exactly the names that file exported, no more (src/server/MODULARIZATION.md).
//
//   types.ts          shapes shared by the siblings: Tx, settings, FixtureLite, round fields
//   helpers.ts        epoch-ms and ISO conversions, minute rounding
//   after-write.ts    afterScheduleWrite: the cache + push invalidation every write fires
//   board.ts          fixture statuses that move or hold a court, the fixture-row read, lookups, locks, the seq guard
//   settings.ts       schedule settings: PUT, GET and the internal loader
//   rounds.ts         round-sequence stage kinds and the per-stage round rules
//   engine-inputs.ts  DB rows -> engine inputs: assignments, slot config, verify config
//   conflicts.ts      engine reasons -> API conflict codes, and the full-board validation
//   solver-tuning.ts  the auto pass's wall-clock budget, cooldown, window bound and day spread
//   reflow.ts         the reflow pass over an already-placed board
//   auto.ts           autoSchedule: the propose-only auto pass
//   apply.ts          applySchedule (transactional persist) and lastAiApply
//   move.ts           moveFixture: the single-fixture drag-and-drop move
//   publish.ts        publishSchedule and startDivision (its status transaction: startDivisionInTx): both take a division live
export type { ScheduleSettingsOut, FixtureLite, RoundFields, RoundSequenceStages } from "./types";
export { afterScheduleWrite, SCHEDULE_FIXTURE_PUSH_CAP } from "./after-write";
export {
  MOVABLE_STATUS,
  OCCUPYING,
  FIXED_OCCUPYING,
  isMovable,
  heldInPlace,
  movableFixtureSql,
  PLAYED_MOVE_MESSAGE,
  scopeLocked,
  divisionLockState,
  divisionFixtures,
  courtNamesById,
  venueNamesById,
  courtVenueIds,
  peopleByEntrant,
  peopleOf,
  lockedFixtureIds,
  assertFreshSeq,
} from "./board";
export type { LockedScope } from "./board";
export { putScheduleSettings, getScheduleSettings, loadSettings } from "./settings";
export type { ScheduleSettingsWire } from "./settings";
export {
  ROUND_ROBIN_STAGE_KINDS,
  ROUND_SEQUENCE_STAGE_KINDS,
  roundRobinStageIds,
  roundBarrierFor,
  perPlayerDailyCap,
  roundFieldsFor,
  roundRulesOf,
  roundFieldsOf,
  roundRobinSequenceKey,
  roundRobinSequenceSiblings,
} from "./rounds";
export {
  toAssignment,
  feedDependencies,
  siblingAssignments,
  toSlotConfig,
  rowToRuleFixture,
  toVerifyConfig,
  verifyConfigForDivision,
  applyWindow,
} from "./engine-inputs";
export type { SiblingBoard } from "./engine-inputs";
export { withCourtNames, validateSchedule } from "./conflicts";
export {
  autoSolverWallMs,
  autoScheduleCooldown,
  boundSolverWindow,
  withDefaultDaySpread,
} from "./solver-tuning";
export { TIERS_TOTAL, autoSchedule } from "./auto";
export type { AutoScheduleOut } from "./auto";
export { applySchedule, lastAiApply } from "./apply";
export type { ApplyScheduleOut } from "./apply";
export { moveFixture } from "./move";
export type { MoveInput } from "./move";
export {
  PUBLISH_BLOCKED,
  PUBLISH_UNACKNOWLEDGED,
  PUBLISH_ALREADY_LIVE,
  publishSchedule,
  startDivision,
  startDivisionInTx,
} from "./publish";
export type { PublishScheduleOut, StartDivisionOut } from "./publish";
