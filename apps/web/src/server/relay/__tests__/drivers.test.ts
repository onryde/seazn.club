// R5 (Task 14b, owner ruling 2026-09-29): a production process with RELAY_DRIVERS unset runs NO drivers. `relayDrivers()`
// then answers a pair whose every port refuses by name — nothing is faked, nothing reaches a provider — and carries the
// `disabled` flag createSession and the relay-sweep cron read to refuse (or skip) before they would call one.
//
// Anti-vacuity: the refusal sweep walks the ports' OWN methods (every function-valued member of the object handed back)
// and reports how many it called; zero is a failure, and it must cover the whole IngestProvider and RunnerProvider
// method sets the usecases call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIngest, FakeRunner } from "../fakes";
import { RelayDriversDisabled, disabledRelayDrivers, relayDrivers, relayIsDisabled, setRelayDriversForTest } from "../drivers";

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

// N1 (Task 14b fix round 2): the division page and the relay-checkout route ask "is the relay off?" on every render /
// request. Answering by CONSTRUCTING the drivers took the fixtures tab down on a live deployment missing a Cloudflare
// secret — `new CloudflareIngest()` throws — for every org, since V426 entitles the relay on every plan. The predicate
// answers from the mode (or the test override) and never builds anything.
describe("N1: relayIsDisabled() answers without constructing the drivers", () => {
  it("live mode with NO Cloudflare env answers false and does not throw — while constructing the drivers there WOULD throw", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "");
    setRelayDriversForTest(null);
    expect(() => relayIsDisabled()).not.toThrow();
    expect(relayIsDisabled()).toBe(false);
    // The premise, witnessed: in this env the constructing read is exactly what fails.
    expect(() => relayDrivers()).toThrow(/CLOUDFLARE_ACCOUNT_ID is not set/);
  });

  it("agrees with the drivers it would build — every mode, and the test override winning over the env", () => {
    const cells: { env: Record<string, string>; override: "disabled" | "fake" | null; want: boolean }[] = [
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "" }, override: null, want: true },
      { env: { NODE_ENV: "test", RELAY_DRIVERS: "" }, override: null, want: false },
      { env: { NODE_ENV: "test", RELAY_DRIVERS: "fake" }, override: null, want: false },
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod" }, override: null, want: false },
      // setRelayDriversForTest keeps working: the override answers, whatever the env says.
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod" }, override: "disabled", want: true },
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "" }, override: "fake", want: false },
    ];
    let checked = 0;
    for (const c of cells) {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(c.env)) vi.stubEnv(k, v);
      setRelayDriversForTest(null);
      if (c.override === "disabled") setRelayDriversForTest(disabledRelayDrivers());
      if (c.override === "fake") setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      const label = JSON.stringify(c);
      expect(relayIsDisabled(), label).toBe(c.want);
      // Where constructing is safe (no live cell), the predicate and the built pair agree.
      if (c.env.RELAY_DRIVERS !== "live" || c.override) expect(relayDrivers().disabled === true, label).toBe(c.want);
      checked++;
    }
    expect(checked).toBe(cells.length);
    expect(cells.some((c) => c.want) && cells.some((c) => !c.want), "both answers are reached").toBe(true);
  });
});
