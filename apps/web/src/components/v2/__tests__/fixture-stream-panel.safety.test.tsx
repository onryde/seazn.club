// Phase 0 (YouTube channel safety) Task 4: the pre-Go-live notice, through the REAL container (`PhoneTab`, driven with `renderIsland` and a
// doubled v1 transport) — what it asks, and when. A sibling of fixture-stream-panel.test.tsx (459 KB; its harness is private to it).
// `apps/web` vitest is `environment: "node"`: layout, tap area and the cascade are the e2e's (e2e/stream-channel-safety.spec.ts).
//
// Sport: not applicable — the Phone tab reads no sport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf, walk, expandWithHooks, textOf } from "@/components/__tests__/_hook-harness";
import { defaultTemplateFor } from "@/components/overlay/template-registry";
import { messages, type MessageKey } from "@/lib/messages";
import type { StreamPhone, StreamTarget } from "@/server/api-v1/schemas";
import type { StreamSessionView } from "@/lib/stream-session-view";
import { LOCALES } from "@/lib/i18n-constants";
import { YOUTUBE_SAFETY_CLIENT_TIMEOUT_MS } from "@/lib/youtube";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PhoneTab, PhoneTabBody, type PhoneScore, type PhoneTabBodyProps } from "@/components/v2/fixture-stream-panel";
import { ChannelSafetyNotice, needsChannelCheck } from "@/components/v2/stream-channel-safety";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(async () => ({}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/billing-checkout-client", () => ({ fetchRelayCheckoutClientSecret: vi.fn() }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: async () => ({ src: "data:image/svg+xml;charset=utf-8,x", modules: 57 }),
}));
const provided = vi.hoisted(() => ({ view: null as StreamSessionView | null }));
vi.mock("@/components/v2/stream-session-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/v2/stream-session-provider")>()),
  useProvidedPhoneSession: () => (provided.view === null ? null : { view: provided.view }),
}));

const m = (k: MessageKey): string => messages[k] as string;
const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => attr(el, "data-testid") === id);

const SCORE_OFF: PhoneScore = {
  available: false, stored: null, template: defaultTemplateFor("football"), delayMs: null, sportKey: "football", editor: null,
  modeFailed: false, onMode: () => {},
};
const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const, phoneLostMinutes: 20, autoStopMinutes: 3, tz: "Europe/London", score: SCORE_OFF };
const CURRENT = "GET /api/v1/fixtures/f-1/stream-sessions/current";
const PHONE = "GET /api/v1/fixtures/f-1/stream-phone";
const TARGETS_URL = "GET /api/v1/orgs/o-1/stream-targets";
const CREATE = "POST /api/v1/fixtures/f-1/stream-sessions";
const SAFETY = "GET /api/v1/orgs/o-1/youtube-connections/c-1/safety";

const phoneRead = (court: StreamPhone["court"] = null): StreamPhone => ({
  code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "active", endCause: null },
  phone: {
    present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator", state: "paired", notReady: null,
    notReadyShown: false, health: null, startFailed: null, lastBeatAt: "2026-09-14T11:59:55.000Z", elapsedMs: 5_000,
    beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false,
  },
  destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null, court,
});
const YT = { connectionId: "c-1", channelId: "UC7xK2mQ9rVbN4tLpA1sZ0wE", channelTitle: "Club", privacy: "unlisted" as const, madeForKids: false, status: "connected" as const, liveState: "enabled" as const, termsOutdated: false, openBroadcasts: 0 };
const target = (id: string, youtube: StreamTarget["youtube"]): StreamTarget => ({
  id, kind: youtube ? "youtube" : "twitch", label: id, watchUrl: null, createdAt: "2026-09-01T10:00:00.000Z", keyHint: youtube ? null : "abc", inUse: null, youtube,
});

type Server = { targets: StreamTarget[]; safety?: () => unknown; court?: StreamPhone["court"] };
function serve(s: Server) {
  apiV1.mockImplementation(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const key = `${options?.method ?? "GET"} ${url}`;
    if (key === CURRENT) return null;
    if (key === PHONE) return structuredClone(phoneRead(s.court ?? null));
    if (key === TARGETS_URL) return structuredClone(s.targets);
    if (key === SAFETY) return s.safety!();
    if (key === "PUT /api/v1/fixtures/f-1/stream-settings") return { targetId: null };
    if (key === CREATE) return { sessionId: "s1" };
    throw new Error(`unrouted ${key}`);
  });
}
const calls = (): string[] => apiV1.mock.calls.map(([url, o]) => `${o?.method ?? "GET"} ${url}`);
const count = (key: string): number => calls().filter((c) => c === key).length;
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1); };
const bodyOf = (island: { tree: () => ReactElement[] }): PhoneTabBodyProps => {
  const el = island.tree().find((e) => e.type === PhoneTabBody);
  if (!el) throw new Error("no PhoneTabBody in the container's tree");
  return propsOf(el) as unknown as PhoneTabBodyProps;
};
/** The notice as the body hands it its props (found by TYPE: a hooks component the node harness does not expand by itself). */
const noticeOf = (island: { tree: () => ReactElement[] }) => {
  const el = treeOf(island).find((e) => e.type === ChannelSafetyNotice);
  return el ? (propsOf(el) as unknown as Parameters<typeof ChannelSafetyNotice>[0]) : undefined;
};
const treeOf = (island: { tree: () => ReactElement[] }) => walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
let islands: { unmount: () => void }[] = [];
async function mount(s: Server) {
  serve(s);
  const island = renderIsland(PhoneTab, TAB);
  islands.push(island);
  await settle();
  return island;
}
/** The organiser's pick of `t1` (the fake serves no saved destination, so nothing is selected until one is made). */
const pick = (island: { tree: () => ReactElement[] }, id = "t1") => bodyOf(island).onSelectTarget(id);
const warnNo = () => ({ warn: false, young: false, shortRecent: 0 });
const warnYes = () => ({ warn: true, young: true, shortRecent: 0 });

beforeEach(() => { vi.useFakeTimers(); apiV1.mockReset(); islands = []; });
afterEach(() => { for (const i of islands) i.unmount(); vi.useRealTimers(); });

describe("needsChannelCheck: the predicate Task 16's Seazn option is excluded by", () => {
  it("is true only for a target with a YouTube connection", () => {
    expect(needsChannelCheck(target("a", YT))).toBe(true);
    expect(needsChannelCheck(target("b", null))).toBe(false);
    expect(needsChannelCheck(undefined)).toBe(false);
    expect(needsChannelCheck(null)).toBe(false);
  });
});

describe("Go live and the channel-safety notice", () => {
  it("a pasted-key target (youtube: null): Go live POSTs at once and makes NO safety request", async () => {
    const island = await mount({ targets: [target("t1", null)] });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(CREATE)).toBe(1);
    expect(calls().filter((c) => c.includes("/safety")), "no safety fetch").toEqual([]);
  });

  it("a YouTube connection target, warn:true: ONE safety read, the notice shows, nothing is started; Go live anyway starts with no second read", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: warnYes });
    expect(noticeOf(island), "premise: no notice before the tap").toBeUndefined();
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(SAFETY)).toBe(1);
    expect(count(CREATE), "the warning does not start the match").toBe(0);
    const shown = walk(expandWithHooks(ChannelSafetyNotice, noticeOf(island)!));
    expect(textOf(byTestId(shown, "stream-safety-text")!)).toContain(m("stream.safety.notice"));
    expect(textOf(byTestId(shown, "stream-safety-go-anyway")!)).toContain(m("stream.safety.goAnyway"));
    expect(byTestId(treeOf(island), "stream-go-live"), "non-blocking: Go live is still there").toBeDefined();
    // The second tap: the notice's own button is the panel's Go live again.
    noticeOf(island)!.onGoAnyway();
    await settle();
    expect(count(CREATE), "Go live anyway proceeds").toBe(1);
    expect(count(SAFETY), "no second safety read").toBe(1);
    expect(noticeOf(island), "the notice is gone once it started").toBeUndefined();
  });

  it("two taps before the first read answers make ONE safety read, and the read is no-store", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: warnYes });
    pick(island);
    bodyOf(island).onGoLive();
    bodyOf(island).onGoLive();   // the same tick: `busy` has not flushed
    await settle();
    expect(count(SAFETY), "one tap = one read").toBe(1);
    expect(apiV1.mock.calls.find(([url]) => url.endsWith("/safety"))?.[1], "never served from a cache").toMatchObject({ cache: "no-store" });
  });

  it("warn:false: no notice and the match starts on the first tap", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: warnNo });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(SAFETY)).toBe(1);
    expect(count(CREATE)).toBe(1);
    expect(noticeOf(island)).toBeUndefined();
  });

  it("fail-open: a safety request that errors does not stop the Go live", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: () => { throw new TypeError("Failed to fetch"); } });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(CREATE)).toBe(1);
    expect(noticeOf(island)).toBeUndefined();
  });

  it("m6: a safety read that never answers is given up after the client timeout and the Go live proceeds (fail open), not before", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: () => new Promise(() => {}) });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(SAFETY), "premise: the read was asked").toBe(1);
    await vi.advanceTimersByTimeAsync(YOUTUBE_SAFETY_CLIENT_TIMEOUT_MS - 20);
    expect(count(CREATE), "still waiting just before the timeout").toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    await settle();
    expect(count(CREATE), "the timeout lets the Go live through").toBe(1);
    expect(noticeOf(island)).toBeUndefined();
    const signal = (apiV1.mock.calls.find(([url]) => url.endsWith("/safety"))?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(signal?.aborted, "the request itself is aborted").toBe(true);
  });

  it("Cancel dismisses the notice, starts nothing, and the NEXT Go live tap checks again (one read per tap)", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: warnYes });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(noticeOf(island)).toBeDefined();
    noticeOf(island)!.onCancel();
    await settle();
    expect(noticeOf(island)).toBeUndefined();
    expect(count(CREATE)).toBe(0);
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(SAFETY), "a second tap after Cancel asks again").toBe(2);
  });

  it("a court-streamed match never asks (its stream goes to the court link's channel, which the panel does not hold)", async () => {
    const island = await mount({ targets: [target("t1", YT)], safety: warnYes, court: { name: "Court 2", targetLabel: "Court channel" } });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(count(SAFETY)).toBe(0);
    expect(count(CREATE)).toBe(1);
  });

  it("the picker choosing another destination takes the notice away", async () => {
    const island = await mount({ targets: [target("t1", YT), target("t2", null)], safety: warnYes });
    pick(island);
    bodyOf(island).onGoLive();
    await settle();
    expect(noticeOf(island)).toBeDefined();
    bodyOf(island).onSelectTarget("t2");
    await settle();
    expect(noticeOf(island)).toBeUndefined();
  });
});

describe("the notice copy in every locale", () => {
  it("each of the three keys is in all four dictionaries and non-empty", () => {
    const keys = ["stream.safety.notice", "stream.safety.goAnyway", "stream.safety.cancel"];
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Record<string, string>;
      for (const k of keys) {
        expect(typeof dict[k], `${locale} ${k}`).toBe("string");
        expect(dict[k]!.trim().length, `${locale} ${k}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(LOCALES.length, "premise: four locales").toBe(4);
    expect(checked, "anti-vacuity: 3 keys x 4 locales").toBe(12);
    expect(messages["stream.safety.notice"]).toBe("Several short test streams can get a YouTube channel flagged, even unlisted. Test on a throwaway channel.");
  });
});
