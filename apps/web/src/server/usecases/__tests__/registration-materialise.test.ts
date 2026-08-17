// RS002 wave 3 — four `materialise` gaps closed by this session (design §6,
// owner ruling 5, `_INDEX.md` "Person get-or-create does NOT dedupe on name
// alone" / "New persons are created with consent..." / "materialise gains
// the pair branch" / "materialise writes registration_players.person_id"):
//
//  1. A player row with NO user_id reuses an existing person only when the
//     row carries a dob AND exactly one non-merged, player-lane person in
//     the org matches on (lower(trim(full_name)), dob) — zero or 2+ matches
//     mint a new person instead of guessing.
//  2. Newly created persons get consent.public_name = true; a REUSED
//     person's own consent (including an opt-out) is never touched.
//  3. `registration_players.person_id` is written for every resolved row.
//  4. `pair` entrant_kind materialises both players, carrying squad_number
//     and is_captain.
//
// Real Postgres required; skipped without DATABASE_URL. Uses the shared
// `seedOrg`/`makeUser` from `./_seed` (same helpers registration-user-link
// and persons-identity tests use) plus a local direct-SQL fixture for the
// V363/V364 shape, since `submitRegistration` is deleted (RS001 demolition)
// — see registration-user-link.test.ts's file header for why a direct-SQL
// fixture is equivalent to a submit call for this purpose.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOpenDivision(
  auth: AuthCtx,
  entrantKind: "individual" | "team" | "pair" = "individual",
): Promise<{ divisionId: string }> {
  const competition = await createCompetition(auth, {
    name: "Materialise Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: entrantKind,
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  return { divisionId: division.id };
}

/** Direct V363/V364 fixture — same group→registration→player-row chain as
 *  registration-user-link.test.ts's seedPlayerEntry, extended with
 *  squadNumber/isCaptain for the pair acceptance criterion this file owns. */
async function seedPlayerEntry(
  divisionId: string,
  players: {
    name: string;
    dob?: string | null;
    gender?: string | null;
    userId?: string | null;
    squadNumber?: number | null;
    isCaptain?: boolean;
  }[],
): Promise<{ id: string }> {
  const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (
      ${competitionId}, 'Contact', ${`c-${randomUUID().slice(0, 8)}@test.local`},
      ${`tok-${randomUUID()}`}, 'gbp'
    )
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name)
    values (${group.id}, ${divisionId}, ${players[0]?.name ?? "Entry"})
    returning id`;
  for (const p of players) {
    await sql`
      insert into registration_players
        (registration_id, full_name, dob, gender, user_id, squad_number, is_captain, source)
      values (
        ${reg.id}, ${p.name}, ${p.dob ?? null}, ${p.gender ?? null}, ${p.userId ?? null},
        ${p.squadNumber ?? null}, ${p.isCaptain ?? false}, 'captain_entered'
      )`;
  }
  return reg;
}

/** Raw persons row, bypassing materialise entirely — for preconditions
 *  materialise itself would never produce on its own (ambiguous duplicates,
 *  a cross-org namesake, a tombstoned person, a non-player lane). */
async function seedPerson(
  orgId: string,
  over: {
    fullName: string;
    dob?: string | null;
    lane?: "player" | "official" | "coach" | "staff";
    mergedInto?: string | null;
    consent?: Record<string, unknown>;
  },
): Promise<{ id: string }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, lane, merged_into, consent)
    values (
      ${orgId}, ${over.fullName}, ${over.dob ?? null}, ${over.lane ?? "player"},
      ${over.mergedInto ?? null}, ${sql.json((over.consent ?? {}) as never)}
    )
    returning id`;
  return p;
}

async function makeUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, password_hash)
    values (${`u-${randomUUID().slice(0, 8)}@test.local`}, 'Session User', 'x')
    returning id`;
  return u.id;
}

async function personCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons where org_id = ${orgId}`;
  return Number(n);
}

/** A globally-unique full_name per call. The name+dob match query this file
 *  exercises is org-scoped in production (so re-running this suite against a
 *  persistent DB is safe on its own), but several tests below deliberately
 *  MUTATE the query to check the org/lane/merged_into guards are load-bearing
 *  (see the implementer's own verification pass) — under a mutation that
 *  drops org-scoping, a fixed literal name would accumulate matches across
 *  every past run of this file and turn "exactly one match" into "many",
 *  which masks the very regression the test exists to catch. A unique name
 *  per call keeps every test's match set exactly what IT seeds, regardless
 *  of how many times the suite has run before against this DB. */
function tag(base: string): string {
  return `${base} ${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!HAS_DB)("player person get-or-create by (org, name, dob) — no user_id (RS002 ruling)", () => {
  it("same name + same dob, no user_id, materialised across two registrations → ONE person, reused", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const name = tag("Riley Fox");

    const a = await seedPlayerEntry(divA.divisionId, [{ name, dob: "1998-06-15" }]);
    const b = await seedPlayerEntry(divB.divisionId, [{ name, dob: "1998-06-15" }]);
    const ca = await confirmRegistration(auth, a.id);
    const cb = await confirmRegistration(auth, b.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
      where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(members).toHaveLength(2);
    expect(members[0]!.person_id).toBe(members[1]!.person_id);
  });

  it("same name, NO dob → two persons (the ruling, asserted)", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const name = tag("No Dob Person");

    const a = await seedPlayerEntry(divA.divisionId, [{ name }]);
    const b = await seedPlayerEntry(divB.divisionId, [{ name }]);
    const ca = await confirmRegistration(auth, a.id);
    const cb = await confirmRegistration(auth, b.id);

    expect(await personCount(auth.orgId)).toBe(before + 2);
    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
      where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(members[0]!.person_id).not.toBe(members[1]!.person_id);
  });

  it("same name, different dob → two persons", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const name = tag("Diff Dob");

    const a = await seedPlayerEntry(divA.divisionId, [{ name, dob: "2000-01-01" }]);
    const b = await seedPlayerEntry(divB.divisionId, [{ name, dob: "2001-02-02" }]);
    await confirmRegistration(auth, a.id);
    await confirmRegistration(auth, b.id);

    expect(await personCount(auth.orgId)).toBe(before + 2);
  });

  it("same name + dob but TWO existing matching persons already present → a NEW person, never an arbitrary pick", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const name = tag("Ambiguous Twin");
    const dup1 = await seedPerson(auth.orgId, { fullName: name, dob: "1995-05-05" });
    const dup2 = await seedPerson(auth.orgId, { fullName: name, dob: "1995-05-05" });
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1995-05-05" }]);
    const confirmed = await confirmRegistration(auth, a.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);
    const [{ person_id }] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).not.toBe(dup1.id);
    expect(person_id).not.toBe(dup2.id);
  });
});

describe.skipIf(!HAS_DB)("player person reuse never crosses org / merge / lane boundaries", () => {
  it("a person in ANOTHER org with the same name+dob is never reused", async () => {
    const { auth: authA } = await seedOrg("pro");
    const { auth: authB } = await seedOrg("pro");
    const name = tag("Cross Org");
    const other = await seedPerson(authB.orgId, { fullName: name, dob: "1990-03-03" });
    const div = await seedOpenDivision(authA);
    const before = await personCount(authA.orgId);

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1990-03-03" }]);
    const confirmed = await confirmRegistration(authA, a.id);

    expect(await personCount(authA.orgId)).toBe(before + 1);
    const [{ person_id }] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).not.toBe(other.id);
    const [created] = await sql<{ org_id: string }[]>`select org_id from persons where id = ${person_id}`;
    expect(created.org_id).toBe(authA.orgId);
  });

  it("a merged_into (tombstoned) person is never reused", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const name = tag("Merged Twin");
    const survivor = await seedPerson(auth.orgId, { fullName: tag("Survivor"), dob: "1988-08-08" });
    const tombstone = await seedPerson(auth.orgId, {
      fullName: name,
      dob: "1988-08-08",
      mergedInto: survivor.id,
    });
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1988-08-08" }]);
    const confirmed = await confirmRegistration(auth, a.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);
    const [{ person_id }] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).not.toBe(tombstone.id);
  });

  it("a lane != 'player' person is never reused", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const name = tag("Match Official");
    const official = await seedPerson(auth.orgId, {
      fullName: name,
      dob: "1975-01-01",
      lane: "official",
    });
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1975-01-01" }]);
    const confirmed = await confirmRegistration(auth, a.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);
    const [{ person_id }] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).not.toBe(official.id);
  });
});

describe.skipIf(!HAS_DB)("new persons default to public_name consent (owner ruling 5)", () => {
  it("a newly created person has consent.public_name = true", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const a = await seedPlayerEntry(div.divisionId, [{ name: tag("Fresh Person"), dob: "1999-09-09" }]);
    const confirmed = await confirmRegistration(auth, a.id);

    const [{ public_name }] = await sql<{ public_name: string }[]>`
      select p.consent->>'public_name' as public_name from persons p
      join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${confirmed.entrant_id as string}`;
    expect(public_name).toBe("true");
  });

  it("a REUSED person that had opted out keeps its own consent untouched", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const name = tag("Opted Out");
    const optedOut = await seedPerson(auth.orgId, {
      fullName: name,
      dob: "1980-12-12",
      consent: { public_name: false },
    });

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1980-12-12" }]);
    const confirmed = await confirmRegistration(auth, a.id);

    const [{ person_id, public_name }] = await sql<{ person_id: string; public_name: string }[]>`
      select p.id as person_id, p.consent->>'public_name' as public_name from persons p
      join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).toBe(optedOut.id);
    expect(public_name).toBe("false");
  });
});

describe.skipIf(!HAS_DB)("registration_players.person_id is written at materialisation", () => {
  it("every materialised player row gets person_id, matching its entrant_members row", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth, "team");
    const reg = await seedPlayerEntry(div.divisionId, [
      { name: tag("Row One"), dob: "1991-01-01" },
      { name: tag("Row Two"), dob: "1992-02-02" },
    ]);
    const confirmed = await confirmRegistration(auth, reg.id);

    const rows = await sql<{ id: string; full_name: string; person_id: string | null }[]>`
      select id, full_name, person_id from registration_players
      where registration_id = ${reg.id} order by full_name`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.person_id).not.toBeNull();
      const [member] = await sql<{ full_name: string }[]>`
        select p.full_name from entrant_members em join persons p on p.id = em.person_id
        where em.entrant_id = ${confirmed.entrant_id as string} and em.person_id = ${r.person_id as string}`;
      expect(member.full_name).toBe(r.full_name);
    }
  });
});

describe.skipIf(!HAS_DB)("pair entrant_kind materialises both players (RS002 gap)", () => {
  it("a pair entry materialises both players as entrant_members, with squad_number and is_captain carried", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth, "pair");
    const nameOne = tag("Pair One");
    const nameTwo = tag("Pair Two");
    const reg = await seedPlayerEntry(div.divisionId, [
      { name: nameOne, dob: "1993-03-03", squadNumber: 1, isCaptain: true },
      { name: nameTwo, dob: "1994-04-04", squadNumber: 2, isCaptain: false },
    ]);
    const confirmed = await confirmRegistration(auth, reg.id);
    expect(confirmed.entrant_id).not.toBeNull();

    const members = await sql<
      { full_name: string; squad_number: number | null; is_captain: boolean }[]
    >`
      select p.full_name, em.squad_number, em.is_captain from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id = ${confirmed.entrant_id as string} order by p.full_name`;
    expect(members).toHaveLength(2);
    expect(members[0]).toMatchObject({ full_name: nameOne, squad_number: 1, is_captain: true });
    expect(members[1]).toMatchObject({ full_name: nameTwo, squad_number: 2, is_captain: false });
  });
});

describe.skipIf(!HAS_DB)("materialisation idempotency (pair roster + person reuse combined)", () => {
  it("confirming twice yields one entrant, one member per player, one person per player, entrant_id unchanged", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth, "pair");
    const reg = await seedPlayerEntry(div.divisionId, [
      { name: tag("Idem One"), dob: "1993-03-03" },
      { name: tag("Idem Two"), dob: "1994-04-04" },
    ]);
    const before = await personCount(auth.orgId);
    const first = await confirmRegistration(auth, reg.id);
    const second = await confirmRegistration(auth, reg.id);

    expect(second.entrant_id).toBe(first.entrant_id);
    expect(await personCount(auth.orgId)).toBe(before + 2);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members where entrant_id = ${first.entrant_id as string}`;
    expect(n).toBe(2);
  });
});

describe.skipIf(!HAS_DB)("the user_id path is unchanged — never subject to the name+dob rule", () => {
  it("a linked player row resolves via resolvePlayerPerson even though an unlinked namesake with the same dob exists", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const name = tag("Case Ten");
    const anon = await seedPerson(auth.orgId, { fullName: name, dob: "1992-03-03" });
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(div.divisionId, [{ name, dob: "1992-03-03", userId }]);
    const confirmed = await confirmRegistration(auth, a.id);

    // A NEW linked person is minted; the pre-existing anonymous namesake is
    // left untouched — proof the user_id branch never falls through to the
    // name+dob reuse rule.
    expect(await personCount(auth.orgId)).toBe(before + 1);
    const [{ person_id }] = await sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${confirmed.entrant_id as string}`;
    expect(person_id).not.toBe(anon.id);
    const [linked] = await sql<{ user_id: string | null; lane: string }[]>`
      select user_id, lane from persons where id = ${person_id}`;
    expect(linked.user_id).toBe(userId);
    expect(linked.lane).toBe("player");
  });

  it("a linked player row with NO dob still resolves (resolvePlayerPerson never required one)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();

    const a = await seedPlayerEntry(div.divisionId, [{ name: tag("No Dob Linked"), userId }]);
    const confirmed = await confirmRegistration(auth, a.id);

    const [{ user_id }] = await sql<{ user_id: string | null }[]>`
      select p.user_id from persons p join entrant_members em on em.person_id = p.id
      where em.entrant_id = ${confirmed.entrant_id as string}`;
    expect(user_id).toBe(userId);
  });
});
