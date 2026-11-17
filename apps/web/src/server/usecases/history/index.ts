import "server-only";
// Schedule undo/versioning use-cases (Jul3/03 §6): undo/redo/history,
// checkpoints + restore, scoped clear, remove-teams-in-pool. The pure
// mechanics live in @seazn/engine/history — this module appends the returned
// event under the division aggregate lock and syncs the fixture tables.
//
// The map (split from history.ts; MODULARIZATION.md):
//   ledger.ts          the division ledger: load it, read the division's seq/watermark, append an event, engine-error mapping
//   barriers.ts        the undo barriers (late entry, seed confirm...) and the ledger-row readers a step needs (Pair next rows)
//   restore.ts         put fixture rows back from a ledger snapshot (`restoreFixtures`), court writes, delete-side events
//   execute.ts         run one history event against the fixture tables
//   undo-redo.ts       one Undo or Redo step: its transaction (`stepWrite`), its publish, `undoDivision` / `redoDivision`
//   queries.ts         read paths: the history listing and the schedule state at the watermark
//   checkpoints.ts     save points: list, create, delete, restore
//   schedule-edits.ts  scoped clear, remove-teams-in-pool, division locks
export { UNDO_BARRIER_TYPES, barrierOfRefusedStep, invertedStepSeq, recordedPairingOverride, undoBarrierRefusal } from "./barriers";
export type { UndoBarrierType } from "./barriers";
export { HistoryStepInput, redoDivision, undoDivision } from "./undo-redo";
export type { HistoryStepOut } from "./undo-redo";
export { divisionHistory, scheduleStateAt } from "./queries";
export type { HistoryRow } from "./queries";
export { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints";
export type { CheckpointKind, CheckpointRow } from "./checkpoints";
export { ClearScheduleInput, LockInput, clearPoolEntrants, clearScheduleScoped, setDivisionLocks } from "./schedule-edits";
