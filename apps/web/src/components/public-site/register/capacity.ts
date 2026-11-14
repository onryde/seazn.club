// Registration redesign B3 T12 (spec §4.1) — places. What a division card says about the places it has left, and which entries of a
// cart the server will put on the waiting list. Pure: components render what these functions return and decide nothing themselves.
//
// The one number everything here reads is `remaining` — places left before a new TEAM entry waitlists, against the cap submit
// enforces (min of the organiser's capacity and the plan's per-division limit; server/usecases/registrations/places-left.ts).
// A solo sign-up (`free_agent`) is the exception to all of it: it never takes a team place and is never waitlisted — submit
// refuses a full solo pool instead of queueing it (registration-submit.ts, FP2).
import type { DivisionLike } from "./types";

/** The most places left that still read as "few" (spec §4.1: 1 ≤ remaining ≤ 3), and so get the emphasised line. */
export const FEW_LEFT_MAX = 3;

/** What a division card shows about its places.
 *  - `closed`: the division takes no entries (window, payments, entry kind) — said by its own closed badge, never by a count.
 *  - `waitlist`: open, no place left; an entry joins the waiting list. `waiting` is how many already wait (0 = nobody).
 *  - `few`: 1 to `FEW_LEFT_MAX` left — emphasised.
 *  - `places`: more than that left, and the ORGANISER set a capacity — the plain count.
 *  - `uncapped`: nothing to say. No organiser capacity and not nearly full: the plan limit alone is not news to a visitor (it
 *    would read "256 places left"), so it stays quiet until `few`/`waitlist` (owner ruling, 2026-11-13). */
export type CapacityState =
  | { kind: "closed" }
  | { kind: "waitlist"; waiting: number }
  | { kind: "few"; left: number }
  | { kind: "places"; left: number }
  | { kind: "uncapped" };

/** A division card's capacity state. `inCart` is how many TEAM entries the visitor's cart already holds in this division
 *  (`teamEntriesInCart`): they take places from the page-load count, so 3 left with 1 in the cart shows 2, and the card turns
 *  to the waiting list when the cart has taken the last place. The closed case is decided first. */
export function capacityState(d: Pick<DivisionLike, "open" | "capacity" | "remaining" | "waitlisted">, inCart: number): CapacityState {
  if (!d.open) return { kind: "closed" };
  if (d.remaining === null) return { kind: "uncapped" };
  const left = Math.max(0, d.remaining - Math.max(0, inCart));
  if (left === 0) return { kind: "waitlist", waiting: d.waitlisted ?? 0 };
  if (left <= FEW_LEFT_MAX) return { kind: "few", left };
  return d.capacity !== null ? { kind: "places", left } : { kind: "uncapped" };
}

/** How many entries of `divisionId` in the cart take a team place: every one except a solo sign-up. */
export function teamEntriesInCart(entries: readonly { division_id: string; free_agent?: boolean }[], divisionId: string): number {
  return entries.filter((e) => e.division_id === divisionId && !e.free_agent).length;
}

/** Per entry, in cart order: will submit put it on the waiting list? Submit walks the cart in order and, under the settings lock,
 *  waitlists a team entry once `taken >= hardCap`, counting the earlier entries of the SAME cart that it seated — so the k-th team
 *  entry into a division with `remaining = r` waits exactly when `k > r`. A solo sign-up never waits and takes no place (it is
 *  not counted in k). `remainingById` is the wire's `remaining` per division; a division it does not name, or names as null
 *  (no cap), never waitlists. Only the page-load count is known here: the server stays the authority if it has moved since. */
export function cartWaitlisted(
  entries: readonly { division_id: string; free_agent?: boolean }[],
  remainingById: ReadonlyMap<string, number | null>,
): boolean[] {
  const position = new Map<string, number>();
  return entries.map((entry) => {
    if (entry.free_agent) return false;
    const remaining = remainingById.get(entry.division_id) ?? null;
    if (remaining === null) return false;
    const k = (position.get(entry.division_id) ?? 0) + 1;
    position.set(entry.division_id, k);
    return k > remaining;
  });
}
