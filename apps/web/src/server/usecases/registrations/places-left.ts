import "server-only";
// Places left before a new team entry joins the waiting list: the public register panel's count (see ./index.ts).
//
// It must be the cap submit enforces (registration-submit.ts, `hardCap` under the settings lock): the division's own
// capacity or the plan's per-division entrant limit (`entrants.per_division.max`), whichever is tighter. Counting
// capacity alone (registration redesign spec, false premise FP3) showed "places left" on a division already at its plan
// limit, and submit then waitlisted the entry.

export interface PlacesLeftInput {
  /** The division's own capacity. null = the organiser set none; 0 is a real cap. */
  capacity: number | null;
  /** `getLimit(org, "entrants.per_division.max", competition)`. null = unlimited; 0 is a real limit. */
  planLimit: number | null;
  /** Team entries holding a place (SPOT_HOLDERS, `free_agent = false`). A solo sign-up never takes one (RS012). */
  active: number;
}

/** null = no cap at all (neither is set). Never below 0: a plan lowered under the entries already in reads as full. */
export function placesLeft({ capacity, planLimit, active }: PlacesLeftInput): number | null {
  const hardCap = Math.min(capacity ?? Number.POSITIVE_INFINITY, planLimit ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(hardCap) ? Math.max(0, hardCap - active) : null;
}

export type PromotionVerdict =
  | { kind: "ok" }
  /** The division's OWN capacity is met (or passed): an organiser may promote anyway, after confirming. */
  | { kind: "over_capacity"; capacity: number; active: number }
  /** The PLAN's per-division entrant limit is met (or passed): never promotable, confirmed or not. */
  | { kind: "plan_limit"; limit: number; active: number };

/** Whether an ORGANISER's manual promotion off the waitlist may seat one more team entry (registration defects, item 1). A promotion
 *  adds one place, so it passes the plan's limit when `active >= planLimit` and the division's capacity when `active >= capacity`.
 *  The plan is judged first: it is the limit sign-up itself honours (`placesLeft`, submit's `hardCap`), and no confirmation lifts it.
 *  `active` is the count `placesLeft` takes - team entries holding a place, never a solo sign-up. Automatic promotion (a withdrawal,
 *  rejection or expiry freeing a place) does not ask: it fills a place that was just made. */
export function promotionVerdict({ capacity, planLimit, active }: PlacesLeftInput): PromotionVerdict {
  if (planLimit !== null && active >= planLimit) return { kind: "plan_limit", limit: planLimit, active };
  if (capacity !== null && active >= capacity) return { kind: "over_capacity", capacity, active };
  return { kind: "ok" };
}
