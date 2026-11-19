// W5 app PR A, Task 10 fix round 1 (I2; R12, RB5-R2, RB5-R3): the two roster doors `patchEntrant` is not.
//
// - The bulk import's `roster.add` onto an EXISTING entrant (`imports.ts`; the planner plans one only for a membership the
//   snapshot does not hold, so it is always a person JOINING): onto a pair of a started league it is a substitute partner,
//   refused 422 RR_SUBSTITUTE_PARTNER_REFUSED before anything is written.
// - A placed solo sign-up who leaves (`releaseSoloSignUpPlacement`, called by withdraw and reject): the member row used to be
//   deleted silently, so a started pair lost a partner and stayed seated. It now dissolves the pair through the withdrawal
//   cascade - the pair withdraws, its record (both people) stands.
//
// differential (both): at 69e0044f08 the import wrote the join and the release deleted the partner, with every fixture untouched
// and the pair still in the field.
//
// The expiry sweep calls the same release but cannot meet a placed solo: assign refuses an unpaid entry and expiry takes only
// `pending` ones, so it is wired (the collector, the post-commit cascade) and not driven here.
//
// Task 10b (ruling 292): both doors apply in EVERY format after Start - the rigs take the entry stage's kind (league, swiss,
// knockout) and each door test is driven in all three; the Swiss/knockout dissolves write no `table_withdrawal` row, so the
// Reinstate sequence reads its own `withdrawal_reinstated` trace.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { getCompetitionDesk } from "../competition-desk";
import { createImport, commitImport } from "../imports";
import { putRegistrationSettings, confirmRegistration, withdrawRegistrationOrganiser } from "../registrations";
import { rejectRegistration } from "../registration-approval";
import { releaseSoloSignUpPlacement } from "../registrations";
import { assignSoloSignUp } from "../registration-assign";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedFootballCatalog, seedOrg } from "./_seed";

// A cascade failure is simulated as self-withdraw-after-start.test.ts does it: the cascade's first cross-module call
// (`replaceDepartedQualifier`, called only by the withdrawal cascade, inside its per-entrant lock and before any write) throws once.
const control = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock("../lucky-loser", async (io) => {
  const real = await io<typeof import("../lucky-loser")>();
  return {
    ...real,
    replaceDepartedQualifier: async (...args: Parameters<typeof real.replaceDepartedQualifier>) => {
      control.calls++;
      if (control.failNext) {
        control.failNext = false;
        throw new Error("simulated: the cascade's first step failed");
      }
      return real.replaceDepartedQualifier(...args);
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;

type StageKind = "league" | "swiss" | "knockout";
const STAGE_KINDS: readonly StageKind[] = ["league", "swiss", "knockout"];
const stageConfig = (kind: StageKind) => (kind === "league" ? { legs: 1 } : kind === "swiss" ? { rounds: 1 } : {});
/** Only a league is generated before Start (the existing rigs' way); a Swiss pairs round one after it (startDivision mints shells). */
async function afterStart(auth: Parameters<typeof startDivision>[0], divisionId: string, stageId: string, kind: StageKind) {
  await startDivision(auth, divisionId);
  if (kind === "swiss") await generateStageFixtures(auth, stageId);
}

const csvUpload = (csv: string) => ({ filename: "import.csv", contentType: "text/csv", buffer: Buffer.from(csv, "utf8") });
const HEADER = "Club,Team,Player,DOB,Number,Position,Captain,Division";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\r\n");

const membersOf = async (entrantId: string): Promise<string[]> =>
  (await sql<{ full_name: string }[]>`
    select p.full_name from entrant_members em join persons p on p.id = em.person_id
    where em.entrant_id = ${entrantId} order by p.full_name`).map((m) => m.full_name);
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;
const personCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from persons where org_id = ${orgId}`)[0]!.n;

describe.skipIf(!HAS_DB)("X-RP-3 the bulk import is a roster door (R12)", () => {
  async function rig(start: boolean, kind: StageKind = "league") {
    const { auth } = await seedOrg();
    await seedFootballCatalog();
    const comp = await createCompetition(auth, { name: "Import Pairs", visibility: "private", branding: {}, ends_on: "2030-12-31" });
    const division = await createDivision(auth, comp.id, { name: "U12", slug: "u12", sport_key: "football", variant_key: "default", config: {} });
    const first = await createImport(
      auth,
      csvUpload(csv("Acme SC,Acme U12,Ada One,2014-01-01,1,,,u12", "Acme SC,Acme U12,Bo Two,2014-01-02,2,,,u12", "Borough FC,Borough U12,Di Four,2014-01-04,4,,,u12")),
    );
    await commitImport(auth, first.importId, null);
    const entrant = async (name: string) =>
      (await sql<{ id: string }[]>`select id from entrants where division_id = ${division.id} and display_name = ${name}`)[0]!.id;
    const acme = await entrant("Acme U12");
    const borough = await entrant("Borough U12");
    // The import makes teams; Acme is rewritten to a pair (the same fixture rewrite as the squad-seed suites: a legacy-shape row
    // built through the real door and then reshaped by SQL).
    await sql`update entrants set kind = 'pair' where id = ${acme}`;
    const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: "Table", config: stageConfig(kind), progression: null });
    if (kind === "league") await generateStageFixtures(auth, stage!.id);
    if (start) await afterStart(auth, division.id, stage!.id, kind);
    return { auth, division, acme, borough };
  }

  it("a roster.add onto a pair of a started league is refused and writes nothing; before Start it is allowed; a team of the same league still takes it", async () => {
    let checked = 0;
    // Before Start: the join is allowed (the pin).
    {
      const r = await rig(false);
      const plan = await createImport(r.auth, csvUpload(csv("Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12")));
      expect((plan.plan.ops as { kind: string }[]).filter((o) => o.kind === "roster.add"), "premise: the file plans one join onto the existing entrant").toHaveLength(1);
      await commitImport(r.auth, plan.importId, null);
      expect(await membersOf(r.acme)).toEqual(["Ada One", "Bo Two", "Cy Three"]);
      checked++;
    }
    // After Start: refused by code, and the whole commit rolls back (the new person is not created either).
    {
      const r = await rig(true);
      const plan = await createImport(r.auth, csvUpload(csv("Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12")));
      expect((plan.plan.ops as { kind: string }[]).filter((o) => o.kind === "roster.add")).toHaveLength(1);
      const persons = await personCount(r.auth.orgId);
      await expect(commitImport(r.auth, plan.importId, null)).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
      expect(await membersOf(r.acme), "the pair is as it was").toEqual(["Ada One", "Bo Two"]);
      expect(await personCount(r.auth.orgId), "nothing written: Cy was not created").toBe(persons);
      expect(await statusOf(r.acme)).toBe("registered");
      checked++;
      // The positive pair in the same started league: a TEAM (Borough) takes a join exactly as before.
      const team = await createImport(r.auth, csvUpload(csv("Borough FC,Borough U12,Eve Nine,2014-01-09,9,,,u12")));
      await commitImport(r.auth, team.importId, null);
      expect(await membersOf(r.borough)).toEqual(["Di Four", "Eve Nine"]);
      checked++;
      // And a withdrawn pair is frozen too: the same file is still refused.
      await sql`update entrants set status = 'withdrawn' where id = ${r.acme}`;
      const again = await createImport(r.auth, csvUpload(csv("Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12")));
      await expect(commitImport(r.auth, again.importId, null)).rejects.toMatchObject({ code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
      checked++;
    }
    expect(checked, "anti-vacuity: four cases driven").toBe(4);
  }, 300_000);

  for (const kind of STAGE_KINDS.filter((k) => k !== "league")) {
    it(`ruling 292: an import roster.add onto a pair of a started ${kind} is refused and writes nothing; before Start it is allowed`, async () => {
      // differential: today (eb2b12514f) the join is written outside a root league or group.
      let checked = 0;
      {
        const r = await rig(false, kind);
        const plan = await createImport(r.auth, csvUpload(csv("Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12")));
        await commitImport(r.auth, plan.importId, null);
        expect(await membersOf(r.acme), `${kind} before Start: the join is allowed`).toEqual(["Ada One", "Bo Two", "Cy Three"]);
        checked++;
      }
      const r = await rig(true, kind);
      const plan = await createImport(r.auth, csvUpload(csv("Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12")));
      expect((plan.plan.ops as { kind: string }[]).filter((o) => o.kind === "roster.add"), "premise: one join planned").toHaveLength(1);
      const persons = await personCount(r.auth.orgId);
      await expect(commitImport(r.auth, plan.importId, null)).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
      expect(await membersOf(r.acme), "the pair is as it was").toEqual(["Ada One", "Bo Two"]);
      expect(await personCount(r.auth.orgId), "nothing written").toBe(persons);
      checked++;
      // The positive pair: a TEAM of the same started division still takes a join.
      const team = await createImport(r.auth, csvUpload(csv("Borough FC,Borough U12,Eve Nine,2014-01-09,9,,,u12")));
      await commitImport(r.auth, team.importId, null);
      expect(await membersOf(r.borough)).toEqual(["Di Four", "Eve Nine"]);
      checked++;
      expect(checked).toBe(3);
    }, 300_000);
  }
});

describe.skipIf(!HAS_DB)("X-RP-2 a placed solo sign-up who leaves a started pair dissolves it (R12b)", () => {
  /** A football team division taking solo sign-ups; the team entry "Pair A" materialised as an entrant (rewritten to a pair) holding its
   *  captain and the placed solo, in a started league against two more teams. */
  async function rig(start: boolean, soloStatus: "confirmed" | "paid" = "confirmed", kind: StageKind = "league") {
    const { auth } = await seedOrg();
    await seedFootballCatalog();
    const comp = await createCompetition(auth, { name: "Solo Pairs", visibility: "public", branding: {}, starts_on: "2030-06-01", ends_on: "2030-12-31" });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "football", variant_key: "default", config: {} });
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
    const seed = async (displayName: string, opts: { freeAgent?: boolean; status: string; players: string[] }) => {
      const [group] = await sql<{ id: string }[]>`
        insert into registration_groups (competition_id, contact_name, contact_email, access_token_hash, currency)
        values (${comp.id}, 'Contact', ${`c-${displayName.replace(/\W/g, "")}@test.local`}, ${`tok-${displayName}-${Math.random()}`}, 'gbp') returning id`;
      const [reg] = await sql<{ id: string }[]>`
        insert into registrations (group_id, division_id, display_name, free_agent, status)
        values (${group!.id}, ${division.id}, ${displayName}, ${opts.freeAgent ?? false}, ${opts.status}) returning id`;
      for (const name of opts.players) {
        await sql`insert into registration_players (registration_id, full_name, source, consent_status) values (${reg!.id}, ${name}, 'captain_entered', 'pending')`;
      }
      return reg!;
    };
    const team = await seed("Pair A", { status: "pending", players: ["Captain One"] });
    await confirmRegistration(auth, team.id);
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${team.id}`;
    const solo = await seed("Priya Raman", { freeAgent: true, status: soloStatus, players: ["Priya Raman"] });
    await assignSoloSignUp(auth, { registration_id: solo.id, target_registration_id: team.id });
    await createEntrants(auth, division.id, [
      { kind: "team", display_name: "Team B", members: [] },
      { kind: "team", display_name: "Team C", members: [] },
    ]);
    await sql`update entrants set kind = 'pair' where id = ${entrantId}`;
    const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: "Table", config: stageConfig(kind), progression: null });
    if (kind === "league") await generateStageFixtures(auth, stage!.id);
    if (start) await afterStart(auth, division.id, stage!.id, kind);
    return { auth, division, divisionId: division.id, competitionId: comp.id, team, solo, entrantId };
  }
  const withdrawalRows = (divisionId: string) =>
    sql<{ payload: Record<string, unknown> }[]>`select payload from division_events where division_id = ${divisionId} and type = 'table_withdrawal' order by seq`;

  it("the solo withdraws from a started pair: the pair withdraws through the cascade and keeps both people; before Start the member is simply released", async () => {
    // Before Start (the pin): nothing changes - the member row goes, the pair stays.
    {
      const r = await rig(false);
      await withdrawRegistrationOrganiser(r.auth, r.solo.id);
      expect(await membersOf(r.entrantId), "released before Start, as ever").toEqual(["Captain One"]);
      expect(await statusOf(r.entrantId), "still in the field").toBe("confirmed");
    }
    // After Start.
    const r = await rig(true);
    expect(await membersOf(r.entrantId), "premise: the pair holds its captain and the placed solo").toEqual(["Captain One", "Priya Raman"]);
    await withdrawRegistrationOrganiser(r.auth, r.solo.id);
    expect(await statusOf(r.entrantId), "the pair that lost its partner withdrew").toBe("withdrawn");
    expect(await membersOf(r.entrantId), "its record stands: nobody is deleted from it").toEqual(["Captain One", "Priya Raman"]);
    expect((await withdrawalRows(r.divisionId)).length, "one ledger row: the pair's one league").toBe(1);
    // The sequence: the withdrawal is idempotent - a second call changes nothing.
    await withdrawRegistrationOrganiser(r.auth, r.solo.id);
    expect((await withdrawalRows(r.divisionId)).length).toBe(1);
  }, 300_000);

  it("the solo is rejected from a started pair: the same dissolve", async () => {
    const r = await rig(true, "paid");
    await sql`update registration_settings set approval = 'manual' where division_id = ${r.divisionId}`;
    await rejectRegistration(r.auth, r.solo.id);
    expect(await statusOf(r.entrantId)).toBe("withdrawn");
    expect(await membersOf(r.entrantId)).toEqual(["Captain One", "Priya Raman"]);
  }, 300_000);

  /** The desk's "withdrawal did not finish" rows for the rig's division. */
  const deskOwed = async (r: { auth: Parameters<typeof getCompetitionDesk>[0]; competitionId: string; divisionId: string }) =>
    ((await getCompetitionDesk(r.auth, r.competitionId)).divisions.get(r.divisionId)?.attention ?? []).filter((a) => a.kind === "withdrawal_owed");

  it("I-1 a pair dissolve that fails after the solo's release is shown on the desk and finished by the solo's re-POST; a dissolve that succeeds shows nothing", async () => {
    // Positive pair first: the successful dissolve leaves nothing owed (and a marker row was written but is not owed).
    {
      const ok = await rig(true);
      expect(await deskOwed(ok), "the empty case: nobody owed").toEqual([]);
      await withdrawRegistrationOrganiser(ok.auth, ok.solo.id);
      expect(await statusOf(ok.entrantId)).toBe("withdrawn");
      expect(await deskOwed(ok), "a successful dissolve shows nothing").toEqual([]);
    }
    const r = await rig(true);
    control.failNext = true;
    await withdrawRegistrationOrganiser(r.auth, r.solo.id);
    expect(control.failNext, "premise: the cascade ran and failed").toBe(false);
    expect(await statusOf(r.entrantId), "the pair is still in the field, still carrying the departed solo").toBe("confirmed");
    expect(await deskOwed(r), "the desk names the pair").toEqual([{ kind: "withdrawal_owed", count: 1, names: ["Pair A"] }]);
    expect(
      (await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${r.divisionId} and type = 'pair_dissolve_owed'`)[0]!.n,
      "one durable marker",
    ).toBe(1);
    const calls = control.calls;
    await withdrawRegistrationOrganiser(r.auth, r.solo.id); // the solo's re-POST
    expect(control.calls - calls, "the retry ran the cascade once").toBe(1);
    expect(await statusOf(r.entrantId)).toBe("withdrawn");
    expect(await membersOf(r.entrantId), "its record stands").toEqual(["Captain One", "Priya Raman"]);
    expect((await withdrawalRows(r.divisionId)).length, "one ledger row").toBe(1);
    expect(await deskOwed(r), "finished: the item clears").toEqual([]);
    await withdrawRegistrationOrganiser(r.auth, r.solo.id);
    expect(control.calls - calls, "departed: a further re-POST runs no cascade").toBe(1);
  }, 300_000);

  it("I-1 the organiser's Withdraw on the owed pair finishes it too; so does a rejection POSTed again", async () => {
    {
      const r = await rig(true);
      control.failNext = true;
      await withdrawRegistrationOrganiser(r.auth, r.solo.id);
      expect(await deskOwed(r)).toHaveLength(1);
      await patchEntrant(r.auth, r.entrantId, { status: "withdrawn" });
      expect(await statusOf(r.entrantId)).toBe("withdrawn");
      expect(await deskOwed(r), "the organiser's Withdraw clears the item").toEqual([]);
    }
    {
      const r = await rig(true, "paid");
      await sql`update registration_settings set approval = 'manual' where division_id = ${r.divisionId}`;
      control.failNext = true;
      await rejectRegistration(r.auth, r.solo.id);
      expect(control.failNext, "premise: the cascade ran and failed").toBe(false);
      expect(await deskOwed(r)).toEqual([{ kind: "withdrawal_owed", count: 1, names: ["Pair A"] }]);
      await rejectRegistration(r.auth, r.solo.id); // already rejected: the retry
      expect(await statusOf(r.entrantId)).toBe("withdrawn");
      expect(await deskOwed(r)).toEqual([]);
    }
  }, 300_000);

  it("a caller that cannot run the cascade (no collector) is refused rather than deleting the partner silently", async () => {
    // The guard behind the two doors above: `releaseSoloSignUpPlacement` called bare, as `unassignSoloSignUp` calls it.
    const r = await rig(true);
    await expect(sql.begin((tx) => releaseSoloSignUpPlacement(tx, r.solo.id))).rejects.toMatchObject({ status: 422, code: "RR_SUBSTITUTE_PARTNER_REFUSED" });
    expect(await membersOf(r.entrantId), "the refused release deleted nobody").toEqual(["Captain One", "Priya Raman"]);
  }, 300_000);

  it("a started TEAM (not a pair) simply loses the member, as before", async () => {
    const r = await rig(true);
    await sql`update entrants set kind = 'team' where id = ${r.entrantId}`;
    await withdrawRegistrationOrganiser(r.auth, r.solo.id);
    expect(await membersOf(r.entrantId)).toEqual(["Captain One"]);
    expect(await statusOf(r.entrantId), "still in the field").toBe("confirmed");
  }, 300_000);

  for (const kind of STAGE_KINDS.filter((k) => k !== "league")) {
    it(`ruling 292: a placed solo who leaves a started ${kind} pair dissolves it through the cascade; the pair is Reinstated and is NOT owed, a re-POST does not withdraw it again`, async () => {
      // differential: today the pair stays seated carrying a departed partner outside a root league or group; and (the closed 8b
      // limit) a Swiss/knockout dissolve then Reinstate read as "withdrawal did not finish" and the solo's re-POST withdrew it again.
      {
        const before = await rig(false, "confirmed", kind);
        await withdrawRegistrationOrganiser(before.auth, before.solo.id);
        expect(await membersOf(before.entrantId), "before Start the member is simply released").toEqual(["Captain One"]);
        expect(await statusOf(before.entrantId)).toBe("confirmed");
      }
      const r = await rig(true, "confirmed", kind);
      expect(await membersOf(r.entrantId), "premise").toEqual(["Captain One", "Priya Raman"]);
      await withdrawRegistrationOrganiser(r.auth, r.solo.id);
      expect(await statusOf(r.entrantId), `the ${kind} pair that lost its partner withdrew`).toBe("withdrawn");
      expect(await membersOf(r.entrantId), "its record stands").toEqual(["Captain One", "Priya Raman"]);
      expect((await withdrawalRows(r.divisionId)).length, "Swiss and knockout write no table-withdrawal row").toBe(0);
      expect(await deskOwed(r), "dissolved: nothing owed").toEqual([]);

      // The sequence: Reinstate, then the desk is quiet and the solo's re-POST runs no cascade.
      await patchEntrant(r.auth, r.entrantId, { status: "confirmed" });
      expect(await statusOf(r.entrantId), "Reinstated").toBe("confirmed");
      expect(await deskOwed(r), "THE LIMIT: a Reinstated Swiss/knockout pair is not 'withdrawal did not finish'").toEqual([]);
      const calls = control.calls;
      await withdrawRegistrationOrganiser(r.auth, r.solo.id); // the solo's re-POST
      expect(control.calls - calls, "the retry ran no cascade").toBe(0);
      expect(await statusOf(r.entrantId), "still Reinstated").toBe("confirmed");
    }, 300_000);

    it(`ruling 292: a ${kind} dissolve that fails after the solo's release is shown on the desk and finished by the re-POST`, async () => {
      const r = await rig(true, "confirmed", kind);
      control.failNext = true;
      await withdrawRegistrationOrganiser(r.auth, r.solo.id);
      expect(control.failNext, "premise: the cascade ran and failed").toBe(false);
      expect(await statusOf(r.entrantId)).toBe("confirmed");
      expect(await deskOwed(r), "the desk names the pair").toEqual([{ kind: "withdrawal_owed", count: 1, names: ["Pair A"] }]);
      await withdrawRegistrationOrganiser(r.auth, r.solo.id);
      expect(await statusOf(r.entrantId)).toBe("withdrawn");
      expect(await deskOwed(r)).toEqual([]);
    }, 300_000);
  }
});
