// R5 (Task 14b, owner ruling 2026-09-29): a production process with RELAY_DRIVERS unset runs NO drivers. `relayDrivers()`
// then answers a pair whose every port refuses by name — nothing is faked, nothing reaches a provider — and carries the
// `disabled` flag createSession and the relay-sweep cron read to refuse (or skip) before they would call one.
//
// Anti-vacuity: the refusal sweep walks the ports' OWN methods (every function-valued member of the object handed back)
// and reports how many it called; zero is a failure, and it must cover the whole IngestProvider and RunnerProvider
// method sets the usecases call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIngest, FakeRunner } from "../fakes";
import { RelayDriversDisabled, relayDrivers, setRelayDriversForTest } from "../drivers";

afterEach(() => {
  vi.unstubAllEnvs();
  setRelayDriversForTest(null);
});

/** Function-valued OWN members, read through their descriptors — reading a refusing getter would throw. */
const methodsOf = (o: object): string[] =>
  Object.keys(o).filter((k) => typeof Object.getOwnPropertyDescriptor(o, k)?.value === "function").sort();

describe("R5: relayDrivers() in disabled mode", () => {
  it("production + RELAY_DRIVERS unset → the DISABLED pair: flagged, and every port method rejects with RelayDriversDisabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "");
    vi.stubEnv("ENV_NAME", "prod");
    setRelayDriversForTest(null);
    const d = relayDrivers();
    expect(d.disabled).toBe(true);
    expect(d.ingest).not.toBeInstanceOf(FakeIngest);
    expect(d.runner).not.toBeInstanceOf(FakeRunner);
    const ingest = methodsOf(d.ingest);
    const runner = methodsOf(d.runner);
    // Completeness is tsc's: the disabled pair is typed as the two ports, so a method missing from it does not compile.
    // What runs here is that every method it HAS refuses — the floors below are today's port sizes (9 and 5).
    let refused = 0;
    for (const [port, names] of [[d.ingest, ingest], [d.runner, runner]] as const) {
      for (const name of names) {
        const call = (port as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!("x", {});
        await expect(call, name).rejects.toBeInstanceOf(RelayDriversDisabled);
        refused++;
      }
    }
    expect(refused, "no port method was exercised").toBeGreaterThanOrEqual(ingest.length + runner.length);
    expect(ingest.length, "the ingest port's methods").toBeGreaterThanOrEqual(9);
    expect(runner.length, "the runner port's methods").toBeGreaterThanOrEqual(5);
    // The two data members refuse too: a capability or a settle window read off a disabled provider is a fake number.
    expect(() => d.ingest.capabilities).toThrow(RelayDriversDisabled);
    expect(() => d.runner.listSettleMs).toThrow(RelayDriversDisabled);
  });

  it("the positive pair: the same unset variable outside production is the FAKE pair, unflagged", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    setRelayDriversForTest(null);
    const d = relayDrivers();
    expect(d.disabled).toBeUndefined();
    expect(d.ingest).toBeInstanceOf(FakeIngest);
    expect(d.runner).toBeInstanceOf(FakeRunner);
  });

  it("an explicit fake on a named deployment is refused at the first driver read, not silently served", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "fake");
    vi.stubEnv("ENV_NAME", "stg");
    setRelayDriversForTest(null);
    expect(() => relayDrivers()).toThrow(/RELAY_DRIVERS=fake is refused on ENV_NAME/);
  });
});
