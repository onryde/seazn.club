// The browser's Sentry.init (src/instrumentation-client.ts). Owner decisions 2026-10-19: browser Sentry ON, session replay OFF,
// then ERRORS ONLY (no tracing, no logs) with the real environment (staging vs production).
//
// Until then no browser Sentry ran: the client options sat in sentry.client.config.ts, which @sentry/nextjs bundles only under
// WEBPACK, and this app builds with Turbopack. Claims, each proven the way it can be:
//   1. the init hands the SDK every scrub hook it still needs, each BY IDENTITY (a hook dropped, swapped or wrapped goes red);
//   2. it captures errors and nothing else: no tracing option of any kind, no log capture, no replay, and the SDK's own
//      default integrations for performance (BrowserTracing), session envelopes (BrowserSession) and AI chats
//      (ConversationId) are taken out of the REAL client's integration list (the real @sentry/nextjs client init is run);
//   3. the SDK really CALLS those hooks: the options are run through a real BrowserClient and the envelope that reaches the
//      transport is read, so a hook the SDK never reaches (an inert seam) would leak the token here;
//   4. the environment is the deployment's (staging vs production), read from the baked origin, not NODE_ENV.
// scrub-score-url-wiring.test.ts keeps proving, route by route, that the hooks scrub what the server configs scrub, and
// scripts/check-client-sentry.ts pins the bundle against a real build.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployConfig } from "./_deploy-config";

vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => ({ name: "Replay", options })),
  consoleLoggingIntegration: vi.fn((options: unknown) => ({ name: "ConsoleLogs", options })),
  browserTracingIntegration: vi.fn((options: unknown) => ({ name: "BrowserTracing", options })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
}));

const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const PAGE = `https://seazn.club/score/${TOKEN}`;
const DSN = "https://77cd7f66bdb8a600423328d6e561b6e9@o4512107033198592.ingest.de.sentry.io/4512119703208016";

type Options = Record<string, unknown>;
type Named = { name: string; processEvent?: (event: unknown, hint: unknown, client: unknown) => unknown };
type IntegrationsFn = (defaults: Named[]) => Named[];

/** The scrubber module the LAST fresh import of instrumentation-client was handed (resetModules gives every import its own). */
async function scrubber() {
  return import("@/lib/scrub-score-url");
}

/** The init's options from a fresh import, under the given env (module-level values are read at import). */
async function initOptions(env: Record<string, string> = {}): Promise<Options> {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  await import("../../instrumentation-client");
  const Sentry = await import("@sentry/nextjs");
  const calls = vi.mocked(Sentry.init).mock.calls;
  expect(calls, "instrumentation-client calls Sentry.init exactly once").toHaveLength(1);
  return calls[0]![0] as Options;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- the real SDK ----------------------------------------------------------------------------------------------------
// The packages are loaded through the ones that depend on them, which also bypasses the @sentry/nextjs mock above.
const requireHere = createRequire(import.meta.url);
const fromNextjs = createRequire(requireHere.resolve("@sentry/nextjs"));
const fromReact = createRequire(fromNextjs.resolve("@sentry/react"));
const browser = fromReact("@sentry/browser") as {
  BrowserClient: new (options: Record<string, unknown>) => {
    init(): void;
    captureEvent(event: Record<string, unknown>): string;
    flush(timeout?: number): Promise<boolean>;
    getOptions(): { integrations: Named[] };
  };
  defaultStackParser: unknown;
};
const core = fromReact("@sentry/core") as {
  getClient(): { getOptions(): { integrations: Named[] } } | undefined;
  getCurrentScope(): { setClient(client: unknown): void };
  getIsolationScope(): { clear(): void };
  addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  hasSpansEnabled(options: Record<string, unknown>): boolean;
  _INTERNAL_captureLog(log: Record<string, unknown>, scope: unknown): void;
};
/** @sentry/nextjs's CLIENT init (the one the browser runs), loaded by absolute path past the package's node-only exports map. */
const nextjsClient = requireHere(path.join(path.dirname(requireHere.resolve("@sentry/nextjs")), "client/index.js")) as {
  init(options: Record<string, unknown>): unknown;
};

const noSend = () => ({ send: async () => ({}), flush: async () => true });

/** The init's `integrations` function, applied to the given defaults (a function, so the SDK's own defaults stay in). */
function resolveIntegrations(options: Options, defaults: Named[] = []): Named[] {
  expect(typeof options.integrations, "the init extends the SDK's default integrations (a function), it does not replace them").toBe("function");
  return (options.integrations as IntegrationsFn)(defaults);
}

describe("the browser init's scrub hooks, by identity", () => {
  it("hands the SDK the scrubber's own functions for errors and breadcrumbs", async () => {
    const options = await initOptions();
    const { scrubSentryEvent, scrubScoreTokens } = await scrubber();
    expect(options.beforeSend, "errors").toBe(scrubSentryEvent);
    expect(options.beforeBreadcrumb, "breadcrumbs").toBe(scrubScoreTokens);
  });

  it("registers the ScrubScoreTokens event processor (the path an event that skips beforeSend takes)", async () => {
    const options = await initOptions();
    const { scrubSentryEvent, scrubScoreTokensIntegration } = await scrubber();
    const processors = resolveIntegrations(options).filter((i) => typeof i.processEvent === "function");
    expect(processors.map((i) => i.name)).toEqual([scrubScoreTokensIntegration().name]);
    const event = { type: "transaction" as const, transaction: `GET /score/${TOKEN}`, request: { url: PAGE } };
    expect(processors[0]!.processEvent!(structuredClone(event), {}, undefined)).toEqual(scrubSentryEvent(structuredClone(event)));
    expect(JSON.stringify(scrubSentryEvent(structuredClone(event))), "premise: scrubbing changes this event").not.toContain(TOKEN);
  });
});

describe("the browser init captures errors and nothing else", () => {
  it("sets no tracing option of any kind, and the SDK itself judges tracing off", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "development" }]) {
      const options = await initOptions(env);
      expect(Object.keys(options).filter((k) => /trac|profil|span|sentry-trace|propagat/i.test(k)), JSON.stringify(env)).toEqual([]);
      expect(core.hasSpansEnabled({ ...options }), "the SDK's own verdict on these options").toBe(false);
    }
    // The control: the SDK's verdict does flip when a sample rate is present, so the false above is a finding.
    expect(core.hasSpansEnabled({ tracesSampleRate: 0.1 })).toBe(true);
  });

  it("enables no log capture: no enableLogs, no log hook, no console-to-logs forwarder", async () => {
    const options = await initOptions();
    const Sentry = await import("@sentry/nextjs");
    expect(options.enableLogs === undefined || options.enableLogs === false).toBe(true);
    expect(Object.hasOwn(options, "beforeSendLog")).toBe(false);
    expect(vi.mocked(Sentry.consoleLoggingIntegration)).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.browserTracingIntegration)).not.toHaveBeenCalled();
    expect(resolveIntegrations(options).map((i) => i.name)).not.toContain("ConsoleLogs");
  });

  it("sets exactly these options (a new one is a decision, not an accident)", async () => {
    const options = await initOptions({ NEXT_PUBLIC_SENTRY_DSN: DSN });
    expect(Object.keys(options).sort()).toEqual(["beforeBreadcrumb", "beforeSend", "dsn", "enabled", "environment", "integrations"]);
  });

  it("does not opt in to default PII", async () => {
    const options = await initOptions();
    expect(options.sendDefaultPii === undefined || options.sendDefaultPii === false).toBe(true);
  });

  // The REAL @sentry/nextjs client init, as the browser runs it, with the init's own options: this is where the SDK's defaults
  // (BrowserTracing among them, added by the nextjs wrapper) meet the init's `integrations` function.
  it("takes the performance, session and AI-chat default integrations out of the real client, and keeps what captures an error", async () => {
    const options = await initOptions({ NEXT_PUBLIC_SENTRY_DSN: DSN });
    let defaults: string[] = [];
    nextjsClient.init({
      ...options,
      enabled: true,
      transport: noSend,
      integrations: (d: Named[]) => {
        defaults = d.map((i) => i.name);
        return resolveIntegrations(options, d);
      },
    });
    const live = core.getClient()!.getOptions().integrations.map((i) => i.name);
    const dropped = ["BrowserTracing", "BrowserSession", "ConversationId"];
    for (const name of dropped) expect(defaults, `premise: the SDK adds ${name} by default`).toContain(name);
    for (const name of dropped) expect(live, `${name} is gone from the live client`).not.toContain(name);
    for (const name of ["ConsoleLogs", "Replay"]) expect(live).not.toContain(name);
    const keeps = [
      "GlobalHandlers", // window.onerror / unhandledrejection: the errors themselves
      "BrowserApiErrors",
      "LinkedErrors",
      "Breadcrumbs", // recent in-app activity, kept on purpose
      "Dedupe",
      "InboundFilters",
      "FunctionToString",
      "HttpContext", // page address, user agent
      "NextjsClientStackFrameNormalization", // frames that match the uploaded source maps
      "ScrubScoreTokens",
    ];
    for (const name of keeps) expect(live, `${name} is kept`).toContain(name);
    // Nothing the SDK adds by default is lost except the three named: the rest of the default list survives untouched.
    expect(defaults.filter((n) => !dropped.includes(n)).every((n) => live.includes(n))).toBe(true);
    expect(live.length, "anti-vacuity: the live client has integrations").toBeGreaterThan(keeps.length - 1);
  });
});

describe("the browser init's values", () => {
  it("reads the DSN from NEXT_PUBLIC_SENTRY_DSN and is enabled exactly when there is one", async () => {
    const withDsn = await initOptions({ NEXT_PUBLIC_SENTRY_DSN: DSN });
    expect(withDsn.dsn).toBe(DSN);
    expect(withDsn.enabled).toBe(true);
    const without = await initOptions({ NEXT_PUBLIC_SENTRY_DSN: "" });
    expect(without.dsn === undefined || without.dsn === "").toBe(true);
    expect(without.enabled, "no DSN, nothing is sent").toBe(false);
  });

  // The expected environments come from the deploy configs' own declarations (app name), and NODE_ENV is deliberately set to
  // something else so it cannot be the source.
  it("reports the deployment's environment, read from the baked origin: staging is staging, production is production", async () => {
    const prod = deployConfig("fly.toml");
    const stg = deployConfig("fly.stg.toml");
    expect(prod.environment).not.toBe(stg.environment);
    expect((await initOptions({ NEXT_PUBLIC_BASE_URL: stg.baseUrl, NODE_ENV: "development" })).environment).toBe(stg.environment);
    expect((await initOptions({ NEXT_PUBLIC_BASE_URL: prod.baseUrl, NODE_ENV: "development" })).environment).toBe(prod.environment);
    // The deployed image has NODE_ENV=production on both; the origin still tells them apart.
    expect((await initOptions({ NEXT_PUBLIC_BASE_URL: stg.baseUrl, NODE_ENV: "production" })).environment).toBe("staging");
  });

  it("falls back to NODE_ENV when the origin is no known deployment (local, CI)", async () => {
    expect((await initOptions({ NEXT_PUBLIC_BASE_URL: "", NODE_ENV: "production" })).environment).toBe("production");
    expect((await initOptions({ NEXT_PUBLIC_BASE_URL: "http://localhost:3343", NODE_ENV: "development" })).environment).toBe("development");
  });

  it("swallows a failed init rather than break the app (analytics and error reporting never do)", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const Sentry = await import("@sentry/nextjs");
    vi.mocked(Sentry.init).mockImplementationOnce(() => {
      throw new Error("init failed");
    });
    await expect(import("../../instrumentation-client")).resolves.toBeDefined();
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1);
  });
});

describe("session replay is OFF", () => {
  it("registers no Replay integration and builds none", async () => {
    const options = await initOptions();
    const Sentry = await import("@sentry/nextjs");
    expect(vi.mocked(Sentry.replayIntegration)).not.toHaveBeenCalled();
    const integrations = resolveIntegrations(options);
    expect(integrations.map((i) => i.name)).not.toContain("Replay");
    // Whatever name a replay would register under, no integration carries recording options.
    for (const integration of integrations) expect(Object.keys(integration)).not.toContain("beforeAddRecordingEvent");
  });

  it("sets no replay sample rate, nor any option about replays", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "development" }]) {
      const options = await initOptions(env);
      expect(Object.hasOwn(options, "replaysSessionSampleRate")).toBe(false);
      expect(Object.hasOwn(options, "replaysOnErrorSampleRate")).toBe(false);
      expect(Object.keys(options).filter((k) => /replay/i.test(k))).toEqual([]);
    }
  });

  it("keeps the replay out of the source that every page loads (a reference is a first-load cost of ~23 KB gzipped)", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const code = (file: string) =>
      readFileSync(path.join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const forbidden = /replayIntegration|getReplay|replaysSessionSampleRate|replaysOnErrorSampleRate|@sentry\/replay|@sentry-internal\/replay|rrweb|replayCanvasIntegration/;
    const loaded = ["../../instrumentation-client.ts", "../replay-guard.ts", "../scrub-score-url.ts", "../consent.ts", "../sentry-environment.ts"];
    for (const file of loaded) expect(forbidden.test(code(file)), `${file} names no replay symbol`).toBe(false);
    // The control: the pattern does see what it is looking for.
    expect(forbidden.test("import { replayIntegration } from '@sentry/nextjs'")).toBe(true);
    expect(forbidden.test("Sentry.getReplay()")).toBe(true);
    expect(loaded.length).toBe(5);
  });

  it("the Webpack-only config file is gone, so a Webpack build cannot init Sentry a second time", () => {
    const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    for (const f of ["sentry.client.config.ts", "sentry.client.config.js"]) {
      expect(() => readFileSync(path.join(webRoot, f)), f).toThrow(/ENOENT/);
    }
    // The control: the server and edge configs, which instrumentation.ts does load, are still there.
    expect(readFileSync(path.join(webRoot, "sentry.server.config.ts"), "utf8")).toContain("Sentry.init");
  });
});

type Envelope = [unknown, [{ type: string }, Record<string, unknown>][]];

/** A real BrowserClient built from the init's own options (the DSN and transport aside), and what it sent. */
async function realClient(overrides: Options = {}) {
  const options = await initOptions();
  const sent: Envelope[] = [];
  const client = new browser.BrowserClient({
    ...options,
    // BrowserClient wants the resolved list; with no defaults the init's function yields just its own additions.
    integrations: resolveIntegrations(options),
    dsn: DSN,
    enabled: true,
    stackParser: browser.defaultStackParser,
    transport: () => ({
      send: async (envelope: Envelope) => {
        sent.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
    ...overrides,
  });
  core.getCurrentScope().setClient(client);
  client.init();
  const payloads = async (type: string): Promise<Record<string, unknown>[]> => {
    await client.flush(100);
    return sent.flatMap(([, items]) => items.filter(([header]) => header.type === type).map(([, payload]) => payload));
  };
  return { client, options, payloads };
}

describe("the SDK really calls the hooks (a real BrowserClient built from the init's options)", () => {
  afterEach(() => {
    core.getCurrentScope().setClient(undefined);
    core.getIsolationScope().clear();
  });

  // integrations: [] takes the event processor out, so beforeSend / beforeBreadcrumb are each the only thing that can
  // scrub. Two guards covering for each other would each be untested.
  it("beforeSend scrubs an error event's request URL and Bearer header before the transport sees it", async () => {
    const { client, payloads } = await realClient({ integrations: [] });
    client.captureEvent({ message: "boom", request: { url: PAGE, headers: { authorization: `Bearer ${TOKEN}` } } });
    const events = await payloads("event");
    expect(events, "the error reached the transport").toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
    expect(JSON.stringify(events[0])).toContain("/score/[token]");
  });

  it("beforeBreadcrumb scrubs a navigation breadcrumb that rides on the next error", async () => {
    const { client, payloads } = await realClient({ integrations: [], beforeSend: undefined });
    core.addBreadcrumb({ category: "navigation", data: { from: "/", to: `/score/${TOKEN}` } });
    client.captureEvent({ message: "boom" });
    const events = await payloads("event");
    expect(events).toHaveLength(1);
    const crumbs = (events[0]!.breadcrumbs as { category?: string }[]).filter((b) => b.category === "navigation");
    expect(crumbs, "the breadcrumb was kept").toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
  });

  it("the ScrubScoreTokens processor scrubs an event on its own (beforeSend taken out)", async () => {
    const { client, payloads } = await realClient({ beforeSend: undefined });
    client.captureEvent({ message: "boom", request: { url: PAGE } });
    const events = await payloads("event");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
    expect(JSON.stringify(events[0])).toContain("/score/[token]");
  });

  it("no log leaves the browser: a structured log record is dropped by the client, while the same record is sent once log capture is on", async () => {
    const log = { level: "error", message: `Failed to fetch RSC payload for ${PAGE}`, attributes: {} };
    const off = await realClient();
    core._INTERNAL_captureLog(log, core.getCurrentScope());
    expect(await off.payloads("log"), "enableLogs is not set, so nothing is sent").toEqual([]);
    core.getCurrentScope().setClient(undefined);
    // The control: with log capture switched on, the same record does reach the transport, so the empty list above is a finding.
    const on = await realClient({ enableLogs: true });
    core._INTERNAL_captureLog(log, core.getCurrentScope());
    expect((await on.payloads("log")).length, "control: the log is sent when log capture is on").toBeGreaterThanOrEqual(1);
  });

  it("control: the same events with every hook taken out DO carry the token (the assertions above see a scrub, not an absence)", async () => {
    const off = { integrations: [], beforeSend: undefined, beforeBreadcrumb: undefined };
    const { client, payloads } = await realClient(off);
    client.captureEvent({ message: "boom", request: { url: PAGE } });
    expect(JSON.stringify(await payloads("event"))).toContain(TOKEN);
  });
});
