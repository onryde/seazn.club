// RS004 W3 — real-Postgres coverage for the Settings tab's one query
// (`fetchDivisionRows`, page.tsx). The mocked wiring test (page.test.tsx)
// proves the query gets CALLED and its result gets MAPPED correctly; it
// cannot prove the SQL itself is valid or that the LEFT JOIN / coalesce /
// SPOT_HOLDERS subquery behave as claimed against a real database. That is
// what this file is for — real Postgres required, skipped without
// DATABASE_URL (repo convention, e.g. add-ons-tab.test.ts).
import { describe, expect, it } from "vitest";
import { fetchDivisionRows, fetchOrgCurrency, fetchOrgCardUnsupportedCurrency } from "../data";
import {
  seedOrg,
  asOwner,
  rig,
  seedRegistration,
} from "@/server/usecases/__tests__/_registration-fixtures";
import { createDivision } from "@/server/usecases/divisions";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { sql } from "@/lib/db";

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
      // RS007/V380 — createDivision can set these at create time now (see
      // divisions.ts); real values here (not the vacuous null default) so
      // this test can actually prove fetchDivisionRows' SELECT reads them
      // back, not just that the interface declares them.
      category: "mixed",
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
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
    await seedRegistration(competition.id, configured.id, settings, { status: "confirmed" });
    await seedRegistration(competition.id, configured.id, settings, { status: "pending" });
    // Waitlisted holds no spot — must NOT count toward `taken`. Two of them,
    // deliberately a DIFFERENT count than `taken` below (3, not 2): a
    // `waitlisted` subquery that accidentally reused SPOT_HOLDERS (RS005 F4)
    // would read 3 here instead of 2, and a `taken` subquery that accidentally
    // counted 'waitlisted' too would read 5 instead of 3 — either mistake
    // fails this assertion, which a same-count fixture could not catch.
    await seedRegistration(competition.id, configured.id, settings, { status: "waitlisted" });
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
      age_cutoff_month: null,
      age_cutoff_day: null,
      eligibility_note: null,
      enabled: false,
      entrant_kind: null,
      opens_at: null,
      closes_at: null,
      capacity: null,
      fee_cents: 0,
      approval: null,
      allow_free_agents: false,
      taken: 0,
      waitlisted: 0,
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
      // 2 confirmed + 1 pending hold a spot; the two waitlisted ones do not.
      taken: 3,
      // RS005 F4 — the Money section's re-price warning reads this. Counted
      // by its OWN subquery (status = 'waitlisted'), never SPOT_HOLDERS.
      waitlisted: 2,
      // RS007/V380 — set at createDivision time above; proves the SELECT
      // actually reads category/age_cutoff_month/age_cutoff_day/
      // eligibility_note off `divisions`, not just age_min/age_max.
      category: "mixed",
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "School-registered students only",
    });
    expect(configuredRow.org_currency).toBeTruthy();
    // A fresh org's Stripe account is not connected at all — never
    // "unsupported", which would wrongly disable card payments outright.
    expect(configuredRow.org_stripe_unsupported_currency).toBeNull();
  });

  // RS004 W3c: the config panel's card-unsupported-currency message reads
  // this column off the SAME per-row subquery org_currency already uses —
  // proves the join actually reaches organizations.stripe_unsupported_currency,
  // not just that the column exists on the interface.
  it("carries the org's stripe_unsupported_currency on every row (RS004 W3c)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`update organizations set stripe_unsupported_currency = 'jpy' where id = ${orgId}`;

    const rows = await fetchDivisionRows(owner, competition.id);
    const row = rows.find((r) => r.division_id === division.id)!;
    expect(row.org_stripe_unsupported_currency).toBe("jpy");
  });

  // RS004 W3b review finding 3 — `order by d.name` alone has no tiebreaker,
  // so two same-named divisions have no guaranteed relative order (Postgres
  // may return them in either order, and that order may change between
  // requests). Seed enough duplicate-name divisions that a coincidental
  // match between insertion order and id order is vanishingly unlikely
  // (1/5! ≈ 0.8%), then assert the query's actual return order for those
  // rows equals `d.id` ascending — the contract `order by d.name, d.id`
  // promises.
  it("orders duplicate-name divisions stably by id, not by insertion order (finding 3)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);

    const dupeIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const division = await createDivision(owner, competition.id, {
        name: "Same Name Division",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      dupeIds.push(division.id);
    }

    const rows = await fetchDivisionRows(owner, competition.id);
    const dupeRowOrder = rows.filter((r) => dupeIds.includes(r.division_id)).map((r) => r.division_id);
    expect(dupeRowOrder).toEqual([...dupeIds].sort());
  });

  // RS004 W3b review finding 4 — fetchDivisionRows had no cross-org test.
  // CHARACTERISATION, not a bug fix: `divisions` and `registration_settings`
  // both carry org-scoped FORCE ROW LEVEL SECURITY, enforced through
  // withTenant's `set_config('app.current_org', …)` — this is proof that
  // isolation already holds, exercised here for the first time. Org A's
  // auth is used to query org B's competition id DIRECTLY (not just "org A's
  // own data looks right") — the WHERE clause alone (`d.competition_id =
  // ${competitionId}`) would happily return org B's rows if RLS were not
  // enforcing app.current_org underneath it.
  it("never returns another org's rows, even when handed that org's competition id directly (finding 4, RLS proof)", async () => {
    const { orgId: orgIdA, ownerId: ownerIdA } = await seedOrg();
    const ownerA = asOwner(orgIdA, ownerIdA);
    await rig(ownerA); // org A has its own, unrelated competition + division

    const { orgId: orgIdB, ownerId: ownerIdB } = await seedOrg();
    const ownerB = asOwner(orgIdB, ownerIdB);
    const { competition: compB, division: divB } = await rig(ownerB);
    await putRegistrationSettings(ownerB, divB.id, {
      enabled: true,
      entrant_kind: "individual",
      capacity: null,
      fee_cents: 0,
      approval: "auto",
      allow_free_agents: false,
      form_fields: [],
    });

    const rows = await fetchDivisionRows(ownerA, compB.id);
    expect(rows).toHaveLength(0);
  });
});

// RS004 W3b review finding 6 — page.test.tsx's mocked wiring test proves the
// PAGE resolves currency independently of rawRows[0]; it cannot prove
// fetchOrgCurrency's own raw SQL is valid against a real database (same gap
// this file exists to close for fetchDivisionRows — see header comment).
// This is that other half: the actual empty-rows landmine scenario, seeded
// for real.
describe.skipIf(!HAS_DB)("fetchOrgCurrency — real Postgres (finding 6)", () => {
  it("resolves the org's real currency even for a competition with zero divisions", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set currency = 'eur' where id = ${orgId}`;
    // No divisions created at all — fetchDivisionRows would return zero
    // rows for any competition here, so this is the actual finding-6
    // landmine scenario, not just a synthetic empty array.
    const currency = await fetchOrgCurrency(owner);
    expect(currency).toBe("eur");
  });
});

// RS004 W3c: the same finding-6 shape, for the card-unsupported-currency
// fallback the config panel needs on a Settings tab with zero divisions.
describe.skipIf(!HAS_DB)("fetchOrgCardUnsupportedCurrency — real Postgres", () => {
  it("resolves null (card supported) for an org with no unsupported currency set", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const value = await fetchOrgCardUnsupportedCurrency(owner);
    expect(value).toBeNull();
  });

  it("resolves the real value even for a competition with zero divisions", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_unsupported_currency = 'jpy' where id = ${orgId}`;
    const value = await fetchOrgCardUnsupportedCurrency(owner);
    expect(value).toBe("jpy");
  });
});
