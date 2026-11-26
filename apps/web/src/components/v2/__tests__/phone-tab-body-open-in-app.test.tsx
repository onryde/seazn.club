// The phone tab's "Open in app" wiring (spec 2026-11-25 §5.4): WHEN the body hands `OpenInAppRow` its link, and WHICH
// facts reach the line under it. Node has no DOM, so this reads the element tree the body returns; who SEES the row (the
// flag, Android, below `md`) is open-in-app.test.tsx's and e2e/open-in-app-buttons.spec.ts's.
//
// Sport: not applicable — the row reads no sport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandWithHooks, propsOf, walk } from "@/components/__tests__/_hook-harness";
import { defaultTemplateFor } from "@/components/overlay/template-registry";
import { PhoneTabBody, type PhoneScore, type PhoneTabBodyProps } from "@/components/v2/fixture-stream-panel";
import { OpenInAppHint, OpenInAppRow } from "@/components/v2/open-in-app";
import { streamAppLink } from "@/lib/open-in-app";
import { phoneTabState, STATE_PILL_KEYS, type PhoneTabState, type StreamSessionView } from "@/lib/stream-session-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const ORIGIN = "https://stg.seazn.club";
const CODE_TEXT = '{"v":2,"tok":"t"}';

const SCORE_OFF: PhoneScore = {
  available: false, stored: null, template: defaultTemplateFor("football"), delayMs: null, sportKey: "football", editor: null,
  modeFailed: false, onMode: () => {},
};
/** A paired phone, so the code lives in the "Show the code again" fold, which is open here. */
const PHONE: NonNullable<PhoneTabBodyProps["phone"]> = {
  code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "active", endCause: null },
  phone: {
    present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator", state: "paired", notReady: null,
    notReadyShown: false, health: null, startFailed: null, pairedAt: "2026-09-14T11:05:00.000Z", lastBeatAt: "2026-09-14T11:59:55.000Z", elapsedMs: 5_000,
    beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false,
  },
  destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null, court: null,
};
const BODY: PhoneTabBodyProps = {
  fixtureId: "f-1", view: null, balance: 3, targets: { status: "ok", list: [] }, busy: false, createError: null, checkoutError: null,
  selectedTargetId: null, phone: PHONE, code: { status: "ok", text: CODE_TEXT, image: null }, codeOpen: true, now: new Date("2026-09-14T12:00:00Z"),
  copied: false, showBuy: false, planGate: false, stopFailed: false, checkoutOpen: false, currency: "gbp", split: null, monthlyAllowance: 0,
  restart: null, youtube: null, pickFailed: false, phoneLostMinutes: 20, autoStopMinutes: 3, pasteCodeShown: false, autoPending: null,
  autoFailed: false, takeoverDismissedAt: null, tz: "Europe/London", onToggleAuto: () => {}, onDismissTakeover: () => {}, onSelectTarget: () => {},
  onPickAnother: () => {}, pickerOpenSignal: 0, onRetryTargets: () => {}, onGoLive: () => {}, safetyNotice: false, onDismissSafety: () => {},
  onStop: () => {}, onCancel: () => {}, onBuy: () => {}, onAgain: () => {}, onCopy: () => {}, onToggleCode: () => {}, onReissue: () => {},
  onRetryCode: () => {}, qrFailed: false, onRetryQr: () => {}, onShowBuy: () => {}, onTileIntent: () => {}, score: SCORE_OFF,
  replayActions: { deleting: null, failed: null, gone: new Set(), onDelete: () => {}, downloading: null, downloadFailed: null, onDownload: () => {} },
};
const view = (state: StreamSessionView["state"]): StreamSessionView => ({
  id: "s", fixtureId: "f-1", mode: "passthrough", overlay: null, state, desiredState: "live", failReason: null,
  health: null, ingest: { state: "connected", protocol: "srt" }, output: null, balance: 0,
  startedAt: "2026-09-14T11:30:00Z", endedAt: null, replayUrl: null, replayParts: [], seaznReplays: [], youtubeVideoUrl: null,
  youtubeStatus: null, youtubeLiveForMs: null, target: { id: "t", kind: "youtube", label: "Club" }, fixtureDecided: false, fixtureHeld: false,
  endReason: null, creditUsed: true, startCause: "organiser", restart: null, countdown: null,
});

/** What the body hands the row and its line: null where no row is in the tree. */
function drawn(over: Partial<PhoneTabBodyProps> = {}) {
  const tree = walk(expandWithHooks(PhoneTabBody, { ...BODY, ...over }));
  const rows = tree.filter((e) => e.type === OpenInAppRow);
  const hints = tree.filter((e) => e.type === OpenInAppHint);
  expect(hints.length, "the line is drawn exactly with the row").toBe(rows.length);
  expect(rows.length, "never two rows").toBeLessThanOrEqual(1);
  const ids = new Set(tree.map((e) => propsOf(e)["data-testid"]));
  return {
    ids,
    row: rows.length === 0 ? null : { href: propsOf(rows[0]!).href as string | null, hint: propsOf(hints[0]!).hint as string },
  };
}

beforeEach(() => vi.stubGlobal("window", { location: { origin: ORIGIN } }));
afterEach(() => vi.unstubAllGlobals());

describe("the phone tab's Open in app row", () => {
  it("in EVERY phone-tab state: where the code is drawn, with its link; an open session says nothing is missing", () => {
    // Per state: the wire state that reaches it, what it must draw (the premise), and the row's line (null: no code, no
    // row). A Record over the type, so a new state does not compile until it is answered here.
    const TABLE: Record<PhoneTabState, { wire: StreamSessionView["state"] | null; premise: string; hint: string | null }> = {
      idle: { wire: null, premise: "stream-ready", hint: "openApp.stream.needDestination" },
      provisioning: { wire: "provisioning", premise: "stream-waiting", hint: "openApp.stream.thenGoLive" },
      warming: { wire: "warming", premise: "stream-waiting", hint: "openApp.stream.thenGoLive" },
      live: { wire: "live", premise: "stream-on-air", hint: "openApp.stream.thenGoLive" },
      ending: { wire: "ending", premise: "stream-ending", hint: null },
      ended: { wire: "completed", premise: "stream-ended", hint: null },
      failed: { wire: "failed", premise: "stream-failed", hint: null },
    };
    const states = Object.keys(STATE_PILL_KEYS) as PhoneTabState[];
    let checked = 0;
    let rows = 0;
    for (const state of states) {
      const { wire, premise, hint } = TABLE[state];
      const v = wire === null ? null : view(wire);
      expect(phoneTabState(v), `premise: ${state}`).toBe(state);
      // No destination picked anywhere. In a session the balance reads 0 (its own credit is spent); at Ready it holds
      // credits, since 0 there hides the code behind the buy card (below).
      const got = drawn({ view: v, balance: v === null ? 3 : 0 });
      expect(got.ids.has(premise), `premise: ${state} draws ${premise}`).toBe(true);
      expect(got.row, state).toEqual(hint === null ? null : { href: streamAppLink(ORIGIN, CODE_TEXT), hint });
      if (got.row) rows += 1;
      checked += 1;
    }
    expect(checked).toBe(7);
    expect(rows).toBe(4);
  });

  it("before a session the panel's own pick, balance and free restart reach the line", () => {
    expect(drawn({ selectedTargetId: "t1" }).row?.hint).toBe("openApp.stream.thenGoLive");
    expect(drawn({ selectedTargetId: null }).row?.hint).toBe("openApp.stream.needDestination");
    const free = { windowOpen: true, used: 1, limit: 3, free: true };
    expect(drawn({ selectedTargetId: "t1", balance: 0, restart: free }).row?.hint).toBe("openApp.stream.thenGoLive");
    // No credit and no free restart at Ready: the buy card takes the place of the code, so there is no row to label.
    const broke = drawn({ selectedTargetId: "t1", balance: 0 });
    expect(broke.ids.has("stream-ready")).toBe(false);
    expect(broke.row).toBeNull();
  });

  it("no row without the code in hand, or under a plan refusal", () => {
    const live = { view: view("live") };
    expect(drawn(live).row, "the control: the same session with its code").not.toBeNull();
    let checked = 0;
    for (const [name, over] of [
      ["code loading", { code: { status: "loading" } }],
      ["code refused", { code: { status: "error" } }],
      ["plan refusal", { planGate: true }],
    ] as [string, Partial<PhoneTabBodyProps>][]) {
      const got = drawn({ ...live, ...over });
      expect(got.ids.has("stream-code-disclosure"), `premise: ${name} still draws the code's fold`).toBe(true);
      expect(got.row, name).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
