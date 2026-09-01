// RS011 — organiser-side eligibility gates. Divisions declare eligibility
// (age/gender/category); before this session only the public registration
// path enforced it — every organiser-side roster-write path accepted an
// ineligible person silently. This suite drives all 7 gate points through
// their REAL usecase functions against real Postgres (RLS, competition_events
// audit ledger); skipped without DATABASE_URL, same convention as every
// other DB-backed usecase suite in this directory.
//
// "Exactly one eligibility evaluator exists repo-wide" (acceptance
// criterion) is proven by IMPORT, not by a test in this file: every gate
// below calls `gateRosterEligibility`/`rosterIssues` from
// `../registration-eligibility` — the SAME module + SAME `rosterIssues`
// function `registration-eligibility.test.ts` unit-tests and the public
// registration submit path (`registration-submit.ts`) imports
// `divisionEligibilityIssues`/`rosterIssues` from. See that file's own
// header for the "two evaluators" history this re-homing exists to prevent.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant, syncEntrantRosterFromSquad } from "../entrants";
import { createPerson } from "../persons";
import { createTeam, setTeamSquad } from "../teams";
import { createStages, generateStageFixtures } from "../stages";
import { putLineup } from "../fixtures";
import { createImport, commitImport } from "../imports";
import { confirmRegistration, putRegistrationSettings } from "../registrations";
import { seedOrg as sharedSeedOrg, GENERIC_CONFIG } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  // `_seed.ts`'s seedOrg: pro plan (clubs.hierarchy — createTeam/setTeamSquad
  // need it), generic sport catalog, a REAL owner user (non-null userId, so
  // the audit ledger's actor_id assertions below have something real to
  // check against).
  const { auth } = await sharedSeedOrg("pro");
  return auth;
}

/** A division carrying whatever eligibility rule the caller wants, on the
 *  `generic` sport every other suite in this directory already seeds. */
async function seedDivision(
  auth: AuthCtx,
  rules: { category?: string | null; age_min?: number | null; age_max?: number | null } = {},
  slug = "open-" + randomUUID().slice(0, 8),
) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Elig Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    category: rules.category ?? null,
    age_min: rules.age_min ?? null,
    age_max: rules.age_max ?? null,
  } as never);
  return { comp, division };
}

async function seedPerson(
  auth: AuthCtx,
  name: string,
  extra: { dob?: string | null; gender?: string | null } = {},
) {
  return createPerson(auth, {
    full_name: name,
    consent: {},
    dob: extra.dob ?? null,
    gender: extra.gender ?? null,
    external_ref: null,
  } as never);
}

/** Every `eligibility.overridden` row for this competition — the audit
 *  ledger `gateRosterEligibility`/`commitImport`'s own override branch write
 *  to. */
async function overrideAuditRows(
  competitionId: string,
): Promise<{ type: string; payload: Record<string, unknown>; actor_id: string | null }[]> {
  return sql<{ type: string; payload: Record<string, unknown>; actor_id: string | null }[]>`
    select type, payload, actor_id from competition_events
    where competition_id = ${competitionId} and type = 'eligibility.overridden'
    order by created_at`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("RS011 — organiser-side eligibility gates", () => {
  describe("createEntrants (covers insertMembers, copy_roster and squad-seed too)", () => {
    it("blocks an over-age person with 422 code ELIGIBILITY_VIOLATION — never a bare {status:422}", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });
      await expect(
        createEntrants(auth, division.id, [
          {
            kind: "individual",
            display_name: "Too Old",
            members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
          },
        ]),
      ).rejects.toMatchObject({ status: 422, code: "ELIGIBILITY_VIOLATION" });
    });

    it("an eligible person of the same age band is NOT blocked", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const ok = await seedPerson(auth, "Ok Age", { dob: "2012-01-01" });
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "Ok Age",
          members: [{ person_id: ok.id, is_captain: false, roles: [] }],
        },
      ]);
      expect(entrant!.kind).toBe("individual");
    });

    it("override with a reason succeeds and writes EXACTLY ONE eligibility.overridden audit row naming actor + reason (one per request, not one per person)", async () => {
      const auth = await seedOrg();
      const { comp, division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const tooOld1 = await seedPerson(auth, "Too Old One", { dob: "2000-01-01" });
      const tooOld2 = await seedPerson(auth, "Too Old Two", { dob: "1999-01-01" });
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "team",
          display_name: "Veterans",
          members: [
            { person_id: tooOld1.id, is_captain: false, roles: [] },
            { person_id: tooOld2.id, is_captain: false, roles: [] },
          ],
          eligibility_override: { reason: "Wildcard entry, organiser approved" },
        },
      ]);
      expect(entrant!.display_name).toBe("Veterans");
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1); // TWO ineligible persons on the roster, still ONE row
      expect(rows[0]).toMatchObject({ type: "eligibility.overridden", actor_id: auth.userId });
      expect(rows[0]!.payload).toMatchObject({
        reason: "Wildcard entry, organiser approved",
        context: "roster_add",
      });
      const violations = rows[0]!.payload.violations as unknown[];
      expect(violations).toHaveLength(2); // both offenders named in the payload
    });

    it("missing dob on an age-restricted division is an amber WARNING, never a block", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const noDob = await seedPerson(auth, "No Dob");
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "No Dob",
          members: [{ person_id: noDob.id, is_captain: false, roles: [] }],
        },
      ]);
      expect(entrant!.eligibility_warnings).toEqual([
        expect.objectContaining({ code: "MISSING_DOB" }),
      ]);
    });

    it("category (mens/womens) blocks the wrong gender and admits the right one — first-class columns, not jsonb (V380 dropped it)", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { category: "womens" });
      const male = await seedPerson(auth, "Male Player", { gender: "m" });
      await expect(
        createEntrants(auth, division.id, [
          {
            kind: "individual",
            display_name: "Male Player",
            members: [{ person_id: male.id, is_captain: false, roles: [] }],
          },
        ]),
      ).rejects.toMatchObject({ status: 422, code: "ELIGIBILITY_VIOLATION" });

      const female = await seedPerson(auth, "Female Player", { gender: "f" });
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "Female Player",
          members: [{ person_id: female.id, is_captain: false, roles: [] }],
        },
      ]);
      expect(entrant!.kind).toBe("individual");
    });

    it("a division with NEITHER category nor age band admits anyone, dob/gender or not", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth); // no rules at all
      const p = await seedPerson(auth, "Anyone");
      const [entrant] = await createEntrants(auth, division.id, [
        { kind: "individual", display_name: "Anyone", members: [{ person_id: p.id, is_captain: false, roles: [] }] },
      ]);
      expect(entrant!.eligibility_warnings).toBeUndefined();
    });
  });

  describe("patchEntrant — full roster replacement", () => {
    it("blocks a member replacement that violates eligibility; override succeeds with one audit row", async () => {
      const auth = await seedOrg();
      const { comp, division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const ok = await seedPerson(auth, "Ok", { dob: "2012-01-01" });
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "Roster",
          members: [{ person_id: ok.id, is_captain: false, roles: [] }],
        },
      ]);
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });

      await expect(
        patchEntrant(auth, entrant!.id, {
          members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
        }),
      ).rejects.toMatchObject({ status: 422, code: "ELIGIBILITY_VIOLATION" });

      const patched = await patchEntrant(auth, entrant!.id, {
        members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
        eligibility_override: { reason: "Age exception granted" },
      });
      expect(patched.members).toHaveLength(1);
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ context: "patch_entrant" });
    });

    it("a patch that never touches members is unaffected by the gate (e.g. seed/status alone)", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const [entrant] = await createEntrants(auth, division.id, [
        { kind: "individual", display_name: "Solo", members: [] },
      ]);
      const patched = await patchEntrant(auth, entrant!.id, { seed: 3 });
      expect(patched.seed).toBe(3);
    });
  });

  describe("syncEntrantRosterFromSquad", () => {
    it("blocks a squad re-sync that now carries an ineligible person; override succeeds with one audit row", async () => {
      const auth = await seedOrg();
      const { comp, division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const team = await createTeam(auth, { name: "Team " + randomUUID().slice(0, 6) });
      const ok = await seedPerson(auth, "Ok", { dob: "2012-01-01" });
      await setTeamSquad(auth, team.id, [{ person_id: ok.id, is_captain: false, roles: [] }]);
      const [entrant] = await createEntrants(auth, division.id, [
        { kind: "individual", team_id: team.id, members: [] }, // squad-seeds the eligible "Ok" person
      ]);

      // The squad itself changes to an ineligible person — setTeamSquad never
      // blocks (its own describe block below proves this more directly).
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });
      await setTeamSquad(auth, team.id, [{ person_id: tooOld.id, is_captain: false, roles: [] }]);

      // The EXPLICIT re-sync action DOES gate.
      await expect(syncEntrantRosterFromSquad(auth, entrant!.id)).rejects.toMatchObject({
        status: 422,
        code: "ELIGIBILITY_VIOLATION",
      });
      const synced = await syncEntrantRosterFromSquad(auth, entrant!.id, {
        reason: "Age exception granted",
      });
      expect(synced.members).toHaveLength(1);
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ context: "roster_sync" });
    });
  });

  describe("setTeamSquad — division-agnostic, NEVER hard-blocks", () => {
    it("saves a squad member who fails a category rule for an enrolled division, reporting it as an advisory warning instead of throwing", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { category: "womens" });
      const team = await createTeam(auth, { name: "Team " + randomUUID().slice(0, 6) });
      // Empty squad seed — no violation possible at enrollment time.
      await createEntrants(auth, division.id, [
        { kind: "individual", team_id: team.id, members: [] },
      ]);
      const male = await seedPerson(auth, "Male Player", { gender: "m" });

      // The call must NOT throw — this is the acceptance criterion itself.
      const result = await setTeamSquad(auth, team.id, [
        { person_id: male.id, is_captain: false, roles: [] },
      ]);
      expect(result.members).toHaveLength(1); // saved despite the violation
      expect(result.eligibility_warnings).toEqual([
        {
          division_id: division.id,
          issues: [expect.objectContaining({ code: "CATEGORY_MISMATCH" })],
        },
      ]);
    });

    it("a squad with no eligibility issue anywhere reports an empty warnings array", async () => {
      const auth = await seedOrg();
      const { division } = await seedDivision(auth, { category: "womens" });
      const team = await createTeam(auth, { name: "Team " + randomUUID().slice(0, 6) });
      await createEntrants(auth, division.id, [
        { kind: "individual", team_id: team.id, members: [] },
      ]);
      const female = await seedPerson(auth, "Female Player", { gender: "f" });
      const result = await setTeamSquad(auth, team.id, [
        { person_id: female.id, is_captain: false, roles: [] },
      ]);
      expect(result.eligibility_warnings).toEqual([]);
    });
  });

  // RS011 review fix 2: `ageBandEligibilityIssues` used to THROW for a
  // division whose stored age_cutoff_month/age_cutoff_day is not a real
  // calendar day. The DB CHECK (`divisions_age_cutoff_check`) only
  // range-checks month 1-12 / day 1-31 independently — it does not know
  // February stops at 28 — so a row like (month: 2, day: 30) passes the
  // constraint even though `createDivision`'s Zod refine (`checkAgeCutoff`)
  // would reject it for any NEW write. That throw reached this file's own
  // gate points UNCAUGHT: it fired AFTER `setTeamSquad`'s squad delete/insert
  // already ran in the same transaction (rolling back a save that endpoint's
  // contract promises will never hard-block), and it is not an `HttpError`,
  // so every other gate point would have surfaced a raw 500 instead of the
  // coded 422 `ELIGIBILITY_VIOLATION` the client dialog recognizes.
  describe("an invalid stored age cutoff never bricks a gate (RS011 review fix 2)", () => {
    /** A division whose age band CANNOT be evaluated — bypasses
     *  createDivision's Zod validation the same "pre-feature roster" way
     *  putLineup's own test above bypasses insertMembers via raw SQL: this
     *  row could only exist as a legacy artifact, never through the API. */
    async function seedBadCutoffDivision(auth: AuthCtx) {
      const { comp, division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      await sql`update divisions set age_cutoff_month = 2, age_cutoff_day = 30 where id = ${division.id}`;
      return { comp, division };
    }

    it("gateRosterEligibility (via createEntrants/insertMembers) returns normally — no age check enforced for the malformed division, never a raw 500", async () => {
      const auth = await seedOrg();
      const { division } = await seedBadCutoffDivision(auth);
      // Same fixture as "blocks an over-age person" above — would 422
      // ELIGIBILITY_VIOLATION under a VALID cutoff; the malformed one means
      // no age check runs at all.
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });
      const [entrant] = await createEntrants(auth, division.id, [
        {
          kind: "individual",
          display_name: "Too Old",
          members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
        },
      ]);
      expect(entrant!.kind).toBe("individual");
      expect(entrant!.eligibility_warnings).toBeUndefined();
    });

    it("setTeamSquad still saves the squad successfully against such a division", async () => {
      const auth = await seedOrg();
      const { division } = await seedBadCutoffDivision(auth);
      const team = await createTeam(auth, { name: "Team " + randomUUID().slice(0, 6) });
      await createEntrants(auth, division.id, [
        { kind: "individual", team_id: team.id, members: [] },
      ]);
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });
      const result = await setTeamSquad(auth, team.id, [
        { person_id: tooOld.id, is_captain: false, roles: [] },
      ]);
      expect(result.members).toHaveLength(1);
      expect(result.eligibility_warnings).toEqual([]);
    });
  });

  describe("putLineup", () => {
    it("blocks a lineup naming a pre-feature-roster person who fails eligibility; override succeeds with one audit row", async () => {
      const auth = await seedOrg();
      const { comp, division } = await seedDivision(auth, { age_min: 10, age_max: 15 });
      const [entrantA, entrantB] = await createEntrants(auth, division.id, [
        { kind: "individual", display_name: "A", seed: 1, members: [] },
        { kind: "individual", display_name: "B", seed: 2, members: [] },
      ]);
      expect(entrantB).toBeTruthy(); // needed only so generateStageFixtures has a pair

      // A pre-feature roster: entrant_members inserted DIRECTLY, bypassing
      // the gate entirely (fixtures-lineup.test.ts uses the same raw-SQL
      // technique for its own player seeding) — the exact scenario putLineup's
      // gate exists to catch.
      const tooOld = await seedPerson(auth, "Too Old", { dob: "2000-01-01" });
      await sql`insert into entrant_members (entrant_id, person_id) values (${entrantA!.id}, ${tooOld.id})`;

      const [stage] = await createStages(auth, division.id, {
        seq: 1,
        kind: "league",
        name: "L",
        config: {},
      });
      const { fixtures } = await generateStageFixtures(auth, stage!.id);
      const fx = fixtures[0]!;

      await expect(
        putLineup(auth, fx.id, entrantA!.id, {
          slots: [{ person_id: tooOld.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
        }),
      ).rejects.toMatchObject({ status: 422, code: "ELIGIBILITY_VIOLATION" });

      await putLineup(auth, fx.id, entrantA!.id, {
        slots: [{ person_id: tooOld.id, slot: "starting", position_key: null, order_no: 1, roles: [] }],
        eligibility_override: { reason: "Special dispensation" },
      });
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ context: "put_lineup" });
    });
  });

  describe("commitImport", () => {
    function csvUpload(csv: string) {
      return { filename: "import.csv", contentType: "text/csv", buffer: Buffer.from(csv, "utf8") };
    }

    it("blocks a commit whose roster carries ineligible persons; override succeeds with EXACTLY ONE audit row for the WHOLE import (not one per row)", async () => {
      const auth = await seedOrg();
      const { comp } = await seedDivision(auth, { age_min: 10, age_max: 15 }, "impcup");
      const csv = [
        "Club,Team,Player,DOB,Division",
        "Acme SC,Acme U12,Too Old,2000-01-01,impcup",
        "Acme SC,Acme U12,Also Old,2001-01-01,impcup", // second offender — proves ONE row covers both
      ].join("\n");
      const preview = await createImport(auth, csvUpload(csv));
      expect(preview.plan.issues).toEqual([]); // no engine-level block — eligibility is RS011's own gate

      await expect(commitImport(auth, preview.importId, null)).rejects.toMatchObject({
        status: 422,
        code: "ELIGIBILITY_VIOLATION",
      });
      // rejected BEFORE any write
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from persons where org_id = ${auth.orgId}`;
      expect(n).toBe(0);

      const result = await commitImport(auth, preview.importId, "retry-key", {
        reason: "Bulk wildcard entries, organiser approved",
      });
      expect(result.stats.rosters).toBe(2);
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ context: "import_commit", violation_count: 2 });
    });

    it("a roster row missing dob on an age-restricted division commits as a warning, never blocks", async () => {
      const auth = await seedOrg();
      await seedDivision(auth, { age_min: 10, age_max: 15 }, "impcup2");
      const csv = ["Team,Player,Division", "Acme U12,No Dob,impcup2"].join("\n");
      const preview = await createImport(auth, csvUpload(csv));
      const result = await commitImport(auth, preview.importId, null);
      expect(result.stats.rosters).toBe(1);
    });

    // Review fix 3: `divisions[0]` picked an ARBITRARY touched competition's
    // FK for the override audit row — a multi-competition import silently
    // lost the ledger entry for every OTHER competition it touched. Fixed to
    // follow `participants_imported`'s own precedent (`select distinct
    // competition_id`, one row per).
    it("spans TWO competitions: override succeeds and writes ONE audit row under EACH competition's ledger — never one row total, never a row on only an arbitrary one", async () => {
      const auth = await seedOrg();
      const { comp: compA } = await seedDivision(auth, { age_min: 10, age_max: 15 }, "impcup3a");
      const { comp: compB } = await seedDivision(auth, { age_min: 10, age_max: 15 }, "impcup3b");
      const csv = [
        "Club,Team,Player,DOB,Division",
        "Acme SC,Acme A,Too Old A,2000-01-01,impcup3a",
        "Acme SC,Acme B,Too Old B,2000-01-01,impcup3b",
      ].join("\n");
      const preview = await createImport(auth, csvUpload(csv));
      expect(preview.plan.issues).toEqual([]);

      await expect(commitImport(auth, preview.importId, null)).rejects.toMatchObject({
        status: 422,
        code: "ELIGIBILITY_VIOLATION",
      });

      const result = await commitImport(auth, preview.importId, "retry-key-multi-comp", {
        reason: "Bulk wildcard entries across both cups",
      });
      expect(result.stats.rosters).toBe(2);
      const rowsA = await overrideAuditRows(compA.id);
      const rowsB = await overrideAuditRows(compB.id);
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(1);
    });

    // Review fix 4: the roster-WIDE `MIXED_NEEDS_BOTH_GENDERS` composition
    // check used to be skipped entirely for imports (the module comment
    // called merging against a pre-existing roster out of scope) — but a
    // fresh `entrant.create` + its `roster.add` ops in the SAME commit have
    // no pre-existing roster to merge against; the plan's own ops ARE the
    // whole roster. An all-male roster imported fresh into a `mixed`
    // division must be caught exactly like the entrants-panel path would
    // catch it.
    it("a fresh entrant.create + all-same-gender roster.add ops into a MIXED division blocks composition — exactly like the entrants-panel path; override succeeds", async () => {
      const auth = await seedOrg();
      const { comp } = await seedDivision(auth, { category: "mixed" }, "mixedcup");
      const csv = [
        "Team,Player,Gender,Division",
        "Mixed FC,Player One,m,mixedcup",
        "Mixed FC,Player Two,m,mixedcup",
      ].join("\n");
      const preview = await createImport(auth, csvUpload(csv));
      expect(preview.plan.issues).toEqual([]); // no engine-level block — eligibility is RS011's own gate

      await expect(commitImport(auth, preview.importId, null)).rejects.toMatchObject({
        status: 422,
        code: "ELIGIBILITY_VIOLATION",
      });

      const result = await commitImport(auth, preview.importId, "retry-key-mixed", {
        reason: "Roster still forming, organiser approved",
      });
      expect(result.stats.rosters).toBe(2);
      const rows = await overrideAuditRows(comp.id);
      expect(rows).toHaveLength(1);
    });
  });

  describe("Stripe-webhook materialise path — regression: stays completely UNGATED (payment already taken)", () => {
    it("confirming a registration whose player fails the division's age band still materialises an entrant — no ELIGIBILITY_VIOLATION anywhere in the chain", async () => {
      const auth = await seedOrg();
      const comp = await createCompetition(auth, {
        name: "Materialise Cup " + randomUUID().slice(0, 6),
        visibility: "public",
        branding: {},
        starts_on: "2026-09-15",
        ends_on: "2026-09-20",
      });
      // Age band an organiser-side create would reject a 2000-dob player for.
      const division = await createDivision(auth, comp.id, {
        name: "U12 " + randomUUID().slice(0, 6),
        sport_key: "generic",
        variant_key: "score",
        config: GENERIC_CONFIG,
        age_min: 10,
        age_max: 12,
      } as never);
      await putRegistrationSettings(auth, division.id, {
        enabled: true,
        entrant_kind: "individual",
        fee_cents: 0,
        form_fields: [],
        opens_at: null,
        closes_at: null,
        capacity: null,
        refund_lock_at: null,
      });

      // Direct V363/V364 fixture (same technique registration-materialise.
      // test.ts / registration-user-link.test.ts use — submitRegistration
      // was deleted at the RS001 demolition): a group → registration →
      // registration_players row with a dob WAY outside the age band.
      const [group] = await sql<{ id: string }[]>`
        insert into registration_groups
          (competition_id, contact_name, contact_email, access_token_hash, currency)
        values (
          ${comp.id}, 'Contact', ${`c-${randomUUID().slice(0, 8)}@test.local`},
          ${`tok-${randomUUID()}`}, 'gbp'
        )
        returning id`;
      const [reg] = await sql<{ id: string }[]>`
        insert into registrations (group_id, division_id, display_name)
        values (${group!.id}, ${division.id}, 'Too Old')
        returning id`;
      await sql`
        insert into registration_players
          (registration_id, full_name, dob, gender, source)
        values (${reg!.id}, 'Too Old', '2000-01-01', null, 'captain_entered')`;

      // This is the SAME `materialise` (registrations.ts) the Stripe webhook
      // fulfilment path and the free/auto-confirm submit path call — never
      // touched by RS011's scope, and never should be: payment (or the
      // free-entry equivalent) is already taken by this point.
      const confirmed = await confirmRegistration(auth, reg!.id);
      expect(confirmed.entrant_id).toBeTruthy();
      const [entrant] = await sql<{ id: string }[]>`
        select id from entrants where id = ${confirmed.entrant_id}`;
      expect(entrant).toBeTruthy();
    });
  });
});
