// R5 (Task 14b, owner ruling 2026-09-29): a production process with RELAY_DRIVERS unset runs NO drivers. `relayDrivers()`
// then answers a pair whose every port refuses by name — nothing is faked, nothing reaches a provider — and carries the
// `disabled` flag createSession and the relay-sweep cron read to refuse (or skip) before they would call one.
//
// Anti-vacuity: the refusal sweep walks the ports' OWN methods (every function-valued member of the object handed back)
// and reports how many it called; zero is a failure, and it must cover the whole IngestProvider and RunnerProvider
// method sets the usecases call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIngest, FakeRunner } from "../fakes";
import { FlyClient } from "../fly-client";
import { FlyRunner } from "../runner-fly";
import { FLY_RELAY_APP_RETIRED_DEFAULT, relayDriverMode, relayOutputProfile } from "../config";
import { RelayDriversDisabled, composedUnavailable, disabledRelayDrivers, relayDrivers, relayUnavailable, setRelayDriversForTest } from "../drivers";

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
    // What runs here is that every method it HAS refuses — the floors below are today's port sizes (11 and 5).
    let refused = 0;
    for (const [port, names] of [[d.ingest, ingest], [d.runner, runner]] as const) {
      for (const name of names) {
        const call = (port as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!("x", {});
        await expect(call, name).rejects.toBeInstanceOf(RelayDriversDisabled);
        refused++;
      }
    }
    expect(refused, "no port method was exercised").toBeGreaterThanOrEqual(ingest.length + runner.length);
    expect(ingest.length, "the ingest port's methods").toBeGreaterThanOrEqual(11);
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

// R2001 (the composed hazard): a composed start used to be admitted on a deployment with no compositor image, write its
// row and open its Cloudflare input, and only THEN fail at FlyRunner's constructor. `composedUnavailable()` is the ONE
// answer to "can this deployment run a composed session?" — the usecase refuses on it at the start's entry (no session
// row, input, credit or runner is created), and the organiser
// UI (R2006) reads the same predicate. Unavailable = the relay is unavailable OR RELAY_IMAGE is unset; only up + set is
// available. Each side of the OR is witnessed ALONE (up + unset, down + set), so neither half can stand in for the other.
describe("R2001: composedUnavailable() — the relay up/down × RELAY_IMAGE set/unset table", () => {
  const IMAGE = "registry.fly.io/seazn-relay:r2001";
  const CF = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STREAM_TOKEN: "tok" };
  // "up"/"down" are built from the env relayUnavailable() reads (no override), in both a fake and a live shape; the
  // PREMISE line asserts each relay cell is what its label says before the table is read.
  const RELAY: { name: string; down: boolean; env: Record<string, string> }[] = [
    { name: "up (fake, outside production)", down: false, env: { NODE_ENV: "test", RELAY_DRIVERS: "" } },
    // I1: a live "up" cell carries the live runner's whole configuration too, so its image column is the image's alone.
    { name: "up (live, both Cloudflare secrets)", down: false, env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod", ...CF, FLY_API_TOKEN: "fly-tok", FLY_RELAY_APP: "seazn-relay-prod" } },
    { name: "down (disabled: production, RELAY_DRIVERS unset)", down: true, env: { NODE_ENV: "production", RELAY_DRIVERS: "" } },
    { name: "down (live, no Cloudflare secret)", down: true, env: { NODE_ENV: "production", RELAY_DRIVERS: "live", ENV_NAME: "prod", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_STREAM_TOKEN: "" } },
  ];
  // Unset means unset OR empty — the same truthiness FlyRunner's constructor refuses on (derived below, not assumed).
  const IMAGES: { name: string; value: string | undefined; set: boolean }[] = [
    { name: "set", value: IMAGE, set: true },
    { name: "unset (absent)", value: undefined, set: false },
    { name: "unset (empty)", value: "", set: false },
  ];

  it("only relay up + RELAY_IMAGE set is available; every other cell is unavailable — and the predicate never throws", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const relay of RELAY) {
      for (const image of IMAGES) {
        vi.unstubAllEnvs();
        for (const [k, v] of Object.entries(relay.env)) vi.stubEnv(k, v);
        vi.stubEnv("RELAY_IMAGE", image.value);
        setRelayDriversForTest(null);
        const label = `relay ${relay.name} × RELAY_IMAGE ${image.name}`;
        expect(relayUnavailable(), `PREMISE ${label}`).toBe(relay.down);
        expect(() => composedUnavailable(), label).not.toThrow();
        const want = relay.down || !image.set;   // the table, as R2001 states it: only up + set is available
        expect(composedUnavailable(), label).toBe(want);
        seen.add(`${relay.down ? "down" : "up"}+${image.set ? "set" : "unset"}`);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(RELAY.length * IMAGES.length);
    expect([...seen].sort(), "all four cells of the 2×2 are reached").toEqual(["down+set", "down+unset", "up+set", "up+unset"]);
  });

  it("each side of the OR alone: relay UP with no image is unavailable (the image half); relay DOWN with an image is unavailable (the relay half); up + set is the one available cell", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    vi.stubEnv("RELAY_IMAGE", "");
    setRelayDriversForTest(null);
    expect(relayUnavailable(), "PREMISE: the relay is up").toBe(false);
    expect(composedUnavailable(), "up + unset: the image half alone").toBe(true);
    vi.stubEnv("RELAY_IMAGE", IMAGE);
    expect(composedUnavailable(), "up + set: the positive pair").toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    setRelayDriversForTest(null);
    expect(relayUnavailable(), "PREMISE: the relay is down").toBe(true);
    expect(composedUnavailable(), "down + set: the relay half alone").toBe(true);
  });

  it("the test override answers the relay half (as relayUnavailable does) but never excuses a missing image", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    const cells: { override: "fake" | "disabled"; image: string; want: boolean }[] = [
      { override: "fake", image: IMAGE, want: false },
      { override: "fake", image: "", want: true },
      { override: "disabled", image: IMAGE, want: true },
      { override: "disabled", image: "", want: true },
    ];
    let checked = 0;
    for (const c of cells) {
      vi.stubEnv("RELAY_IMAGE", c.image);
      setRelayDriversForTest(c.override === "fake" ? { ingest: new FakeIngest(), runner: new FakeRunner() } : disabledRelayDrivers());
      expect(composedUnavailable(), JSON.stringify(c)).toBe(c.want);
      checked++;
    }
    expect(checked).toBe(cells.length);
  });

  it("the image half agrees with the REAL consumer: with the relay up, unavailable EXACTLY when FlyRunner's constructor refuses for want of RELAY_IMAGE", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    // An injected client: the constructor's ONLY env read is then RELAY_IMAGE, so its refusal is the image's alone.
    const client = new FlyClient({ token: "fly-tok", app: "seazn-relay-r2001" });
    let checked = 0;
    let refused = 0;
    for (const image of IMAGES) {
      vi.stubEnv("RELAY_IMAGE", image.value);
      setRelayDriversForTest(null);
      let throws = false;
      try {
        new FlyRunner({ client });
      } catch (e) {
        expect(String(e), image.name).toMatch(/RELAY_IMAGE is not set/);
        throws = true;
      }
      expect(composedUnavailable(), image.name).toBe(throws);
      if (throws) refused++;
      checked++;
    }
    expect(checked).toBe(IMAGES.length);
    expect(refused, "the two unset shapes are both refused by the constructor").toBe(2);
  });

  it("R2004 review m5: RELAY_OUTPUT_PROFILE — with the relay up and the image set, unavailable EXACTLY when the job facts' own reader (relayOutputProfile) refuses the value; under the test override too; the predicate never throws", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    vi.stubEnv("RELAY_IMAGE", IMAGE);
    const VALUES: (string | undefined)[] = [undefined, "", "   ", "720p", "1080p", " 1080p ", "4k", "720", "1080P"];
    let checked = 0;
    let refused = 0;
    for (const override of [false, true]) {
      for (const value of VALUES) {
        vi.stubEnv("RELAY_OUTPUT_PROFILE", value);
        setRelayDriversForTest(override ? { ingest: new FakeIngest(), runner: new FakeRunner() } : null);
        const label = `${override ? "override" : "env"} × ${JSON.stringify(value)}`;
        let throws = false;
        try { relayOutputProfile(); } catch (e) { expect(String(e), label).toMatch(/RELAY_OUTPUT_PROFILE/); throws = true; }
        expect(() => composedUnavailable(), label).not.toThrow();
        expect(composedUnavailable(), label).toBe(throws);
        if (throws) refused++;
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(VALUES.length * 2);
    expect(refused, "both halves of the differential: the three bad values, under both drivers").toBe(6);
  });

  it("answers without constructing anything: a live deployment short FLY_API_TOKEN (which the runner's constructor refuses) does not make the predicate throw", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "live");
    vi.stubEnv("ENV_NAME", "prod");
    for (const [k, v] of Object.entries(CF)) vi.stubEnv(k, v);
    vi.stubEnv("RELAY_IMAGE", IMAGE);
    vi.stubEnv("FLY_API_TOKEN", "");
    setRelayDriversForTest(null);
    expect(() => new FlyRunner(), "PREMISE: constructing the live runner here throws").toThrow(/FLY_API_TOKEN/);
    expect(() => composedUnavailable()).not.toThrow();
    expect(composedUnavailable(), "I1: and it answers unavailable — the runner half").toBe(true);
  });

  // I1 (review of PR #965): a LIVE deployment's composed runner is FlyRunner, built on first use (drivers.ts lazyRunner).
  // Its constructor refuses an unset FLY_API_TOKEN as well as RELAY_IMAGE, and whatever liveRunnerIdentity() refuses
  // (FLY_RELAY_APP unset, blank or the retired shared default; ENV_NAME unset). Each such deployment would admit a composed
  // start, write its row, open its Cloudflare input and only then fail made-nothing. The relay is UP in every cell below
  // (the PREMISE line), so each answer is the runner half's alone.
  const LIVE_FULL: Record<string, string> = {
    NODE_ENV: "production", RELAY_DRIVERS: "live", ...CF, RELAY_IMAGE: IMAGE, FLY_API_TOKEN: "fly-tok", FLY_RELAY_APP: "seazn-relay-prod", ENV_NAME: "prod",
  };
  const LIVE_CELLS: { name: string; patch: Record<string, string | undefined> }[] = [
    { name: "all present", patch: {} },
    { name: "FLY_API_TOKEN absent", patch: { FLY_API_TOKEN: undefined } },
    { name: "FLY_API_TOKEN empty", patch: { FLY_API_TOKEN: "" } },
    { name: "FLY_RELAY_APP absent", patch: { FLY_RELAY_APP: undefined } },
    { name: "FLY_RELAY_APP blank", patch: { FLY_RELAY_APP: "  " } },
    { name: "FLY_RELAY_APP the retired shared default", patch: { FLY_RELAY_APP: FLY_RELAY_APP_RETIRED_DEFAULT } },
    { name: "ENV_NAME absent", patch: { ENV_NAME: undefined } },
    { name: "ENV_NAME empty", patch: { ENV_NAME: "" } },
  ];

  it("I1: on a LIVE deployment each missing runner variable ALONE leaves composed unavailable and all present leaves it available — agreeing cell by cell with the REAL constructor, and nothing asks Fly", () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      let checked = 0;
      let refused = 0;
      for (const cell of LIVE_CELLS) {
        vi.unstubAllEnvs();
        for (const [k, v] of Object.entries({ ...LIVE_FULL, ...cell.patch })) vi.stubEnv(k, v);
        setRelayDriversForTest(null);
        expect(relayDriverMode(), `PREMISE ${cell.name}: live`).toBe("live");
        expect(relayUnavailable(), `PREMISE ${cell.name}: the relay is up`).toBe(false);
        expect(() => composedUnavailable(), cell.name).not.toThrow();
        // The rule, as the review ruling states it: only the all-present cell is available.
        expect(composedUnavailable(), cell.name).toBe(cell.name !== "all present");
        // The REAL consumer agrees: the live runner's own constructor refuses exactly the unavailable cells.
        let throws = false;
        try {
          new FlyRunner();
        } catch {
          throws = true;
        }
        expect(composedUnavailable(), `${cell.name}: agrees with FlyRunner's constructor`).toBe(throws);
        if (throws) refused++;
        checked++;
      }
      expect(checked, "anti-vacuity").toBe(LIVE_CELLS.length);
      expect(refused, "every cell but all-present is refused by the real constructor").toBe(LIVE_CELLS.length - 1);
      expect(fetchSpy, "neither the predicate nor the constructor asked Fly").not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("I1: the runner half is LIVE-only — a fake deployment, or the test override, with none of FLY_API_TOKEN / FLY_RELAY_APP / ENV_NAME stays available (their runner needs none of them); the same live env with no override is unavailable", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RELAY_DRIVERS", "");
    vi.stubEnv("RELAY_IMAGE", IMAGE);
    for (const k of ["FLY_API_TOKEN", "FLY_RELAY_APP", "ENV_NAME"]) vi.stubEnv(k, undefined);
    setRelayDriversForTest(null);
    expect(relayDriverMode(), "PREMISE: fake").toBe("fake");
    expect(composedUnavailable(), "fake, no Fly configuration").toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RELAY_DRIVERS", "live");
    for (const [k, v] of Object.entries(CF)) vi.stubEnv(k, v);
    setRelayDriversForTest({ ingest: new FakeIngest(), runner: new FakeRunner() });
    expect(composedUnavailable(), "live env, but the override's runner is the one that runs").toBe(false);
    setRelayDriversForTest(null);
    expect(relayUnavailable(), "PREMISE: the relay is up without the override").toBe(false);
    expect(composedUnavailable(), "the positive pair: the same live env, the real lazy runner").toBe(true);
  });
});
