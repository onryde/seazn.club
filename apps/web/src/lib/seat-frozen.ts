// An org admin whose seat the plan's member limit has paused (doc 10 §2.4, auth.ts `requireOrgAuth`) is refused every write-scoped
// route with a 402 PAYMENT_REQUIRED whose `feature_key` is `members.max` (api-v1/http.ts). Client-safe: no imports. Task 33e: the
// stream panel's two polls read that refusal to stop asking, and say why.

/** The feature a paused seat's 402 names — the one `requireOrgAuth` throws (`new PaymentRequiredError("members.max")`). */
export const FROZEN_SEAT_FEATURE = "members.max";

/** True for the paused-seat refusal, read STRUCTURALLY off an `ApiV1Error` (lib/client-v1.ts): status 402, code
 *  PAYMENT_REQUIRED, `extra.feature_key` the frozen seat. A 402 for any other feature (an upgrade gate), another status, a
 *  network error and a non-object are all false — only this refusal means "asking again can never succeed". */
export function isSeatFrozenError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { status, code, extra } = err as { status?: unknown; code?: unknown; extra?: unknown };
  if (status !== 402 || code !== "PAYMENT_REQUIRED") return false;
  return typeof extra === "object" && extra !== null && (extra as { feature_key?: unknown }).feature_key === FROZEN_SEAT_FEATURE;
}
