import "server-only";
// Places left before a new team entry joins the waiting list: the public register panel's count (see ./index.ts).
//
// It must be the cap submit enforces (registration-submit.ts, `hardCap` under the settings lock): the division's own
// capacity, the plan's per-division entrant limit (`entrants.per_division.max`) or the format's max entrants, whichever is
// tightest. Counting capacity alone (registration redesign spec, false premise FP3) showed "places left" on a division already
// at its plan limit, and submit then waitlisted the entry. W5 B4 (stress F8; owner 2026-11-21): the format's max is the largest
// field the division's first stage can start (`lib/format-max-entrants.ts`), the same on every plan.

export interface PlacesLeftInput {
  /** The division's own capacity. null = the organiser set none; 0 is a real cap. */
  capacity: number | null;
  /** `getLimit(org, "entrants.per_division.max", competition)`. null = unlimited; 0 is a real limit. */
  planLimit: number | null;
  /** The division's format max entrants (`divisionFormatMaxes`). null = no format yet, or one no field bounds. */
  formatMax: number | null;
  /** Team entries holding a place (SPOT_HOLDERS, `free_agent = false`). A solo sign-up never takes one (RS012). */
  active: number;
}

/** null = no cap at all (none is set). Never below 0: a plan lowered (or a format changed) under the entries already in reads as full. */
export function placesLeft({ capacity, planLimit, formatMax, active }: PlacesLeftInput): number | null {
  const hardCap = Math.min(capacity ?? Number.POSITIVE_INFINITY, planLimit ?? Number.POSITIVE_INFINITY, formatMax ?? Number.POSITIVE_INFINITY);
  return Number.isFinite(hardCap) ? Math.max(0, hardCap - active) : null;
}

export type PromotionVerdict =
  | { kind: "ok" }
  /** The division's OWN capacity is met (or passed): an organiser may promote anyway, after confirming. */
  | { kind: "over_capacity"; capacity: number; active: number }
  /** The PLAN's per-division entrant limit is met (or passed): never promotable, confirmed or not. */
  | { kind: "plan_limit"; limit: number; active: number }
  /** The FORMAT's max entrants is met (or passed): never promotable, confirmed or not, on any plan. */
  | { kind: "format_max"; max: number; active: number };

/** Whether an ORGANISER's manual promotion off the waitlist may seat one more team entry (registration defects, item 1). A promotion
 *  adds one place, so it passes the plan's limit when `active >= planLimit` and the division's capacity when `active >= capacity`.
 *  The plan is judged first: it is the limit sign-up itself honours (`placesLeft`, submit's `hardCap`), and no confirmation lifts it.
 *  `active` is the count `placesLeft` takes - team entries holding a place, never a solo sign-up. Automatic promotion (a withdrawal,
 *  rejection or expiry freeing a place) does not ask: it fills a place that was just made. */
export function promotionVerdict({ capacity, planLimit, formatMax, active }: PlacesLeftInput): PromotionVerdict {
  // W5 B4: the format's max first - no plan raises it, so the plan's "raise the plan" would send an organiser the wrong way.
  if (formatMax !== null && active >= formatMax) return { kind: "format_max", max: formatMax, active };
  if (planLimit !== null && active >= planLimit) return { kind: "plan_limit", limit: planLimit, active };
  if (capacity !== null && active >= capacity) return { kind: "over_capacity", capacity, active };
  return { kind: "ok" };
}
