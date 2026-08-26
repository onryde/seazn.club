// The point of the extraction: two appends in ONE transaction either both
// land or neither does. Looping the public appendEvent commits each event
// separately, so this test is what makes a half-imported fixture impossible.
import { describe, expect, it } from "vitest";
import { withTenant, sql } from "@/lib/db";
import { appendEventInTx } from "../append-event";
import { seedOrg, startedDivisionWithFixture } from "../../usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("appendEventInTx", () => {
  it("rolls back every event in the transaction when a later one is refused", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);

    await expect(
      withTenant(auth.orgId, async (tx) => {
        await appendEventInTx(tx, auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
        // seq 1 is now the tip; passing 5 is a SEQ_CONFLICT the writer throws on.
        await appendEventInTx(tx, auth.orgId, fixtureId, 5, { type: "core.start", payload: {} });
      }),
    ).rejects.toThrow(/SEQ_CONFLICT|expected seq/);

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(rows[0]!.n).toBe(0); // the FIRST event must be gone too
  });
});
