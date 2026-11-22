import "server-only";
// W5 B4 (stress F8; owner 2026-11-21): each division's FORMAT max entrants, the third term of the cap sign-up honours
// (./places-left.ts). The max is the largest field the division's FIRST stage can start inside the measured Start line budget
// (`lib/format-max-entrants.ts`, the real generators' count), the same on every plan; null for a division with no stage yet or
// a first stage whose start no field bounds (a ladder, an americano).
import { formatMaxEntrants } from "@/lib/format-max-entrants";
import type { AnySql } from "./types";

/** Every division of `divisionIds` to its format's max entrants, in one read. EMPTY CASE FIRST: no division, no statement. */
export async function divisionFormatMaxes(db: AnySql, divisionIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(divisionIds.map((id) => [id, null]));
  if (divisionIds.length === 0) return out;
  const firsts = await db<{ division_id: string; kind: string; config: unknown }[]>`
    select distinct on (division_id) division_id, kind, config
      from stages where division_id in ${db([...divisionIds])} order by division_id, seq`;
  for (const first of firsts) out.set(first.division_id, formatMaxEntrants(first));
  return out;
}
