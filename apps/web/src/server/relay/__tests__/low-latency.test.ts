// W-LL, review of #1322 (I2): the request-path reader of STREAM_PROGRAMME_LOW_LATENCY. A value that is neither true nor false reads
// OFF, is reported ONCE per distinct value per process (the app logger's warn and the app's Sentry capture helper, which is the one
// path to Sentry: nothing here initialises it), and NEVER throws -- not from the reading, not from a reporter that itself fails.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { warn, capture } = vi.hoisted(() => ({ warn: vi.fn(), capture: vi.fn() }));
vi.mock("@/server/logger", () => ({ log: { warn } }));
vi.mock("@/lib/sentry", () => ({ captureError: capture }));

import { lowLatencyOn, resetLowLatencyReports } from "../low-latency";

beforeEach(() => { warn.mockReset(); capture.mockReset(); resetLowLatencyReports(); });
afterEach(() => vi.unstubAllEnvs());

describe("lowLatencyOn", () => {
  it("a bad value reads OFF without throwing and is reported once per distinct value: one warn and one capture, then silence; another bad value reports again", () => {
    const env = { ENV_NAME: "stg", STREAM_PROGRAMME_LOW_LATENCY: "maybe" };
    for (let i = 0; i < 5; i++) expect(lowLatencyOn(env), `read ${i}`).toBe(false);
    expect(warn, "one warning for five reads").toHaveBeenCalledTimes(1);
    expect(capture, "one Sentry capture for five reads").toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(String(warn.mock.calls[0]![1])).toMatch(/STREAM_PROGRAMME_LOW_LATENCY/);
    expect(lowLatencyOn({ ...env, STREAM_PROGRAMME_LOW_LATENCY: "1" })).toBe(false);
    expect([warn.mock.calls.length, capture.mock.calls.length], "a second distinct value is a second report").toEqual([2, 2]);
  });

  it("a good value, set or unset, reports nothing and answers the config's reading (on for true anywhere, on unset only on stg)", () => {
    let checked = 0;
    for (const [env, want] of [
      [{ STREAM_PROGRAMME_LOW_LATENCY: "true" }, true], [{ STREAM_PROGRAMME_LOW_LATENCY: "false", ENV_NAME: "stg" }, false],
      [{ ENV_NAME: "stg" }, true], [{ ENV_NAME: "prod" }, false], [{}, false],
    ] as const) {
      expect(lowLatencyOn(env), JSON.stringify(env)).toBe(want);
      checked++;
    }
    expect(checked).toBe(5);
    expect([warn, capture].map((f) => f.mock.calls.length), "nothing reported").toEqual([0, 0]);
  });

  it("a reporter that fails never takes the read down: the answer is still OFF", () => {
    warn.mockImplementation(() => { throw new Error("logger down"); });
    expect(lowLatencyOn({ STREAM_PROGRAMME_LOW_LATENCY: "maybe" })).toBe(false);
    warn.mockReset();
    capture.mockImplementation(() => { throw new Error("sentry down"); });
    expect(lowLatencyOn({ STREAM_PROGRAMME_LOW_LATENCY: "perhaps" })).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("ENV_NAME", "stg");
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "");
    expect(lowLatencyOn()).toBe(true);
  });
});
