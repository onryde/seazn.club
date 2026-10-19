// The browser's Sentry.init (src/instrumentation-client.ts), owner decision 2026-10-19: browser Sentry ON, session replay OFF.
//
// Until then no browser Sentry ran: the client options sat in sentry.client.config.ts, which @sentry/nextjs bundles only under
// WEBPACK, and this app builds with Turbopack. Three claims, each proven the way it can be:
//   1. the init hands the SDK every scrub hook, each BY IDENTITY (a hook dropped, swapped or wrapped goes red) and keeps the
//      option values it always had;
//   2. it registers no replay: no integration, no sample rate, and no reference in the source that would bring @sentry/replay
//      and rrweb into the first-load chunk (scripts/check-client-sentry.ts pins that half against a real build);
//   3. the SDK really CALLS those hooks: the options are run through a real BrowserClient and the envelope that reaches the
//      transport is read, so a hook the SDK never reaches (an inert seam) would leak the token here.
// scrub-score-url-wiring.test.ts keeps proving, route by route, that the hooks scrub what the server configs scrub.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => ({ name: "Replay", options })),
  consoleLoggingIntegration: vi.fn((options: unknown) => ({ name: "ConsoleLogs", options })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
}));

const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const PAGE = `https://seazn.club/score/${TOKEN}`;
const DSN = "https://77cd7f66bdb8a600423328d6e561b6e9@o4512107033198592.ingest.de.sentry.io/4512119703208016";

type Options = Record<string, unknown>;
type Named = { name: string; processEvent?: (event: unknown, hint: unknown, client: unknown) => unknown };

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

const integrationsOf = (options: Options): Named[] => options.integrations as Named[];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the browser init's scrub hooks, by identity", () => {
  it("hands the SDK the scrubber's own functions for errors, transactions and breadcrumbs", async () => {
    const options = await initOptions();
    const { scrubSentryEvent, scrubScoreTokens } = await scrubber();
    expect(options.beforeSend, "errors").toBe(scrubSentryEvent);
    expect(options.beforeSendTransaction, "transactions and their spans").toBe(scrubSentryEvent);
    expect(options.beforeBreadcrumb, "breadcrumbs").toBe(scrubScoreTokens);
  });

  it("registers the ScrubScoreTokens event processor (the path an event that skips beforeSend takes)", async () => {
    const options = await initOptions();
    const { scrubSentryEvent, scrubScoreTokensIntegration } = await scrubber();
    const processors = integrationsOf(options).filter((i) => typeof i.processEvent === "function");
    expect(processors.map((i) => i.name)).toEqual([scrubScoreTokensIntegration().name]);
    const event = { type: "transaction" as const, transaction: `GET /score/${TOKEN}`, request: { url: PAGE } };
    expect(processors[0]!.processEvent!(structuredClone(event), {}, undefined)).toEqual(scrubSentryEvent(structuredClone(event)));
    expect(JSON.stringify(scrubSentryEvent(structuredClone(event))), "premise: scrubbing changes this event").not.toContain(TOKEN);
  });

  it("registers the console-to-logs forwarder for warn and error only", async () => {
    const options = await initOptions();
    const consoleLogs = integrationsOf(options).filter((i) => i.name === "ConsoleLogs") as (Named & { options: unknown })[];
    expect(consoleLogs).toHaveLength(1);
    expect(consoleLogs[0]!.options).toEqual({ levels: ["warn", "error"] });
    expect(integrationsOf(options).map((i) => i.name)).toEqual(["ConsoleLogs", "ScrubScoreTokens"]);
  });

  // The log hook wraps scrubScoreTokens (prod drops debug and trace first), so it is pinned by what it does.
  it("scrubs a log line, and in production drops debug and trace but keeps warn and error", async () => {
    const line = (level: string) => ({ level, message: `Failed to fetch RSC payload for ${PAGE}`, attributes: {} });
    const prod = (await initOptions({ NODE_ENV: "production" })).beforeSendLog as (l: unknown) => { message: string } | null;
    expect(typeof prod).toBe("function");
    for (const level of ["debug", "trace"]) expect(prod(line(level)), `production drops ${level}`).toBeNull();
    for (const level of ["info", "warn", "error"]) {
      const out = prod(line(level));
      expect(out, `production keeps ${level}`).not.toBeNull();
      expect(out!.message, `${level} is scrubbed`).not.toContain(TOKEN);
      expect(out!.message).toContain("[token]");
    }
    const dev = (await initOptions({ NODE_ENV: "development" })).beforeSendLog as (l: unknown) => { message: string } | null;
    const debug = dev(line("debug"));
    expect(debug, "outside production a debug line is kept").not.toBeNull();
    expect(debug!.message).not.toContain(TOKEN);
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

  it("takes its environment from NODE_ENV and samples 10% of traces in production, all of them elsewhere", async () => {
    const prod = await initOptions({ NODE_ENV: "production" });
    expect(prod.environment).toBe("production");
    expect(prod.tracesSampleRate).toBe(0.1);
    const dev = await initOptions({ NODE_ENV: "development" });
    expect(dev.environment).toBe("development");
    expect(dev.tracesSampleRate).toBe(1.0);
    expect(dev.enableLogs).toBe(true);
  });

  it("does not opt in to default PII", async () => {
    const options = await initOptions();
    expect(options.sendDefaultPii === undefined || options.sendDefaultPii === false).toBe(true);
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
    expect(integrationsOf(options).map((i) => i.name)).not.toContain("Replay");
    // Whatever name a replay would register under, no integration carries recording options.
    for (const integration of integrationsOf(options)) expect(Object.keys(integration)).not.toContain("beforeAddRecordingEvent");
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
    const loaded = ["../../instrumentation-client.ts", "../replay-guard.ts", "../scrub-score-url.ts", "../consent.ts"];
    for (const file of loaded) expect(forbidden.test(code(file)), `${file} names no replay symbol`).toBe(false);
    // The control: the pattern does see what it is looking for.
    expect(forbidden.test("import { replayIntegration } from '@sentry/nextjs'")).toBe(true);
    expect(forbidden.test("Sentry.getReplay()")).toBe(true);
    expect(loaded.length).toBe(4);
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

// ---- the real SDK ----------------------------------------------------------------------------------------------------
// The packages are loaded through the ones that depend on them, which also bypasses the @sentry/nextjs mock above.
const fromNextjs = createRequire(createRequire(import.meta.url).resolve("@sentry/nextjs"));
const fromReact = createRequire(fromNextjs.resolve("@sentry/react"));
const browser = fromReact("@sentry/browser") as {
  BrowserClient: new (options: Record<string, unknown>) => {
    init(): void;
    captureEvent(event: Record<string, unknown>): string;
    flush(timeout?: number): Promise<boolean>;
  };
  defaultStackParser: unknown;
};
const core = fromReact("@sentry/core") as {
  getCurrentScope(): { setClient(client: unknown): void };
  getIsolationScope(): { clear(): void };
  addBreadcrumb(breadcrumb: Record<string, unknown>): void;
  _INTERNAL_captureLog(log: Record<string, unknown>, scope: unknown): void;
};

type Envelope = [unknown, [{ type: string }, Record<string, unknown>][]];

/** A real BrowserClient built from the init's own options (the DSN and transport aside), and what it sent. */
async function realClient(overrides: Options = {}) {
  const options = await initOptions();
  const sent: Envelope[] = [];
  const client = new browser.BrowserClient({
    ...options,
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

  // integrations: [] takes the event processor out, so beforeSend / beforeSendTransaction / beforeBreadcrumb are each the
  // only thing that can scrub. Two guards covering for each other would each be untested.
  it("beforeSend scrubs an error event's request URL and Bearer header before the transport sees it", async () => {
    const { client, payloads } = await realClient({ integrations: [] });
    client.captureEvent({ message: "boom", request: { url: PAGE, headers: { authorization: `Bearer ${TOKEN}` } } });
    const events = await payloads("event");
    expect(events, "the error reached the transport").toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
    expect(JSON.stringify(events[0])).toContain("/score/[token]");
  });

  it("beforeSendTransaction scrubs a transaction and the URL on its spans", async () => {
    const { client, payloads } = await realClient({ integrations: [] });
    client.captureEvent({
      type: "transaction",
      transaction: `GET /score/${TOKEN}`,
      start_timestamp: 1,
      timestamp: 2,
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) } },
      spans: [{ span_id: "c".repeat(16), trace_id: "a".repeat(32), start_timestamp: 1, timestamp: 2, data: { "url.full": PAGE } }],
    });
    const transactions = await payloads("transaction");
    expect(transactions, "the transaction reached the transport").toHaveLength(1);
    expect(JSON.stringify(transactions[0])).not.toContain(TOKEN);
    expect(JSON.stringify(transactions[0])).toContain("[token]");
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

  it("the ScrubScoreTokens processor scrubs an event on its own (beforeSend and beforeSendTransaction taken out)", async () => {
    const { client, payloads } = await realClient({ beforeSend: undefined, beforeSendTransaction: undefined });
    client.captureEvent({ message: "boom", request: { url: PAGE } });
    const events = await payloads("event");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(TOKEN);
    expect(JSON.stringify(events[0])).toContain("/score/[token]");
  });

  it("beforeSendLog scrubs a structured log record before the transport sees it", async () => {
    const { payloads } = await realClient({ integrations: [] });
    core._INTERNAL_captureLog({ level: "error", message: `Failed to fetch RSC payload for ${PAGE}`, attributes: {} }, core.getCurrentScope());
    const logs = await payloads("log");
    const text = JSON.stringify(logs);
    expect(logs.length, "the log reached the transport").toBeGreaterThanOrEqual(1);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[token]");
  });

  it("control: the same events with every hook taken out DO carry the token (the assertions above see a scrub, not an absence)", async () => {
    const off = { integrations: [], beforeSend: undefined, beforeSendTransaction: undefined, beforeBreadcrumb: undefined, beforeSendLog: undefined };
    const { client, payloads } = await realClient(off);
    client.captureEvent({ message: "boom", request: { url: PAGE } });
    core._INTERNAL_captureLog({ level: "error", message: `Failed to fetch RSC payload for ${PAGE}`, attributes: {} }, core.getCurrentScope());
    expect(JSON.stringify(await payloads("event"))).toContain(TOKEN);
    expect(JSON.stringify(await payloads("log"))).toContain(TOKEN);
  });
});
