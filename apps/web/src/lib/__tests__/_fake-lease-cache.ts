// An in-memory stand-in for the lease primitives in `lib/cache.ts`
// (`cacheReadRaw`, `cacheLeaseAcquire`, `cacheLeaseFill`, `cacheLeaseRelease`)
// plus the plain `cacheDel` every public-cache WRITER sends.
//
// It keeps the SEMANTICS the Lua scripts promise — a fill lands only while the
// key still holds the filler's own lease, a release deletes only its own lease,
// a lease expires after its PX, a DEL removes whatever is there — so the
// single-flight orchestration (`lib/single-flight-cache.ts`) and the usecases
// built on it can be driven through concurrency and write races in a plain
// unit run with no Redis. The scripts themselves are proven against a REAL
// Redis in `cache-lease.redis.test.ts`; a mutant in the Lua is invisible here
// by construction, and that suite is where it dies.
//
// Wire it with:
//   vi.mock("@/lib/cache", async (importOriginal) => {
//     const { fakeLeaseCache } = await import("@/lib/__tests__/_fake-lease-cache");
//     return { ...(await importOriginal<typeof import("@/lib/cache")>()), ...fakeLeaseCache.module() };
//   });
import type { LeaseAttempt, RawRead } from "@/lib/cache";

interface Entry {
  raw: string;
  /** epoch ms, or null for no expiry */
  expiresAt: number | null;
}

const LEASE_PREFIX = "lease:";

export class FakeLeaseCache {
  private entries = new Map<string, Entry>();
  private seq = 0;
  /** Every command, in order — `read`/`acquire`/`fill`/`release`/`del`. */
  readonly log: { op: string; key: string; ok?: boolean; ttl?: number }[] = [];
  /** When true every primitive answers as a Redis that is not there. */
  down = false;

  reset(): void {
    this.entries.clear();
    this.log.length = 0;
    this.down = false;
  }

  private live(key: string): Entry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && Date.now() >= e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  /** Seed a raw value (a document, or anything else) under a key. */
  seed(key: string, value: unknown, ttlSeconds = 60): void {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    this.entries.set(key, { raw, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /** The parsed value under a key, `undefined` when absent or a lease. */
  peek(key: string): unknown {
    const e = this.live(key);
    if (!e || e.raw.startsWith(LEASE_PREFIX)) return undefined;
    return JSON.parse(e.raw);
  }

  isLeased(key: string): boolean {
    return this.live(key)?.raw.startsWith(LEASE_PREFIX) ?? false;
  }

  count(op: string, key?: string): number {
    return this.log.filter((l) => l.op === op && (key === undefined || l.key === key)).length;
  }

  async readRaw(key: string): Promise<RawRead> {
    this.log.push({ op: "read", key });
    if (this.down) return { kind: "unavailable" };
    const e = this.live(key);
    if (!e) return { kind: "absent" };
    if (e.raw.startsWith(LEASE_PREFIX)) return { kind: "leased" };
    return { kind: "value", raw: e.raw };
  }

  async acquire(key: string, leaseMs: number, mode: "absent" | "replace"): Promise<LeaseAttempt> {
    if (this.down) {
      this.log.push({ op: "acquire", key, ok: false });
      return { kind: "unavailable" };
    }
    if (mode === "absent" && this.live(key)) {
      this.log.push({ op: "acquire", key, ok: false });
      return { kind: "held" };
    }
    this.seq += 1;
    const token = `t${this.seq}`;
    this.entries.set(key, { raw: LEASE_PREFIX + token, expiresAt: Date.now() + leaseMs });
    this.log.push({ op: "acquire", key, ok: true });
    return { kind: "acquired", token };
  }

  async fill(
    key: string,
    token: string,
    value: unknown,
    ttlSeconds: number,
    stale?: { key: string; ttlSeconds: number },
  ): Promise<boolean> {
    if (this.down) {
      this.log.push({ op: "fill", key, ok: false });
      return false;
    }
    const e = this.live(key);
    if (!e || e.raw !== LEASE_PREFIX + token) {
      this.log.push({ op: "fill", key, ok: false });
      return false;
    }
    const raw = JSON.stringify(value);
    this.entries.set(key, { raw, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (stale) this.entries.set(stale.key, { raw, expiresAt: Date.now() + stale.ttlSeconds * 1000 });
    this.log.push({ op: "fill", key, ok: true, ttl: ttlSeconds });
    return true;
  }

  async release(key: string, token: string): Promise<void> {
    this.log.push({ op: "release", key });
    if (this.down) return;
    const e = this.live(key);
    if (e && e.raw === LEASE_PREFIX + token) this.entries.delete(key);
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.log.push({ op: "del", key });
      if (!this.down) this.entries.delete(key);
    }
  }

  /** The `@/lib/cache` exports this fake replaces. */
  module() {
    return {
      cacheReadRaw: (key: string) => this.readRaw(key),
      cacheLeaseAcquire: (key: string, leaseMs: number, mode: "absent" | "replace") =>
        this.acquire(key, leaseMs, mode),
      cacheLeaseFill: (
        key: string,
        token: string,
        value: unknown,
        ttlSeconds: number,
        stale?: { key: string; ttlSeconds: number },
      ) => this.fill(key, token, value, ttlSeconds, stale),
      cacheLeaseRelease: (key: string, token: string) => this.release(key, token),
      cacheDel: (...keys: string[]) => this.del(...keys),
    };
  }
}

export const fakeLeaseCache = new FakeLeaseCache();
