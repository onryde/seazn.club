// Reading a send result (spec "Sending", "Result handling") and dating the next attempt. Pure: no I/O.
//
// The spec's table:
//   2xx                                  -> sent (even when Resend's body carried no id; ruling R8)
//   429, 5xx, timeout, network error     -> retry
//   400, 403, 422 (and any other 4xx)    -> dead at once: retrying cannot help
//   409 concurrent_idempotent_requests   -> retry (the same key is still in flight)
//   409 invalid_idempotent_request       -> dead, and the caller logs it: it means a bug
//   no API key                           -> dead (nothing could ever send it)
//   suppressed                           -> suppressed
// A 409 whose name we do not know retries: the dead name is the one specific reading, and a retry is cheap and safe
// under the same key.
import type { SendResult } from "@/lib/email";
import { RETRY_DELAYS_MS } from "./constants";

export type Verdict = "sent" | "retry" | "dead" | "suppressed";

export const INVALID_IDEMPOTENT_REQUEST = "invalid_idempotent_request";

export function classifyResult(r: SendResult): Verdict {
  if (r.ok) return "sent";
  switch (r.reason) {
    case "suppressed":
      return "suppressed";
    case "no_api_key":
      return "dead";
    case "network":
      return "retry";
    case "http": {
      if (r.status === 429 || r.status >= 500) return "retry";
      if (r.status === 409) return r.errorName === INVALID_IDEMPOTENT_REQUEST ? "dead" : "retry";
      return "dead";
    }
  }
}

/**
 * When to try again after `attemptsMade` attempts (counting the one that just failed): `RETRY_DELAYS_MS[n - 1]` after
 * `from`, or null when every attempt has been spent and the row is dead.
 */
export function nextAttemptAt(attemptsMade: number, from: Date): Date | null {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new RangeError(`nextAttemptAt: ${attemptsMade} is not an attempt number (1 or more)`);
  }
  const delay = RETRY_DELAYS_MS[attemptsMade - 1];
  return delay === undefined ? null : new Date(from.getTime() + delay);
}
