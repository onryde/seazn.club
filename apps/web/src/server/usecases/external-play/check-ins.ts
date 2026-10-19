import "server-only";
// The counted check-ins of a board (spec §7.2): who CAME, judged against the board's own window. A leaf, so the seat
// (preflight, which the room imports) and the create (which the room imports) read it without a cycle; room.ts re-exports it
// as `checkIns` for T13's no-show sweep.
import { sql } from "@/lib/db";
import { checkInCounts, type BoardAnchor } from "@/server/external-play/window";
import type { OnlinePlayFixture, SidePlayer } from "./guard";

/** Check-in state for both sides, scoped by fixture_id AND the two resolved
 *  person ids, judged against the open's window. Exported for T13's no-show
 *  sweep, which must judge "who came" by exactly this reading. */
export async function countedCheckIns(
  f: OnlinePlayFixture,
  home: SidePlayer,
  away: SidePlayer,
  anchor: BoardAnchor | null,
): Promise<{ home: boolean; away: boolean }> {
  // An unopened round has no window, so no check-in can count toward it —
  // and one stamped during a PREVIOUS round's window must not either (D12).
  if (anchor === null) return { home: false, away: false };
  const ids = [home.personId, away.personId].filter((p): p is string => p !== null);
  const rows =
    ids.length === 0
      ? []
      : await sql<{ person_id: string; checked_in_at: Date | null }[]>`
          select person_id, checked_in_at from fixture_availability
           where fixture_id = ${f.fixtureId}
             and person_id in ${sql(ids)}`;
  const at = (p: string | null) => (p === null ? null : (rows.find((r) => r.person_id === p)?.checked_in_at ?? null));
  return {
    home: checkInCounts(at(home.personId), anchor),
    away: checkInCounts(at(away.personId), anchor),
  };
}
