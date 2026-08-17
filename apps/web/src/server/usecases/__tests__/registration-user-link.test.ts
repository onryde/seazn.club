// #402 — the account behind a registration, and the person it resolves to.
//
// Two halves, deliberately in one file because the second depends on what the
// first writes:
//
//  1. CAPTURE. Pre-RS001 this was `registrations.user_id`, written ONLY when
//     the submitter was signed in AND affirmed "I'm registering myself" AND
//     left every guardian field empty (`deriveLinkUserId`, still exported,
//     still pinned pure below). Post-RS001/V363 the target column is
//     `registration_players.user_id` — the account that owns ONE specific
//     player row, set for the submitter's own row at submit (design §4 step
//     1) or at claim/join (design §2 item 4). Deliberately NOT
//     `registration_groups.user_id`: the group's contact is often a club rep
//     entering OTHER people's entries, and resolving every player against
//     the rep's account would mis-link entries that are not theirs. Nothing
//     writes this column yet (RS002/RS003 own submit, RS008 owns claim) —
//     untested here, on purpose; that capture decision has no call site to
//     pin against until one of those ships.
//  2. RESOLVE. Given a player row carrying a `user_id`, `materialise` calls
//     `resolvePlayerPerson` to upsert into the PLAYER lane on (org_id,
//     user_id, 'player'), so one human entering two divisions gets ONE
//     persons row. A row with no `user_id` keeps the plain unlinked insert.
//     Restored below, seeded directly against the V363/V364 shape (RS001
//     follow-up) — this half needs no submit flow, only a player row that
//     already carries the link.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { confirmRegistration, deriveLinkUserId, putRegistrationSettings } from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** An unambiguous adult on any clock this suite will ever run on. Linking now
 *  REQUIRES a dob (#402 finding 5), so every "expect a link" case sends one. */
const ADULT_DOB = "1990-05-05";

/** Registration-open division. Deliberately a local copy of the helper in
 *  persons-identity.test.ts — the two suites stay independent. */
async function seedOpenDivision(
  auth: AuthCtx,
  entrantKind: "individual" | "team" = "individual",
): Promise<{ divisionId: string; orgSlug: string; compSlug: string }> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    name: "Identity Cup " + randomUUID().slice(0, 6),
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
  return { divisionId: division.id, orgSlug, compSlug: competition.slug };
}

// The derivation is exported so the branches the outer 422s make unreachable can
// still be pinned. A minor's dob is guardian territory whether or not the
// guardian fields were filled in: `submitRegistration` refuses that submission
// outright today, but the link rule must not depend on that refusal staying
// where it is — the veto is the guarantee, the 422 is only the friendly error.
describe("deriveLinkUserId (#402 — the capture rule itself)", () => {
  const NOW = new Date("2026-08-04T12:00:00Z");
  const MINOR_DOB = "2016-09-11"; // 9 on NOW
  const base = {
    registering_self: false as boolean | undefined,
    guardian_name: null as string | null | undefined,
    guardian_consent: false,
    dob: null as string | null | undefined,
  };

  it("no session ⇒ null", () => {
    expect(deriveLinkUserId(null, { ...base, registering_self: true, dob: ADULT_DOB }, NOW))
      .toBeNull();
  });

  it("session but no affirmation ⇒ null", () => {
    expect(deriveLinkUserId("u1", { ...base, dob: ADULT_DOB }, NOW)).toBeNull();
  });

  it("session + affirmation + an ADULT dob ⇒ the session id", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: ADULT_DOB }, NOW))
      .toBe("u1");
  });

  it("guardian_name present ⇒ null", () => {
    expect(
      deriveLinkUserId(
        "u1",
        { ...base, registering_self: true, dob: ADULT_DOB, guardian_name: "Grace Guardian" },
        NOW,
      ),
    ).toBeNull();
  });

  it("guardian_consent true ⇒ null", () => {
    expect(
      deriveLinkUserId(
        "u1",
        { ...base, registering_self: true, dob: ADULT_DOB, guardian_consent: true },
        NOW,
      ),
    ).toBeNull();
  });

  it("NO dob ⇒ null — an unaged registrant may be anyone, including a child", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: null }, NOW)).toBeNull();
    expect(
      deriveLinkUserId("u1", { ...base, registering_self: true, dob: undefined }, NOW),
    ).toBeNull();
  });

  it("a MINOR's dob ⇒ null even with NO guardian fields at all", () => {
    expect(deriveLinkUserId("u1", { ...base, registering_self: true, dob: MINOR_DOB }, NOW))
      .toBeNull();
  });
});

// describe("registration session capture (#402)") DELETED (RS001 demolition):
// all 7 tests drove `submitRegistration`'s own capture of the
// session's user_id onto the row it inserted. The column moved too
// (`registrations.user_id` → `registration_groups.user_id`, V364), but that
// is secondary — the write only ever happened INSIDE submitRegistration,
// which no longer exists. `deriveLinkUserId`, the pure decision function
// this capture step called, keeps its own full coverage above, unchanged.
// RS002/RS003 own re-wiring capture (and re-testing it) against the new
// group-shaped submit flow.

describe.skipIf(!HAS_DB)("organiser-side entry creation (#402)", () => {
  it("binds NO user_id to the person, even though the organiser is signed in", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    expect(auth.userId).toBeTruthy(); // the organiser IS a session, or this is vacuous

    // Structural, by design (spec §4): the session is resolved in the PUBLIC
    // route and passed inward, so no organiser-facing path can supply one. An
    // organiser adding an entry on someone's behalf must never bind their own
    // account to a player's identity — that is the same two-humans-one-person
    // corruption from the other end.
    const [entrant] = await createEntrants(auth, div.divisionId, [
      {
        kind: "individual",
        display_name: "Walk In",
        members: [{ new_person: { full_name: "Walk In" }, is_captain: false, roles: [] }],
        seed: null,
        team_id: null,
        copy_roster_from_entrant_id: null,
        badge_url: null,
      },
    ]);

    const people = await sql<{ user_id: string | null; lane: string }[]>`
      select p.user_id, p.lane from persons p
        join entrant_members em on em.person_id = p.id
       where em.entrant_id = ${entrant.id}`;
    expect(people).toHaveLength(1);
    expect(people[0].user_id).toBeNull();
    expect(people[0].lane).toBe("player");
    // …and the organiser's own account still holds no person in this org.
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${auth.userId}`;
    expect(Number(n)).toBe(0);
  });
});

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

/**
 * Direct V363/V364 fixture: the group → entry → player-row chain
 * `submitRegistration` used to write in one call (now deleted — see the file
 * header). `userId` on a player entry mimics whatever RS002/RS003 (submit) or
 * RS008 (claim) will eventually stamp onto that ONE row — never the group's
 * own `user_id`, which is the CONTACT's account and is not what `materialise`
 * resolves against.
 */
async function seedPlayerEntry(
  divisionId: string,
  players: { name: string; dob?: string | null; gender?: string | null; userId?: string | null }[],
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
      insert into registration_players (registration_id, full_name, dob, gender, user_id, source)
      values (
        ${reg.id}, ${p.name}, ${p.dob ?? null}, ${p.gender ?? null}, ${p.userId ?? null},
        'captain_entered'
      )`;
  }
  return reg;
}

describe.skipIf(!HAS_DB)("person resolution by (org_id, user_id, 'player') (#402, restored)", () => {
  it("THE headline: one signed-in registrant, two divisions ⇒ ONE persons row, linked", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(divA.divisionId, [{ name: "Sam Player", dob: ADULT_DOB, userId }]);
    const b = await seedPlayerEntry(divB.divisionId, [{ name: "Sam Player", dob: ADULT_DOB, userId }]);
    const ca = await confirmRegistration(auth, a.id);
    const cb = await confirmRegistration(auth, b.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);
    const [person] = await sql<{ user_id: string | null; lane: string }[]>`
      select user_id, lane from persons where org_id = ${auth.orgId} and user_id = ${userId}`;
    expect(person.user_id).toBe(userId);
    expect(person.lane).toBe("player");

    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(members).toHaveLength(2);
    expect(members[0]!.person_id).toBe(members[1]!.person_id);
  });

  it("the resolved person keeps its OWN data — a later entry never overwrites it", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();

    const a = await seedPlayerEntry(divA.divisionId, [
      { name: "Original Name", dob: "1990-01-01", userId },
    ]);
    await confirmRegistration(auth, a.id);
    const b = await seedPlayerEntry(divB.divisionId, [{ name: "Typo Nmae", dob: "1991-02-02", userId }]);
    await confirmRegistration(auth, b.id);

    const [person] = await sql<{ full_name: string; dob: string | null }[]>`
      select full_name, dob from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(person.full_name).toBe("Original Name");
    expect(person.dob).toBe("1990-01-01");
  });

  it("a player row with a NULL user_id still materialises an unlinked person, fresh each time", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const one = await seedPlayerEntry(div.divisionId, [{ name: "Anon A", userId: null }]);
    const two = await seedPlayerEntry(div.divisionId, [{ name: "Anon B", userId: null }]);
    const ca = await confirmRegistration(auth, one.id);
    await confirmRegistration(auth, two.id);

    expect(await personCount(auth.orgId)).toBe(before + 2);
    const [{ user_id: linked }] = await sql<{ user_id: string | null }[]>`
      select p.user_id from persons p join entrant_members em on em.person_id = p.id
       where em.entrant_id = ${ca.entrant_id as string}`;
    expect(linked).toBeNull();
  });

  it("team roster: the linked player's row resolves & dedupes; unlinked teammates insert fresh each time", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth, "team");
    const divB = await seedOpenDivision(auth, "team");
    const userId = await makeUser();

    const players = [
      { name: "Cap Tain", dob: ADULT_DOB, userId },
      { name: "Team Mate One", userId: null },
      { name: "Team Mate Two", userId: null },
    ];
    const a = await seedPlayerEntry(divA.divisionId, players);
    const b = await seedPlayerEntry(divB.divisionId, players);
    const ca = await confirmRegistration(auth, a.id);
    const cb = await confirmRegistration(auth, b.id);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(Number(n)).toBe(1);

    const rows = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(rows).toHaveLength(6);
    // The captain's person is the only one appearing on BOTH entrants; the two
    // team-mates are unlinked and insert fresh on every confirm.
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.person_id, (counts.get(r.person_id) ?? 0) + 1);
    expect([...counts.values()].filter((c) => c === 2)).toHaveLength(1);
    expect(counts.size).toBe(5);
    const [captain] = await sql<{ id: string }[]>`
      select id from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(counts.get(captain!.id)).toBe(2);
  });

  it("two concurrent confirmations of the same linked user ⇒ still ONE persons row", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await seedPlayerEntry(divA.divisionId, [{ name: "Race One", dob: ADULT_DOB, userId }]);
    const b = await seedPlayerEntry(divB.divisionId, [{ name: "Race Two", dob: ADULT_DOB, userId }]);
    await Promise.all([confirmRegistration(auth, a.id), confirmRegistration(auth, b.id)]);

    expect(await personCount(auth.orgId)).toBe(before + 1);
  });
});

// Two more cases from the pre-RS001 version of this describe are NOT
// restored: a guardian's/parent's own veto against linking a CHILD's row, and
// a defensive "only the first of two flagged rows resolves" guard. Both
// tested `deriveLinkUserId`/the old roster's single boolean `self` flag —
// decisions the OLD `submitRegistration` made about WHETHER to write a link
// at all. That decision now lives entirely upstream of `materialise`
// (RS002/RS003's submit flow, RS008's claim flow): whichever row a future
// caller stamps `user_id` onto is not something `materialise` re-derives, so
// there is no `materialise`-level surface left to pin either scenario
// against — restoring them here would either duplicate the NULL-user_id
// coverage above under a different name, or invent a same-registration
// double-`user_id` guard nobody has asked `materialise` to enforce.
// RS002/RS003/RS008 own re-pinning their own linking decisions once they
// exist.
