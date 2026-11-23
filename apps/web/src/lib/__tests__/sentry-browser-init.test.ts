// The BROWSER Sentry client (owner 2026-11-23: switch it on, errors and warnings only, no session replay). Under Turbopack the
// one client init path Next 16 and @sentry/nextjs 10.62 support is src/instrumentation-client.ts (Next's
// file-conventions/instrumentation-client.md; @sentry/nextjs config/webpack.js: "When using Turbopack
// `sentry.client.config.ts` will no longer work"). Before this change no client file called `Sentry.init`, so every browser
// capture (the camera drop warnings, the D7 and arbiter guards' reports, the router hook) went to no client at all.
//
// This file imports the REAL instrumentation-client with the SDK mocked and proves: it calls `Sentry.init` once, with replay
// and tracing off and the privacy hooks attached; no DSN means no init and no throw; and nothing is SENT without the
// visitor's analytics consent (the privacy policy names no lawful basis for Sentry, so it is gated as PostHog is:
// lib/sentry-browser.ts). The scrub hooks themselves are proven in scrub-score-url-wiring.test.ts, through this same init.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "@/lib/consent";

const fakeTransport = vi.hoisted(() => ({ send: vi.fn(async () => ({ statusCode: 200 })), flush: vi.fn(async () => true) }));
vi.mock("posthog-js", () => ({ default: { init: vi.fn(), opt_in_capturing: vi.fn() } }));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
  makeFetchTransport: vi.fn(() => fakeTransport),
}));

const DSN = "https://0123456789abcdef0123456789abcdef@o0.ingest.sentry.io/0";
type Options = Record<string, unknown>;

async function clientInit(): Promise<{ options: Options; Sentry: typeof import("@sentry/nextjs") }> {
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
  await import("../../instrumentation-client");
  const Sentry = await import("@sentry/nextjs");
  const calls = vi.mocked(Sentry.init).mock.calls;
  expect(calls, "instrumentation-client calls Sentry.init once").toHaveLength(1);
  return { options: calls[0]![0] as Options, Sentry };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the browser Sentry client (src/instrumentation-client.ts)", () => {
  it("with a DSN, inits once: replay off, tracing off, warn/error console logs, and the scrub hooks and processor attached", async () => {
    const { options, Sentry } = await clientInit();
    expect(options.dsn).toBe(DSN);
    expect(options.tracesSampleRate, "no performance tracing (a 0 rate keeps the router hook's span unsampled)").toBe(0);
    expect(options.replaysSessionSampleRate, "no session replay").toBe(0);
    expect(options.replaysOnErrorSampleRate, "no replay on error either").toBe(0);
    expect(vi.mocked(Sentry.replayIntegration), "no Replay integration is built").not.toHaveBeenCalled();
    const integrations = options.integrations as { name: string }[];
    expect(integrations.map((i) => i.name), "the exact set: a new integration is a decision").toEqual(["ConsoleLogs", "ScrubScoreTokens"]);
    expect(vi.mocked(Sentry.consoleLoggingIntegration)).toHaveBeenCalledWith({ levels: ["warn", "error"] });
    // The same module instance the init loaded (resetModules gives every test a fresh one).
    const { scrubScoreTokens, scrubSentryEvent } = await import("@/lib/scrub-score-url");
    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(options.beforeSendTransaction).toBe(scrubSentryEvent);
    expect(options.beforeBreadcrumb).toBe(scrubScoreTokens);
    expect(typeof options.beforeSendLog).toBe("function");
    expect(typeof options.transport, "sending goes through the consent gate").toBe("function");
    expect(Object.keys(options).sort(), "the exact option set: a new one is a decision").toEqual([
      "beforeBreadcrumb",
      "beforeSend",
      "beforeSendLog",
      "beforeSendTransaction",
      "dsn",
      "enableLogs",
      "environment",
      "integrations",
      "replaysOnErrorSampleRate",
      "replaysSessionSampleRate",
      "tracesSampleRate",
      "transport",
    ]);
  });

  it("a second load of the page inits again (one init per page load, never zero), and the router hook is still exported", async () => {
    const first = await clientInit();
    vi.resetModules();
    vi.clearAllMocks();
    const second = await clientInit();
    expect(second.options.dsn).toBe(first.options.dsn);
    const mod = await import("../../instrumentation-client");
    expect(typeof mod.onRouterTransitionStart).toBe("function");
  });

  it("without a DSN (unset, or blank as the CI builds bake it) the client is never initialised, nothing throws, and the router hook still runs", async () => {
    let checked = 0;
    for (const dsn of [undefined, ""]) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
      const mod = await import("../../instrumentation-client");
      const Sentry = await import("@sentry/nextjs");
      expect(vi.mocked(Sentry.init), `DSN ${JSON.stringify(dsn)}: no init`).not.toHaveBeenCalled();
      expect(() => mod.onRouterTransitionStart("/dashboard", "push")).not.toThrow();
      checked++;
    }
    expect(checked, "anti-vacuity: both no-DSN shapes checked").toBe(2);
  });

  it("an init that throws never breaks the page: the module still loads and exports the router hook", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    const Sentry = await import("@sentry/nextjs");
    vi.mocked(Sentry.init).mockImplementationOnce(() => {
      throw new Error("sdk boom");
    });
    const mod = await import("../../instrumentation-client");
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1);
    expect(typeof mod.onRouterTransitionStart).toBe("function");
  });
});

describe("the consent gate: nothing leaves the browser without analytics consent against the CURRENT policy version", () => {
  function stubStorage(): Map<string, string> {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    return store;
  }

  it("reads consent at every send, so Accept and withdraw act at once and a policy bump revokes; the empty case sends nothing", async () => {
    const { options, Sentry } = await clientInit();
    const store = stubStorage();
    const transport = (options.transport as (o: unknown) => { send(e: unknown): PromiseLike<unknown>; flush(t?: number): PromiseLike<boolean> })({
      url: "https://o0.ingest.sentry.io/api/0/envelope/",
      recordDroppedEvent: () => undefined,
    });
    expect(vi.mocked(Sentry.makeFetchTransport), "the SDK's own fetch transport does the sending").toHaveBeenCalledTimes(1);
    const envelope = [{ event_id: "e1" }, [[{ type: "event" }, { message: "boom" }]]];
    // Each step: what the banner leaves in localStorage (lib/consent's own keys), and whether it may send.
    const steps: [string, () => void, boolean][] = [
      ["no choice yet (the empty case)", () => store.clear(), false],
      ["rejected", () => (store.set(CONSENT_KEY, "rejected"), store.set(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION)), false],
      ["accepted an OLD policy version", () => (store.set(CONSENT_KEY, "accepted"), store.set(CONSENT_VERSION_KEY, "2000-01-01")), false],
      ["accepted the current version", () => (store.set(CONSENT_KEY, "accepted"), store.set(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION)), true],
      ["a second send while accepted", () => undefined, true],
      ["withdrawn mid-session", () => store.set(CONSENT_KEY, "rejected"), false],
      ["accepted again", () => store.set(CONSENT_KEY, "accepted"), true],
      ["storage that throws (a private window)", () => vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } }), false],
    ];
    let checked = 0;
    let expectedSends = 0;
    for (const [name, arrange, sends] of steps) {
      arrange();
      await expect(transport.send(envelope), `${name}: the send resolves`).resolves.toBeDefined();
      if (sends) expectedSends++;
      expect(fakeTransport.send, name).toHaveBeenCalledTimes(expectedSends);
      checked++;
    }
    expect(checked, "anti-vacuity: every consent state checked").toBe(steps.length);
    expect(expectedSends, "anti-vacuity: the gate opened at least once").toBe(3);
    await expect(transport.flush(5)).resolves.toBe(true);
    expect(fakeTransport.flush).toHaveBeenCalledWith(5);
  });
});

// Two inits on the client would double every event (and @sentry/nextjs warns). The webpack-only sentry.client.config.ts is gone,
// and no other file calls `Sentry.init` except the server and edge configs (run by instrumentation.ts on the server).
describe("Sentry.init is called in exactly one client file", () => {
  const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "e2e", "test-results", "playwright-report", "coverage", "public"]);
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) sources(path.join(dir, entry.name), out);
      } else if (/\.(c|m)?(t|j)sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  }
  const INIT_CALL = /\bSentry\.init\s*\(/g;
  const NAMED_INIT_IMPORT = /import\s*\{[^}]*\binit\b[^}]*\}\s*from\s*["']@sentry\//;
  /** Code only: comment lines (`//`, `/*`, ` *`) out, so a comment naming `Sentry.init(` is not a call. Line-based on purpose:
   *  a regex that strips block comments also eats code between a `/*` and a `*\/` inside two strings (a glob), hiding a call. */
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");

  it("is in src/instrumentation-client.ts once; the server and edge configs are the only others; sentry.client.config is gone", () => {
    const files = sources(WEB);
    expect(files.length, "anti-vacuity: the app's source files were scanned").toBeGreaterThan(1000);
    const callers: Record<string, number> = {};
    for (const file of files) {
      const src = code(file);
      const calls = (src.match(INIT_CALL) ?? []).length + (NAMED_INIT_IMPORT.test(src) ? 1 : 0);
      if (calls > 0) callers[path.relative(WEB, file)] = calls;
    }
    expect(callers).toEqual({
      "sentry.edge.config.ts": 1,
      "sentry.server.config.ts": 1,
      "src/instrumentation-client.ts": 1,
    });
    for (const dead of ["sentry.client.config.ts", "sentry.client.config.js"]) {
      expect(existsSync(path.join(WEB, dead)), `${dead}: webpack-only, and a second client init if a webpack build ever ran`).toBe(false);
    }
  });

  it("no client code builds a Replay integration (owner 2026-11-23: no session replay)", () => {
    const files = sources(WEB);
    expect(files.length, "anti-vacuity: the app's source files were scanned").toBeGreaterThan(1000);
    const builders = files.filter((f) => /\breplay(Canvas)?Integration\s*\(/.test(code(f))).map((f) => path.relative(WEB, f));
    expect(builders).toEqual([]);
  });
});
