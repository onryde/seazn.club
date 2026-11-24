// Task 33e (found in the T33d review): an org admin whose seat the plan's member limit has paused (doc 10 §2.4) is refused 402
// `members.max` by BOTH reads the stream panel polls every STREAM_POLL_MS — `stream-sessions/current` (the shared session) and
// `stream-phone` (the Phone tab's read model). Before this task each answered silently, every 5 s, forever: no reason on screen,
// and a request the server takes that can never succeed. Now a 402 for that feature stops THAT poll and the panel says why, in the
// seatFrozen vocabulary; every other refusal (a 500, a 402 for another feature) keeps polling, and a return to the tab is ONE
// re-check — never a loop. Driven through the REAL container (`PhoneTab`, `renderIsland`, a doubled v1 transport that throws the
// REAL `ApiV1Error`), the way fixture-stream-panel.seazn-replays.test.tsx drives it. A sibling of fixture-stream-panel.test.tsx
// (459 KB; its harness is private to it). `apps/web` vitest is node: the page seeded with a paused admin is the e2e's
// (e2e/walkthrough/seazn-hosted.spec.ts, Task 33e).
//
// Sport: not applicable — the Phone tab reads no sport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderIsland, propsOf, walk, expandWithHooks, textOf } from "@/components/__tests__/_hook-harness";
import { defaultTemplateFor } from "@/components/overlay/template-registry";
import { ApiV1Error } from "@/lib/client-v1";
import { LOCALES } from "@/lib/i18n-constants";
import { messages, type MessageKey } from "@/lib/messages";
import { STREAM_POLL_MS, type StreamSessionView } from "@/lib/stream-session-view";
import type { StreamPhone } from "@/server/api-v1/schemas";
import { PhoneTab, PhoneTabBody, type PhoneScore, type PhoneTabBodyProps } from "@/components/v2/fixture-stream-panel";
import { seatPausedNote } from "@/components/v2/fixture-stream-panel/shared";

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

const DICT_DIR = join(__dirname, "..", "..", "..", "dictionaries");
const uiDict = (locale: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, locale, "ui.json"), "utf8"));
const en = uiDict("en");
const LINE_KEY: MessageKey = "stream.phone.seatPaused";
const SCORE_OFF: PhoneScore = {
  available: false, stored: null, template: defaultTemplateFor("football"), delayMs: null, sportKey: "football", editor: null,
  modeFailed: false, onMode: () => {},
};
const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const, phoneLostMinutes: 20, autoStopMinutes: 3, pasteCodeShown: true, tz: "Europe/London", score: SCORE_OFF };
const CURRENT = "GET /api/v1/fixtures/f-1/stream-sessions/current";
const PHONE = "GET /api/v1/fixtures/f-1/stream-phone";
const TARGETS_URL = "GET /api/v1/orgs/o-1/stream-targets";

/** The server's own refusal of a paused seat, as `apiV1` rethrows it (http.ts: 402 PAYMENT_REQUIRED, feature_key = the feature). */
const frozen = () => new ApiV1Error("Plan upgrade required: members.max", 402, "PAYMENT_REQUIRED", { feature: "members.max", feature_key: "members.max", reason: "x" });
const otherFeature = () => new ApiV1Error("Plan upgrade required: streaming.relay", 402, "PAYMENT_REQUIRED", { feature: "streaming.relay", feature_key: "streaming.relay", reason: "x" });
const serverError = () => new ApiV1Error("boom", 500, "INTERNAL");

type Mode = "ok" | "frozen" | "500" | "otherFeature";
const refusal = (m: Mode): Error | null => (m === "frozen" ? frozen() : m === "500" ? serverError() : m === "otherFeature" ? otherFeature() : null);
const server = { current: "ok" as Mode, phone: "ok" as Mode, targets: "ok" as Mode, live: null as StreamSessionView | null };

const phoneRead = (): StreamPhone => ({
  code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "active", endCause: null },
  phone: null, destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null, court: null,
} as unknown as StreamPhone);
const LIVE = {
  id: "s1", fixtureId: "f-1", mode: "passthrough", overlay: null, state: "live", desiredState: "live", failReason: null, health: null,
  ingest: { state: "connected", protocol: "srt" }, output: null, balance: 2, startedAt: "2026-09-14T11:00:00.000Z", endedAt: null, replayUrl: null,
  replayParts: [], seaznReplays: [], youtubeVideoUrl: null, youtubeStatus: null, youtubeLiveForMs: null,
  target: { id: "t1", kind: "youtube", label: "Club" }, fixtureDecided: false, fixtureHeld: false, endReason: null, creditUsed: false,
  startCause: "organiser", restart: null, countdown: null,
} as unknown as StreamSessionView;

function serve() {
  apiV1.mockImplementation(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const key = `${options?.method ?? "GET"} ${url}`;
    if (key === CURRENT) {
      const e = refusal(server.current);
      if (e) throw e;
      return server.live === null ? null : structuredClone(server.live);
    }
    if (key === PHONE) {
      const e = refusal(server.phone);
      if (e) throw e;
      return structuredClone(phoneRead());
    }
    if (key === TARGETS_URL) {
      const e = refusal(server.targets);
      if (e) throw e;
      return [];
    }
    throw new Error(`unrouted ${key}`);
  });
}
const calls = (): string[] => apiV1.mock.calls.map(([url, o]) => `${o?.method ?? "GET"} ${url}`);
const count = (key: string): number => calls().filter((c) => c === key).length;
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1); };
/** `n` poll periods, each followed by the network hops its answers take. */
const intervals = async (n: number) => { for (let i = 0; i < n; i++) { await vi.advanceTimersByTimeAsync(STREAM_POLL_MS); await settle(); } };
const bodyOf = (island: { tree: () => ReactElement[] }): PhoneTabBodyProps => {
  const el = island.tree().find((e) => e.type === PhoneTabBody);
  if (!el) throw new Error("no PhoneTabBody in the container's tree");
  return propsOf(el) as unknown as PhoneTabBodyProps;
};
const bodyTree = (island: { tree: () => ReactElement[] }): ReactElement[] => walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined =>
  tree.find((el) => (el.props as Record<string, unknown>)["data-testid"] === id);
const NOTE = "stream-seat-paused";

let islands: { unmount: () => void }[] = [];
async function mount(modes: Partial<Pick<typeof server, "current" | "phone" | "targets" | "live">> = {}) {
  Object.assign(server, { current: "ok", phone: "ok", targets: "ok", live: null }, modes);
  serve();
  const island = renderIsland(PhoneTab, TAB);
  islands.push(island);
  await settle();
  return island;
}
/** A minimal page (the only surface `useTabReturn` touches), stubbed BEFORE the mount so the listeners are the real ones. */
const stubPage = () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  const win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return { doc, win };
};

beforeEach(() => { vi.useFakeTimers(); apiV1.mockReset(); islands = []; });
afterEach(() => { for (const i of islands) i.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Task 33e: a paused admin's panel stops polling and says why", () => {
  it("EMPTY CASE FIRST: an unpaused seat has no line, and both polls run — the premise every test below leans on", async () => {
    const island = await mount();
    expect(count(CURRENT), "the session's read").toBe(1);
    expect(count(PHONE), "the read model's read").toBe(1);
    expect(bodyOf(island).seatPaused ?? false).toBe(false);
    expect(byTestId(bodyTree(island), NOTE)).toBeUndefined();
    await intervals(3);
    expect(count(PHONE), "the read model polls every period (its positive pair)").toBe(4);
  });

  it("a 402 members.max stops BOTH polls: one ask each, then nothing for N periods (the count is the anti-vacuity: both WERE asked)", async () => {
    await mount({ current: "frozen", phone: "frozen", targets: "frozen" });
    expect(count(CURRENT), "asked once").toBe(1);
    expect(count(PHONE), "asked once").toBe(1);
    const before = calls().length;
    await intervals(6);
    expect(count(CURRENT), "no further session read").toBe(1);
    expect(count(PHONE), "no further read-model read").toBe(1);
    expect(calls().length, "and no request of any other kind").toBe(before);
  });

  it("each poll stops on ITS OWN refusal: only the read model refused → the session keeps polling, and the other way round", async () => {
    await mount({ current: "ok", phone: "frozen" });
    await intervals(3);
    expect(count(PHONE), "the read model stopped").toBe(1);
    expect(count(CURRENT), "the session is idle and answered: it does not poll (unchanged behaviour)").toBe(1);
    islands.pop()!.unmount();
    apiV1.mockReset();
    // A live session polls; the read model refused it, the session did not.
    await mount({ current: "ok", phone: "frozen", live: LIVE });
    await intervals(3);
    expect(count(CURRENT), "the live session keeps polling: 1 + 3").toBe(4);
    expect(count(PHONE), "the read model stayed stopped").toBe(1);
    islands.pop()!.unmount();
    apiV1.mockReset();
    // …and the other way round: the session refused, the read model did not — it keeps its own poll.
    await mount({ current: "frozen", phone: "ok" });
    await intervals(3);
    expect(count(CURRENT), "the session stopped").toBe(1);
    expect(count(PHONE), "the read model polls on: 1 + 3").toBe(4);
  });

  it("a 500 keeps polling — both reads, every period (only a paused seat stops the loop)", async () => {
    const island = await mount({ current: "500", phone: "500", targets: "500" });
    await intervals(3);
    expect(count(CURRENT), "1 + 3 (a failed first read is polled like any unsettled state)").toBe(4);
    expect(count(PHONE)).toBe(4);
    expect(bodyOf(island).seatPaused ?? false, "and says nothing about a seat").toBe(false);
    expect(byTestId(bodyTree(island), NOTE)).toBeUndefined();
  });

  it("a 402 for ANOTHER feature keeps polling and says nothing about the seat", async () => {
    const island = await mount({ current: "otherFeature", phone: "otherFeature", targets: "otherFeature" });
    await intervals(3);
    expect(count(CURRENT)).toBe(4);
    expect(count(PHONE)).toBe(4);
    expect(byTestId(bodyTree(island), NOTE)).toBeUndefined();
  });

  it("the line: ONE note in the body, the dictionary's words, a status region; the panel is NOT blanked (the body is drawn, past the loading state)", async () => {
    const island = await mount({ current: "frozen", phone: "frozen", targets: "frozen" });
    expect(island.tree().find((e) => e.type === PhoneTabBody), "the body is drawn").toBeDefined();
    expect(byTestId(island.tree(), "stream-loading"), "not the loading placeholder").toBeUndefined();
    const tree = bodyTree(island);
    expect(tree.filter((e) => (e.props as Record<string, unknown>)["data-testid"] === NOTE)).toHaveLength(1);
    const note = byTestId(tree, NOTE)!;
    expect(textOf(note)).toBe(messages[LINE_KEY]);
    expect((note.props as Record<string, unknown>).role).toBe("status");
  });

  it("a session already on screen stays on screen: the seat is paused mid-stream → the poll stops, the live view stays, the line appears", async () => {
    const island = await mount({ live: LIVE });
    expect(bodyOf(island).view?.id, "PREMISE: the live session is shown").toBe("s1");
    expect(byTestId(bodyTree(island), NOTE), "PREMISE: no line yet").toBeUndefined();
    Object.assign(server, { current: "frozen", phone: "frozen" });
    await intervals(1);
    const stopped = { current: count(CURRENT), phone: count(PHONE) };
    await intervals(5);
    expect({ current: count(CURRENT), phone: count(PHONE) }, "no more reads once refused").toEqual(stopped);
    expect(bodyOf(island).view?.id, "the live view is kept, not blanked").toBe("s1");
    expect(byTestId(bodyTree(island), NOTE), "and the line says why").toBeDefined();
  });

  describe("resume: coming back to the tab is ONE re-check, never a loop", () => {
    it("still paused: one re-check per read (session + read model), the line stays, and the polls stay stopped", async () => {
      const { win } = stubPage();
      const island = await mount({ current: "frozen", phone: "frozen", targets: "frozen" });
      win.dispatchEvent(new Event("focus"));
      await settle();
      expect(count(CURRENT), "one session re-check").toBe(2);
      expect(count(PHONE), "one read-model re-check").toBe(2);
      await intervals(5);
      expect(count(CURRENT)).toBe(2);
      expect(count(PHONE)).toBe(2);
      expect(byTestId(bodyTree(island), NOTE), "still says why").toBeDefined();
    });

    it("with a session on screen the pause is rechecked too (the read model's own return is not idle-only), and an unpaused seat resumes both polls", async () => {
      const { win } = stubPage();
      const island = await mount({ live: LIVE });
      Object.assign(server, { current: "frozen", phone: "frozen" });
      await intervals(1);
      const stopped = { current: count(CURRENT), phone: count(PHONE) };
      Object.assign(server, { current: "ok", phone: "ok" });
      win.dispatchEvent(new Event("focus"));
      await settle();
      expect(count(CURRENT), "the session's re-check").toBe(stopped.current + 1);
      expect(count(PHONE), "the read model's re-check — its tab return is on while paused, not only at idle").toBe(stopped.phone + 1);
      expect(byTestId(bodyTree(island), NOTE), "the line is gone").toBeUndefined();
      await intervals(2);
      expect(count(CURRENT), "the live session polls again").toBe(stopped.current + 3);
      expect(count(PHONE), "…and so does the read model").toBe(stopped.phone + 3);
    });

    it("unfrozen meanwhile: the re-check lands, the line goes, and the polls run again", async () => {
      const { doc, win } = stubPage();
      const island = await mount({ current: "frozen", phone: "frozen", targets: "frozen" });
      Object.assign(server, { current: "ok", phone: "ok", targets: "ok" });
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("focus"));
      await settle();
      expect(byTestId(bodyTree(island), NOTE), "the line is gone").toBeUndefined();
      const afterReturn = count(PHONE);
      await intervals(3);
      expect(count(PHONE), "the read model polls again").toBe(afterReturn + 3);
    });

    it("leaving the tab is not a return: the hide re-checks nothing", async () => {
      const { doc } = stubPage();
      await mount({ current: "frozen", phone: "frozen", targets: "frozen" });
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(count(CURRENT)).toBe(1);
      expect(count(PHONE)).toBe(1);
    });
  });
});

describe("Task 33e: the line's words", () => {
  const SEAT_STATE_WORDS: [locale: string, readOnly: string, memberLimit: string][] = [
    ["en", "read-only", "member limit"],
    ["nl", "alleen-lezen", "ledenlimiet"],
    ["fr", "en lecture seule", "limite de membres"],
    ["es", "de solo lectura", "límite de miembros"],
  ];

  it("every locale has the key, translated outside English, and the note renders it as given", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = uiDict(locale);
      const want = d[LINE_KEY];
      expect(want, `${locale}: ${LINE_KEY}`).toBeTruthy();
      if (locale !== "en") expect(want, `${locale}: translated`).not.toBe(en[LINE_KEY]);
      const note = seatPausedNote((k) => uiDict(locale)[k]!);
      expect(textOf(note), locale).toBe(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
  });

  it("one name for one state: the note says \"read-only\" and \"member limit\" in the same words as the app's existing seat line (streamDest.error.seatFrozen)", () => {
    let checked = 0;
    for (const [locale, readOnly, memberLimit] of SEAT_STATE_WORDS) {
      const d = uiDict(locale);
      for (const words of [readOnly, memberLimit]) {
        expect(d["streamDest.error.seatFrozen"], `${locale}: PREMISE: the house line says "${words}"`).toContain(words);
        expect(d[LINE_KEY], `${locale}: the panel line says "${words}" too`).toContain(words);
        checked++;
      }
    }
    expect(new Set(SEAT_STATE_WORDS.map(([l]) => l)), "every locale is in the table").toEqual(new Set(LOCALES));
    expect(checked, "anti-vacuity: two phrases per locale").toBe(LOCALES.length * 2);
  });
});
