// RS009 — an organiser placing a pooled solo sign-up onto a team entry.
//
// The public stepper has promised this since RS006 shipped: a solo sign-up
// is told, in `register.details.freeAgent.note`, that "the organiser will
// assign you to a team once one has space." Until this session there was no
// way for an organiser to do it — `joinTeamEntry` explicitly REFUSES a free
// agent (`registration-submit.ts`), and no other write path existed. These
// tests are the contract for the one that does.
//
// The word in user-facing copy is "solo sign-up"; `free_agent` remains the
// column name (RS005 ruled the two vocabularies confusing side by side).
//
// Real Postgres required; skipped without DATABASE_URL. Fixtures follow
// registration-materialise.test.ts's direct-SQL pattern for the V363/V364
// shape, for the same reason it gives: `submitRegistration` was deleted in
// the RS001 demolition, so a direct insert is the equivalent of a submit.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  confirmRegistration,
  putRegistrationSettings,
  withdrawRegistrationOrganiser,
} from "../registrations";
import { rejectRegistration } from "../registration-approval";
import { assignSoloSignUp, unassignSoloSignUp } from "../registration-assign";
import { seedFootballCatalog, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** A team division that accepts solo sign-ups, on a sport whose
 *  position_catalog declares a roster big enough to fill. */
async function seedTeamDivision(
  auth: AuthCtx,
  opts: { allowFreeAgents?: boolean; capacity?: number | null } = {},
): Promise<{ divisionId: string; competitionId: string }> {
  await seedFootballCatalog();
  const competition = await createCompetition(auth, {
    name: "Assign Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    // Football, deliberately, not `generic`: generic's position_catalog
    // declares a lineup of `{ size: 1, benchMax: 0 }`, so `rosterCapExpr`
    // makes every "team" full at ONE player and every assignment in this
    // file was refused with `Team A is full (1/1)`. Football's 11 + 12 is
    // the first roster big enough for these tests to mean anything.
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "team",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: opts.capacity ?? null,
    refund_lock_at: null,
    allow_free_agents: opts.allowFreeAgents ?? true,
  });
  return { divisionId: division.id, competitionId: competition.id };
}

/** One `registrations` row plus its roster rows. `freeAgent: true` gives the
 *  pooled solo sign-up (no roster of its own); otherwise a team entry. */
async function seedEntry(
  divisionId: string,
  opts: {
    displayName: string;
    freeAgent?: boolean;
    /** `confirmRegistration` returns early on an already-confirmed row, so a
     *  team that needs MATERIALISING must be seeded unconfirmed. Seeding
     *  'confirmed' here is what made the two entrant_members tests assert
     *  `expected null not to be null` — nothing had ever materialised. */
    status?: "pending" | "paid" | "confirmed" | "waitlisted";
    players?: {
      name: string;
      gender?: string | null;
      dob?: string | null;
      consentStatus?: "pending" | "granted" | "guardian";
    }[];
  },
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
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group.id}, ${divisionId}, ${opts.displayName}, ${opts.freeAgent ?? false}, ${opts.status ?? "confirmed"})
    returning id`;
  for (const p of opts.players ?? []) {
    await sql`
      insert into registration_players
        (registration_id, full_name, gender, dob, source, consent_status, consent_at)
      values (
        ${reg.id}, ${p.name}, ${p.gender ?? null}, ${p.dob ?? null}, 'captain_entered',
        ${p.consentStatus ?? "pending"},
        ${p.consentStatus === "granted" || p.consentStatus === "guardian" ? sql`now()` : null}
      )`;
  }
  return reg;
}

async function rosterOf(registrationId: string) {
  return sql<
    { full_name: string; source: string; assigned_from_registration_id: string | null }[]
  >`
    select full_name, source, assigned_from_registration_id
    from registration_players where registration_id = ${registrationId}
    order by created_at, id`;
}

describe.skipIf(!HAS_DB)("assignSoloSignUp", () => {
  it("puts the solo sign-up on the target roster, marked as organiser-assigned", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      players: [{ name: "Captain One" }],
    });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const roster = await rosterOf(team.id);
    expect(roster.map((r) => r.full_name)).toEqual(["Captain One", "Priya Raman"]);
    expect(roster[1].source).toBe("organiser_assigned");
    expect(roster[1].assigned_from_registration_id).toBe(solo.id);
  });

  it("leaves the solo sign-up's own entry intact — their money and consent stay theirs", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const [row] = await sql<{ status: string; free_agent: boolean }[]>`
      select status, free_agent from registrations where id = ${solo.id}`;
    expect(row.status).toBe("confirmed");
    expect(row.free_agent).toBe(true);
  });

  it("is idempotent — assigning the same person to the same team twice is not an error", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    expect(await rosterOf(team.id)).toHaveLength(1);
  });

  it("refuses to place one person on two teams at once", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const teamA = await seedEntry(divisionId, { displayName: "Team A" });
    const teamB = await seedEntry(divisionId, { displayName: "Team B" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: teamA.id });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: teamB.id }),
    ).rejects.toThrow(/already on/i);
  });

  it("refuses a target whose roster is already full, and says so", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const [{ cap }] = await sql<{ cap: number }[]>`
      select ((sp.position_catalog -> 'lineup' ->> 'size')::int
              + coalesce((sp.position_catalog -> 'lineup' ->> 'benchMax')::int, 0)) as cap
      from divisions d join sports sp on sp.key = d.sport_key
      where d.id = ${divisionId}`;
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      players: Array.from({ length: cap }, (_, i) => ({ name: `Player ${i + 1}` })),
    });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id }),
    ).rejects.toThrow(/full/i);
  });

  it("refuses a target in a different division", async () => {
    const { auth } = await seedOrg();
    const a = await seedTeamDivision(auth);
    const b = await seedTeamDivision(auth);
    const team = await seedEntry(b.divisionId, { displayName: "Other Division Team" });
    const solo = await seedEntry(a.divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id }),
    ).rejects.toThrow(/same division/i);
  });

  it("refuses to assign an entry that is not a solo sign-up", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const teamA = await seedEntry(divisionId, { displayName: "Team A" });
    const teamB = await seedEntry(divisionId, {
      displayName: "Team B",
      players: [{ name: "Someone" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: teamB.id, target_registration_id: teamA.id }),
    ).rejects.toThrow(/solo sign-up/i);
  });

  it("stays available after the division stops accepting new solo sign-ups", async () => {
    // RS009 scope item 4: turning `allow_free_agents` off blocks NEW pool
    // entries (RS002 already does that at submit) but must not strand the
    // people already in the pool — they are exactly who still needs placing.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth, { allowFreeAgents: true });
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });
    await sql`
      update registration_settings set allow_free_agents = false where division_id = ${divisionId}`;

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    expect(await rosterOf(team.id)).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("assignSoloSignUp carries the solo sign-up's own consent forward", () => {
  // The headline behaviour of the assign path, and it was EXERCISED by every
  // other test in this file without being CHECKED by any of them: the seeded
  // solo player defaults to consent_status 'pending', so a regression that
  // dropped the carry-forward and started the placed row at 'pending' would
  // have left all 19 tests green. Caught in review, not by the suite.
  //
  // Why it matters beyond correctness: a solo sign-up filled in the form
  // themselves and consented at their own submit. Resetting them to pending
  // would ask a second time for something already given, and would show the
  // organiser a consent-pending player on the roster who has in fact
  // consented — which is what the Registrants tab's consent-pending filter
  // reads.
  it("keeps a granted consent granted, with its original timestamp", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman", consentStatus: "granted" }],
    });
    const [before] = await sql<{ consent_status: string; consent_at: Date | null }[]>`
      select consent_status, consent_at from registration_players
      where registration_id = ${solo.id}`;

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const [placed] = await sql<{ consent_status: string; consent_at: Date | null }[]>`
      select consent_status, consent_at from registration_players
      where assigned_from_registration_id = ${solo.id}`;
    expect(placed.consent_status).toBe("granted");
    expect(placed.consent_at?.toISOString()).toBe(before.consent_at?.toISOString());
  });

  it("does not invent consent the registrant never gave", async () => {
    // The other direction, and the one that would be a safeguarding problem
    // rather than an annoyance: assignment must never upgrade a pending
    // consent to granted on the registrant's behalf.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Sam Blake",
      freeAgent: true,
      players: [{ name: "Sam Blake", consentStatus: "pending" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const [placed] = await sql<{ consent_status: string; consent_at: Date | null }[]>`
      select consent_status, consent_at from registration_players
      where assigned_from_registration_id = ${solo.id}`;
    expect(placed.consent_status).toBe("pending");
    expect(placed.consent_at).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("assignSoloSignUp and a mixed division's composition rule", () => {
  /** Fills the target to one slot short of its cap, all one gender, so the
   *  next placement is the one that decides whether the finished team
   *  satisfies the mixed rule. */
  async function seedNearlyFullTeam(divisionId: string, gender: "m" | "f") {
    const [{ cap }] = await sql<{ cap: number }[]>`
      select ((sp.position_catalog -> 'lineup' ->> 'size')::int
              + coalesce((sp.position_catalog -> 'lineup' ->> 'benchMax')::int, 0)) as cap
      from divisions d join sports sp on sp.key = d.sport_key
      where d.id = ${divisionId}`;
    return seedEntry(divisionId, {
      displayName: "Team A",
      players: Array.from({ length: cap - 1 }, (_, i) => ({
        name: `Player ${i + 1}`,
        gender,
      })),
    });
  }

  it("refuses the placement that would close a mixed team on one gender, and says why", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    await sql`update divisions set category = 'mixed' where id = ${divisionId}`;
    const team = await seedNearlyFullTeam(divisionId, "m");
    const solo = await seedEntry(divisionId, {
      displayName: "Sam Blake",
      freeAgent: true,
      players: [{ name: "Sam Blake", gender: "m" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id }),
    ).rejects.toThrow(/mixed/i);
  });

  it("allows the placement that satisfies the rule instead of breaking it", async () => {
    // The other half, and the reason the refusal above is not simply "mixed
    // divisions reject the last player". Same roster, same slot — only the
    // gender differs.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    await sql`update divisions set category = 'mixed' where id = ${divisionId}`;
    const team = await seedNearlyFullTeam(divisionId, "m");
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman", gender: "f" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const roster = await rosterOf(team.id);
    expect(roster.map((r) => r.full_name)).toContain("Priya Raman");
  });

  it("does not refuse while the team still has room to become mixed", async () => {
    // A mixed team of three men is not yet a problem — it is a team still
    // filling. Refusing here would block a placement that the very next one
    // would have made valid, and an organiser filling a roster one solo
    // sign-up at a time would be stuck at the first.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    await sql`update divisions set category = 'mixed' where id = ${divisionId}`;
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      players: [{ name: "One", gender: "m" }, { name: "Two", gender: "m" }],
    });
    const solo = await seedEntry(divisionId, {
      displayName: "Sam Blake",
      freeAgent: true,
      players: [{ name: "Sam Blake", gender: "m" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    expect(await rosterOf(team.id)).toHaveLength(3);
  });

  it("leaves a non-mixed division's composition alone", async () => {
    // `open`/`mens`/`womens` carry no composition rule — only `mixed` does
    // (design §2 ruling 3). Without this, a category check that fired on
    // every division would look correct against the mixed tests alone.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    await sql`update divisions set category = 'mens' where id = ${divisionId}`;
    const team = await seedNearlyFullTeam(divisionId, "m");
    const solo = await seedEntry(divisionId, {
      displayName: "Sam Blake",
      freeAgent: true,
      players: [{ name: "Sam Blake", gender: "m" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const roster = await rosterOf(team.id);
    expect(roster.map((r) => r.full_name)).toContain("Sam Blake");
  });
});

describe.skipIf(!HAS_DB)("assignSoloSignUp onto an already-materialised entrant", () => {
  it("rosters the person onto the live entrant, not just the registration", async () => {
    // The defect this pins is #23's shape: `materialise()` returns early once
    // `entrant_id` is set, so a roster row added AFTER confirmation never
    // becomes an `entrant_members` row on its own. The player would show on
    // the registration and be absent from the team that actually gets
    // fielded. `joinExistingEntrant` is the one true path and its docstring
    // names RS009 as a caller — this test is why.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      status: "pending",
      players: [{ name: "Captain One" }],
    });
    await confirmRegistration(auth, team.id);
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${team.id}`;
    expect(entrantId).not.toBeNull();

    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const members = await sql<{ full_name: string }[]>`
      select p.full_name from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id = ${entrantId}
      order by p.full_name`;
    expect(members.map((m) => m.full_name)).toContain("Priya Raman");
  });

  it("creates the person through the shared path — no second directory entry", async () => {
    // Regression for the acceptance criterion "person created via the one
    // true path (no forked insert)". A forked insert would mint a duplicate
    // rather than reusing the person the shared resolver already made.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      status: "pending",
      players: [{ name: "Captain One" }],
    });
    await confirmRegistration(auth, team.id);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman", dob: "1998-04-02" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    await unassignSoloSignUp(auth, { registration_id: solo.id });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
      where org_id = ${auth.orgId} and lower(full_name) = 'priya raman' and merged_into is null`;
    expect(Number(n)).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("a solo sign-up is never a team of one", () => {
  // Design §6 of record: "Free agents materialize as members of the team they
  // were assigned to, or STAY UNMATERIALIZED until assigned." `materialise`
  // had no free_agent guard at all, so confirming a solo sign-up — which the
  // card-payment webhook does automatically — minted a one-person `team`
  // entrant for them in the division.
  //
  // That entrant is schedulable and appears in standings. Assign them to a
  // real team afterwards and the same person is on two entrants: a phantom
  // one-player team sits in the fixture list forever, and nothing ever
  // removes it.
  it("confirming a solo sign-up creates no entrant of its own", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      status: "pending",
      players: [{ name: "Priya Raman" }],
    });

    await confirmRegistration(auth, solo.id);

    const [row] = await sql<{ entrant_id: string | null; status: string }[]>`
      select entrant_id, status from registrations where id = ${solo.id}`;
    expect(row.status).toBe("confirmed");
    expect(row.entrant_id).toBeNull();
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from entrants where division_id = ${divisionId}`;
    expect(Number(n)).toBe(0);
  });

  it("still materialises an ordinary team entry", async () => {
    // The guard must be narrow. Without this, a change that skipped every
    // confirm would look identical to the test above.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      status: "pending",
      players: [{ name: "Captain One" }],
    });

    await confirmRegistration(auth, team.id);

    const [row] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${team.id}`;
    expect(row.entrant_id).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("waitlisted entries are not assignable in either direction", () => {
  // A waitlisted entry holds NO capacity spot and was charged nothing
  // (`registration-submit.ts` sets feeCents = waitlisted ? 0 : ...). The
  // terminal-status guards only refuse withdrawn/rejected/expired, so
  // without these an organiser could place someone who has paid nothing onto
  // a roster, or fill a team that is not actually in the division yet.
  it("refuses to place a waitlisted solo sign-up", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      status: "waitlisted",
      players: [{ name: "Priya Raman" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id }),
    ).rejects.toThrow(/waitlist/i);
  });

  it("refuses a waitlisted team as the target", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A", status: "waitlisted" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await expect(
      assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id }),
    ).rejects.toThrow(/waitlist/i);
  });
});

describe.skipIf(!HAS_DB)("a placed solo sign-up who leaves does not stay on the team", () => {
  // The V388 comment claims `on delete cascade` covers this. It does not:
  // withdrawing, rejecting and expiring are all STATUS changes, not deletes.
  // `withdrawCore` marks the entry's OWN entrant withdrawn and stops — it
  // knows nothing about `assigned_from_registration_id`, and neither did
  // reject or the expiry sweep.
  //
  // Left unfixed, a placed solo sign-up who cancels from their public status
  // page is refunded and STILL fielded: their roster row and their
  // entrant_members row both survive, the team still reads full, and the
  // organiser is never told. Three separate paths, so the release is one
  // shared helper rather than three copies that can drift.
  async function seedPlacedAndMaterialised(auth: AuthCtx) {
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      status: "pending",
      players: [{ name: "Captain One" }],
    });
    await confirmRegistration(auth, team.id);
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${team.id}`;
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      status: "pending",
      players: [{ name: "Priya Raman" }],
    });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    return { divisionId, team, solo, entrantId };
  }

  async function memberNames(entrantId: string | null) {
    const rows = await sql<{ full_name: string }[]>`
      select p.full_name from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id = ${entrantId}`;
    return rows.map((r) => r.full_name);
  }

  it("withdrawing releases the roster place and the entrant membership", async () => {
    const { auth } = await seedOrg();
    const { team, solo, entrantId } = await seedPlacedAndMaterialised(auth);

    await withdrawRegistrationOrganiser(auth, solo.id);

    expect(await rosterOf(team.id)).toHaveLength(1); // the captain, alone again
    expect(await memberNames(entrantId)).not.toContain("Priya Raman");
  });

  it("rejecting releases it too", async () => {
    const { auth } = await seedOrg();
    const { divisionId, team, solo, entrantId } = await seedPlacedAndMaterialised(auth);
    await sql`
      update registration_settings set approval = 'manual' where division_id = ${divisionId}`;

    await rejectRegistration(auth, solo.id);

    expect(await rosterOf(team.id)).toHaveLength(1);
    expect(await memberNames(entrantId)).not.toContain("Priya Raman");
  });

  it("leaves an UNPLACED solo sign-up's withdrawal alone", async () => {
    // The release must be a no-op for the ordinary case, or every withdrawal
    // in the product starts doing extra work on a row that does not exist.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const solo = await seedEntry(divisionId, {
      displayName: "Sam Blake",
      freeAgent: true,
      status: "pending",
      players: [{ name: "Sam Blake" }],
    });

    await expect(withdrawRegistrationOrganiser(auth, solo.id)).resolves.toBeDefined();
  });
});

describe.skipIf(!HAS_DB)("unassignSoloSignUp", () => {
  it("returns the person to the pool and frees the roster slot", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    await unassignSoloSignUp(auth, { registration_id: solo.id });

    expect(await rosterOf(team.id)).toHaveLength(0);
  });

  it("also removes the membership from a materialised entrant", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, {
      displayName: "Team A",
      status: "pending",
      players: [{ name: "Captain One" }],
    });
    await confirmRegistration(auth, team.id);
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${team.id}`;
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    await unassignSoloSignUp(auth, { registration_id: solo.id });

    const members = await sql<{ full_name: string }[]>`
      select p.full_name from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id = ${entrantId}`;
    expect(members.map((m) => m.full_name)).not.toContain("Priya Raman");
  });

  it("is idempotent — unassigning someone already in the pool is not an error", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });

    await expect(unassignSoloSignUp(auth, { registration_id: solo.id })).resolves.toBeDefined();
  });

  it("refuses once the division has started — that roster belongs to scheduling", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    await sql`
      update competitions set starts_on = '2020-01-01'
      where id = (select competition_id from divisions where id = ${divisionId})`;

    await expect(unassignSoloSignUp(auth, { registration_id: solo.id })).rejects.toThrow(
      /started/i,
    );
  });

  it("refuses once the division has fixtures, even with the start date still ahead", async () => {
    // The stronger half of the same gate, and the one a date cannot express:
    // a competition starting next month can already have a full schedule
    // built, and that schedule is exactly what unassigning would break.
    const { auth } = await seedOrg();
    const { divisionId } = await seedTeamDivision(auth);
    const team = await seedEntry(divisionId, { displayName: "Team A" });
    const solo = await seedEntry(divisionId, {
      displayName: "Priya Raman",
      freeAgent: true,
      players: [{ name: "Priya Raman" }],
    });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });

    const [{ org_id: orgId }] = await sql<{ org_id: string }[]>`
      select org_id from divisions where id = ${divisionId}`;
    const [stage] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${divisionId}, ${orgId}, 1, 'league', 'League')
      returning id`;
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, fixture_no)
      values (${stage.id}, ${divisionId}, ${orgId}, 1, 1, 1)`;

    await expect(unassignSoloSignUp(auth, { registration_id: solo.id })).rejects.toThrow(
      /started/i,
    );
  });
});
