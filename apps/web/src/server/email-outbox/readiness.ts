import "server-only";
// Is this box able to queue email at all? `sealBody` answers per email (and a refusal rolls the caller's transaction back,
// so the first symptom of a missing outbox key is a user who cannot sign in). This answers once, at boot, from the same
// rule (`outboxKeyProblem`), so the fault is in the log and in Sentry BEFORE a user meets it.
//
// It logs and returns; it does not throw. A missing key breaks queueing, not the whole app, and refusing to boot would turn
// one secret that was not set on a deployment into an outage of every page (the relay's mode check chooses that for a
// fake-live stream; here a log line and an alert are the proportionate answer).
import { log } from "@/server/logger";
import { outboxKeyProblem, type OutboxKeyProblem } from "./seal";

/** What each problem means to the person reading the log. Names the variable, never a value. */
const WHAT: Record<OutboxKeyProblem, string> = {
  unset:
    "RESEND_API_KEY is set but EMAIL_OUTBOX_KEK is unset or malformed (64 hex characters): every email the outbox is asked to " +
    "queue will be refused, so every action that sends email will fail until it is set",
  sample:
    "EMAIL_OUTBOX_KEK is the sample key published in apps/web/.env.example, which is refused under NODE_ENV=production: " +
    "every email the outbox is asked to queue will be refused, so every action that sends email will fail until a key of its own is set",
};

/** The message a report carries (also what the boot hook hands to Sentry). */
export const outboxReadinessMessage = (problem: OutboxKeyProblem): string => `email outbox is not ready: ${WHAT[problem]}`;

/**
 * Called once from instrumentation.ts's register(). Logs one error line when the box cannot queue email and returns the
 * problem (null when it can), so the caller can alert on it too. Logs nothing when ready.
 */
export function reportOutboxReadiness(): OutboxKeyProblem | null {
  const problem = outboxKeyProblem();
  if (problem) log.error({ problem }, outboxReadinessMessage(problem));
  return problem;
}
