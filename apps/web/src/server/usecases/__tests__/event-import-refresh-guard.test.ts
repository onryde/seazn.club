// The regression test the fix-wave dispatch could not write (its owned-files
// list did not include a host for it): the between-streams lock refresh is
// best-effort, and a failure there must NOT abort an import whose per-fixture
// writes have already committed. Without the try/catch at event-import.ts's
// refresh call site this file fails — the rejection propagates out of
// `importEvents` and the caller sees a 500 for an import that in fact landed.
//
// The seam is deliberately narrow. `sql` is wrapped so that ONLY the refresh
// statement throws; every other query — acquire, release, resolveFixture, and
// all of `withTenant`'s real transactional writes — runs against the real
// database, because the thing under test is what the import does when one
// specific best-effort statement fails, not what it does against a fake DB.
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ failRefresh: false, refreshAttempts: 0 }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const real = actual.sql;
  const sql = new Proxy(real, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0];
      const isRefresh =
        Array.isArray(strings) &&
        strings.join("?").includes("update import_locks set expires_at");
      if (isRefresh) {
        hoisted.refreshAttempts += 1;
        if (hoisted.failRefresh) {
          throw new Error("simulated import_locks failure");
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Reflect.apply(target as any, thisArg, args);
    },
  });
  return { ...actual, sql };
});

const { sql } = await import("@/lib/db");
const { importEvents } = await import("../event-import");
const { seedOrg, startedDivisionWithFixture, decidingStream } = await import("./_rig");

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("import_locks — a failing refresh does not lose a committed import", () => {
  it("keeps the import's result when the between-streams refresh throws", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const before = hoisted.refreshAttempts;
    hoisted.failRefresh = true;
    let report;
    try {
      report = await importEvents(auth, divisionId, {
        import_id: "imp-refresh-fails",
        streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
      });
    } finally {
      hoisted.failRefresh = false;
    }

    // The refresh really was attempted. Without this the test would still pass
    // if a future edit deleted the refresh call altogether — it would then be
    // asserting nothing but "a normal import works", which is covered
    // elsewhere. This is the assertion that keeps it honest.
    expect(hoisted.refreshAttempts).toBeGreaterThan(before);

    // The import is reported as it actually happened, not as a 500.
    expect(report.results[0]!.status).toBe("imported");
    expect(report.totals.imported).toBe(1);

    // And the events are genuinely on the ledger — the refresh failing must
    // not roll anything back, since the per-fixture write already committed.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(decidingStream().length);

    // Release still ran despite the refresh failure: no lock row is stranded
    // to block the next import of this (division, import_id).
    const [{ locks }] = await sql<{ locks: number }[]>`
      select count(*)::int as locks from import_locks
      where division_id = ${divisionId} and import_id = ${"imp-refresh-fails"}`;
    expect(locks).toBe(0);
  });
});
