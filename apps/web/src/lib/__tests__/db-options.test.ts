import { describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";
import { FLY_CONFIGS, healthCheckIntervalS } from "./_fly-health-check";

describe("connectionOptions", () => {
  const remote = "postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com";

  it("disables prepared statements on the transaction pooler (:6543)", () => {
    expect(connectionOptions(`${remote}:6543/postgres`, {}).prepare).toBe(false);
  });

  it("enables prepared statements on the session pooler (:5432)", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).prepare).toBe(true);
  });

  it("requires SSL for remote hosts, none for localhost", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).ssl).toBe("require");
    expect(connectionOptions("postgresql://u:p@localhost:5432/seazn", {}).ssl).toBe(false);
  });

  it("honors DATABASE_SSL override", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, { DATABASE_SSL: "disable" }).ssl).toBe(false);
    expect(connectionOptions("postgresql://u:p@localhost:5432/x", { DATABASE_SSL: "require" }).ssl).toBe("require");
  });

  it("defaults pool max to 5, accepts DB_POOL_MAX within 1..50, rejects garbage", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "10" }).max).toBe(10);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "0" }).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "banana" }).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "999" }).max).toBe(5);
  });

  it("defaults schema to seazn_club, honors DB_SCHEMA", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).schema).toBe("seazn_club");
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_SCHEMA: "public" }).schema).toBe("public");
  });

  const urlShapes = [
    `${remote}:5432/postgres`,
    `${remote}:6543/postgres`,
    "postgresql://u:p@localhost:5432/seazn",
  ];

  // The rule that matters, derived from its source: fly's /api/health check
  // runs `select 1` on the pool, so an idle timeout at or below its interval
  // re-dials on every check (~24.7k reconnects in 6 days at 20 s vs a 30 s
  // check). Lowering the timeout OR slowing the check reddens this.
  it.each(FLY_CONFIGS)("idle timeout outlasts %s's /api/health check interval, on every URL shape", (file) => {
    const intervalS = healthCheckIntervalS(file);
    expect(intervalS).toBeGreaterThan(0);
    for (const url of urlShapes) {
      expect(connectionOptions(url, {}).idleTimeout).toBeGreaterThan(intervalS);
    }
  });

  // The owner's chosen value (2026-09-24, re-confirmed with the health-check
  // facts) — a pin on the decision, not a derivation. See lib/db.ts.
  it("idle timeout is the owner's chosen 60 s", () => {
    for (const url of urlShapes) {
      expect(connectionOptions(url, {}).idleTimeout).toBe(60);
    }
  });
});
