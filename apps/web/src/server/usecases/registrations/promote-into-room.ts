import "server-only";
// Promote the waitlist into the room a bigger Online Chess size just made (spec 2026-11-23-online-chess-credits-design.md P18, §7.4
// item 2/3, §11): "Moving up a size promotes the waitlist into the new room, by the same automatic promotion a freed place triggers."
//
// Called AFTER the commit that moved the size up - the pay door (`payOnlinePackage`) and the unpaid size save (`patchDivision`) - never
// inside it: the size is a committed fact before anybody is promoted against it, and a promotion that fails must not undo a payment.
//
// THE SAME PROMOTION A FREED PLACE TRIGGERS: `promoteOldestWaitlisted`, the helper a withdrawal, an expiry and a rejection call, with the
// seat gate those open (`openPromotionSeatGate`) and the mail they send (`notifyPromoted`). What differs is only HOW MANY: a freed place
// is one place, a size can be many, so this asks the same question before each one - is there room for one more? - and stops at the
// first "no". The question is the organiser's own room check (`assertOrganiserPromotionHasRoom`): the format's max, the three lines of
// the online cap (the plan's, the size, 256), the plan's per-division limit, and the division's OWN registration capacity - so a
// capacity the organiser set below the new size is respected (they promised that many), and a queue that is already as long as the room
// ends the loop. One transaction per promotion: each is its own commit, so a failure in the Nth leaves the first N-1 promoted and
// the rest waiting, exactly as the same number of withdrawals would.
//
// Where registration needs the organiser's approval, a promotion moves the entry to `pending` for them to approve - what the same
// freed place does today - and nothing is confirmed on their behalf (`promoteWaitlistedRow` decides, never this).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION, ONLINE_DIVISION_FULL } from "@/lib/online-chess";
import { PROMOTE_OVER_CAPACITY_CODE, PROMOTE_PLAN_LIMIT_CODE } from "@/lib/registration-promote";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { log } from "@/server/logger";
import { lockForPromotionCap, openOnlineCapGuard, readPlanLimit } from "@/server/external-play/online-entrant-cap";
import { audit } from "../audit";
import type { RegistrationWithGroupRow } from "./types";
import { divisionCtx, fallbackOrigin, loadSettings } from "./lookups";
import {
  assertOrganiserPromotionHasRoom,
  notifyPromoted,
  openPromotionSeatGate,
  promoteOldestWaitlisted,
} from "./waitlist";

/** The refusals of the room check that mean "no room for one more" - the end of the loop, not a failure. Every other error is one. */
const NO_ROOM_CODES: ReadonlySet<string> = new Set([
  ONLINE_PACKAGE_CODES.sizeFull,
  ONLINE_DIVISION_FULL,
  PROMOTE_PLAN_LIMIT_CODE,
  PROMOTE_OVER_CAPACITY_CODE,
  "FORMAT_TOO_MANY_ENTRANTS", // the format's own max (`formatMaxPromotionRefusal`: the code the draw doors use)
]);

/** Promote waitlisted registrants of `divisionId` while it has room, oldest first, after its size moved up. Answers the ids promoted
 *  (none: no waitlist, no room, no registration settings, or nobody the seat gate lets in). At most one pass of the division's cap:
 *  the loop is bounded by the largest division an online chess size can hold, never by what the queue happens to contain. */
export async function promoteIntoNewRoom(divisionId: string, actorId: string | null): Promise<string[]> {
  const settings = await loadSettings(sql, divisionId);
  if (settings === null) return []; // no registration here: nobody can be waiting
  const ctx = await divisionCtx(sql, divisionId);
  // Opened out here, before the transactions (entitlement and link reads cannot run inside one), as every automatic promotion does.
  const seatGate = await openPromotionSeatGate(divisionId, settings);
  const capGuard = await openOnlineCapGuard(divisionId);
  const planLimit = capGuard === undefined ? null : readPlanLimit(capGuard);
  const promoted: RegistrationWithGroupRow[] = [];
  // Whoever the seat gate passes over stays passed over for the places after: one skip is one ledger row and one mail, not one per place.
  const passedOver: string[] = [];
  try {
    for (let place = 0; place < ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION; place++) {
      const one = await sql.begin(async (tx) => {
        if (seatGate) await seatGate.load(tx); // a superuser transaction: the link read needs no prelude
        // The division lock before any registration or entrant row is written (online-entrant-cap.ts: registration row -> `division:`
        // -> entrants; this promotion locks the waitlisted row only after it, as a withdrawal's does).
        await lockForPromotionCap(tx, divisionId, capGuard);
        try {
          await assertOrganiserPromotionHasRoom(tx, divisionId, { planLimit, confirmOverCapacity: false });
        } catch (err) {
          // Reads and locks only: nothing was written, so the transaction is whole and the answer is simply "no more room".
          if (err instanceof HttpError && err.code !== undefined && NO_ROOM_CODES.has(err.code)) return null;
          throw err;
        }
        const next = await promoteOldestWaitlisted(tx, divisionId, settings, undefined, seatGate, undefined, passedOver);
        if (next === null) return null; // nobody waiting (or nobody the seat gate lets in)
        await audit(tx, ctx.competition_id, ctx.org_id, "registration.promoted", {
          registration_id: next.id,
          from: "waitlist",
          reason: "online_size_up",
        }, actorId);
        return next;
      });
      if (one === null) break;
      promoted.push(one);
    }
  } finally {
    // Every promotion that COMMITTED is announced even when a later place threw: each is its own commit, so the registrant already holds
    // the place (a card division's pay window is running) and the public pages already differ. The error then goes on to the caller.
    await announce(promoted, divisionId, ctx, settings);
  }
  return promoted.map((p) => p.id);
}

/** The after-commit half of a promotion: the log line, the public pages and each registrant's notice. Never throws - it runs in a
 *  `finally`, where a throw would hide the error that got us there (`notifyPromoted` and `fireDivisionRevalidate` already swallow their
 *  own failures; this is the belt over them). */
async function announce(
  promoted: RegistrationWithGroupRow[],
  divisionId: string,
  ctx: Awaited<ReturnType<typeof divisionCtx>>,
  settings: NonNullable<Awaited<ReturnType<typeof loadSettings>>>,
): Promise<void> {
  if (promoted.length === 0) return;
  try {
    log.info({ divisionId, promoted: promoted.length }, "registrations: waitlist promoted into the room a bigger Online Chess size made");
    fireDivisionRevalidate(divisionId, ctx.competition_id);
    // Queued, not awaited one by one: `notifyPromoted` swallows its own failures (a promotion mail must never undo the promotion), so
    // waiting for the lot only means the registrants' notices are on the outbox when the payment that made the room returns.
    await Promise.all(promoted.map((p) => notifyPromoted(p, ctx, settings, fallbackOrigin(), { firstAttempt: "request" })));
  } catch (err) {
    log.error({ err, divisionId }, "registrations: announcing the promotions into a bigger Online Chess size failed");
  }
}
