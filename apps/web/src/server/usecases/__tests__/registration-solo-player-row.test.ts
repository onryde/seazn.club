// Polish wave P5, H-1 (walk 15, HIGH): a solo sign-up could not be placed on a team. The public form's Details step collected no
// player for a solo sign-up and the submit wrote none, so Assign refused "This entry has no player details to place on a team"
// (`registration-assign.ts`) on every solo sign-up the form had ever made.
//
// The rules under test:
// - submit writes ONE `registration_players` row for a solo sign-up: the row the form sends, or, when none is sent (an older cart,
//   an API caller), one built from the contact. It is the registrant's OWN row (a solo sign-up is the person looking for a team):
//   consent given at submit, the contact's dob/gender/email as fallbacks, a minor needs a guardian like any self-registration;
// - only the person's own eligibility applies to it - a team's composition (a mixed roster) is the team's, never one solo player's;
// - a solo sign-up made before this change (no player row) is placed as its registrant contact - the name the panel already shows;
// - the chain the feature exists for: solo sign-up -> assign -> on the team's roster -> the team's confirm SEATS them.
//
// Expected values come from what each test submits (the contact, the row), never from the code under test.
// Sport: solo sign-ups exist only on team divisions; football is the seeded sport whose roster is big enough to place anyone
// (generic's lineup is one player). Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { assignSoloSignUp } from "../registration-assign";
import { submitRegistrationGroup, type SubmitGroupContact, type SubmitGroupPlayerInput } from "../registration-submit";
import { seedFootballCatalog, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

function farFutureDate(daysFromNow = 60): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  ctx: { orgSlug: string; compSlug: string };
}

async function rig(eligibility: { category?: string; age_min?: number; age_max?: number } = {}): Promise<Rig> {
  const { auth } = await seedOrg();
  await seedFootballCatalog();
  const competition = await createCompetition(auth, {
    name: "Solo Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: farFutureDate(),
    ends_on: farFutureDate(65),
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  await sql`update divisions
               set category = ${eligibility.category ?? null}, age_min = ${eligibility.age_min ?? null},
                   age_max = ${eligibility.age_max ?? null}
             where id = ${division.id}`;
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "team",
    fee_cents: 0,
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    allow_free_agents: true,
  });
  const [row] = await sql<{ org_slug: string; comp_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug from competitions c join organizations o on o.id = c.org_id
     where c.id = ${competition.id}`;
  return { auth, divisionId: division.id, ctx: { orgSlug: row!.org_slug, compSlug: row!.comp_slug } };
}

function contactOf(name: string, over: Partial<SubmitGroupContact> = {}): SubmitGroupContact {
  return { name, email: `solo-${randomUUID().slice(0, 8)}@test.local`, ...over };
}

async function submitSolo(r: Rig, contact: SubmitGroupContact, players: SubmitGroupPlayerInput[]): Promise<string> {
  const res = await submitRegistrationGroup(r.ctx, {
    contact,
    privacy_consent: true,
    entries: [{ division_id: r.divisionId, entrant_kind: "team", free_agent: true, players, answers: {} }],
  } as never);
  return res.entries[0]!.registration_id;
}

async function playersOf(regId: string) {
  return sql<{ full_name: string; email: string | null; dob: string | null; gender: string | null; consent_status: string }[]>`
    select full_name, email, to_char(dob, 'YYYY-MM-DD') as dob, gender, consent_status
      from registration_players where registration_id = ${regId} order by created_at, id`;
}

/** A team entry waiting for the organiser's confirm (pending, not materialised), with its captain on the roster. */
async function pendingTeam(r: Rig, name: string): Promise<string> {
  const [{ competition_id }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${r.divisionId}`;
  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
    values (${competition_id}, 'Captain', ${`cap-${randomUUID().slice(0, 8)}@test.local`}, ${`tok-${randomUUID()}`}, 'gbp')
    returning id`;
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, free_agent, status)
    values (${group!.id}, ${r.divisionId}, ${name}, false, 'pending') returning id`;
  await sql`insert into registration_players (registration_id, full_name, source, consent_status, consent_at)
            values (${reg!.id}, 'Captain Kay', 'captain_entered', 'granted', now())`;
  return reg!.id;
}

async function seatedNames(regId: string): Promise<string[]> {
  const rows = await sql<{ full_name: string }[]>`
    select p.full_name from registrations r
      join entrant_members em on em.entrant_id = r.entrant_id
      join persons p on p.id = em.person_id
     where r.id = ${regId} order by p.full_name`;
  return rows.map((x) => x.full_name);
}

describe.skipIf(!HAS_DB)("a solo sign-up carries ONE player row: the registrant's own (H-1)", () => {
  it("the row the form sends is written once, as the registrant's own: consent given, the contact's email as its fallback", async () => {
    const r = await rig();
    const contact = contactOf("Priya Contact");
    const regId = await submitSolo(r, contact, [{ full_name: "Priya Raman", gender: "f" }]);
    const rows = await playersOf(regId);
    expect(rows.length, "exactly one player row").toBe(1);
    expect(rows[0]).toMatchObject({ full_name: "Priya Raman", gender: "f", email: contact.email, consent_status: "granted" });
  });

  it("no row sent (an older cart, an API caller): one row is made from the contact, dob and gender included", async () => {
    const r = await rig();
    const contact = contactOf("Sam Contact", { dob: "1992-04-05", gender: "m" });
    const regId = await submitSolo(r, contact, []);
    const rows = await playersOf(regId);
    expect(rows.length, "exactly one player row").toBe(1);
    expect(rows[0]).toMatchObject({ full_name: "Sam Contact", email: contact.email, dob: "1992-04-05", gender: "m", consent_status: "granted" });
  });

  it("a minor solo sign-up needs a guardian's consent, like any player registering themselves; with it the row is written", async () => {
    const r = await rig();
    const minorDob = `${new Date().getUTCFullYear() - 12}-01-01`;
    await expect(submitSolo(r, contactOf("Kid Contact"), [{ full_name: "Kid Solo", dob: minorDob }])).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("guardian"),
    });
    const regId = await submitRegistrationGroup(r.ctx, {
      contact: contactOf("Parent Contact", { guardian_name: "Parent Contact", guardian_consent: true }),
      privacy_consent: true,
      entries: [{ division_id: r.divisionId, entrant_kind: "team", free_agent: true, players: [{ full_name: "Kid Solo", dob: minorDob }], answers: {} }],
    } as never).then((res) => res.entries[0]!.registration_id);
    expect((await playersOf(regId)).map((p) => p.full_name)).toEqual(["Kid Solo"]);
  });

  it("a mixed division takes a solo sign-up: one player is never a mixed roster - only their own eligibility applies", async () => {
    const r = await rig({ category: "mixed" });
    const regId = await submitSolo(r, contactOf("Mia Contact"), [{ full_name: "Mia Solo", gender: "f" }]);
    expect((await playersOf(regId)).length).toBe(1);
  });

  it("the positive pair: the solo player's OWN eligibility still refuses (an adult in an under-12 division)", async () => {
    const r = await rig({ age_max: 11 });
    await expect(
      submitSolo(r, contactOf("Old Contact"), [{ full_name: "Too Old", dob: "1990-01-01" }]),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe.skipIf(!HAS_DB)("solo sign-up -> assign -> the team's roster -> the team's confirm seats them (H-1 chain)", () => {
  it("a solo sign-up the form made (no row sent, as the form used to) is placed as the contact and seated on the team's confirm", async () => {
    const r = await rig();
    const soloId = await submitSolo(r, contactOf("Jordan Solo"), []);
    const [solo] = await sql<{ status: string }[]>`select status from registrations where id = ${soloId}`;
    expect(solo!.status, "premise: free + auto confirms the solo at submit (assign takes confirmed or paid)").toBe("confirmed");
    const teamId = await pendingTeam(r, "Team A");

    const placed = await assignSoloSignUp(r.auth, { registration_id: soloId, target_registration_id: teamId });
    expect((await playersOf(teamId)).map((p) => p.full_name)).toEqual(["Captain Kay", "Jordan Solo"]);
    // Sequence: a second press of the same pair is the same placement.
    const again = await assignSoloSignUp(r.auth, { registration_id: soloId, target_registration_id: teamId });
    expect(again.player_id).toBe(placed.player_id);
    expect((await playersOf(teamId)).length, "no second roster row").toBe(2);

    await confirmRegistration(r.auth, teamId);
    expect(await seatedNames(teamId)).toEqual(["Captain Kay", "Jordan Solo"]);
  });

  it("a solo sign-up made before this change (no player row at all) is placed as its registrant contact", async () => {
    const r = await rig();
    const soloId = await submitSolo(r, contactOf("Legacy Lee"), []);
    await sql`delete from registration_players where registration_id = ${soloId}`;
    expect((await playersOf(soloId)).length, "premise: the solo sign-up has no player row").toBe(0);
    const teamId = await pendingTeam(r, "Team B");

    await assignSoloSignUp(r.auth, { registration_id: soloId, target_registration_id: teamId });
    const roster = await playersOf(teamId);
    expect(roster.map((p) => p.full_name)).toEqual(["Captain Kay", "Legacy Lee"]);
    expect(roster[1]!.consent_status, "they filled the form themselves: their consent is carried, not re-asked").toBe("granted");

    await confirmRegistration(r.auth, teamId);
    expect(await seatedNames(teamId)).toEqual(["Captain Kay", "Legacy Lee"]);
  });
});
