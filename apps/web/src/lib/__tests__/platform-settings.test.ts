// Platform fee default (spec §1): admin-set platform_settings row → env → 5.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { cacheDelPattern } from "@/lib/cache";
import {
  platformFeeDefault,
  setPlatformFeeDefault,
  __platformFeeCacheKeyForTests,
} from "@/lib/platform-settings";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("platform fee default", () => {
  // #336: defensive hygiene, not the fix — every read/write in this file
  // already invalidates the key it touches, but a fresh cache at the start
  // of each test means a future test added here without perfect discipline
  // fails loudly on its own miss, not silently on a leftover warm entry from
  // whichever test happened to run first.
  beforeEach(async () => {
    await cacheDelPattern(__platformFeeCacheKeyForTests());
  });

  it("reads the seeded default, honours admin writes, validates range", async () => {
    const [{ id: actor }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`fee-admin-${randomUUID().slice(0, 8)}@test.local`}, 'Fee Admin', true)
      returning id`;

    expect(await platformFeeDefault()).toBe(5);

    await setPlatformFeeDefault(7, actor);
    expect(await platformFeeDefault()).toBe(7); // cache invalidated on write

    await expect(setPlatformFeeDefault(101, actor)).rejects.toMatchObject({ status: 422 });
    await expect(setPlatformFeeDefault(-1, actor)).rejects.toMatchObject({ status: 422 });

    const [row] = await sql<{ updated_by: string }[]>`
      select updated_by from platform_settings where key = 'platform_fee_percent'`;
    expect(row.updated_by).toBe(actor);

    await setPlatformFeeDefault(5, actor); // restore for sibling suites
  });

  it("falls back to env/5 on a garbage row", async () => {
    // Cache is Redis-backed and fail-open — absent REDIS_URL (test env) every
    // read hits Postgres, so garbage → fallback is directly observable.
    await sql`update platform_settings set value = '"nonsense"' where key = 'platform_fee_percent'`;
    await cacheDelPattern(__platformFeeCacheKeyForTests()); // no-op locally, correct in prod

    const prev = process.env.PLATFORM_FEE_PERCENT;
    process.env.PLATFORM_FEE_PERCENT = "12";
    expect(await platformFeeDefault()).toBe(12);
    // #336: that read just cached { v: 12 } for 300s (real Redis, cache-aside).
    // Without busting it here, the next line is not a fresh read at all — it's
    // this SAME call's own cache entry, and the assertion below would silently
    // check 12 against 12 instead of exercising the env-unset fallback. This
    // is the exact "one read's write leaks into the next read" defect #336
    // reports, reproduced within a single test rather than across two.
    delete process.env.PLATFORM_FEE_PERCENT;
    await cacheDelPattern(__platformFeeCacheKeyForTests());
    expect(await platformFeeDefault()).toBe(5);
    if (prev !== undefined) process.env.PLATFORM_FEE_PERCENT = prev;

    await sql`update platform_settings set value = '5'::jsonb where key = 'platform_fee_percent'`;
  });

  /**
   * The jsonb shapes that are NOT garbage — they are a finite, in-range, utterly
   * plausible 0. `Number(null)`, `Number(false)` and `Number("")` are each `0`,
   * which clears the 0..100 bounds check and is served as a 0% platform cut,
   * overriding the fallback an ABSENT row correctly reaches. Zero revenue on
   * every entry fee, and nothing anywhere logs a complaint.
   *
   * The env is pinned to 11 rather than left at the seeded 5 ON PURPOSE. With
   * the fallback at 5 this test would assert 5 against a row that already said
   * 5, so a decoder that never ran — or an UPDATE that silently did not take —
   * would pass it. At 11 the three outcomes separate: 11 is the fallback doing
   * its job, 0 is the defect, and 5 is the row the update was supposed to have
   * replaced. `decodeFeePercent`'s own unit suite (lib/__tests__/platform-fee)
   * pins the rule; this pins that PRODUCTION reads a real Postgres jsonb row
   * through it, which no pure test can see.
   */
  it("falls back rather than serving a 0% cut on an empty jsonb row", async () => {
    const prev = process.env.PLATFORM_FEE_PERCENT;
    process.env.PLATFORM_FEE_PERCENT = "11";
    try {
      for (const empty of ["null", "false", '""', "[]"]) {
        await sql`update platform_settings set value = ${sql.unsafe(`'${empty}'::jsonb`)}
          where key = 'platform_fee_percent'`;
        await cacheDelPattern(__platformFeeCacheKeyForTests());
        expect(
          await platformFeeDefault(),
          `a jsonb ${empty} row must reach the PLATFORM_FEE_PERCENT fallback, not read as 0%`,
        ).toBe(11);
      }
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_FEE_PERCENT;
      else process.env.PLATFORM_FEE_PERCENT = prev;
      await sql`update platform_settings set value = '5'::jsonb where key = 'platform_fee_percent'`;
      await cacheDelPattern(__platformFeeCacheKeyForTests());
    }
  });
});
