// The BROWSER Sentry client (owner 2026-11-23: switch it on, errors and warnings only, no session replay; coordinator ruling the
// same day: the SDK must not be in the first-load JS). Under Turbopack the client init path Next 16 and @sentry/nextjs 10.62
// support is src/instrumentation-client.ts (Next's file-conventions/instrumentation-client.md; @sentry/nextjs config/webpack.js:
// "When using Turbopack `sentry.client.config.ts` will no longer work"). It boots lib/sentry-browser.ts, a facade with no
// runtime SDK import, which fetches lib/sentry-browser-sdk.ts (the one module that imports the SDK, by name) with a dynamic
// import() on idle, and only with a DSN and the visitor's analytics consent (the privacy policy names no lawful basis for
// Sentry, so it is gated as PostHog is). Every client file reports through the facade, which queues calls while the load is
// pending and drops them otherwise.
//
// The SDK is mocked; instrumentation-client, the facade, the lazy SDK module, lib/consent and the banner's
// recordConsentChoice run for real. The scrub hooks themselves are proven in scrub-score-url-wiring.test.ts through the same
// boot.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_KEY, COOKIE_POLICY_VERSION } from "@/lib/consent";
import { TEST_DSN, bootBrowserSentry, integrationsOf, stubConsent } from "./_browser-sentry";

const fakeTransport = vi.hoisted(() => ({ send: vi.fn(async () => ({ statusCode: 200 })), flush: vi.fn(async () => true) }));
vi.mock("posthog-js", () => ({
  default: { init: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), capture: vi.fn(), __loaded: false },
}));
vi.mock("@sentry/nextjs", () => ({
  init: vi.fn(),
  replayIntegration: vi.fn(() => ({ name: "Replay" })),
  consoleLoggingIntegration: vi.fn(() => ({ name: "ConsoleLogs" })),
  captureRouterTransitionStart: vi.fn(),
  getClient: vi.fn(),
  makeFetchTransport: vi.fn(() => fakeTransport),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  getIsolationScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
  getCurrentScope: vi.fn(() => ({ clearBreadcrumbs: vi.fn() })),
}));

type Options = Record<string, unknown>;
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** requestIdleCallback, captured: the scheduled callbacks run only when the test says the browser is idle. */
function captureIdle(): (() => void)[] {
  const pending: (() => void)[] = [];
  vi.stubGlobal("requestIdleCallback", vi.fn((cb: () => void) => (pending.push(cb), pending.length)));
  return pending;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("loading the SDK (src/instrumentation-client.ts -> lib/sentry-browser.ts)", () => {
  it("consented at boot: nothing is fetched while the page loads; the load waits for idle, then inits once with replay and tracing off and the scrub hooks", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    const store = stubConsent("accepted");
    const idle = captureIdle();
    await import("../../instrumentation-client");
    const Sentry = await import("@sentry/nextjs");
    await settle();
    expect(vi.mocked(Sentry.init), "nothing loads before the browser is idle").not.toHaveBeenCalled();
    expect(idle, "the load is scheduled on requestIdleCallback").toHaveLength(1);
    idle[0]!();
    const facade = await import("@/lib/sentry-browser");
    expect(await facade.loadBrowserSentry()).toBe(true);
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1);

    const options = vi.mocked(Sentry.init).mock.calls[0]![0] as Options;
    expect(options.dsn).toBe(TEST_DSN);
    // Tracing OFF is the rate UNSET: a 0 counts as enabled and inherits a sampled server trace (review I1; the real sampler is
    // pinned in sentry-browser-real-sdk.test.ts).
    expect("tracesSampleRate" in options, "no tracesSampleRate").toBe(false);
    expect("tracesSampler" in options, "no tracesSampler").toBe(false);
    expect(options.tracePropagationTargets, "no trace header on any request").toEqual([]);
    expect(options.replaysSessionSampleRate, "no session replay").toBe(0);
    expect(options.replaysOnErrorSampleRate, "no replay on error either").toBe(0);
    expect(vi.mocked(Sentry.replayIntegration), "no Replay integration is built").not.toHaveBeenCalled();
    // The integrations this config adds and drops, over a stand-in for the SDK's defaults. The EFFECTIVE set after a real init
    // is pinned in sentry-browser-real-sdk.test.ts.
    const standInDefaults = ["InboundFilters", "BrowserTracing", "Breadcrumbs", "BrowserSession"].map((name) => ({ name }));
    expect(integrationsOf(options, standInDefaults).map((i) => i.name), "the integrations this config adds and drops: a change is a decision").toEqual([
      "InboundFilters",
      "Breadcrumbs",
      "ConsoleLogs",
      "ScrubScoreTokens",
    ]);
    expect(vi.mocked(Sentry.consoleLoggingIntegration)).toHaveBeenCalledWith({ levels: ["warn", "error"] });
    // The same module instance the load used (resetModules gives every test a fresh one).
    const { scrubScoreTokens, scrubSentryEvent } = await import("@/lib/scrub-score-url");
    expect(options.beforeSend).toBe(scrubSentryEvent);
    expect(options.beforeSendTransaction).toBe(scrubSentryEvent);
    const crumb = { category: "navigation", data: { to: "/score/dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9" } };
    expect((options.beforeBreadcrumb as (c: unknown) => unknown)(crumb), "consented: the crumb is scrubbed, as scrubScoreTokens does").toEqual(scrubScoreTokens(crumb));
    store.set(CONSENT_KEY, "rejected");
    expect((options.beforeBreadcrumb as (c: unknown) => unknown)(crumb), "withdrawn: nothing is collected").toBeNull();
    store.set(CONSENT_KEY, "accepted");
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
      "tracePropagationTargets",
      "transport",
    ]);
    // A second schedule or load is the same load.
    facade.scheduleBrowserSentry();
    expect(await facade.loadBrowserSentry()).toBe(true);
    expect(vi.mocked(Sentry.init), "one init per page load").toHaveBeenCalledTimes(1);
  });

  it("without requestIdleCallback (Safari) the load falls back to a timeout and still inits once", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    stubConsent("accepted");
    vi.stubGlobal("requestIdleCallback", undefined);
    await import("../../instrumentation-client");
    const Sentry = await import("@sentry/nextjs");
    await vi.waitFor(() => expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1));
  });

  it("no consent at boot (the empty case), a rejection or an OLD policy version: never fetched; the banner's Accept loads it then, once", async () => {
    let checked = 0;
    for (const [name, choice, version] of [
      ["no choice yet", null, COOKIE_POLICY_VERSION],
      ["rejected", "rejected", COOKIE_POLICY_VERSION],
      ["accepted an old policy version", "accepted", "2000-01-01"],
    ] as const) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
      stubConsent(choice, version);
      const idle = captureIdle();
      await import("../../instrumentation-client");
      const Sentry = await import("@sentry/nextjs");
      await settle();
      expect(idle, `${name}: nothing scheduled`).toHaveLength(0);
      expect(vi.mocked(Sentry.init), `${name}: never fetched`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "anti-vacuity: every no-consent state checked").toBe(3);

    // The visitor now accepts in the banner: its real handler (components/cookie-consent.tsx) loads the client.
    const idle = captureIdle();
    const { recordConsentChoice } = await import("@/components/cookie-consent");
    recordConsentChoice("accepted");
    expect(idle, "the Accept schedules the load on idle").toHaveLength(1);
    idle[0]!();
    const Sentry = await import("@sentry/nextjs");
    await vi.waitFor(() => expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1));
    recordConsentChoice("accepted");
    recordConsentChoice("rejected");
    await settle();
    expect(idle, "a second Accept schedules nothing new").toHaveLength(1);
    expect(vi.mocked(Sentry.init), "one init").toHaveBeenCalledTimes(1);
  });

  it("no DSN (unset, or blank as the CI builds bake it), even with consent: never fetched; the router hook is a no-op that does not throw", async () => {
    let checked = 0;
    for (const dsn of [undefined, ""]) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
      stubConsent("accepted");
      const idle = captureIdle();
      const mod = await import("../../instrumentation-client");
      const facade = await import("@/lib/sentry-browser");
      const Sentry = await import("@sentry/nextjs");
      expect(idle, `DSN ${JSON.stringify(dsn)}: nothing scheduled`).toHaveLength(0);
      expect(await facade.loadBrowserSentry(), `DSN ${JSON.stringify(dsn)}: may not load`).toBe(false);
      expect(() => mod.onRouterTransitionStart("/dashboard", "push")).not.toThrow();
      expect(vi.mocked(Sentry.init)).not.toHaveBeenCalled();
      expect(vi.mocked(Sentry.captureRouterTransitionStart)).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "anti-vacuity: both no-DSN shapes checked").toBe(2);
  });

  it("a load that fails (init throws) never breaks the page: queued and later calls are dropped, and it is not retried", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    stubConsent("accepted");
    const idle = captureIdle();
    const Sentry = await import("@sentry/nextjs");
    vi.mocked(Sentry.init).mockImplementationOnce(() => {
      throw new Error("sdk boom");
    });
    const mod = await import("../../instrumentation-client");
    const facade = await import("@/lib/sentry-browser");
    facade.captureException(new Error("queued before the failed load"));
    idle[0]!();
    expect(await facade.loadBrowserSentry()).toBe(false);
    facade.captureException(new Error("after the failed load"));
    expect(() => mod.onRouterTransitionStart("/dashboard", "push")).not.toThrow();
    facade.scheduleBrowserSentry();
    expect(await facade.loadBrowserSentry(), "no retry").toBe(false);
    expect(vi.mocked(Sentry.init)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });
});

describe("the facade (lib/sentry-browser.ts): a call before, during and after the load", () => {
  it("while the load is pending, calls queue and flush IN ORDER on load; past 20 they are dropped; after the load they go straight through", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    stubConsent("accepted");
    const idle = captureIdle();
    const facade = await import("@/lib/sentry-browser");
    const Sentry = await import("@sentry/nextjs");
    expect(facade.SENTRY_QUEUE_CAP, "the ruled cap (coordinator 2026-11-23: a bounded queue, 20)").toBe(20);
    facade.scheduleBrowserSentry();
    const errors = Array.from({ length: 25 }, (_, i) => new Error(`e${i}`));
    for (const e of errors) facade.captureException(e, { level: "warning" });
    facade.captureRouterTransitionStart("/dashboard", "push");
    expect(vi.mocked(Sentry.captureException), "nothing forwarded before the load").not.toHaveBeenCalled();
    idle[0]!();
    expect(await facade.loadBrowserSentry()).toBe(true);
    const sent = vi.mocked(Sentry.captureException).mock.calls;
    expect(sent.map((c) => (c[0] as Error).message), "the first 20, in order").toEqual(errors.slice(0, 20).map((e) => e.message));
    // AFTER init: a report forwarded to an SDK with no client yet is silently dropped (review m3).
    expect(vi.mocked(Sentry.init).mock.invocationCallOrder[0]!, "init runs before the first queued call is forwarded").toBeLessThan(
      vi.mocked(Sentry.captureException).mock.invocationCallOrder[0]!,
    );
    expect(sent.every((c) => (c[1] as { level: string }).level === "warning"), "each call's own arguments").toBe(true);
    expect(vi.mocked(Sentry.captureRouterTransitionStart), "a navigation before the load is not replayed").not.toHaveBeenCalled();
    facade.captureMessage("realtimekit: room dropped", { level: "warning" });
    facade.addBreadcrumb({ category: "realtimekit", message: "realtimekit: room left" });
    facade.captureRouterTransitionStart("/dashboard", "replace");
    expect(vi.mocked(Sentry.captureMessage)).toHaveBeenCalledWith("realtimekit: room dropped", { level: "warning" });
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledWith({ category: "realtimekit", message: "realtimekit: room left" });
    expect(vi.mocked(Sentry.captureRouterTransitionStart)).toHaveBeenCalledWith("/dashboard", "replace");
  });

  it("with no consent every call is a no-op: nothing is queued, so nothing is sent even once consent arrives", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    const store = stubConsent(null);
    const idle = captureIdle();
    const facade = await import("@/lib/sentry-browser");
    const Sentry = await import("@sentry/nextjs");
    facade.scheduleBrowserSentry();
    facade.captureException(new Error("before consent"));
    facade.captureMessage("before consent");
    facade.addBreadcrumb({ message: "before consent" });
    expect(idle, "no consent: no load scheduled").toHaveLength(0);
    store.set(CONSENT_KEY, "accepted");
    store.set("seazn_cookie_consent_version", COOKIE_POLICY_VERSION);
    facade.scheduleBrowserSentry();
    idle[0]!();
    expect(await facade.loadBrowserSentry()).toBe(true);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.captureMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(Sentry.addBreadcrumb)).not.toHaveBeenCalled();
  });

  it("consent withdrawn between the schedule and the idle callback: nothing loads, and what was queued is dropped", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    const store = stubConsent("accepted");
    const idle = captureIdle();
    const facade = await import("@/lib/sentry-browser");
    const Sentry = await import("@sentry/nextjs");
    facade.scheduleBrowserSentry();
    facade.captureException(new Error("queued"));
    store.set(CONSENT_KEY, "rejected");
    idle[0]!();
    expect(await facade.loadBrowserSentry()).toBe(false);
    expect(vi.mocked(Sentry.init)).not.toHaveBeenCalled();
    // Accepted again: the load happens, and the call queued under the withdrawn consent is not sent.
    store.set(CONSENT_KEY, "accepted");
    facade.scheduleBrowserSentry();
    idle[1]!();
    expect(await facade.loadBrowserSentry()).toBe(true);
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });

  it("a Reject then an Accept before the SDK loads: nothing queued before the Reject or made while rejected is sent; what follows the Accept is", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", TEST_DSN);
    stubConsent("accepted");
    const idle = captureIdle();
    const facade = await import("@/lib/sentry-browser");
    const { recordConsentChoice } = await import("@/components/cookie-consent");
    const Sentry = await import("@sentry/nextjs");
    facade.scheduleBrowserSentry();
    facade.captureException(new Error("queued before the Reject"));
    facade.addBreadcrumb({ message: "crumb queued before the Reject" });
    recordConsentChoice("rejected");
    facade.captureException(new Error("made while rejected"));
    facade.addBreadcrumb({ message: "crumb made while rejected" });
    recordConsentChoice("accepted");
    expect(idle, "the load was already pending: the Accept schedules nothing new").toHaveLength(1);
    facade.captureException(new Error("made after the re-accept"));
    idle[0]!();
    expect(await facade.loadBrowserSentry()).toBe(true);
    expect(vi.mocked(Sentry.captureException).mock.calls.map((c) => (c[0] as Error).message), "only what follows the Accept").toEqual(["made after the re-accept"]);
    expect(vi.mocked(Sentry.addBreadcrumb), "no breadcrumb from before the Accept").not.toHaveBeenCalled();
  });
});

describe("the consent gate at send: once loaded, nothing leaves without consent against the CURRENT policy version", () => {
  it("reads consent at every send, so a withdrawal acts at once and a policy bump revokes; the empty case sends nothing", async () => {
    const options = await bootBrowserSentry();
    const Sentry = await import("@sentry/nextjs");
    const store = stubConsent(null);
    const transport = (options.transport as (o: unknown) => { send(e: unknown): PromiseLike<unknown>; flush(t?: number): PromiseLike<boolean> })({
      url: "https://o0.ingest.sentry.io/api/0/envelope/",
      recordDroppedEvent: () => undefined,
    });
    expect(vi.mocked(Sentry.makeFetchTransport), "the SDK's own fetch transport does the sending").toHaveBeenCalledTimes(1);
    const envelope = [{ event_id: "e1" }, [[{ type: "event" }, { message: "boom" }]]];
    const steps: [string, () => void, boolean][] = [
      ["no choice (the empty case)", () => store.clear(), false],
      ["rejected", () => (store.set(CONSENT_KEY, "rejected"), store.set("seazn_cookie_consent_version", COOKIE_POLICY_VERSION)), false],
      ["accepted an OLD policy version", () => (store.set(CONSENT_KEY, "accepted"), store.set("seazn_cookie_consent_version", "2000-01-01")), false],
      ["accepted the current version", () => store.set("seazn_cookie_consent_version", COOKIE_POLICY_VERSION), true],
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
    expect(expectedSends, "anti-vacuity: the gate opened").toBe(3);
    await expect(transport.flush(5)).resolves.toBe(true);
    expect(fakeTransport.flush).toHaveBeenCalledWith(5);
  });
});

// The first-load JS must not carry the SDK (coordinator 2026-11-23). A file reached from a client root by imports is bundled
// for the browser; one runtime import of @sentry/* in any of them puts SDK code in a client chunk.
describe("source scans", () => {
  const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const SRC = path.join(WEB, "src");
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
  /** Code only: comment lines (`//`, `/*`, ` *`) out. Line-based on purpose: a regex that strips block comments also eats code
   *  between a `/*` and a `*\/` inside two strings (a glob), hiding what it should find. */
  const code = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
  const hasDirective = (src: string, d: string) => new RegExp(`^(\\s*(//[^\\n]*|/\\*[\\s\\S]*?\\*/))*\\s*["']${d}["']`).test(src);

  type Dep = { spec: string; dynamic: boolean };
  /** Runtime imports: `import … from`, `export … from`, a bare `import "x"`, and `import("x")`. `import type` / `export type`
   *  and an all-`type` specifier list are erased by the compiler, so they are not. */
  function runtimeDeps(src: string): Dep[] {
    const out: Dep[] = [];
    const fromRe = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
    for (let m = fromRe.exec(src); m; m = fromRe.exec(src)) {
      if (m[1]) continue;
      const braces = m[2]!.match(/^\{([\s\S]*)\}$/);
      if (braces && braces[1]!.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
      out.push({ spec: m[3]!, dynamic: false });
    }
    const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
    for (let m = bare.exec(src); m; m = bare.exec(src)) out.push({ spec: m[1]!, dynamic: false });
    const dyn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    for (let m = dyn.exec(src); m; m = dyn.exec(src)) out.push({ spec: m[1]!, dynamic: true });
    return out;
  }
  const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
  function resolveLocal(from: string, spec: string): string | null {
    const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of EXTS) if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
    return null;
  }

  const LAZY = "src/lib/sentry-browser-sdk.ts";
  const FACADE = "src/lib/sentry-browser.ts";
  /** Walk the import graph from every client root ("use client" files and instrumentation-client.ts). `followDynamic` false is
   *  the FIRST-LOAD graph: only static imports put code in a page's first-load chunks; an import() is its own chunk. */
  function clientWalk(followDynamic: boolean) {
    const roots = sources(SRC).filter((f) => hasDirective(readFileSync(f, "utf8"), "use client"));
    roots.push(path.join(SRC, "instrumentation-client.ts"));
    const reached = new Set<string>();
    const stack = [...roots];
    const sdkImports: string[] = [];
    const dynamicEdges: string[] = [];
    while (stack.length) {
      const file = stack.pop()!;
      if (reached.has(file)) continue;
      reached.add(file);
      if (hasDirective(readFileSync(file, "utf8"), "use server")) continue; // a server action is a reference on the client
      for (const dep of runtimeDeps(code(file))) {
        if (dep.spec.startsWith("@sentry/")) sdkImports.push(`${path.relative(WEB, file)} ${dep.dynamic ? "import()" : "static"} ${dep.spec}`);
        const next = resolveLocal(file, dep.spec);
        if (next && dep.dynamic) dynamicEdges.push(`${path.relative(WEB, file)} -> ${path.relative(WEB, next)}`);
        if (next && (followDynamic || !dep.dynamic)) stack.push(next);
      }
    }
    return { roots, reached, sdkImports, dynamicEdges };
  }
  const rel = (files: Set<string>) => new Set([...files].map((f) => path.relative(WEB, f)));

  it("the first-load graph: no client-reachable file imports @sentry/* at runtime, and the lazy SDK module is not in it", () => {
    const { roots, reached, sdkImports } = clientWalk(false);
    expect(roots.length, "anti-vacuity: client roots").toBeGreaterThan(100);
    expect(reached.size, "anti-vacuity: files statically reachable from a client root").toBeGreaterThan(500);
    const reachedRel = rel(reached);
    for (const via of [FACADE, "src/lib/replay-guard.ts", "src/components/cookie-consent.tsx", "src/app/global-error.tsx", "src/components/public-site/match-room/camera-loader.ts", "src/components/v2/match-day/online/arbiter-camera.ts"]) {
      expect(reachedRel.has(via), `the walk reaches ${via}`).toBe(true);
    }
    expect(sdkImports, "no runtime @sentry/* import anywhere in the first-load graph").toEqual([]);
    expect(reachedRel.has(LAZY), `${LAZY} is reached only through an import()`).toBe(false);
    // The matcher's positive pair: the server config's runtime import IS seen.
    expect(runtimeDeps(code(path.join(WEB, "sentry.server.config.ts"))).map((d) => d.spec)).toContain("@sentry/nextjs");
  });

  it("with the import() edges followed: the only client module that imports @sentry/* is the lazy SDK module, and only the facade loads it", () => {
    const { reached, sdkImports, dynamicEdges } = clientWalk(true);
    expect(rel(reached).has(LAZY), "anti-vacuity: the full walk reaches the lazy module").toBe(true);
    expect(sdkImports).toEqual([`${LAZY} static @sentry/nextjs`]);
    expect(dynamicEdges.filter((e) => e.endsWith(`-> ${LAZY}`))).toEqual([`${FACADE} -> ${LAZY}`]);
    // Named imports only: an import of the whole namespace (or an import() of the package) cannot be tree-shaken, and that chunk
    // carried Replay and rrweb (measured 2026-11-23).
    expect(code(path.join(WEB, LAZY))).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s*["']@sentry\/|import\(\s*["']@sentry\//);
  });

  it("init: the server and edge configs call Sentry.init; the browser's one init is the lazy SDK module's; sentry.client.config is gone", () => {
    const files = sources(WEB);
    expect(files.length, "anti-vacuity: the app's source files were scanned").toBeGreaterThan(1000);
    const sentryInit: Record<string, number> = {};
    const browserInit: Record<string, number> = {};
    for (const file of files) {
      const src = code(file);
      const a = (src.match(/\bSentry\.init\s*\(/g) ?? []).length + (/import\s*\{[^}]*\binit\b[^}]*\}\s*from\s*["']@sentry\//.test(src) ? 1 : 0);
      const b = (src.match(/\binit\(\s*browserSentryOptions\(/g) ?? []).length;
      if (a) sentryInit[path.relative(WEB, file)] = a;
      if (b) browserInit[path.relative(WEB, file)] = b;
    }
    expect(sentryInit).toEqual({ "sentry.edge.config.ts": 1, "sentry.server.config.ts": 1, [LAZY]: 1 });
    expect(browserInit).toEqual({ [LAZY]: 1 });
    for (const dead of ["sentry.client.config.ts", "sentry.client.config.js"]) {
      expect(existsSync(path.join(WEB, dead)), `${dead}: webpack-only, and a second client init if a webpack build ever ran`).toBe(false);
    }
  });

  it("no source builds a Replay integration (owner 2026-11-23: no session replay)", () => {
    const files = sources(WEB);
    expect(files.length, "anti-vacuity: the app's source files were scanned").toBeGreaterThan(1000);
    expect(files.filter((f) => /\breplay(Canvas)?Integration\s*\(/.test(code(f))).map((f) => path.relative(WEB, f))).toEqual([]);
  });
});
