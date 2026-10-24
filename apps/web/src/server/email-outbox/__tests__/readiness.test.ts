// R13 boot readiness: "RESEND_API_KEY set, EMAIL_OUTBOX_KEK missing in production" must be loud BEFORE a user hits sign-in.
// Two layers, each with its own kind of proof:
//  - the rule (`outboxKeyProblem`) and the report (`reportOutboxReadiness`): a table over the whole input space, with the
//    expected value taken from the spec's statement of the rule, not from seal.ts;
//  - the seam (`register()` in instrumentation.ts, the hook Next calls once before the server takes a request): driven for
//    real, so a report that nothing calls is caught (the inert-seam class).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: logMock }));
const sentryMock = vi.hoisted(() => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureRequestError: () => {}, init: () => {}, ...sentryMock }));
vi.mock("../../../../sentry.server.config", () => ({}));
vi.mock("../../../../sentry.edge.config", () => ({}));
// The two other boot checks register() runs are not the subject here; the relay's own tests drive them.
vi.mock("@/server/relay/config", () => ({ relayDriverMode: vi.fn() }));
vi.mock("@/server/public-site/error-no-store", () => ({ installPublicErrorNoStore: vi.fn() }));

import { outboxKeyProblem } from "../seal";
import { outboxReadinessMessage, reportOutboxReadiness } from "../readiness";

const EXAMPLE_FILE = path.resolve(__dirname, "../../../../.env.example");
const PUBLISHED_SAMPLE = /^EMAIL_OUTBOX_KEK=([0-9a-f]{64})$/m.exec(fs.readFileSync(EXAMPLE_FILE, "utf8"))?.[1] ?? "";
const OWN_KEK = "ab".repeat(32);
const RESEND = "re_live_0123456789abcdef";

beforeEach(() => {
  for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug, sentryMock.captureMessage, sentryMock.captureException]) m.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

/** The spec's rule as a table: (resend key?, outbox key state, NODE_ENV) -> the problem, or null when the box is ready. */
type Row = { resend: boolean; kek: "unset" | "empty" | "short" | "non-hex" | "own" | "sample" | "SAMPLE"; env: "production" | "development" | "test"; problem: "unset" | "sample" | null };
const ROWS: Row[] = [];
for (const env of ["production", "development", "test"] as const) {
  for (const kek of ["unset", "empty", "short", "non-hex"] as const) {
    ROWS.push({ resend: true, kek, env, problem: "unset" }); // can send mail it cannot protect
    ROWS.push({ resend: false, kek, env, problem: null }); // dev / CI: cannot send anyway, nothing to protect
  }
  for (const resend of [true, false]) {
    ROWS.push({ resend, kek: "own", env, problem: null });
    for (const kek of ["sample", "SAMPLE"] as const) ROWS.push({ resend, kek, env, problem: env === "production" ? "sample" : null });
  }
}

function setEnv(r: Row): string | undefined {
  const value = { unset: undefined, empty: "", short: "ab".repeat(31), "non-hex": "zz".repeat(32), own: OWN_KEK, sample: PUBLISHED_SAMPLE, SAMPLE: PUBLISHED_SAMPLE.toUpperCase() }[r.kek];
  vi.stubEnv("EMAIL_OUTBOX_KEK", value);
  vi.stubEnv("RESEND_API_KEY", r.resend ? RESEND : undefined);
  vi.stubEnv("NODE_ENV", r.env);
  return value;
}

describe("the readiness rule, over every (Resend key, outbox key, NODE_ENV) combination", () => {
  it("premise: the table covers both problems and the ready case, and the published sample is real", () => {
    expect(PUBLISHED_SAMPLE).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(ROWS.map((r) => r.problem))).toEqual(new Set(["unset", "sample", null]));
    expect(ROWS.length).toBe(3 * (4 * 2 + 2 * 3)); // 3 environments x (4 bad keys x 2 resend states + 2 resend states x 3 usable keys)
  });

  it("outboxKeyProblem answers the table", () => {
    let checked = 0;
    for (const r of ROWS) {
      setEnv(r);
      expect(outboxKeyProblem(), JSON.stringify(r)).toBe(r.problem);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("reportOutboxReadiness logs exactly one error line when not ready and nothing at all when ready", () => {
    let withProblem = 0;
    let ready = 0;
    for (const r of ROWS) {
      logMock.error.mockClear();
      for (const m of [logMock.warn, logMock.info, logMock.debug]) m.mockClear();
      const kekValue = setEnv(r);
      const result = reportOutboxReadiness();
      expect(result, JSON.stringify(r)).toBe(r.problem);
      if (r.problem) {
        expect(logMock.error, JSON.stringify(r)).toHaveBeenCalledTimes(1);
        const [fields, message] = logMock.error.mock.calls[0]!;
        expect(fields).toEqual({ problem: r.problem });
        expect(message).toBe(outboxReadinessMessage(r.problem));
        expect(message).toMatch(/EMAIL_OUTBOX_KEK/);
        // Names the variable, never a value.
        for (const secret of [kekValue, PUBLISHED_SAMPLE, PUBLISHED_SAMPLE.toUpperCase(), RESEND, OWN_KEK]) {
          if (secret) expect(JSON.stringify(logMock.error.mock.calls), JSON.stringify(r)).not.toContain(secret);
        }
        withProblem++;
      } else {
        for (const m of [logMock.error, logMock.warn, logMock.info, logMock.debug]) expect(m, JSON.stringify(r)).not.toHaveBeenCalled();
        ready++;
      }
    }
    expect(withProblem).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(0);
    expect(withProblem + ready).toBe(ROWS.length);
  });

  it("the two problems read differently to the person on call", () => {
    expect(outboxReadinessMessage("unset")).not.toBe(outboxReadinessMessage("sample"));
    expect(outboxReadinessMessage("unset")).toMatch(/RESEND_API_KEY/);
    expect(outboxReadinessMessage("sample")).toMatch(/sample/i);
  });
});

// The seam. register() is what Next calls once before the server takes a request; the report only helps if it is called.
describe("register() (instrumentation.ts) reports outbox readiness at boot", () => {
  async function boot() {
    const { register } = await import("../../../../instrumentation");
    return register();
  }

  it("nodejs, Resend key set and no outbox key: resolves (does NOT stop the boot), logs the error once and alerts Sentry", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", RESEND);
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    await expect(boot()).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]![0]).toEqual({ problem: "unset" });
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(outboxReadinessMessage("unset"), "error");
    expect(JSON.stringify([logMock.error.mock.calls, sentryMock.captureMessage.mock.calls])).not.toContain(RESEND);
  });

  it("nodejs, the published sample key in production: logs and alerts with the sample message", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", RESEND);
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
    await expect(boot()).resolves.toBeUndefined();
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]![0]).toEqual({ problem: "sample" });
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(outboxReadinessMessage("sample"), "error");
    expect(JSON.stringify([logMock.error.mock.calls, sentryMock.captureMessage.mock.calls])).not.toContain(PUBLISHED_SAMPLE);
  });

  it("nodejs, a ready box (own key; and no Resend key at all, as in dev and CI): no log line, no alert", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_OUTBOX_KEK", OWN_KEK);
    vi.stubEnv("RESEND_API_KEY", RESEND);
    await expect(boot()).resolves.toBeUndefined();
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    vi.stubEnv("RESEND_API_KEY", undefined);
    await expect(boot()).resolves.toBeUndefined();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
  });

  it("the edge runtime serves no sign-in route and does not run the check (positive pair: the same env reports on nodejs)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", RESEND);
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(boot()).resolves.toBeUndefined();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(sentryMock.captureMessage).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await boot();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});
