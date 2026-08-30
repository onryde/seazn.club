// RS009 — `registration_players.source` lives in exactly TWO places and
// nothing in the toolchain connects them.
//
// The values are pinned by a Postgres CHECK constraint
// (`V363__registration_groups_players.sql`, widened by V388) and by the
// `RegistrationPlayerRow["source"]` union in `../registrations`. There is no
// zod enum for this column anywhere — scout swept for one and found nothing —
// so there is no third canonical definition to reconcile them, and no gate
// that notices when only one is updated: `tsc` cannot read a CHECK
// constraint, and Postgres cannot read a TypeScript union.
//
// That asymmetry is the whole reason this file exists. Adding a value to the
// union alone gives you code that compiles and then throws
// `violates check constraint` in production; adding it to the CHECK alone
// gives you a column the reading code cannot narrow. Both failures reach a
// user before any existing test sees them.
//
// This test asserts the two agree, in both directions.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { RegistrationPlayerRow } from "../registrations";

const HAS_DB = !!process.env.DATABASE_URL;

/** The TypeScript side, written out as a value so it can be compared.
 *  `satisfies` ties it to the union: drop a value the union still has and
 *  this array no longer covers it; add one the union lacks and tsc rejects
 *  the file. So the array cannot silently drift from the type it mirrors. */
const TS_SOURCES = ["captain_entered", "self_joined", "organiser_assigned"] as const satisfies
  readonly RegistrationPlayerRow["source"][];

// The other direction: every union member must appear in the array above.
// A `Record` keyed by the union is exhaustive by construction, so adding a
// member to the union without adding it here fails to compile.
const _EXHAUSTIVE: Record<RegistrationPlayerRow["source"], true> = {
  captain_entered: true,
  self_joined: true,
  organiser_assigned: true,
};

describe.skipIf(!HAS_DB)("registration_players.source", () => {
  it("accepts exactly the values the TypeScript union declares", async () => {
    const [{ def }] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
      from pg_constraint where conname = 'registration_players_source_check'`;

    const inDb = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...TS_SOURCES].sort());
  });

  it("rejects a value the union does not contain", async () => {
    // Proves the CHECK is load-bearing rather than merely present — a
    // constraint that permits anything would pass the test above whenever
    // the union happened to list every value it allowed.
    //
    // org_id is supplied because it is NOT NULL: the first version of this
    // test omitted it and failed on `null value in column "org_id"` before
    // reaching the CHECK at all — a red that proved nothing about `source`.
    // The registration_id is deliberately a real one, for the same reason:
    // the FK would otherwise reject the row first and the CHECK would again
    // never be evaluated.
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Source Check', ${`src-${Date.now()}`}) returning id`;
    const [{ id: competitionId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, starts_on, ends_on)
      values (${orgId}, 'C', ${`c-${Date.now()}`}, 'public', '2026-09-15', '2026-09-20')
      returning id`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions
        (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      values (${competitionId}, ${orgId}, 'D', 'd', 'generic', 'score', '{}'::jsonb, 1)
      returning id`;
    const [{ id: groupId }] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, currency)
      values (${competitionId}, 'C', ${`x-${Date.now()}@test.local`}, ${`t-${Date.now()}`}, 'gbp')
      returning id`;
    const [{ id: regId }] = await sql<{ id: string }[]>`
      insert into registrations (group_id, division_id, display_name)
      values (${groupId}, ${divisionId}, 'E') returning id`;

    await expect(
      sql`
        insert into registration_players (registration_id, org_id, full_name, source)
        values (${regId}, ${orgId}, 'Nobody', 'invented_value')`,
    ).rejects.toThrow(/registration_players_source_check|check constraint/i);
  });

  it("ties organiser_assigned to an assignment link, in both directions", async () => {
    // The two halves of one fact (V388). A row claiming organiser_assigned
    // with no link could never be unassigned; a row carrying a link while
    // claiming the captain typed it would lie about how the player got there.
    const [{ def }] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conname = 'registration_players_assigned_from_matches_source'`;
    expect(def).toMatch(/organiser_assigned/);
    expect(def).toMatch(/assigned_from_registration_id/);
  });

  it("allows a solo sign-up to be assigned to only one team", async () => {
    const [idx] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where indexname = 'registration_players_assigned_from_uniq'`;
    expect(idx?.indexdef).toMatch(/UNIQUE/i);
    expect(idx?.indexdef).toMatch(/assigned_from_registration_id/);
  });
});
