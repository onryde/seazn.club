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
