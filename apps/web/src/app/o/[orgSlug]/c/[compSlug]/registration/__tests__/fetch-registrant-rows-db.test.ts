// RS005 W2a — real-Postgres coverage for the Registrants tab's data layer.
// fetch-registrant-rows.test.ts (mocked listRegistrations) proves the WIRING
// — which arguments reach it, and the retry-on-404 control flow; it cannot
// prove the filters actually narrow real rows, or that fetchDivisionOptions'
// own SQL is valid and correctly scoped. That is what this file is for —
// real Postgres required, skipped without DATABASE_URL (repo convention,
// e.g. fetch-division-rows.test.ts). Deliberately modest: `listRegistrations`
// itself (roster_cap, waitlist_position, consent_pending_count, exhaustive
// filter combinations…) is already proven end to end by
// registration-list-read.test.ts (usecases/__tests__, outside this wave's
// file set) — this file only needs to prove THIS wave's new code threads
// through to a real database correctly, not re-prove the read model.
import { describe, expect, it } from "vitest";
import { fetchRegistrantRows, fetchDivisionOptions } from "../data";
import { seedOrg, asOwner, rig, seedRegistration } from "@/server/usecases/__tests__/_registration-fixtures";
import { createDivision } from "@/server/usecases/divisions";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const SETTINGS = { fee_cents: 0, currency: "usd", payment_method: "offline" as const };

describe.skipIf(!HAS_DB)("fetchRegistrantRows — real Postgres", () => {
  it("a status filter narrows to only matching rows", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "confirmed" });
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "withdrawn" });

    const result = await fetchRegistrantRows(owner, competition.id, { status: "confirmed" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe("confirmed");
  });

  it("combined filters compose (status AND free_agent together)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // A pending, non-free-agent entry — must NOT appear in the result below.
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    const target = await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    await sql`update registrations set free_agent = true where id = ${target.registration.id}`;

    const result = await fetchRegistrantRows(owner, competition.id, { status: "pending", free_agent: "1" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe(target.registration.id);
  });

  it("a bogus status value renders unfiltered against a real database, rather than throwing", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "confirmed" });

    const result = await fetchRegistrantRows(owner, competition.id, { status: "not-a-real-status" });
    expect(result.rows).toHaveLength(2);
    expect(result.filters.status).toBeNull();
  });

  it("a division_id belonging to ANOTHER competition retries without it, returning this competition's own rows rather than 500ing", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    // A second, unrelated competition (same org) — syntactically valid
    // division id, does not belong to `competition`.
    const { division: otherDivision } = await rig(owner);

    const result = await fetchRegistrantRows(owner, competition.id, { division_id: otherDivision.id });
    expect(result.rows).toHaveLength(1);
    expect(result.filters.divisionId).toBeNull();
  });

  it("a division_id that does not exist at all gets the same treatment", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });

    const result = await fetchRegistrantRows(owner, competition.id, {
      division_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.filters.divisionId).toBeNull();
  });

  it("a REAL division_id of THIS competition narrows to it", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await seedRegistration(competition.id, division.id, SETTINGS, { status: "pending" });
    const otherDivision = await createDivision(owner, competition.id, {
      name: "Second Division",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await seedRegistration(competition.id, otherDivision.id, SETTINGS, { status: "pending" });

    const result = await fetchRegistrantRows(owner, competition.id, { division_id: division.id });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.division_id).toBe(division.id);
    expect(result.filters.divisionId).toBe(division.id);
  });
});

describe.skipIf(!HAS_DB)("fetchDivisionOptions — real Postgres", () => {
  it("returns id+name for every non-archived division of the competition, ordered by name", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner); // seeds a division named "Open"
    await createDivision(owner, competition.id, {
      name: "Alpha",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });

    const options = await fetchDivisionOptions(owner, competition.id);
    expect(options.map((o) => o.name)).toEqual(["Alpha", "Open"]);
    expect(Object.keys(options[0]!).sort()).toEqual(["id", "name"]);
  });

  it("excludes archived divisions", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`update divisions set archived_at = now() where id = ${division.id}`;

    const options = await fetchDivisionOptions(owner, competition.id);
    expect(options).toHaveLength(0);
  });

  it("never returns another competition's divisions", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    await rig(owner); // a second, unrelated competition, same org

    const options = await fetchDivisionOptions(owner, competition.id);
    expect(options).toHaveLength(1);
  });
});
