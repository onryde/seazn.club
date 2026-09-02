import "server-only";
import type postgres from "postgres";
import type { Lineup, LineupPair } from "@seazn/engine/core";

type Tx = postgres.TransactionSql;

interface LineupRow {
  entrant_id: string;
  person_id: string;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number | null;
  roles: string[] | null;
  // Shirt number (R8 sweep, WS-SQ). NOT a `lineups` column — it lives on
  // `entrant_members`, which is why both queries below reach it through a
  // LEFT join and why it is nullable twice over (undeclared number, or a
  // lineup row whose person is no longer an entrant member).
  //
  // This loader is the SERVER fold (`append-event.ts`, `fold.ts`,
  // `event-import.ts`, `org-posts.ts`); the pad's own client fold builds the
  // same `LineupPair` through registry.tsx's `toLineupSlot`. The two must
  // agree field for field or the authoritative state and the state on the
  // scorer's screen disagree about the squad — the placer/verifier fork this
  // repo has paid for before. `toLineupSlot` now carries `squadNumber`, so
  // this one has to as well.
  squad_number: number | null;
  // S4 (#428) review round 1, finding 1 — V357. `'player'` is the DB
  // default and the overwhelming common case, so it is never spread onto
  // the built LineupSlot: only a non-player role is present, the same
  // "absent unless it adds information" shape `positionKey`/`roles` already
  // use, and the S3 engine schema's own contract ("OPTIONAL WITH NO
  // `.default()`... Absent ⇒ player", core/types.ts) is what a loader has
  // to respect, not just the wire.
  role: "player" | "coach" | "staff";
}

/** One entrant's slots, from already-fetched rows — shared by the
 *  single-fixture and the batched division loaders below so the two paths
 *  cannot drift into two different LineupSlot shapes. */
function buildLineup(entrantId: string, rows: readonly LineupRow[]): Lineup {
  const mine = rows.filter((r) => r.entrant_id === entrantId);
  return {
    entrantId,
    slots: mine.map((r, i) => ({
      personId: r.person_id,
      slot: r.slot,
      orderNo: r.order_no ?? i + 1,
      ...(r.position_key ? { positionKey: r.position_key } : {}),
      ...(r.roles && r.roles.length > 0 ? { roles: r.roles } : {}),
      ...(r.role !== "player" ? { role: r.role } : {}),
      // Omitted when null, mirroring registry.tsx's `toLineupSlot` and the
      // kernel's own `memberFromSlot` (core/lineup.ts), which omits the key
      // entirely for an undefined slot number. A carried `null` would be a
      // shape neither the engine nor the client fold ever produces.
      ...(r.squad_number != null ? { squadNumber: r.squad_number } : {}),
    })),
  };
}

// Build the [home, away] LineupPair a SportModule.init needs from the fixture's
// lineup rows. `orderNo` must be a positive int (spec 02 §3 LineupSlot); DB
// order_no is nullable, so fall back to append order. A fixture with an
// unassigned side (bye/TBD) cannot be scored — the caller rejects that earlier.
export async function loadLineupPair(
  tx: Tx,
  fixtureId: string,
  homeEntrantId: string,
  awayEntrantId: string,
): Promise<LineupPair> {
  const rows = await tx<LineupRow[]>`
    select l.entrant_id, l.person_id, l.slot, l.position_key, l.order_no, l.roles, l.role,
           em.squad_number
    from lineups l
    left join entrant_members em
      on em.entrant_id = l.entrant_id and em.person_id = l.person_id
    where l.fixture_id = ${fixtureId}
    order by l.order_no nulls last, l.person_id
  `;
  return { home: buildLineup(homeEntrantId, rows), away: buildLineup(awayEntrantId, rows) };
}

/**
 * Every fixture's LineupPair in one division, in ONE query — the batched
 * counterpart `player-stats.ts`'s division-wide recompute needs (S4/#428
 * review round 1, finding 1). An INNER join on `lineups`, so a fixture with
 * NO lineup ever entered simply has no entry in the returned map — the
 * caller's contract (`aggregatePlayerStats`'s `lineups` argument is
 * optional) already treats "no lineups for this fixture" as "don't filter",
 * which is the correct, safe default: a missing team sheet must never
 * silently drop a real player's stats.
 */
interface DivisionLineupRow extends LineupRow {
  fixture_id: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

export async function loadLineupPairsForDivision(
  tx: Tx,
  divisionId: string,
): Promise<Map<string, LineupPair>> {
  const rows = await tx<DivisionLineupRow[]>`
    select f.id as fixture_id, f.home_entrant_id, f.away_entrant_id,
           l.entrant_id, l.person_id, l.slot, l.position_key, l.order_no, l.roles, l.role,
           em.squad_number
    from fixtures f
    join lineups l on l.fixture_id = f.id
    left join entrant_members em
      on em.entrant_id = l.entrant_id and em.person_id = l.person_id
    where f.division_id = ${divisionId}
    order by f.id, l.order_no nulls last, l.person_id
  `;
  // A plain array type, deliberately NOT `typeof rows` (postgres.js's
  // RowList carries query metadata a fresh `[]` cannot structurally satisfy).
  const byFixture = new Map<string, DivisionLineupRow[]>();
  for (const r of rows) {
    (byFixture.get(r.fixture_id) ?? byFixture.set(r.fixture_id, []).get(r.fixture_id)!).push(r);
  }
  const out = new Map<string, LineupPair>();
  for (const [fixtureId, fixtureRows] of byFixture) {
    const home = fixtureRows[0]!.home_entrant_id;
    const away = fixtureRows[0]!.away_entrant_id;
    if (home === null || away === null) continue; // bye/TBD — unscoreable, no lineup to build
    out.set(fixtureId, { home: buildLineup(home, fixtureRows), away: buildLineup(away, fixtureRows) });
  }
  return out;
}
