// RS005 W2b — real-Postgres coverage for the row-expand detail's data layer
// (`fetchRegistrantDetails`). fetch-registrant-details.test.ts (mocked
// @/lib/db) proves the QUERY COUNT and the grouping logic in isolation; this
// file proves the actual SQL is valid and correctly scoped against a real
// database — roster ordering, the zero-player degenerate case, self-inclusive
// cart siblings, and the LEFT JOIN to registration_settings for form_fields.
// Same split as fetch-registrant-rows.test.ts / fetch-registrant-rows-db.test.ts.
import { describe, expect, it } from "vitest";
import { fetchRegistrantDetails } from "../data";
import {
  seedOrg,
  asOwner,
  rig,
  seedRegistration,
  seedSecondEntry,
  SETTINGS_BASE,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { createDivision } from "@/server/usecases/divisions";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const SETTINGS = { fee_cents: 0, currency: "usd", payment_method: "offline" as const };

describe.skipIf(!HAS_DB)("fetchRegistrantDetails — real Postgres", () => {
  describe("roster", () => {
    it("batches across multiple entries and orders captain-first, then squad number, then name", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);

      const { registration: reg1 } = await seedRegistration(competition.id, division.id, SETTINGS, {
        players: [
          { name: "Sam", squadNumber: 4 },
          { name: "Alex", squadNumber: 2 },
        ],
      });
      const { registration: reg2 } = await seedRegistration(competition.id, division.id, SETTINGS, {
        players: [{ name: "Jordan", squadNumber: null }],
      });
      // Make "Alex" (squad 2) the captain of reg1 — captain-first must win
      // over squad-number order.
      await sql`update registration_players set is_captain = true, consent_status = 'granted'
                where registration_id = ${reg1.id} and full_name = 'Alex'`;
      await sql`update registration_players set consent_status = 'pending'
                where registration_id = ${reg1.id} and full_name = 'Sam'`;
      await sql`update registration_players set consent_status = 'guardian', guardian_name = 'Guardian Jordan'
                where registration_id = ${reg2.id}`;

      const result = await fetchRegistrantDetails(owner, [
        { id: reg1.id, group_id: reg1.group_id },
        { id: reg2.id, group_id: reg2.group_id },
      ]);

      const roster1 = result.rosterByRegistration.get(reg1.id)!;
      expect(roster1.map((p) => p.full_name)).toEqual(["Alex", "Sam"]);
      expect(roster1[0]!.is_captain).toBe(true);
      expect(roster1[0]!.consent_status).toBe("granted");
      expect(roster1[1]!.consent_status).toBe("pending");

      const roster2 = result.rosterByRegistration.get(reg2.id)!;
      expect(roster2).toHaveLength(1);
      expect(roster2[0]!.consent_status).toBe("guardian");
    });

    it("an entry with NO players has no key in the map at all — the degenerate case", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {});

      const result = await fetchRegistrantDetails(owner, [
        { id: registration.id, group_id: registration.group_id },
      ]);
      expect(result.rosterByRegistration.get(registration.id)).toBeUndefined();
    });

    it("never leaks a DIFFERENT registration's players onto this one", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const { registration: reg1 } = await seedRegistration(competition.id, division.id, SETTINGS, {
        players: [{ name: "OnlyOnReg1" }],
      });
      const { registration: reg2 } = await seedRegistration(competition.id, division.id, SETTINGS, {});

      // Only reg1 is asked for — reg2 (a real sibling division-mate, NOT in
      // the requested id list) must contribute nothing.
      const result = await fetchRegistrantDetails(owner, [{ id: reg1.id, group_id: reg1.group_id }]);
      expect(result.rosterByRegistration.get(reg1.id)!.map((p) => p.full_name)).toEqual(["OnlyOnReg1"]);
      expect(result.rosterByRegistration.has(reg2.id)).toBe(false);
    });
  });

  describe("cart siblings", () => {
    it("a multi-entry cart groups every entry under its shared group_id, self-inclusive", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const { registration: first } = await seedRegistration(competition.id, division.id, SETTINGS, {
        displayName: "First Entry",
      });
      const second = await seedSecondEntry(first.group_id, division.id, 0, "Second Entry");

      const result = await fetchRegistrantDetails(owner, [
        { id: first.id, group_id: first.group_id },
        { id: second.id, group_id: second.group_id },
      ]);
      const siblings = result.siblingsByGroup.get(first.group_id)!;
      expect(siblings.map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
      expect(siblings.find((s) => s.id === second.id)!.display_name).toBe("Second Entry");
    });

    it("a single-entry cart's group list has length 1 — itself only", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {});

      const result = await fetchRegistrantDetails(owner, [
        { id: registration.id, group_id: registration.group_id },
      ]);
      expect(result.siblingsByGroup.get(registration.group_id)).toHaveLength(1);
    });

    it("never mixes two DIFFERENT carts into one group's list", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const { registration: cartA } = await seedRegistration(competition.id, division.id, SETTINGS, {});
      const { registration: cartB } = await seedRegistration(competition.id, division.id, SETTINGS, {});

      const result = await fetchRegistrantDetails(owner, [
        { id: cartA.id, group_id: cartA.group_id },
        { id: cartB.id, group_id: cartB.group_id },
      ]);
      expect(result.siblingsByGroup.get(cartA.group_id)!.map((s) => s.id)).toEqual([cartA.id]);
      expect(result.siblingsByGroup.get(cartB.group_id)!.map((s) => s.id)).toEqual([cartB.id]);
    });
  });

  describe("form_fields (answers label lookup, task 2 — LEFT JOIN, no third query)", () => {
    it("reads the entry's OWN division's declared form_fields", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      await putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        form_fields: [{ key: "dietary_reqs", label: "Dietary requirements", kind: "text", required: false }],
      });
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {
        answers: { dietary_reqs: "Vegetarian" },
      });

      const result = await fetchRegistrantDetails(owner, [
        { id: registration.id, group_id: registration.group_id },
      ]);
      expect(result.formFieldsByRegistration.get(registration.id)).toEqual([
        { key: "dietary_reqs", label: "Dietary requirements", kind: "text", required: false },
      ]);
    });

    it("defaults to [] for a division with NO registration_settings row at all (LEFT JOIN miss)", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      // rig()'s division is left deliberately unconfigured.
      const { competition, division } = await rig(owner);
      const { registration } = await seedRegistration(competition.id, division.id, SETTINGS, {});

      const result = await fetchRegistrantDetails(owner, [
        { id: registration.id, group_id: registration.group_id },
      ]);
      expect(result.formFieldsByRegistration.get(registration.id)).toEqual([]);
    });

    it("two entries in different divisions get their OWN division's fields, never each other's", async () => {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition, division: divA } = await rig(owner);
      const divB = await createDivision(owner, competition.id, {
        name: "Division B",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        eligibility: [],
      });
      await putRegistrationSettings(owner, divA.id, {
        ...SETTINGS_BASE,
        form_fields: [{ key: "a_field", label: "A field", kind: "text", required: false }],
      });
      await putRegistrationSettings(owner, divB.id, {
        ...SETTINGS_BASE,
        form_fields: [{ key: "b_field", label: "B field", kind: "text", required: false }],
      });
      const { registration: regA } = await seedRegistration(competition.id, divA.id, SETTINGS, {});
      const { registration: regB } = await seedRegistration(competition.id, divB.id, SETTINGS, {});

      const result = await fetchRegistrantDetails(owner, [
        { id: regA.id, group_id: regA.group_id },
        { id: regB.id, group_id: regB.group_id },
      ]);
      expect(result.formFieldsByRegistration.get(regA.id)!.map((f) => f.key)).toEqual(["a_field"]);
      expect(result.formFieldsByRegistration.get(regB.id)!.map((f) => f.key)).toEqual(["b_field"]);
    });
  });

  it("an empty row list resolves to empty maps without querying (no crash on a 0-row page)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const result = await fetchRegistrantDetails(owner, []);
    expect(result.rosterByRegistration.size).toBe(0);
    expect(result.siblingsByGroup.size).toBe(0);
    expect(result.formFieldsByRegistration.size).toBe(0);
  });
});
