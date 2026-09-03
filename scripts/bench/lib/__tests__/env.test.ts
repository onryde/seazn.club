// DB-free unit + regression coverage for the pre-flight orchestration.
// Every probe is injected (PreflightProbes) — no live Postgres, server, or
// placement container involved, which is the whole point of the DI split
// in lib/env.ts (see its header comment).
import { describe, expect, it } from "vitest";
import {
  runPreflight,
  type AppHealthResult,
  type ChromiumInstalledResult,
  type OwnDatabaseResult,
  type OwnPortResult,
  type PlacementHealthResult,
  type PreflightProbes,
  type SelectedDivisionExposure,
  type SportsCatalogResult,
  type StripeConfigResult,
} from "../env.ts";

const PASSING_DB: OwnDatabaseResult = { ok: true, detail: "own DB confirmed", dataDirectory: "/data/bench", port: 54329 };
const PASSING_PORT: OwnPortResult = { ok: true, detail: "bound", pid: 4242 };
const PASSING_CATALOG: SportsCatalogResult = { ok: true, detail: "synced" };
const PASSING_HEALTH: AppHealthResult = { ok: true, detail: "healthy" };
const LIVE_PLACEMENT: PlacementHealthResult = { status: "live", detail: "answered" };
const ABSENT_PLACEMENT: PlacementHealthResult = { status: "absent", detail: "unreachable" };

const PASSING_STRIPE: StripeConfigResult = {
  testModeKeyPresent: true,
  liveKeyDetected: false,
  connectTestAccountPresent: true,
  webhookSecretPresent: true,
  webhookListenerLive: true,
  webhookListenerDetail: "confirmed live",
};
const ABSENT_STRIPE: StripeConfigResult = {
  testModeKeyPresent: false,
  liveKeyDetected: false,
  connectTestAccountPresent: false,
  webhookSecretPresent: false,
  webhookListenerLive: false,
  webhookListenerDetail: "nothing configured",
};
const LIVE_KEY_STRIPE: StripeConfigResult = {
  ...PASSING_STRIPE,
  testModeKeyPresent: false,
  liveKeyDetected: true,
};
const WEBHOOK_SECRET_NO_LISTENER_STRIPE: StripeConfigResult = {
  ...PASSING_STRIPE,
  webhookSecretPresent: true,
  webhookListenerLive: false,
  webhookListenerDetail: "STRIPE_LISTEN_PID set but lsof found no live process",
};
const WEBHOOK_LISTENER_INDETERMINATE_STRIPE: StripeConfigResult = {
  ...PASSING_STRIPE,
  webhookListenerLive: null,
  webhookListenerDetail: "neither STRIPE_LISTEN_STATUS_FILE nor STRIPE_LISTEN_PID is set",
};

const PASSING_CHROMIUM: ChromiumInstalledResult = { ok: true, detail: "found" };
const ABSENT_CHROMIUM: ChromiumInstalledResult = { ok: false, detail: "no chromium binary on disk" };

const ADMIN_ONLY: SelectedDivisionExposure[] = [{ entry: "admin", pay: false }];
const PAID_API_DIVISION: SelectedDivisionExposure[] = [{ entry: "registration-api", pay: true }];
const FREE_UI_DIVISION: SelectedDivisionExposure[] = [{ entry: "registration-ui", pay: false }];

function fakeProbes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    checkOwnDatabase: async () => PASSING_DB,
    checkOwnPort: async () => PASSING_PORT,
    checkPlacementHealth: async () => LIVE_PLACEMENT,
    checkSportsCatalogSynced: async () => PASSING_CATALOG,
    checkAppHealth: async () => PASSING_HEALTH,
    checkStripeConfig: async () => PASSING_STRIPE,
    checkChromiumInstalled: async () => PASSING_CHROMIUM,
    ...overrides,
  };
}

describe("runPreflight — verdict matrix", () => {
  it("a malformed --base is a named refusal, not a thrown TypeError", async () => {
    // Regression: resolvePort()/new URL(base) used to be unguarded, so this
    // crashed straight out of runPreflight — contradicting its own doc
    // comment ("never throws itself").
    await expect(runPreflight("not a url", fakeProbes())).resolves.not.toThrow();
    const result = await runPreflight("not a url", fakeProbes());
    expect(result.ok).toBe(false);
    expect(result.refusals).toEqual([{ reason: "base_url_invalid", detail: expect.stringContaining("not a url") }]);
  });

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

  it("refuses a 127.0.0.1 base outright (Secure-cookie rule drops the auth cookie there)", async () => {
    const result = await runPreflight("http://127.0.0.1:54301", fakeProbes());
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "base_host_forbidden")).toBe(true);
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

// B03r task 7: the registration-layer pre-flight additions. The escalation
// rule (design §6 / B03r-repins §2 quoting the brief): "Abort only if a
// SELECTED division has pay:true or entry:registration-ui. Otherwise warn."
// So every Stripe/Chromium check below is graded against the RESOLVED
// selection passed in, never against a global "is Stripe configured" fact —
// `runPreflight`'s third parameter is the decoupling seam (no import from
// the concurrently-built `lib/register.ts` --entry resolver).
describe("runPreflight — registration escalation (Stripe/Chromium, B03r task 7)", () => {
  it("an admin-only selection warns but never aborts, even with Stripe AND Chromium fully absent", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE, checkChromiumInstalled: async () => ABSENT_CHROMIUM }),
      ADMIN_ONLY,
    );
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    const reasons = result.warnings.map((w) => w.reason).sort();
    expect(reasons).toEqual(
      [
        "stripe_secret_key_missing_or_invalid",
        "stripe_connect_test_account_missing",
        "stripe_webhook_not_confirmed",
        "registration_ui_chromium_missing",
      ].sort(),
    );
  });

  it("no selected divisions at all (e.g. an empty suite) also only warns", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE, checkChromiumInstalled: async () => ABSENT_CHROMIUM }),
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it("MATRIX DIFFERENTIAL: the identical absent-Stripe probe result aborts for a paid division but only warns for admin-only — proves the decision reads the selection, not a constant", async () => {
    const probes = fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE });

    const adminResult = await runPreflight("http://localhost:54301", probes, ADMIN_ONLY);
    expect(adminResult.ok).toBe(true);

    const paidResult = await runPreflight("http://localhost:54301", probes, PAID_API_DIVISION);
    expect(paidResult.ok).toBe(false);
    expect(paidResult.refusals.some((r) => r.reason === "stripe_secret_key_missing_or_invalid")).toBe(true);
  });

  it("MATRIX DIFFERENTIAL: the identical absent-Chromium probe result aborts for a registration-ui division but only warns for a registration-api one", async () => {
    const probes = fakeProbes({ checkChromiumInstalled: async () => ABSENT_CHROMIUM });

    const apiResult = await runPreflight("http://localhost:54301", probes, PAID_API_DIVISION);
    expect(apiResult.refusals.some((r) => r.reason === "registration_ui_chromium_missing")).toBe(false);
    expect(apiResult.warnings.some((r) => r.reason === "registration_ui_chromium_missing")).toBe(true);

    const uiResult = await runPreflight("http://localhost:54301", probes, FREE_UI_DIVISION);
    expect(uiResult.ok).toBe(false);
    expect(uiResult.refusals.some((r) => r.reason === "registration_ui_chromium_missing")).toBe(true);
  });

  it("pay:true selected, Stripe entirely absent -> abort", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE }),
      PAID_API_DIVISION,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "stripe_secret_key_missing_or_invalid")).toBe(true);
    expect(result.refusals.some((r) => r.reason === "stripe_connect_test_account_missing")).toBe(true);
  });

  it("entry:registration-ui selected, Chromium absent -> abort", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkChromiumInstalled: async () => ABSENT_CHROMIUM }),
      FREE_UI_DIVISION,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({ reason: "registration_ui_chromium_missing", detail: ABSENT_CHROMIUM.detail });
  });

  it("a LIVE sk_live_ key aborts regardless of selection — distinct from merely absent", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => LIVE_KEY_STRIPE }),
      ADMIN_ONLY,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "stripe_live_key_detected")).toBe(true);
    // Distinct reason from "absent" — a live key must not be reported (or
    // silently folded into) the missing/invalid bucket.
    expect(result.refusals.some((r) => r.reason === "stripe_secret_key_missing_or_invalid")).toBe(false);
  });

  it("a LIVE key still aborts even when a paid division IS selected (not a special-case-only path)", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => LIVE_KEY_STRIPE }),
      PAID_API_DIVISION,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "stripe_live_key_detected")).toBe(true);
  });

  it("webhook secret present but no live `stripe listen` forwarder -> abort when a paid division is selected", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => WEBHOOK_SECRET_NO_LISTENER_STRIPE }),
      PAID_API_DIVISION,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals.some((r) => r.reason === "stripe_webhook_not_confirmed")).toBe(true);
    // The rest of Stripe config is fine — only the listener finding fires.
    expect(result.refusals.some((r) => r.reason === "stripe_secret_key_missing_or_invalid")).toBe(false);
    expect(result.refusals.some((r) => r.reason === "stripe_connect_test_account_missing")).toBe(false);
  });

  it("webhook liveness that cannot be determined either way is treated as NOT confirmed (never passes by default) when a paid division is selected", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => WEBHOOK_LISTENER_INDETERMINATE_STRIPE }),
      PAID_API_DIVISION,
    );
    expect(result.ok).toBe(false);
    expect(result.refusals).toContainEqual({
      reason: "stripe_webhook_not_confirmed",
      detail: expect.stringContaining("could not be determined"),
    });
  });

  it("an indeterminate webhook liveness is only a warning when no selected division needs Stripe", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => WEBHOOK_LISTENER_INDETERMINATE_STRIPE }),
      ADMIN_ONLY,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.reason === "stripe_webhook_not_confirmed")).toBe(true);
  });

  it("a mixed selection (one admin division, one paid division) still aborts on the paid one's missing Stripe", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE }),
      [...ADMIN_ONLY, ...PAID_API_DIVISION],
    );
    expect(result.ok).toBe(false);
  });

  it("no secret found never leaks the key value — refusal detail never contains a value-shaped string beyond the sk_test_/sk_live_ discriminator", async () => {
    const result = await runPreflight(
      "http://localhost:54301",
      fakeProbes({ checkStripeConfig: async () => ABSENT_STRIPE }),
      PAID_API_DIVISION,
    );
    for (const r of result.refusals) {
      expect(r.detail).not.toMatch(/sk_(test|live)_[A-Za-z0-9]/);
    }
  });

  it("everything present and needed -> full pass, no refusals, no warnings", async () => {
    const result = await runPreflight("http://localhost:54301", fakeProbes(), [...PAID_API_DIVISION, ...FREE_UI_DIVISION]);
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
