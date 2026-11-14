import "server-only";
// The organiser's payment-reminder cap window, in ONE place (registration walk-fix F13). Two readers count the same thing: the press
// itself (`sendPaymentReminder`, organiser-actions: refuse at REMINDER_CAP_PER_DAY) and the hub row (`listRegistrations`,
// `reminders_in_window`: the button is disabled at the cap). A second hand-written copy of the predicate could disagree with the
// first, and the hub would then disable a press the server accepts, or offer one it refuses.
//
// What counts: the organiser's own presses for the entry, i.e. `registration.payment_reminded` audit rows on the entry's competition
// naming it, younger than REMINDER_WINDOW_HOURS. The sweep's reminders write no audit row and never count. Sibling-only (not on the
// barrel).
import type postgres from "postgres";
import { REMINDER_WINDOW_HOURS } from "@/lib/registration-reminder";
import type { AnySql } from "./types";

/** A bound value, or a column reference written as a fragment (`tx\`r.id::text\``) for a correlated read. */
type Operand = string | postgres.PendingQuery<postgres.Row[]>;

/** `(select count(*)::int ...)`: the organiser's presses for `registrationId` (text) in `competitionId` inside the cap's window. */
export function remindersInWindowSql(db: AnySql, competitionId: Operand, registrationId: Operand) {
  return db`(select count(*)::int from competition_events ev
     where ev.competition_id = ${competitionId}
       and ev.type = 'registration.payment_reminded'
       and ev.payload->>'registration_id' = ${registrationId}
       and ev.created_at > now() - make_interval(hours => ${REMINDER_WINDOW_HOURS}))`;
}
