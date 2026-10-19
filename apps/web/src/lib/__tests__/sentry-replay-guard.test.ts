// #988 round 3: Sentry Replay records the page's URL in more places than the scrubber has a hook for. This file proves, against
// the INSTALLED @sentry/replay source and the SDK's own pipeline, where each field is written, which defence reaches it, and
// that the defence holds for every credential page the scrubber knows.
//
//  - what a hook can reach: Custom frames (`beforeAddRecordingEvent` -> `recordingEventHook`) and the `replay_event`
//    (`urls`, `request.url`, `request.headers.Referer`, via the ScrubScoreTokens event processor);
//  - what no hook can reach (rrweb's Meta frame `href`, the DOM snapshot and its mutations): the replay does not run on a page
//    whose URL holds a credential (`holdsCredential` = the scrubber's own predicate), and blocks `.ph-no-capture` elements.
//
// STATUS: session replay is OFF (owner decision 2026-10-19; sentry-client-init.test.ts pins that the init registers none). The
// guard is inert and READY, not dead: every test here still drives it against the installed SDK, so the day a replay is turned
// back on it is the guard that was proven, not a stale one.
//
// The page URLs come from the real minters and route builders over `_fake-sql` (the same rig as scrub-score-url-wiring.test).
// There is no DOM in this suite, so the recorder itself (rrweb) is not run: the premises it can only be read from are PINNED to
// the installed source, and the parts that can run for real (the `replayIntegration` constructor, `BrowserClient`,
// `httpContextIntegration`, `core.prepareEvent`) do.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayFrameEvent } from "@sentry/nextjs";
import {
  REPLAY_BLOCK_SELECTORS,
  REPLAY_INTEGRATION_NAME,
  recordingEventHook,
  replayMayRunAt,
  stopReplayBeforeNavigatingTo,
  type StoppableReplay,
} from "@/lib/replay-guard";
import { holdsCredential, scrubScoreTokensIntegration, scrubScoreUrl } from "@/lib/scrub-score-url";
import { ORIGIN, TOKEN, credentialPages, setReplay } from "./_replay-fixtures";

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("./_fake-sql")).fakeSql,
}));
vi.mock("@sentry/nextjs", () => ({ getClient: vi.fn(), captureRouterTransitionStart: vi.fn() }));

// ---- the installed SDK, loaded through the packages that depend on it (this also bypasses the mock above) ----
const fromNextjs = createRequire(createRequire(import.meta.url).resolve("@sentry/nextjs"));
const fromReact = createRequire(fromNextjs.resolve("@sentry/react"));
const browser = fromReact("@sentry/browser") as {
  replayIntegration(options: Record<string, unknown>): StoppableReplay & { name: string; _recordingOptions: Record<string, unknown> };
  BrowserClient: new (options: Record<string, unknown>) => { init(): void; emit(name: string, ...args: unknown[]): void; getOptions(): unknown };
  httpContextIntegration(): unknown;
  defaultStackParser: unknown;
};
const core = fromReact("@sentry/core") as {
  prepareEvent(options: unknown, event: unknown, hint: unknown, scope: unknown, client: unknown, isolationScope: unknown): Promise<Record<string, unknown> | null>;
  getCurrentScope(): unknown;
  getIsolationScope(): unknown;
};
const replayEntry = createRequire(fromReact.resolve("@sentry/browser")).resolve("@sentry/replay");
const REPLAY_SRC = readFileSync(replayEntry, "utf8");
const REPLAY_PKG = JSON.parse(readFileSync(path.join(path.dirname(replayEntry), "../../../package.json"), "utf8")) as { name: string; version: string };
const nextjsClientEntry = fromNextjs(path.join(path.dirname(fromNextjs.resolve("@sentry/nextjs")), "index.client.js")) as Record<string, unknown>;

/** Pages that carry no credential: the replay may run on them. */
const ORDINARY_PAGES = [
  `${ORIGIN}/`,
  `${ORIGIN}/dashboard`,
  `${ORIGIN}/fr/pricing`,
  `${ORIGIN}/login`,
  `${ORIGIN}/login?next=%2Fdashboard`,
  `${ORIGIN}/claim/`,
  `${ORIGIN}/magic-link`,
  `${ORIGIN}/magic-link?next=%2Fdashboard`,
  `${ORIGIN}/shared/chess-club/autumn-open/open/fixtures/00000000-0000-4000-8000-000000000003`,
  `${ORIGIN}/o/acme/c/spring/d/open/join/claim`,
  "/dashboard",
  "/",
];

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const fakeReplay = (stop: () => Promise<void> = async () => undefined) => ({ stop: vi.fn(stop) });

// ---- Custom frames, in the shapes @sentry/replay 10.62 writes (createPerformanceSpans, the breadcrumb listener) ----
const span = (op: string, description: string, data?: Record<string, unknown>): ReplayFrameEvent =>
  ({ type: 5, timestamp: 1_700_000_000, data: { tag: "performanceSpan", payload: { op, description, startTimestamp: 1_700_000_000, endTimestamp: 1_700_000_001, data } } }) as ReplayFrameEvent;
const crumb = (category: string, extra: Record<string, unknown>): ReplayFrameEvent =>
  ({ type: 5, timestamp: 1_700_000_000_000, data: { tag: "breadcrumb", payload: { timestamp: 1_700_000_000, type: "default", category, ...extra } } }) as ReplayFrameEvent;
const historyFrame = (to: string, previous?: string) => span("navigation.push", to, { previous });
const navigateFrame = (url: string) => span("navigation.navigate", url, { size: 1, type: "navigate" });
const navigationCrumb = (from: string, to: string) => crumb("navigation", { data: { from, to } });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("premises: where @sentry/replay writes a page URL (pinned to the installed source)", () => {
  it("is the version these pins were read from (a bump means re-reading the source below)", () => {
    expect(REPLAY_PKG).toMatchObject({ name: "@sentry/replay", version: "10.62.0" });
  });

  it("writes the page URL into rrweb's Meta frame, a frame beforeAddRecordingEvent never receives", () => {
    expect(REPLAY_SRC).toMatch(/type: EventType\.Meta,\s*data: \{\s*href: window\.location\.href/);
    // Custom is 5, and the callback is applied to Custom events only, at the single place events are added.
    expect(REPLAY_SRC).toContain('EventType2[EventType2["Custom"] = 5] = "Custom"');
    expect(REPLAY_SRC).toMatch(/function isCustomEvent\(event\) \{\s*return event\.type === EventType\.Custom;\s*\}/);
    expect(REPLAY_SRC).toMatch(/typeof callback === "function" && isCustomEvent\(event\)/);
    expect(REPLAY_SRC.match(/maybeApplyCallback\(event, replayOptions\.beforeAddRecordingEvent\)/g), "one call site").toHaveLength(1);
  });

  it("drops a frame the hook returns null for, before the event buffer sees it", () => {
    expect(REPLAY_SRC).toMatch(/if \(!eventAfterPossibleCallback\) \{\s*return;\s*\}\s*return await eventBuffer\.addEvent\(eventAfterPossibleCallback\)/);
  });

  it("builds a Custom performanceSpan from op/description/start/end/data (the shape the frame fixtures use)", () => {
    expect(REPLAY_SRC).toMatch(
      /type: EventType\.Custom,\s*timestamp: start,\s*data: \{\s*tag: "performanceSpan",\s*payload: \{\s*op: type,\s*description: name,\s*startTimestamp: start,\s*endTimestamp: end,\s*data\s*\}/,
    );
    expect(REPLAY_SRC).toMatch(/tag: "breadcrumb",[^}]*payload: core\.normalize\(breadcrumb, 10, 1e3\)/s);
  });

  it("names the TARGET url in a history span, and also lists it in replay_event.urls", () => {
    expect(REPLAY_SRC).toMatch(/browserUtils\.addHistoryInstrumentationHandler\(handleHistorySpanListener\(replay\)\)/);
    expect(REPLAY_SRC).toMatch(/function handleHistory\(handlerData\) \{\s*const \{ from, to \} = handlerData;[\s\S]*?type: "navigation\.push",[\s\S]*?name: to,\s*data: \{\s*previous: from\s*\}/);
    expect(REPLAY_SRC).toContain("replay.getContext().urls.push(result.name)");
    // The first page: origin + path + hash + search.
    expect(REPLAY_SRC).toMatch(/const url = `\$\{WINDOW\.location\.origin\}\$\{urlPath\}`;[\s\S]*?this\._context\.urls\.push\(url\)/);
  });

  it("sends replay_event through core.prepareEvent (event processors run) and never through beforeSend", () => {
    expect(REPLAY_SRC).toMatch(/client\.emit\("preprocessEvent", event, eventHint\);\s*const preparedEvent = await core\.prepareEvent\(/);
    expect(REPLAY_SRC).toMatch(/type: REPLAY_EVENT_NAME,[\s\S]*?urls,\s*replay_id: replayId,/);
    // The only `beforeSend*` names are client hooks it LISTENS on, for error and feedback events (adding the replay id); it never
    // calls the app's `beforeSend` option, which therefore never sees a replay_event.
    expect(REPLAY_SRC.match(/[A-Za-z_.]*beforeSend[A-Za-z_]*/g)).toEqual(["beforeSendEvent", "beforeSendFeedback"]);
    expect(REPLAY_SRC).toContain('client.on("beforeSendEvent", handleBeforeSendEvent(replay))');
  });

  it("captures no network bodies or headers unless the app opts in with networkDetailAllowUrls, and blocks only what it is told to", () => {
    expect(REPLAY_SRC).toContain("networkDetailAllowUrls = []");
    expect(REPLAY_SRC).toContain("block = []");
    expect(REPLAY_SRC).toContain("unblock = []");
    expect(REPLAY_SRC).toMatch(/blockSelector: getOption\(block, \[/);
  });

  it("is stopped with the integration's public stop(), found by name on the client as getReplay() does; a repeated stop is a no-op", () => {
    // replay-guard spells out getReplay()'s body (getClient()?.getIntegrationByName("Replay")) instead of importing getReplay,
    // which would drag @sentry/replay and rrweb into every page's first-load chunk.
    expect(REPLAY_SRC).toMatch(/function getReplay\(\) \{\s*const client = core\.getClient\(\);\s*return client\?\.getIntegrationByName\("Replay"\);/);
    expect(REPLAY_INTEGRATION_NAME).toBe("Replay");
    expect(browser.replayIntegration({}).name, "the real integration registers under that name").toBe(REPLAY_INTEGRATION_NAME);
    expect(REPLAY_SRC).toMatch(/async stop\(\{\s*forceFlush = false,\s*reason\s*\} = \{\}\) \{\s*if \(!this\._isEnabled\) \{\s*return;\s*\}/);
  });

  it("is reachable from @sentry/nextjs's client entry: getClient (the guard) and replayIntegration (what an init would register if a replay is turned back on; today's init registers none)", () => {
    expect(typeof nextjsClientEntry.getClient).toBe("function");
    expect(typeof nextjsClientEntry.replayIntegration).toBe("function");
  });
});

describe("the block option, on the real replayIntegration", () => {
  it("adds the secret-painter class to what rrweb blocks, keeping Sentry's defaults", () => {
    const replay = browser.replayIntegration({ maskAllText: true, blockAllMedia: true, block: REPLAY_BLOCK_SELECTORS });
    const selectors = String(replay._recordingOptions.blockSelector).split(",");
    expect(REPLAY_BLOCK_SELECTORS).toEqual([".ph-no-capture"]);
    expect(selectors).toContain(".ph-no-capture");
    expect(selectors, "Sentry's own default is still there").toContain(".sentry-block");
    expect(replay._recordingOptions.unblockSelector, "nothing un-blocks it").toBe("");
    // Control: without the option the class is NOT blocked, so the assertion above sees the option and not a default.
    const bare = browser.replayIntegration({ maskAllText: true, blockAllMedia: true });
    expect(String(bare._recordingOptions.blockSelector).split(",")).not.toContain(".ph-no-capture");
  });

  it("is the class the painter scan requires on every element that paints a scrubbed secret", () => {
    const painters = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "scrub-secret-painters.test.ts"), "utf8");
    expect(painters).toContain('const CLASS = "ph-no-capture"');
    expect(REPLAY_BLOCK_SELECTORS).toEqual([".ph-no-capture"]);
  });
});

describe("holdsCredential and replayMayRunAt: the scrubber is the authority on which page is secret", () => {
  it("holds for every credential page, plain, locale-prefixed, as a router href, signed in with a next, with a hash", async () => {
    const pages = await credentialPages();
    expect(pages.length, "anti-vacuity: pages checked").toBeGreaterThanOrEqual(12);
    for (const p of pages) {
      expect(holdsCredential(p.url), `${p.name}: ${p.url}`).toBe(true);
      expect(replayMayRunAt(p.url), `${p.name}: the replay does not run`).toBe(false);
    }
  });

  it("does not hold for an ordinary page (the empty case: no credential, no change), and a server render has no page at all", () => {
    expect(ORDINARY_PAGES.length).toBeGreaterThanOrEqual(10);
    for (const url of ORDINARY_PAGES) {
      expect(holdsCredential(url), url).toBe(false);
      expect(replayMayRunAt(url), url).toBe(true);
    }
    expect(replayMayRunAt(undefined)).toBe(true);
  });

  it("is the scrubber's verdict page by page: a page is credential-bearing exactly when scrubbing changes it", async () => {
    const pages = await credentialPages();
    for (const p of pages) {
      const scrubbed = scrubScoreUrl(p.url);
      expect(scrubbed, p.name).not.toBe(p.url);
      for (const secret of p.secrets) expect(scrubbed, p.name).not.toContain(secret);
    }
    for (const url of ORDINARY_PAGES) expect(scrubScoreUrl(url), url).toBe(url);
  });
});

describe("recordingEventHook (beforeAddRecordingEvent)", () => {
  it("lets a frame through untouched on an ordinary page, stopping nothing", async () => {
    const replay = fakeReplay();
    const frames = [
      historyFrame(`${ORIGIN}/dashboard`, `${ORIGIN}/`),
      navigateFrame(`${ORIGIN}/dashboard`),
      navigationCrumb("/", "/dashboard"),
      span("resource.fetch", `${ORIGIN}/api/v1/fixtures`, { method: "GET", statusCode: 200 }),
      crumb("console", { level: "log", message: "hello", data: { logger: "console" } }),
      crumb("ui.click", { message: "button#save", data: { nodeId: 4 } }),
    ];
    for (const frame of frames) expect(recordingEventHook(structuredClone(frame), replay)).toEqual(frame);
    await flush();
    expect(frames).toHaveLength(6);
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("scrubs a credential inside a frame that is not a navigation, and keeps the frame", async () => {
    const replay = fakeReplay();
    const pages = await credentialPages();
    let checked = 0;
    for (const p of pages) {
      const frames = [
        span("resource.fetch", p.url, { method: "POST", statusCode: 200 }),
        span("resource.xhr", `${ORIGIN}/api/claims/${p.secrets[0]}/accept`, { method: "POST" }),
        crumb("console", { level: "error", message: `Failed to fetch ${p.url}`, data: { logger: "console" } }),
      ];
      for (const frame of frames) {
        const out = recordingEventHook(structuredClone(frame), replay);
        expect(out, `${p.name}: kept`).not.toBeNull();
        const text = JSON.stringify(out);
        for (const secret of p.secrets) expect(text, p.name).not.toContain(secret);
        expect(text).toContain("[token]");
        checked++;
      }
    }
    await flush();
    expect(checked, "anti-vacuity").toBe(pages.length * 3);
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("stops the replay and drops the frame when a navigation names a credential page (the router can arrive there unannounced)", async () => {
    const pages = await credentialPages();
    let checked = 0;
    for (const p of pages) {
      for (const [form, frame] of [
        ["history span", historyFrame(p.url, `${ORIGIN}/`)],
        ["navigate span", navigateFrame(p.url)],
        ["navigation breadcrumb", navigationCrumb("/", p.url)],
      ] as const) {
        const replay = fakeReplay();
        expect(recordingEventHook(structuredClone(frame), replay), `${p.name} / ${form}: dropped`).toBeNull();
        await flush();
        expect(replay.stop, `${p.name} / ${form}: stopped once`).toHaveBeenCalledTimes(1);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(pages.length * 3);
  });

  it("keeps the frame when the app LEAVES a credential page, with the page it left scrubbed", async () => {
    const replay = fakeReplay();
    const [first] = await credentialPages();
    const out = recordingEventHook(historyFrame(`${ORIGIN}/dashboard`, first!.url), replay);
    await flush();
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).toContain("/score/[token]");
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("is safe with no replay at all (Sentry not initialised)", async () => {
    const [first] = await credentialPages();
    setReplay(undefined);
    expect(recordingEventHook(historyFrame(first!.url), undefined)).toBeNull();
    await flush();
  });

  // vitest reports an unhandled rejection as a run error (exit 1) while the JSON still says "passed": the run goes red and
  // no test does. A listener turns it into a failing assertion in the test that caused it.
  it("swallows a stop() that rejects or throws: no unhandled rejection escapes", async () => {
    const [first] = await credentialPages();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => void seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const stop of [() => Promise.reject(new Error("stop rejected")), () => { throw new Error("stop threw"); }]) {
        const failing = fakeReplay(stop as () => Promise<void>);
        expect(recordingEventHook(historyFrame(first!.url), failing)).toBeNull();
        expect(stopReplayBeforeNavigatingTo(first!.url, failing)).toBe(true);
        await flush();
        await flush();
        expect(failing.stop).toHaveBeenCalledTimes(2);
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen.map(String)).toEqual([]);
  });

  it("does not throw on a frame shape it does not know (a throw makes the SDK drop the frame without a word)", async () => {
    const replay = fakeReplay();
    const odd = [
      { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: { description: `${ORIGIN}/score/${TOKEN}` } } },
      { type: 5, timestamp: 1, data: { tag: "performanceSpan", payload: null } },
      { type: 5, timestamp: 1, data: { tag: "breadcrumb", payload: { category: "navigation" } } },
      { type: 5, timestamp: 1, data: { tag: "options", payload: { shouldRecordCanvas: false } } },
      { type: 5, timestamp: 1 },
    ];
    for (const frame of odd) expect(() => recordingEventHook(frame as unknown as ReplayFrameEvent, replay)).not.toThrow();
    // A span with no `op` is not a navigation: it is scrubbed and kept.
    const kept = recordingEventHook(odd[0] as unknown as ReplayFrameEvent, replay);
    expect(JSON.stringify(kept)).not.toContain(TOKEN);
    await flush();
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("asks the client's Replay integration (found by name) to stop when none is passed", async () => {
    const [first] = await credentialPages();
    const replay = fakeReplay();
    setReplay(replay);
    expect(recordingEventHook(historyFrame(first!.url))).toBeNull();
    await flush();
    expect(replay.stop).toHaveBeenCalledTimes(1);
    setReplay(undefined);
    expect(recordingEventHook(historyFrame(first!.url))).toBeNull();
    await flush();
    expect(replay.stop, "no replay found: nothing more to stop").toHaveBeenCalledTimes(1);
  });
});

describe("stopReplayBeforeNavigatingTo (onRouterTransitionStart)", () => {
  it("stops the replay for every credential href and for none of the ordinary ones", async () => {
    const pages = await credentialPages();
    for (const p of pages) {
      const replay = fakeReplay();
      expect(stopReplayBeforeNavigatingTo(p.url, replay), p.name).toBe(true);
      await flush();
      expect(replay.stop, p.name).toHaveBeenCalledTimes(1);
    }
    for (const url of ORDINARY_PAGES) {
      const replay = fakeReplay();
      expect(stopReplayBeforeNavigatingTo(url, replay), url).toBe(false);
      await flush();
      expect(replay.stop, url).not.toHaveBeenCalled();
    }
    expect(pages.length + ORDINARY_PAGES.length).toBeGreaterThanOrEqual(22);
  });

  it("calls stop() on a REAL Replay integration, and on the one the client holds", async () => {
    const [first] = await credentialPages();
    const real = browser.replayIntegration({ maskAllText: true });
    const stop = vi.spyOn(real, "stop");
    expect(stopReplayBeforeNavigatingTo(first!.url, real)).toBe(true);
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    setReplay(real);
    expect(stopReplayBeforeNavigatingTo(first!.url)).toBe(true);
    await flush();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("does nothing, and does not throw, when Sentry has no client or the client has no Replay (every client today: replay is off)", async () => {
    const { getClient } = await import("@sentry/nextjs");
    const [first] = await credentialPages();
    setReplay(undefined);
    expect(stopReplayBeforeNavigatingTo(first!.url)).toBe(true);
    vi.mocked(getClient).mockReturnValue({ getIntegrationByName: () => undefined } as never);
    expect(stopReplayBeforeNavigatingTo(first!.url)).toBe(true);
    await flush();
  });
});

describe("replay_event, through the SDK's own pipeline: BrowserClient, httpContextIntegration, core.prepareEvent", () => {
  /** A replay_event as `sendReplayRequest` builds it (baseEvent), prepared as `prepareReplayEvent` does. */
  async function prepared(urls: string[], page: string, referrer: string, scrub: boolean): Promise<Record<string, unknown>> {
    vi.stubGlobal("document", { addEventListener() {}, location: { href: page }, referrer });
    const client = new browser.BrowserClient({
      dsn: "https://key@o1.ingest.sentry.io/1",
      integrations: scrub ? [browser.httpContextIntegration(), scrubScoreTokensIntegration()] : [browser.httpContextIntegration()],
      stackParser: browser.defaultStackParser,
      transport: () => ({ send: async () => ({}), flush: async () => true }),
    });
    client.init();
    const event = {
      type: "replay_event",
      replay_start_timestamp: 1_700_000_000,
      timestamp: 1_700_000_060,
      error_ids: [],
      trace_ids: [],
      urls,
      replay_id: "0123456789abcdef0123456789abcdef",
      segment_id: 0,
      replay_type: "session",
    };
    const hint = { event_id: event.replay_id };
    client.emit("preprocessEvent", event, hint);
    const out = await core.prepareEvent(client.getOptions(), event, hint, core.getCurrentScope(), client, core.getIsolationScope());
    expect(out, "an event processor did not drop it").not.toBeNull();
    return out!;
  }

  it("carries the credential in urls, request.url and the Referer header when nothing scrubs it (control)", async () => {
    const [first, second] = await credentialPages();
    const out = await prepared([first!.url, second!.url], first!.url, second!.url, false);
    const text = JSON.stringify(out);
    expect((out.urls as string[]).join(" ")).toContain(first!.secrets[0]);
    expect((out.request as { url: string }).url).toContain(first!.secrets[0]);
    expect((out.request as { headers: Record<string, string> }).headers.Referer).toContain(second!.secrets[0]);
    expect(text).toContain(second!.secrets[0]);
  });

  it("is scrubbed by the ScrubScoreTokens event processor, for every credential page", async () => {
    const pages = await credentialPages();
    const secrets = pages.flatMap((p) => p.secrets);
    let checked = 0;
    for (const p of pages) {
      const other = pages[(pages.indexOf(p) + 1) % pages.length]!;
      const out = await prepared([p.url, other.url], p.url, other.url, true);
      const text = JSON.stringify(out);
      for (const secret of secrets) expect(text, `${p.name}: ${secret}`).not.toContain(secret);
      expect((out.urls as string[]).every((u) => u !== p.url), `${p.name}: urls changed`).toBe(true);
      expect((out.request as { url: string }).url, `${p.name}: request.url`).not.toBe(p.url);
      expect((out.request as { headers: Record<string, string> }).headers.Referer, `${p.name}: Referer`).not.toBe(other.url);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(pages.length);
  });

  it("leaves an ordinary replay_event as it was", async () => {
    const out = await prepared([`${ORIGIN}/dashboard`, `${ORIGIN}/`], `${ORIGIN}/dashboard`, `${ORIGIN}/`, true);
    expect(out.urls).toEqual([`${ORIGIN}/dashboard`, `${ORIGIN}/`]);
    expect((out.request as { url: string }).url).toBe(`${ORIGIN}/dashboard`);
  });
});
