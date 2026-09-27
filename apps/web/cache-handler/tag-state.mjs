// apps/web/cache-handler/tag-state.mjs
// @ts-check
/**
 * Shared tag-state arithmetic for the Redis cache handler (handler.mjs) and
 * peer-revalidate.ts. Plain ESM: Next loads the handler outside the bundle.
 * Spec: docs/superpowers/specs/2026-09-24-shared-redis-cache-handler-design.md §4, §6.
 */

export const TAGS_HASH = "nc:tags";

/**
 * Mirror of next@16.3.6 FileSystemCache.revalidateTag
 * (server/lib/incremental-cache/file-system-cache.js:43-76; body unchanged
 * since 16.2.9). A parity test
 * runs Next's own class against this, so an upgrade that changes the rule
 * turns the test red instead of drifting.
 * @param {{stale?: number, expired?: number}} existing
 * @param {{expire?: number} | undefined} durations
 * @param {number} now
 */
export function nextTagEntry(existing, durations, now) {
  if (durations) {
    const e = { ...existing, stale: now };
    if (durations.expire !== undefined) e.expired = now + durations.expire * 1000;
    return e;
  }
  return { ...existing, expired: now };
}

/**
 * @param {{stale?: number, expired?: number}} existing
 * @param {{expire?: number} | undefined} durations
 * @param {number} now
 * @returns {{stale?: number, expired?: number, at: number}}
 */
export function writeState(existing, durations, now) {
  const { stale, expired } = nextTagEntry(existing, durations, now);
  /** @type {{stale?: number, expired?: number, at: number}} */
  const s = { at: now };
  if (stale !== undefined) s.stale = stale;
  if (expired !== undefined) s.expired = expired;
  return s;
}

/** @param {{at: number, stale?: number, expired?: number}} s */
export function encodeField(s) {
  const { at, ...rest } = s;
  return `${at}|${JSON.stringify(rest)}`;
}

/**
 * @param {string | null | undefined} raw
 * @returns {{at: number, stale?: number, expired?: number} | null}
 */
export function decodeField(raw) {
  if (typeof raw !== "string") return null;
  const bar = raw.indexOf("|");
  if (bar <= 0) return null;
  // Digits only, as the Lua scripts read it (^(%d+)|): "1e3", " 12", "-3"
  // and "1.5" all parse as numbers in JS but never order a write in Redis.
  if (!/^\d+$/.test(raw.slice(0, bar))) return null;
  const at = Number(raw.slice(0, bar));
  if (!Number.isFinite(at)) return null;
  try {
    const rest = JSON.parse(raw.slice(bar + 1));
    if (rest === null || typeof rest !== "object") return null;
    return { ...rest, at };
  } catch {
    return null;
  }
}

/**
 * Newest write wins (ties → b). Never merge per field: a "max" write's
 * year-ahead `expired` must not survive a later {expire:0}.
 * @template {{at: number}} T
 * @param {T | null} a @param {T | null} b @returns {T | null}
 */
export function newest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.at >= a.at ? b : a;
}

/** Sets each field only when its `at` is >= the stored one. */
export const HSET_IF_NEWER = `
for i = 1, #ARGV, 2 do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  local curAt = cur and tonumber(string.match(cur, '^(%d+)|')) or -1
  local newAt = tonumber(string.match(ARGV[i + 1], '^(%d+)|'))
  if newAt and newAt >= curAt then redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
end
return 1`;

/**
 * The daily sweep's delete. KEYS[1] = hash, ARGV[1] = cutoff (epoch ms),
 * ARGV[2..] = fields the HSCAN judged dead. Each field is re-read HERE and
 * deleted only if it is unparseable or max(at, stale, expired) < cutoff, so a
 * field another machine rewrote between the HSCAN and this call survives.
 * Returns the number of fields deleted.
 */
export const HDEL_IF_OLDER = `
local cutoff = tonumber(ARGV[1])
local deleted = 0
for i = 2, #ARGV do
  local cur = redis.call('HGET', KEYS[1], ARGV[i])
  if cur then
    local at, body = string.match(cur, '^(%d+)|(.*)$')
    local ok, s = false, nil
    if at then ok, s = pcall(cjson.decode, body) end
    local dead = true
    if ok and type(s) == 'table' then
      local newest = tonumber(at)
      if type(s.stale) == 'number' and s.stale > newest then newest = s.stale end
      if type(s.expired) == 'number' and s.expired > newest then newest = s.expired end
      dead = newest < cutoff
    end
    if dead then deleted = deleted + redis.call('HDEL', KEYS[1], ARGV[i]) end
  end
end
return deleted`;
