// Final review I-3. `scoreEvent` invalidates the public caches on every write
// (scoring.ts:146); the importer fired only `onDecided` / `refreshDiscipline` /
// `refreshNews`, so the public pages, the public API and discovery kept serving
// pre-import content. That lands squarely on this feature's own headline
// promise (design doc §1: career pages filled on day one) — §2.1's read path IS
// the public cached one.
//
// Why this file rather than an extension of an existing side-effect test: the
// three effects the importer already fires are asserted OBSERVATIONALLY today
// (event-import-regression.test.ts (c) counts `org_posts` rows), which cannot
// see a cache invalidation at all — it writes to Redis and Next's tag cache,
// neither of which leaves a row behind. So the seam has to be the module
// boundary, and it is the same narrow seam `event-import-refresh-guard.test.ts`
// already uses for `@/lib/db`: wrap the real function, record the call, then
// DELEGATE to the real implementation. Nothing is faked out — the import runs
// end to end against the real database and the real side effects.
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  cache: [] as Array<{ orgId: string; fixtureId: string; movesDiscovery: boolean | undefined }>,
  onDecided: [] as string[],
  refreshDiscipline: [] as string[],
  refreshNews: [] as string[],
}));

vi.mock("../scoring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scoring")>();
  return {
    ...actual,
    invalidatePublicCache: (orgId: string, fixtureId: string, movesDiscovery?: boolean) => {
      seen.cache.push({ orgId, fixtureId, movesDiscovery });
      return actual.invalidatePublicCache(orgId, fixtureId, movesDiscovery);
    },
    onDecided: (...args: Parameters<typeof actual.onDecided>) => {
      seen.onDecided.push(args[1]);
      return actual.onDecided(...args);
    },
    refreshDiscipline: (...args: Parameters<typeof actual.refreshDiscipline>) => {
      seen.refreshDiscipline.push(args[1]);
      return actual.refreshDiscipline(...args);
    },
    refreshNews: (...args: Parameters<typeof actual.refreshNews>) => {
      seen.refreshNews.push(args[1]);
      return actual.refreshNews(...args);
    },
  };
});

const { sql } = await import("@/lib/db");
const { importEvents } = await import("../event-import");
const { seedOrg, startedDivisionWithFixture, decidingStream } = await import("./_rig");

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — post-commit side effects (I-3)", () => {
  it("invalidates the public cache once per IMPORTED stream, with movesDiscovery true", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-cache",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.status).toBe("imported");

    // `movesDiscovery` is unconditionally true for an import: the dry run
    // guarantees the stream decides, and every stream carries a `core.start` —
    // the two conditions `scoreEvent` computes it from (scoring.ts:149-150).
    expect(seen.cache.filter((c) => c.fixtureId === fixtureId)).toEqual([
      { orgId: auth.orgId, fixtureId, movesDiscovery: true },
    ]);
    // The three effects that were already there stay there, and this file now
    // covers all four in one place — a refactor of step 8 that dropped one of
    // them reds here rather than silently shipping.
    expect(seen.onDecided).toContain(fixtureId);
    expect(seen.refreshDiscipline).toContain(fixtureId);
    expect(seen.refreshNews).toContain(fixtureId);
  });

  // Non-vacuousness control: a stream the call REFUSED must not invalidate
  // anything — nothing changed, so nothing public is stale. Without this, an
  // unconditional invalidation at the top of `runStream` would pass the case
  // above while flushing the cache for every rejected paste.
  it("does NOT invalidate for a stream that was rejected", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
              values (${fixtureId}, ${auth.orgId}, 1, 'core.start', '{}'::jsonb)`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-cache-rejected",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.error?.code).toBe("import.fixture_started");
    expect(seen.cache.filter((c) => c.fixtureId === fixtureId)).toEqual([]);
  });
});
