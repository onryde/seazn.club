// DB-free unit + regression coverage for the pre-flight orchestration.
// Every probe is injected (PreflightProbes) — no live Postgres, server, or
// placement container involved, which is the whole point of the DI split
// in lib/env.ts (see its header comment).
import { describe, expect, it } from "vitest";
import {
  runPreflight,
  type AppHealthResult,
  type OwnDatabaseResult,
  type OwnPortResult,
  type PlacementHealthResult,
  type PreflightProbes,
  type SportsCatalogResult,
} from "../env.ts";

const PASSING_DB: OwnDatabaseResult = { ok: true, detail: "own DB confirmed", dataDirectory: "/data/bench", port: 54329 };
const PASSING_PORT: OwnPortResult = { ok: true, detail: "bound", pid: 4242 };
const PASSING_CATALOG: SportsCatalogResult = { ok: true, detail: "synced" };
const PASSING_HEALTH: AppHealthResult = { ok: true, detail: "healthy" };
const LIVE_PLACEMENT: PlacementHealthResult = { status: "live", detail: "answered" };
const ABSENT_PLACEMENT: PlacementHealthResult = { status: "absent", detail: "unreachable" };

function fakeProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    checkOwnDatabase: async () => PASSING_DB,
    checkOwnPort: async () => PASSING_PORT,
    checkPlacementHealth: async () => LIVE_PLACEMENT,
    checkSportsCatalogSynced: async () => PASSING_CATALOG,
    checkAppHealth: async () => PASSING_HEALTH,
    ...overrides,
  };
}

describe("runPreflight — verdict matrix", () => {
  it("passes when every probe passes and the base port is not forbidden", async () => {
    const result = await runPreflight("http://localhost:54301", fakeProbes());
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.placement).toEqual(LIVE_PLACEMENT);
  });

  it("records placement ABSENT without refusing the run — a report field, never a gate", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkPlacementHealth: async () => ABSENT_PLACEMENT }),
    );
    expect(result.ok).toBe(true);
    expect(result.placement.status).toBe("absent");
  });

  it("checkOwnDatabase failure -> named refusal, not a thrown exception", async () => {
    const dbFail: OwnDatabaseResult = { ok: false, reason: "own_db_connection_failed", detail: "ECONNREFUSED" };
    const result = await runPreflight("http://localhost:54301", fakeProbes({ checkOwnDatabase: async () => dbFail }));
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "own_db_connection_failed", detail: "ECONNREFUSED" });
  });

  it("checkOwnPort failure -> named refusal", async () => {
    const portFail: OwnPortResult = { ok: false, reason: "own_port_unbound", detail: "no PID" };
    const result = await runPreflight("http://localhost:54301", fakeProbes({ checkOwnPort: async () => portFail }));
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "own_port_unbound", detail: "no PID" });
  });

  it("checkSportsCatalogSynced failure -> named refusal", async () => {
    const catalogFail: SportsCatalogResult = {
      ok: false,
      reason: "sports_catalog_unsynced",
      detail: "badminton missing",
    };
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkSportsCatalogSynced: async () => catalogFail }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "sports_catalog_unsynced", detail: "badminton missing" });
  });

  it("checkAppHealth unreachable -> named refusal", async () => {
    const healthFail: AppHealthResult = { ok: false, reason: "app_health_unreachable", detail: "ECONNREFUSED" };
    const result = await runPreflight("http://localhost:54301", fakeProbes({ checkAppHealth: async () => healthFail }));
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "app_health_unreachable", detail: "ECONNREFUSED" });
  });

  it("checkAppHealth not-ok (200 that isn't healthy) -> named refusal", async () => {
    const healthFail: AppHealthResult = { ok: false, reason: "app_health_not_ok", detail: "503" };
    const result = await runPreflight("http://localhost:54301", fakeProbes({ checkAppHealth: async () => healthFail }));
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "app_health_not_ok", detail: "503" });
  });

  it("collects every applicable refusal at once rather than stopping at the first", async () => {
    const result = await runPreflight(
      "http://localhost:3000",
      fakeProbes({
        checkOwnDatabase: async () => ({ ok: false, reason: "own_db_dev_db_port", detail: "port 5432" }),
        checkSportsCatalogSynced: async () => ({ ok: false, reason: "sports_catalog_unsynced", detail: "missing" }),
      }),
    );
    expect(result.ok).toBe(false);
    const reasons = result.refusals.map((r) => r.reason).sort();
    expect(reasons).toEqual(["base_port_forbidden", "own_db_dev_db_port", "sports_catalog_unsynced"].sort());
  });
});

describe("runPreflight — regression: three known real traps", () => {
  it("refuses a :3000 base outright (the owner's local dev server)", async () => {
    const result = await runPreflight("http://localhost:3000", fakeProbes());
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "base_port_forbidden")).toBe(true);
  });

  it("refuses a :3100 base outright too (the e2e target — same forbidden-port mechanism)", async () => {
    const result = await runPreflight("http://localhost:3100", fakeProbes());
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "base_port_forbidden")).toBe(true);
  });

  it("refuses a foreign data_directory (own-DB proof mismatched against BENCH_EXPECTED_DATA_DIR)", async () => {
    const mismatched: OwnDatabaseResult = {
      ok: false,
      reason: "own_db_data_directory_mismatch",
      detail: 'show data_directory returned "/other/session/pg", expected "/this/session/pg"',
      dataDirectory: "/other/session/pg",
      port: 54331,
    };
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkOwnDatabase: async () => mismatched }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "own_db_data_directory_mismatch")).toBe(true);
  });

  it("refuses an unsynced sports catalog (missing the funnel badminton witness)", async () => {
    const unsynced: SportsCatalogResult = {
      ok: false,
      reason: "sports_catalog_unsynced",
      detail: "sports.key = 'badminton' not found — run `npm run sync:sports`",
    };
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkSportsCatalogSynced: async () => unsynced }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "sports_catalog_unsynced")).toBe(true);
  });
});
