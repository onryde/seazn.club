// The email outbox's public surface. No logic here: callers import from "@/server/email-outbox".
export * from "./constants";
export { OutboxExpiryTooLongError, enqueueEmail, extendEmailExpiry, type OutboxMessage } from "./enqueue";
export { latestEmailStatus, purgeOldEmails, type EmailStatusRow, type PurgeOptions } from "./status";
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
export { OutboxKeyUnavailableError, outboxKeyProblem, type OutboxKeyProblem } from "./seal";
export { classifyResult, nextAttemptAt, type Verdict } from "./classify";
export { outboxRoleOk } from "./role-check";
export { PROVIDER_EVENT_STATUS, applyProviderEvent, type ProviderEventResult, type ProviderEventType } from "./provider-events";
