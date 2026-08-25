// P11 Task 1 — event_imports (V376). The unique index IS the idempotency
// guarantee (design doc §5): a second insert of the same (division_id,
// import_id, fixture_id) must fail at the DDL level, not by application code
// remembering not to repeat itself.
//
// Controller ruling: the original draft inserted random uuids for
// division_id/fixture_id, which the foreign keys reject before the unique
// index is ever reached — that would prove nothing. This version seeds a
// REAL division and fixture through the shared rig so the FK checks pass and
// the second insert actually reaches, and violates, `event_imports_key_idx`.
import { describe, expect, it, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, setupDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("event_imports (V376)", () => {
  it("rejects a duplicate (division_id, import_id, fixture_id) at the DDL level", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await setupDivisionWithFixture(auth);

    // Insert twice with the same key against the raw table so the guarantee
    // is proven in the DDL, not in whatever the usecase does about it later.
    const insert = () => sql`
      insert into event_imports (org_id, division_id, import_id, fixture_id, events_appended)
      values (${auth.orgId}, ${divisionId}, ${"imp-1"}, ${fixtureId}, 3)`;

    await insert(); // first insert lands
    await expect(insert()).rejects.toThrow(/event_imports_key_idx/);
  });

  it("has row level security forced", async () => {
    const [row] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'event_imports'`;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });
});
