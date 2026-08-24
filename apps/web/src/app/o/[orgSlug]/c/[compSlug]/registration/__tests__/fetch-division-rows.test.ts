// RS004 W3 — real-Postgres coverage for the Settings tab's one query
// (`fetchDivisionRows`, page.tsx). The mocked wiring test (page.test.tsx)
// proves the query gets CALLED and its result gets MAPPED correctly; it
// cannot prove the SQL itself is valid or that the LEFT JOIN / coalesce /
// SPOT_HOLDERS subquery behave as claimed against a real database. That is
// what this file is for — real Postgres required, skipped without
// DATABASE_URL (repo convention, e.g. add-ons-tab.test.ts).
import { describe, expect, it } from "vitest";
import { fetchDivisionRows } from "../page";
import {
  seedOrg,
  asOwner,
  rig,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { createDivision } from "@/server/usecases/divisions";
import { putRegistrationSettings } from "@/server/usecases/registrations";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("fetchDivisionRows — real Postgres", () => {
  it("LEFT JOINs registration_settings (never configured -> defaulted row) and counts only SPOT_HOLDERS statuses", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    // rig()'s division is left UNCONFIGURED — no putRegistrationSettings
    // call — so it has no registration_settings row at all.
    const { competition, division: unconfigured } = await rig(owner);

    const configured = await createDivision(owner, competition.id, {
      name: "Z Team Division",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    await putRegistrationSettings(owner, configured.id, {
      enabled: true,
      entrant_kind: "team",
      capacity: 10,
      fee_cents: 500,
      approval: "manual",
      allow_free_agents: true,
      form_fields: [],
    });

    const settings = { fee_cents: 500, currency: "usd", payment_method: "offline" as const };
    await seedRegistration(competition.id, configured.id, settings, { status: "confirmed" });
    await seedRegistration(competition.id, configured.id, settings, { status: "pending" });
    // Waitlisted holds no spot — must NOT count toward `taken`.
    await seedRegistration(competition.id, configured.id, settings, { status: "waitlisted" });

    const rows = await fetchDivisionRows(owner, competition.id);
    expect(rows).toHaveLength(2);

    // Ordered by division name: rig()'s division is named "Open".
    const unconfiguredRow = rows.find((r) => r.division_id === unconfigured.id)!;
    expect(unconfiguredRow).toMatchObject({
      name: "Open",
      category: null,
      age_min: null,
      age_max: null,
      enabled: false,
      entrant_kind: null,
      opens_at: null,
      closes_at: null,
      capacity: null,
      fee_cents: 0,
      approval: null,
      allow_free_agents: false,
      taken: 0,
    });

    const configuredRow = rows.find((r) => r.division_id === configured.id)!;
    expect(configuredRow).toMatchObject({
      name: "Z Team Division",
      enabled: true,
      entrant_kind: "team",
      capacity: 10,
      fee_cents: 500,
      approval: "manual",
      allow_free_agents: true,
      // 1 confirmed + 1 pending hold a spot; the waitlisted one does not.
      taken: 2,
    });
    expect(configuredRow.org_currency).toBeTruthy();
  });
});
