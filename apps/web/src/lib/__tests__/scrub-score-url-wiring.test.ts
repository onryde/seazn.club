// Final review I2, the wiring half. scrub-score-url.test.ts proves the helpers;
// this file proves each REAL config hands them to its SDK. Each config module is
// imported for real with the SDK mocked, and the options it passed to
// `init` are run on an event that carries a device-link token. A helper nothing
// passes to an SDK would be an inert seam, and every test here would then be red.
//
// NOTE: sentry.client.config.ts is only picked up by @sentry/nextjs's WEBPACK
// integration (config/webpack.js `getClientSentryConfigFile`). This app builds
// with Turbopack, and the prod client bundle carries none of that file's options,
// so client-side Sentry is not initialised today. That gap predates this change
// and is outside it. The client test below pins the file's wiring so the scrub
// is already in place on the day client Sentry is initialised.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => ({ name: "Replay", options })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
  pinoIntegration: vi.fn(() => ({ name: "Pino" })),
  captureRouterTransitionStart: vi.fn(),
}));

const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const PAGE = `https://seazn.club/score/${TOKEN}`;

type Options = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;
const run = (fn: unknown, ...args: unknown[]): unknown => {
  expect(typeof fn, "the option is a function").toBe("function");
  return (fn as Fn)(...args);
};

function expectScrubbed(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TOKEN);
  expect(text).toContain("[token]");
}

async function sentryInitOptions(configPath: string): Promise<Options> {
  await import(configPath);
  const Sentry = await import("@sentry/nextjs");
  const calls = vi.mocked(Sentry.init).mock.calls;
  expect(calls, `${configPath} calls Sentry.init once`).toHaveLength(1);
  return calls[0]![0] as Options;
}

const errorEvent = () => ({
  event_id: "e1",
  request: { url: PAGE, headers: { authorization: `Bearer ${TOKEN}` } },
  breadcrumbs: [{ category: "navigation", data: { from: "/", to: `/score/${TOKEN}` } }],
});
const transactionEvent = () => ({
  type: "transaction",
  transaction: `GET /score/${TOKEN}`,
  spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": PAGE } }],
});
// Fly's check, as prod records it: the proxy's transaction with /api/health in request.url.
const healthCheckTransaction = () => ({
  type: "transaction",
  transaction: "GET middleware GET",
  request: { method: "GET", url: "http://172.19.29.122:3000/api/health" },
});
const healthCheckError = () => ({
  event_id: "e2",
  exception: { values: [{ type: "Error", value: "db down" }] },
  request: { method: "GET", url: "http://172.19.29.122:3000/api/health" },
});
const logRecord = () => ({ level: "error", message: `Failed to fetch RSC payload for ${PAGE}`, attributes: {} });

beforeEach(() => {
  // A fresh import of each config per test. The mocked SDK functions survive
  // resetModules, so their recorded calls are cleared as well.
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PostHog (src/instrumentation-client.ts)", () => {
  it("sends events to the same-origin /ingest rewrite unless a proxy host is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "");
    vi.stubGlobal("document", { cookie: "" });
    await import("../../instrumentation-client");
    const posthog = (await import("posthog-js")).default;
    expect((vi.mocked(posthog.init).mock.calls[0]![1] as Options).api_host).toBe("/ingest");
  });

  it("sends events to NEXT_PUBLIC_POSTHOG_API_HOST when set (prod's managed proxy)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "https://g.example.test");
    vi.stubGlobal("document", { cookie: "" });
    await import("../../instrumentation-client");
    const posthog = (await import("posthog-js")).default;
    expect((vi.mocked(posthog.init).mock.calls[0]![1] as Options).api_host).toBe("https://g.example.test");
  });

  it("passes a before_send that scrubs a pageview, and keeps the options it already had", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import("../../instrumentation-client");
    const posthog = (await import("posthog-js")).default;
    const calls = vi.mocked(posthog.init).mock.calls;
    expect(calls).toHaveLength(1);
    const options = calls[0]![1] as Options;
    expect(options.api_host).toBe("/ingest");
    expect(options.opt_out_capturing_by_default).toBe(true);

    const pageview = {
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: PAGE, $pathname: `/score/${TOKEN}`, $referrer: PAGE },
      $set_once: { $initial_current_url: PAGE },
    };
    let out: unknown = pageview;
    for (const fn of [options.before_send].flat()) out = run(fn, out);
    expectScrubbed(out);

    // Fix batch 7: the same before_send drops a staff page's events.
    const staff = { uuid: "u2", event: "$pageview", properties: { $pathname: "/admin/orgs/x" } };
    let dropped: unknown = staff;
    for (const fn of [options.before_send].flat()) dropped = dropped === null ? null : run(fn, dropped);
    expect(dropped).toBeNull();
  });
});

describe("Sentry server (sentry.server.config.ts, loaded by instrumentation.ts on nodejs)", () => {
  it("scrubs errors (request URL, Bearer header), transactions and logs", async () => {
    const options = await sentryInitOptions("../../../sentry.server.config");
    expectScrubbed(run(options.beforeSend, errorEvent(), {}));
    expectScrubbed(run(options.beforeSendTransaction, transactionEvent(), {}));
    expectScrubbed(run(options.beforeSendLog, logRecord()));
    const Sentry = await import("@sentry/nextjs");
    expect(vi.mocked(Sentry.pinoIntegration)).toHaveBeenCalledTimes(1);
  });

  it("drops Fly's health-check transactions but still sends an error from that route", async () => {
    const options = await sentryInitOptions("../../../sentry.server.config");
    expect(run(options.beforeSendTransaction, healthCheckTransaction(), {})).toBeNull();
    expect(run(options.beforeSend, healthCheckError(), {})).not.toBeNull();
  });
});

describe("Sentry edge (sentry.edge.config.ts, loaded by instrumentation.ts on edge)", () => {
  it("scrubs errors, transactions and logs", async () => {
    const options = await sentryInitOptions("../../../sentry.edge.config");
    expectScrubbed(run(options.beforeSend, errorEvent(), {}));
    expectScrubbed(run(options.beforeSendTransaction, transactionEvent(), {}));
    expectScrubbed(run(options.beforeSendLog, logRecord()));
  });

  it("drops Fly's health-check transactions but still sends an error from that route", async () => {
    const options = await sentryInitOptions("../../../sentry.edge.config");
    expect(run(options.beforeSendTransaction, healthCheckTransaction(), {})).toBeNull();
    expect(run(options.beforeSend, healthCheckError(), {})).not.toBeNull();
  });
});

describe("Sentry client (sentry.client.config.ts; not loaded by the Turbopack build today, see NOTE)", () => {
  it("scrubs errors, transactions, breadcrumbs and logs", async () => {
    const options = await sentryInitOptions("../../../sentry.client.config");
    expectScrubbed(run(options.beforeSend, errorEvent(), {}));
    expectScrubbed(run(options.beforeSendTransaction, transactionEvent(), {}));
    expectScrubbed(run(options.beforeBreadcrumb, { category: "navigation", data: { to: `/score/${TOKEN}` } }, {}));
    expectScrubbed(run(options.beforeSendLog, logRecord()));
  });

  it("registers an event processor that scrubs a replay_event's URL list (beforeSend never sees one)", async () => {
    const options = await sentryInitOptions("../../../sentry.client.config");
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubbers = integrations.filter((i) => typeof i.processEvent === "function");
    expect(scrubbers.map((i) => i.name)).toEqual(["ScrubScoreTokens"]);
    const out = run(scrubbers[0]!.processEvent, { type: "replay_event", urls: [PAGE] }, {}, {});
    expect(out).toEqual({ type: "replay_event", urls: ["https://seazn.club/score/[token]"] });
  });

  it("gives Replay a beforeAddRecordingEvent scrub, and keeps its masking options", async () => {
    await sentryInitOptions("../../../sentry.client.config");
    const Sentry = await import("@sentry/nextjs");
    const replayOptions = vi.mocked(Sentry.replayIntegration).mock.calls[0]![0] as Options;
    expect(replayOptions.maskAllText).toBe(true);
    expect(replayOptions.blockAllMedia).toBe(true);
    const frame = { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: PAGE } } };
    expectScrubbed(run(replayOptions.beforeAddRecordingEvent, frame));
  });
});
