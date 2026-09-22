// The constraint V413 adds is only real if something tries to violate it
// (AGENTS.md class 3). Each refusal here has its ACCEPTED twin in the same
// `it`, so a test that passes against an EMPTY schema cannot exist: the twin
// would fail with "relation does not exist" first.
//
// Deliberately NOT through `appendEvent`: this suite is about the DDL, and
// going through the adapter would let an adapter-side guard answer for the
// database. The plain `sql` client, not `withTenant`, for the same reason —
// the question is what Postgres refuses, not what a policy hides.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

async function rig() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  return { orgId: auth.orgId, fixtureId };
}

async function insertEvent(
  r: { orgId: string; fixtureId: string },
  seq: number,
  idempotencyKey: string | null,
) {
  const [row] = await sql<{ id: string }[]>`
    insert into score_events (fixture_id, org_id, seq, type, payload, idempotency_key)
    values (${r.fixtureId}, ${r.orgId}, ${seq}, 'core.start', '{}'::jsonb, ${idempotencyKey})
    returning id`;
  return row!.id;
}

describe.skipIf(!HAS_DB)("V413 — score_events.idempotency_key", () => {
  it("refuses a second row with the same (fixture_id, idempotency_key), and accepts a different key", async () => {
    const r = await rig();
    const key = `idem-${randomUUID()}`;
    // The ACCEPTED twin, first: proves the table and the column exist, so the
    // refusal below cannot be a missing relation wearing a constraint's name.
    await insertEvent(r, 1, key);

    await expect(insertEvent(r, 2, key)).rejects.toMatchObject({ code: "23505" });

    // Same fixture, DIFFERENT key: allowed. Without this the assertion above
    // would also pass against a unique index on (fixture_id) alone, which
    // would refuse every second event any fixture ever records.
    await expect(insertEvent(r, 2, `idem-${randomUUID()}`)).resolves.toBeTruthy();
  });

  it("scopes the key to the fixture — the same key on ANOTHER fixture is allowed", async () => {
    const a = await rig();
    const b = await rig();
    const key = `idem-${randomUUID()}`;
    await insertEvent(a, 1, key);
    // A GLOBAL unique index on idempotency_key would red here. Two scorers on
    // two courts can legitimately mint the same client-side key, and refusing
    // the second one's write would be a worse bug than the one this wave fixes.
    await expect(insertEvent(b, 1, key)).resolves.toBeTruthy();
  });

  it("allows MANY null keys on one fixture — the column is optional", async () => {
    const r = await rig();
    await insertEvent(r, 1, null);
    // Postgres treats NULLs as DISTINCT in a unique index by default. If the
    // migration ever gains `nulls not distinct`, every un-keyed write after
    // the first refuses — which is every import, every rebuild, and every
    // client that does not send a key.
    await expect(insertEvent(r, 2, null)).resolves.toBeTruthy();
  });

  it("leaves the hash chain verifying — the key is NOT in the canonical", async () => {
    const r = await rig();
    await insertEvent(r, 1, `idem-${randomUUID()}`);
    await insertEvent(r, 2, `idem-${randomUUID()}`);
    // `verify_score_events_chain` (V226:54) returns the id of the FIRST bad
    // row, or null. V226's canonical is
    // id|fixture_id|seq|type|payload|voids|recorded_by|recorded_at —
    // idempotency_key must stay out of it, exactly as device_link_id does, or
    // every existing row's row_hash becomes wrong the day this ships.
    const [{ bad }] = await sql<{ bad: string | null }[]>`
      select verify_score_events_chain(${r.fixtureId}::uuid) as bad`;
    expect(bad).toBeNull();
  });
});
