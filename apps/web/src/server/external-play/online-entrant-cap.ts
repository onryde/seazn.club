import "server-only";
// The hard entrant cap of an ONLINE chess division (owner ruling 2026-11-21): min(the plan's `entrants.per_division.max`,
// ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION), on every plan, for a division that plays online (`divisionPlaysOnline`) and for no other.
// Over-the-board chess and every other sport keep the plan's own cap, untouched.
//
// It is a CAPACITY limit, not a plan upsell, and the two refusals differ for exactly that reason:
//   - a plan cap BELOW the online cap (Community's 64) is the one that binds, and an upgrade does lift it: the plan's own 402
//     answers, with its upgrade copy, as it always did;
//   - a plan cap AT OR ABOVE the online cap (or none: null = unlimited) is not what stops the division, and no plan lifts the
//     online cap: ONLINE_DIVISION_FULL answers - a 422 with its own code, never the plan-limit 402, never upgrade wording.
// The tie goes to the online cap (a plan of exactly 128, an Event Pass's 128): there an upgrade would change nothing.
//
// Every door that grows an online division's entrant count asks through here, by the same arithmetic: createEntrants
// (usecases/entrants.ts), the public sign-up's waitlist threshold and the places-left count (registration-submit.ts,
// registrations/settings.ts), the organiser's promote / confirm / waive room check (registrations/waitlist.ts), the registration
// capacity a save may promise (registrations/settings.ts), and the one door that makes a division online (usecases/divisions.ts).
import { HttpError } from "@/lib/errors";
import { assertWithinLimit } from "@/lib/entitlements";
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";
import { divisionPlaysOnline } from "./online-play";

/** Does the ONLINE cap, rather than the plan, decide how many entrants this division holds? True for a division that plays online
 *  when the plan cap is absent (unlimited) or no lower than the online cap. */
export function onlineCapBinds(online: boolean, planCap: number | null): boolean {
  return online && (planCap === null || planCap >= ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION);
}

/** The most entrants the division may hold: the plan's cap, and for an online chess division no more than the online cap.
 *  null = no cap at all (unlimited plan, division not online). */
export function effectiveEntrantCap(online: boolean, planCap: number | null): number | null {
  if (!online) return planCap;
  return planCap === null ? ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION : Math.min(planCap, ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION);
}

/** The refusal of a door that would put an online chess division past its cap: 422 ONLINE_DIVISION_FULL, carrying `limit`. */
export function onlineDivisionFullError(): HttpError {
  return new HttpError(
    422,
    `Online chess divisions hold up to ${ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION} entrants.`,
    ONLINE_DIVISION_FULL,
    { limit: ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION },
  );
}

/** The entrant door: the division would hold `wouldBe` entrants after this write. Refuses past the effective cap - by the plan's 402 when
 *  the plan binds (a lower cap than the online one, or the division is not online), by ONLINE_DIVISION_FULL when the online cap binds. */
export function assertEntrantRoom(
  division: { sport_key: string; config: unknown },
  planCap: number | null,
  wouldBe: number,
): void {
  if (onlineCapBinds(divisionPlaysOnline(division), planCap)) {
    if (wouldBe > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION) throw onlineDivisionFullError();
    return;
  }
  assertWithinLimit(planCap, "entrants.per_division.max", wouldBe);
}

/** The door that turns online play ON: a division already holding more than an online chess division may is refused, 422
 *  ONLINE_PLAY_TOO_MANY_ENTRANTS (`limit`, `entrants`). Its own code and sentence: the organiser's way out is removing entrants,
 *  which "full" would not say. */
export function assertOnlinePlayFits(entrants: number): void {
  if (entrants > ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION) {
    throw new HttpError(
      422,
      `This division has ${entrants} entrants, and online chess divisions hold up to ${ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION}. Remove entrants before turning online play on.`,
      ONLINE_PLAY_TOO_MANY_ENTRANTS,
      { limit: ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION, entrants },
    );
  }
}
