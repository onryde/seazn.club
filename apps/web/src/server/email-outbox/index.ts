// The email outbox's public surface. No logic here: callers import from "@/server/email-outbox".
export * from "./constants";
export { enqueueEmail, type OutboxMessage } from "./enqueue";
export {
  attemptClaimed,
  dispatchNow,
  endedRowFor,
  toClaimedRow,
  type AttemptOutcome,
  type AttemptResult,
  type ClaimedRecord,
  type ClaimedRow,
} from "./attempt";
export { KIND_HOOKS, afterEndedBadly, type EndedRow, type KindHook } from "./hooks";
export { OutboxKeyUnavailableError } from "./seal";
export { classifyResult, nextAttemptAt, type Verdict } from "./classify";
export { outboxRoleOk } from "./role-check";
