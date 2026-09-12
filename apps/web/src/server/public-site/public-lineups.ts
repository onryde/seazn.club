// Spectator surface W1, Task 5 — the public, consent-gated lineup reader for
// the match-centre document. Public surface: takes a bare `Sql` client (no
// AuthCtx, no tenant scoping — callers are responsible for confirming the
// fixture/division are public before calling this).
//
// SQL join shape copied from `readLineup` (server/usecases/fixtures.ts:397-412)
// — same `lineups l join persons p on p.id = l.person_id`, same `order_no`
// column — but WITHOUT its auth (`withTenant`/RLS), and joining `persons.consent`
// instead of `entrant_members.squad_number`. Consent-loading convention copied
// from `maskPublicEntrantNames` (server/public-site/data.ts:510-599): read
// `p.consent` alongside `full_name`, filter `p.merged_into is null` so a
// tombstoned/merged duplicate's stale consent never counts, and resolve through
// the single shared `resolvePersonDisplayName` — never a second resolver.
import postgres from "postgres";
import { resolvePersonDisplayName } from "@/lib/name-display";

export type Sql = ReturnType<typeof postgres>;

/** The division-level consent inputs `resolvePersonDisplayName` needs — same
 *  shape as `maskPublicEntrantNames`'s own `division` parameter. */
export type DivisionConsentCtx = { youth?: boolean; player_name_display?: string | null };

/** `slot` is carried because the TIMELINE REPLAY needs it. `toLineupPair`
 *  (match-centre.ts) used to stamp every member "starting", which put the
 *  substitutes on the field before kick-off — so the first `football.sub` the
 *  replay reached threw "<name> is already on the field", the derived pass
 *  stopped there, and every set/period line after it vanished with no visible
 *  trace. Measured on a seeded 2–1: the whole timeline rendered, and the
 *  "End of 1st half — 1–1" rung was simply absent. */
export type PublicPerson = {
  personId: string;
  name: string;
  masked: boolean;
  slot: "starting" | "bench";
};

export async function readPublicLineups(
  sql: Sql,
  fixtureId: string,
  division: DivisionConsentCtx,
): Promise<Record<string, PublicPerson[]>> {
  const rows = await sql<
    {
      entrant_id: string;
      person_id: string;
      full_name: string;
      slot: string | null;
      consent: { public_name?: boolean } | null;
    }[]
  >`
    select l.entrant_id, l.person_id, p.full_name, l.slot, p.consent
    from lineups l
    join persons p on p.id = l.person_id
    where l.fixture_id = ${fixtureId} and p.merged_into is null
    order by l.entrant_id, l.order_no nulls last, p.full_name`;

  const byEntrant: Record<string, PublicPerson[]> = {};
  for (const row of rows) {
    const name = resolvePersonDisplayName(
      row.full_name,
      row.consent,
      division.player_name_display ?? null,
      division.youth ?? false,
    );
    const list = byEntrant[row.entrant_id] ?? [];
    list.push({
      personId: row.person_id,
      name,
      masked: name !== row.full_name,
      // Anything that is not the string "bench" is a starter. The column is
      // `starting`/`bench` today; defaulting the unknown to "starting" keeps a
      // null or a value added later on the field rather than silently benching
      // someone the ledger then uses.
      slot: row.slot === "bench" ? "bench" : "starting",
    });
    byEntrant[row.entrant_id] = list;
  }
  return byEntrant;
}
