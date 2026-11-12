// The organiser's "Send payment reminder" limits. Dependency-free so the server usecase (the cap) and the client island (the
// "really send another?" confirm) read ONE number each, never a second hand-kept copy.

/** The cap: this many presses per entry in any rolling 24 h, then a 429 PAYMENT_REMINDER_LIMIT. */
export const REMINDER_CAP_PER_DAY = 5;
/** The client asks "really send another?" when the last press is younger than this. */
export const REMINDER_CONFIRM_WITHIN_MS = 60 * 60_000;
/** The error code the 429 carries; the client says the limit in its own language off this. */
export const REMINDER_LIMIT_CODE = "PAYMENT_REMINDER_LIMIT";
