// Final review I2, the wiring half. scrub-score-url.test.ts proves the helpers;
// this file proves each REAL config hands them to its SDK. Each config module is
// imported for real with the SDK mocked, and the options it passed to
// `init` are run on an event that carries a device-link token. A helper nothing
// passes to an SDK would be an inert seam, and every test here would then be red.
//
// NOTE: the client's Sentry.init lives in src/instrumentation-client.ts, the one client file the Turbopack build loads.
// (A sentry.client.config.ts is only picked up by @sentry/nextjs's WEBPACK integration, config/webpack.js
// `getClientSentryConfigFile`; this app never bundled it, so until the init moved to instrumentation-client no browser
// Sentry ran at all.) Session replay is OFF (owner decision 2026-10-19): the client tests below prove that the init hands
// every scrub hook to the SDK AND registers no replay; the replay guard's own behaviour is sentry-replay-guard.test.ts.
// What the whole option set is, hook by hook and by identity, is sentry-client-init.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { routes } from "@/lib/routes";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import { generateRefCode } from "@/lib/ref-code";
import { USER_ID } from "./_fake-sql";
import { clientSpanDetails, otelTraceData, outgoingBreadcrumb, serverSpanDetails, transaction } from "./_sdk-span-data";
import { credentialPages, setReplay } from "./_replay-fixtures";

// Only the Postgres round trip is a stand-in: the real minters (`createLoginLink`, `createVerificationToken`) run on it.
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));
vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn((options: unknown) => ({ name: "Replay", options })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
  pinoIntegration: vi.fn(() => ({ name: "Pino" })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
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

/** The client's Sentry.init: src/instrumentation-client.ts (relative to this directory). */
const CLIENT_INIT = "../../instrumentation-client";

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
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    expect((vi.mocked(posthog.init).mock.calls[0]![1] as Options).api_host).toBe("/ingest");
  });

  it("sends events to NEXT_PUBLIC_POSTHOG_API_HOST when set (prod's managed proxy)", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_API_HOST", "https://g.example.test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    expect((vi.mocked(posthog.init).mock.calls[0]![1] as Options).api_host).toBe("https://g.example.test");
  });

  it("passes a before_send that scrubs a pageview, and keeps the options it already had", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
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

  // A18 (capture QR v2 §10.2), through the REAL beforeSend the server config hands the SDK.
  it("a capture route's error event loses its code, its Bearer and its body; a non-capture route keeps URL and body (the positive pair)", async () => {
    const options = await sentryInitOptions("../../../sentry.server.config");
    const CODE = "k3m9p2q7r4t8";
    const TOK = "Zm9vYmFyYmF6cXV4cXV1eA";
    const capture = {
      event_id: "c1",
      request: {
        method: "POST",
        url: `https://seazn.club/api/v1/capture/codes/${CODE}/beats`,
        headers: { authorization: `Bearer ${TOK}` },
        data: JSON.stringify({ code: CODE, phone: "phone-x-0123456789" }),
      },
    };
    const out = run(options.beforeSend, capture, {}) as { request: { url: string; headers: Record<string, string>; data?: unknown } };
    expect(JSON.stringify(out)).not.toContain(CODE);
    expect(JSON.stringify(out)).not.toContain(TOK);
    expect(out.request.url).toBe("https://seazn.club/api/v1/capture/codes/[code]/beats");
    expect(out.request.headers.authorization).toBe("Bearer [tok]");
    expect(Object.hasOwn(out.request, "data")).toBe(false);
    const other = {
      event_id: "o1",
      request: { method: "POST", url: "https://seazn.club/api/v1/fixtures/f1/stream-sessions", data: JSON.stringify({ targetId: "t1" }) },
    };
    expect(run(options.beforeSend, structuredClone(other), {})).toEqual(other);
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

describe("Sentry client (src/instrumentation-client.ts)", () => {
  it("scrubs errors, transactions, breadcrumbs and logs", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    expectScrubbed(run(options.beforeSend, errorEvent(), {}));
    expectScrubbed(run(options.beforeSendTransaction, transactionEvent(), {}));
    expectScrubbed(run(options.beforeBreadcrumb, { category: "navigation", data: { to: `/score/${TOKEN}` } }, {}));
    expectScrubbed(run(options.beforeSendLog, logRecord()));
  });

  it("registers an event processor that scrubs a replay_event's URL list (beforeSend never sees one)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubbers = integrations.filter((i) => typeof i.processEvent === "function");
    expect(scrubbers.map((i) => i.name)).toEqual(["ScrubScoreTokens"]);
    const out = run(scrubbers[0]!.processEvent, { type: "replay_event", urls: [PAGE] }, {}, {});
    expect(out).toEqual({ type: "replay_event", urls: ["https://seazn.club/score/[token]"] });
  });

  // Session replay is OFF (owner decision 2026-10-19). A replay would also bring rrweb into every page's first-load chunk
  // (scripts/check-client-sentry.ts pins that half against a real build).
  it("registers no Replay integration and sets no replay sample rate", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const Sentry = await import("@sentry/nextjs");
    expect(vi.mocked(Sentry.replayIntegration), "replayIntegration is never called").not.toHaveBeenCalled();
    expect((options.integrations as { name: string }[]).map((i) => i.name)).not.toContain("Replay");
    expect(Object.hasOwn(options, "replaysSessionSampleRate")).toBe(false);
    expect(Object.hasOwn(options, "replaysOnErrorSampleRate")).toBe(false);
  });

  it("sets exactly this option set (a new option is a decision, so it is a red here first)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    expect(Object.keys(options).sort()).toEqual([
      "beforeBreadcrumb",
      "beforeSend",
      "beforeSendLog",
      "beforeSendTransaction",
      "dsn",
      "enableLogs",
      "enabled",
      "environment",
      "integrations",
      "tracesSampleRate",
    ]);
  });

  // The replay used to run on every page but a credential one (lib/replay-guard). With it off, no page has one: not an
  // ordinary page (that a replay came back on a page the guard allows would show here), not a credential page. Everything else
  // the init sets up is the same on every page.
  it("builds no replay on ANY page, ordinary or credential, and sets up the same integrations on each", async () => {
    const pages = await credentialPages();
    expect(pages.length, "anti-vacuity: pages checked").toBeGreaterThanOrEqual(12);
    const names: string[][] = [];
    for (const href of ["https://seazn.club/dashboard", ...pages.map((p) => new URL(p.url, "https://seazn.club").href)]) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubGlobal("window", { location: new URL(href) });
      const integrations = (await sentryInitOptions(CLIENT_INIT)).integrations as { name: string }[];
      const Sentry = await import("@sentry/nextjs");
      expect(vi.mocked(Sentry.replayIntegration), `${href}: no replay is built`).not.toHaveBeenCalled();
      names.push(integrations.map((i) => i.name));
    }
    expect(names.length).toBe(pages.length + 1);
    expect(names[0], "the scrubbers and the console logs are there").toEqual(["ConsoleLogs", "ScrubScoreTokens"]);
    for (const n of names) expect(n).toEqual(names[0]);
  });
});

describe("Sentry router hook (src/instrumentation-client.ts, onRouterTransitionStart)", () => {
  async function routerHook() {
    const mod = await import(CLIENT_INIT);
    const Sentry = await import("@sentry/nextjs");
    return { hook: mod.onRouterTransitionStart, Sentry };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("stops the replay before the app navigates to a credential page, and still reports the transition", async () => {
    const { hook, Sentry } = await routerHook();
    const stop = vi.fn(async () => undefined);
    setReplay({ stop });
    hook(`/score/${TOKEN}`, "push");
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureRouterTransitionStart)).toHaveBeenCalledWith(`/score/${TOKEN}`, "push");
  });

  it("leaves the replay running for any other navigation, and still reports the transition", async () => {
    const { hook, Sentry } = await routerHook();
    const stop = vi.fn(async () => undefined);
    setReplay({ stop });
    hook("/dashboard", "replace");
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureRouterTransitionStart)).toHaveBeenCalledWith("/dashboard", "replace");
  });
});

// Review I1 of the login-round-trip fix: the personal match-room link (`/play?t=<JWT>`) rides URLs at three encoding
// depths once a signed-out player links Lichess from the room. The patterns are proven in
// api/auth/__tests__/lichess-link-login-round-trip.test.ts; this half proves each REAL config hands them to its SDK, so
// a scrub nothing passes to an SDK (an inert seam) would be red here. The token and the room/start URLs come from the
// real minter and builders; the login URL is the start route's own one-line `/login?next=<encoded start>`.
describe("the match-room token (review I1): every config's real hooks scrub it", () => {
  async function roomUrls() {
    const token = await mintMatchRoomToken({
      fixtureId: randomUUID(),
      personId: randomUUID(),
      roundOpenId: randomUUID(),
      roundOpenedAt: new Date().toISOString(),
    });
    const selfPath = routes.sharedFixturePlay("chess-club", "autumn-open", "open", randomUUID(), token);
    const startHref = lichessLinkStartHref("chess-club", selfPath);
    const urls = {
      room: `https://seazn.club${selfPath}`,
      start: `https://seazn.club${startHref}`,
      login: `https://seazn.club/login?next=${encodeURIComponent(startHref)}`,
    };
    for (const [depth, url] of Object.entries(urls)) expect(url, `premise: ${depth} carries the token`).toContain(token);
    return { token, ...urls };
  }
  const expectScrubbedOf = (value: unknown, token: string) => {
    const text = JSON.stringify(value);
    expect(text).not.toContain(token);
    expect(text).toContain("[token]");
  };

  it("PostHog: a pageview of the room, its referrer and an autocaptured link", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    const options = vi.mocked(posthog.init).mock.calls[0]![1] as Options;
    const { token, room, start, login } = await roomUrls();
    const pageview = {
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: room, $referrer: login, $elements: [{ attr__href: start }] },
      $set_once: { $initial_current_url: room },
    };
    let out: unknown = pageview;
    for (const fn of [options.before_send].flat()) out = run(fn, out);
    expectScrubbedOf(out, token);
  });

  it.each([
    ["server", "../../../sentry.server.config"],
    ["edge", "../../../sentry.edge.config"],
  ])("Sentry %s: an error's request URL and query, a transaction's span, and a log line", async (_name, config) => {
    const options = await sentryInitOptions(config);
    const { token, room, start, login } = await roomUrls();
    expectScrubbedOf(
      run(options.beforeSend, { event_id: "e1", request: { url: room, query_string: `t=${token}`, headers: { Referer: login } } }, {}),
      token,
    );
    expectScrubbedOf(
      run(options.beforeSendTransaction, { type: "transaction", transaction: "GET /play", spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": start } }] }, {}),
      token,
    );
    expectScrubbedOf(run(options.beforeSendLog, { level: "error", message: `Failed to fetch RSC payload for ${room}`, attributes: {} }), token);
  });

  it("Sentry client: an error, a navigation breadcrumb and the event processor (a replay_event's URL list)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { token, room, start, login } = await roomUrls();
    expectScrubbedOf(run(options.beforeSend, { event_id: "e1", request: { url: room } }, {}), token);
    expectScrubbedOf(run(options.beforeBreadcrumb, { category: "navigation", data: { from: login, to: room } }, {}), token);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expectScrubbedOf(run(scrubber.processEvent, { type: "replay_event", urls: [room, start, login] }, {}, {}), token);
  });
});

// A one-time sign-in token rides `/magic-link?token=…` and `/verify-email?token=…` and reaches telemetry BEFORE it is
// spent (the `$pageview` fires on landing, the consume POST comes after). The rules are proven in scrub-login-token.test.ts;
// this half proves each REAL config hands them to its SDK, so a scrub nothing passes to an SDK (an inert seam) would be
// red here. The tokens come from the real minters, over a stand-in for the Postgres round trip alone.
describe("the one-time sign-in token: every config's real hooks scrub it", () => {
  async function signInUrls() {
    const login = await createLoginLink(USER_ID);
    const verify = await createVerificationToken(USER_ID);
    const next = encodeURIComponent("/dashboard");
    const magicUrl = `https://seazn.club/magic-link?token=${login}&next=${next}`;
    const verifyUrl = `https://seazn.club/verify-email?token=${verify}&next=${next}`;
    expect(magicUrl, "premise: the sign-in link carries the token").toContain(login);
    expect(verifyUrl, "premise: the verification link carries the token").toContain(verify);
    return { login, verify, magicUrl, verifyUrl };
  }
  const expectGone = (value: unknown, ...secrets: string[]) => {
    const text = JSON.stringify(value);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("token=[token]");
  };

  it("PostHog: the pageview on landing, its referrer and the person's first-seen URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    const options = vi.mocked(posthog.init).mock.calls[0]![1] as Options;
    const { login, verify, magicUrl, verifyUrl } = await signInUrls();
    const pageview = {
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: magicUrl, $pathname: "/magic-link", $referrer: verifyUrl, $elements: [{ attr__href: verifyUrl }] },
      $set_once: { $initial_current_url: magicUrl },
    };
    let out: unknown = pageview;
    for (const fn of [options.before_send].flat()) out = run(fn, out);
    expectGone(out, login, verify);
  });

  it.each([
    ["server", "../../../sentry.server.config"],
    ["edge", "../../../sentry.edge.config"],
  ])("Sentry %s: an error's request URL and bare query string, a transaction, a span and a log line", async (_name, config) => {
    const options = await sentryInitOptions(config);
    const { login, verify, magicUrl, verifyUrl } = await signInUrls();
    const out = run(
      options.beforeSend,
      { event_id: "e1", request: { url: magicUrl, query_string: `token=${login}&next=%2Fdashboard`, headers: { Referer: verifyUrl } } },
      {},
    ) as { request: { query_string: string } };
    expectGone(out, login, verify);
    expect(out.request.query_string, "Sentry's query string has no `?`, and is still scrubbed").toBe("token=[token]&next=%2Fdashboard");
    expectGone(
      run(
        options.beforeSendTransaction,
        { type: "transaction", transaction: "GET /verify-email", request: { query_string: `token=${verify}` }, spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": verifyUrl } }] },
        {},
      ),
      verify,
    );
    expectGone(run(options.beforeSendLog, { level: "error", message: `Failed to fetch RSC payload for ${magicUrl}`, attributes: {} }), login);
    // The positive pair: the same query string on a route that is not a one-time route is kept.
    const other = run(options.beforeSend, { event_id: "e2", request: { url: "https://seazn.club/dashboard", query_string: `token=${login}` } }, {}) as {
      request: { query_string: string };
    };
    expect(other.request.query_string).toBe(`token=${login}`);
  });

  it("Sentry client: an error, a navigation breadcrumb and the event processor (a replay_event's URL list)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { login, verify, magicUrl, verifyUrl } = await signInUrls();
    expectGone(run(options.beforeSend, { event_id: "e1", request: { url: magicUrl, query_string: `token=${login}` } }, {}), login);
    expectGone(run(options.beforeBreadcrumb, { category: "navigation", data: { from: verifyUrl, to: magicUrl } }, {}), login, verify);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expectGone(run(scrubber.processEvent, { type: "replay_event", urls: [magicUrl, verifyUrl] }, {}, {}), login, verify);
  });
});

// The profile-claim link `/claim/<pc_secret>` (routes.claim, 14 days, shown to the organiser as a link and a QR) and the
// accept call its page makes, `/api/claims/<secret>/accept`, carry the secret in the PATH. Proven in
// scrub-claim-path.test.ts; this half proves each REAL config hands the rule to its SDK. The secret is the real
// `mintClaimSecret()`, the page URL the real `routes.claim()`, the sign-in `next=` the one AuthForm sends.
describe("the profile-claim secret: every config's real hooks scrub it", () => {
  function claimUrls() {
    const secret = mintClaimSecret();
    const urls = {
      page: `https://seazn.club${routes.claim(secret)}`,
      accept: `https://seazn.club/api/claims/${secret}/accept`,
      login: `https://seazn.club/login?next=${encodeURIComponent(routes.claim(secret))}`,
    };
    for (const [name, url] of Object.entries(urls)) expect(url, `premise: ${name} carries the secret`).toContain(secret);
    return { secret, ...urls };
  }
  const expectGone = (value: unknown, secret: string) => {
    const text = JSON.stringify(value);
    expect(text).not.toContain(secret);
    expect(text).toContain("[token]");
  };

  it("PostHog: the pageview of the claim page, its referrer (a sign-in next=) and an autocaptured link", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    const options = vi.mocked(posthog.init).mock.calls[0]![1] as Options;
    const { secret, page, login } = claimUrls();
    const pageview = {
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: page, $pathname: routes.claim(secret), $referrer: login, $elements: [{ attr__href: page }] },
      $set_once: { $initial_current_url: page },
    };
    let out: unknown = pageview;
    for (const fn of [options.before_send].flat()) out = run(fn, out);
    expectGone(out, secret);
  });

  it.each([
    ["server", "../../../sentry.server.config"],
    ["edge", "../../../sentry.edge.config"],
  ])("Sentry %s: an error's request URL, a transaction's span, a log line and the accept call's transaction", async (_name, config) => {
    const options = await sentryInitOptions(config);
    const { secret, page, accept, login } = claimUrls();
    expectGone(run(options.beforeSend, { event_id: "e1", request: { url: page, headers: { Referer: login } } }, {}), secret);
    expectGone(
      run(options.beforeSendTransaction, { type: "transaction", transaction: `POST /api/claims/${secret}/accept`, spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": accept } }] }, {}),
      secret,
    );
    expectGone(run(options.beforeSendLog, { level: "error", message: `Failed to fetch RSC payload for ${page}`, attributes: {} }), secret);
  });

  it("Sentry client: an error, a navigation breadcrumb and the event processor (a replay_event's URL list)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { secret, page, accept, login } = claimUrls();
    expectGone(run(options.beforeSend, { event_id: "e1", request: { url: page } }, {}), secret);
    expectGone(run(options.beforeBreadcrumb, { category: "navigation", data: { from: login, to: page } }, {}), secret);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expectGone(run(scrubber.processEvent, { type: "replay_event", urls: [page, accept, login] }, {}, {}), secret);
  });
});

// The org invite `/join/<token>` (admin or viewer; an email invite also mints a session) and the day's check-in code
// `/checkin/<token>` (a JWT, the proof of presence) carry their secret in the PATH. Proven in scrub-path-secrets.test.ts;
// this half proves each REAL config hands the rule to its SDK. The invite comes from the real `createInvite`, the code
// from the real `mintCheckinToken`, the page URL from `routes.checkin()`, the API URLs from the islands' own templates.
describe("the invite token and the check-in code: every config's real hooks scrub them", () => {
  async function pathSecretUrls() {
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const checkin = await mintCheckinToken("00000000-0000-4000-8000-000000000003", new Date(Date.now() + 3600_000));
    const urls = {
      joinUrl: `https://seazn.club/join/${invite}`,
      claimApiUrl: `https://seazn.club/api/invites/${invite}/claim`,
      revokeApiUrl: `https://seazn.club/api/orgs/00000000-0000-4000-8000-000000000002/invites/${invite}/revoke`,
      checkinUrl: `https://seazn.club${routes.checkin(checkin)}`,
      checkinApiUrl: `https://seazn.club/api/checkin/${checkin}`,
    };
    for (const [name, url] of Object.entries(urls)) expect(url, `premise: ${name} carries its secret`).toMatch(new RegExp(`${invite}|${checkin}`));
    return { invite, checkin, ...urls };
  }
  const expectGone = (value: unknown, ...secrets: string[]) => {
    const text = JSON.stringify(value);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("[token]");
  };

  it("PostHog: the pageview of the join page and of the check-in page (their $pathname too), and a referrer", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubGlobal("document", { cookie: "" });
    await import(CLIENT_INIT);
    const posthog = (await import("posthog-js")).default;
    const options = vi.mocked(posthog.init).mock.calls[0]![1] as Options;
    const { invite, checkin, joinUrl, checkinUrl } = await pathSecretUrls();
    for (const [url, pathname, secret] of [
      [joinUrl, `/join/${invite}`, invite],
      [checkinUrl, routes.checkin(checkin), checkin],
    ] as const) {
      let out: unknown = {
        uuid: "u1",
        event: "$pageview",
        properties: { $current_url: url, $pathname: pathname, $referrer: joinUrl, $elements: [{ attr__href: url }] },
        $set_once: { $initial_current_url: url },
      };
      for (const fn of [options.before_send].flat()) out = run(fn, out);
      expectGone(out, secret);
      expect((out as { properties: { $pathname: string } }).properties.$pathname).toBe(pathname.replace(secret, "[token]"));
    }
  });

  it.each([
    ["server", "../../../sentry.server.config"],
    ["edge", "../../../sentry.edge.config"],
  ])("Sentry %s: an error's request URL, a transaction's span, a log line and the API calls", async (_name, config) => {
    const options = await sentryInitOptions(config);
    const { invite, checkin, joinUrl, claimApiUrl, revokeApiUrl, checkinUrl, checkinApiUrl } = await pathSecretUrls();
    expectGone(run(options.beforeSend, { event_id: "e1", request: { url: joinUrl, headers: { Referer: checkinUrl } } }, {}), invite, checkin);
    expectGone(
      run(options.beforeSendTransaction, { type: "transaction", transaction: `POST /api/invites/${invite}/claim`, spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, data: { "url.full": claimApiUrl } }] }, {}),
      invite,
    );
    expectGone(run(options.beforeSend, { event_id: "e2", request: { url: revokeApiUrl } }, {}), invite);
    expectGone(run(options.beforeSend, { event_id: "e3", request: { url: checkinApiUrl } }, {}), checkin);
    expectGone(run(options.beforeSendLog, { level: "error", message: `Failed to fetch RSC payload for ${joinUrl}`, attributes: {} }), invite);
  });

  it("Sentry client: an error, a navigation breadcrumb and the event processor (a replay_event's URL list)", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { invite, checkin, joinUrl, claimApiUrl, checkinUrl } = await pathSecretUrls();
    expectGone(run(options.beforeSend, { event_id: "e1", request: { url: joinUrl } }, {}), invite);
    expectGone(run(options.beforeBreadcrumb, { category: "navigation", data: { from: joinUrl, to: checkinUrl } }, {}), invite, checkin);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expectGone(run(scrubber.processEvent, { type: "replay_event", urls: [joinUrl, checkinUrl, claimApiUrl] }, {}, {}), invite, checkin);
  });
});

// A credential that rides a request BODY (the sign-in consume POSTs `{ token, next }`) reaches Sentry in `request.data`
// after the URL has been scrubbed. Proven route by route in scrub-request-body.test.ts; this half proves
// each REAL config hands the drop to its SDK, on events carrying a REAL minted token (the sign-in link, the
// verification token, an invite), through every hook an event can take: `beforeSend`, `beforeSendTransaction`, and the
// client's event processor.
describe("a credential in a request body: every Sentry config's real hooks drop the body", () => {
  async function bodyEvents() {
    const login = await createLoginLink(USER_ID);
    const verify = await createVerificationToken(USER_ID);
    const invite = (await createInvite("00000000-0000-4000-8000-000000000002", USER_ID, { role: "admin", max_uses: 1 })).token;
    const request = (url: string, data: unknown) => ({ method: "POST", url, headers: { "content-type": "application/json" }, data });
    const consume = { event_id: "b1", request: request("https://seazn.club/api/auth/magic-link/consume", JSON.stringify({ token: login, next: "/dashboard" })) };
    const verifyTx = {
      type: "transaction",
      transaction: "POST /api/auth/verify-email",
      request: { method: "POST", data: { token: verify, next: "/dashboard" } },
    };
    const claim = { event_id: "b3", request: request(`https://seazn.club/api/invites/${invite}/claim`, { token: invite }) };
    const lookup = { event_id: "b4", request: request("https://seazn.club/api/auth/magic-link", { email: "a@example.test", next: "/dashboard" }) };
    return { login, verify, invite, consume, verifyTx, claim, lookup };
  }
  type Out = { request?: { method?: string; headers?: Record<string, string>; data?: unknown } };
  const expectBodyGone = (out: unknown, ...secrets: string[]) => {
    const request = (out as Out).request ?? {};
    expect(Object.hasOwn(request, "data"), "the body is gone").toBe(false);
    expect(request.method, "the rest of the request stays").toBe("POST");
    for (const secret of secrets) expect(JSON.stringify(out)).not.toContain(secret);
  };
  const expectBodyKept = (out: unknown) => {
    expect((out as Out).request?.data, "an ordinary route keeps its body (the positive pair)").toEqual({ email: "a@example.test", next: "/dashboard" });
  };

  for (const [name, config] of [
    ["Sentry server", "../../../sentry.server.config"],
    ["Sentry edge", "../../../sentry.edge.config"],
  ] as const) {
    it(`${name}: the sign-in consume and an invite claim lose their body in beforeSend, the verification POST in beforeSendTransaction; the sign-in request keeps its`, async () => {
      const options = await sentryInitOptions(config);
      const { login, verify, invite, consume, verifyTx, claim, lookup } = await bodyEvents();
      expectBodyGone(run(options.beforeSend, consume, {}), login);
      expectBodyGone(run(options.beforeSend, claim, {}), invite);
      expectBodyGone(run(options.beforeSendTransaction, verifyTx, {}), verify);
      expectBodyKept(run(options.beforeSend, lookup, {}));
    });
  }

  it("Sentry client: beforeSend and the event processor drop the body too", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { login, invite, consume, claim, lookup } = await bodyEvents();
    expectBodyGone(run(options.beforeSend, consume, {}), login);
    expectBodyGone(run(options.beforeSend, claim, {}), invite);
    expectBodyKept(run(options.beforeSend, lookup, {}));
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expectBodyGone(run(scrubber.processEvent, consume, {}, {}), login);
  });
});

// A sampled transaction's span data carries the request's bare query (`http.query` / `url.query`, with its `?`) beside a URL
// that has none, and a team's join code rides the register pages' query. The events come from the SDK's own span-data helpers
// (_sdk-span-data.ts); scrub-span-query.test.ts and scrub-join-code.test.ts hold the sweeps, this proves each REAL config's
// hooks do it (an inert seam would be red here).
describe("a one-time token in a span's bare query, and a join code: every Sentry config's real hooks", () => {
  async function spanEvents() {
    const login = await createLoginLink(USER_ID);
    const code = generateRefCode();
    const url = `https://seazn.club/magic-link?token=${login}&next=%2Fdashboard`;
    const joinUrl = `https://seazn.club/api/v1/public/orgs/city-club/competitions/spring-open/register/join?join_code=${encodeURIComponent(code)}`;
    const tx = transaction({ name: "GET /magic-link", traceData: otelTraceData(url) });
    const child = transaction({
      name: "GET /dashboard",
      traceData: otelTraceData("https://seazn.club/dashboard"),
      spans: [{ description: `GET ${url}`, data: clientSpanDetails(url).data }],
    });
    const server = transaction({ name: "GET /magic-link", traceData: serverSpanDetails(url, "/magic-link").data });
    const joinTx = transaction({ name: "GET /api/v1/public/orgs/[orgSlug]/competitions/[slug]/register/join", traceData: otelTraceData(joinUrl) });
    const error = { event_id: "s1", transaction: "GET /magic-link", breadcrumbs: [outgoingBreadcrumb(url)], request: { url: "https://seazn.club/magic-link" } };
    const joinError = { event_id: "s2", request: { method: "GET", url: "https://seazn.club/shared/city-club/spring-open/register/join", query_string: { join_code: code, player_id: "p1" } } };
    return { login, code, tx, child, server, joinTx, error, joinError };
  }
  const data = (e: unknown) => (e as { contexts: { trace: { data: Record<string, unknown> } } }).contexts.trace.data;
  const spanData = (e: unknown) => (e as { spans: { data: Record<string, unknown> }[] }).spans[0]!.data;

  for (const [name, config] of [
    ["Sentry server", "../../../sentry.server.config"],
    ["Sentry edge", "../../../sentry.edge.config"],
  ] as const) {
    it(`${name}: beforeSendTransaction scrubs http.query / url.query; beforeSend scrubs a breadcrumb's and a join code's query_string`, async () => {
      const options = await sentryInitOptions(config);
      const { login, code, tx, child, server, joinTx, error, joinError } = await spanEvents();
      const out = (hook: unknown, event: unknown) => run(hook, event, {});
      expect(data(out(options.beforeSendTransaction, tx))["http.query"]).toBe("?token=[token]&next=%2Fdashboard");
      expect(data(out(options.beforeSendTransaction, server))["url.query"]).toBe("?token=[token]&next=%2Fdashboard");
      expect(spanData(out(options.beforeSendTransaction, child))["url.query"]).toBe("?token=[token]&next=%2Fdashboard");
      expect(data(out(options.beforeSendTransaction, joinTx))["http.query"]).toBe("?join_code=[code]");
      const beforeSend = JSON.stringify(out(options.beforeSend, error));
      expect(beforeSend).not.toContain(login);
      expect(beforeSend).toContain("?token=[token]");
      const joinOut = out(options.beforeSend, joinError) as { request: { query_string: Record<string, string> } };
      expect(joinOut.request.query_string).toEqual({ join_code: "[code]", player_id: "p1" });
      for (const o of [tx, child, server, joinTx]) expect(JSON.stringify(out(options.beforeSendTransaction, o))).not.toMatch(new RegExp(`${login}|${code}`));
    });
  }

  it("Sentry client: beforeSend, beforeSendTransaction and the event processor do it too", async () => {
    const options = await sentryInitOptions(CLIENT_INIT);
    const { login, code, tx, child, joinTx, error, joinError } = await spanEvents();
    expect(data(run(options.beforeSendTransaction, tx, {}))["http.query"]).toBe("?token=[token]&next=%2Fdashboard");
    expect(spanData(run(options.beforeSendTransaction, child, {}))["url.query"]).toBe("?token=[token]&next=%2Fdashboard");
    expect(data(run(options.beforeSendTransaction, joinTx, {}))["http.query"]).toBe("?join_code=[code]");
    expect(JSON.stringify(run(options.beforeSend, error, {}))).not.toContain(login);
    const integrations = options.integrations as { name: string; processEvent?: unknown }[];
    const scrubber = integrations.find((i) => typeof i.processEvent === "function")!;
    expect(data(run(scrubber.processEvent, tx, {}, {}))["http.query"]).toBe("?token=[token]&next=%2Fdashboard");
    expect(JSON.stringify(run(scrubber.processEvent, joinError, {}, {}))).not.toContain(code);
  });
});
