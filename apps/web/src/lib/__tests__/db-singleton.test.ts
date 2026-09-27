import { beforeEach, describe, expect, it, vi } from "vitest";
import { FLY_CONFIGS, healthCheckIntervalS } from "./_fly-health-check";

// 2026-07-13 incident: in production builds getClient() constructed a brand
// new postgres client (its own pool) on EVERY sql proxy access, because the
// singleton was only stashed when NODE_ENV !== "production". One authed page
// render opened 25+ connections; on stg (max_connections=60, 2 machines) this
// exhausted the slots → FATAL 53300. The client must be constructed exactly
// once per process regardless of NODE_ENV.
const postgresMock = vi.fn(() => {
  const client = () => Promise.resolve([]);
  client.begin = vi.fn();
  return client;
});
vi.mock("postgres", () => ({ default: postgresMock }));

describe("db client singleton", () => {
  beforeEach(() => {
    vi.resetModules();
    postgresMock.mockClear();
    delete (globalThis as { _sql?: unknown })._sql;
    vi.stubEnv("DATABASE_URL", "postgres://app@db.example.com:5432/app");
  });

  it("constructs the postgres client once in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sql } = await import("@/lib/db");
    void sql.options;
    void sql.options;
    await sql`select 1`;
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it("constructs the postgres client once in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { sql } = await import("@/lib/db");
    void sql.options;
    void sql.options;
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  async function clientOptions(): Promise<Record<string, unknown>> {
    const { sql } = await import("@/lib/db");
    void sql.options;
    expect(postgresMock).toHaveBeenCalledTimes(1);
    return (postgresMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
  }

  // What postgres() actually receives must outlast fly's /api/health check,
  // which runs `select 1` on this pool — read from both fly configs, so the
  // bound moves with the check. (connectionOptions().idleTimeout is a constant,
  // so this pins the value handed over; it cannot tell pass-through from a
  // hard-coded literal — accepted, see the T3 review.)
  it.each(FLY_CONFIGS)("postgres() gets an idle_timeout above %s's /api/health interval", async (file) => {
    const intervalS = healthCheckIntervalS(file);
    const opts = await clientOptions();
    expect(typeof opts.idle_timeout).toBe("number");
    expect(opts.idle_timeout as number).toBeGreaterThan(intervalS);
  });

  it("postgres() gets connectionOptions' idle timeout — the owner's chosen 60 s", async () => {
    const { connectionOptions } = await import("@/lib/db");
    const opts = await clientOptions();
    expect(opts.idle_timeout).toBe(connectionOptions("postgres://app@db.example.com:5432/app").idleTimeout);
    expect(opts.idle_timeout).toBe(60);
  });

  // postgres.js 3.4.9 registers EVERY array parser (text[]/uuid[] included)
  // through fetch_types. It must be passed EXPLICITLY true: left at the
  // default, a `?fetch_types=false` URL param (or PGFETCH_TYPES) turns it off.
  it("passes fetch_types: true explicitly, so the connection string cannot turn it off", async () => {
    const opts = await clientOptions();
    expect(opts.fetch_types).toBe(true);
  });
});
