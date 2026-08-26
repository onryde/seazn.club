// Fix round 2 (owner ruling — row lock replaces the session advisory lock,
// design doc §5.1). DB-backed, unlike event-import-lock.test.ts's pure
// unit tests: these two exercise the REAL import_locks table and the real
// acquire/release SQL, which a fake acquire/release cannot stand in for.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { importEvents, refreshImportLock, releaseImportLock } from "../event-import";
import { seedOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("import_locks — expiry and release scoping", () => {
  it("requirement #2: a lock row whose expires_at is in the past is taken over, not blocked", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    // Simulates a crashed prior process: a row for this EXACT
    // (division_id, import_id) whose TTL already elapsed, held by a holder
    // this call knows nothing about.
    await sql`
      insert into import_locks (division_id, import_id, org_id, holder, expires_at)
      values (${divisionId}, ${"imp-crashed"}, ${auth.orgId}, ${randomUUID()}, now() - interval '1 minute')`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-crashed",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });

    // Not wedged: the stale row was taken over and the import actually ran,
    // not merely "didn't 409" — imported all the way through.
    expect(report.results[0]!.status).toBe("imported");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from import_locks
      where division_id = ${divisionId} and import_id = ${"imp-crashed"}`;
    expect(n).toBe(0); // released after the (successful) call, same as any other import
  });

  it("requirement #2, negative control: a LIVE (non-expired) lock still blocks", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`
      insert into import_locks (division_id, import_id, org_id, holder, expires_at)
      values (${divisionId}, ${"imp-live"}, ${auth.orgId}, ${randomUUID()}, now() + interval '30 minutes')`;

    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-live",
        streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "import.concurrent" });
  });

  it("requirement #3: release only ever affects the caller's own row — a foreign holder survives", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await startedDivisionWithFixture(auth);
    const importId = "imp-foreign";
    const foreignHolder = randomUUID();
    await sql`
      insert into import_locks (division_id, import_id, org_id, holder, expires_at)
      values (${divisionId}, ${importId}, ${auth.orgId}, ${foreignHolder}, now() + interval '30 minutes')`;

    // A DIFFERENT holder — as if this call's own (already-timed-out) lock
    // were being released after a successor already took over the row.
    await releaseImportLock(divisionId, importId, auth.orgId, randomUUID());

    const [row] = await sql<{ holder: string; expires_at: string }[]>`
      select holder, expires_at from import_locks
      where division_id = ${divisionId} and import_id = ${importId}`;
    expect(row).toBeDefined();
    expect(row!.holder).toBe(foreignHolder); // untouched — the mismatched release was a no-op
  });

  // Final review (minor): release's `holder` predicate had this test; REFRESH's
  // identical predicate had none, so it was deletable with the suite green —
  // and a refresh that ignored `holder` is strictly worse than a release that
  // does. It would let an already-timed-out caller keep pushing a SUCCESSOR's
  // lock out by thirty minutes at a time, from a call the successor knows
  // nothing about, for as long as the zombie kept running.
  it("requirement #3, refresh side: a non-holder's refresh must not push out the holder's expires_at", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await startedDivisionWithFixture(auth);
    const importId = "imp-refresh-foreign";
    const holder = randomUUID();
    await sql`
      insert into import_locks (division_id, import_id, org_id, holder, expires_at)
      values (${divisionId}, ${importId}, ${auth.orgId}, ${holder}, now() + interval '5 minutes')`;
    const readExpiry = async (): Promise<Date> => {
      const [row] = await sql<{ expires_at: Date }[]>`
        select expires_at from import_locks
        where division_id = ${divisionId} and import_id = ${importId}`;
      return row!.expires_at;
    };
    const before = await readExpiry();

    await refreshImportLock(divisionId, importId, auth.orgId, randomUUID());

    expect(await readExpiry()).toEqual(before); // untouched

    // Positive control: the REAL holder's refresh does push it out. Without
    // this, a `refreshImportLock` that had been gutted to a no-op would satisfy
    // the assertion above and the test would prove nothing at all.
    await refreshImportLock(divisionId, importId, auth.orgId, holder);
    expect((await readExpiry()).getTime()).toBeGreaterThan(before.getTime());
  });

  // Final review (minor): acquire's `ON CONFLICT ... DO UPDATE` re-homed
  // `holder`, `acquired_at` and `expires_at` on a takeover but NOT `org_id`, so
  // a taken-over row kept whichever org wrote it first. Refresh and release both
  // filter on `org_id`, so neither would then match the row the caller is
  // actually holding: the import succeeds and strands its own lock for a full
  // 30-minute TTL, wedging every retry of that (division, import_id).
  it("a takeover re-homes org_id, so the new holder can still refresh and release", async () => {
    const { auth } = await seedOrg();
    const { auth: foreign } = await seedOrg(); // a real, different org (FK)
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const importId = "imp-foreign-org";
    await sql`
      insert into import_locks (division_id, import_id, org_id, holder, expires_at)
      values (${divisionId}, ${importId}, ${foreign.orgId}, ${randomUUID()}, now() - interval '1 minute')`;

    const report = await importEvents(auth, divisionId, {
      import_id: importId,
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.status).toBe("imported");

    // The row is GONE, i.e. release matched it. This is the observable
    // difference: with a stale org_id the import still reports success and
    // leaves the lock behind.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from import_locks
      where division_id = ${divisionId} and import_id = ${importId}`;
    expect(n).toBe(0);
  });
});
