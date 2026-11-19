// W5 app PR A, Task 22 (ST-G23, ST-G28): the three fields every standings row of the API carries beyond the engine's ledger - the
// entrant's `name`, her `status`, and the `pool` key the row's rank is within. Pure (no DB, no `server-only`): the private route's usecase
// and the public document builder each read their own entrants (the organiser's rows; the public view through the division's name
// mask) and hand them here, so the two doors can never disagree about what a departed entrant's row says.
import { DEPARTED_STATUS_KEYS } from "@/lib/departed-status-keys";

/** What a door knows about one entrant of the division: the name it is allowed to print, and the stored status. */
export interface WireEntrant {
  name: string;
  status: string;
}

/** `active`, or the departed word. The departed vocabulary is `DEPARTED_STATUS_KEYS` (one authority); every other stored status
 *  (registered, confirmed, ...) is a competing entrant. */
export function wireStatus(status: string | undefined): "active" | (typeof DEPARTED_STATUS_KEYS)[number] {
  return (DEPARTED_STATUS_KEYS as readonly string[]).includes(status ?? "") ? (status as (typeof DEPARTED_STATUS_KEYS)[number]) : "active";
}

/** A stored row as the API serves it: the engine row plus `name`, `status`, `pool`. A row whose entrant the division no longer holds
 *  (a delete that raced the read) is `name: null`, `active` - declared in the schema, never a thrown 500 on a read. */
export function wireStandingsRows<R extends { entrantId: string }>(
  rows: readonly R[],
  entrants: ReadonlyMap<string, WireEntrant>,
  pool: string | null,
): (R & { name: string | null; status: "active" | (typeof DEPARTED_STATUS_KEYS)[number]; pool: string | null })[] {
  return rows.map((row) => {
    const entrant = entrants.get(row.entrantId);
    return { ...row, name: entrant?.name ?? null, status: wireStatus(entrant?.status), pool };
  });
}
