// An organiser's manual "Promote from waitlist" can run past a division's capacity. Dependency-free, so the server usecase (the two
// refusals) and the client island (the confirm, the plan-limit sentence) read ONE code each, never a second hand-kept copy.

/** 409: the division is at or over its OWN capacity. The organiser may promote anyway: resend with `confirm_over_capacity: true`. */
export const PROMOTE_OVER_CAPACITY_CODE = "PROMOTE_OVER_CAPACITY";
/** 422: the PLAN's per-division entrant limit is met. Never lifted by a confirmation; the error body carries `limit`. */
export const PROMOTE_PLAN_LIMIT_CODE = "PROMOTE_PLAN_LIMIT";
