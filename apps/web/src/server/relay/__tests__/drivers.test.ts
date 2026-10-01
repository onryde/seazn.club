// R5 (Task 14b, owner ruling 2026-09-29): a production process with RELAY_DRIVERS unset runs NO drivers. `relayDrivers()`
// then answers a pair whose every port refuses by name — nothing is faked, nothing reaches a provider — and carries the
// `disabled` flag createSession and the relay-sweep cron read to refuse (or skip) before they would call one.
//
// Anti-vacuity: the refusal sweep walks the ports' OWN methods (every function-valued member of the object handed back)
// and reports how many it called; zero is a failure, and it must cover the whole IngestProvider and RunnerProvider
// method sets the usecases call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIngest, FakeRunner } from "../fakes";
import { RelayDriversDisabled, disabledRelayDrivers, relayDrivers, relayUnavailable, setRelayDriversForTest } from "../drivers";

// m-2: the live pair's report reaches Sentry (last describe); the provider-call recorder's DB write is stubbed out.
const sentry = vi.hoisted(() => ({ captureError: vi.fn<(err: unknown, ctx?: { route?: string; extra?: Record<string, unknown> }) => void>() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));
vi.mock("../telemetry", () => ({ recordProviderCall: vi.fn(async () => undefined) }));

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

// N1 (Task 14b fix round 2) + m1 (lane-close review): the division page and the relay-checkout route ask "can this
// deployment stream at all?" on every render / request. N1: answering by CONSTRUCTING the drivers took the fixtures tab
// down on a live deployment missing a Cloudflare secret — `new CloudflareIngest()` throws — for every org. m1: answering
// "no" there was just as wrong the other way — the tab offered Go live and buy tiles, and the checkout SOLD packs, on a
// deployment whose every start would fail. The predicate answers from the mode, the two Cloudflare env reads and the
// test override, and never builds anything.
describe("N1 + m1: relayUnavailable() answers without constructing the drivers — and a live deploy short a Cloudflare secret IS unavailable", () => {
  it("live mode: unavailable EXACTLY when constructing the live drivers would throw — every Cloudflare env combination, derived from the real constructor", () => {
    const combos = [
      { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "tok" },
      { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "tok" },
      { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "" },
      { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "" },
    ];
    let checked = 0;
    let unavailable = 0;
    for (const cf of combos) {
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("RELAY_DRIVERS", "live");
      vi.stubEnv("ENV_NAME", "prod");
      for (const [k, v] of Object.entries(cf)) vi.stubEnv(k, v);
      setRelayDriversForTest(null);
      const label = JSON.stringify(cf);
      expect(() => relayUnavailable(), `${label}: the predicate never throws`).not.toThrow();
      // The expected answer is the REAL constructor's own: does building the live pair refuse in this env?
      let throws = false;
      try {
        relayDrivers();
      } catch {
        throws = true;
      }
      setRelayDriversForTest(null);
      expect(relayUnavailable(), label).toBe(throws);
      if (throws) unavailable++;
      checked++;
    }
    expect(checked).toBe(combos.length);
    expect(unavailable, "three of the four combinations lack a secret").toBe(3);
  });

  it("agrees with the drivers it would build — every mode, and the test override winning over the env", () => {
    const CF = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "tok" };
    const cells: { env: Record<string, string>; override: "disabled" | "fake" | null; want: boolean }[] = [
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "" }, override: null, want: true },
      { env: { NODE_ENV: "test", RELAY_DRIVERS: "" }, override: null, want: false },
      { env: { NODE_ENV: "test", RELAY_DRIVERS: "fake" }, override: null, want: false },
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod", ...CF }, override: null, want: false },
      // setRelayDriversForTest keeps working: the override answers, whatever the env says.
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod", ...CF }, override: "disabled", want: true },
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "" }, override: "fake", want: false },
      { env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "" }, override: "fake", want: false },
    ];
    let checked = 0;
    for (const c of cells) {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(c.env)) vi.stubEnv(k, v);
      setRelayDriversForTest(null);
      if (c.override === "disabled") setRelayDriversForTest(disabledRelayDrivers());
      if (c.override === "fake") setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
      const label = JSON.stringify(c);
      expect(relayUnavailable(), label).toBe(c.want);
      // The predicate and the built pair agree (constructing is safe in every cell: a live one carries its secrets).
      expect(relayDrivers().disabled === true, label).toBe(c.want);
      checked++;
    }
    expect(checked).toBe(cells.length);
    expect(cells.some((c) => c.want) && cells.some((c) => !c.want), "both answers are reached").toBe(true);
  });
});

// m-2 (B5 re-review 2 §4b): the Cloudflare adapter reports an output word it has never seen through an INJECTED reporter
// (it imports no app module — fakes.ts imports it, and e2e specs import fakes.ts outside Next). The live pair must hand it
// `captureError`, or the report is an inert seam that only the adapter's own unit test ever sees. Driven through
// `relayDrivers()` itself, against a stubbed Cloudflare.
describe("m-2: the live drivers wire the Cloudflare adapter's unseen-word report to captureError", () => {
  it("live mode: an unseen output word reads unknown and reaches captureError with the raw word and the session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("ENV_NAME", "prod");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "tok");
    const cf = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, result: [{ uid: "o", status: { current: { state: "reconnected" } } }] }), { status: 200 }));
    vi.stubGlobal("fetch", cf);
    sentry.captureError.mockClear();
    try {
      setRelayDriversForTest(null);
      const { ingest } = relayDrivers();
      expect(await ingest.outputState("in_wire", { sessionId: "sess-wire" })).toBe("unknown");
      expect(cf, "PREMISE: the live adapter really asked (the stubbed) Cloudflare").toHaveBeenCalledTimes(1);
      const reports = sentry.captureError.mock.calls.filter(([, ctx]) => ctx?.route === "relay.output_state");
      expect(reports).toHaveLength(1);
      expect(reports[0]![1]).toMatchObject({ extra: { sessionId: "sess-wire", inputUid: "in_wire", words: ["reconnected"] } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
