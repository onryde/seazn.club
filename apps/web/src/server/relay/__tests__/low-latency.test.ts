// W-LL, review of #1322 (I2, N1): the reader of STREAM_PROGRAMME_LOW_LATENCY. A value that is neither true nor false reads OFF, is handed
// to the caller's reporter ONCE per distinct value per reader, and NEVER throws -- not from the reading, not from a reporter that itself
// fails. The module is PURE (N1): Playwright loads it through fakes.ts > ingest-cf.ts, outside Next, where `server-only` throws at load.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidLowLatencyMessage, lowLatencyReader } from "../low-latency";

afterEach(() => vi.unstubAllEnvs());

describe("lowLatencyReader", () => {
  it("a bad value reads OFF without throwing and is reported once per distinct value; another bad value reports again", () => {
    const report = vi.fn();
    const read = lowLatencyReader(report);
    const env = { ENV_NAME: "stg", STREAM_PROGRAMME_LOW_LATENCY: "maybe" };
    for (let i = 0; i < 5; i++) expect(read(env), `read ${i}`).toBe(false);
    expect(report.mock.calls, "one report for five reads").toEqual([["maybe"]]);
    expect(read({ ...env, STREAM_PROGRAMME_LOW_LATENCY: "1" })).toBe(false);
    expect(report.mock.calls, "a second distinct value is a second report").toEqual([["maybe"], ["1"]]);
  });

  it("two readers keep their own memory: each call site reports once, through its own reporter", () => {
    const a = vi.fn();
    const b = vi.fn();
    const env = { STREAM_PROGRAMME_LOW_LATENCY: "perhaps" };
    lowLatencyReader(a)(env);
    lowLatencyReader(b)(env);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
  });

  it("a good value, set or unset, reports nothing and answers the config's reading (true anywhere, unset only on stg); no reporter is fine too", () => {
    const report = vi.fn();
    const read = lowLatencyReader(report);
    let checked = 0;
    for (const [env, want] of [
      [{ STREAM_PROGRAMME_LOW_LATENCY: "true" }, true], [{ STREAM_PROGRAMME_LOW_LATENCY: "false", ENV_NAME: "stg" }, false],
      [{ ENV_NAME: "stg" }, true], [{ ENV_NAME: "prod" }, false], [{}, false],
    ] as const) {
      expect(read(env), JSON.stringify(env)).toBe(want);
      checked++;
    }
    expect(checked).toBe(5);
    expect(report, "nothing reported").not.toHaveBeenCalled();
    expect(lowLatencyReader()({ STREAM_PROGRAMME_LOW_LATENCY: "maybe" }), "no reporter: still off, no throw").toBe(false);
  });

  it("a reporter that fails never takes the read down: the answer is still OFF", () => {
    const read = lowLatencyReader(() => { throw new Error("logger down"); });
    expect(read({ STREAM_PROGRAMME_LOW_LATENCY: "maybe" })).toBe(false);
    expect(read({ STREAM_PROGRAMME_LOW_LATENCY: "maybe" }), "and the second read").toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("ENV_NAME", "stg");
    vi.stubEnv("STREAM_PROGRAMME_LOW_LATENCY", "");
    expect(lowLatencyReader()()).toBe(true);
  });

  it("the message names the variable and shortens a long value", () => {
    expect(invalidLowLatencyMessage("maybe")).toMatch(/STREAM_PROGRAMME_LOW_LATENCY.*"maybe".*OFF/);
    expect(invalidLowLatencyMessage("x".repeat(500)).length).toBeLessThan(200);
  });
});

// N1: the import chain Playwright loads. e2e/helpers/stream-slot-pool.ts and the court-stream, capture-auto, capture-phone and
// stream-relay walkthroughs import relay/fakes.ts, which imports the Cloudflare adapter; vitest's alias stub for `server-only` hides a
// real one, so this reads the sources. A module in the chain that imports `server-only` (or Sentry, or the app logger, which do)
// would throw at load in a Playwright process.
describe("the relay fakes' import chain stays free of server-only (Playwright loads it outside Next)", () => {
  const SRC = resolve(__dirname, "../../..");
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const resolveSpec = (spec: string, from: string): string | null => {
    const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
    if (base === null) return null;
    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((c) => existsSync(c)) ?? null;
  };
  function walk(entry: string): { seen: string[]; offenders: string[] } {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      const text = strip(readFileSync(f, "utf8"));
      if (/import\s+["']server-only["']/.test(text)) offenders.push(f);
      for (const m of text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/g)) {
        const r = resolveSpec(m[1]!, f);
        if (r !== null) visit(r);
      }
    };
    visit(entry);
    return { seen: [...seen], offenders };
  }

  it("no module reachable from fakes.ts imports server-only; the walk reaches the adapter and the switch reader (anti-vacuity)", () => {
    const { seen, offenders } = walk(join(SRC, "server/relay/fakes.ts"));
    const names = seen.map((f) => f.slice(SRC.length + 1));
    expect(names, "the walk found the adapter").toContain("server/relay/ingest-cf.ts");
    expect(names, "and the switch reader").toContain("server/relay/low-latency.ts");
    expect(seen.length, "and a real chain, not one file").toBeGreaterThan(5);
    expect(offenders.map((f) => f.slice(SRC.length + 1)), "server-only imports in the chain").toEqual([]);
  });

  it("the walker does see a server-only import (its own positive twin): cf-playback.ts is one", () => {
    const { offenders } = walk(join(SRC, "server/video/cf-playback.ts"));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toContain("server/video/cf-playback.ts");
  });
});
