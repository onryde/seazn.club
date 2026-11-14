// Registration redesign, guardian consent for minors (owner 2026-11-14, final-fix-brief "Addendum 2b — SIMPLIFY"): a parent who enters
// children they do not play beside ticks ONE box on the consent step, and the submit carries one boolean, `guardian_for_minors`.
//
// The rules under test, each from the brief, never from the code:
//  - ticked: every typed-in row that is NOT the registrant's own and whose date of birth makes them under 18 today (doc 06 §4.7, the
//    same threshold the self-registration guardian gate uses) is written consent_status 'guardian', consent_at = the submit, and
//    guardian_name = the contact's name;
//  - every other row is exactly what it was: an adult or a row with no date of birth stays 'pending' (they confirm when they join), and
//    the registrant's own row stays 'granted';
//  - unticked: 'pending' as before; ticked with no minor in the cart: accepted and ignored (forgiving, never a 422);
//  - the hub's "Consent pending" (the consent_pending read) no longer counts a guardian-consented row;
//  - the claim link: a guardian-consented row gets no join-link slot and a hand-made claim of it changes nothing (409), and the account
//    link that does reach it (RS008's claim invite) links the account only and never touches, or re-asks, its consent.
//
// Sport: not applicable (consent at submit does not vary by sport); the generic sport is the fixture's. Real Postgres required;
// skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The outbox's one network seam (the RS008 claim invite is mailed through it): captured, never sent.
const transport = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: transport.deliver }));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { createDivision } from "../divisions";
import { inviteUnclaimedMembers, listRegistrations, putRegistrationSettings } from "../registrations";
import { claimPerson } from "../person-claims";
import {
  joinTeamEntry,
  previewJoinEntry,
  submitRegistrationGroup,
  type SubmitGroupInput,
  type SubmitGroupPlayerInput,
} from "../registration-submit";
import { SETTINGS_BASE, asOwner, rig, seedOrg } from "./_registration-fixtures";
import { stubOutboxEnv } from "./_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `gm-${randomUUID().slice(0, 8)}`;
const orgs: string[] = [];

/** A date of birth `years` whole years before today (UTC), a month clear of any birthday so "under 18 today" cannot flip mid-run. */
function bornYearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCMonth(d.getUTCMonth() - 1);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}
const CHILD = bornYearsAgo(10);
const TEEN = bornYearsAgo(16);
const ADULT = bornYearsAgo(35);

/** One competition, a TEAM division and an INDIVIDUAL one, both free with automatic approval (so the cart confirms at submit and the
 *  RS008 sweep runs for real). */
async function competitionRig() {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  orgs.push(orgId);
  const owner = asOwner(orgId, ownerId);
  const { competition, division: team } = await rig(owner);
  const kids = await createDivision(owner, competition.id, {
    name: "Kids " + randomUUID().slice(0, 4),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const base = { ...SETTINGS_BASE, payment_method: "offline" as const, fee_cents: 0, approval: "auto" as const };
  await putRegistrationSettings(owner, team.id, { ...base, entrant_kind: "team" });
  await putRegistrationSettings(owner, kids.id, { ...base, entrant_kind: "individual" });
  return { orgId, owner, ctx: { orgSlug, compSlug: competition.slug }, competitionId: competition.id, teamId: team.id, kidsId: kids.id };
}
type Rig = Awaited<ReturnType<typeof competitionRig>>;

const CONTACT_NAME = "Pat Parent";

/** The cart the brief names: a parent (not playing) entering a team of two minors, an adult and a player with no date of birth, plus
 *  a third minor on an individual entry. `guardian_for_minors` is the one thing a test varies. */
function parentsCart(r: Rig, guardianForMinors: boolean | undefined, childEmail: string): SubmitGroupInput {
  const team: SubmitGroupPlayerInput[] = [
    { full_name: "Ada Minor", dob: CHILD, email: childEmail },
    { full_name: "Ben Minor", dob: TEEN },
    { full_name: "Cal Adult", dob: ADULT },
    { full_name: "Dee Undated" },
  ];
  return {
    contact: { name: CONTACT_NAME, email: `${RUN}-${randomUUID().slice(0, 6)}@x.test` },
    privacy_consent: true,
    ...(guardianForMinors === undefined ? {} : { guardian_for_minors: guardianForMinors }),
    entries: [
      { division_id: r.teamId, entrant_kind: "team", team_name: `Kids ${RUN}`, players: team, answers: {} },
      { division_id: r.kidsId, entrant_kind: "individual", players: [{ full_name: "Eli Minor", dob: CHILD }], answers: {} },
    ],
  };
}

type PlayerRow = {
  id: string;
  full_name: string;
  consent_status: string;
  consent_at: Date | null;
  guardian_name: string | null;
  privacy_consent_at: Date | null;
  person_id: string | null;
};
/** Every player row of a submitted cart, by name (each name is unique in a cart). */
async function rowsByName(groupId: string): Promise<Map<string, PlayerRow>> {
  const rows = await sql<PlayerRow[]>`
    select rp.id, rp.full_name, rp.consent_status, rp.consent_at, rp.guardian_name, rp.privacy_consent_at, rp.person_id
      from registration_players rp join registrations r on r.id = rp.registration_id
     where r.group_id = ${groupId}`;
  return new Map(rows.map((row) => [row.full_name, row]));
}

/** Entries the hub's "Consent pending" filter lists for this competition (the organiser's own read). */
async function consentPendingIds(r: Rig): Promise<string[]> {
  const rows = await listRegistrations(r.owner, null, null, { competition_id: r.competitionId, consent_pending: true });
  return rows.map((row) => row.id).sort();
}

beforeEach(() => {
  transport.deliver.mockReset().mockImplementation(async () => ({ ok: true, providerId: `re_${RUN}_${randomUUID()}` }));
  stubOutboxEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (!HAS_DB || orgs.length === 0) return;
  await sql`delete from email_outbox where org_id = any(${orgs}::uuid[])`;
});

describe.skipIf(!HAS_DB)("guardian_for_minors at submit (DB)", () => {
  it("ticked: every typed-in minor is guardian-consented in the contact's name; the adult and the undated row stay pending", async () => {
    const r = await competitionRig();
    const [{ t: before }] = await sql<{ t: Date }[]>`select clock_timestamp() as t`;

    const res = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, true, `${RUN}-ada@x.test`));

    const [{ t: after }] = await sql<{ t: Date }[]>`select clock_timestamp() as t`;
    const rows = await rowsByName(res.group_id);
    expect(rows.size, "five rows written, one per typed-in player").toBe(5);
    const minors = ["Ada Minor", "Ben Minor", "Eli Minor"];
    for (const name of minors) {
      const row = rows.get(name)!;
      expect(row.consent_status, name).toBe("guardian");
      expect(row.guardian_name, name).toBe(CONTACT_NAME);
      expect(row.consent_at!.getTime(), `${name} consented at the submit`).toBeGreaterThanOrEqual(before.getTime());
      expect(row.consent_at!.getTime(), name).toBeLessThanOrEqual(after.getTime());
    }
    for (const name of ["Cal Adult", "Dee Undated"]) {
      expect(rows.get(name), name).toMatchObject({ consent_status: "pending", consent_at: null, guardian_name: null });
    }

    // The hub: the team still waits on its adult; the individual entry (one guardian-consented minor) no longer reads Consent pending.
    const teamEntry = res.entries.find((e) => e.division_id === r.teamId)!.registration_id;
    expect(await consentPendingIds(r)).toEqual([teamEntry]);
  });

  it("unticked (and absent): every typed-in row is pending exactly as before, on a first and a second submit", async () => {
    const r = await competitionRig();

    const first = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, false, `${RUN}-a1@x.test`));
    const second = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, undefined, `${RUN}-a2@x.test`));

    let checked = 0;
    for (const res of [first, second]) {
      const rows = await rowsByName(res.group_id);
      expect(rows.size).toBe(5);
      for (const row of rows.values()) {
        expect(row, row.full_name).toMatchObject({ consent_status: "pending", consent_at: null, guardian_name: null });
        checked++;
      }
    }
    expect(checked, "ten rows checked across the two carts").toBe(10);
    // Every entry of both carts reads Consent pending on the hub.
    const all = [...first.entries, ...second.entries].map((e) => e.registration_id).sort();
    expect(await consentPendingIds(r)).toEqual(all);
  });

  it("a second submit ticked does not touch the first cart's rows (each cart's own tick decides)", async () => {
    const r = await competitionRig();
    const unticked = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, false, `${RUN}-b1@x.test`));
    const ticked = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, true, `${RUN}-b2@x.test`));

    expect((await rowsByName(unticked.group_id)).get("Ada Minor")!.consent_status).toBe("pending");
    expect((await rowsByName(ticked.group_id)).get("Ada Minor")!.consent_status).toBe("guardian");
  });

  it("ticked with no minor in the cart is accepted and ignored (never a 422)", async () => {
    const r = await competitionRig();
    const res = await submitRegistrationGroup(
      { ...r.ctx, sessionUserId: null },
      {
        contact: { name: CONTACT_NAME, email: `${RUN}-adults@x.test` },
        privacy_consent: true,
        guardian_for_minors: true,
        entries: [
          { division_id: r.teamId, entrant_kind: "team", team_name: "Grown-ups", players: [{ full_name: "Gus Adult", dob: ADULT }, { full_name: "Hal Undated" }], answers: {} },
        ],
      },
    );
    const rows = await rowsByName(res.group_id);
    expect([...rows.values()].map((row) => [row.full_name, row.consent_status]).sort()).toEqual([
      ["Gus Adult", "pending"],
      ["Hal Undated", "pending"],
    ]);
  });

  it("a registrant playing beside their child: their own row stays granted, the child's is guardian-consented", async () => {
    const r = await competitionRig();
    const res = await submitRegistrationGroup(
      { ...r.ctx, sessionUserId: null },
      {
        contact: { name: CONTACT_NAME, email: `${RUN}-self@x.test`, dob: ADULT },
        privacy_consent: true,
        guardian_for_minors: true,
        entries: [
          {
            division_id: r.teamId,
            entrant_kind: "team",
            team_name: "Family",
            registering_self: true,
            self_player_index: 0,
            players: [{ full_name: CONTACT_NAME }, { full_name: "Ivy Minor", dob: TEEN }],
            answers: {},
          },
        ],
      },
    );
    const rows = await rowsByName(res.group_id);
    // The registrant's own row is consented by the registrant (no guardian: they are an adult and gave none).
    expect(rows.get(CONTACT_NAME)).toMatchObject({ consent_status: "granted", guardian_name: null });
    expect(rows.get("Ivy Minor")).toMatchObject({ consent_status: "guardian", guardian_name: CONTACT_NAME });
  });
});

describe.skipIf(!HAS_DB)("the claim link on a guardian-consented row (DB)", () => {
  it("the join link offers no slot for it and a hand-made claim changes nothing; the account link links the account only", async () => {
    const r = await competitionRig();
    const childEmail = `${RUN}-ada-claim@x.test`;
    const res = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, true, childEmail));
    const team = res.entries.find((e) => e.division_id === r.teamId)!;
    expect(team.status, "premise: the free auto-approval entry confirmed, so its people are resolved").toBe("confirmed");
    const before = (await rowsByName(res.group_id)).get("Ada Minor")!;
    expect(before.consent_status, "premise").toBe("guardian");

    // The join link: only the rows still to confirm are offered.
    const preview = await previewJoinEntry(team.join_code!);
    expect(preview.unclaimed_slots.map((s) => s.full_name).sort()).toEqual(["Cal Adult", "Dee Undated"]);
    // A claim of the guardian row made by hand (its id is never offered) is "already joined", and writes nothing.
    const refused = await joinTeamEntry(
      {},
      {
        join_code: team.join_code!,
        player_id: before.id,
        player: { full_name: "Ada Minor", dob: CHILD },
        guardian_name: CONTACT_NAME,
        guardian_consent: true,
        privacy_consent: true,
      },
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(409);

    // The account link: the RS008 sweep (run by the submit's own auto-confirm) invites the guardian-consented row's address.
    let token = "";
    await vi.waitFor(
      () => {
        const mailed = transport.deliver.mock.calls.map((c) => (c[0] as { to: string; text: string })).find((m) => m.to === childEmail);
        if (!mailed) throw new Error("no claim invite mailed yet");
        token = /\/claim\/(pc_[A-Za-z0-9_-]+)/.exec(mailed.text)![1]!;
      },
      { timeout: 15_000, interval: 50 },
    );
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${childEmail}, 'Ada', true) returning id`;
    await claimPerson(token, userId, childEmail);

    const [person] = await sql<{ user_id: string | null }[]>`select user_id from persons where id = ${before.person_id}`;
    expect(person!.user_id, "the account is linked").toBe(userId);
    const after = (await rowsByName(res.group_id)).get("Ada Minor")!;
    // ...and the guardian's consent is exactly as given: never re-asked, never replaced, no privacy consent stamped on the row.
    expect(after).toMatchObject({
      consent_status: "guardian",
      guardian_name: CONTACT_NAME,
      consent_at: before.consent_at,
      privacy_consent_at: null,
    });
  });

  it("unticked: the minor's pending row is offered on the join link and is never invited to link an account", async () => {
    const r = await competitionRig();
    const childEmail = `${RUN}-ada-pending@x.test`;
    const res = await submitRegistrationGroup({ ...r.ctx, sessionUserId: null }, parentsCart(r, false, childEmail));
    const team = res.entries.find((e) => e.division_id === r.teamId)!;
    const preview = await previewJoinEntry(team.join_code!);
    expect(preview.unclaimed_slots.map((s) => s.full_name).sort()).toEqual(["Ada Minor", "Ben Minor", "Cal Adult", "Dee Undated"]);
    // The sweep, run to completion here (the submit's own run is detached): a pending row has nobody's consent, so no invite.
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string | null }[]>`
      select entrant_id from registrations where id = ${team.registration_id}`;
    expect(entrantId, "premise: confirmed at submit, so the sweep has a roster to read").not.toBeNull();
    await inviteUnclaimedMembers(r.orgId, entrantId!);
    const ada = (await rowsByName(res.group_id)).get("Ada Minor")!;
    expect(ada.person_id, "premise: the row resolved a person the sweep could have invited").not.toBeNull();
    const claims = await sql<{ id: string }[]>`select id from person_claims where person_id = ${ada.person_id}`;
    expect(claims).toEqual([]);
  });
});
