import "server-only";
// Platform-wide admin knobs (spec 2026-07-12 §1). One row per key in
// platform_settings; the table is superuser-only (never exposed to tenant
// connections or the Data API). Values cache like entitlements: cache-aside,
// short TTL, invalidated on admin writes.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { decodeFeePercent } from "@/lib/platform-fee";

const FEE_KEY = "platform_fee_percent";
// v2 — BUMPED with the jsonb decode fix. The Redis read at the top of
// platformFeeDefault() precedes the decode, and the only invalidator is an
// admin PUT: a warm `{v:0}` written by the old `Number(row?.value)` would
// otherwise keep serving a 0% cut for the full 300s TTL AFTER the fix
// deployed. That window is not merely cosmetic — the first paid entry in it
// runs `update competitions set fee_percent = <0> where fee_percent is null`
// (registrations.ts:2918, first-wins and the only writer), and
// effectiveFeePercentFor treats a locked 0 as "not locked" (`> 0`, :103), so
// the row is non-null forever and that competition can never lock a rate
// again. Bumping the key makes the fix take effect on deploy instead of 300s
// later.
const CACHE_KEY_PREFIX = "platform:fee_percent:v2";
const TTL_SECONDS = 300;

/**
 * Cache key, namespaced by DB_SCHEMA — the same env var lib/db.ts's
 * connection options use to pick a schema (db.ts:49). A function, not a
 * module-load-time const: entKey() in entitlements.ts already does this
 * per-org, and computing it lazily (rather than freezing it at import time)
 * is what lets a test flip DB_SCHEMA mid-run and observe a different key.
 *
 * #336: the old un-namespaced key meant every schema — every migrated test
 * database, and a local dev database sitting alongside one — shared a single
 * 300s Redis entry. A write under one schema's platform_settings row leaked
 * straight into a read for another's.
 */
function cacheKey(): string {
  return `${CACHE_KEY_PREFIX}:${process.env.DB_SCHEMA ?? "seazn_club"}`;
}

/** @internal — exported for tests (#336 cache-isolation regression). */
export function __platformFeeCacheKeyForTests(): string {
  return cacheKey();
}

/** @internal — exported for tests. `envFallback` is the branch EVERY rejected
 *  jsonb row lands on, so it needs a guard that runs without a database;
 *  platform-settings.test.ts is `skipIf(!HAS_DB)` and CI has no DATABASE_URL. */
export function __envFallbackForTests(): number {
  return envFallback();
}

function envFallback(): number {
  // `?? "5"` does NOT cover an empty value, and this is the same 0-shaped trap
  // decodeFeePercent exists for: `Number("")` is a finite, in-range `0`, so
  // `PLATFORM_FEE_PERCENT=` (set but blank — an unset GH secret, a bare Docker
  // `-e PLATFORM_FEE_PERCENT`, an uncommented-and-emptied .env line) served a
  // 0% platform cut. This path carries MORE traffic since the jsonb decode
  // landed: every row decodeFeePercent rejects is routed here.
  const raw = process.env.PLATFORM_FEE_PERCENT?.trim();
  if (!raw) return 5;
  return decodeFeePercent(Number(raw)) ?? 5;
}

/** Platform's default cut of entry fees, in percent. Resolution: admin-set
 *  platform_settings row → PLATFORM_FEE_PERCENT env → 5. Plans and per-org
 *  overrides sit ABOVE this default (see feePercentFor in registrations). */
export async function platformFeeDefault(): Promise<number> {
  const cached = await cacheGet<{ v: number }>(cacheKey());
  if (cached) return cached.v;
  const [row] = await sql<{ value: unknown }[]>`
    select value from platform_settings where key = ${FEE_KEY}`;
  // decodeFeePercent, not Number(): the column is jsonb, so a row holding a
  // jsonb `null`/`false`/`""` decodes to a FINITE 0 that passes the bounds
  // check and serves a 0% platform cut, overriding the fallback an absent row
  // correctly reaches. See lib/platform-fee.ts.
  const v = decodeFeePercent(row?.value) ?? envFallback();
  await cacheSet(cacheKey(), { v }, TTL_SECONDS);
  return v;
}

/** Admin write (staff-only route). Bounds-checked; audited via updated_by. */
export async function setPlatformFeeDefault(pct: number, actorId: string): Promise<void> {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new HttpError(422, "Fee percent must be between 0 and 100");
  }
  await sql`
    insert into platform_settings (key, value, updated_by)
    values (${FEE_KEY}, ${sql.json(pct)}, ${actorId})
    on conflict (key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
  await cacheDelPattern(cacheKey());
}
