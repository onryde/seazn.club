// The browser Sentry client against the REAL SDK (review of feat/browser-sentry-init, 2026-11-23: I1, m1, m2, m4, m5). The
// mocked suite (sentry-browser-init.test.ts) proves what the code HANDS the SDK; this file proves what the installed
// @sentry/nextjs 10.62 client DOES with it, because a mock cannot see the SDK's defaults, its sampler or its transport:
//  - the EFFECTIVE integration set after init (the nextjs client's own defaults, minus BrowserTracing and BrowserSession);
//  - tracing OFF in @sentry/core's own terms, so even an inherited, sampled server trace makes no transaction;
//  - no `sentry-trace` / `baggage` header on a fetch from the page, so the server keeps its own sampling decision;
//  - the consent gate held at the real client's transport;
//  - a withdrawal clears the breadcrumbs, and none are collected while it lasts.
//
// Only the network is a stand-in: `fetch` records what it is handed. The facade (lib/sentry-browser.ts), the lazy module
// (lib/sentry-browser-sdk.ts), lib/consent, the scrubbers and the banner's recordConsentChoice run for real, over the
// @sentry/nextjs CLIENT entry (in node, vitest would resolve the package to its server entry). The SDK keeps one client per
// process, so it is loaded once, in beforeAll, and the tests run in order; the last one changes the client on purpose.
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CONSENT_KEY } from "@/lib/consent";
import { TEST_DSN, stubConsent } from "./_browser-sentry";

vi.mock("@sentry/nextjs", async () => {
  const { createRequire: requireFrom } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const fromNextjs = requireFrom(requireFrom(import.meta.url).resolve("@sentry/nextjs"));
  return fromNextjs(join(dirname(fromNextjs.resolve("@sentry/nextjs")), "index.client.js"));
});
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));

// The installed SDK's own packages, the same instances the client entry runs on.
const fromNextjs = createRequire(createRequire(import.meta.url).resolve("@sentry/nextjs"));
const fromReact = createRequire(fromNextjs.resolve("@sentry/react"));
const core = fromReact("@sentry/core") as {
  hasSpansEnabled(options: unknown): boolean;
  sampleSpan(options: unknown, context: Record<string, unknown>, sampleRand: number): [boolean, ...unknown[]];
  continueTrace<T>(trace: { sentryTrace: string; baggage: string }, callback: () => T): T;
  startSpan<T>(options: Record<string, unknown>, callback: (span: { isRecording(): boolean }) => T): T;
};
const browser = fromReact("@sentry/browser") as { browserTracingIntegration(options: Record<string, unknown>): unknown };

type Named = { name: string };
type RealClient = {
  getOptions(): { defaultIntegrations: Named[]; integrations: Named[]; tracePropagationTargets?: unknown[] } & Record<string, unknown>;
  getIntegrationByName(name: string): unknown;
  addIntegration(integration: unknown): void;
  flush(timeout?: number): PromiseLike<boolean>;
};
type Call = { url: string; headers: Record<string, string>; body: string };

const calls: Call[] = [];
const decode = (body: unknown) => (body == null ? "" : typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
/** What reached the network: every envelope POSTed to the DSN's ingest host. */
const envelopes = () => calls.filter((c) => c.url.includes("ingest.sentry.io/api/"));
/** The item types of every envelope sent (`event`, `transaction`, `session`, `log`, ...), from the item headers. */
const sentTypes = () =>
  envelopes().flatMap((c) =>
    c.body.split("\n").flatMap((line) => {
      try {
        const item = JSON.parse(line) as { type?: unknown; event_id?: unknown };
        return typeof item.type === "string" && !("event_id" in item) ? [item.type] : [];
      } catch {
        return [];
      }
    }),
  );

let store: Map<string, string>;
let client: RealClient;
let facade: typeof import("@/lib/sentry-browser");

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
  store = stubConsent("accepted");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { headers?: HeadersInit; body?: unknown }) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: decode(init?.body) });
      return new Response("{}", { status: 200 });
    }),
  );
  facade = await import("@/lib/sentry-browser");
  expect(await facade.loadBrowserSentry(), "the real SDK loaded and initialised").toBe(true);
  client = facade.sentryClient() as unknown as RealClient;
  expect(client, "the facade holds the real client").toBeDefined();
});

describe("the browser client on the REAL @sentry/nextjs 10.62 client", () => {
  it("installs the SDK's own defaults minus BrowserTracing and BrowserSession, plus ConsoleLogs and ScrubScoreTokens (the EFFECTIVE set)", () => {
    const defaults = client.getOptions().defaultIntegrations.map((i) => i.name);
    for (const dropped of ["BrowserTracing", "BrowserSession"]) {
      expect(defaults, `premise: the nextjs client's own defaults include ${dropped}, so dropping it is not vacuous`).toContain(dropped);
    }
    const installed = client.getOptions().integrations.map((i) => i.name);
    expect(installed.length, "anti-vacuity: integrations installed").toBeGreaterThan(5);
    expect(installed).toEqual([...defaults.filter((n) => n !== "BrowserTracing" && n !== "BrowserSession"), "ConsoleLogs", "ScrubScoreTokens"]);
    // What the client actually holds, after every integration's setup ran (BrowserTracing would add WebVitals here).
    for (const absent of ["BrowserTracing", "BrowserSession", "WebVitals", "Replay", "ReplayCanvas"]) {
      expect(client.getIntegrationByName(absent), `${absent} is not installed`).toBeUndefined();
    }
    for (const present of installed) expect(client.getIntegrationByName(present), `${present} is installed`).toBeDefined();
  });

  it("tracing is OFF in @sentry/core's own terms: even an inherited, sampled server trace makes no transaction, and none is sent", async () => {
    const options = client.getOptions();
    const inherited = { name: "/dashboard", attributes: {}, parentSampled: true };
    expect(core.hasSpansEnabled(options), "hasSpansEnabled").toBe(false);
    expect(core.sampleSpan(options, inherited, 0.5)[0], "a sampled parent is not inherited").toBe(false);
    // The positive pair: the same sampler with a 0 rate (this branch's first cut) DOES inherit the server's decision.
    expect(core.sampleSpan({ ...options, tracesSampleRate: 0 }, inherited, 0.5)[0], "premise: a 0 rate is not off").toBe(true);
    const sampledServerTrace = { sentryTrace: `${"a".repeat(32)}-${"b".repeat(16)}-1`, baggage: "sentry-sampled=true,sentry-sample_rate=1" };
    const recording = core.continueTrace(sampledServerTrace, () =>
      core.startSpan({ name: "/dashboard", op: "pageload", forceTransaction: true }, (span) => span.isRecording()),
    );
    expect(recording, "the pageload span under a sampled server trace records nothing").toBe(false);

    calls.length = 0;
    facade.captureException(new Error("the witness"));
    await client.flush(2000);
    expect(sentTypes(), "the witness: an error envelope is seen, so the absence below is not a blind spot").toContain("event");
    expect(sentTypes(), "no transaction is ever sent").not.toContain("transaction");
    expect(sentTypes(), "no release-health session is sent").not.toContain("session");
  });

  it("a fetch from the page carries no sentry-trace or baggage header, so the server keeps its own sampling decision", async () => {
    calls.length = 0;
    await fetch("/api/probe", { headers: { accept: "application/json" } });
    const probe = calls.find((c) => c.url === "/api/probe");
    expect(probe?.headers.accept, "the recorder sees the request's headers").toBe("application/json");
    expect(Object.keys(probe!.headers)).not.toContain("sentry-trace");
    expect(Object.keys(probe!.headers)).not.toContain("baggage");
  });

  it("the consent gate holds at the real client's transport: nothing leaves while withdrawn, exactly one envelope once accepted", async () => {
    calls.length = 0;
    store.set(CONSENT_KEY, "rejected");
    facade.captureException(new Error("raised while withdrawn"));
    await client.flush(2000);
    expect(envelopes(), "withdrawn: no envelope reaches the network").toEqual([]);
    store.set(CONSENT_KEY, "accepted");
    facade.captureException(new Error("raised once accepted"));
    await client.flush(2000);
    const sent = envelopes();
    expect(sent, "accepted: one envelope").toHaveLength(1);
    expect(sent[0]!.body).toContain("raised once accepted");
    expect(sent[0]!.body, "the held-back event is not sent later").not.toContain("raised while withdrawn");
  });

  it("a withdrawal clears the breadcrumbs and none are collected while it lasts, so the first error after a re-accept carries neither", async () => {
    const { recordConsentChoice } = await import("@/components/cookie-consent");
    calls.length = 0;
    facade.addBreadcrumb({ category: "probe", message: "crumb collected before the withdrawal" });
    recordConsentChoice("rejected");
    facade.addBreadcrumb({ category: "probe", message: "crumb made while withdrawn" });
    await fetch("/api/fetched-while-withdrawn");
    recordConsentChoice("accepted");
    facade.addBreadcrumb({ category: "probe", message: "crumb made after the re-accept" });
    facade.captureException(new Error("the first error after the re-accept"));
    await client.flush(2000);
    const event = envelopes().find((c) => c.body.includes("the first error after the re-accept"));
    expect(event, "the error was sent").toBeDefined();
    expect(event!.body, "breadcrumbs do ride an error (the positive pair)").toContain("crumb made after the re-accept");
    expect(event!.body).not.toContain("crumb collected before the withdrawal");
    expect(event!.body).not.toContain("crumb made while withdrawn");
    expect(event!.body).not.toContain("/api/fetched-while-withdrawn");
  });

  it("a warning logged while consent is withdrawn is dropped at capture, so a re-accept inside the log buffer's 5 s sends nothing of it", async () => {
    calls.length = 0;
    console.warn("probe: a warning while accepted");
    store.set(CONSENT_KEY, "rejected");
    console.warn("probe: a warning while withdrawn");
    store.set(CONSENT_KEY, "accepted");
    await client.flush(2000);
    const bodies = envelopes().map((c) => c.body).join("\n");
    expect(sentTypes(), "the witness: a log envelope is sent").toContain("log");
    expect(bodies, "the warning logged under consent is sent (the positive pair)").toContain("probe: a warning while accepted");
    expect(bodies, "the warning logged while withdrawn is not").not.toContain("probe: a warning while withdrawn");
  });

  // LAST: it adds a tracing integration to the shared client.
  it("the header probe can see a trace header: tracePropagationTargets [] blocks it even with a tracing integration, and a target lets it through", async () => {
    client.addIntegration(browser.browserTracingIntegration({ instrumentPageLoad: false, instrumentNavigation: false }));
    expect(client.getIntegrationByName("BrowserTracing"), "premise: a tracing integration is now installed").toBeDefined();
    calls.length = 0;
    await fetch("/api/with-tracing-and-no-targets");
    expect(Object.keys(calls.find((c) => c.url === "/api/with-tracing-and-no-targets")!.headers), "targets [] alone blocks the header").not.toContain("sentry-trace");
    const targets = client.getOptions().tracePropagationTargets;
    expect(targets, "the client's own option").toEqual([]);
    targets!.push(/^\//);
    await fetch("/api/with-a-target");
    expect(calls.find((c) => c.url === "/api/with-a-target")!.headers["sentry-trace"], "the positive pair: the probe sees a header when one is attached").toMatch(
      /^[0-9a-f]{32}-[0-9a-f]{16}/,
    );
  });
});
