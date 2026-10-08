// The organiser's stream panel (Stream Overlay W1, task 6).
//
// `apps/web` vitest is `environment: "node"` — NO DOM. So this file proves the
// things a static render and a driven island CAN prove: which controls exist,
// what the style strip is BUILT FROM, what the preview is HANDED, which branch
// the Phone tab takes, and what the save button does with a bad link. It cannot
// see wrap, overflow, tap area or the cascade; those are Task 8's e2e.
//
// Two disciplines the wave's own rules impose and this file follows:
//
//   * every expectation about the style strip is DERIVED from
//     `themesForSport` / `defaultThemeFor` — never a table typed here, so a
//     fourth theme moves the test with the registry instead of leaving it
//     asserting yesterday's list (AGENTS.md class 19);
//   * the opaque-preview caption is derived from the DICTIONARY, not from the
//     word "slate" — the panel must not know a theme by name.
//
// Streaming R1 Task 14 (lane D) adds the Phone tab. Three layers, each proven
// where it CAN be (AGENTS.md classes 1 and 2):
//   * `PhoneTabBody` — pure, every §8a/§8b state rendered from props alone;
//   * `PhoneTab` — the container, driven through `renderIsland` (which runs
//     effects) with the v1 transport, the checkout client, the confirm dialog
//     and the QR encoder doubled — so the PATHS it calls, what it hands the
//     body and what each action sends are pinned, not a source scan's guess;
//   (T8, D1: the destination form moved to Directory → Streaming — the panel only picks; see
//   stream-destinations-panel.test.tsx for the form.)
// What none of this can see — layout, the cascade, a real Stripe iframe, a
// real server — is the browser pass and Task 15's walkthrough.
//
// One sport, on purpose: the Phone tab reads no sport (the relay is
// sport-agnostic); the W1 style-strip describes above sweep three.
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { renderIsland, propsOf, walk, expandWithHooks, textOf } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { UpgradeGate } from "@/components/upgrade-gate";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { defaultThemeFor, themesForSport } from "@/components/overlay/theme-registry";
import { ApiV1Error } from "@/lib/client-v1";
import { CaptureQrV2, captureQrV2Text } from "@/lib/capture-qr";
import { messages, type MessageKey } from "@/lib/messages";
import { STREAM_CREDIT_PACKS, streamPack, streamPackPriceAmounts } from "@/lib/stream-credit-packs";
import { SUPPORTED_CURRENCIES, formatMinor } from "@/lib/currency";
import { LOCALES } from "@/lib/i18n-constants";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import {
  END_REASON_KEYS,
  FAIL_REASON_KEYS,
  HEALTH_KEYS,
  STREAM_POLL_MS,
  TAKEOVER_NOTICE_MS,
  TARGET_REMOVED,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { HEALTH_REASONS } from "@/server/relay/domain/health-reasons";
import { StreamLostCountdown, StreamTargetKind, type StreamPhone, type StreamTarget } from "@/server/api-v1/schemas";
import { resolveStreamTarget, type SavedStreamTarget } from "@/lib/stream-destinations";
import { STREAM_TARGET_TABLE, STREAM_TARGET_TABLE_ROWS, rowName } from "@/lib/__tests__/_stream-target-table";
import { PlatformMark, platformName } from "@/components/v2/stream-platform-mark";
import { D3Warning, PhoneStripView, SignalChain } from "@/components/v2/stream-signal-chain";
import QRCode from "qrcode";
import { SeaznQrImage, SeaznQrPlaceholder } from "@/components/v2/seazn-qr-image";
import { SEAZN_QR_ERROR_CORRECTION, SEAZN_QR_QUIET_MODULES, type SeaznQr } from "@/lib/seazn-qr";
import { DictProvider } from "@/components/i18n/dict-provider";
import { chainFor } from "@/lib/stream-chain";
import {
  CheckoutSheetBoundary,
  FixtureStreamPanel,
  PhoneStopProbe,
  PhoneTab,
  PhoneTabBody,
  StreamCredits,
  StreamCreditsBody,
  CANVAS_H,
  CANVAS_W,
  PREVIEW_MAX_W_PX,
  previewScaleFor,
  type PhoneTabBodyProps,
  type TargetsState,
  type StreamPanelContext,
  type StreamPanelFixture,
} from "@/components/v2/fixture-stream-panel";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(
  async () => ({}),
);
// The REAL `ApiV1Error` (a refusal the Phone tab reads is the class `apiV1` itself throws — D1), only the transport doubled.
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
}));

// The panel reads the URL only to STRIP a consumed return (G5); whether it opens on a return is the page's word.
const searchParamsMock = vi.hoisted(() => {
  let p = new URLSearchParams("");
  return { set: (n: URLSearchParams) => { p = n; }, get: () => p };
});
// G5: the panel strips the consumed return params with `router.replace` — the spy is what the tests read.
const router = vi.hoisted(() => ({ replace: vi.fn<(href: string, opts?: { scroll?: boolean }) => void>() }));
const PATHNAME = "/o/org/c/comp/d/div";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: router.replace }),
  usePathname: () => PATHNAME,
  useSearchParams: () => searchParamsMock.get(),
}));

// I2: the checkout sheet is a `next/dynamic` import, so Stripe.js loads only once a checkout opens. The double records
// each loader and its options and returns a marker component, so a test can (a) find the lazy element the panel
// renders and read its props, and (b) run the panel's OWN loader and render the module it resolves to.
const lazy = vi.hoisted(() => ({ made: [] as { loader: () => Promise<unknown>; opts: unknown; C: (props: Record<string, unknown>) => null }[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>, opts: unknown) => {
    const C: (props: Record<string, unknown>) => null = () => null;
    lazy.made.push({ loader, opts, C });
    return C;
  },
}));

// M2 / D-B (fix round 4): the sheet's ONE loader lives in its own module so a test can COUNT calls to it — `dynamic()` and
// the tile-intent warm-up both go through it. Delegates to the real `import()`, so the sheet a test loads is the real one.
const sheetLoader = vi.hoisted(() => ({
  load: vi.fn<() => Promise<unknown>>(),
  real: () => import("@/components/v2/stream-checkout-modal"),
}));
vi.mock("@/components/v2/stream-checkout-sheet-loader", () => ({
  loadCheckoutSheet: () => sheetLoader.load(),
}));

// D17: the embedded-checkout trio, doubled the way pass-checkout-parity.test.tsx does it. Read only by the LAZY module
// (stream-checkout-modal.tsx) since I2 — the panel itself no longer imports any of it.
const stripe = vi.hoisted(() => ({ promise: Promise.resolve(null) }));
vi.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: (props: { children?: unknown }) => props.children,
  EmbeddedCheckout: () => null,
}));
vi.mock("@/lib/stripe-browser", () => ({ stripePromise: stripe.promise }));

const checkout = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/billing-checkout-client", () => ({
  fetchRelayCheckoutClientSecret: (args: unknown) => checkout.fetch(args),
}));

const confirmMock = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>(async () => true));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirmMock }));

// The Seazn QR helper is doubled so its INPUT (the payload) is what the test reads (T10: the panel no longer calls
// `qrcode` itself — `lib/seazn-qr` owns the EC level and the logo; its own test decodes the symbol). The painted size
// is the shared component's (B6 fix round 1), so the helper takes no size at all.
const seaznQr = vi.hoisted(() => ({
  renderSeaznQr: vi.fn<(text: string) => Promise<{ src: string; modules: number }>>(async (text) => ({
    src: `data:image/svg+xml;charset=utf-8,len${text.length}`,
    modules: 113,
  })),
}));
vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: seaznQr.renderSeaznQr,
}));

// The preview's own first fetch. Left rejecting by default: the panel must
// render its seed from the ROW, so a failing fetch is the interesting case.
const fetchOverlayFixture = vi.fn(async () => {
  throw new Error("offline");
});
vi.mock("@/components/public-site/live-score-data", () => ({
  fetchOverlayFixture: () => fetchOverlayFixture(),
  fetchLiveFixture: async () => ({}),
  fetchPublicRealtimeToken: async () => ({ token: "", channel: "" }),
}));

const TZ = "Europe/London";

const FIXTURE: StreamPanelFixture = {
  id: "f-1",
  status: "in_play",
  outcome: null,
  scheduled_at: "2026-09-10T14:00:00.000Z",
  home_entrant_id: "e1",
  away_entrant_id: "e2",
};

const ENTRANTS = { e1: "Alpha Athletic", e2: "Bravo Rangers" };

function ctx(o: Partial<StreamPanelContext> = {}): StreamPanelContext {
  return {
    entitled: true,
    relayEntitled: false,
    relayDisabled: false,
    sportKey: "football",
    overlayDict: {},
    orgId: "o-1",
    streamBalance: 3,
    streamSplit: null,
    monthlyAllowance: 0,
    currency: "gbp",
    overlayKeys: { [FIXTURE.id]: "KEY_for-f-1_0123456789" },
    phoneCapture: true,
    phoneLostMinutes: 20,
    autoStopMinutes: 3,
    ...o,
  };
}

/** The panel ON ITS OBS TAB — what the W1 describes below are about. Since T9b Phone is the default (spec §3.1), so this
 *  taps OBS overlay first, as an organiser would; `openPanel` renders it as it opens. */
function open(o: Partial<StreamPanelContext> = {}) {
  const island = openPanel(o);
  click(byTestId(island.tree(), "stream-tab-obs"));
  return island;
}
function openPanel(o: Partial<StreamPanelContext> = {}) {
  return renderIsland(FixtureStreamPanel, {
    fixture: FIXTURE,
    entrantNames: ENTRANTS,
    tz: TZ,
    stream: ctx(o),
  });
}

const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined =>
  tree.find((el) => attr(el, "data-testid") === id);
const allTestIds = (tree: ReactElement[], id: string): ReactElement[] =>
  tree.filter((el) => attr(el, "data-testid") === id);

/** The style strip's tabs, in DOM order, by the attribute that marks them —
 *  never by a `stream-tab-` testid prefix, which `stream-tab-obs` also matches. */
const styleTabs = (tree: ReactElement[]): ReactElement[] =>
  tree.filter((el) => typeof attr(el, "data-stream-style") === "string");
const styleIds = (tree: ReactElement[]): string[] =>
  styleTabs(tree).map((el) => String(attr(el, "data-stream-style")));

const click = (el: ReactElement | undefined): void => {
  const onClick = el && (propsOf(el).onClick as (() => void) | undefined);
  if (!onClick) throw new Error("no onClick on that element — the test is asserting nothing");
  onClick();
};

/** A click event whose `currentTarget` resolves `closest(root marker)` → a root whose `querySelector(opener)` → `found`,
 *  recording every selector asked — so a handler that looks up the wrong element reads null, not a lucky match. */
function fakeClick(found: { focus: () => void } | null) {
  const selectors: string[] = [];
  const root = { querySelector: (sel: string) => { selectors.push(sel); return sel === '[data-testid="stream-buy-more"]' ? found : null; } };
  const event = { currentTarget: { closest: (sel: string) => { selectors.push(sel); return sel === "[data-phone-body]" ? root : null; } } };
  return { event, selectors };
}

const stageOf = (tree: ReactElement[]): ReactElement => {
  const stage = tree.find((el) => el.type === OverlayStage);
  if (!stage) throw new Error("no <OverlayStage> in the panel — the preview is not the real stage");
  return stage;
};

/** The binding sheet itself — `live-cell-cap.test.ts`'s own path shape. */
const SHEET_PATH = join(
  __dirname,
  "../../../../../..",
  "docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md",
);
/** §8a's `QR size` row's cap — the `N` of its `min(Npx, available)` rule (amended 2026-09-30 to ≥ 320, spec §7; 2026-10-01
 *  to 363, so desktop keeps ≥ 320 at a whole number of px per module). */
const sheetQrCap = (): number => {
  const row = readFileSync(SHEET_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"));
  if (!row) throw new Error("§8a lost its QR size row");
  const cap = /min\((\d+)px, available\)/.exec(row)?.[1];
  if (!cap) throw new Error("§8a's QR size row no longer states min(Npx, available)");
  return Number(cap);
};
/** The stream QR as the body hands it to the shared component — an element the node harness does not expand, so it is
 *  found by TYPE and its `testId` PROP, never by `data-testid` (which only the component's own <img> carries). */
const qrImageOf = (tree: ReactElement[], testId: string): ReactElement | undefined =>
  tree.find((el) => el.type === SeaznQrImage && propsOf(el).testId === testId);

const DICT_DIR = join(__dirname, "..", "..", "..", "dictionaries");
const uiDict = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT_DIR, locale, "ui.json"), "utf8"));

// R5a: a tap now AWAITS the sheet's code before its POST. The first real `import()` of a module in this runner is file
// I/O (vite transforms it), which the fake-timer `settle()` below cannot wait out — in a browser that is the chunk fetch.
// So the module is loaded once up front; every later `import()` of it resolves in microtasks, as a cached chunk does.
beforeAll(async () => {
  await sheetLoader.real();
});

beforeEach(() => {
  sheetLoader.load.mockReset();
  sheetLoader.load.mockImplementation(sheetLoader.real);
  apiV1.mockReset();
  apiV1.mockImplementation(async () => ({}));
  fetchOverlayFixture.mockClear();
  searchParamsMock.set(new URLSearchParams(""));
  router.replace.mockReset();
});

describe("the style strip is built from the registry", () => {
  // A sport whose default differs from another's, so an ordering/selection
  // mistake cannot hide behind one lucky constant (AGENTS.md class 19).
  it("premise: two sports really do open on different themes", () => {
    expect(defaultThemeFor("cricket")).not.toBe(defaultThemeFor("football"));
  });

  it.each(["football", "cricket", "badminton"])(
    "%s renders exactly the themes themesForSport returns, in registry order",
    (sportKey) => {
      const tree = open({ sportKey }).tree();
      const expected = themesForSport(sportKey).map((t) => t.id);
      expect(expected.length, "premise: the registry offers more than one theme").toBeGreaterThan(1);
      expect(styleIds(tree)).toEqual(expected);
    },
  );

  it("labels every style tab from the registry's own labelKey, never English typed here", () => {
    const tree = open({ sportKey: "football" }).tree();
    for (const theme of themesForSport("football")) {
      const tab = byTestId(tree, `stream-tab-${theme.id}`);
      expect(tab, `no tab for ${theme.id}`).toBeDefined();
      const label = (messages as Record<string, string>)[theme.labelKey];
      expect(label, `${theme.labelKey} is missing from the ui catalog`).toBeTypeOf("string");
      expect(JSON.stringify(propsOf(tab!).children)).toContain(label);
    }
  });

  it("the OBS/Phone pair is NOT part of the style strip", () => {
    const tree = open().tree();
    expect(styleIds(tree)).not.toContain("obs");
    expect(styleIds(tree)).not.toContain("phone");
    expect(byTestId(tree, "stream-tab-obs"), "the OBS tab").toBeDefined();
    expect(byTestId(tree, "stream-tab-phone"), "the Phone tab").toBeDefined();
  });

  it("capture-qr-v2 OFF (owner 2026-10-04): no Phone/OBS switch at all — the OBS overlay shows directly, the Phone tab's container never mounts, and the stop probe keeps a leftover stream stoppable", () => {
    const off = openPanel({ relayEntitled: true, phoneCapture: false }).tree();
    let absent = 0;
    for (const id of ["stream-tab-phone", "stream-tab-obs", "stream-qr-text", "stream-code-card", "stream-go-live"]) {
      expect(byTestId(off, id), id).toBeUndefined();
      absent++;
    }
    expect(absent).toBe(5);
    expect(off.filter((el) => attr(el, "aria-label") === m("stream.tabs.label")), "the Phone/OBS tablist").toHaveLength(0);
    expect(off.find((el) => el.type === PhoneTab), "the phone container").toBeUndefined();
    // The OBS tab's own content, without a tap.
    expect(textAt(off, "stream-lead")).toBe(m("stream.line"));
    expect(styleTabs(off).length, "the OBS style strip").toBeGreaterThan(0);
    // The routes are not gated: a stream a phone already started keeps its way out.
    const probe = off.find((el) => el.type === PhoneStopProbe);
    expect(propsOf(probe!).fixtureId).toBe(FIXTURE.id);
    // The positive pair: flag on — the switch, Phone first (§3.1), the container mounted, no probe beside it.
    const on = openPanel({ relayEntitled: true, phoneCapture: true }).tree();
    expect(byTestId(on, "stream-tab-phone")).toBeDefined();
    expect(attr(byTestId(on, "stream-tab-phone")!, "aria-selected")).toBe(true);
    expect(on.find((el) => el.type === PhoneTab)).toBeDefined();
    expect(on.find((el) => el.type === PhoneStopProbe)).toBeUndefined();
    expect(byTestId(on, "stream-lead"), "the OBS lead is the OBS tab's").toBeUndefined();
  });

  it("every style tab is a real tab (role + aria-selected), exactly one selected", () => {
    const tabs = styleTabs(open().tree());
    for (const tab of tabs) expect(attr(tab, "role")).toBe("tab");
    expect(tabs.filter((t) => attr(t, "aria-selected") === true)).toHaveLength(1);
  });
});

describe("the strip OPENS on the sport's own default, not merely on something", () => {
  it.each(["football", "cricket", "badminton", "tennis", "volleyball"])(
    "%s opens on defaultThemeFor",
    (sportKey) => {
      const tree = open({ sportKey }).tree();
      const selected = styleTabs(tree).find((t) => attr(t, "aria-selected") === true);
      expect(String(attr(selected!, "data-stream-style"))).toBe(defaultThemeFor(sportKey));
    },
  );

  it.each(["football", "cricket"])("%s hands the preview the same default", (sportKey) => {
    const stage = stageOf(open({ sportKey }).tree());
    expect(propsOf(stage).style).toBe(defaultThemeFor(sportKey));
    expect(propsOf(stage).sportKey).toBe(sportKey);
  });

  it("selecting another style moves BOTH the preview and the OBS link", () => {
    const island = open({ sportKey: "football" });
    const other = themesForSport("football").find((t) => t.id !== defaultThemeFor("football"))!;
    click(styleTabs(island.tree()).find((t) => attr(t, "data-stream-style") === other.id));
    expect(propsOf(stageOf(island.tree())).style).toBe(other.id);
    expect(String(propsOf(byTestId(island.tree(), "stream-link")!).value)).toContain(
      `?style=${other.id}`,
    );
  });
});

describe("RT: the OBS URL the panel copies carries THIS fixture's signed overlay key", () => {
  it("the link is the overlay route with the style AND the page's key for this row's fixture — and Copy writes exactly that", async () => {
    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { writes.push(t); } } });
    try {
      const island = open({ sportKey: "football" });
      const link = String(propsOf(byTestId(island.tree(), "stream-link")!).value);
      const url = new URL(link, "http://origin.test");
      expect(url.pathname).toBe(`/overlay/fixtures/${FIXTURE.id}`);
      expect(url.searchParams.get("style")).toBe(defaultThemeFor("football"));
      expect(url.searchParams.get(OVERLAY_KEY_PARAM), "the key, under the route's own parameter name").toBe(ctx().overlayKeys[FIXTURE.id]);
      await (propsOf(byTestId(island.tree(), "stream-copy")!).onClick as () => Promise<void>)();
      expect(writes, "Copy puts the keyed URL on the clipboard").toEqual([link]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a key for ANOTHER fixture is never used, and no key for this row leaves the link keyless (the overlay then polls)", () => {
    const island = open({ overlayKeys: { "f-other": "KEY_other" } });
    const url = new URL(String(propsOf(byTestId(island.tree(), "stream-link")!).value), "http://origin.test");
    expect(url.searchParams.has(OVERLAY_KEY_PARAM)).toBe(false);
    expect(url.searchParams.get("style"), "the positive pair: the rest of the link is intact").toBe(defaultThemeFor("football"));
  });
});

describe("the preview is the real stage, seeded from the row", () => {
  it("renders <OverlayStage> inside the strip, on the row's own fixture", () => {
    const tree = open().tree();
    expect(byTestId(tree, "stream-preview"), "the 360px strip").toBeDefined();
    const stage = stageOf(tree);
    expect(propsOf(stage).fixtureId).toBe(FIXTURE.id);
    expect(propsOf(stage).fit, "the console preview scales its own wrapper").toBeFalsy();
    expect(propsOf(stage).realtime, "the console never opens a realtime channel").toBe(false);
    // RT (m6/R1): nor does it DECLARE the overlay purpose or carry the key — `realtime={false}` means what it says, and
    // the preview never mints a token. Absent as props, not merely falsy: the stage passes them straight to the hook.
    expect("realtimePurpose" in propsOf(stage), "the preview declares no realtime purpose").toBe(false);
    expect("overlayKey" in propsOf(stage), "the preview carries no overlay key").toBe(false);
    const initial = propsOf(stage).initial as { status: string; venueTz: string };
    expect(initial.status, "seeded from the row, so a dead endpoint still previews").toBe(
      FIXTURE.status,
    );
    expect(initial.venueTz, "the VENUE zone, never the org zone").toBe(TZ);
  });

  it("hands the stage the entrant names the row already resolved", () => {
    const stage = stageOf(open().tree());
    const sides = propsOf(stage).sides as { id: string; name: string }[];
    expect(sides.map((s) => s.name)).toEqual([ENTRANTS.e1, ENTRANTS.e2]);
  });

  // _THEMES.md §8, SECOND correction 2026-09-10: **scale to the container**.
  // The first correction (owner ruling, 360px strip) fixed the vertical half
  // only — at a FIXED `scale(640/1920)` the panel still painted a 640px canvas
  // however wide the strip actually was, so at a 320px viewport (~296px panel)
  // about a third of the frame was visible and §3's bar — cricket's default —
  // had its score cells cropped off the right edge with nothing to scroll to.
  //
  // 360 is not lost: it is 640 × 1080/1920, so a capped 640px strip is still
  // 360 tall. It is a consequence of the aspect ratio now instead of a number
  // of its own.
  //
  // WHAT THIS FILE CANNOT SEE: node has no layout, so nothing here measures a
  // strip or proves the observer fires. `previewScaleFor` is the pure half;
  // `stream-overlay.spec.ts`'s "§8: the preview scales to the strip" opens the
  // real console at three viewports and compares the painted canvas box with
  // the strip's own.
  it("the sheet binds a CONTAINER scale, not a constant", () => {
    // Derived from `_THEMES.md`, so a further amendment moves this test rather
    // than leaving it pinning a superseded value — which is exactly what the
    // pair of assertions this replaced had become.
    const sheet = readFileSync(SHEET_PATH, "utf8");
    const row = sheet.split("\n").find((l) => l.includes("| live preview |"));
    expect(row, "§8 no longer has a `live preview` row").toBeDefined();
    expect(row!, "the sheet must still bind scale-to-container").toMatch(/scale\(w\/1920\)/);
  });

  it("the whole authored canvas is visible at EVERY width, not just at one", () => {
    // The invariant, stated the way the sheet states it: authored px across the
    // strip = 1920 at any `w`. A constant satisfies this at exactly one width.
    for (const w of [214, 296, 375, 512, PREVIEW_MAX_W_PX]) {
      expect(w / previewScaleFor(w), `authored px across a ${w}px strip`).toBeCloseTo(CANVAS_W, 6);
    }
  });

  it("the differential — a phone-width strip is NOT the desktop number", () => {
    // The regression this exists for. `640/1920` is what shipped, and it is
    // what a reverted implementation would return at 296 as well.
    expect(previewScaleFor(296), "the defect: 296px of strip painting 640px of canvas").not.toBe(
      PREVIEW_MAX_W_PX / CANVAS_W,
    );
    expect(previewScaleFor(296)).toBe(296 / CANVAS_W);
    // ...and desktop is unchanged, which is what §8's OBS-link copy rests on.
    expect(previewScaleFor(PREVIEW_MAX_W_PX)).toBe(PREVIEW_MAX_W_PX / CANVAS_W);
    expect(PREVIEW_MAX_W_PX * (CANVAS_H / CANVAS_W), "the owner's 360px strip still falls out").toBe(
      360,
    );
  });

  it("the strip is capped at §8's 640, and a degenerate measurement falls back to it", () => {
    expect(previewScaleFor(900), "a wide console must not inflate the graphic").toBe(
      PREVIEW_MAX_W_PX / CANVAS_W,
    );
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(previewScaleFor(bad), `${bad} must not paint a zero-scale canvas`).toBe(
        PREVIEW_MAX_W_PX / CANVAS_W,
      );
    }
  });

  it("the strip is MEASURED and the canvas renders at that scale — not a constant nothing reads", () => {
    const tree = open().tree();
    const strip = byTestId(tree, "stream-preview");
    const style = propsOf(strip!).style as Record<string, unknown>;
    // The pinned pixel height is the thing the correction removed: the strip's
    // height follows its own width now, so there is no second number to drift.
    expect(style.height, "a pinned pixel height is a fixed scale wearing a hat").toBeUndefined();
    expect(style.aspectRatio).toBe(`${CANVAS_W} / ${CANVAS_H}`);
    expect(style.maxWidth).toBe(PREVIEW_MAX_W_PX);
    // A ref on the strip is what makes the scale a MEASUREMENT. Without it
    // nothing observes the box and `previewScaleFor` can only ever be handed
    // its own fallback — the constant, back again, with a function around it.
    expect(propsOf(strip!).ref, "nothing measures the strip").toBeDefined();
    const canvas = byTestId(tree, "stream-preview-canvas");
    const cstyle = propsOf(canvas!).style as Record<string, unknown>;
    expect(cstyle.width).toBe(CANVAS_W);
    expect(cstyle.height).toBe(CANVAS_H);
    // Unmeasured (no layout here), so this is the fallback — but it must be
    // the FUNCTION's fallback, not a literal beside it.
    expect(cstyle.transform).toBe(`scale(${previewScaleFor(PREVIEW_MAX_W_PX)})`);
    expect(String(propsOf(strip!).className), "no h-24 (96px) left behind").not.toMatch(/\bh-\d/);
  });
});

describe("the opaque-preview caption is dictionary-driven, not theme-named", () => {
  const captionKeyFor = (id: string) => `stream.preview.${id}`;
  const en = uiDict("en");
  const withCaption = themesForSport("football")
    .map((t) => t.id)
    .filter((id) => typeof en[captionKeyFor(id)] === "string");

  it("bar and bug declare no opaque caption — only a future opaque theme would", () => {
    // 2026-09-12: slate retired as a theme; match card is a transparent layer.
    // The caption mechanism remains: `stream.preview.<id>` when a theme needs it.
    expect(withCaption).toEqual([]);
  });

  it("every declared caption exists in all four locales", () => {
    for (const locale of ["en", "fr", "es", "nl"]) {
      const dict = uiDict(locale);
      for (const id of withCaption) {
        expect(typeof dict[captionKeyFor(id)], `${locale} is missing ${captionKeyFor(id)}`).toBe(
          "string",
        );
      }
    }
  });

  it("shows the caption for a theme that declares one and for no other", () => {
    for (const theme of themesForSport("football")) {
      const island = open({ sportKey: "football" });
      click(styleTabs(island.tree()).find((t) => attr(t, "data-stream-style") === theme.id));
      const note = byTestId(island.tree(), "stream-preview-note");
      if (withCaption.includes(theme.id)) {
        expect(note, `${theme.id} declares a caption`).toBeDefined();
        expect(JSON.stringify(propsOf(note!).children)).toContain(en[captionKeyFor(theme.id)]);
      } else {
        expect(note, `${theme.id} declares no caption`).toBeUndefined();
      }
    }
  });
});

describe("the stream-link field refuses a bad link before it sends", () => {
  const type = (island: ReturnType<typeof open>, value: string) => {
    const input = byTestId(island.tree(), "stream-url-input")!;
    (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  };

  it("an off-list host is refused inline and NEVER reaches the API", async () => {
    const island = open();
    type(island, "https://evil.example/www.youtube.com");
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    const error = byTestId(island.tree(), "stream-error");
    expect(error, "no inline error rendered").toBeDefined();
    expect(JSON.stringify(propsOf(error!).children)).toContain(messages["stream.error.link"]);
    expect(apiV1).not.toHaveBeenCalled();
  });

  it("an allowed host PUTs the fixture's stream route and reaches Saved", async () => {
    const island = open();
    const url = "https://www.youtube.com/watch?v=abc";
    type(island, url);
    expect(JSON.stringify(propsOf(byTestId(island.tree(), "stream-save")!).children)).toContain(
      messages["stream.save"],
    );
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    expect(apiV1).toHaveBeenCalledTimes(1);
    expect(apiV1.mock.calls[0]![0]).toBe(`/api/v1/fixtures/${FIXTURE.id}/stream`);
    expect(apiV1.mock.calls[0]![1]).toMatchObject({ method: "PUT", json: { streamUrl: url } });
    expect(JSON.stringify(propsOf(byTestId(island.tree(), "stream-save")!).children)).toContain(
      messages["stream.saved"],
    );
    expect(byTestId(island.tree(), "stream-error")).toBeUndefined();
  });

  it("an empty field CLEARS the link (null on the wire), it is not an error", async () => {
    const island = open();
    type(island, "   ");
    await (propsOf(byTestId(island.tree(), "stream-save")!).onClick as () => Promise<void>)();
    expect(byTestId(island.tree(), "stream-error")).toBeUndefined();
    expect(apiV1.mock.calls[0]![1]).toMatchObject({ json: { streamUrl: null } });
  });
});

/** A sentence as the English catalog renders it, `{var}` filled — the copy a customer reads. */
const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);

/** P3/P4 (fix round 3): what every Stop confirm must carry — its cancel from the PAGE's dictionary, and the touch size. */
const STOP_CONFIRM_EXTRAS = { cancelLabel: m("stream.phone.stop.keep"), size: "touch" } as const;

/** The fixture's stream code as the T5 route answers it (§6.2's alphabet and tok, written out here). */
const CODE_QR: CaptureQrV2 = CaptureQrV2.parse({ v: 2, code: "k7m2q9xr4tbw", slot: 0, tok: "f3Kq9_ZtR2mXw8LpN4vB0a" });
const CODE_TEXT = captureQrV2Text(CODE_QR);
/** An encoded symbol, as the browser hands the body one (57 modules: the v2 payload's v8 + the quiet zone). */
const SYMBOL: SeaznQr = { src: "data:image/svg+xml;charset=utf-8,code", modules: 57 };

type Facts = NonNullable<StreamPhone["phone"]>;
/** The paired phone's facts as the T9 read model serves them — present, answering, nothing wrong. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "capture/2", mode: "operator",
  state: "paired", notReady: null, notReadyForMs: null, notReadyShown: false, health: null, startFailed: null,
  lastBeatAt: "2026-09-14T11:59:55.000Z", elapsedMs: 5_000,
  beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false, ...over,
});
/** The `stream-phone` read model (§9, T9): an active code with a paired, present phone — Ready's "paired" row. */
const readModel = (over: Partial<StreamPhone> = {}): StreamPhone => ({
  code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "active", endCause: null }, phone: facts(), destination: null,
  lastTakeover: null, auto: null, legacy: false, finished: false, session: null, ...over,
});
/** §6.9: paired, but the phone has stopped answering. */
const SILENT = facts({ present: false, silent: true, elapsedMs: 90_000 });
/** C5: the match is over — finished, and its code ended. */
const MATCH_OVER = readModel({ finished: true, phone: null, code: { issuedAt: "2026-09-14T09:00:00.000Z", state: "ended", endCause: "expired" } });
/** C-1: an open session with no pairing (it opened before stream codes) — today's panel. */
const LEGACY = readModel({ legacy: true, phone: null, code: null });

const session = (over: Partial<StreamSessionView> = {}): StreamSessionView => ({
  id: "s1", fixtureId: "f-1", mode: "passthrough", state: "warming", desiredState: "live",
  failReason: null, health: null, ingest: { state: "disconnected", protocol: null }, output: null,
  balance: 2, startedAt: null, endedAt: null, replayUrl: null,
  target: { id: "t1", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: false,
  startCause: "organiser", restart: null, countdown: null,
  ...over,
});

const TARGETS: StreamTarget[] = [
  { id: "t1", kind: "youtube", label: "Club", watchUrl: null, createdAt: "2026-09-01T10:00:00.000Z", keyHint: "abc", inUse: null },
  { id: "t2", kind: "twitch", label: "Alt", watchUrl: null, createdAt: "2026-09-02T10:00:00.000Z", keyHint: null, inUse: null },
];

describe("the Phone tab reads the §5.3 gate, then hands the container the context (D15)", () => {
  const phone = (o: Partial<StreamPanelContext>) => {
    const island = open(o);
    click(byTestId(island.tree(), "stream-tab-phone"));
    return island;
  };

  it("I4: without streaming.relay it is the SWITCHED-OFF state (staff turned it off; since V426 every plan grants it) — plus the stop-only probe ABOVE it (G2), never the full tab", () => {
    const tree = phone({ relayEntitled: false }).tree();
    expect(byTestId(tree, "stream-phone-gate"), "the gate card").toBeDefined();
    const gate = byTestId(tree, "stream-switched-off");
    expect(gate, "no switched-off state").toBeDefined();
    expect(textOf(gate!)).toContain(m("stream.phone.switchedOff"));
    // Direction, not mood: the way back is a real address.
    const mail = tree.find((el) => el.type === "a" && String(attr(el, "href")).startsWith("mailto:"));
    expect(attr(mail!, "href")).toBe("mailto:support@seazn.club");
    expect(tree.find((el) => el.type === PhoneTab), "no container behind the gate").toBeUndefined();
    // G2: a stream started while the org HAD the relay must stay stoppable after it lost it (lane C C1: "Stop not
    // stopping a youth broadcast is a safety defect"). The probe reads THIS row's fixture, and it comes first.
    const probe = tree.find((el) => el.type === PhoneStopProbe);
    expect(probe, "nothing can stop a live stream on an unentitled org").toBeDefined();
    expect(propsOf(probe!).fixtureId).toBe(FIXTURE.id);
    expect(tree.indexOf(probe!), "the probe renders above the gate").toBeLessThan(tree.indexOf(gate!));
    expect(byTestId(tree, "stream-phone-unavailable"), "switched off is not 'unavailable'").toBeUndefined();
    // …and an entitled tab has no probe: the container owns the session there.
    expect(phone({ relayEntitled: true }).tree().find((el) => el.type === PhoneStopProbe)).toBeUndefined();
  });

  it("I4: a switched-off org is never sold a plan — no upgrade gate, no upgrade link and no price anywhere in the tab", () => {
    // An override outranks every plan, so "Go Pro — £X/mo" sold a plan that could not lift the switch-off.
    const tree = phone({ relayEntitled: false, streamBalance: 0 }).tree();
    expect(byTestId(tree, "stream-switched-off"), "premise: the switched-off state rendered").toBeDefined();
    expect(tree.find((el) => el.type === UpgradeGate), "an upgrade gate").toBeUndefined();
    const links = tree.filter((el) => el.type === "a" || typeof attr(el, "href") === "string").map((el) => String(attr(el, "href")));
    expect(links.length, "premise: the tab's links were collected").toBeGreaterThan(0);
    for (const href of links) expect(href, "an upgrade link").not.toMatch(/\/settings\/billing|\/upgrade/);
    const text = textOf(tree[0]!);
    for (const sign of ["£", "$", "€", "₹", "/mo"]) expect(text, sign).not.toContain(sign);
    expect(text).not.toContain(m("stream.credits.title"));
  });

  it("I2: a deployment with NO relay shows 'unavailable' in place of the whole tab — no buy tiles, no Go live — and keeps the stop probe; a switched-off org still sees its own state", () => {
    const tree = phone({ relayEntitled: true, relayDisabled: true, streamBalance: 4 }).tree();
    expect(textAt(tree, "stream-phone-unavailable")).toBe(m("stream.phone.unavailable"));
    expect(tree.find((el) => el.type === PhoneTab), "no buy tiles and no Go live behind it").toBeUndefined();
    const probe = tree.find((el) => el.type === PhoneStopProbe);
    expect(probe, "a leftover stream must stay stoppable").toBeDefined();
    expect(propsOf(probe!).fixtureId).toBe(FIXTURE.id);
    expect(tree.indexOf(probe!)).toBeLessThan(tree.indexOf(byTestId(tree, "stream-phone-unavailable")!));
    // Both at once: the org-specific state wins — it says how to get streaming back.
    const both = phone({ relayEntitled: false, relayDisabled: true }).tree();
    expect(byTestId(both, "stream-switched-off")).toBeDefined();
    expect(byTestId(both, "stream-phone-unavailable")).toBeUndefined();
    // The positive pair: the relay back on is the real tab.
    expect(phone({ relayEntitled: true, relayDisabled: false }).tree().find((el) => el.type === PhoneTab)).toBeDefined();
  });

  it("B1: the W1 lead line is the OBS tab's — the Phone tab has no scorebug and nothing to paste back (§8a's frame has no lead)", () => {
    const island = open({ relayEntitled: true });
    expect(textAt(island.tree(), "stream-lead")).toBe(m("stream.line"));
    click(byTestId(island.tree(), "stream-tab-phone"));
    expect(byTestId(island.tree(), "stream-lead"), "the OBS promise shows above the Phone tab").toBeUndefined();
    expect(textOf(island.tree()[0]!)).not.toContain(m("stream.line"));
    click(byTestId(island.tree(), "stream-tab-obs"));
    expect(byTestId(island.tree(), "stream-lead"), "…and comes back with OBS").toBeDefined();
  });

  it("with streaming.relay it mounts the container with THIS row's fixture and the page's org, balance and plan", () => {
    const split = { monthly: 1, pack: 3, total: 4 };
    const tree = phone({ relayEntitled: true, orgId: "o-77", streamBalance: 4, streamSplit: split, monthlyAllowance: 5, currency: "inr", phoneLostMinutes: 7, autoStopMinutes: 9 }).tree();
    expect(byTestId(tree, "stream-switched-off"), "no refusal once entitled").toBeUndefined();
    const tab = tree.find((el) => el.type === PhoneTab);
    expect(tab, "the Phone tab body is not the container").toBeDefined();
    // Each value differs from ctx()'s default, so a prop wired to the wrong field (or a constant) cannot pass.
    expect(propsOf(tab!)).toMatchObject({ fixtureId: FIXTURE.id, orgId: "o-77", streamBalance: 4, streamSplit: split, monthlyAllowance: 5, currency: "inr", phoneLostMinutes: 7 });
    // PR-2 T10/T12: the auto stop's delay (the server's, through the context loader) and the venue zone (the takeover's
    // clock) — each a value ctx()'s default cannot produce.
    expect(ctx().autoStopMinutes, "premise: the default differs").not.toBe(9);
    expect(propsOf(tab!)).toMatchObject({ autoStopMinutes: 9, tz: TZ });
  });

  it("buying is the EMBEDDED checkout in the repo's Modal, never a navigation (owner ruling 8) — the source half", () => {
    // The behaviour is driven below (PhoneTab — checkout). This pins the negative the node harness cannot drive: no
    // hosted-checkout hop anywhere in the module — nor in the lazily loaded checkout sheet (I2).
    const src = readFileSync(join(__dirname, "..", "fixture-stream-panel.tsx"), "utf8");
    const sheet = readFileSync(join(__dirname, "..", "stream-checkout-modal.tsx"), "utf8");
    // I2: the sheet is its OWN chunk, fetched on first render — never a static import of the panel. M2: its one loader
    // is its own module (so the warm-up is countable), and the panel hands that loader to dynamic().
    const loaderSrc = readFileSync(join(__dirname, "..", "stream-checkout-sheet-loader.ts"), "utf8");
    expect(loaderSrc).toMatch(/export const loadCheckoutSheet = makeSheetLoader\(\(\) => import\("\.\/stream-checkout-modal"\)\);/);
    expect(src).toMatch(/import \{ loadCheckoutSheet \} from "\.\/stream-checkout-sheet-loader";/);
    expect(src).toMatch(/dynamic\(loadCheckoutSheet, \{ ssr: false \}\)/);
    expect(sheet).toMatch(/EmbeddedCheckoutProvider/);
    expect(sheet).toMatch(/data-testid="stream-checkout-modal"/);
    expect(src).toMatch(/fetchRelayCheckoutClientSecret/);
    for (const text of [src, sheet]) expect(text).not.toMatch(/window\.location\.assign|checkout\.stripe\.com/);
    // C22: the 402 gate is read off STATUS — `CheckoutSecretResult` has no code field.
    expect(src).toMatch(/result\.status === 402/);
    expect(src).not.toMatch(/result\.code/);
    // C1: the idle tab's balance has a source when there is no session (m2: a no_credits refusal reads it as 0).
    expect(src).toMatch(/view \? view\.balance : noCredits \? 0 : streamBalance/);
    // W4 (capture QR v2 §6.13): the session's read — on the page's one poller (T9b) — asks no reveal any more; the route
    // answers 400 to one (routes.test.ts). The positive pair: the provider still reads `current`.
    const provider = readFileSync(join(__dirname, "..", "stream-session-provider.tsx"), "utf8");
    expect(provider).not.toMatch(/reveal/i);
    expect(provider).toMatch(/\/stream-sessions\/current`/);
    // The legacy transport prefixes nothing and drops the extras (404s here) — v1 only.
    expect(src).not.toMatch(/from "@\/lib\/client"/);
  });

  it("I2: Stripe.js is NOT in the panel's static import graph — the fixtures tab never loads js.stripe.com until a checkout opens", () => {
    // `@stripe/stripe-js`'s main entry injects js.stripe.com as an IMPORT side effect, and the panel ships on every
    // organiser fixtures tab (run-sheet-row.tsx imports it). So the whole static graph is walked, not just the panel's
    // own import lines: a Stripe import re-introduced two modules away reds here too. `import type` is erased and a
    // dynamic `import()` is a separate chunk, so neither is an edge.
    const SRC = join(__dirname, "..", "..", "..");
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
      if (!base) return null;
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (/\.(ts|tsx)$/.test(cand) && existsSync(cand)) return cand;
      }
      return null;
    };
    const graph = (entry: string) => {
      const seen = new Set<string>();
      const bare = new Set<string>();
      const queue = [entry];
      while (queue.length) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        const specs = [
          ...[...text.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[\s\S]*?)\sfrom\s+"([^"]+)"/gm)].map((mm) => mm[1]!),
          ...[...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((mm) => mm[1]!),
        ];
        for (const spec of specs) {
          const next = resolve(file, spec);
          if (next) queue.push(next);
          else bare.add(spec);
        }
      }
      return { files: seen, bare };
    };
    const panel = graph(join(__dirname, "..", "fixture-stream-panel.tsx"));
    const stripeish = (g: ReturnType<typeof graph>) => [
      ...[...g.bare].filter((b) => b.startsWith("@stripe/")),
      ...[...g.files].filter((f) => f.endsWith("stripe-browser.ts")),
    ];
    expect(stripeish(panel), "a static path from the panel reaches Stripe.js").toEqual([]);
    // Anti-vacuity: the walk really followed the panel's imports (it reaches the view model and the upgrade gate)…
    expect(panel.files.size, "the walk read no modules").toBeGreaterThan(10);
    expect([...panel.files].some((f) => f.endsWith("stream-session-view.ts"))).toBe(true);
    // …and the positive pair: the SAME walk finds Stripe from the lazily loaded sheet, so it can see one when it is there.
    const sheet = graph(join(__dirname, "..", "stream-checkout-modal.tsx"));
    expect(stripeish(sheet).sort()).toEqual(expect.arrayContaining(["@stripe/react-stripe-js"]));
    expect([...sheet.files].some((f) => f.endsWith("stripe-browser.ts")), "the sheet's own stripePromise").toBe(true);
  });

  it("the OBS tab's own body is gone while Phone is selected, and comes back", () => {
    const island = phone({ relayEntitled: true });
    expect(byTestId(island.tree(), "stream-preview")).toBeUndefined();
    click(byTestId(island.tree(), "stream-tab-obs"));
    expect(byTestId(island.tree(), "stream-preview")).toBeDefined();
    expect(byTestId(island.tree(), "stream-phone-gate")).toBeUndefined();
  });
});

describe("phone first — the 44px floor is the BASE, not an override", () => {
  // §8: "at 320 every control full width and 44 px tall, tabs 44 px". Written
  // mobile-first, so the floor must be on the UNPREFIXED class: a
  // `max-md:h-11` would satisfy the rendered page only by out-ordering a base
  // utility in the generated CSS, which nothing in a node-environment suite
  // can see. This asserts the spelling that needs no ordering at all.
  const TAPPABLE = /(^|\s)(min-h-11|h-11)(\s|$)/;

  it("every control an organiser taps carries it", () => {
    const seen: string[] = [];
    const check = (el: ReactElement | undefined, what: string) => {
      expect(el, `${what} did not render`).toBeDefined();
      seen.push(what);
      expect(
        String(propsOf(el!).className ?? ""),
        `${what} has no unprefixed 44px floor`,
      ).toMatch(TAPPABLE);
    };
    for (const relayEntitled of [false, true]) {
      const island = open({ relayEntitled });
      for (const tab of styleTabs(island.tree())) check(tab, `style tab ${attr(tab, "data-stream-style")}`);
      for (const id of ["stream-tab-obs", "stream-tab-phone", "stream-link", "stream-copy", "stream-url-input", "stream-save"]) {
        check(byTestId(island.tree(), id), id);
      }
      // The Phone tab's own controls live in `PhoneTabBody`; their floor is swept state by state below.
    }
    // The positive pair: without it an empty tree passes every check above. Two passes × (the registry's style tabs +
    // the six OBS-tab controls) — derived from the registry, so a fourth theme moves the floor with it.
    expect(seen.length, "nothing was checked").toBe(2 * (themesForSport("football").length + 6));
    expect(seen.length).toBeGreaterThanOrEqual(16);
  });

});

describe("one DOM, branched — never a second phone tree", () => {
  it("nothing in the panel is hidden by width, at either tab", () => {
    let checked = 0;
    for (const relayEntitled of [false, true]) {
      const island = open({ relayEntitled });
      for (const testId of ["stream-tab-obs", "stream-tab-phone"]) {
        click(byTestId(island.tree(), testId));
        const tree = island.tree();
        const hidden = tree
          .map((el) => String(propsOf(el).className ?? ""))
          .filter((cls) => /(^|\s)(max-)?md:hidden(\s|$)/.test(cls));
        expect(hidden, `${testId} hides a control by width`).toEqual([]);
        checked += tree.length;
      }
    }
    expect(checked, "the sweep read no elements").toBeGreaterThan(0);
  });

  // D16 → §3.2 (T9a): §8a's stepper pair (the `ol` at ≥ 768 and its one-line twin) is gone. The Signal path is ONE
  // drawing at every width — only its destination LABEL moves, inside `<SignalChain>` (stream-signal-chain.test.tsx
  // pins that twin). So the body itself hides nothing by width, and every control is a single instance.
  it("across every PhoneTabBody state, nothing the body renders is hidden by width, and every control appears once", () => {
    let states = 0;
    let chained = 0;
    for (const [name, tree] of bodyStates()) {
      const hidden = tree.filter((el) => /(^|\s)(max-)?md:hidden(\s|$)/.test(String(propsOf(el).className ?? "")));
      expect(hidden.map((el) => attr(el, "data-testid") ?? el.type), name).toEqual([]);
      const ids = tree.map((el) => attr(el, "data-testid")).filter((id): id is string => typeof id === "string");
      const repeated = ids.filter((id, i) => ids.indexOf(id) !== i && id !== "stream-health-chip");
      expect(repeated, `${name}: a control is rendered twice`).toEqual([]);
      expect(tree.filter((e) => e.type === SignalChain).length, `${name}: at most one chain`).toBeLessThanOrEqual(1);
      if (chainOf(tree)) chained++;
      states++;
    }
    expect(states).toBe(bodyStates().length);
    expect(states).toBeGreaterThanOrEqual(8);
    expect(chained, "the chain was drawn in some state, or the single-instance check above was vacuous").toBeGreaterThan(0);
  });
});

// ─── The return (spec 2026-09-30 §2) ────────────────────────────────────────────────────────────────────────────────
// The checkout return and the run sheet's chip both land on the FIXTURE page with `?stream=open`. The page reads it on the
// server and hands the panel `openedByReturn`; the URL on its own opens nothing (T6 removed `checkoutReturnFor` and the
// run-sheet toggle it drove). The page IS the fixture, so there is no `fixture` param to name a row any more.
describe("the return opens the panel on the Phone tab — on the fixture page's word, `openedByReturn`", () => {
  const RETURN = "stream=open&checkout=success&session_id=cs_test_1";
  const panel = (openedByReturn?: boolean, relayEntitled = true) =>
    renderIsland(FixtureStreamPanel, { fixture: FIXTURE, entrantNames: ENTRANTS, tz: TZ, stream: ctx({ relayEntitled }), openedByReturn });

  it("T5: `openedByReturn` opens on the PHONE tab and strips the return; an ordinary open strips nothing", () => {
    searchParamsMock.set(new URLSearchParams(RETURN));
    const here = panel(true).tree();
    expect(attr(byTestId(here, "stream-tab-phone")!, "aria-selected"), "the fixture page's return lands on Phone").toBe(true);
    expect(byTestId(here, "stream-phone-gate"), "the Phone tab body").toBeDefined();
    expect(router.replace, "the return's params are stripped (G5)").toHaveBeenCalledWith(PATHNAME, { scroll: false });
    router.replace.mockReset();
    // The same URL without the page's word: an ordinary open — still Phone (T9b's default), and nothing stripped.
    const ordinary = panel(false).tree();
    expect(attr(byTestId(ordinary, "stream-tab-phone")!, "aria-selected")).toBe(true);
    expect(router.replace, "an ordinary open strips nothing").not.toHaveBeenCalled();
  });

  // Spec §3.1 (T9b): tabs Phone first, the default; OBS overlay second, today's OBS tab.
  it("T9b: Phone is the FIRST tab and the DEFAULT — first in the markup, selected with no openedByReturn; OBS is one tap away", () => {
    for (const openedByReturn of [undefined, false]) {
      const island = panel(openedByReturn);
      const tree = island.tree();
      const tabs = tree.filter((el) => attr(el, "role") === "tab" && typeof attr(el, "data-stream-style") !== "string");
      expect(tabs.map((el) => attr(el, "data-testid")), "the mode tabs, in DOM order").toEqual(["stream-tab-phone", "stream-tab-obs"]);
      expect(attr(tabs[0]!, "aria-selected"), "Phone is selected").toBe(true);
      expect(attr(tabs[1]!, "aria-selected"), "OBS is not").toBe(false);
      expect(byTestId(tree, "stream-phone-gate"), "the Phone tab's body is what shows").toBeDefined();
      expect(byTestId(tree, "stream-preview"), "…and the OBS preview is not").toBeUndefined();
      expect(textOf(tabs[1]!)).toBe(m("stream.tab.obs"));
      click(byTestId(tree, "stream-tab-obs"));
      expect(byTestId(island.tree(), "stream-preview"), "OBS overlay opens on a tap").toBeDefined();
    }
  });

  it("T6: the old run-sheet return URL (`?stream=open&fixture=<this id>`) opens nothing by itself — the URL is no longer a reader", () => {
    searchParamsMock.set(new URLSearchParams(`tab=fixtures&fixture=${FIXTURE.id}&${RETURN}`));
    panel(undefined).tree();
    expect(router.replace, "nothing consumed, nothing stripped").not.toHaveBeenCalled();
  });

  it("G5: once consumed, the return's params are stripped with router.replace — every other param kept, once", () => {
    // A reload or a shared link must not re-open the panel (or re-run the reconcile) on a URL whose purchase is done.
    searchParamsMock.set(new URLSearchParams(`${RETURN}&court=2`));
    const island = panel(true);
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(`${PATHNAME}?court=2`, { scroll: false });
    island.rerender({ fixture: FIXTURE, entrantNames: ENTRANTS, tz: TZ, stream: ctx({ relayEntitled: true }), openedByReturn: true });
    expect(router.replace, "a re-render stripped again").toHaveBeenCalledTimes(1);
    // …and a return with nothing else on the URL lands on the bare path.
    router.replace.mockReset();
    searchParamsMock.set(new URLSearchParams("stream=open"));
    panel(true, false);
    expect(router.replace).toHaveBeenCalledWith(PATHNAME, { scroll: false });
    // A `fixture` param is no longer the return's (the page IS the fixture): it is kept like any other.
    router.replace.mockReset();
    searchParamsMock.set(new URLSearchParams("stream=open&fixture=kept"));
    panel(true, false);
    expect(router.replace).toHaveBeenCalledWith(`${PATHNAME}?fixture=kept`, { scroll: false });
  });

  it("B2: the return scrolls the opened panel into view ONCE — smooth, instant under reduced motion; an ordinary open never scrolls", () => {
    const REDUCE = "(prefers-reduced-motion: reduce)";
    const attach = (reduce: boolean, openedByReturn: boolean) => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q === REDUCE, media: q }));
      searchParamsMock.set(new URLSearchParams(openedByReturn ? RETURN : ""));
      const section = byTestId(panel(openedByReturn).tree(), "stream-panel")!;
      const el = { scrollIntoView: vi.fn() };
      const ref = attr(section, "ref");
      if (typeof ref === "function") {
        ref(el);
        ref(el); // React re-attaches a callback ref; the scroll must not repeat
      }
      return el.scrollIntoView;
    };
    try {
      const smooth = attach(false, true);
      expect(smooth).toHaveBeenCalledTimes(1);
      expect(smooth).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
      const still = attach(true, true);
      expect(still).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
      expect(attach(false, false), "an ordinary open scrolled").not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    // The landing clears the console's sticky bars rather than tucking the panel's heading under them.
    const cls = String(attr(byTestId(panel(true).tree(), "stream-panel")!, "className")).split(/\s+/);
    expect(cls.some((c) => /^scroll-mt-/.test(c)), "no scroll margin").toBe(true);
  });
});

// ─── PhoneTabBody: every §8a / §8b state from the projection alone ──────────────────────────────────────────────────
const NOW = new Date("2026-09-14T12:00:00Z");
const BODY: PhoneTabBodyProps = {
  fixtureId: "f-1", view: null, balance: 0, targets: { status: "ok", list: [] }, busy: false, createError: null, checkoutError: null,
  selectedTargetId: null, phone: readModel(), code: { status: "loading" }, codeOpen: false, now: NOW, copied: false, showBuy: false,
  planGate: false, stopFailed: false, checkoutOpen: false, currency: "gbp", split: null, monthlyAllowance: 0, restart: null, pickFailed: false,
  phoneLostMinutes: 20, autoStopMinutes: 3, autoPending: null, autoFailed: false, takeoverDismissedAt: null, tz: "Europe/London",
  onToggleAuto: () => {}, onDismissTakeover: () => {},
  onSelectTarget: () => {}, onRetryTargets: () => {}, onGoLive: () => {}, onStop: () => {}, onCancel: () => {},
  onBuy: () => {}, onAgain: () => {}, onCopy: () => {}, onToggleCode: () => {}, onReissue: () => {}, onRetryCode: () => {},
  onShowBuy: () => {}, onTileIntent: () => {},
};
/** A loaded list — what most states render with. */
const ok = (list: StreamTarget[]): TargetsState => ({ status: "ok", list });
/** `targets` may be given as a bare list (a LOADED one) — every state below that is not about the load itself. */
type BodyArgs = Omit<Partial<PhoneTabBodyProps>, "targets"> & { targets?: StreamTarget[] | TargetsState };
const body = ({ targets, ...p }: BodyArgs = {}): ReactElement[] =>
  walk(expandWithHooks(PhoneTabBody, { ...BODY, ...p, targets: Array.isArray(targets) ? ok(targets) : targets ?? BODY.targets }));
/** The list a TargetsState holds, or a failure naming the state it was in. */
const listOf = (t: TargetsState): StreamTarget[] => {
  if (t.status !== "ok") throw new Error(`the destinations are ${t.status}, not loaded`);
  return t.list;
};
const textAt = (tree: ReactElement[], id: string): string => {
  const el = byTestId(tree, id);
  if (!el) throw new Error(`no ${id} in the tree`);
  return textOf(el).replace(/\s+/g, " ").trim();
};

/** §3.2 (T9a): the Signal path the body hands `<SignalChain>` — the node harness expands one level, so the chain is an
 *  element whose PROPS are what this file reads (its drawing is stream-signal-chain.test.tsx's). */
const chainOf = (tree: ReactElement[]) => {
  const el = tree.find((e) => e.type === SignalChain);
  return el ? (propsOf(el) as unknown as { chain: ReturnType<typeof chainFor>; destination: { kind: string; label: string } }) : undefined;
};

/** The ended card's chips, in order, by testid — every span in its chip row, so a chip added without a testid still counts. */
const endedChips = (tree: ReactElement[]): string[] => {
  const card = byTestId(tree, "stream-ended");
  if (!card) throw new Error("no stream-ended card in the tree");
  const row = walk(propsOf(card).children as ReactElement).find((el) => el.type === "div");
  if (!row) throw new Error("the ended card has no chip row");
  return walk(propsOf(row).children as ReactElement).filter((el) => el.type === "span").map((el) => String(attr(el, "data-testid")));
};

/** B3: the states that are the heading and the credits card ONLY — no stepper, no pill (idle, balance < 1). */
const CREDITS_ONLY = new Set(["idle, balance 0 (the credits card)"]);

/** Every state the body renders, named — the sweeps below iterate THIS list and assert they read all of it. */
/** A target_in_use refusal's holder — another match, live, with its page (T8). */
const IN_USE_HOLDER = { sessionId: "s9", fixtureId: "f-9", href: "/o/org/c/comp/d/div/f/5", matchNo: 5, courtName: "Court 1", state: "live" as const, label: "Club YouTube" };

function bodyStates(): [string, ReactElement[]][] {
  return [
    ["idle, balance 0 (the credits card)", body({ view: null, balance: 0 })],
    ["idle, balance 2", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" })],
    ["idle, no destinations yet", body({ view: null, balance: 2, targets: [], selectedTargetId: null })],
    ["idle, the destination list failed to load", body({ view: null, balance: 2, targets: { status: "error" }, selectedTargetId: null })],
    ["idle, the destination list loading", body({ view: null, balance: 2, targets: { status: "loading" }, selectedTargetId: null })],
    ["idle, a refused create", body({ view: null, balance: 1, targets: TARGETS, selectedTargetId: "t1", createError: { code: "storage_exhausted", holder: null } })],
    ["idle, Buy more opened", body({ view: null, balance: 2, showBuy: true, checkoutError: "owner" })],
    ["idle, the destination in use", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "target_in_use", holder: IN_USE_HOLDER } })],
    // Capture QR v2 §6.12 (Option B rev 2): the Ready rows, each with the code where it shows.
    ["ready, no phone (the code card)", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: null }), code: { status: "ok", text: CODE_TEXT, image: SYMBOL } })],
    ["ready, no phone, the code refused", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: null }), code: { status: "error" } })],
    ["ready, paired, the code shown again", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", codeOpen: true, code: { status: "ok", text: CODE_TEXT, image: SYMBOL } })],
    ["ready, silent", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: SILENT }) })],
    ["ready, inside the reuse window at the limit", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", restart: { windowOpen: true, used: 3, limit: 3, free: false } })],
    ["ready, the match over", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: MATCH_OVER })],
    ["provisioning", body({ view: session({ state: "provisioning" }), balance: 2 })],
    ["warming", body({ view: session(), balance: 2, phone: readModel({ phone: facts({ farPoll: true }) }) })],
    ["warming, the countdown", body({ view: session({ countdown: { kind: "warming", reason: "no_inbound_timeout", elapsedMs: 45_000, remainingMs: 555_000 } }), balance: 2 })],
    ["live, the phone lost (the countdown)", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z", output: { state: "unknown", since: "2026-09-14T11:57:00Z", elapsedMs: 180_000 }, countdown: { kind: "live", reason: "phone_lost", elapsedMs: 160_000, remainingMs: 740_000 } }), balance: 1, phone: readModel({ phone: SILENT }) })],
    ["live, paused (O5)", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 1, phone: readModel({ phone: facts({ notReady: "camera", state: "publishing" }) }) })],
    ["live, a legacy session", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 1, phone: LEGACY })],
    ["live", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z", fixtureDecided: true, health: { fps: 30, bitrateKbps: 2900, lastBeatAt: "2026-09-14T11:59:56Z" } }), balance: 1 })],
    // PR-2 (Option A): the switch on, a refused automatic start, a takeover notice, the live line + Details data, an amber.
    ["ready, the switch on", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ auto: { enabled: true, startedAt: null, blocked: false, refusal: null, refusalAt: null } }) })],
    ["ready, the automatic start refused", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ auto: { enabled: true, startedAt: null, blocked: false, refusal: "no_destination", refusalAt: "2026-09-14T11:59:00Z" } }) })],
    ["ready, a takeover notice", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ lastTakeover: { at: "2026-09-14T11:50:00.000Z", model: "Pixel 8", elapsedMs: 600_000 } }) })],
    ["live, automatic, Details data, a takeover", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" } }), balance: 1, phone: readModel({ auto: { enabled: true, startedAt: "2026-09-14T11:50:00Z", blocked: false, refusal: null, refusalAt: null }, lastTakeover: { at: "2026-09-14T11:55:00.000Z", model: null, elapsedMs: 300_000 }, phone: facts({ state: "publishing", mode: "automatic", appVersion: "1.4.0", beat: { battery: { percent: 78, charging: true, drainPctPerHour: null }, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 245 } }) }) })],
    ["live, the battery low (amber)", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" } }), balance: 1, phone: readModel({ phone: facts({ state: "publishing", health: "battery_low", beat: { battery: { percent: 14, charging: false, drainPctPerHour: 9 }, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 12 } }) }) })],
    ["ending", body({ view: session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" }), balance: 1 })],
    ["ended", body({ view: session({ state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", replayUrl: "https://www.youtube.com/watch?v=abc", endReason: "stopped", creditUsed: true }), balance: 1 })],
    ["failed", body({ view: session({ state: "failed", failReason: "no_credits" }), balance: 0 })],
  ];
}

describe("PhoneTabBody — every §8a state, from the projection alone", () => {
  it("balance 0 and no session: the three tiles from STREAM_CREDIT_PACKS, no Go live, no balance chip", () => {
    const tree = body({ view: null, balance: 0 });
    let tiles = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const tile = byTestId(tree, `stream-buy-pack-${pack.size}`);
      expect(tile, `tile ${pack.size}`).toBeDefined();
      expect(textOf(tile!)).toContain(m(pack.labelKey));
      // §8b: the popular pack is the one ringed in purple-500, the others purple-200 — read off the catalogue.
      expect(String(attr(tile!, "className"))).toContain(pack.popular ? "border-purple-500" : "border-purple-200");
      tiles++;
    }
    expect(tiles).toBe(3);
    expect(textAt(tree, "stream-buy-pack-5")).toContain(m("stream.credits.popular"));
    expect(byTestId(tree, "stream-go-live")).toBeUndefined();
    expect(byTestId(tree, "stream-balance")).toBeUndefined();
    expect(byTestId(tree, "stream-buy-more")).toBeUndefined();
  });

  it("P1: every tile quotes the pack in the CHECKOUT's currency — the amount its Stripe price charges, per pack × currency", () => {
    let checked = 0;
    for (const currency of SUPPORTED_CURRENCIES) {
      const tree = body({ view: null, balance: 0, currency });
      for (const pack of STREAM_CREDIT_PACKS) {
        const price = streamPackPriceAmounts(pack);
        const charged = currency === price.currency ? price.unit_amount : price.currency_options[currency]!.unit_amount;
        const text = textAt(tree, `stream-buy-pack-${pack.size}`);
        expect(text, `${pack.size} ${currency}`).toContain(formatMinor(charged, currency, "en"));
        expect(text, `${pack.size} ${currency} per match`).toContain(
          m("stream.credits.perMatch", { price: formatMinor(Math.round(charged / pack.credits), currency, "en") }),
        );
        checked++;
      }
    }
    expect(checked).toBe(SUPPORTED_CURRENCIES.length * STREAM_CREDIT_PACKS.length);
    // The regression itself, off a real checkout (capture pass 2, en-US): the 5-pack tile reads $33.25, never £25.
    const usd = textAt(body({ view: null, balance: 0, currency: "usd" }), "stream-buy-pack-5");
    expect(usd).toContain("$33.25");
    expect(usd).not.toContain("£");
    expect(streamPack(5)!.gbpPence).toBe(2500);
  });

  it("a tile click buys THAT pack — the size off the catalogue, never a default", () => {
    const bought: number[] = [];
    const tree = body({ view: null, balance: 0, onBuy: (n) => bought.push(n) });
    for (const pack of STREAM_CREDIT_PACKS) click(byTestId(tree, `stream-buy-pack-${pack.size}`));
    expect(bought).toEqual(STREAM_CREDIT_PACKS.map((p) => p.size));
  });

  it("balance 2 and no session: idle controls, the first destination selected — and NO feed-mode control (spec §3.1)", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(tree, "stream-balance")).toBe(m("stream.phone.credits.other", { n: 2 }));
    expect(attr(byTestId(tree, "stream-target")!, "value")).toBe("t1");
    // T9b: the disabled "With scorebug — Coming soon" control is gone, and the radiogroup with it (passthrough only).
    for (const id of ["stream-mode", "stream-mode-clean", "stream-mode-scorebug"]) expect(byTestId(tree, id), id).toBeUndefined();
    const html = renderToStaticMarkup(<PhoneTabBody {...BODY} view={null} balance={2} targets={ok(TARGETS)} selectedTargetId="t1" />);
    expect(html.includes("Coming soon"), "no Coming soon, in any key").toBe(false);
    expect(byTestId(tree, "stream-go-live")).toBeDefined();
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled).toBeFalsy();
    expect(byTestId(tree, "stream-buy-pack-5")).toBeUndefined();
    expect(byTestId(tree, "stream-buy-more")).toBeDefined();
    expect(textAt(body({ view: null, balance: 1 }), "stream-balance"), "one credit is singular").toBe(m("stream.phone.credits.one"));
  });

  // Task 14b (R4). The owner's per-plan rates are V426's rows — parsed from the migration itself, never typed here, so a
  // changed rate moves this sweep with it (the DB-backed half, each plan's GRANT, is stream-credits-monthly.test.ts).
  const v426Rates = (): [string, number][] => {
    const sql = readFileSync(join(__dirname, "../../../../../../db/migration/deltas/V426__streaming_every_plan_monthly_credits.sql"), "utf8");
    const block = sql.slice(sql.indexOf("'streaming.credits.monthly', null"), sql.indexOf("join plans p on p.key = v.plan_key"));
    return [...block.matchAll(/\('(\w+)',\s*(\d+)\)/g)].map((x) => [x[1]!, Number(x[2])]);
  };

  it("Task 14b (R4): the credits card names the plan's free monthly credits — every V426 plan's own n, singular at 1", () => {
    const rates = v426Rates();
    let checked = 0;
    for (const [plan, n] of rates) {
      // Balance 0: the card is forced open, so the note is on screen.
      const note = textAt(body({ view: null, balance: 0, monthlyAllowance: n }), "stream-credits-monthly");
      expect(note, plan).toBe(n === 1 ? m("stream.credits.monthlyNote.one") : m("stream.credits.monthlyNote.other", { n }));
      expect(note, `${plan}: the number itself is on screen`).toContain(String(n));
      checked++;
    }
    expect(checked, "no V426 rate was parsed").toBeGreaterThan(0);
    expect(checked).toBe(rates.length);
    // Both plural arms were exercised by real rates, not by a value typed here.
    expect(rates.some(([, n]) => n === 1) && rates.some(([, n]) => n > 1), "V426 covers both forms").toBe(true);
  });

  it("Task 14b (R4): no allowance, no note — and the note lives in the credits card, so a closed card shows none", () => {
    expect(byTestId(body({ view: null, balance: 0, monthlyAllowance: 0 }), "stream-credits-monthly"), "the empty case").toBeUndefined();
    expect(byTestId(body({ view: null, balance: 2, monthlyAllowance: 5 }), "stream-credits-monthly"), "card closed").toBeUndefined();
    expect(byTestId(body({ view: null, balance: 2, monthlyAllowance: 5, showBuy: true }), "stream-credits-monthly"), "the positive pair: opened").toBeDefined();
  });

  it("Task 14b (R4, review M2): the split line shows ONLY while BOTH buckets are held and the split still adds up to the chip; the chip stays the total", () => {
    const split = { monthly: 2, pack: 3, total: 5 };
    const shown = body({ view: null, balance: 5, split });
    expect(textAt(shown, "stream-credits-split")).toBe(m("stream.credits.split", { m: 2, p: 3 }));
    expect(textAt(shown, "stream-balance"), "the chip is the total").toBe(m("stream.phone.credits.other", { n: 5 }));
    let hidden = 0;
    for (const [why, p] of [
      ["no free credits held", { balance: 3, split: { monthly: 0, pack: 3, total: 3 } }],
      ["no bought credits held (M2: the chip already says it)", { balance: 2, split: { monthly: 2, pack: 0, total: 2 } }],
      ["stale: a session moved the balance since the page read it", { balance: 4, split }],
      ["no split read (no relay)", { balance: 5, split: null }],
      ["nothing at all", { balance: 0, split: { monthly: 0, pack: 0, total: 0 } }],
    ] as const) {
      expect(byTestId(body({ view: null, ...p }), "stream-credits-split"), why).toBeUndefined();
      hidden++;
    }
    expect(hidden).toBe(5);
  });

  it("no destination yet: the empty copy with its Directory link, no select, and Go live DISABLED — even with a stale selection (the empty case)", () => {
    for (const selectedTargetId of [null, "t1"]) {
      const tree = body({ view: null, balance: 2, targets: [], selectedTargetId });
      expect(textAt(tree, "stream-dest-empty"), String(selectedTargetId)).toContain(m("stream.dest.empty"));
      expect(byTestId(tree, "stream-target"), "no select over nothing").toBeUndefined();
      expect(propsOf(byTestId(tree, "stream-go-live")!).disabled, String(selectedTargetId)).toBe(true);
    }
  });

  it("balance ≥ 1: Buy more OPENS the pack chooser — it never picks a pack for the organiser", () => {
    let bought: number | null = null;
    let opened = false;
    const tree = body({ view: null, balance: 2, onBuy: (n) => { bought = n; }, onShowBuy: () => { opened = true; } });
    click(byTestId(tree, "stream-buy-more"));
    expect(opened, "the chooser opens").toBe(true);
    expect(bought, "no pack is chosen on the organiser's behalf").toBeNull();
    expect(attr(byTestId(tree, "stream-buy-more")!, "aria-expanded")).toBe(false);
    // …and once open, all three tiles are reachable even with a balance in hand, mid-session included.
    for (const view of [null, session({ state: "live", startedAt: "2026-09-14T11:50:00Z" })]) {
      const opened2 = body({ view, balance: 2, showBuy: true });
      expect(attr(byTestId(opened2, "stream-buy-more")!, "aria-expanded")).toBe(true);
      for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(opened2, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
    }
  });

  it("a refused checkout shows the CHECKOUT copy (D13), never the create copy", () => {
    expect(textAt(body({ view: null, balance: 0, checkoutError: "owner" }), "stream-checkout-error")).toBe(m("stream.credits.error.owner"));
    expect(textAt(body({ view: null, balance: 0, checkoutError: "unknown" }), "stream-checkout-error")).toBe(m("stream.credits.error.unknown"));
    expect(byTestId(body({ view: null, balance: 0 }), "stream-checkout-error")).toBeUndefined();
    expect(byTestId(body({ view: null, balance: 0, checkoutError: "owner" }), "stream-create-error")).toBeUndefined();
  });

  it("a refused create shows the E5 create-error copy, keyed by code; target_in_use NAMES the match and court (D12, spec §5.5)", () => {
    const tree = body({ view: null, balance: 1, createError: { code: "storage_exhausted", holder: null } });
    expect(textAt(tree, "stream-create-error")).toBe(m("stream.error.storage_exhausted"));
    const named = body({ view: null, balance: 1, createError: { code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel", matchNo: 4, href: "/x", state: "live" } } });
    expect(textAt(named, "stream-create-error")).toBe(
      m("stream.inUse.live", { label: "Club channel", match: m("stream.inUse.matchCourt", { match: m("breadcrumb.match", { no: 4 }), court: "Court 3" }) }),
    );
    const elsewhere = body({ view: null, balance: 1, createError: { code: "target_in_use", holder: null } });
    expect(textAt(elsewhere, "stream-create-error")).toBe(m("stream.error.target_in_use.unknown"));
    expect(byTestId(body({ view: null, balance: 1 }), "stream-create-error"), "the empty case").toBeUndefined();
  });

  it("Ready, no phone (§6.12, Option B): the code card — its title, the QR through SeaznQrImage (sensitive, the sheet's cap), the paste code (ph-no-capture, exactly the QR's four keys), Copy beneath it, Revoke & reissue", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: null }), code: { status: "ok", text: CODE_TEXT, image: SYMBOL } });
    const card = byTestId(tree, "stream-code-card");
    expect(card, "the code card at Ready with no phone").toBeDefined();
    expect(textOf(card!)).toContain(m("stream.code.scan"));
    // T10: the QR is a <SeaznQrImage> element (the harness does not expand it): found by type and `testId` prop.
    const qrEl = qrImageOf(tree, "stream-qr");
    expect(qrEl, "the stream QR, through the shared component").toBeDefined();
    expect(byTestId(tree, "stream-qr"), "no bare img bypasses the component").toBeUndefined();
    expect(propsOf(qrEl!).qr, "the symbol the container encoded, whole").toBe(SYMBOL);
    expect(propsOf(qrEl!).alt).toBe(m("stream.phone.qr.alt"));
    expect(propsOf(qrEl!).sensitive, "the QR carries a live tok: ph-no-capture").toBe(true);
    const cap = sheetQrCap();
    expect(cap).toBeGreaterThanOrEqual(320); // spec §7's floor on desktop
    expect(propsOf(qrEl!).maxSize, "the sheet's cap; the component snaps inside it").toBe(cap);
    const field = byTestId(tree, "stream-qr-text")!;
    expect(String(attr(field, "className")).split(/\s+/), "the paste code is ph-no-capture").toContain("ph-no-capture");
    // W3 (regression): the paste code is the QR's text — exactly the four keys, in order, never a credential.
    expect(attr(field, "value")).toBe(CODE_TEXT);
    expect(Object.keys(JSON.parse(String(attr(field, "value"))))).toEqual(["v", "code", "slot", "tok"]);
    expect(attr(field, "readOnly")).toBe(true);
    expect(attr(field, "aria-label")).toBe(m("stream.phone.qr.field"));
    // Option B: Copy sits BENEATH the field, full width, at every width — no md: placement inside it.
    const copy = String(attr(byTestId(tree, "stream-qr-copy")!, "className")).split(/\s+/);
    expect(copy).toEqual(expect.arrayContaining(["w-full", "h-11", "mt-1.5"]));
    expect(copy.filter((c) => c.startsWith("md:")), "no md: override moves Copy into the field").toEqual([]);
    expect(textAt(tree, "stream-qr-copy")).toBe(m("stream.phone.qr.copy"));
    expect(textAt(body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: null }), code: { status: "ok", text: CODE_TEXT, image: SYMBOL }, copied: true }), "stream-qr-copy")).toBe(m("stream.phone.qr.copied"));
    expect(textAt(tree, "stream-code-reissue")).toBe(m("stream.code.reissue"));
    // Order inside the card: the title, the QR, the paste code, Copy, then Revoke & reissue.
    const cardTree = walk(propsOf(card!).children as ReactElement);
    const at = (pred: (el: ReactElement) => boolean, what: string) => {
      const i = cardTree.findIndex(pred);
      expect(i, what).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at((el) => el.type === SeaznQrImage, "qr"),
      at((el) => attr(el, "data-testid") === "stream-qr-text", "paste"),
      at((el) => attr(el, "data-testid") === "stream-qr-copy", "copy"),
      at((el) => attr(el, "data-testid") === "stream-code-reissue", "reissue"),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // Go live is held: no phone yet (W5) — and it names the strip that says why.
    const go = byTestId(tree, "stream-go-live")!;
    expect(attr(go, "disabled")).toBe(true);
    expect(attr(go, "aria-describedby")).toBe("stream-why-f-1");
    const strip = tree.find((el) => el.type === PhoneStripView);
    expect(propsOf(strip!).id).toBe("stream-why-f-1");
    expect(propsOf(strip!).strip).toEqual({ tone: "slate", icon: "phone", lead: null, body: { key: "stream.phone.pairFirst" } });
    expect(chainOf(tree)?.chain?.phone).toEqual({ tone: "slate", word: "notConnected", mark: null });
  });

  it("the code before the encoder answers: a placeholder the QR's size for THIS text, and the paste code ALREADY there; still asking: a module-less placeholder and no paste code; refused: the error with Retry", () => {
    const base = { view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: null }) } as const;
    const tree = body({ ...base, code: { status: "ok", text: CODE_TEXT, image: null } });
    expect(qrImageOf(tree, "stream-qr"), "no QR before the encoder answers").toBeUndefined();
    const placeholder = tree.find((el) => el.type === SeaznQrPlaceholder);
    expect(placeholder, "the placeholder renders").toBeDefined();
    expect(propsOf(placeholder!).maxSize).toBe(sheetQrCap());
    // The module count of THIS text — QRCode's own matrix at the house EC level, plus the quiet zone.
    const modules = QRCode.create(CODE_TEXT, { errorCorrectionLevel: "H" }).modules.size + 2 * 4;
    expect(modules, "PREMISE: the v2 payload is the v8 symbol §6.12 sized for").toBe(57);
    expect(propsOf(placeholder!).modules).toBe(modules);
    expect(attr(byTestId(tree, "stream-qr-text")!, "value")).toBe(CODE_TEXT);
    const asking = body({ ...base, code: { status: "loading" } });
    expect(propsOf(asking.find((el) => el.type === SeaznQrPlaceholder)!).modules).toBeNull();
    expect(byTestId(asking, "stream-qr-text")).toBeUndefined();
    expect(attr(byTestId(asking, "stream-code-reissue")!, "disabled"), "no reissue while one is in flight").toBe(true);
    const onRetryCode = vi.fn();
    const refused = body({ ...base, code: { status: "error" }, onRetryCode });
    expect(attr(byTestId(refused, "stream-code-error")!, "role")).toBe("alert");
    expect(textAt(refused, "stream-code-error")).toContain(m("stream.code.error"));
    click(byTestId(refused, "stream-code-retry"));
    expect(onRetryCode).toHaveBeenCalledTimes(1);
  });

  it("Ready, paired: the card folds to one line — a lime dot, 'Paired · Pixel 8', Show the code again — Go live ENABLED, the strip names the phone (Option A); opened, the same code body inside", () => {
    const onToggleCode = vi.fn();
    const folded = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", onToggleCode });
    expect(byTestId(folded, "stream-code-card"), "no card: the phone is paired").toBeUndefined();
    const d = byTestId(folded, "stream-code-disclosure")!;
    expect(d.type).toBe("details");
    expect(attr(d, "open")).toBe(false);
    // PR-2 T12 (§7.5, Option A state 1): the fold names the phone — its model beside Paired, Show the code again after.
    expect(textOf(d).replace(/\s+/g, " ")).toContain(`${m("stream.code.paired")} · Pixel 8 ${m("stream.code.showAgain")}`);
    expect(walk(propsOf(d).children as ReactElement).find((el) => attr(el, "data-tone") !== undefined && el.type === "span")?.props).toMatchObject({ "data-tone": "lime" });
    expect(byTestId(folded, "stream-qr-text"), "folded: the code is not even in the DOM").toBeUndefined();
    (attr(d, "onToggle") as (e: unknown) => void)({ currentTarget: { open: true } });
    expect(onToggleCode).toHaveBeenCalledWith(true);
    expect(attr(byTestId(folded, "stream-go-live")!, "disabled")).toBe(false);
    // PR-2 (Option A state 1): the strip says which phone, and how it will start — Go live names it.
    expect(attr(byTestId(folded, "stream-go-live")!, "aria-describedby")).toBe("stream-why-f-1");
    expect(propsOf(folded.find((el) => el.type === PhoneStripView)!).strip).toEqual({
      tone: "slate", icon: "phone", lead: null, body: null, line: [{ kind: "model", text: "Pixel 8" }, { kind: "mode", mode: "operator" }],
    });
    expect(chainOf(folded)?.chain?.phone).toEqual({ tone: "lime", word: "paired", mark: null });
    // The EMPTY case: a phone that named neither model nor mode — no strip, nothing for Go live to name, and the fold
    // says Paired alone (no dangling "·").
    const anon = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: facts({ model: null, mode: null }) }) });
    expect(anon.find((el) => el.type === PhoneStripView)).toBeUndefined();
    expect(attr(byTestId(anon, "stream-go-live")!, "aria-describedby"), "nothing to say: no strip").toBeUndefined();
    expect(textOf(byTestId(anon, "stream-code-disclosure")!).replace(/\s+/g, " ").trim()).toBe(`${m("stream.code.paired")} ${m("stream.code.showAgain")}`);
    const opened = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", codeOpen: true, code: { status: "ok", text: CODE_TEXT, image: SYMBOL } });
    expect(attr(byTestId(opened, "stream-code-disclosure")!, "open")).toBe(true);
    expect(attr(byTestId(opened, "stream-qr-text")!, "value")).toBe(CODE_TEXT);
    expect(byTestId(opened, "stream-code-reissue")).toBeDefined();
    expect(qrImageOf(opened, "stream-qr")).toBeDefined();
  });

  it("Ready, silent (§6.9): amber — the dot, the Phone node 'Not answering', the strip 'Open Seazn Capture' — and Go live DISABLED", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: readModel({ phone: SILENT }) });
    expect(attr(byTestId(tree, "stream-go-live")!, "disabled")).toBe(true);
    expect(attr(byTestId(tree, "stream-go-live")!, "aria-describedby")).toBe("stream-why-f-1");
    expect(propsOf(tree.find((el) => el.type === PhoneStripView)!).strip).toMatchObject({ tone: "amber", icon: "alert", body: { key: "stream.phone.silent" } });
    expect(chainOf(tree)?.chain?.phone).toEqual({ tone: "amber", word: "notAnswering", mark: null });
    const d = byTestId(tree, "stream-code-disclosure")!;
    expect(walk(propsOf(d).children as ReactElement).find((el) => el.type === "span" && attr(el, "data-tone") !== undefined)?.props).toMatchObject({ "data-tone": "amber" });
  });

  it("Code ended (C5): 'This match is over' — no QR, no code line, no Go live, no chain, no strip; a reverted result (not finished, the code still ended) is Ready again", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: MATCH_OVER });
    expect(textAt(tree, "stream-match-over")).toBe(m("stream.phone.matchOver"));
    for (const id of ["stream-go-live", "stream-code-card", "stream-code-disclosure", "stream-qr-text", "stream-credits-line", "stream-buy-pack-5"]) {
      expect(byTestId(tree, id), id).toBeUndefined();
    }
    expect(chainOf(tree)).toBeUndefined();
    expect(tree.find((el) => el.type === PhoneStripView)).toBeUndefined();
    // …and at balance 0 it is still the line, never the forced chooser: there is nothing left to start.
    expect(byTestId(body({ view: null, balance: 0, phone: MATCH_OVER }), "stream-buy-pack-5")).toBeUndefined();
    const reverted = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: { ...MATCH_OVER, finished: false } });
    expect(byTestId(reverted, "stream-match-over")).toBeUndefined();
    expect(byTestId(reverted, "stream-code-card"), "Ready may mint again").toBeDefined();
    // A finished match whose code is still FINISHING (the grace): not over — but its code cannot be reissued (422).
    const grace = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", codeOpen: true, code: { status: "ok", text: CODE_TEXT, image: SYMBOL }, phone: readModel({ finished: true, code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "finishing", endCause: null } }) });
    expect(byTestId(grace, "stream-match-over")).toBeUndefined();
    expect(byTestId(grace, "stream-qr-text")).toBeDefined();
    expect(byTestId(grace, "stream-code-reissue"), "no reissue on a finished match").toBeUndefined();
  });

  it("waiting (§6.12): no QR — the strip's 'Waiting for the phone's video', the far-cadence line only on the 60 s cadence, Cancel, and the folded code line (ruling A)", () => {
    const near = body({ view: session(), balance: 2 });
    expect(qrImageOf(near, "stream-qr")).toBeUndefined();
    expect(byTestId(near, "stream-qr-text")).toBeUndefined();
    expect(byTestId(near, "stream-poll-far")).toBeUndefined();
    expect(byTestId(near, "stream-cancel")).toBeDefined();
    expect(byTestId(near, "stream-code-disclosure"), "ruling A: Reissue stays one tap away").toBeDefined();
    expect(propsOf(near.find((el) => el.type === PhoneStripView)!).strip).toEqual({ tone: "slate", icon: "clock", lead: "stream.phone.waitingVideo", body: null });
    expect(chainOf(near)?.chain?.phone).toEqual({ tone: "amber", word: "starting", mark: null });
    const far = body({ view: session(), balance: 2, phone: readModel({ phone: facts({ farPoll: true }) }) });
    expect(textAt(far, "stream-poll-far")).toBe(m("stream.phone.pollFar"));
    // Its order: the line, then Cancel.
    const i = far.findIndex((el) => attr(el, "data-testid") === "stream-poll-far");
    const j = far.findIndex((el) => attr(el, "data-testid") === "stream-cancel");
    expect(i).toBeLessThan(j);
  });

  it("W24: the countdown renders EXACTLY as the server sends it — its (kind, reason) sentence and both durations — and none at all when `countdown` is null", () => {
    const warming = { kind: "warming" as const, reason: "no_inbound_timeout" as const, elapsedMs: 45_000, remainingMs: 555_000 };
    const w = body({ view: session({ countdown: warming }), balance: 2 });
    expect(propsOf(w.find((el) => el.type === PhoneStripView)!).strip).toEqual({
      tone: "amber", icon: "clock", lead: "stream.phone.waitingVideo",
      body: { key: "stream.phone.countdown.warming.no_inbound_timeout", elapsedMs: 45_000, remainingMs: 555_000 },
    });
    const html = renderToStaticMarkup(<PhoneTabBody {...BODY} view={session({ countdown: warming })} balance={2} />);
    expect(html).toContain(`the stream is cancelled in <span aria-live="off" class="whitespace-nowrap tabular-nums">9 min, 15 sec</span>`);
    const lost = { kind: "live" as const, reason: "phone_lost" as const, elapsedMs: 160_000, remainingMs: 740_000 };
    const liveView = session({ state: "live", startedAt: "2026-09-14T11:50:00Z", countdown: lost });
    const liveHtml = renderToStaticMarkup(<PhoneTabBody {...BODY} view={liveView} balance={1} phone={readModel({ phone: SILENT })} />);
    expect(liveHtml).toContain(`No video from the phone for <span aria-live="off" class="whitespace-nowrap tabular-nums">2 min, 40 sec</span> — the stream ends in <span aria-live="off" class="whitespace-nowrap tabular-nums">12 min, 20 sec</span>`);
    expect(liveHtml).toContain(`>${m("stream.chain.word.reconnecting")}<`);
    // The empty case: a live session with the input down and NO countdown from the server shows no countdown sentence.
    const none = renderToStaticMarkup(<PhoneTabBody {...BODY} view={session({ state: "live", startedAt: "2026-09-14T11:50:00Z" })} balance={1} />);
    expect(none).not.toMatch(/the stream (ends|is cancelled) in/);
    expect(none).not.toContain("tabular-nums\">9 min");
  });

  it("B8 re-review item 1, rendered: warming with ask 10's countdown → the strip's 'stopped checking in' and the Phone node 'Not answering' WITH the '!' — the phone still `present` in the read model (ask 10's real window); the warming timeout keeps 'Starting' with no mark", () => {
    const PHONE_BANG = /data-node="phone"[^]*?data-mark="bang"[^]*?data-node="seazn"/;
    const ask10 = { kind: "warming" as const, reason: "phone_lost" as const, elapsedMs: 40_000, remainingMs: 20_000 };
    const lostHtml = renderToStaticMarkup(<PhoneTabBody {...BODY} view={session({ countdown: ask10 })} balance={2} phone={readModel({ phone: facts({ state: "paired" }) })} />);
    expect(lostHtml).toContain(`The phone stopped checking in — the stream is cancelled in <span aria-live="off" class="whitespace-nowrap tabular-nums">20 sec</span>`);
    expect(lostHtml).toContain(`>${m("stream.chain.word.notAnswering")}<`);
    expect(lostHtml).not.toContain(`>${m("stream.chain.word.starting")}<`);
    expect(lostHtml, "the '!' on the phone node").toMatch(PHONE_BANG);
    // The positive pair: the warming TIMEOUT's countdown (the phone checks in) — Starting, no mark (mockup §5).
    const timeout = { kind: "warming" as const, reason: "no_inbound_timeout" as const, elapsedMs: 45_000, remainingMs: 555_000 };
    const waitHtml = renderToStaticMarkup(<PhoneTabBody {...BODY} view={session({ countdown: timeout })} balance={2} phone={readModel({ phone: facts({ state: "paired" }) })} />);
    expect(waitHtml).toContain(`>${m("stream.chain.word.starting")}<`);
    expect(waitHtml).not.toMatch(PHONE_BANG);
  });

  it("B8 re-review ruling (the open point), rendered: the folded 'Paired' line's dot says what the strip and the Phone node say, for EVERY countdown the wire declares — amber with the '!' and the lost sentence, lime with neither — the phone still `present` in the read model throughout", () => {
    const PHONE_BANG = /data-node="phone"[^]*?data-mark="bang"[^]*?data-node="seazn"/;
    const FOLD_DOT = /data-testid="stream-code-disclosure"[^]*?data-tone="(\w+)"/;
    const LINK1 = /data-link1="(\w+)"/;
    const esc = (t: string) => t.replace(/'/g, "&#x27;");
    type Countdown = StreamLostCountdown;
    const wire: Countdown[] = StreamLostCountdown.options.flatMap((o) => {
      const reason = o.shape.reason;
      const reasons = ("options" in reason ? reason.options : [reason.value]) as Countdown["reason"][];
      return reasons.map((r) => ({ kind: o.shape.kind.value, reason: r, elapsedMs: 40_000, remainingMs: 20_000 }) as Countdown);
    });
    /** Where each kind is served: `warming` before any video; `live` in live AND in a warming reconnect (§5.4). */
    const states = (c: Countdown): ("warming" | "live")[] => (c.kind === "live" ? ["live", "warming"] : ["warming"]);
    let checked = 0;
    let lost = 0;
    for (const countdown of wire) for (const state of states(countdown)) {
      const where = `${countdown.kind}.${countdown.reason} in ${state}`;
      const view = session({ state, countdown, ...(state === "live" ? { startedAt: "2026-09-14T11:50:00Z" } : {}) });
      const html = renderToStaticMarkup(<PhoneTabBody {...BODY} view={view} balance={2} phone={readModel({ phone: facts({ state: "publishing" }) })} />);
      const sentence = m(`stream.phone.countdown.${countdown.kind}.${countdown.reason}` as MessageKey).split("{")[0]!;
      expect(html, `${where}: the strip's sentence`).toContain(esc(sentence));
      const isLost = countdown.reason === "phone_lost";
      expect(PHONE_BANG.test(html), `${where}: the '!' on the node`).toBe(isLost);
      expect(html.match(FOLD_DOT)?.[1], `${where}: the fold's dot`).toBe(isLost ? "amber" : "lime");
      // Item 6 (coordinator ruling): link 1 is the fourth voice — `problem` (amber dashes) exactly when the phone is lost.
      expect(html.match(LINK1)?.[1], `${where}: link 1`).toBe(isLost ? "problem" : "connecting");
      if (isLost) lost++;
      checked++;
    }
    expect(checked, "warming timeout, ask 10, W19 in live and in a warming reconnect").toBe(4);
    expect(lost).toBe(3);
    // The positive pair, no countdown: the same present phone's dot is lime (the read model) — the dot moved above
    // because of the countdown, not because the fold always paints amber.
    const quiet = renderToStaticMarkup(<PhoneTabBody {...BODY} view={session()} balance={2} phone={readModel({ phone: facts({ state: "publishing" }) })} />);
    expect(quiet.match(FOLD_DOT)?.[1]).toBe("lime");
    expect(quiet.match(LINK1)?.[1], "no countdown: waiting's link 1").toBe("connecting");
  });

  it("O5: live, the input down, the phone still beating with notReady camera → 'Reconnecting…' and 'Phone is on a call — video paused', NO countdown, no '!' and no D3 phone box", () => {
    const v = session({ state: "live", startedAt: "2026-09-14T11:50:00Z", output: { state: "unknown", since: "2026-09-14T11:57:00Z", elapsedMs: 180_000 } });
    const phone = readModel({ phone: facts({ notReady: "camera", state: "publishing" }) });
    const html = renderToStaticMarkup(<PhoneTabBody {...BODY} view={v} balance={1} phone={phone} />);
    expect(html).toContain(`>${m("stream.chain.word.reconnecting")}<`);
    expect(m("stream.chain.word.reconnecting")).toBe("Reconnecting…");
    expect(html).toContain(m("stream.phone.paused.camera"));
    expect(m("stream.phone.paused.camera")).toBe("Phone is on a call — video paused");
    expect(html).not.toMatch(/the stream (ends|is cancelled) in/);
    expect(html, "the phone beats: no '!' on its node").not.toMatch(/data-node="phone"[^]*?data-mark="bang"[^]*?data-node="seazn"/);
    const PHONE_BOX = 'data-testid="stream-output-warning" data-cause="phone"';
    expect(html, "the strip replaced D3's phone sentence").not.toContain(PHONE_BOX);
    // The positive pair: the same live view with NO reason (publishing, no notReady) — D3's phone box is back.
    const plain = renderToStaticMarkup(<PhoneTabBody {...BODY} view={v} balance={1} phone={readModel({ phone: facts({ state: "publishing" }) })} />);
    expect(plain).toContain(PHONE_BOX);
    expect(plain).not.toContain(m("stream.phone.paused.camera"));
    // A connected input says none of it: "Reconnecting…" only while the input is not connected.
    const connected = renderToStaticMarkup(<PhoneTabBody {...BODY} view={{ ...v, ingest: { state: "connected", protocol: "srt" } }} balance={1} phone={phone} />);
    expect(connected).not.toContain(m("stream.chain.word.reconnecting"));
    expect(connected).not.toContain(m("stream.phone.paused.camera"));
  });

  it("C-1: a LEGACY session (no pairing) is today's panel — §3.2's chain words, no strip, no code line, no far-cadence line", () => {
    let checked = 0;
    for (const v of [session(), session({ state: "live", startedAt: "2026-09-14T11:50:00Z" })]) {
      const tree = body({ view: v, balance: 1, phone: LEGACY });
      expect(chainOf(tree)?.chain, v.state).toEqual(chainFor(v));
      expect(tree.find((el) => el.type === PhoneStripView), v.state).toBeUndefined();
      expect(byTestId(tree, "stream-code-disclosure"), v.state).toBeUndefined();
      expect(byTestId(tree, "stream-poll-far"), v.state).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(2);
    expect(chainOf(body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 1, phone: LEGACY }))?.chain?.phone.word).toBe("noSignal");
  });

  it("no `qr` and no `reveal` is read: a projection carrying a smuggled v1 `qr` paints nothing from it", () => {
    const smuggled = { ...session(), qr: { v: 1, sid: "x", cred: { srt: { passphrase: "LEAK" } } } } as unknown as StreamSessionView;
    const html = renderToStaticMarkup(<PhoneTabBody {...BODY} view={smuggled} balance={2} />);
    expect(html).not.toContain("LEAK");
    expect(html).not.toContain("passphrase");
    // The source half: no session read names `qr` (the code's QR comes from the stream-code route), and nothing asks
    // `current` for a reveal (W4: the route answers 400 to one).
    const src = readFileSync(join(__dirname, "..", "fixture-stream-panel.tsx"), "utf8");
    expect(src.match(/\b(view|shown|session|v)\??\.qr\b/g) ?? [], "a session's `qr` is read").toEqual([]);
    expect(src.match(/reveal/gi) ?? [], "a reveal is asked for").toEqual([]);
    expect(src, "PREMISE: the scan reads the panel (it names the code route)").toContain("/stream-code");
  });

  it("live (§3.3, mockup state 3): On air + the elapsed time in mono, a FULL-WIDTH solid red Stop, then a CLOSED Details led by the INGEST STATE (C6); the decided chip only when decided", () => {
    const live = session({ state: "live", startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" } });
    const tree = body({ view: live, balance: 1 });
    expect(textAt(tree, "stream-on-air")).toBe(m("stream.onAir"));
    expect(byTestId(tree, "stream-rec"), "T9b: no REC badge in the tab — On air says it").toBeUndefined();
    expect(textAt(tree, "stream-elapsed")).toBe("10:00");
    const clock = String(attr(byTestId(tree, "stream-elapsed")!, "className")).split(" ");
    for (const c of ["font-mono", "text-3xl", "tabular-nums"]) expect(clock, c).toContain(c);
    // The mockup's order: On air, then Stop, then Details.
    const at = (id: string) => tree.findIndex((el) => attr(el, "data-testid") === id);
    expect(at("stream-on-air")).toBeLessThan(at("stream-stop"));
    expect(at("stream-stop")).toBeLessThan(at("stream-details"));
    const stopClass = String(attr(byTestId(tree, "stream-stop")!, "className")).split(" ");
    for (const c of ["w-full", "min-h-12", "bg-red-600", "text-white"]) expect(stopClass, c).toContain(c);
    expect(stopClass, "full width at every width").not.toContain("md:w-auto");
    // T9a (§3.3): the chips moved into Details, closed by default; the chain above carries the state.
    const details = byTestId(tree, "stream-details")!;
    expect(details.type).toBe("details");
    expect(attr(details, "open"), "Details opens CLOSED (class 19: what it opens at)").toBeFalsy();
    expect(textOf(walk(propsOf(details).children as ReactElement).find((e) => e.type === "summary")!)).toBe(m("stream.details"));
    expect(walk(propsOf(details).children as ReactElement).some((e) => attr(e, "data-testid") === "stream-health"), "the chips are INSIDE Details").toBe(true);
    const chips = allTestIds(tree, "stream-health-chip");
    expect(textOf(chips[0]!)).toBe(m("stream.health.ingest.connected"));
    expect(chips).toHaveLength(1); // passthrough with no heartbeat: the ingest chip alone
    const stop = byTestId(tree, "stream-stop")!;
    expect(String(attr(stop, "className"))).toMatch(/(^|\s)bg-red-600(\s|$)/);
    expect(String(attr(stop, "className"))).not.toContain("btn-danger");
    expect(textOf(stop)).toBe(m("stream.phone.stop"));
    expect(byTestId(tree, "stream-decided-chip")).toBeUndefined();
    expect(byTestId(body({ view: { ...live, fixtureDecided: true }, balance: 1 }), "stream-decided-chip")).toBeDefined();
    // A stale beat turns its chip amber — the one chip, not the line.
    const stale = body({ view: { ...live, health: { fps: 30, bitrateKbps: 2900, lastBeatAt: "2026-09-14T11:58:00Z" } }, balance: 1 });
    const beat = allTestIds(stale, "stream-health-chip").at(-1)!;
    expect(String(attr(beat, "className"))).toContain("bg-amber-100");
    expect(String(attr(allTestIds(stale, "stream-health-chip")[0]!, "className"))).toContain("bg-slate-100");
  });

  it("ending: the flush copy names the destination and there is no Stop", () => {
    const tree = body({ view: session({ state: "ending", target: { id: "t1", kind: "youtube", label: "Club TV" } }), balance: 1 });
    expect(textAt(tree, "stream-ending")).toBe(m("stream.phone.ending", { destination: "Club TV" }));
    expect(byTestId(tree, "stream-stop")).toBeUndefined();
  });

  it("ended: duration; '1 credit used' ONLY when the ledger says so (D3); the replay link only with a replay; the end reason", () => {
    const base = { state: "completed" as const, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "max_duration" as const };
    const paid = body({ view: session({ ...base, creditUsed: true, replayUrl: "https://www.youtube.com/watch?v=abc" }), balance: 1 });
    expect(textAt(paid, "stream-ended")).toContain(m("stream.phone.ended.duration", { duration: "45:00" }));
    expect(textAt(paid, "stream-credit-used")).toBe(m("stream.phone.ended.credits"));
    expect(attr(byTestId(paid, "stream-replay")!, "href")).toBe("https://www.youtube.com/watch?v=abc");
    expect(textAt(paid, "stream-end-reason")).toBe(m(END_REASON_KEYS.max_duration));
    expect(byTestId(paid, "stream-again")).toBeDefined();
    // A restart inside the reuse window, or a refunded consume: no credit was used, so the chip must not claim one.
    const waived = body({ view: session({ ...base, creditUsed: false }), balance: 1 });
    expect(byTestId(waived, "stream-credit-used"), "a waived restart claims a credit").toBeUndefined();
    expect(byTestId(waived, "stream-ended"), "…while the rest of the card still renders").toBeDefined();
    expect(byTestId(waived, "stream-replay")).toBeUndefined();
  });

  // W19's window is the SERVER's — config.ts PHONE_LOST_LIVE_MINUTES through `tunable`, handed down by the page's
  // loader (stream-panel-context.ts) — and the chip names it; the panel computes nothing. Class 19: every value but 15 is
  // one a "15" typed into the copy (or the panel) cannot render, so a hard-coded window reds here.
  it("phone_lost names the window the server declared — at 1, 7, 15 and 45 minutes, each its own number", () => {
    const raw = messages["stream.phone.ended.reason.phone_lost"] as string;
    expect(raw.split("{minutes}").length, "premise: the copy carries ONE {minutes}").toBe(2);
    const ended = { state: "completed" as const, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "phone_lost" as const };
    let checked = 0;
    for (const minutes of [1, 7, 15, 45]) {
      const text = textAt(body({ view: session(ended), balance: 1, phoneLostMinutes: minutes }), "stream-end-reason");
      expect(text, `${minutes} min`).toBe(raw.replace("{minutes}", String(minutes)));
      expect(text.match(/\d+/g), `${minutes} min: the only number in the chip is the window`).toEqual([String(minutes)]);
      checked++;
    }
    expect(checked).toBe(4);
    // No locale types the window into its copy: each carries the placeholder once, and no digit at all.
    let locales = 0;
    for (const l of ["en", "es", "fr", "nl"]) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
      const copy = dict["stream.phone.ended.reason.phone_lost"] ?? "";
      expect(copy.split("{minutes}").length, `${l}: one {minutes}`).toBe(2);
      expect(copy, `${l}: no number typed into the copy`).not.toMatch(/\d/);
      locales++;
    }
    expect(locales).toBe(4);
  });

  // P6 + P7 (fix round 4). Capture pass 3 read "Ended before going live" beside "Stopped by you" on a Cancel from the QR:
  // two chips for one fact, the second restating what the organiser just did. A session that never went live now has ONE
  // chip. Every end reason the view model declares is swept — the reason chip is dropped for all of them, not just "stopped".
  it("P6/P7: a session that ENDED BEFORE GOING LIVE has ONE chip saying so — no duration, no end reason; one that went live keeps both", () => {
    // `startedAt` is stamped only on the live transition (relay/domain/session.ts, the same signal replayFill reads), so
    // an ended session without one never went live: a Cancel on the QR, a camera that never connected. Nothing is consumed
    // before live (the consume rides the live transition), so `creditUsed` is false here — the shape the server sends.
    const reasons = Object.keys(END_REASON_KEYS) as (keyof typeof END_REASON_KEYS)[];
    expect(reasons.length, "no end reasons declared — the sweep would be vacuous").toBeGreaterThan(0);
    let checked = 0;
    for (const endReason of reasons) {
      const never = body({ view: session({ state: "completed", startedAt: null, endedAt: "2026-09-14T11:45:00Z", endReason, creditUsed: false }), balance: 1 });
      expect(endedChips(never), `${endReason}: one chip, and it is the never-live one`).toEqual(["stream-ended-never-live"]);
      expect(textAt(never, "stream-ended-never-live"), endReason).toBe(m("stream.phone.ended.neverLive"));
      expect(textAt(never, "stream-ended"), endReason).not.toContain(m("stream.phone.ended.duration", { duration: "0:00" }));
      expect(textAt(never, "stream-ended"), `${endReason}: the reason is not restated`).not.toContain(m(END_REASON_KEYS[endReason]));
      expect(byTestId(never, "stream-again"), endReason).toBeDefined();
      // The positive pair, UNCHANGED: once it went live the card shows its duration and its end reason — a paid stop adds
      // "1 credit used", a free restart inside the reuse window does not.
      const live = { state: "completed" as const, startedAt: "2026-09-14T11:44:45Z", endedAt: "2026-09-14T11:45:00Z", endReason };
      const paid = body({ view: session({ ...live, creditUsed: true }), balance: 1 });
      expect(endedChips(paid), `${endReason}: paid stop`).toEqual(["stream-ended-duration", "stream-credit-used", "stream-end-reason"]);
      expect(textAt(paid, "stream-ended-duration"), endReason).toBe(m("stream.phone.ended.duration", { duration: "0:15" }));
      expect(textAt(paid, "stream-end-reason"), endReason).toBe(m(END_REASON_KEYS[endReason], { minutes: BODY.phoneLostMinutes }));
      expect(textAt(paid, "stream-end-reason"), `${endReason}: every placeholder is filled`).not.toMatch(/\{\w+\}/);
      const free = body({ view: session({ ...live, creditUsed: false }), balance: 1 });
      expect(endedChips(free), `${endReason}: free restart`).toEqual(["stream-ended-duration", "stream-end-reason"]);
      checked++;
    }
    expect(checked).toBe(reasons.length);
    // The copy exists in all four locales, and differs from the English in each of the other three.
    let locales = 0;
    for (const l of ["en", "es", "fr", "nl"]) {
      const dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
      expect(dict["stream.phone.ended.neverLive"]?.length, l).toBeGreaterThan(0);
      if (l !== "en") expect(dict["stream.phone.ended.neverLive"], l).not.toBe(m("stream.phone.ended.neverLive"));
      locales++;
    }
    expect(locales).toBe(4);
  });

  it("failed: the reason copy, Try again — and no end-reason chip (P1-F-b: a failed row carries none)", () => {
    const failed = body({ view: session({ state: "failed", failReason: "target_rejected" }), balance: 1 });
    expect(textAt(failed, "stream-fail-reason")).toBe(m(FAIL_REASON_KEYS.target_rejected));
    expect(byTestId(failed, "stream-retry")).toBeDefined();
    expect(byTestId(failed, "stream-end-reason")).toBeUndefined();
    for (const reason of ["provision_timeout", "admission_timeout"] as const) {
      expect(textAt(body({ view: session({ state: "failed", failReason: reason }), balance: 1 }), "stream-fail-reason"), reason).toBe(m(FAIL_REASON_KEYS[reason]));
    }
  });

  it("B3: balance < 1 and no session is the credits card ONLY — no 'Ready' pill, no chain, no credits line; a credit brings them back", () => {
    const tree = body({ view: null, balance: 0, targets: TARGETS, selectedTargetId: "t1" });
    // T9b: the tab has no heading of its own any more (the console card names it); the h4 is gone in every state.
    expect(tree.some((el) => el.type === "h4"), "no tab heading").toBe(false);
    expect(byTestId(tree, "stream-buy-pack-5"), "the credits card").toBeDefined();
    for (const id of ["stream-state-pill", "stream-credits-line"]) expect(byTestId(tree, id), id).toBeUndefined();
    expect(chainOf(tree), "no chain while credits-only — even with a destination picked").toBeUndefined();
    // The positive pair, one credit up: the pill and the chain are back (and the tiles are not).
    const funded = body({ view: null, balance: 1, targets: TARGETS, selectedTargetId: "t1" });
    for (const id of ["stream-state-pill", "stream-go-live"]) expect(byTestId(funded, id), id).toBeDefined();
    expect(chainOf(funded)?.chain).toEqual(chainFor(null, { capture: { phone: facts(), countdown: null } }));
    expect(byTestId(funded, "stream-buy-pack-5")).toBeUndefined();
    // …and a FAILED session at balance 0 is not idle: it keeps its pill and stepper (the no_credits failure explains itself).
    const failed = body({ view: session({ state: "failed", failReason: "no_credits" }), balance: 0 });
    expect(byTestId(failed, "stream-state-pill")).toBeDefined();
  });

  // I-1 → W23 (capture QR v2 §6.7.4): admission waives the credit for a restart while the reuse window is open and fewer
  // than three restarts are used. The projection's `restart` ({windowOpen, used, limit, free}) is the ONE authority —
  // the panel counts nothing — and the tab obeys it: a free restart keeps Go live at balance 0, and the line says how
  // many of the free restarts are used.
  const FREE = { windowOpen: true, used: 1, limit: 3, free: true } as const;
  const AT_LIMIT = { windowOpen: true, used: 3, limit: 3, free: false } as const;
  it("W23 / I-1: idle at balance 0 with a FREE restart is Go live plus the emerald 'Free restarts used (1 of 3)' — not the forced chooser; at the limit or with no window, the tiles", () => {
    const free = body({ view: null, balance: 0, restart: FREE, targets: TARGETS, selectedTargetId: "t1" });
    const go = byTestId(free, "stream-go-live");
    expect(go, "a free restart at balance 0 reaches Go live").toBeDefined();
    expect(propsOf(go!).disabled, "…and it is enabled").toBeFalsy();
    let tiles = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      expect(byTestId(free, `stream-buy-pack-${pack.size}`), `no forced tile ${pack.size}`).toBeUndefined();
      tiles++;
    }
    expect(tiles, "no packs declared — the absence above would be vacuous").toBeGreaterThan(0);
    expect(textAt(free, "stream-restart")).toBe(m("stream.restart.used", { used: 1, limit: 3 }));
    expect(attr(byTestId(free, "stream-restart")!, "data-tone")).toBe("emerald");
    expect(byTestId(free, "stream-state-pill")).toBeDefined();
    expect(chainOf(free), "a free restart draws the chain").toBeDefined();
    expect(byTestId(free, "stream-balance")).toBeUndefined();

    // At the limit with no credits: not free, so the forced tiles — the restart line is Go live's, and Go live is gone.
    const spent = body({ view: null, balance: 0, restart: AT_LIMIT, targets: TARGETS, selectedTargetId: "t1" });
    for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(spent, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
    expect(byTestId(spent, "stream-go-live")).toBeUndefined();
    // The empty case: no window → no line, at any balance.
    const shut = body({ view: null, balance: 0, restart: null, targets: TARGETS, selectedTargetId: "t1" });
    expect(byTestId(shut, "stream-go-live")).toBeUndefined();
    expect(byTestId(shut, "stream-restart")).toBeUndefined();
    expect(byTestId(body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" }), "stream-restart"), "funded, window shut: no line").toBeUndefined();
  });

  it("W23 (rev 2): at the limit the amber line carries the credit suffix and 'Uses 1 credit' leaves the credits line — '1 credit' said once; below it, emerald and no suffix", () => {
    const SEP = " · ";
    const limit = body({ view: null, balance: 9, restart: AT_LIMIT, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(limit, "stream-restart")).toBe(m("stream.restart.usedCredit", { used: 3, limit: 3 }));
    expect(m("stream.restart.usedCredit", { used: 3, limit: 3 })).toBe("Free restarts used (3 of 3) — this one uses 1 credit");
    expect(attr(byTestId(limit, "stream-restart")!, "data-tone")).toBe("amber");
    expect(textAt(limit, "stream-credits-line")).toBe([m("stream.phone.credits.other", { n: 9 }), m("stream.phone.buyMore")].join(SEP));
    const below = body({ view: null, balance: 9, restart: { windowOpen: true, used: 2, limit: 3, free: true }, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(below, "stream-restart")).toBe(m("stream.restart.used", { used: 2, limit: 3 }));
    expect(textAt(below, "stream-restart")).not.toContain("credit");
    expect(textAt(below, "stream-credits-line")).toBe([m("stream.phone.credits.other", { n: 9 }), m("stream.phone.buyMore")].join(SEP));
    // The line sits above Go live, in the column under the picker (mockup state 4).
    const i = limit.findIndex((el) => attr(el, "data-testid") === "stream-restart");
    const j = limit.findIndex((el) => attr(el, "data-testid") === "stream-go-live");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(j);
  });

  it("§6.12's new copy, in every locale: the same placeholders as English (a lost {remaining} renders a countdown with no time), and every sentence translated", () => {
    const en = uiDict("en");
    const keys = Object.keys(en).filter((k) => /^stream\.(restart\.|code\.|phone\.(countdown|paused)\.|phone\.(pairFirst|silent|waitingVideo|pollFar|matchOver)$|error\.phone_not_paired$)/.test(k));
    const holes = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    let checked = 0;
    let sentences = 0;
    for (const l of LOCALES) {
      const d = uiDict(l);
      for (const k of keys) {
        expect(d[k], `${l} ${k}`).toBeTypeOf("string");
        expect(holes(d[k]!), `${l} ${k}`).toEqual(holes(en[k]!));
        if (l !== "en" && en[k]!.length > 20) {
          expect(d[k], `${l} ${k} is translated`).not.toBe(en[k]);
          sentences++;
        }
        checked++;
      }
    }
    // 2 restart + 8 code + 3 countdown + 5 paused + 5 phone sentences + phone_not_paired.
    expect(keys.length, "PREMISE: the sweep found §6.12's keys").toBe(24);
    expect(checked).toBe(keys.length * LOCALES.length);
    expect(sentences).toBeGreaterThan(0);
    // The countdown sentences name the time left; the live one also the time gone (W24).
    expect(holes(en["stream.phone.countdown.live.phone_lost"]!)).toEqual(["elapsed", "remaining"]);
    expect(holes(en["stream.restart.usedCredit"]!)).toEqual(["limit", "used"]);
  });

  it("W23: the ENDED card carries the line too (Ready or Ended, inside the window); a live, waiting or failed session never does", () => {
    const ended = session({ state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true, restart: FREE });
    const card = byTestId(body({ view: ended, balance: 0, restart: FREE }), "stream-ended")!;
    expect(walk(propsOf(card).children as ReactElement).some((el) => attr(el, "data-testid") === "stream-restart"), "inside the ended card").toBe(true);
    const up = [
      session({ state: "live", startedAt: "2026-09-14T11:50:00Z", restart: FREE }),
      session({ restart: FREE }),
      session({ state: "failed", failReason: "no_inbound_timeout", balance: 0, restart: FREE }),
    ];
    let checked = 0;
    for (const v of up) {
      expect(byTestId(body({ view: v, balance: 0, restart: FREE }), "stream-restart"), v.state).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("B6: an OPENED chooser has a visible Close that hands back the idle controls; a FORCED one (balance 0) has none", () => {
    let toggled = 0;
    const opened = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", showBuy: true, onShowBuy: () => { toggled++; } });
    const close = byTestId(opened, "stream-credits-close")!;
    expect(close, "no close on an opened chooser").toBeDefined();
    expect(textOf(close)).toBe(m("stream.credits.close"));
    const cls = String(attr(close, "className")).split(/\s+/);
    expect(cls).toContain("btn-ghost");
    expect(cls).toContain("min-h-11");
    expect(byTestId(opened, "stream-go-live"), "the chooser replaces the idle controls while open").toBeUndefined();
    (attr(close, "onClick") as (e: unknown) => void)(fakeClick(null).event);
    expect(toggled, "Close is the chooser's own toggle").toBe(1);
    // Closed (the container flips showBuy): the idle controls are back.
    expect(byTestId(body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", showBuy: false }), "stream-go-live")).toBeDefined();
    // Forced: nothing to go back to — no Close.
    expect(byTestId(body({ view: null, balance: 0, showBuy: true }), "stream-credits-close")).toBeUndefined();
    expect(byTestId(body({ view: null, balance: 0 }), "stream-credits-close")).toBeUndefined();
  });

  it("P5: closing the chooser hands focus back to Buy more — the Close unmounts with it, and focus must not fall to <body>", () => {
    let toggled = 0;
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", showBuy: true, onShowBuy: () => { toggled++; } });
    // The handler finds Buy more from the body's own root marker — which must BE on the rendered root.
    expect(attr(tree[0]!, "data-phone-body"), "the root carries the marker the Close looks up").toBe(true);
    expect(byTestId(tree, "stream-buy-more"), "the opener is on screen while the chooser is open").toBeDefined();
    const buyMore = { focus: vi.fn() };
    const { event, selectors } = fakeClick(buyMore);
    (attr(byTestId(tree, "stream-credits-close")!, "onClick") as (e: unknown) => void)(event);
    expect(toggled).toBe(1);
    expect(buyMore.focus, "focus went back to Buy more").toHaveBeenCalledTimes(1);
    expect(selectors).toEqual(["[data-phone-body]", '[data-testid="stream-buy-more"]']);
    // No opener to return to (a mid-session balance that fell to 0): the close still closes, and throws nothing.
    const { event: orphan } = fakeClick(null);
    expect(() => (attr(byTestId(tree, "stream-credits-close")!, "onClick") as (e: unknown) => void)(orphan)).not.toThrow();
    expect(toggled).toBe(2);
  });

  it("B8: every credit tile top-aligns its lines, so the three tiles' baselines line up", () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const cls = String(attr(byTestId(body({ view: null, balance: 0 }), `stream-buy-pack-${pack.size}`)!, "className")).split(/\s+/);
      for (const c of ["flex", "flex-col", "items-start", "justify-start"]) expect(cls, `${pack.size}: ${c}`).toContain(c);
      checked++;
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length);
  });

  it("I1/I4: a relay refusal mid-session renders the switched-off state in the BUY slot and keeps every session control — Stop above all", () => {
    const live = session({ state: "live", startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: live, balance: 2, planGate: true, showBuy: true });
    expect(byTestId(tree, "stream-stop"), "a plan refusal took Stop away from a live stream").toBeDefined();
    expect(byTestId(tree, "stream-on-air")).toBeDefined();
    const slot = byTestId(tree, "stream-plan-gate")!;
    expect(slot, "no gate in the buy slot").toBeDefined();
    expect(textOf(byTestId(tree, "stream-switched-off")!)).toContain(m("stream.phone.switchedOff"));
    // The tiles and Buy more are gone: buying is exactly what the plan refused.
    expect(byTestId(tree, "stream-buy-pack-5")).toBeUndefined();
    expect(byTestId(tree, "stream-buy-more")).toBeUndefined();
    // The empty case: no refusal, no gate slot.
    expect(byTestId(body({ view: live, balance: 2 }), "stream-plan-gate")).toBeUndefined();
  });

  it("m1: a failed stop has its OWN copy while the session is still up — never the create copy, and gone once it has ended", () => {
    const live = session({ state: "live", startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: live, balance: 1, stopFailed: true });
    expect(textAt(tree, "stream-stop-error")).toBe(m("stream.error.stop"));
    expect(attr(byTestId(tree, "stream-stop-error")!, "role")).toBe("alert");
    expect(byTestId(tree, "stream-create-error")).toBeUndefined();
    expect(byTestId(body({ view: live, balance: 1 }), "stream-stop-error"), "the empty case").toBeUndefined();
    // A later read that finds it ended makes "did not stop" false — the card must not keep saying it.
    const ended = session({ state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z" });
    expect(byTestId(body({ view: ended, balance: 1, stopFailed: true }), "stream-stop-error")).toBeUndefined();
  });

  it("N1/N3: the failure copy names the control ON SCREEN — Cancel before live, Stop once live — and nothing while it ends", () => {
    expect(m("stream.error.cancel"), "premise: the two sentences differ").not.toBe(m("stream.error.stop"));
    const EXPECTED: [string, StreamSessionView, string | null][] = [
      ["provisioning", session({ state: "provisioning" }), m("stream.error.cancel")],
      ["warming", session({ state: "warming" }), m("stream.error.cancel")],
      ["live", session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), m("stream.error.stop")],
      ["ending", session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" }), null],
      ["failed", session({ state: "failed", failReason: "machine_crash" }), null],
    ];
    let checked = 0;
    for (const [name, view, copy] of EXPECTED) {
      const tree = body({ view, balance: 1, stopFailed: true });
      if (copy === null) expect(byTestId(tree, "stream-stop-error"), name).toBeUndefined();
      else expect(textAt(tree, "stream-stop-error"), name).toBe(copy);
      checked++;
    }
    expect(checked).toBe(EXPECTED.length);
  });

  it("m9: the state pill announces a change politely", () => {
    let checked = 0;
    for (const [name, tree] of bodyStates()) {
      const pill = byTestId(tree, "stream-state-pill");
      if (!pill) continue;
      expect(attr(pill, "aria-live"), name).toBe("polite");
      checked++;
    }
    expect(checked).toBe(bodyStates().length - CREDITS_ONLY.size);
  });

  it("m11: a failed row with NO reason (V410's fail_reason is nullable, unchecked) has its own copy — not a machine crash", () => {
    const tree = body({ view: session({ state: "failed", failReason: null }), balance: 1 });
    expect(textAt(tree, "stream-fail-reason")).toBe(m("stream.fail.unknown"));
    expect(m("stream.fail.unknown"), "the premise: the two sentences differ").not.toBe(m(FAIL_REASON_KEYS.machine_crash));
  });

  it("m12: ending disables EVERY control — Buy more and an open chooser's tiles and Close included", () => {
    const ending = session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: ending, balance: 2, showBuy: true });
    const ids = ["stream-buy-more", "stream-credits-close", ...STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`)];
    for (const id of ids) expect(attr(byTestId(tree, id)!, "disabled"), id).toBe(true);
    // The positive pair: live, the same controls are live.
    const live = body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true });
    for (const id of ids) expect(attr(byTestId(live, id)!, "disabled"), id).toBeFalsy();
  });

  it("N2: while a checkout sheet is open (or still loading) every tile is disabled; the positive pair enables them", () => {
    const ids = STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`);
    let checked = 0;
    for (const [name, props] of [
      ["forced, balance 0", { view: null, balance: 0 }],
      ["Buy more opened, live", { view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true }],
    ] as const) {
      const open = body({ ...props, checkoutOpen: true });
      const shut = body({ ...props, checkoutOpen: false });
      for (const id of ids) {
        expect(attr(byTestId(open, id)!, "disabled"), `${name}: ${id}`).toBe(true);
        expect(attr(byTestId(shut, id)!, "disabled"), `${name}: ${id}`).toBeFalsy();
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("M2: every tile says a hand is reaching for it — pointerenter, focus and touchstart — and a click still buys that pack", () => {
    let checked = 0;
    for (const [name, props] of [
      ["forced, balance 0", { view: null, balance: 0 }],
      ["Buy more opened, live", { view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true }],
    ] as const) {
      const intent = vi.fn();
      const bought: number[] = [];
      const tree = body({ ...props, onTileIntent: intent, onBuy: (s) => bought.push(s) });
      for (const pack of STREAM_CREDIT_PACKS) {
        const tile = byTestId(tree, `stream-buy-pack-${pack.size}`)!;
        for (const event of ["onPointerEnter", "onFocus", "onTouchStart"] as const) {
          const before = intent.mock.calls.length;
          (attr(tile, event) as (() => void) | undefined)?.();
          expect(intent.mock.calls.length, `${name}: ${pack.size} ${event}`).toBe(before + 1);
          checked++;
        }
        click(tile);
      }
      expect(bought, `${name}: a click is still the purchase`).toEqual(STREAM_CREDIT_PACKS.map((p) => p.size));
    }
    expect(checked).toBe(2 * STREAM_CREDIT_PACKS.length * 3);
    // Nothing but a tile warms the sheet: the chooser's other controls carry no intent handler.
    const tree = body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true, onTileIntent: () => {} });
    const warmers = tree.filter((el) => typeof attr(el, "onPointerEnter") === "function");
    expect(warmers.map((el) => attr(el, "data-testid")).sort()).toEqual(STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`).sort());
  });

  it("B7: each native select names its selection in a title, so a clipped option is still readable", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t2" });
    expect(attr(byTestId(tree, "stream-target")!, "title")).toBe(`Alt (${platformName(m, "twitch")})`);
    expect(String(attr(byTestId(tree, "stream-target")!, "className")).split(/\s+/)).toEqual(expect.arrayContaining(["w-full", "min-w-0"]));
  });

  // T9b (spec §3.1): the chain says the state, so in the tab the pill is for assistive tech only — still `aria-live`, still
  // the state's own copy. Ended and failed draw no chain (§3.2): their card shows the pill, in §8a's colour.
  it("the state pill: sr-only (aria-live, the state's copy) wherever the chain shows; VISIBLE in the ended and failed cards in §8a's colour", () => {
    const VISIBLE: Record<string, string> = { ended: "bg-emerald-100", failed: "bg-red-50" };
    let hidden = 0;
    let shown = 0;
    for (const [name, tree] of bodyStates()) {
      const pill = byTestId(tree, "stream-state-pill");
      if (name === "idle, balance 0 (the credits card)") {
        expect(pill, name).toBeUndefined(); // B3: credits only
        continue;
      }
      expect(pill, name).toBeDefined();
      expect(attr(pill!, "aria-live"), name).toBe("polite");
      const cls = String(attr(pill!, "className"));
      if (name in VISIBLE) {
        expect(cls, name).toContain(VISIBLE[name]);
        expect(cls.split(" "), name).not.toContain("sr-only");
        shown++;
      } else {
        expect(cls, name).toBe("sr-only");
        hidden++;
      }
      expect(byTestId(tree, "stream-live-dot"), `${name}: no live dot in the tab (the chain's red ring is it)`).toBeUndefined();
    }
    expect(shown).toBe(Object.keys(VISIBLE).length);
    expect(hidden, "anti-vacuity: the sr-only states were reached").toBeGreaterThanOrEqual(10);
  });

  it("phone first: every stream-* control in every state carries the unprefixed 44px floor", () => {
    // min-h-12 (48 px: the mockup's Go live and Stop stream) clears the floor too.
    const TAPPABLE = /(^|\s)(min-h-11|min-h-12|h-11)(\s|$)/;
    let seen = 0;
    for (const [name, tree] of bodyStates()) {
      for (const el of tree) {
        const id = attr(el, "data-testid");
        if (typeof id !== "string" || !id.startsWith("stream-")) continue;
        if (!["button", "a", "select", "input"].includes(String(el.type))) continue;
        seen++;
        expect(String(attr(el, "className") ?? ""), `${name}: ${id} has no unprefixed 44px floor`).toMatch(TAPPABLE);
      }
    }
    expect(seen, "the sweep found no controls").toBeGreaterThanOrEqual(24);
  });
});

// ─── T8: the picker picks from Directory (D1) ────────────────────────────────────────────────────────────────────────
describe("T8 — the destination picker: Directory manages, the panel picks (D1)", () => {
  it("D1: no inline add anywhere — no add button, no destination form, no key field in ANY state; 'Manage destinations' opens the Directory tab in a new tab", () => {
    let checked = 0;
    for (const [name, tree] of bodyStates()) {
      for (const id of ["stream-target-add", "stream-target-form", "stream-dest-form", "stream-target-key", "stream-dest-key"]) {
        expect(byTestId(tree, id), `${name}: ${id}`).toBeUndefined();
      }
      expect(tree.filter((el) => el.type === "input" && attr(el, "type") === "password"), `${name}: a key field`).toEqual([]);
      expect(tree.filter((el) => el.type === "form"), `${name}: a form`).toEqual([]);
      checked++;
    }
    expect(checked, "every body state was read").toBe(bodyStates().length);
    let linked = 0;
    for (const targets of [ok(TARGETS), ok([]), { status: "error" } as const]) {
      const link = byTestId(body({ view: null, balance: 2, targets, selectedTargetId: null }), "stream-manage-destinations");
      expect(link, targets.status).toBeDefined();
      expect(link!.type).toBe("a");
      expect(attr(link!, "href")).toBe("/directory?tab=streaming");
      expect(attr(link!, "target")).toBe("_blank");
      expect(attr(link!, "rel")).toBe("noopener");
      expect(textOf(link!)).toBe(m("stream.dest.manage"));
      linked++;
    }
    expect(linked).toBe(3);
  });

  it("one destination: the select and Go live ENABLED (the positive pair of the empty case)", () => {
    const tree = body({ view: null, balance: 2, targets: [TARGETS[0]!], selectedTargetId: "t1" });
    expect(byTestId(tree, "stream-dest-empty")).toBeUndefined();
    expect(attr(byTestId(tree, "stream-target")!, "value")).toBe("t1");
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled).toBeFalsy();
  });

  it("m12: the select's id is the FIXTURE's own (two mounted panels never share one), and its label names it", () => {
    let checked = 0;
    for (const fixtureId of ["f-1", "f-2"]) {
      const tree = body({ fixtureId, view: null, balance: 2, targets: [TARGETS[0]!], selectedTargetId: "t1" });
      const select = byTestId(tree, "stream-target")!;
      expect(attr(select, "id"), fixtureId).toBe(`stream-target-${fixtureId}`);
      const label = tree.find((el) => el.type === "label" && attr(el, "htmlFor") === attr(select, "id"));
      expect(label, `${fixtureId}: a <label> names the select`).toBeDefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a failed destination load is an ERROR with Retry — never shown as 'none' (the silent catch this replaces)", () => {
    let retried = 0;
    const tree = body({ view: null, balance: 2, targets: { status: "error" }, selectedTargetId: "t1", onRetryTargets: () => retried++ });
    const err = byTestId(tree, "stream-dest-load-error")!;
    expect(attr(err, "role")).toBe("alert");
    expect(textOf(err)).toContain(m("stream.dest.loadError"));
    expect(byTestId(tree, "stream-dest-empty"), "an unread list is not an empty one").toBeUndefined();
    expect(byTestId(tree, "stream-target")).toBeUndefined();
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled, "no Go live on a list nobody read").toBe(true);
    expect(textAt(tree, "stream-dest-retry")).toBe(m("stream.dest.retry"));
    click(byTestId(tree, "stream-dest-retry"));
    expect(retried).toBe(1);
  });

  it("loading: neither 'none' nor an error, no select, and Go live waits", () => {
    const tree = body({ view: null, balance: 2, targets: { status: "loading" }, selectedTargetId: "t1" });
    for (const id of ["stream-dest-empty", "stream-dest-load-error", "stream-target"]) expect(byTestId(tree, id), id).toBeUndefined();
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled).toBe(true);
  });

  it("each option names the destination AND its platform — every stored kind, legacy ones included", () => {
    const all = StreamTargetKind.options.map((kind, i) => ({ ...TARGETS[0]!, id: `k${i}`, kind, label: `Dest ${i}` }));
    const select = byTestId(body({ view: null, balance: 2, targets: all, selectedTargetId: "k0" }), "stream-target")!;
    const options = walk(propsOf(select).children as ReactElement[]).filter((el) => el.type === "option");
    expect(options.map((o) => textOf(o))).toEqual(all.map((t) => `${t.label} (${platformName(m, t.kind)})`));
    expect(options.length, "every stored kind was offered").toBe(StreamTargetKind.options.length);
  });

  it("a target_in_use refusal names the match and links 'Open Match {n}' to its page; a holder whose fixture is gone shows no link", () => {
    const held = body({
      view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1",
      createError: { code: "target_in_use", holder: { label: "Club YouTube", matchNo: 5, courtName: "Court 1", href: "/o/a/c/b/d/c/f/5", state: "waiting" } },
    });
    expect(textAt(held, "stream-create-error")).toBe(
      m("stream.inUse.waiting", { label: "Club YouTube", match: m("stream.inUse.matchCourt", { match: m("breadcrumb.match", { no: 5 }), court: "Court 1" }) }),
    );
    const open = byTestId(held, "stream-in-use-open")!;
    expect(open.type).toBe("a");
    expect(attr(open, "href")).toBe("/o/a/c/b/d/c/f/5");
    expect(textOf(open)).toBe(m("stream.inUse.open", { match: m("breadcrumb.match", { no: 5 }) }));
    let none = 0;
    for (const holder of [
      { label: "X", matchNo: null, courtName: null, href: null, state: "live" as const },
      { label: "X", matchNo: 7, courtName: null, href: null, state: "live" as const },
      { label: "X", matchNo: null, courtName: null, href: "/o/a/c/b/d/c/f/7", state: "live" as const },
    ]) {
      const gone = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "target_in_use", holder } });
      expect(byTestId(gone, "stream-in-use-open"), JSON.stringify(holder)).toBeUndefined();
      none++;
    }
    expect(none).toBe(3);
    const other = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "storage_exhausted", holder: null } });
    expect(byTestId(other, "stream-in-use-open"), "only an in-use refusal links a match").toBeUndefined();
  });
});

// ─── PhoneTab: the container, driven (D15) ─────────────────────────────────────────────────────────────────────────
// ─── T9a: the Signal path and the D3 warning, as the body wires them (spec 2026-09-30 §3.2) ─────────────────────────
// The mapping is stream-chain.test.ts's and the drawing stream-signal-chain.test.tsx's. What is proven HERE is the
// wiring: which session the body hands the mapping, which destination the chain is drawn to, and when the D3 box shows.
// Expected chains are `chainFor` of the SAME projection — the wiring is the claim, and the mapping is pinned against
// the spec on its own. Rule 1's states: no destination, waiting, live ok / connecting / <30 s / ≥30 s / back to ok,
// stale phone, ending, ended, failed, in use.
describe("PhoneTabBody — the Signal path and the D3 warning (T9a)", () => {
  const W = 30_000; // spec §0 D3 — stream-session-view.test.ts pins the lib's OUTPUT_WARNING_AFTER_MS to it
  const live = (output: "ok" | "connecting" | "unknown" | "rejected" | null, elapsedMs = 0, over: Partial<StreamSessionView> = {}) =>
    session({
      state: "live", startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" },
      output: output ? { state: output, since: "2026-09-14T11:59:00Z", elapsedMs } : null,
      ...over,
    });
  const warnings = (tree: ReactElement[]) => tree.filter((e) => e.type === D3Warning);

  it("idle: drawn to the PICKED destination — and not drawn at all with nothing to draw it to (empty, loading, failed list)", () => {
    const picked = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t2" });
    expect(chainOf(picked)?.chain).toEqual(chainFor(null, { capture: { phone: facts(), countdown: null } }));
    expect(chainOf(picked)?.destination).toEqual({ kind: "twitch", label: "Alt" });
    let none = 0;
    for (const targets of [[] as StreamTarget[], { status: "loading" } as TargetsState, { status: "error" } as TargetsState]) {
      expect(chainOf(body({ view: null, balance: 2, targets, selectedTargetId: null }))).toBeUndefined();
      none++;
    }
    expect(none).toBe(3);
    // A selection the list no longer holds draws nothing either (n1: nothing is drawn to a destination that is gone).
    expect(chainOf(body({ view: null, balance: 2, targets: [TARGETS[0]!], selectedTargetId: "t2" }))).toBeUndefined();
  });

  it("with a session: drawn to the SESSION's destination, whatever the picker holds", () => {
    const tree = body({ view: session({ target: { id: "t9", kind: "facebook", label: "Page" } }), balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    expect(chainOf(tree)?.destination).toEqual({ kind: "facebook", label: "Page" });
    expect(chainOf(tree)?.chain?.phone.word, "§6.12: a v2 session's phone is Starting").toBe("starting");
  });

  it("every state's chain is chainFor of the body's own projection; ended and failed draw none", () => {
    let checked = 0;
    for (const v of [session({ state: "provisioning" }), session(), live("ok"), live("connecting", W - 1), live("connecting", W), session({ state: "ending" })]) {
      // The body hands chainFor its read model's phone and the server's countdown (§6.12); a legacy session hands none.
      expect(chainOf(body({ view: v, balance: 2 }))?.chain, v.state).toEqual(chainFor(v, { capture: { phone: facts(), countdown: v.countdown } }));
      expect(chainOf(body({ view: v, balance: 2, phone: LEGACY }))?.chain, `${v.state} (legacy)`).toEqual(chainFor(v));
      checked++;
    }
    for (const v of [session({ state: "completed" }), session({ state: "failed", failReason: "no_credits" })]) {
      expect(chainOf(body({ view: v, balance: 2 })), v.state).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("D3: the warning shows at the 30 s line, NOT one millisecond before; never on ok; gone once it is ok again; never while ending", () => {
    expect(warnings(body({ view: live("connecting", W - 1), balance: 1 })), "under the line").toHaveLength(0);
    const at = warnings(body({ view: live("connecting", W), balance: 1 }));
    expect(at, "at the line").toHaveLength(1);
    expect(propsOf(at[0]!).kind, "names the session's platform").toBe("youtube");
    let words = 0;
    for (const o of ["unknown", "rejected"] as const) {
      expect(warnings(body({ view: live(o, W * 3), balance: 1 })), o).toHaveLength(1);
      words++;
    }
    expect(words).toBe(2);
    expect(warnings(body({ view: live("ok", W * 3), balance: 1 })), "ok after a long time: no warning").toHaveLength(0);
    expect(warnings(body({ view: live(null), balance: 1 })), "no output read").toHaveLength(0);
    expect(warnings(body({ view: { ...live("connecting", W * 3), state: "ending" }, balance: 1 })), "ending").toHaveLength(0);
    // The stream keeps running (D3): Stop is still there, enabled, beside the warning.
    const warned = body({ view: live("connecting", W), balance: 1 });
    expect(byTestId(warned, "stream-stop")).toBeDefined();
    expect(propsOf(byTestId(warned, "stream-stop")!).disabled).toBeFalsy();
    // A Twitch session's warning names Twitch.
    expect(propsOf(warnings(body({ view: live("connecting", W, { target: { id: "t2", kind: "twitch", label: "Alt" } }), balance: 1 }))[0]!).kind).toBe("twitch");
  });

  it("a stale phone while live: the chain says Reconnecting… (§6.12; a legacy session keeps No signal); the destination half still follows the output", () => {
    const v = live("ok", 0, { ingest: { state: "disconnected", protocol: null } });
    expect(chainOf(body({ view: v, balance: 1 }))?.chain).toMatchObject({ phone: { word: "reconnecting" }, dest: { word: "live" } });
    expect(chainOf(body({ view: v, balance: 1, phone: LEGACY }))?.chain).toMatchObject({ phone: { word: "noSignal" }, dest: { word: "live" } });
  });

  // I-1 (owner 2026-10-01, option a): past the hold, the box POINTS AT THE PHONE while the phone has no signal, and at
  // the stream key only while the phone is sending. The stream keeps running either way: Stop stays, enabled.
  it("I-1: past the hold, no signal from the phone → the phone box; the phone sending → the key box; under the hold → none", () => {
    const silent = { ingest: { state: "disconnected" as const, protocol: null } };
    let checked = 0;
    for (const o of ["connecting", "unknown", "rejected"] as const) {
      const phone = warnings(body({ view: live(o, W, silent), balance: 1 }));
      expect(phone, `${o}: one box`).toHaveLength(1);
      expect(propsOf(phone[0]!).cause, `${o}: it points at the phone`).toBe("phone");
      const key = warnings(body({ view: live(o, W), balance: 1 }));
      expect(propsOf(key[0]!).cause, `${o}: phone sending → the key box`).toBe("destination");
      expect(warnings(body({ view: live(o, W - 1, silent), balance: 1 })), `${o}: under the hold`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(3);
    expect(warnings(body({ view: live("ok", W * 3, silent), balance: 1 })), "silent phone but the destination ok: no box").toHaveLength(0);
    const warned = body({ view: live("connecting", W, silent), balance: 1 });
    expect(propsOf(byTestId(warned, "stream-stop")!).disabled, "the stream keeps running: Stop is there").toBeFalsy();
    // The chain's "!" follows the box (ruling 2026-10-01): on the phone node, not the destination, through the body.
    expect(chainOf(warned)?.chain).toMatchObject({ phone: { word: "reconnecting", mark: "bang" }, dest: { word: "notReceiving", mark: null } });
    expect(chainOf(body({ view: live("connecting", W), balance: 1 }))?.chain, "the phone sending: the '!' is the destination's")
      .toMatchObject({ phone: { mark: null }, dest: { word: "notReceiving", mark: "bang" } });
  });

  // I-2a (controller ruling 2026-10-01): the server restarts the hold when the phone returns (pinned on the server's
  // clock in stream-sessions.test.ts). This feeds the body the elapsed the server answers at each step, so it asserts
  // the box AND the "!" the body draws from them — not the clock.
  it("I-1/I-2a: the box and the '!' through the body for each answer of a drop-and-return, as the server times it: drop → phone; back → none until 30 s after the return → key; receiving → none", () => {
    const silent = { ingest: { state: "disconnected" as const, protocol: null } };
    const seen = [
      live("ok", 0),
      live("unknown", 5_000, silent),
      live("unknown", W, silent),
      live("connecting", 0),
      live("connecting", W - 1),
      live("connecting", W),
      live("ok", 0),
    ].map((v) => {
      const b = body({ view: v, balance: 1 });
      const w = warnings(b);
      const c = chainOf(b)!.chain!;
      const bang = c.phone.mark === "bang" ? "phone" : c.dest.mark === "bang" ? "dest" : null;
      return [w.length === 0 ? null : (propsOf(w[0]!).cause as string), bang];
    });
    expect(seen).toEqual([[null, null], [null, null], ["phone", "phone"], [null, null], [null, null], ["destination", "dest"], [null, null]]);
  });

  it("in use (mockup state 5): an idle target_in_use refusal draws the destination node 'In use'; any other refusal does not", () => {
    const holder = { sessionId: "s9", fixtureId: "f-9", href: "/x", matchNo: 5, courtName: "Court 1", state: "live" as const, label: "Club" };
    const inUse = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "target_in_use", holder } });
    expect(chainOf(inUse)?.chain?.dest.word).toBe("inUse");
    const other = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "storage_exhausted", holder: null } });
    expect(chainOf(other)?.chain?.dest.word).toBe("notLive");
  });
});

// ─── T9b: the frame (spec §3.1 / §3.3, mockup option-a states 1, 3 and 5) ────────────────────────────────────────────
describe("PhoneTabBody — the T9b frame: one credits line, Ready's order, the in-use picker", () => {
  const SEP = " · ";
  const localeDict = (locale: "es" | "fr") => uiDict(locale);
  const balanceIn = (html: string): string => /data-testid="stream-balance"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";

  it("Ready: 'Uses 1 credit · {n} credits · Buy more' — three parts, the balance in the plural key's own text, the split as its title", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(tree, "stream-credits-line")).toBe(
      [m("stream.credits.uses"), m("stream.phone.credits.other", { n: 2 }), m("stream.phone.buyMore")].join(SEP),
    );
    expect(attr(byTestId(tree, "stream-balance")!, "title"), "no split, no title").toBeUndefined();
    // Both buckets held and adding up: the split is the balance's title, and a visually hidden copy reads it out.
    const split = { monthly: 2, pack: 3, total: 5 };
    const both = body({ view: null, balance: 5, split, targets: TARGETS, selectedTargetId: "t1" });
    const sentence = m("stream.credits.split", { m: 2, p: 3 });
    expect(attr(byTestId(both, "stream-balance")!, "title")).toBe(sentence);
    expect(textAt(both, "stream-balance"), "the balance itself is the total, as before").toBe(m("stream.phone.credits.other", { n: 5 }));
    expect(textAt(both, "stream-credits-split").trim()).toBe(sentence);
    expect(String(attr(byTestId(both, "stream-credits-split")!, "className"))).toBe("sr-only");
    // A split that no longer adds up (a session moved the balance) titles nothing.
    expect(attr(byTestId(body({ view: null, balance: 4, split, targets: TARGETS, selectedTargetId: "t1" }), "stream-balance")!, "title")).toBeUndefined();
  });

  it("the balance reads the plural key's ONE and OTHER forms in es and fr — never a number dropped into a fixed word", () => {
    let checked = 0;
    for (const locale of ["es", "fr"] as const) {
      const d = localeDict(locale);
      const one = d["stream.phone.credits.one"]!;
      const other = d["stream.phone.credits.other"]!;
      // The case can witness the defect: "{n} credits" at n = 1 is not the singular.
      expect(other.replace("{n}", "1"), `${locale}: the one form differs from other at n=1`).not.toBe(one);
      for (const [n, want] of [[1, one], [9, other.replace("{n}", "9")]] as const) {
        const html = renderToStaticMarkup(
          <DictProvider dict={d} locale={locale}>
            <PhoneTabBody {...BODY} view={null} balance={n} targets={ok(TARGETS)} selectedTargetId="t1" />
          </DictProvider>,
        );
        expect(balanceIn(html), `${locale} n=${n}`).toBe(want);
        expect(html, `${locale}: the uses part`).toContain(`>${d["stream.credits.uses"]}<`);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("'Uses 1 credit' only where Go live would spend one: not inside the reuse window, not mid-session; ending disables Buy more", () => {
    const free = body({ view: null, balance: 2, restart: { windowOpen: true, used: 0, limit: 3, free: true }, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(free, "stream-credits-line")).toBe([m("stream.phone.credits.other", { n: 2 }), m("stream.phone.buyMore")].join(SEP));
    const live = body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), balance: 2 });
    expect(textAt(live, "stream-credits-line"), "a mid-match top-up stays").toBe([m("stream.phone.credits.other", { n: 2 }), m("stream.phone.buyMore")].join(SEP));
    const ending = body({ view: session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" }), balance: 2 });
    expect(propsOf(byTestId(ending, "stream-buy-more")!).disabled).toBe(true);
    // The empty case: credits only (balance 0, no free restart) has no line at all — the tiles are the whole tab.
    expect(byTestId(body({ view: null, balance: 0 }), "stream-credits-line")).toBeUndefined();
  });

  it("Ready's DOM order (mockup state 1): Manage destinations, the picker, a full-width Go live, then the credits line", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    const order = ["stream-manage-destinations", "stream-target", "stream-go-live", "stream-credits-line"].map((id) => {
      const i = tree.findIndex((el) => attr(el, "data-testid") === id);
      expect(i, `${id} rendered`).toBeGreaterThan(-1);
      return i;
    });
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const go = String(attr(byTestId(tree, "stream-go-live")!, "className")).split(" ");
    for (const c of ["btn-primary", "w-full", "min-h-12"]) expect(go, c).toContain(c);
    // The picker shows the selected destination's platform mark inside the field, and a chevron at its end.
    const mark = tree.find((el) => el.type === PlatformMark);
    expect(mark && propsOf(mark).kind, "the mark is the SELECTED destination's").toBe("youtube");
    expect(propsOf(byTestId(body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t2" }), "stream-target")!).value).toBe("t2");
    const markT2 = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t2" }).find((el) => el.type === PlatformMark);
    expect(markT2 && propsOf(markT2).kind).toBe("twitch");
    const select = String(attr(byTestId(tree, "stream-target")!, "className")).split(" ");
    for (const c of ["appearance-none", "min-w-0", "pr-9", "truncate"]) expect(select, c).toContain(c);
  });

  it("n1: with a list and NO selection the picker shows a placeholder 'Pick a destination', no platform mark, Go live disabled; a selection has no placeholder", () => {
    const none = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: null });
    const select = byTestId(none, "stream-target")!;
    expect(attr(select, "value")).toBe("");
    const options = walk(select).filter((el) => el.type === "option");
    expect(options.map((o) => attr(o, "value"))).toEqual(["", "t1", "t2"]);
    expect(textOf(options[0]!)).toBe(m("stream.dest.pick"));
    expect(attr(options[0]!, "disabled"), "the placeholder cannot be chosen back").toBe(true);
    expect(none.some((el) => el.type === PlatformMark), "no mark for nothing").toBe(false);
    expect(propsOf(byTestId(none, "stream-go-live")!).disabled).toBe(true);
    // The positive pair: a selection, no placeholder.
    const picked = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    expect(walk(byTestId(picked, "stream-target")!).filter((el) => el.type === "option").map((o) => attr(o, "value"))).toEqual(["t1", "t2"]);
  });

  it("in use (mockup state 5): the picker turns red and says why under itself, Open Match beside it, and Go live waits", () => {
    const createError = { code: "target_in_use" as const, holder: IN_USE_HOLDER };
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError });
    const select = byTestId(tree, "stream-target")!;
    expect(String(attr(select, "className"))).toMatch(/(^|\s)border-red-300(\s|$)/);
    expect(attr(select, "aria-invalid")).toBe(true);
    const box = tree.find((el) => attr(el, "id") === attr(select, "aria-describedby"))!;
    expect(box, "aria-describedby names the box").toBeDefined();
    expect(attr(box, "role")).toBe("alert");
    const inBox = walk(box);
    expect(textOf(inBox.find((el) => attr(el, "data-testid") === "stream-create-error")!)).toBe(
      m("stream.inUse.live", { label: IN_USE_HOLDER.label, match: m("stream.inUse.matchCourt", { match: m("breadcrumb.match", { no: 5 }), court: "Court 1" }) }),
    );
    const open = inBox.find((el) => attr(el, "data-testid") === "stream-in-use-open")!;
    expect(attr(open, "href")).toBe(IN_USE_HOLDER.href);
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled, "Go live waits for another pick").toBe(true);
    expect(allTestIds(tree, "stream-create-error"), "said once").toHaveLength(1);
    // The positive pair: any OTHER refusal leaves the picker alone, Go live tappable, the sentence at the foot.
    const other = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", createError: { code: "storage_exhausted", holder: null } });
    expect(attr(byTestId(other, "stream-target")!, "aria-invalid")).toBeUndefined();
    expect(String(attr(byTestId(other, "stream-target")!, "className"))).not.toContain("border-red-300");
    expect(propsOf(byTestId(other, "stream-go-live")!).disabled).toBeFalsy();
    expect(textAt(other, "stream-create-error")).toBe(m("stream.error.storage_exhausted" as MessageKey));
  });

  it("the no-credit state is the pack tiles, unchanged — every catalogue pack, by its own test id", () => {
    const tree = body({ view: null, balance: 0 });
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      expect(byTestId(tree, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
      checked++;
    }
    expect(checked, "anti-vacuity: the catalogue declares packs").toBeGreaterThan(0);
    expect(byTestId(tree, "stream-go-live")).toBeUndefined();
  });
});

// ─── PR-2 (spec §7.1, §7.4, §7.5) — Option A, owner-approved 2026-10-07 ─────────────────────────────────────────────
// Every expected sentence below is the SPEC's (and the mockup's) English, typed here — never read back through the code
// under test; every verdict is the read model's own field (`auto.enabled`, `phone.health`, `notReadyShown`,
// `auto.refusal`, `lastTakeover.elapsedMs`).
describe("PhoneTabBody — PR-2: the switch, the phone's line, the refusal, the takeover and Details (Option A)", () => {
  type Auto = NonNullable<StreamPhone["auto"]>;
  const auto = (over: Partial<Auto> = {}): Auto => ({ enabled: true, startedAt: null, blocked: false, refusal: null, refusalAt: null, ...over });
  const READY = { view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" } as const;
  const LIVE = session({ state: "live", startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" }, health: { fps: 30, bitrateKbps: 2900, lastBeatAt: "2026-09-14T11:59:56Z" } });
  /** §7.1's caption and Live's line, the figure filled — singular at 1 (the plural key's `one`). */
  const caption = (n: number) => `Starts when the match starts. Stops about ${n} ${n === 1 ? "minute" : "minutes"} after the result.`;
  const liveLine = (n: number) => `Automatic: stops about ${n} ${n === 1 ? "minute" : "minutes"} after the result`;
  const stripOf = (tree: ReactElement[]) => {
    const el = tree.find((e) => e.type === PhoneStripView);
    return el ? (propsOf(el) as { strip: Record<string, unknown>; onBuy?: () => void; caret: boolean }) : undefined;
  };

  it("T10: the switch sits under the destination picker in Ready — role=switch, checked from the read model's auto.enabled (no settings row: off)", () => {
    const rows: [string, StreamPhone["auto"], boolean][] = [["no settings row", null, false], ["off", auto({ enabled: false }), false], ["on", auto(), true]];
    let checked = 0;
    for (const [name, a, on] of rows) {
      const tree = body({ ...READY, phone: readModel({ auto: a }) });
      const sw = byTestId(tree, "stream-auto-switch");
      expect(sw, name).toBeDefined();
      expect([sw!.type, attr(sw!, "role"), attr(sw!, "aria-checked")], name).toEqual(["button", "switch", on]);
      expect(tree.indexOf(byTestId(tree, "stream-target")!), `${name}: under the picker`).toBeLessThan(tree.indexOf(sw!));
      expect(tree.indexOf(sw!), `${name}: above Go live`).toBeLessThan(tree.indexOf(byTestId(tree, "stream-go-live")!));
      expect(textAt(tree, "stream-auto-switch"), name).toContain("Stream the match automatically");
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("T10: the caption names the SERVER's delay (autoStopMinutes) only while on — 5 reads 5, 1 reads the singular", () => {
    let checked = 0;
    for (const n of [5, 1]) {
      expect(textAt(body({ ...READY, phone: readModel({ auto: auto() }), autoStopMinutes: n }), "stream-auto-hint"), `${n}`).toBe(caption(n));
      checked++;
    }
    expect(checked).toBe(2);
    expect(byTestId(body({ ...READY, phone: readModel({ auto: auto({ enabled: false }) }), autoStopMinutes: 5 }), "stream-auto-hint")).toBeUndefined();
  });

  it("T10: a tap asks for the flip (onToggleAuto(!checked)); a flip in flight shows the asked state and holds the switch; a failed save says so", () => {
    const onToggleAuto = vi.fn();
    click(byTestId(body({ ...READY, phone: readModel({ auto: auto({ enabled: false }) }), onToggleAuto }), "stream-auto-switch"));
    click(byTestId(body({ ...READY, phone: readModel({ auto: auto() }), onToggleAuto }), "stream-auto-switch"));
    click(byTestId(body({ ...READY, phone: readModel({ auto: null }), onToggleAuto }), "stream-auto-switch"));
    expect(onToggleAuto.mock.calls).toEqual([[true], [false], [true]]);
    const pending = body({ ...READY, phone: readModel({ auto: auto({ enabled: false }) }), autoPending: true });
    expect([attr(byTestId(pending, "stream-auto-switch")!, "aria-checked"), attr(byTestId(pending, "stream-auto-switch")!, "disabled")]).toEqual([true, true]);
    expect(byTestId(pending, "stream-auto-error")).toBeUndefined();
    const failed = body({ ...READY, phone: readModel({ auto: auto({ enabled: false }) }), autoFailed: true });
    expect(attr(byTestId(failed, "stream-auto-switch")!, "aria-checked"), "back to the server's answer").toBe(false);
    expect(attr(byTestId(failed, "stream-auto-error")!, "role")).toBe("alert");
    expect(textAt(failed, "stream-auto-error")).toBe(m("stream.error.failed"));
  });

  it("T10: the switch is Ready's alone — every body state that draws Ready's grid has exactly one; every other state has none", () => {
    let withSwitch = 0;
    let without = 0;
    for (const [name, tree] of bodyStates()) {
      const ready = byTestId(tree, "stream-ready") !== undefined;
      expect(allTestIds(tree, "stream-auto-switch").length, name).toBe(ready ? 1 : 0);
      if (ready) withSwitch++;
      else without++;
    }
    expect(withSwitch, "anti-vacuity: Ready states were read").toBeGreaterThan(0);
    expect(without, "anti-vacuity: other states were read").toBeGreaterThan(0);
  });

  it("T10: Live's read-only line names the server's figure — only live, with the switch on AND the phone automatic (A4); above Stop", () => {
    const autoPhone = readModel({ auto: auto(), phone: facts({ mode: "automatic", state: "publishing" }) });
    const tree = body({ view: LIVE, balance: 1, phone: autoPhone, autoStopMinutes: 4 });
    expect(textAt(tree, "stream-auto-live")).toBe(liveLine(4));
    expect(tree.indexOf(byTestId(tree, "stream-auto-live")!)).toBeLessThan(tree.indexOf(byTestId(tree, "stream-stop")!));
    expect(textAt(body({ view: LIVE, balance: 1, phone: autoPhone, autoStopMinutes: 1 }), "stream-auto-live")).toBe(liveLine(1));
    const rows: [string, PhoneTabBodyProps["view"], StreamPhone][] = [
      ["the switch off", LIVE, readModel({ auto: auto({ enabled: false }), phone: facts({ mode: "automatic" }) })],
      ["the phone in operator mode", LIVE, readModel({ auto: auto(), phone: facts({ mode: "operator" }) })],
      ["no settings row", LIVE, readModel({ auto: null, phone: facts({ mode: "automatic" }) })],
      ["ending", session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" }), autoPhone],
      ["waiting", session(), autoPhone],
      ["ready", null, autoPhone],
    ];
    let checked = 0;
    for (const [name, view, phone] of rows) {
      expect(byTestId(body({ view, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone }), "stream-auto-live"), name).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("T11: live, the strip is the phone-health line (Option A state 4) — the read model's readings, wired as the builder answers", () => {
    const f = facts({ state: "publishing", elapsedMs: 4_000, beat: { battery: { percent: 78, charging: true, drainPctPerHour: null }, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 12 } });
    const tree = body({ view: LIVE, balance: 1, phone: readModel({ phone: f }) });
    expect(stripOf(tree)?.strip).toEqual({
      tone: "slate", icon: "phone", lead: null, body: null,
      line: [{ kind: "phone" }, { kind: "battery", percent: 78, charging: true }, { kind: "bitrate", kbps: 2400 }, { kind: "heard", elapsedMs: 4_000 }],
    });
    expect(stripOf(tree)?.caret, "inside the chain, caret on the phone").toBe(true);
  });

  it("T11: each reason the SERVER names turns the live strip amber with its sentence; the Phone node agrees for not-responding and stalled (W24)", () => {
    let checked = 0;
    for (const health of HEALTH_REASONS) {
      const tree = body({ view: LIVE, balance: 1, phone: readModel({ phone: facts({ state: "publishing", health, elapsedMs: 52_000, beat: { battery: { percent: 14, charging: false, drainPctPerHour: null }, bitrateKbps: 2400, delivery: "stalled", thermal: 4, dataUsedMB: 1 } }) }) });
      expect(stripOf(tree)?.strip, health).toMatchObject({ tone: "amber", icon: "alert", lead: HEALTH_KEYS[health] });
      const node = chainOf(tree)?.chain?.phone;
      expect(node?.mark ?? null, `${health}: the node's "!"`).toBe(health === "not_responding" || health === "stalled" ? "bang" : null);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
  });

  it("T11: waiting — 'Phone not ready' only with the server's notReadyShown; 'Couldn't start on the phone' from startFailed", () => {
    const flap = body({ view: session(), balance: 2, phone: readModel({ phone: facts({ notReady: "camera", notReadyShown: false, mode: "automatic" }) }) });
    expect(stripOf(flap)?.strip).toMatchObject({ tone: "slate", lead: "stream.phone.waitingVideo" });
    const held = body({ view: session(), balance: 2, phone: readModel({ phone: facts({ notReady: "camera", notReadyShown: true, mode: "automatic" }) }) });
    expect(stripOf(held)?.strip).toMatchObject({ tone: "amber", lead: "stream.phone.notReady.line", leadVars: { reason: "stream.phone.notReady.reason.camera" } });
    const failed = body({ view: session(), balance: 2, phone: readModel({ phone: facts({ startFailed: "start-error" }) }) });
    expect(stripOf(failed)?.strip).toMatchObject({ tone: "amber", lead: "stream.phone.startFailed" });
  });

  it("T11: Ready, the automatic start refused — the strip carries it (Option A state 10); Buy credits opens the chooser; Go live names it", () => {
    const onShowBuy = vi.fn();
    const refused = readModel({ auto: auto({ refusal: "no_credit", refusalAt: "2026-09-14T11:59:00Z" }) });
    const tree = body({ ...READY, phone: refused, onShowBuy });
    expect(stripOf(tree)?.strip).toMatchObject({ tone: "amber", lead: "stream.auto.refused", leadVars: { reason: "stream.error.no_credits" }, remedy: "buy" });
    stripOf(tree)!.onBuy!();
    expect(onShowBuy).toHaveBeenCalledTimes(1);
    expect(attr(byTestId(tree, "stream-go-live")!, "aria-describedby")).toBe("stream-why-f-1");
    // The chooser already open (Buy more): the remedy is not offered twice.
    expect(stripOf(body({ ...READY, phone: refused, showBuy: true }))?.onBuy).toBeUndefined();
    // Credits only (B3): the refusal still says why nothing started — no chain, no caret, and the tiles ARE the remedy.
    const forced = body({ view: null, balance: 0, targets: TARGETS, selectedTargetId: "t1", phone: refused });
    expect(chainOf(forced)).toBeUndefined();
    expect(stripOf(forced)?.strip).toMatchObject({ lead: "stream.auto.refused" });
    expect([stripOf(forced)?.caret, stripOf(forced)?.onBuy]).toEqual([false, undefined]);
    // The EMPTY case: credits only with no refusal stays the heading and the card alone.
    expect(stripOf(body({ view: null, balance: 0, targets: TARGETS, selectedTargetId: "t1" }))).toBeUndefined();
  });

  it("T11 (FP22, owner ruling Q-D): Details carries data used and the app version AFTER the runner's chips, each omitted when null", () => {
    const withData = (dataUsedMB: number | null, appVersion: string | null) =>
      readModel({ phone: facts({ state: "publishing", appVersion, beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB } }) });
    const tree = body({ view: LIVE, balance: 1, phone: withData(1234.5, "1.4.0") });
    expect(textAt(tree, "stream-phone-data-used")).toBe("1,234.5 MB used");
    expect(textAt(tree, "stream-phone-app-version")).toBe("App 1.4.0");
    const runner = allTestIds(tree, "stream-health-chip");
    expect(runner.length, "premise: the runner's chips rendered").toBeGreaterThan(0);
    expect(tree.indexOf(runner.at(-1)!)).toBeLessThan(tree.indexOf(byTestId(tree, "stream-phone-data-used")!));
    expect(tree.indexOf(byTestId(tree, "stream-phone-data-used")!)).toBeLessThan(tree.indexOf(byTestId(tree, "stream-phone-app-version")!));
    expect(tree.indexOf(byTestId(tree, "stream-details")!), "inside Details").toBeLessThan(tree.indexOf(runner[0]!));
    const rows: [string, number | null, string | null, string[]][] = [
      ["no data reading", null, "1.4.0", ["stream-phone-app-version"]],
      ["no app version", 12, null, ["stream-phone-data-used"]],
      ["a real 0 MB", 0, null, ["stream-phone-data-used"]],
      ["neither", null, null, []],
    ];
    let checked = 0;
    for (const [name, mb, v, ids] of rows) {
      const t = body({ view: LIVE, balance: 1, phone: withData(mb, v) });
      expect(["stream-phone-data-used", "stream-phone-app-version"].filter((id) => byTestId(t, id)), name).toEqual(ids);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(textAt(body({ view: LIVE, balance: 1, phone: withData(0, null) }), "stream-phone-data-used")).toBe("0 MB used");
    expect(byTestId(body({ view: session({ state: "ending", startedAt: "2026-09-14T11:50:00Z" }), balance: 1, phone: withData(12, "1.4.0") }), "stream-phone-app-version"), "Ending keeps Details").toBeDefined();
  });

  it("T11 (Q-D): NOT pre-live — with both readings set, no Ready, waiting or summary state shows either chip (nor Details)", () => {
    const data = readModel({ phone: facts({ appVersion: "1.4.0", beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: 245 } }) });
    const rows: [string, ReactElement[]][] = [
      ["ready, paired", body({ ...READY, phone: data })],
      ["ready, paired, the code open", body({ ...READY, phone: data, codeOpen: true, code: { status: "ok", text: CODE_TEXT, image: SYMBOL } })],
      ["provisioning", body({ view: session({ state: "provisioning" }), balance: 2, phone: data })],
      ["warming", body({ view: session(), balance: 2, phone: data })],
      ["ended", body({ view: session({ state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped" }), balance: 1, phone: data })],
    ];
    let checked = 0;
    for (const [name, tree] of rows) {
      for (const id of ["stream-details", "stream-phone-data-used", "stream-phone-app-version"]) expect(byTestId(tree, id), `${name}: ${id}`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  const AT = "2026-09-14T11:32:00.000Z"; // 12:32 in Europe/London (BST), 17:02 in Asia/Kolkata
  const took = (elapsedMs: number, model: string | null = "Pixel 8", at = AT) => readModel({ lastTakeover: { at, model, elapsedMs } });

  it("T12: a takeover inside 30 min — the amber notice with the model and the VENUE's time, after the chain; Stop named only live", () => {
    const ready = body({ ...READY, phone: took(60_000) });
    expect(textAt(ready, "stream-takeover-text")).toBe("The camera moved to another phone (Pixel 8) at 12:32. Not yours? Revoke & reissue");
    expect(attr(byTestId(ready, "stream-takeover")!, "role")).toBe("status");
    expect(ready.indexOf(ready.find((e) => e.type === SignalChain)!)).toBeLessThan(ready.indexOf(byTestId(ready, "stream-takeover")!));
    expect(textAt(body({ ...READY, phone: took(60_000), tz: "Asia/Kolkata" }), "stream-takeover-text"), "the venue's zone").toContain("at 17:02.");
    expect(textAt(body({ ...READY, phone: took(60_000, null) }), "stream-takeover-text")).toBe("The camera moved to another phone at 12:32. Not yours? Revoke & reissue");
    const live = body({ view: LIVE, balance: 1, phone: took(60_000) });
    expect(textAt(live, "stream-takeover-text")).toBe("The camera moved to another phone (Pixel 8) at 12:32. Not yours? Stop the stream, then Revoke & reissue");
    const views: [string, PhoneTabBodyProps["view"], boolean][] = [
      ["ready", null, false], ["provisioning", session({ state: "provisioning" }), false], ["warming", session(), false], ["live", LIVE, true],
    ];
    let checked = 0;
    for (const [name, view, stop] of views) {
      const t = textAt(body({ view, balance: 2, targets: TARGETS, selectedTargetId: "t1", phone: took(60_000) }), "stream-takeover-text");
      expect(t.includes("Stop the stream"), name).toBe(stop);
      checked++;
    }
    expect(checked).toBe(views.length);
  });

  it("T12: the 30-minute window is the SERVER's elapsedMs — 29:59 shown, 30:00 not", () => {
    expect(TAKEOVER_NOTICE_MS).toBe(30 * 60_000);
    expect(byTestId(body({ ...READY, phone: took(30 * 60_000 - 1_000) }), "stream-takeover")).toBeDefined();
    expect(byTestId(body({ ...READY, phone: took(30 * 60_000) }), "stream-takeover")).toBeUndefined();
  });

  it("T12: the X (44px on a phone) dismisses THIS takeover; a dismissed instant hides it; another instant shows again", () => {
    const onDismissTakeover = vi.fn();
    const tree = body({ ...READY, phone: took(60_000), onDismissTakeover });
    const x = byTestId(tree, "stream-takeover-dismiss")!;
    expect([x.type, attr(x, "type"), attr(x, "aria-label")]).toEqual(["button", "button", m("stream.takeover.dismiss")]);
    expect(String(attr(x, "className"))).toMatch(/(^|\s)h-11(\s|$)/);
    click(x);
    expect(onDismissTakeover).toHaveBeenCalledWith(AT);
    expect(byTestId(body({ ...READY, phone: took(60_000), takeoverDismissedAt: AT }), "stream-takeover")).toBeUndefined();
    expect(byTestId(body({ ...READY, phone: took(60_000, "Galaxy S24", "2026-09-14T11:45:00.000Z"), takeoverDismissedAt: AT }), "stream-takeover")).toBeDefined();
  });

  it("T12: no notice where Revoke & reissue is out of reach — credits only, the match over, a legacy session, the ended card", () => {
    const rows: [string, ReactElement[]][] = [
      ["credits only", body({ view: null, balance: 0, phone: took(60_000) })],
      ["the match over", body({ ...READY, phone: { ...MATCH_OVER, lastTakeover: { at: AT, model: "Pixel 8", elapsedMs: 60_000 } } })],
      ["legacy", body({ view: LIVE, balance: 1, phone: { ...LEGACY, lastTakeover: { at: AT, model: "Pixel 8", elapsedMs: 60_000 } } })],
      ["ended", body({ view: session({ state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped" }), balance: 1, phone: took(60_000) })],
    ];
    let checked = 0;
    for (const [name, tree] of rows) {
      expect(byTestId(tree, "stream-takeover"), name).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(rows.length);
  });
});

describe("PhoneTab — fetch, poll, reveal and every action, through the real v1 paths", () => {
  type Server = {
    current: StreamSessionView | null;
    targets: StreamTarget[];
    failCurrent?: boolean;
    /** The destination list's read fails (a network error) while set. */
    failTargets?: boolean;
    create?: () => unknown;
    stop?: () => unknown;
    /** The `stream-phone` read model (T9). Unset: a paired, present phone (Ready's "paired" row). Its `destination` and
     *  `session` are ALWAYS the server's own, from `saved` + `targets` and `current` (see `serve`). */
    phone?: StreamPhone;
    /** The fixture's saved destination row (`fixture_stream_settings`). Unset: none — nobody has chosen. A pick (PUT
     *  stream-settings) writes it, as the route does. A saved id the list does not hold is archived (or not the org's). */
    saved?: { row: false } | { row: true; targetId: string | null };
    /** The read model's read fails while set. */
    failPhone?: boolean;
    /** The read model's `session` — unset: the server's own, from `current`. Set, it names an open session that
     *  `current` does not (yet, or any longer) answer: the lag the I-2 once-per-id guard exists for. */
    openSession?: string | null;
    /** Called with a pick's target before it is saved; a throw is the PUT's failure (a network error, a refusal). */
    failSettings?: (targetId: string | null) => void;
    /** PR-2 T10: the fixture's saved switch (`fixture_stream_settings.auto_stream`) — unset: no row (the read model's
     *  `auto` as `phone` gives it). A PUT `{ autoStream }` writes it, as the route does. */
    autoStream?: boolean;
    /** The switch's PUT fails (a network error) while set. */
    failAuto?: boolean;
    /** The stream-code ensure (T5). Unset: the active code, as the route re-shows it. */
    code?: () => unknown;
    reissue?: () => unknown;
  };
  const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const, phoneLostMinutes: 20, autoStopMinutes: 3, tz: "Europe/London" };
  const CURRENT = "GET /api/v1/fixtures/f-1/stream-sessions/current";
  const PHONE = "GET /api/v1/fixtures/f-1/stream-phone";
  const ENSURE = "POST /api/v1/fixtures/f-1/stream-code";
  const REISSUE = "POST /api/v1/fixtures/f-1/stream-code/reissue";
  const SETTINGS = "PUT /api/v1/fixtures/f-1/stream-settings";

  function serve(s: Server): Server {
    apiV1.mockImplementation(async (url, options) => {
      // Every response lands a TIMER hop later, as a network answer does — never in the same microtask run. Without it a
      // component that re-requests on every answer (a reveal per poll, say) would spin the microtask queue forever and
      // hang the runner instead of failing the count that exists to catch it.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const method = options?.method ?? "GET";
      const key = `${method} ${url}`;
      if (key === CURRENT) {
        if (s.failCurrent) throw new TypeError("Failed to fetch");
        // A fresh object per response, as JSON off the wire is — an identity-keyed effect must not be flattered.
        return s.current === null ? null : structuredClone(s.current);
      }
      if (key === PHONE) {
        if (s.failPhone) throw new TypeError("Failed to fetch");
        // The server's own answers: the destination is `fixtureStreamTarget`'s — the REAL resolver over this fake's saved
        // row and its live list (the list route serves the org's live destinations, oldest first) — and `session` names
        // the open session, whoever started it (I-2).
        const row = s.saved ?? { row: false };
        const saved: SavedStreamTarget = row.row
          ? { row: true, targetId: row.targetId }
          : { row: false };
        const pick = resolveStreamTarget(saved, s.targets);
        const open = s.current !== null && !["completed", "failed"].includes(s.current.state);
        return structuredClone({
          ...(s.phone ?? readModel()),
          destination: pick === null ? null : { id: pick.id, label: pick.label, source: pick.source },
          ...(s.autoStream !== undefined ? { auto: { enabled: s.autoStream, startedAt: null, blocked: false, refusal: null, refusalAt: null } } : {}),
          session: s.openSession !== undefined ? (s.openSession === null ? null : { id: s.openSession }) : open ? { id: s.current!.id } : null,
        });
      }
      if (key === ENSURE) return s.code ? s.code() : { qr: { ...CODE_QR, exp: 1_900_000_000 }, issuedAt: (s.phone ?? readModel()).code?.issuedAt ?? "2026-09-14T11:00:00.000Z" };
      if (key === REISSUE) return s.reissue!();
      if (key === SETTINGS) {
        const json = options?.json as { targetId?: string | null; autoStream?: boolean };
        if (json.autoStream !== undefined) {
          // The PR-2 body names the switch ALONE (the route writes only the fields a PUT names) — the pick is untouched.
          if (s.failAuto) throw new TypeError("Failed to fetch");
          s.autoStream = json.autoStream;
          return { targetId: null, autoStream: json.autoStream };
        }
        const targetId = json.targetId as string | null;
        s.failSettings?.(targetId);
        s.saved = { row: true, targetId };
        return { targetId };
      }
      if (key === "GET /api/v1/orgs/o-1/stream-targets") {
        if (s.failTargets) throw new TypeError("Failed to fetch");
        return structuredClone(s.targets);
      }
      if (key === "POST /api/v1/fixtures/f-1/stream-sessions") return s.create!();
      if (/^POST \/api\/v1\/fixtures\/f-1\/stream-sessions\/[^/]+\/stop$/.test(key)) return s.stop!();
      throw new Error(`unrouted ${key}`);
    });
    return s;
  }
  const calls = (): string[] => apiV1.mock.calls.map(([url, o]) => `${o?.method ?? "GET"} ${url}`);
  const plainPolls = () => calls().filter((c) => c === CURRENT).length;
  const phoneReads = () => calls().filter((c) => c === PHONE).length;
  const ensures = () => calls().filter((c) => c === ENSURE).length;
  /** Eight network hops' worth of time — enough for mount → current → reveal → encode, and every action → refresh. */
  const settle = async () => {
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1);
  };
  async function mount(s: Server) {
    serve(s);
    const island = renderIsland(PhoneTab, TAB);
    await settle();
    return island;
  }
  const bodyOf = (island: { tree: () => ReactElement[] }): PhoneTabBodyProps => {
    const el = island.tree().find((e) => e.type === PhoneTabBody);
    if (!el) throw new Error("no PhoneTabBody in the container's tree");
    return propsOf(el) as unknown as PhoneTabBodyProps;
  };
  /** The lazily loaded checkout sheet, if the container rendered it — found by the `next/dynamic` double's own marker. */
  const lazySheet = (tree: ReactElement[]) => tree.find((el) => lazy.made.some((d) => d.C === el.type));
  let islands: { unmount: () => void }[] = [];
  const track = <T extends { unmount: () => void }>(i: T): T => { islands.push(i); return i; };

  beforeEach(() => {
    vi.useFakeTimers();
    seaznQr.renderSeaznQr.mockClear();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    checkout.fetch.mockReset();
    islands = [];
  });
  afterEach(() => {
    for (const i of islands) i.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("C23: the first commit is the placeholder, and the mount asks the v1 routes by their EXACT paths — and nothing else", async () => {
    serve({ current: null, targets: TARGETS });
    const island = track(renderIsland(PhoneTab, TAB));
    expect(byTestId(island.tree(), "stream-loading"), "the pre-fetch placeholder").toBeDefined();
    // m9: announced, not a bare ellipsis — a status region with real text for a screen reader.
    expect(attr(byTestId(island.tree(), "stream-loading")!, "role")).toBe("status");
    expect(textOf(byTestId(island.tree(), "stream-loading")!)).toContain(m("stream.phone.loading"));
    expect(island.tree().find((el) => el.type === PhoneTabBody)).toBeUndefined();
    expect([...calls()].sort()).toEqual([CURRENT, PHONE, "GET /api/v1/orgs/o-1/stream-targets"].sort());
    await settle();
    expect(byTestId(island.tree(), "stream-loading")).toBeUndefined();
    expect(bodyOf(island).view, "no session: idle").toBeNull();
  });

  it("Task 14b (R4): the container hands the body the page's split and monthly allowance, untouched", async () => {
    serve({ current: null, targets: TARGETS });
    const split = { monthly: 2, pack: 1, total: 3 };
    const island = track(renderIsland(PhoneTab, { ...TAB, streamSplit: split, monthlyAllowance: 5 }));
    await settle();
    expect(bodyOf(island).split).toEqual(split);
    expect(bodyOf(island).monthlyAllowance).toBe(5);
    expect(bodyOf(island).balance, "the chip is still the total").toBe(TAB.streamBalance);
  });

  it("W19: the container hands the body the page's phone-lost window, untouched — a value the default cannot produce", async () => {
    serve({ current: null, targets: TARGETS });
    const island = track(renderIsland(PhoneTab, { ...TAB, phoneLostMinutes: 7 }));
    await settle();
    expect(TAB.phoneLostMinutes, "premise: the default differs").not.toBe(7);
    expect(bodyOf(island).phoneLostMinutes).toBe(7);
  });

  it("C1: no session → the SERVER-resolved balance; a session → its projection's fresher number, which Start another keeps", async () => {
    const idle = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(idle).balance).toBe(TAB.streamBalance);
    // 1, not the page's 3: the right answer differs from the wrong one's constant.
    const done = track(await mount({ current: session({ id: "s0", state: "completed", balance: 1 }), targets: TARGETS }));
    expect(bodyOf(done).balance).toBe(1);
    bodyOf(done).onAgain();
    expect(bodyOf(done).view, "Start another returns the tab to idle").toBeNull();
    expect(bodyOf(done).balance, "…and keeps the fresher balance, not the page-load one").toBe(1);
  });

  // I-1: the review's own case. A restart whose phone never connected failed (no_inbound_timeout) at balance 0, inside
  // the reuse window of the match's paid go-live — admission would waive the credit, so Try again must reach Go live.
  it("I-1: a failed no_inbound_timeout session at balance 0 INSIDE the window → Try again shows Go live and no forced tiles; OUTSIDE → the tiles", async () => {
    const failed = { id: "s2", state: "failed" as const, failReason: "no_inbound_timeout" as const, balance: 0 };
    let checked = 0;
    for (const restart of [{ windowOpen: true, used: 1, limit: 3, free: true }, null]) {
      const windowOpen = restart !== null;
      const island = track(await mount({ current: session({ ...failed, restart }), targets: TARGETS }));
      expect(bodyOf(island).restart, `${windowOpen}: the container hands the projection's answer down`).toEqual(restart);
      expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-retry"), "Try again is on the failed card").toBeDefined();
      bodyOf(island).onAgain();
      const b = bodyOf(island);
      expect(b.view, "Try again returns the tab to idle").toBeNull();
      expect(b.balance, "the projection's balance, kept").toBe(0);
      // …and the answer survives the dismiss: it is the FIXTURE's window, not the dismissed card's.
      expect(b.restart, `${windowOpen}: kept across Try again`).toEqual(restart);
      const tree = walk(expandWithHooks(PhoneTabBody, b));
      if (windowOpen) {
        expect(byTestId(tree, "stream-go-live"), "inside the window: Go live").toBeDefined();
        expect(byTestId(tree, "stream-buy-pack-5"), "inside the window: no forced tiles").toBeUndefined();
        expect(textAt(tree, "stream-restart")).toBe(m("stream.restart.used", { used: 1, limit: 3 }));
      } else {
        expect(byTestId(tree, "stream-go-live"), "outside the window: no Go live").toBeUndefined();
        for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(tree, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("I-1: the balance-0 ENDED card still offers Start another, and it leads to Go live inside the window", async () => {
    const ended = session({ id: "s1", state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true, balance: 0, restart: { windowOpen: true, used: 0, limit: 3, free: true } });
    const island = track(await mount({ current: ended, targets: TARGETS }));
    expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-again"), "Start another at balance 0").toBeDefined();
    bodyOf(island).onAgain();
    const tree = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
    expect(byTestId(tree, "stream-go-live")).toBeDefined();
    expect(byTestId(tree, "stream-buy-pack-5")).toBeUndefined();
    // The go-live it leads to POSTs a create like any other; the server (createSession → reuseWindowOpen) decides.
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled, "a destination is selected").toBeFalsy();
  });

  it("opens at the SERVER's destination — with nothing saved, the oldest (created_at order, as the route returns it); no destination → none selected; nothing is written", async () => {
    const two = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(two).selectedTargetId).toBe("t1");
    expect(calls(), "opening the panel saves no choice").not.toContain(SETTINGS);
    expect(listOf(bodyOf(two).targets).map((t) => t.id)).toEqual(["t1", "t2"]);
    const none = track(await mount({ current: null, targets: [] }));
    expect(bodyOf(none).selectedTargetId).toBeNull();
  });

  it("Go live POSTs the SELECTED destination as passthrough, then shows the server's state", async () => {
    const s = serve({ current: null, targets: TARGETS });
    s.create = () => { s.current = session(); return { sessionId: "s1" }; };
    const island = track(await mount(s));
    bodyOf(island).onSelectTarget("t2");
    bodyOf(island).onGoLive();
    await settle();
    const post = apiV1.mock.calls.find(([url, o]) => url === "/api/v1/fixtures/f-1/stream-sessions" && o?.method === "POST");
    expect(post?.[1]?.json).toEqual({ mode: "passthrough", targetId: "t2" });
    expect(bodyOf(island).view?.state).toBe("warming");
    expect(bodyOf(island).createError).toBeNull();
  });

  it("§6.12 polling: the read model is read at mount and every STREAM_POLL_MS while the tab is open — at idle too, where `current` rests — and never after it closes", async () => {
    const island = track(await mount({ current: null, targets: TARGETS }));
    expect(phoneReads(), "the mount's read").toBe(1);
    const currentBefore = plainPolls();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 3);
    await settle();
    expect(phoneReads(), "three polls at idle").toBe(4);
    expect(plainPolls() - currentBefore, "PREMISE: `current` does not poll at idle — the read model's poll is its own").toBe(0);
    island.unmount();
    islands = islands.filter((i) => i !== island);
    const after = phoneReads();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 2);
    expect(phoneReads(), "nothing polls behind a closed tab").toBe(after);
  });

  it("the body waits for the read model's first answer (a Ready drawn before it would flash 'no phone' at a paired one); a FAILED first read still lets it render", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    serve({ current: null, targets: TARGETS });
    const inner = apiV1.getMockImplementation()!;
    apiV1.mockImplementation(async (url, o) => {
      if (url === "/api/v1/fixtures/f-1/stream-phone") await gate;
      return inner(url, o);
    });
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(byTestId(island.tree(), "stream-loading"), "current answered; the read model has not").toBeDefined();
    release();
    await settle();
    expect(bodyOf(island).phone?.phone?.present).toBe(true);
    const failed = track(await mount({ current: null, targets: TARGETS, failPhone: true }));
    expect(byTestId(failed.tree(), "stream-loading")).toBeUndefined();
    expect(bodyOf(failed).phone, "no answer yet: the body reads no phone").toBeNull();
  });

  it("the code is asked for LAZILY: paired → never; opening 'Show the code again' → once; no phone → once at mount; legacy and match-over → never", async () => {
    const paired = track(await mount({ current: null, targets: TARGETS }));
    expect(ensures(), "paired and folded: no code asked").toBe(0);
    expect(bodyOf(paired).code).toEqual({ status: "loading" });
    bodyOf(paired).onToggleCode(true);
    await settle();
    expect(ensures(), "opened: one ensure").toBe(1);
    expect(bodyOf(paired).code).toMatchObject({ status: "ok", text: CODE_TEXT });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 2);
    await settle();
    expect(ensures(), "polls never re-ask an answered code").toBe(1);
    apiV1.mockClear();
    track(await mount({ current: null, targets: TARGETS, phone: readModel({ phone: null }) }));
    expect(ensures(), "no phone: the card asks at once").toBe(1);
    let checked = 0;
    for (const [name, phone, current] of [
      ["legacy", LEGACY, session({ state: "live", startedAt: "2026-09-14T11:50:00Z" })],
      ["match over", MATCH_OVER, null],
    ] as const) {
      apiV1.mockClear();
      const island = track(await mount({ current, targets: TARGETS, phone }));
      bodyOf(island).onToggleCode(true);
      await settle();
      expect(ensures(), name).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("W3: the code is encoded CLIENT-side from its own text — exactly the four keys, never the route's `exp` — once per text; Copy writes that text", async () => {
    const island = track(await mount({ current: null, targets: TARGETS, phone: readModel({ phone: null }) }));
    expect(seaznQr.renderSeaznQr.mock.calls).toEqual([[CODE_TEXT]]);
    expect(Object.keys(JSON.parse(seaznQr.renderSeaznQr.mock.calls[0]![0]))).toEqual(["v", "code", "slot", "tok"]);
    expect(bodyOf(island).code).toEqual({ status: "ok", text: CODE_TEXT, image: { src: `data:image/svg+xml;charset=utf-8,len${CODE_TEXT.length}`, modules: 113 } });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 2);
    await settle();
    expect(seaznQr.renderSeaznQr, "the same text was re-encoded per poll").toHaveBeenCalledTimes(1);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    bodyOf(island).onCopy();
    await settle();
    expect(writeText).toHaveBeenCalledWith(CODE_TEXT);
    expect(bodyOf(island).copied).toBe(true);
    expect(calls().some((c) => /reveal/.test(c)), "no reveal is ever asked").toBe(false);
  });

  it("m5: a clipboard that REFUSES is not 'Copied'", async () => {
    const island = track(await mount({ current: null, targets: TARGETS, phone: readModel({ phone: null }) }));
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => { throw new Error("NotAllowedError"); });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    bodyOf(island).onCopy();
    await settle();
    expect(writeText, "the copy was attempted").toHaveBeenCalledTimes(1);
    expect(bodyOf(island).copied).toBe(false);
  });

  it("a code reissued elsewhere (the read model names a newer one) is asked for ONCE — and the same stale answer never asks again; an expired code on a reverted match is re-minted once", async () => {
    const s = serve({ current: null, targets: TARGETS, phone: readModel({ phone: null }) });
    const island = track(await mount(s));
    expect(ensures()).toBe(1);
    const NEW = CaptureQrV2.parse({ v: 2, code: "m3n4p5q6r7s8", slot: 0, tok: "Zz9_Yy8-Xx7Ww6Vv5Uu4Tt" });
    s.phone = readModel({ phone: null, code: { issuedAt: "2026-09-14T11:30:00.000Z", state: "active", endCause: null } });
    s.code = () => ({ qr: NEW, issuedAt: "2026-09-14T11:30:00.000Z" });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(ensures(), "the newer code, asked once").toBe(2);
    expect(bodyOf(island).code).toMatchObject({ status: "ok", text: captureQrV2Text(NEW) });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 2);
    await settle();
    expect(ensures(), "now in step: no more asks").toBe(2);
    // C5: the shown code expired and the result was reverted (finished false) — Ready mints again, once.
    s.phone = readModel({ phone: null, code: { issuedAt: "2026-09-14T11:30:00.000Z", state: "ended", endCause: "expired" } });
    s.code = () => ({ qr: CODE_QR, issuedAt: "2026-09-14T12:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(ensures()).toBe(3);
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(ensures(), "the same ended answer does not spin the ensure").toBe(3);
  });

  // B8 review m-6 (K6): the re-ask's `!finished` is reachable only here — the fold open on an Ended card, past C2's grace.
  // The code expired BECAUSE the match is over: asking again would only meet ensure's 422 and turn the card into an error.
  it("K6: the code fold open on an ENDED card when the code expires on a FINISHED match — the code is NOT asked for again", async () => {
    const issuedAt = "2026-09-14T09:00:00.000Z";
    const ended = session({ id: "s0", state: "completed", startedAt: "2026-09-14T09:10:00Z", endedAt: "2026-09-14T10:40:00Z", endReason: "stopped", creditUsed: true });
    const s = serve({ current: ended, targets: TARGETS, phone: readModel({ finished: true, code: { issuedAt, state: "finishing", endCause: null } }) });
    const island = track(await mount(s));
    expect(ensures(), "PREMISE: a code is asked for only when the fold opens").toBe(0);
    bodyOf(island).onToggleCode(true);
    await settle();
    expect(ensures()).toBe(1);
    expect(bodyOf(island).code).toMatchObject({ status: "ok" });
    // C2's grace runs out: the code ends `expired` — on a match that is still finished.
    s.phone = readModel({ finished: true, code: { issuedAt, state: "ended", endCause: "expired" } });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(phoneReads(), "PREMISE: the read model was read again").toBeGreaterThanOrEqual(2);
    expect(ensures(), "the match is over: no second ask").toBe(1);
    // The positive pair: the result REVERTED (not finished) — the same ended code is re-minted, once.
    s.phone = readModel({ finished: false, code: { issuedAt, state: "ended", endCause: "expired" } });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(ensures()).toBe(2);
  });

  it("Revoke & reissue asks the house confirm (danger, §6.12's copy) and POSTs reissue, showing the NEW code; declined, nothing is sent", async () => {
    const NEW = CaptureQrV2.parse({ v: 2, code: "m3n4p5q6r7s8", slot: 0, tok: "Zz9_Yy8-Xx7Ww6Vv5Uu4Tt" });
    const s = serve({ current: null, targets: TARGETS, phone: readModel({ phone: null }) });
    s.reissue = () => ({ qr: NEW, issuedAt: "2026-09-14T11:40:00.000Z" });
    const island = track(await mount(s));
    confirmMock.mockResolvedValueOnce(false);
    bodyOf(island).onReissue();
    await settle();
    expect(calls()).not.toContain(REISSUE);
    expect(confirmMock).toHaveBeenCalledWith({
      title: m("stream.code.reissue.confirm.title"), body: m("stream.code.reissue.confirm.body"),
      confirmLabel: m("stream.code.reissue.confirm.button"), tone: "danger", size: "touch",
    });
    expect(m("stream.code.reissue.confirm.title")).toBe("Make a new code?");
    bodyOf(island).onReissue();
    await settle();
    expect(calls().filter((c) => c === REISSUE)).toHaveLength(1);
    expect(bodyOf(island).code).toMatchObject({ status: "ok", text: captureQrV2Text(NEW) });
    // A refused reissue says so, with Retry (which re-shows whatever code is current).
    s.reissue = () => { throw new ApiV1Error("the match is over", 422, "fixture_finished"); };
    bodyOf(island).onReissue();
    await settle();
    expect(bodyOf(island).code).toEqual({ status: "error" });
    bodyOf(island).onRetryCode();
    await settle();
    expect(bodyOf(island).code).toMatchObject({ status: "ok" });
  });

  it("§6.7.3: a pick writes the fixture's pre-pick (PUT stream-settings); the saved pre-pick is what the picker opens at until the organiser picks", async () => {
    const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId, "the saved pre-pick, not the oldest").toBe("t2");
    expect(calls(), "opening writes nothing").not.toContain(SETTINGS);
    bodyOf(island).onSelectTarget("t1");
    await settle();
    const put = apiV1.mock.calls.find(([url, o]) => url === "/api/v1/fixtures/f-1/stream-settings" && o?.method === "PUT");
    expect(put?.[1]?.json).toEqual({ targetId: "t1" });
    expect(bodyOf(island).selectedTargetId, "the organiser's pick outranks the saved one").toBe("t1");
    // B8 review I-1 (replaces "the list's own choice stands", which froze the divergence): a saved choice that is not
    // listed — archived in Directory — is NONE, exactly as the phone's start answers it (409 no_destination). The picker
    // is empty and Go live is held; the oldest is NOT put in its place.
    const gone = track(await mount({ current: null, targets: TARGETS, saved: { row: true, targetId: "t9" } }));
    expect(bodyOf(gone).selectedTargetId).toBeNull();
    const shown = walk(expandWithHooks(PhoneTabBody, bodyOf(gone)));
    expect(attr(byTestId(shown, "stream-target")!, "value"), "the placeholder").toBe("");
    expect(propsOf(byTestId(shown, "stream-go-live")!).disabled, "Go live held").toBe(true);
  });

  // B8 re-review n-5: the pick's PUT is what makes the phone's start agree with the picker (§17.13). A save that fails
  // must not leave the picker showing a choice the server never took: it goes back to the server's answer — what the
  // phone streams to — and says so. A later pick that saves clears it; a failure for a pick already replaced is moot.
  it("n-5: a pick whose save FAILS is not kept as if saved — the picker returns to the server's answer and says so (alert); a later pick that saves clears it", async () => {
    let checked = 0;
    for (const [name, fail] of [
      ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
      ["a server refusal", () => { throw new ApiV1Error("boom", 500, "internal"); }],
    ] as const) {
      const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
      const island = track(await mount(s));
      expect(bodyOf(island).selectedTargetId, `${name}: PREMISE — the saved pre-pick`).toBe("t2");
      expect(bodyOf(island).pickFailed, `${name}: no error before a pick`).toBe(false);
      s.failSettings = fail;
      bodyOf(island).onSelectTarget("t1");
      await settle();
      expect(calls().filter((c) => c === SETTINGS).length, `${name}: PREMISE — the save was attempted`).toBeGreaterThanOrEqual(1);
      expect(s.saved, `${name}: the server still holds t2`).toEqual({ row: true, targetId: "t2" });
      expect(bodyOf(island).selectedTargetId, `${name}: back to what the phone streams to`).toBe("t2");
      expect(bodyOf(island).pickFailed, name).toBe(true);
      let shown = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(textAt(shown, "stream-pick-error"), `${name}: said, visibly`).toBe(m("stream.dest.pickFailed"));
      expect(attr(byTestId(shown, "stream-pick-error")!, "role")).toBe("alert");
      // The next poll keeps the server's answer — the failed pick does not come back.
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(bodyOf(island).selectedTargetId, `${name}: after a poll`).toBe("t2");
      // The positive pair: the save works again — the pick stands, the server holds it, and the line goes.
      s.failSettings = undefined;
      bodyOf(island).onSelectTarget("t1");
      await settle();
      expect(s.saved).toEqual({ row: true, targetId: "t1" });
      expect(bodyOf(island).selectedTargetId, `${name}: the saved pick`).toBe("t1");
      expect(bodyOf(island).pickFailed, `${name}: cleared`).toBe(false);
      shown = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(byTestId(shown, "stream-pick-error"), `${name}: the line is gone`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("n-5, the sequence: a failure that lands after the organiser already picked again is moot — the newer pick stands, saved, with no error", async () => {
    const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
    s.failSettings = (id) => { if (id === "t1") throw new TypeError("Failed to fetch"); };
    const island = track(await mount(s));
    bodyOf(island).onSelectTarget("t1");   // will fail
    bodyOf(island).onSelectTarget("t2");   // picked again before the failure lands; this one saves
    await settle();
    expect(calls().filter((c) => c === SETTINGS).length, "PREMISE — both saves were attempted").toBe(2);
    expect(s.saved).toEqual({ row: true, targetId: "t2" });
    expect(bodyOf(island).selectedTargetId).toBe("t2");
    expect(bodyOf(island).pickFailed, "the failure was about a pick already replaced").toBe(false);
  });

  // B8 final re-review n-6 (the reviewer's probe, made permanent): the "couldn't save" alert is about the server not
  // holding the pick. It goes when that stops being news — the server's answer CHANGES (saved from another device or
  // tab), or a Go live succeeds (the start saves its destination) — and never comes back at Ready after the session.
  it("n-6: the pick-failure alert clears when the server's answer CHANGES (not on a poll that answers the same), and on a Go live that succeeds — and is not back at Ready after Stop and Start another", async () => {
    let checked = 0;
    // 1. The server's answer moves to the very destination the failed pick wanted (another device saved it).
    {
      const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
      s.failSettings = () => { throw new TypeError("Failed to fetch"); };
      const island = track(await mount(s));
      bodyOf(island).onSelectTarget("t1");
      await settle();
      expect([bodyOf(island).selectedTargetId, bodyOf(island).pickFailed], "PREMISE — the failed pick").toEqual(["t2", true]);
      // A poll that answers the SAME keeps the alert: nothing the organiser was told has changed.
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect([bodyOf(island).selectedTargetId, bodyOf(island).pickFailed], "the same answer: still said").toEqual(["t2", true]);
      s.saved = { row: true, targetId: "t1" };
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(bodyOf(island).selectedTargetId, "the server's new answer").toBe("t1");
      expect(bodyOf(island).pickFailed, "the answer changed: the alert goes").toBe(false);
      expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-pick-error")).toBeUndefined();
      checked++;
    }
    // 2. Go live on the server's answer succeeds, then Stop and Start another: Ready shows no stale alert.
    {
      const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
      s.failSettings = () => { throw new TypeError("Failed to fetch"); };
      s.create = () => { s.current = session({ id: "s1" }); s.saved = { row: true, targetId: "t2" }; return { sessionId: "s1" }; };
      s.stop = () => {
        s.current = session({ id: "s1", state: "completed", startedAt: "2026-09-14T11:50:00Z", endedAt: "2026-09-14T11:58:00Z", endReason: "stopped", creditUsed: true });
        return s.current;
      };
      const island = track(await mount(s));
      bodyOf(island).onSelectTarget("t1");
      await settle();
      expect([bodyOf(island).selectedTargetId, bodyOf(island).pickFailed], "PREMISE — the failed pick").toEqual(["t2", true]);
      bodyOf(island).onGoLive();
      await settle();
      expect(bodyOf(island).view?.state, "PREMISE — the session is up").toBe("warming");
      expect(bodyOf(island).pickFailed, "Go live succeeded: the alert goes").toBe(false);
      s.current = session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      bodyOf(island).onStop();
      await settle();
      expect(bodyOf(island).view?.state, "PREMISE — the Ended card").toBe("completed");
      bodyOf(island).onAgain();
      await settle();
      const ready = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(byTestId(ready, "stream-target"), "PREMISE — Ready, the picker shown").toBeDefined();
      expect(byTestId(ready, "stream-pick-error"), "no stale alert at Ready").toBeUndefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  // B8 review I-1 (controller ruling, §17.13): what the organiser sees is what streams. For EVERY row of THE table the
  // picker shows the row's answer — the target the phone's start opens on (stream-target-agreement.test.ts proves the
  // server half: read model == descriptor == start) — and Go live is held exactly on the rows whose answer is none.
  it("§17.13 agreement: for every row of the destination table the panel's selection IS the admission target, and Go live is held on none", async () => {
    const ID = { A: "t1", B: "t2" } as const;
    let checked = 0;
    for (const row of STREAM_TARGET_TABLE) {
      const targets = row.live.map((n) => TARGETS[n === "A" ? 0 : 1]!);
      const newest = targets[targets.length - 1]?.id ?? "t-ghost";
      const saved =
        row.saved === "none" ? { row: false as const }
        : row.saved === "cleared" ? { row: true as const, targetId: null }
        : row.saved === "live" ? { row: true as const, targetId: newest }
        : { row: true as const, targetId: row.saved === "archived" ? "t-archived" : "t-other-org" };
      apiV1.mockClear();
      const island = track(await mount({ current: null, targets, saved }));
      const want = row.expect === null ? null : ID[row.expect.pick];
      expect(bodyOf(island).selectedTargetId, rowName(row)).toBe(want);
      const shown = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(Boolean(propsOf(byTestId(shown, "stream-go-live")!).disabled), `${rowName(row)}: Go live held iff none`).toBe(want === null);
      expect(calls(), `${rowName(row)}: nothing written`).not.toContain(SETTINGS);
      checked++;
    }
    expect(checked).toBe(STREAM_TARGET_TABLE_ROWS);
  });

  // B8 review I-1, probe (a), kept: n1 acts on what is SHOWN. A saved pre-pick archived in Directory leaves the picker
  // empty — never the oldest, which nobody chose — through the tab return AND the read model's next answer.
  it("I-1 probe (a): a SHOWN pre-pick archived in Directory → a tab return and a phone poll leave the picker EMPTY and Go live held — never the oldest", async () => {
    const { doc } = stubPage();
    const s = serve({ current: null, targets: TARGETS, saved: { row: true, targetId: "t2" } });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId, "PREMISE: the saved pre-pick is shown").toBe("t2");
    s.targets = [TARGETS[0]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "after the return").toBeNull();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(bodyOf(island).selectedTargetId, "after the next phone poll").toBeNull();
    expect(propsOf(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-go-live")!).disabled).toBe(true);
  });

  // B8 review I-1, probe (b), kept: the in-use lift acts on what is SHOWN. A refusal about the shown pre-pick (held by
  // another match) stays across a return that finds it STILL held — the free oldest is not what is shown.
  it("I-1 probe (b): target_in_use on the SHOWN pre-pick survives a return while it is still held; freed, it lifts", async () => {
    const { doc } = stubPage();
    const holder = { sessionId: "s9", fixtureId: "f-9", href: "/x/f/5", matchNo: 5, courtName: "Court 1", state: "live" as const };
    const held = { ...TARGETS[1]!, inUse: holder };
    const s = serve({ current: null, targets: [TARGETS[0]!, held], saved: { row: true, targetId: "t2" } });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId, "PREMISE: the held pre-pick is shown").toBe("t2");
    s.create = () => { throw new ApiV1Error("in use", 409, "target_in_use", { holder: { ...holder, label: "Alt" } }); };
    bodyOf(island).onGoLive();
    await settle();
    expect(apiV1.mock.calls.some(([u, o]) => o?.method === "POST" && /stream-sessions$/.test(u) && (o.json as { targetId?: string }).targetId === "t2"), "Go live sent the SHOWN destination").toBe(true);
    expect(bodyOf(island).createError?.code).toBe("target_in_use");
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).createError?.code, "still held: the refusal stands").toBe("target_in_use");
    s.targets = TARGETS;
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).createError, "freed: lifted").toBeNull();
    expect(bodyOf(island).selectedTargetId).toBe("t2");
  });

  // B8 review I-2 (ruling: fix it). `current` rests at Ready and on an Ended card (terminal: no poll), and T8 made the
  // paired PHONE a starter — so the read model names the open session, and the tab reads `current` for one it does not
  // show. Without it the organiser watched "Paired · Go live" while the phone was warming, and Go live met active_session.
  it("I-2: a session the PHONE starts while the tab sits at Ready — or on an Ended card — is shown within one poll: warming, then live, no stale Go live, `current` read ONCE for it", async () => {
    const CREATE = "POST /api/v1/fixtures/f-1/stream-sessions";
    let checked = 0;
    for (const [name, start] of [
      ["Ready, paired", null],
      ["an Ended card", session({ id: "s0", state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true })],
    ] as const) {
      apiV1.mockClear();
      const s = serve({ current: start, targets: TARGETS });
      // Not tracked: unmounted at the end of its case, so its own (now live) poll never lands in the next case's count.
      const island = await mount(s);
      const before = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      if (start === null) {
        expect(propsOf(byTestId(before, "stream-go-live")!).disabled, `${name}: PREMISE — Go live offered`).toBeFalsy();
      } else {
        expect(byTestId(before, "stream-again"), `${name}: PREMISE — the Ended card`).toBeDefined();
      }
      // Nothing changes on the server: the read model's next poll reads `current` for nothing.
      const quiet = plainPolls();
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(plainPolls() - quiet, `${name}: no session opened — no read`).toBe(0);
      // The phone's own start (T8): the server opens an OPERATOR session.
      s.current = session({ id: "s-phone", state: "warming", startCause: "operator" });
      const polls = plainPolls();
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(plainPolls() - polls, `${name}: \`current\` read once for the new id`).toBe(1);
      expect(bodyOf(island).view?.id, name).toBe("s-phone");
      expect(bodyOf(island).view?.state, name).toBe("warming");
      const after = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(byTestId(after, "stream-go-live"), `${name}: no stale Go live`).toBeUndefined();
      expect(byTestId(after, "stream-again"), `${name}: no stale Ended card`).toBeUndefined();
      expect(calls().filter((c) => c === CREATE), `${name}: nothing tapped, nothing refused`).toEqual([]);
      // …and it goes LIVE on the panel too: the in-flight session is polled like the organiser's own.
      s.current = session({ id: "s-phone", state: "live", startCause: "operator", startedAt: "2026-09-14T11:58:00Z" });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(bodyOf(island).view?.state, `${name}: live`).toBe("live");
      const live = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
      expect(byTestId(live, "stream-stop"), `${name}: Stop, the live control`).toBeDefined();
      expect(byTestId(live, "stream-go-live"), `${name}: still no stale Go live`).toBeUndefined();
      expect(calls().filter((c) => c === CREATE), `${name}: still nothing refused`).toEqual([]);
      island.unmount();
      checked++;
    }
    expect(checked).toBe(2);
  });

  // B8 re-review P1: the I-2 effect reads `current` ONCE per open id. `view.id` alone stops the second read only once
  // `current` answers that id; until it does — a lag, or a session already gone by the time it is asked — every phone
  // poll would ask again. The ref is what holds it to one.
  it("I-2's once-per-id guard: while `current` keeps answering something else for the read model's open id — nothing at Ready, the old Ended card — it is read ONCE for that id across several polls; a NEW id is read once more", async () => {
    const POLLS = 4;
    let checked = 0;
    for (const [name, start] of [
      ["Ready, paired", null],
      ["an Ended card", session({ id: "s0", state: "completed", startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true })],
    ] as const) {
      apiV1.mockClear();
      const s = serve({ current: start, targets: TARGETS });
      // Not tracked: unmounted at the end of its case, so its poll never lands in the next case's count.
      const island = await mount(s);
      for (const id of ["s-phone", "s-phone-2"]) {
        s.openSession = id;   // the read model names it; `current` keeps answering `start`
        const polls = plainPolls();
        const reads = phoneReads();
        for (let i = 0; i < POLLS; i++) {
          await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
          await settle();
        }
        expect(phoneReads() - reads, `${name}, ${id}: PREMISE — the read model was polled every time`).toBeGreaterThanOrEqual(POLLS);
        expect(plainPolls() - polls, `${name}, ${id}: \`current\` read ONCE across ${POLLS} polls`).toBe(1);
        expect(bodyOf(island).view?.id ?? null, `${name}, ${id}: \`current\`'s own answer is shown`).toBe(start?.id ?? null);
        checked++;
      }
      island.unmount();
    }
    expect(checked).toBe(4);
  });

  it("§8a's encoding settings are the helper's: EC-H, a 4-module quiet zone, and the Seazn logo (amended 2026-09-30, D7)", () => {
    const sheet = readFileSync(SHEET_PATH, "utf8");
    const row = sheet.split("\n").find((l) => l.startsWith("| QR encoding |"));
    expect(row, "§8a lost its QR encoding row").toBeDefined();
    expect(row!).toContain(`EC-${SEAZN_QR_ERROR_CORRECTION} with a ${SEAZN_QR_QUIET_MODULES}-module quiet zone`);
    expect(row!).toMatch(/Seazn logo/);
    expect(SEAZN_QR_ERROR_CORRECTION).toBe("H"); // spec §7, the rulebook
    expect(SEAZN_QR_QUIET_MODULES).toBe(4); // §7.6's quiet zone, unchanged by the amendment
  });

  it("polls while a session is in flight and STOPS once it is terminal — nothing polls behind an ended card", async () => {
    const s = { current: session({ state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS };
    const island = track(await mount(s));
    s.current = session({ state: "completed" });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(bodyOf(island).view?.state).toBe("completed");
    const settled = plainPolls();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 3);
    await settle();
    expect(plainPolls(), "a terminal session is still being polled").toBe(settled);
  });

  it("refusals: target_in_use carries the holder (D12); a plan refusal from CREATE is the switched-off state (I4), never a retry", async () => {
    const s = serve({ current: null, targets: TARGETS });
    // T3: the wire holder names the match (stream-target-holders.ts wireHolder); `waiting` so the state is read, not defaulted.
    s.create = () => {
      throw new ApiV1Error("in use", 409, "target_in_use", {
        holder: { fixtureId: "f-9", href: "/o/a/c/b/d/c/f/4", matchNo: 4, courtName: "Court 3", label: "Club", state: "waiting" },
      });
    };
    const inUse = track(await mount(s));
    bodyOf(inUse).onGoLive();
    await settle();
    expect(bodyOf(inUse).createError).toEqual({
      code: "target_in_use", holder: { courtName: "Court 3", label: "Club", matchNo: 4, href: "/o/a/c/b/d/c/f/4", state: "waiting" },
    });

    const plan = serve({ current: null, targets: TARGETS });
    plan.create = () => { throw new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature: "x", feature_key: "streaming.relay", reason: "This feature needs a plan upgrade." }); };
    const gated = track(await mount(plan));
    bodyOf(gated).onGoLive();
    await settle();
    expect(byTestId(gated.tree(), "stream-switched-off"), "the plan refusal is not the switched-off state").toBeDefined();
    expect(gated.tree().find((el) => el.type === PhoneTabBody)).toBeUndefined();
  });

  it("after Start another, a refused create SHOWS its refusal — the refresh must not resurrect the dismissed card over it", async () => {
    const s = serve({ current: session({ id: "s0", state: "completed", balance: 0 }), targets: TARGETS });
    s.create = () => { throw new ApiV1Error("no credits", 402, "no_credits", { featureKey: "streaming.relay" }); };
    const island = track(await mount(s));
    bodyOf(island).onAgain();
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).view, "the old session came back over the refusal").toBeNull();
    expect(bodyOf(island).createError).toEqual({ code: "no_credits", holder: null });
    // An active_session refusal is the other way round: the running session IS the answer, so it is shown.
    const running = session({ id: "s9", state: "live", startedAt: "2026-09-14T11:50:00Z" });
    const busy = serve({ current: null, targets: TARGETS });
    busy.create = () => { busy.current = running; throw new ApiV1Error("busy", 409, "active_session", { sessionId: "s9" }); };
    const other = track(await mount(busy));
    bodyOf(other).onGoLive();
    await settle();
    expect(bodyOf(other).view?.id).toBe("s9");
  });

  it("m2: a no_credits refusal opens the chooser and reads the balance as 0 here — the page's stale number is not believed", async () => {
    const s = serve({ current: null, targets: TARGETS });
    s.create = () => { throw new ApiV1Error("no credits", 402, "no_credits", { featureKey: "streaming.relay" }); };
    const island = track(await mount(s));
    expect(bodyOf(island).balance, "premise: the page said 3").toBe(TAB.streamBalance);
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).balance).toBe(0);
    expect(bodyOf(island).showBuy).toBe(true);
    expect(bodyOf(island).createError).toEqual({ code: "no_credits", holder: null });
    // Any OTHER refusal leaves both alone.
    const other = serve({ current: null, targets: TARGETS });
    other.create = () => { throw new ApiV1Error("full", 409, "storage_exhausted"); };
    const kept = track(await mount(other));
    bodyOf(kept).onGoLive();
    await settle();
    expect(bodyOf(kept).balance).toBe(TAB.streamBalance);
    expect(bodyOf(kept).showBuy).toBe(false);
  });

  it("I1: a 402 at checkout while a session is UP never replaces the tab — the body keeps Stop and shows the gate; at idle it still does", async () => {
    checkout.fetch.mockResolvedValueOnce({ ok: false, error: "plan_lacks_relay", status: 402 });
    const s = serve({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onShowBuy();
    bodyOf(island).onBuy(5);
    await settle();
    expect(byTestId(island.tree(), "stream-switched-off"), "the refusal replaced a live tab").toBeUndefined();
    const b = bodyOf(island);
    expect(b.planGate).toBe(true);
    expect(b.view?.state).toBe("live");
    // Folded through the REAL body: what the container handed it renders Stop and the gate together.
    const rendered = walk(expandWithHooks(PhoneTabBody, b));
    expect(byTestId(rendered, "stream-stop"), "Stop is gone").toBeDefined();
    expect(byTestId(rendered, "stream-plan-gate")).toBeDefined();
    // …and once the session ends and the organiser starts another, idle has nothing to protect: the gate IS the tab.
    // N5: the session ends the way it really does — the SERVER serves it completed and the next poll reads it; Start
    // another is only offered on an ended card, so it is pressed from there, never from a live one.
    s.current = session({ id: "s1", state: "completed", startedAt: "2026-09-14T11:50:00Z", endedAt: "2026-09-14T11:58:00Z", endReason: "stopped", creditUsed: true });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(bodyOf(island).view?.state, "the poll read the ended session").toBe("completed");
    expect(byTestId(island.tree(), "stream-switched-off"), "an ended card is still a session to show").toBeUndefined();
    expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-again"), "Start another is on the ended card").toBeDefined();
    bodyOf(island).onAgain();
    expect(byTestId(island.tree(), "stream-switched-off"), "idle + a plan refusal is the switched-off state").toBeDefined();
  });

  it("B6: Buy more and Close are one toggle, and closing drops a stale checkout refusal", async () => {
    checkout.fetch.mockResolvedValueOnce({ ok: false, error: "no", status: 403 });
    const island = track(await mount({ current: null, targets: TARGETS }));
    bodyOf(island).onShowBuy();
    expect(bodyOf(island).showBuy).toBe(true);
    bodyOf(island).onBuy(5);
    await settle();
    expect(bodyOf(island).checkoutError).toBe("owner");
    bodyOf(island).onShowBuy();
    expect(bodyOf(island).showBuy).toBe(false);
    expect(bodyOf(island).checkoutError, "a closed chooser's refusal came back with the next one").toBeNull();
  });

  it("Stop asks the repo's confirm dialog (danger) and POSTs THIS session's stop; a declined confirm sends nothing", async () => {
    const s = serve({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    s.stop = () => session({ id: "s1", state: "ending" });
    const island = track(await mount(s));
    confirmMock.mockResolvedValueOnce(false);
    bodyOf(island).onStop();
    await settle();
    expect(calls().some((c) => c.endsWith("/stop")), "a declined confirm stopped the stream").toBe(false);
    bodyOf(island).onStop();
    await settle();
    expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({ title: m("stream.phone.stop.title"), body: m("stream.phone.stop.body"), confirmLabel: m("stream.phone.stop"), tone: "danger" }));
    // P3/P4 (fix round 3): the page-locale "Keep streaming" (never the cookie's English "Cancel") and 44-px buttons.
    expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining(STOP_CONFIRM_EXTRAS));
    expect((confirmMock.mock.lastCall![0] as { cancelLabel?: unknown }).cancelLabel, "the key exists and is not the confirm's own label").toBe("Keep streaming");
    expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
    expect(bodyOf(island).view?.state).toBe("ending");
  });

  it("m3: Cancel re-reads FIRST — still warming stops with no confirm; already LIVE is the confirming stop; ended does nothing", async () => {
    const STOP = "POST /api/v1/fixtures/f-1/stream-sessions/s1/stop";
    // Every branch below shares the transport double, so each counts ITS OWN stops from a baseline.
    const stops = () => calls().filter((c) => c === STOP).length;
    // Still warming: nothing is on air, so no confirm — but the read came before the stop.
    const s = serve({ current: session({ id: "s1" }), targets: TARGETS });
    s.stop = () => session({ id: "s1", state: "completed" });
    const warm = track(await mount(s));
    const before = calls().length;
    bodyOf(warm).onCancel();
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    const after = calls().slice(before);
    expect(after, "no stop was sent").toContain(STOP);
    expect(after.filter((c) => c === CURRENT).length, "Cancel did not re-read").toBeGreaterThanOrEqual(1);
    expect(after.indexOf(CURRENT), "the read came after the stop").toBeLessThan(after.indexOf(STOP));

    // The phone connected while the QR was on screen: the SAME tap is now a live stop, and asks.
    const went = serve({ current: session({ id: "s1" }), targets: TARGETS });
    went.stop = () => session({ id: "s1", state: "ending" });
    const live = track(await mount(went));
    went.current = session({ id: "s1", state: "live", startedAt: "2026-09-14T11:59:00Z" });
    confirmMock.mockResolvedValueOnce(false);
    let base = stops();
    bodyOf(live).onCancel();
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger", title: m("stream.phone.stop.title"), ...STOP_CONFIRM_EXTRAS }));
    expect(stops() - base, "a declined confirm still stopped a live stream").toBe(0);
    expect(bodyOf(live).view?.state, "the card shows what the read found").toBe("live");

    // The read fails: nobody knows whether it is on air, so it is the confirming stop.
    const blind = serve({ current: session({ id: "s1" }), targets: TARGETS });
    blind.stop = () => session({ id: "s1", state: "ending" });
    const unknown = track(await mount(blind));
    blind.failCurrent = true;
    confirmMock.mockClear();
    base = stops();
    bodyOf(unknown).onCancel();
    await settle();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(stops() - base).toBe(1);

    // It already ended (it timed out): nothing to stop, nothing asked.
    const gone = serve({ current: session({ id: "s1" }), targets: TARGETS });
    const done = track(await mount(gone));
    gone.current = session({ id: "s1", state: "failed", failReason: "admission_timeout" });
    confirmMock.mockClear();
    base = stops();
    bodyOf(done).onCancel();
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(stops() - base).toBe(0);
    expect(bodyOf(done).view?.state).toBe("failed");
  });

  it("D14: a refused stop reads the server again (it may already have ended); only a failed read says so", async () => {
    const s = serve({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    s.stop = () => { s.current = session({ id: "s1", state: "completed" }); throw new ApiV1Error("not running", 409, "not_active"); };
    const ended = track(await mount(s));
    bodyOf(ended).onStop();
    await settle();
    expect(bodyOf(ended).view?.state, "server state is the truth").toBe("completed");
    expect(bodyOf(ended).createError).toBeNull();

    const down = serve({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    down.stop = () => { down.failCurrent = true; throw new TypeError("Failed to fetch"); };
    const offline = track(await mount(down));
    bodyOf(offline).onStop();
    await settle();
    expect(bodyOf(offline).stopFailed, "m1: a stop that could not be confirmed has its own state").toBe(true);
    expect(bodyOf(offline).createError, "…never the create copy").toBeNull();
    expect(bodyOf(ended).stopFailed).toBe(false);
  });

  it("checkout (owner ruling 8): the secret up front, then the EMBEDDED checkout in the repo's Modal; 402 → the gate; 403 → owner copy; anything else → checkout copy (D13)", async () => {
    checkout.fetch.mockResolvedValueOnce({ ok: true, clientSecret: "cs_test_secret_1" });
    const island = track(await mount({ current: null, targets: TARGETS }));
    expect(lazySheet(island.tree()), "the sheet (and Stripe.js with it) mounted before any checkout").toBeUndefined();
    bodyOf(island).onShowBuy();
    bodyOf(island).onBuy(5);
    await settle();
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "o-1", fixtureId: "f-1", pack: 5 });
    // I2: the sheet is the `next/dynamic` component, mounted only now — and its loader is the real module.
    const sheet = lazySheet(island.tree());
    expect(sheet, "no checkout sheet").toBeDefined();
    expect(propsOf(sheet!).clientSecret).toBe("cs_test_secret_1");
    const made = lazy.made.find((d) => d.C === sheet!.type)!;
    expect(made.opts, "the sheet must never render on the server").toEqual({ ssr: false });
    const mod = (await made.loader()) as { default: (p: Record<string, unknown>) => ReactElement };
    const inner = walk(expandWithHooks(mod.default, propsOf(sheet!)));
    const modal = inner.find((el) => el.type === Modal);
    expect(modal, "no Modal").toBeDefined();
    expect(propsOf(modal!).title).toBe(m("stream.credits.title"));
    // P2: edge to edge on a phone — Stripe's form was clipped inside the default padding at 320.
    expect(propsOf(modal!).bleed, "the checkout sheet bleeds below md").toBe(true);
    expect(byTestId(inner, "stream-checkout-modal")).toBeDefined();
    const provider = inner.find((el) => el.type === EmbeddedCheckoutProvider);
    expect(propsOf(provider!).options).toEqual({ clientSecret: "cs_test_secret_1" });
    expect(propsOf(provider!).stripe).toBe(stripe.promise);
    expect(bodyOf(island).showBuy, "the chooser closes behind the sheet").toBe(false);
    // closing the sheet (the Modal's own close, wired through the lazy component's prop) unmounts it
    (propsOf(modal!).onClose as () => void)();
    expect(lazySheet(island.tree())).toBeUndefined();

    let checked = 0;
    for (const [status, expected] of [[403, "owner"], [400, "unknown"], [503, "unknown"], [null, "unknown"]] as const) {
      checkout.fetch.mockResolvedValueOnce({ ok: false, error: "no", status });
      const refused = track(await mount({ current: null, targets: TARGETS }));
      bodyOf(refused).onBuy(1);
      await settle();
      expect(bodyOf(refused).checkoutError, String(status)).toBe(expected);
      expect(bodyOf(refused).createError, "never the create copy").toBeNull();
      expect(lazySheet(refused.tree())).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(4);

    checkout.fetch.mockResolvedValueOnce({ ok: false, error: "plan_lacks_relay", status: 402 });
    const gated = track(await mount({ current: null, targets: TARGETS }));
    bodyOf(gated).onBuy(20);
    await settle();
    // I4: the checkout's 402 is the switched-off state, never a priced upgrade.
    expect(byTestId(gated.tree(), "stream-switched-off")).toBeDefined();
    expect(gated.tree().find((el) => el.type === UpgradeGate)).toBeUndefined();
  });

  it("P1: the container hands the body the PAGE's currency — the one the checkout route resolves for the same request", async () => {
    const island = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(island).currency).toBe("eur");
  });

  it("N2: ONE Checkout Session per sheet — a double tap, and a tap while the sheet's chunk loads, POST once; closing or a refusal frees the tiles", async () => {
    let answer: (r: unknown) => void = () => {};
    checkout.fetch.mockImplementation(() => new Promise((r) => { answer = r; }));
    serve({ current: null, targets: TARGETS });
    const island = track(renderIsland(PhoneTab, { ...TAB, streamBalance: 0 }));
    await settle();
    expect(bodyOf(island).checkoutOpen, "no sheet yet").toBe(false);
    // A double tap lands on the SAME render's handler — before `busy` has disabled anything.
    const first = bodyOf(island);
    first.onBuy(5);
    first.onBuy(5);
    await settle();
    expect(checkout.fetch, "a double tap before the tiles disable").toHaveBeenCalledTimes(1);
    answer({ ok: true, clientSecret: "cs_test_secret_1" });
    await settle();
    // The sheet element is up but `next/dynamic` renders nothing until its chunk arrives; the forced chooser (balance 0)
    // is still on screen behind it. Its tiles must be dead, and a tap that gets through anyway is refused.
    expect(lazySheet(island.tree()), "the sheet").toBeDefined();
    expect(bodyOf(island).checkoutOpen, "the tiles are told the sheet is open").toBe(true);
    bodyOf(island).onBuy(1);
    await settle();
    expect(checkout.fetch, "a tap during the load window").toHaveBeenCalledTimes(1);
    // Closing the sheet frees the tiles: the next tap is a new Checkout Session.
    (propsOf(lazySheet(island.tree())!).onClose as () => void)();
    await settle();
    expect(bodyOf(island).checkoutOpen).toBe(false);
    bodyOf(island).onBuy(20);
    await settle();
    expect(checkout.fetch, "after the sheet closed").toHaveBeenCalledTimes(2);
    // …and a REFUSED attempt frees them too — the organiser can try again.
    answer({ ok: false, error: "no", status: 503 });
    await settle();
    expect(bodyOf(island).checkoutError).toBe("unknown");
    expect(bodyOf(island).checkoutOpen).toBe(false);
    bodyOf(island).onBuy(20);
    await settle();
    expect(checkout.fetch, "after a refusal").toHaveBeenCalledTimes(3);
  });

  // M1 (Task 14 fix round 4). Anything the sheet THROWS while rendering would otherwise reach the nearest boundary, the
  // route's error.tsx: the whole division page went, an on-air Stop with it, and the purchase lock stayed held. When M1
  // landed the likely thrower was a chunk that failed to load (`next/dynamic` is `React.lazy`); since R5a the tap awaits
  // the sheet's code BEFORE it asks for a Session, so a chunk failure never reaches this boundary (the R5a test below
  // owns that path) and what is left for it is an error thrown while the sheet renders. The node harness has no
  // reconciler, so React's catch is driven by hand below: the boundary's OWN static and lifecycle methods, on an
  // instance built from the element the container rendered — the order React runs them in (render phase, then commit).
  it("M1: a sheet that THROWS while rendering takes down only the sheet — Stop stays, the lock and the tiles are freed, and it says so", async () => {
    checkout.fetch.mockResolvedValue({ ok: true, clientSecret: "cs_test_secret_1" });
    const live = session({ state: "live", startedAt: "2026-09-14T11:50:00Z", balance: 2 });
    const island = track(await mount({ current: live, targets: TARGETS }));
    bodyOf(island).onShowBuy();
    bodyOf(island).onBuy(5);
    await settle();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    // The sheet sits INSIDE its own boundary, and the boundary holds nothing else.
    const boundary = island.tree().find((el) => el.type === CheckoutSheetBoundary);
    expect(boundary, "the sheet has no boundary of its own").toBeDefined();
    const held = walk(propsOf(boundary!).children as ReactElement);
    expect(held.filter((el) => lazy.made.some((d) => d.C === el.type)), "the lazy sheet inside the boundary").toHaveLength(1);
    expect(held.some((el) => el.type === PhoneTabBody), "the boundary must not wrap the tab (Stop lives there)").toBe(false);
    expect(bodyOf(island).checkoutOpen, "tiles dead while the sheet loads").toBe(true);

    // React hands both methods the thrown error; the boundary reads neither, so none is passed.
    const inst = new CheckoutSheetBoundary(propsOf(boundary!) as ConstructorParameters<typeof CheckoutSheetBoundary>[0]);
    expect(inst.render(), "before any failure the boundary renders its sheet").toBe(propsOf(boundary!).children);
    inst.state = CheckoutSheetBoundary.getDerivedStateFromError();
    expect(inst.render(), "a failed sheet renders nothing — never a crash screen over the tab").toBeNull();
    inst.componentDidCatch();
    await settle();

    expect(lazySheet(island.tree()), "the failed sheet is unmounted").toBeUndefined();
    expect(island.tree().find((el) => el.type === CheckoutSheetBoundary)).toBeUndefined();
    const after = bodyOf(island);
    expect(after.checkoutOpen, "the tiles are freed").toBe(false);
    expect(after.checkoutError, "the checkout's own copy, never a create one").toBe("unknown");
    expect(after.createError).toBeNull();
    // Through the REAL body: Stop is on screen and live, the chooser is back with every tile enabled, and the copy says it.
    const tree = walk(expandWithHooks(PhoneTabBody, after));
    expect(byTestId(tree, "stream-stop"), "Stop survives a failed sheet").toBeDefined();
    expect(attr(byTestId(tree, "stream-stop")!, "disabled")).toBeFalsy();
    let tiles = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const tile = byTestId(tree, `stream-buy-pack-${pack.size}`);
      expect(tile, `tile ${pack.size}`).toBeDefined();
      expect(attr(tile!, "disabled"), `tile ${pack.size}`).toBeFalsy();
      tiles++;
    }
    expect(tiles).toBe(STREAM_CREDIT_PACKS.length);
    expect(tiles).toBeGreaterThan(0);
    expect(textAt(tree, "stream-checkout-error")).toBe(m("stream.credits.error.unknown"));
    // The second call: the lock was released, so the next tap is a new Checkout Session — and a fresh boundary.
    after.onBuy(1);
    await settle();
    expect(checkout.fetch, "the purchase lock stuck").toHaveBeenCalledTimes(2);
    expect(island.tree().find((el) => el.type === CheckoutSheetBoundary), "a new sheet, a new boundary").toBeDefined();
  });

  // R5a (fix round 5). M1's boundary caught a chunk that failed to load, but only AFTER the Checkout Session had been
  // opened — and `next/dynamic` is React.lazy, which pins a rejected load for the page's lifetime, so "Try again" failed
  // again at once and opened another Session each time. The sheet's code is now fetched FIRST: no code, no Session.
  it("R5a: a sheet whose code cannot load opens NO Checkout Session — the lock frees, the copy says so, and Try again really retries", async () => {
    checkout.fetch.mockResolvedValue({ ok: true, clientSecret: "cs_test_secret_1" });
    sheetLoader.load.mockRejectedValueOnce(new Error("Failed to load chunk static/chunks/sheet.js"));
    const island = track(renderIsland(PhoneTab, { ...TAB, streamBalance: 0 }));
    await settle();
    bodyOf(island).onBuy(5);
    await settle();
    expect(sheetLoader.load, "the sheet's code was asked for").toHaveBeenCalledTimes(1);
    expect(checkout.fetch, "a Checkout Session opened for a sheet that cannot load").toHaveBeenCalledTimes(0);
    expect(bodyOf(island).checkoutError, "the checkout's own copy").toBe("unknown");
    expect(bodyOf(island).createError).toBeNull();
    expect(bodyOf(island).busy, "the tiles are live again").toBe(false);
    expect(bodyOf(island).checkoutOpen).toBe(false);
    expect(lazySheet(island.tree()), "no sheet mounted over a failed load").toBeUndefined();
    // Try again: the loader is asked AGAIN (it dropped the failure), and this time exactly one Session opens.
    bodyOf(island).onBuy(5);
    await settle();
    expect(sheetLoader.load, "the retry never re-asked for the code").toHaveBeenCalledTimes(2);
    expect(checkout.fetch, "one Session for the retry").toHaveBeenCalledTimes(1);
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "o-1", fixtureId: "f-1", pack: 5 });
    expect(lazySheet(island.tree()), "the sheet").toBeDefined();
    expect(bodyOf(island).checkoutError).toBeNull();
  });

  it("R5a: the sheet's code is in hand BEFORE the Checkout Session is asked for — and a double tap meanwhile is still one POST", async () => {
    checkout.fetch.mockResolvedValue({ ok: true, clientSecret: "cs_test_secret_1" });
    let arrive: () => void = () => {};
    sheetLoader.load.mockImplementationOnce(() => new Promise<void>((r) => { arrive = r; }).then(() => sheetLoader.real()));
    const island = track(renderIsland(PhoneTab, { ...TAB, streamBalance: 0 }));
    await settle();
    const first = bodyOf(island);
    first.onBuy(1);
    first.onBuy(1);
    await settle();
    expect(checkout.fetch, "a Session asked for before the sheet's code arrived").toHaveBeenCalledTimes(0);
    expect(bodyOf(island).busy, "the tiles are dead while it loads").toBe(true);
    arrive();
    await settle();
    expect(checkout.fetch, "N2: one POST for a double tap").toHaveBeenCalledTimes(1);
    expect(sheetLoader.load, "N2: one load for a double tap").toHaveBeenCalledTimes(1);
    expect(lazySheet(island.tree())).toBeDefined();
  });

  it("M1: the boundary itself — renders its sheet until something below it throws, then nothing, and reports once", () => {
    const onFail = vi.fn();
    const sheet = <p data-testid="sheet" />;
    const inst = new CheckoutSheetBoundary({ onFail, children: sheet });
    expect(inst.state).toEqual({ failed: false });
    expect(inst.render()).toBe(sheet);
    expect(CheckoutSheetBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    inst.state = { failed: true };
    expect(inst.render()).toBeNull();
    expect(onFail).not.toHaveBeenCalled();
    inst.componentDidCatch();
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  // M2 / D-B (fix round 4): N2 warmed the sheet's chunk when the chooser OPENED, and the chunk's import side effect is
  // js.stripe.com — so an organiser with no credits who merely looked at the Phone tab (the forced chooser) loaded
  // Stripe.js: capture pass 3 counted 13 stripe.com requests before any tap. The warm-up now waits for a hand on a tile.
  it("M2: opening the chooser loads NOTHING — forced or opened; the first tile intent loads the sheet ONCE, and a failed warm-up retries", async () => {
    // TAB's balance is 3, so this one's chooser opens only on Buy more; balance 0 at idle is the FORCED chooser.
    const opened = track(await mount({ current: null, targets: TARGETS }));
    const forced = track(renderIsland(PhoneTab, { ...TAB, streamBalance: 0 }));
    await settle();
    expect(bodyOf(forced).balance, "premise: the forced chooser").toBe(0);
    expect(bodyOf(forced).view).toBeNull();
    bodyOf(opened).onShowBuy();
    await settle();
    expect(bodyOf(opened).showBuy, "premise: Buy more opened the chooser").toBe(true);
    expect(sheetLoader.load, "an OPEN chooser fetched the sheet (and Stripe.js with it)").toHaveBeenCalledTimes(0);

    // A hand on a tile: pointerenter, then the focus a press brings, then — on a phone — touchstart. One fetch.
    bodyOf(forced).onTileIntent();
    bodyOf(forced).onTileIntent();
    bodyOf(forced).onTileIntent();
    await settle();
    expect(sheetLoader.load, "tile intent warms the sheet exactly once").toHaveBeenCalledTimes(1);
    // …through the SAME loader the sheet itself mounts with (N2: one specifier, one chunk).
    const made = lazy.made.filter((d) => (d.opts as { ssr?: boolean } | undefined)?.ssr === false);
    expect(made, "the panel's one dynamic() sheet").toHaveLength(1);
    await made[0]!.loader();
    expect(sheetLoader.load, "dynamic() and the warm-up are one loader").toHaveBeenCalledTimes(2);

    // A warm-up that FAILED (a network blip) must not block the next intent from trying again (class 13).
    sheetLoader.load.mockClear();
    sheetLoader.load.mockRejectedValueOnce(new Error("Loading chunk failed"));
    const retry = track(renderIsland(PhoneTab, { ...TAB, streamBalance: 0 }));
    await settle();
    bodyOf(retry).onTileIntent();
    await settle();
    bodyOf(retry).onTileIntent();
    await settle();
    expect(sheetLoader.load, "a failed warm-up, then a retry").toHaveBeenCalledTimes(2);
    bodyOf(retry).onTileIntent();
    await settle();
    expect(sheetLoader.load, "…and once it succeeded, no more").toHaveBeenCalledTimes(2);
  });

  it("M2: the ONE loader module — the only specifier of the sheet anywhere in the panel, and no warm-up on the chooser", () => {
    const src = readFileSync(join(__dirname, "..", "fixture-stream-panel.tsx"), "utf8");
    const loaderSrc = readFileSync(join(__dirname, "..", "stream-checkout-sheet-loader.ts"), "utf8");
    expect(src.match(/import\("\.\/stream-checkout-modal"\)/g) ?? [], "the panel imports the sheet itself").toHaveLength(0);
    expect(loaderSrc.match(/import\("\.\/stream-checkout-modal"\)/g) ?? []).toHaveLength(1);
    // The loader module is in the panel's STATIC graph, so it must carry nothing but the dynamic import.
    expect(loaderSrc).not.toMatch(/^\s*import\s/m);
    expect(src, "the chooser-open warm-up is gone").not.toMatch(/chooserOpen/);
  });

  // ─── PR-2 T10 / T12: the switch's write, and the takeover notice's dismissal ─────────────────────────────────────────
  const settingsBodies = () => apiV1.mock.calls.filter(([url, o]) => `${o?.method ?? "GET"} ${url}` === SETTINGS).map(([, o]) => o?.json);

  it("T10: the container hands the body the auto stop's delay and the venue zone, untouched — values the defaults cannot produce", async () => {
    serve({ current: null, targets: TARGETS });
    const island = track(renderIsland(PhoneTab, { ...TAB, autoStopMinutes: 7, tz: "Asia/Kolkata" }));
    await settle();
    expect([TAB.autoStopMinutes, TAB.tz], "premise: the defaults differ").not.toEqual([7, "Asia/Kolkata"]);
    expect([bodyOf(island).autoStopMinutes, bodyOf(island).tz]).toEqual([7, "Asia/Kolkata"]);
  });

  it("T10: a flip writes PUT stream-settings { autoStream } — that field ALONE — then re-reads the read model; the switch follows the SERVER", async () => {
    const s = serve({ current: null, targets: TARGETS });
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(bodyOf(island).phone?.auto ?? null, "premise: no settings row").toBeNull();
    const reads = phoneReads();
    bodyOf(island).onToggleAuto(true);
    expect(bodyOf(island).autoPending, "the asked state shows while the save is in flight").toBe(true);
    await settle();
    expect(settingsBodies()).toEqual([{ autoStream: true }]);
    expect(phoneReads(), "the read model is read again after the save").toBeGreaterThan(reads);
    expect(bodyOf(island).phone?.auto?.enabled).toBe(true);
    expect([bodyOf(island).autoPending, bodyOf(island).autoFailed]).toEqual([null, false]);
    expect(s.saved, "the pick is left alone").toBeUndefined();
    // The sequence: back off — a second write, the server's answer again.
    bodyOf(island).onToggleAuto(false);
    await settle();
    expect(settingsBodies()).toEqual([{ autoStream: true }, { autoStream: false }]);
    expect(bodyOf(island).phone?.auto?.enabled).toBe(false);
  });

  it("T10: a failed save goes back to the server's answer and says so; the next flip clears the line", async () => {
    const s = serve({ current: null, targets: TARGETS, autoStream: false, failAuto: true });
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    bodyOf(island).onToggleAuto(true);
    await settle();
    expect([bodyOf(island).autoPending, bodyOf(island).autoFailed, bodyOf(island).phone?.auto?.enabled]).toEqual([null, true, false]);
    s.failAuto = false;
    bodyOf(island).onToggleAuto(true);
    expect(bodyOf(island).autoFailed, "a new attempt retires the old failure").toBe(false);
    await settle();
    expect([bodyOf(island).autoFailed, bodyOf(island).phone?.auto?.enabled]).toEqual([false, true]);
  });

  it("T12: the X remembers THIS takeover's instant for this fixture (localStorage), read back on the next mount; a storage that throws still dismisses", async () => {
    const AT = "2026-09-14T11:32:00.000Z";
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    serve({ current: null, targets: TARGETS, phone: readModel({ lastTakeover: { at: AT, model: "Pixel 8", elapsedMs: 60_000 } }) });
    const a = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(bodyOf(a).takeoverDismissedAt, "nothing dismissed yet").toBeNull();
    bodyOf(a).onDismissTakeover(AT);
    expect(bodyOf(a).takeoverDismissedAt).toBe(AT);
    expect([...store.entries()]).toEqual([["seazn.stream.takeoverDismissed.f-1", AT]]);
    const b = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(bodyOf(b).takeoverDismissedAt, "read back on the next mount").toBe(AT);
    const boom = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    const c = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(bodyOf(c).takeoverDismissedAt, "an unreadable store reads as nothing dismissed").toBeNull();
    bodyOf(c).onDismissTakeover(AT);
    expect(bodyOf(c).takeoverDismissedAt, "…and the X still works for this view").toBe(AT);
  });

  describe("PhoneStopProbe — an org without the relay can still stop what is on air (G2)", () => {
    async function probe(s: Server) {
      serve(s);
      const island = track(renderIsland(PhoneStopProbe, { fixtureId: "f-1" }));
      await settle();
      return island;
    }

    it("no session, or a finished one: renders NOTHING, and reads only `current` — never the org's destinations", async () => {
      let checked = 0;
      for (const current of [null, session({ state: "completed" }), session({ state: "failed" })]) {
        apiV1.mockClear();
        const island = await probe({ current, targets: TARGETS });
        expect(island.tree(), String(current?.state)).toEqual([]);
        expect(calls(), String(current?.state)).toEqual([CURRENT]);
        checked++;
      }
      expect(checked).toBe(3);
    });

    it("live: the pill (announced), REC + elapsed and a confirming Stop that POSTs THIS session's stop", async () => {
      const s = { current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS } as Server;
      s.stop = () => { s.current = session({ id: "s1", state: "ending" }); return s.current; };
      const island = await probe(s);
      const tree = island.tree();
      expect(byTestId(tree, "stream-stop-probe")).toBeDefined();
      expect(attr(byTestId(tree, "stream-state-pill")!, "aria-live")).toBe("polite");
      expect(byTestId(tree, "stream-rec")).toBeDefined();
      expect(String(attr(byTestId(tree, "stream-stop")!, "className")).split(/\s+/)).toEqual(expect.arrayContaining(["bg-red-600", "min-h-11"]));
      click(byTestId(tree, "stream-stop"));
      await settle();
      expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger", ...STOP_CONFIRM_EXTRAS }));
      expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
      expect(textAt(island.tree(), "stream-ending")).toBe(m("stream.phone.ending", { destination: "Club" }));
      expect(byTestId(island.tree(), "stream-stop"), "no Stop while it ends").toBeUndefined();
      // It keeps polling while not terminal, and gets out of the way once the stream is done.
      s.current = session({ id: "s1", state: "completed" });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(island.tree()).toEqual([]);
    });

    it("F1: a probe the frozen division page mounts NAMES its fixture; a row's own probe (no label) adds no line", async () => {
      const live = () => ({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS }) as Server;
      serve(live());
      const labelled = track(renderIsland(PhoneStopProbe, { fixtureId: "f-1", label: "Green Giants vs Gold Geese" }));
      await settle();
      const el = byTestId(labelled.tree(), "stream-stop-probe-label");
      expect(el && textOf(el)).toBe("Green Giants vs Gold Geese");
      // A long pair of names truncates inside the card instead of widening the page; the title keeps it readable.
      expect(String(attr(el!, "className")).split(/\s+/)).toContain("truncate");
      expect(attr(el!, "title")).toBe("Green Giants vs Gold Geese");
      expect(byTestId(labelled.tree(), "stream-stop"), "the label never costs the Stop").toBeDefined();
      const bare = await probe(live());
      expect(byTestId(bare.tree(), "stream-stop-probe")).toBeDefined();
      expect(byTestId(bare.tree(), "stream-stop-probe-label")).toBeUndefined();
    });

    it("warming: Cancel — through the same re-read — and a stop nobody could confirm says so", async () => {
      const s = { current: session({ id: "s1" }), targets: TARGETS } as Server;
      s.stop = () => { s.failCurrent = true; throw new TypeError("Failed to fetch"); };
      const island = await probe(s);
      expect(byTestId(island.tree(), "stream-qr"), "the probe never shows the credentials").toBeUndefined();
      expect(qrImageOf(island.tree(), "stream-qr"), "…nor through the shared QR component").toBeUndefined();
      click(byTestId(island.tree(), "stream-cancel"));
      await settle();
      expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
      // N1: a failed CANCEL says so, and names the Cancel button still on screen — never "tap Stop stream again".
      expect(textAt(island.tree(), "stream-stop-error")).toBe(m("stream.error.cancel"));
      expect(byTestId(island.tree(), "stream-cancel"), "the control the copy names").toBeDefined();
    });

    it("N3: a stop that LANDED behind a lost response says nothing once a read finds it ending", async () => {
      const s = { current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS } as Server;
      s.stop = () => { s.failCurrent = true; throw new TypeError("Failed to fetch"); };
      const island = await probe(s);
      click(byTestId(island.tree(), "stream-stop"));
      await settle();
      expect(textAt(island.tree(), "stream-stop-error"), "premise: the stop could not be confirmed").toBe(m("stream.error.stop"));
      // The network comes back and the stop had in fact landed.
      s.failCurrent = false;
      s.current = session({ id: "s1", state: "ending", startedAt: "2026-09-14T11:50:00Z" });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(byTestId(island.tree(), "stream-ending")).toBeDefined();
      expect(byTestId(island.tree(), "stream-stop-error"), "'did not stop' beside 'ending'").toBeUndefined();
    });

    // m3 (lane-close fix, ruled 2026-09-29): a first read that FAILED is not an answer. Before, the probe read "no view"
    // as idle, idle as terminal, and never polled — so a stream on air behind one dropped request left the organiser
    // with no Stop until a reload. It now keeps reading at STREAM_POLL_MS until a read lands, and stops once one does.
    it("m3: a FAILED first read keeps polling at STREAM_POLL_MS until a read lands — then shows the live stream's Stop", async () => {
      const s = { current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS, failCurrent: true } as Server;
      apiV1.mockClear();
      const island = await probe(s);
      expect(island.tree(), "nothing known yet: nothing drawn").toEqual([]);
      expect(plainPolls(), "the mount's read").toBe(1);
      // Still down: each interval is another read, never a silence.
      let retried = 0;
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
        await settle();
        retried++;
        expect(plainPolls(), `retry ${retried}`).toBe(1 + retried);
        expect(island.tree()).toEqual([]);
      }
      expect(retried).toBe(3);
      // A read comes back: the stream that was on air all along is stoppable.
      s.failCurrent = false;
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(byTestId(island.tree(), "stream-stop")).toBeDefined();
    });

    it("m3: the retry ENDS once a read lands on nothing — a probe with no stream stops asking; after a failed read at mount, a finished one does too", async () => {
      let checked = 0;
      for (const answer of [null, session({ id: "s1", state: "completed" })]) {
        const s = { current: answer, targets: TARGETS, failCurrent: true } as Server;
        apiV1.mockClear();
        const island = await probe(s);
        s.failCurrent = false;
        await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
        await settle();
        const landed = plainPolls();
        expect(landed, `${String(answer?.state)}: the mount's failed read and the retry that landed`).toBe(2);
        await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 3);
        await settle();
        expect(plainPolls(), `${String(answer?.state)}: polled on after a read said nothing is up`).toBe(landed);
        expect(island.tree()).toEqual([]);
        checked++;
      }
      expect(checked).toBe(2);
    });
  });

  it("m3: the Phone tab shares the retry — a failed first read keeps polling until the live session it missed is shown", async () => {
    // The read model is unreadable too: it would name the open session (I-2) and read `current` itself — this case is
    // the session's OWN retry, so only that one may show it.
    const s = serve({ current: session({ id: "s1", state: "live", startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS, failCurrent: true, failPhone: true });
    apiV1.mockClear();
    const island = track(await mount(s));
    expect(bodyOf(island).view, "premise: the failed read leaves the tab usable, at idle").toBeNull();
    const before = plainPolls();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(plainPolls() - before, "idle after a FAILED read is not terminal").toBe(1);
    s.failCurrent = false;
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(bodyOf(island).view?.state).toBe("live");
  });

  it("the list's first read is LOADING, then ok; a FAILED read is the error state (never 'none'), and Retry re-reads it and selects the first destination (never a removed one's replacement)", async () => {
    const s = serve({ current: null, targets: TARGETS, failTargets: true });
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(bodyOf(island).targets).toEqual({ status: "error" });
    expect(bodyOf(island).selectedTargetId, "nothing selected from a list nobody read").toBeNull();
    const reads = () => calls().filter((c) => c === "GET /api/v1/orgs/o-1/stream-targets").length;
    expect(reads()).toBe(1);
    s.failTargets = false;
    bodyOf(island).onRetryTargets();
    await settle();
    expect(reads(), "Retry re-reads the list").toBe(2);
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    // A second Retry keeps a selection that still exists, and drops one that does not.
    bodyOf(island).onSelectTarget("t2");
    bodyOf(island).onRetryTargets();
    await settle();
    expect(bodyOf(island).selectedTargetId, "kept: still in the list").toBe("t2");
    s.targets = [TARGETS[0]!];
    bodyOf(island).onRetryTargets();
    await settle();
    // B4 re-review n1 (reverses the old "falls to the first remaining"): the removed choice is cleared, nothing chosen.
    expect(bodyOf(island).selectedTargetId, "t2 was removed in Directory: cleared, t1 NOT picked for them").toBeNull();
    expect(reads()).toBe(4);
  });

  it("D1: the container never writes a destination — every call it makes is a read of the list or a session route", async () => {
    const s = serve({ current: null, targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onRetryTargets();
    await settle();
    const writes = apiV1.mock.calls.filter(([url, o]) => /stream-targets/.test(url) && (o?.method ?? "GET") !== "GET");
    expect(writes, "no POST, PATCH or DELETE to the destination routes").toEqual([]);
    expect(calls().filter((c) => c === "GET /api/v1/orgs/o-1/stream-targets").length, "the positive pair: the list WAS read").toBe(2);
  });

  it("Try again on a failed session is the same return to idle as Start another — the refusal cleared, the destination kept", async () => {
    const s = serve({ current: session({ id: "s5", state: "failed", failReason: "target_rejected" }), targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onAgain();
    expect(bodyOf(island).view).toBeNull();
    expect(bodyOf(island).selectedTargetId).toBe("t1");
  });

  // ─── I1 (B4 review): the picker re-reads its list when the organiser comes back from Directory ──────────────────────
  // "Manage destinations" opens Directory in a NEW tab (D1), so the round trip — add or remove there, come back here —
  // never remounts this tab. `apps/web` vitest has no DOM: a minimal `document` / `window` (EventTargets, the only
  // surface `useTabReturn` touches) is stubbed BEFORE the mount, so the listeners are the real ones the hook adds.
  const stubPage = () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
    const win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    return { doc, win };
  };
  const LIST = "GET /api/v1/orgs/o-1/stream-targets";
  const listReads = () => calls().filter((c) => c === LIST).length;

  it("I1: coming back to the tab re-reads the list — the destination added in Directory is offered and Go live is enabled; ONE read per return (focus + visibilitychange), none on the hide, none while a session is up", async () => {
    const { doc, win } = stubPage();
    const s = serve({ current: null, targets: [] });
    const island = track(await mount(s));
    expect(listReads(), "the mount's read").toBe(1);
    expect(listOf(bodyOf(island).targets)).toEqual([]);
    expect(bodyOf(island).selectedTargetId, "the empty case: nothing to pick").toBeNull();

    // Added in the Directory tab; the organiser comes back. A real return fires BOTH events — one read, not two.
    s.targets = [TARGETS[0]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(listReads(), "one read for one return — the second event lands while the first read is in flight").toBe(2);
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1"]);
    expect(bodyOf(island).selectedTargetId, "the new destination is picked, so Go live is enabled").toBe("t1");
    expect(bodyOf(island).targets.status, "a quiet re-read never flashes loading").toBe("ok");

    // A second return is a second read (the dedupe is per read in flight, never once per mount).
    s.targets = [TARGETS[0]!, TARGETS[1]!];
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(listReads()).toBe(3);
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(bodyOf(island).selectedTargetId, "a selection still listed stays").toBe("t1");

    // The HIDE fires visibilitychange too — leaving the tab is not a return.
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(listReads(), "no read on the hide").toBe(3);
    doc.visibilityState = "visible";

    // Removed in Directory: the return drops it, and the stale selection is CLEARED — never a silent fall to another
    // destination (B4 re-review n1): streaming to one the organiser did not pick is the worse mistake.
    bodyOf(island).onSelectTarget("t2");
    s.targets = [TARGETS[0]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(listReads()).toBe(4);
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1"]);
    expect(bodyOf(island).selectedTargetId, "the removed choice is cleared, and nothing is picked for them").toBeNull();

    // A return whose read FAILS keeps the picker the organiser already has — a quiet read never turns it into an error.
    s.failTargets = true;
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(listReads()).toBe(5);
    expect(bodyOf(island).targets.status, "the list already shown stays").toBe("ok");
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1"]);
    s.failTargets = false;

    // With a session up there is no picker to refresh: a return reads nothing.
    s.create = () => { s.current = session(); return { sessionId: "s1" }; };
    bodyOf(island).onSelectTarget("t1");
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).view?.state).toBe("warming");
    const before = listReads();
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    await settle();
    expect(listReads(), "no list read while a session is up").toBe(before);
  });

  it("I1: a Go live answered 404 re-reads the list — the chosen destination is GONE: 'removed' copy and the stale choice cleared; still listed (a 404 about something else): the generic copy, choice kept", async () => {
    stubPage();
    const s = serve({ current: null, targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onSelectTarget("t2");
    // Removed in Directory while this tab stayed open — no return event, so only the 404 can tell.
    s.targets = [TARGETS[0]!];
    s.create = () => { throw new ApiV1Error("stream target not found", 404, "NOT_FOUND"); };
    const before = listReads();
    bodyOf(island).onGoLive();
    await settle();
    expect(listReads(), "the 404 re-read the list").toBe(before + 1);
    expect(bodyOf(island).createError).toEqual({ code: TARGET_REMOVED, holder: null });
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1"]);
    expect(bodyOf(island).selectedTargetId, "the stale choice is cleared — and t1 is NOT picked for them (n1)").toBeNull();
    expect(bodyOf(island).busy, "the tap is over").toBe(false);

    // The positive pair: a 404 whose chosen destination IS still listed is not "removed".
    bodyOf(island).onSelectTarget("t1");
    s.create = () => { throw new ApiV1Error("fixture not found", 404, "NOT_FOUND"); };
    bodyOf(island).onGoLive();
    await settle();
    expect(listReads()).toBe(before + 2);
    expect(bodyOf(island).createError).toEqual({ code: "unknown", holder: null });
    expect(bodyOf(island).selectedTargetId).toBe("t1");

    // Another refusal never re-reads the list.
    s.create = () => { throw new ApiV1Error("busy", 409, "active_session", { sessionId: "s9" }); };
    bodyOf(island).onGoLive();
    await settle();
    expect(listReads(), "a 409 reads no list").toBe(before + 2);
  });

  // B4 re-review n1: after a "removed" answer the picker is EMPTY until the organiser picks — Go live cannot start, and
  // nothing is picked for them on any later read. The sentence explaining it stays until that pick, however many
  // returns come between.
  it("n1: removed → no selection, Go live held, the 'removed' line kept across a later return; the next PICK clears it and starts again", async () => {
    const { doc } = stubPage();
    const s = serve({ current: null, targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onSelectTarget("t2");
    s.targets = [TARGETS[0]!];
    s.create = () => { throw new ApiV1Error("stream target not found", 404, "NOT_FOUND"); };
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).createError).toEqual({ code: TARGET_REMOVED, holder: null });
    expect(bodyOf(island).selectedTargetId).toBeNull();
    // What the organiser sees: the placeholder, and Go live disabled.
    const shown = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
    expect(attr(byTestId(shown, "stream-target")!, "value")).toBe("");
    expect(propsOf(byTestId(shown, "stream-go-live")!).disabled, "no destination, no start").toBe(true);

    // A LATER return re-reads the list (t1 still there): still nothing picked, still the sentence.
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "a later read never picks for them").toBeNull();
    expect(bodyOf(island).createError, "the explanation outlives the return").toEqual({ code: TARGET_REMOVED, holder: null });

    // The pick — after that return — clears the sentence and lets Go live start.
    s.create = () => { s.current = session(); return { sessionId: "s1" }; };
    bodyOf(island).onSelectTarget("t1");
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    expect(bodyOf(island).createError, "the pick answers the removed line").toBeNull();
    bodyOf(island).onGoLive();
    await settle();
    expect(apiV1.mock.calls.some(([u, o]) => o?.method === "POST" && /stream-sessions$/.test(u) && (o.json as { targetId?: string }).targetId === "t1")).toBe(true);
  });

  // B8 review I-1 narrows this edge: the offer is the SERVER's (`fixtureStreamTarget`). With nothing ever SAVED, the first
  // destination added after the list emptied is the oldest, offered. A saved choice that was removed stays none on the
  // server — so a destination added after it is NOT offered: the organiser picks it (the last steps below).
  it("n1's edge: a removal that EMPTIES the list holds nothing — with nothing saved, the next destination added is a first one, offered (directory-stream-destinations I1, steps 4→5)", async () => {
    const { doc } = stubPage();
    const s = serve({ current: null, targets: [TARGETS[0]!] });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    s.targets = [];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "removed, and nothing left").toBeNull();
    s.targets = [TARGETS[1]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "the only destination, added after the list emptied: offered").toBe("t2");
    // …while a removal that leaves OTHERS listed still holds (the positive pair of n1).
    s.targets = [TARGETS[0]!, TARGETS[1]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    bodyOf(island).onSelectTarget("t1");
    s.targets = [TARGETS[1]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "t1 removed, t2 still there: NOT picked for them").toBeNull();
    // …and emptying it from there, then adding a NEW destination: the saved choice (t1) is gone, so the server answers
    // none (n1) — the new one is listed, not chosen for them. The organiser's pick is what offers it.
    expect(s.saved, "PREMISE: the pick was saved").toEqual({ row: true, targetId: "t1" });
    s.targets = [];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    const t3 = { ...TARGETS[0]!, id: "t3", label: "New" };
    s.targets = [t3];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t3"]);
    expect(bodyOf(island).selectedTargetId, "a removed CHOICE is never replaced — not even by the only destination").toBeNull();
    bodyOf(island).onSelectTarget("t3");
    expect(bodyOf(island).selectedTargetId).toBe("t3");
  });

  // B5 review m-2: an EMPTY list has nothing to "pick another" from. The empty state (No destinations yet + Manage) says
  // what to do; a "removed, pick another one" line beside it — or, after a destination is added, beside an enabled Go
  // live on a DIFFERENT destination — contradicts the screen.
  it("m-2: a Go live 404 that finds the list EMPTY is the empty state, not 'removed, pick another'; the next destination added is offered with no stale line", async () => {
    const { doc } = stubPage();
    const s = serve({ current: null, targets: [TARGETS[0]!] });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    s.targets = [];
    s.create = () => { throw new ApiV1Error("stream target not found", 404, "NOT_FOUND"); };
    bodyOf(island).onGoLive();
    await settle();
    expect(listOf(bodyOf(island).targets), "the 404 re-read the list: empty").toEqual([]);
    expect(bodyOf(island).createError, "nothing to pick another from: the empty state says it").toBeNull();
    const shown = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
    expect(byTestId(shown, "stream-dest-empty"), "the empty state").toBeDefined();
    expect(byTestId(shown, "stream-manage-destinations"), "…with the way to Directory").toBeDefined();
    expect(byTestId(shown, "stream-create-error"), "no 'removed' line").toBeUndefined();
    expect(propsOf(byTestId(shown, "stream-go-live")!).disabled).toBe(true);
    // A destination added in Directory: offered, and nothing on screen still says "removed".
    s.targets = [TARGETS[1]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId).toBe("t2");
    expect(bodyOf(island).createError).toBeNull();
  });

  it("m-2: a 'removed' line from a list that still had others goes when a later read finds the list EMPTY — the empty state replaces it", async () => {
    const { doc } = stubPage();
    const s = serve({ current: null, targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onSelectTarget("t2");
    s.targets = [TARGETS[0]!];
    s.create = () => { throw new ApiV1Error("stream target not found", 404, "NOT_FOUND"); };
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).createError, "premise: others listed, so 'pick another' is true").toEqual({ code: TARGET_REMOVED, holder: null });
    s.targets = [];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).createError, "the list emptied: the line goes").toBeNull();
    s.targets = [TARGETS[1]!];
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).selectedTargetId, "a first destination after the empty list is offered").toBe("t2");
    expect(bodyOf(island).createError, "…with no 'removed' line beside an enabled Go live").toBeNull();
  });

  it("n1 (in use): a pick clears the target_in_use hold; a return that finds the picked destination FREE clears it too — one still held does not", async () => {
    const { doc } = stubPage();
    const holder = { sessionId: "s9", fixtureId: "f-9", href: "/x/f/5", matchNo: 5, courtName: "Court 1", state: "live" as const };
    const held = { ...TARGETS[0]!, inUse: holder };
    const s = serve({ current: null, targets: [held, TARGETS[1]!] });
    const island = track(await mount(s));
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    s.create = () => { throw new ApiV1Error("in use", 409, "target_in_use", { holder: { ...holder, label: "Club" } }); };
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).createError?.code).toBe("target_in_use");
    // A return while t1 is STILL held: the hold stands.
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).createError?.code, "still held — the line stays").toBe("target_in_use");
    // f-9 stopped; the next return finds t1 free: the hold is lifted, the selection kept.
    s.targets = TARGETS;
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(bodyOf(island).createError, "freed — Go live may try again").toBeNull();
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    // And a PICK clears it outright.
    s.targets = [held, TARGETS[1]!];
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).createError?.code).toBe("target_in_use");
    bodyOf(island).onSelectTarget("t2");
    expect(bodyOf(island).createError, "picking another destination answers it").toBeNull();
  });

  // B8 review m-4: the read model's reads race too — the poll, a tab return's, the reissue's. Only the NEWEST answer
  // lands: an older poll answering late would put a phone that has since gone back on screen (or, as here, take a paired
  // one away — and ask for the code it no longer needs).
  it("m-4: an OLDER read-model answer that lands LATE never overwrites a newer one — and asks for no code it would have", async () => {
    const { doc } = stubPage();
    const pending: { resolve: (v: unknown) => void }[] = [];
    serve({ current: null, targets: TARGETS });
    const base = apiV1.getMockImplementation()!;
    apiV1.mockImplementation((url, options) =>
      `${options?.method ?? "GET"} ${url}` === PHONE ? new Promise((resolve) => { pending.push({ resolve }); }) : base(url, options),
    );
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(pending.length, "the mount's read is in flight").toBe(1);
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(pending.length, "the return asked again").toBe(2);
    pending[1]!.resolve(readModel());                  // the NEWER answer: a paired phone
    await settle();
    expect(bodyOf(island).phone?.phone?.present).toBe(true);
    pending[0]!.resolve(readModel({ phone: null }));   // the OLDER answer, late: no phone
    await settle();
    expect(bodyOf(island).phone?.phone?.present, "the late older answer is dropped").toBe(true);
    expect(ensures(), "…so no code is asked for a phone that is still paired").toBe(0);
    // The positive pair: a NEWER answer with no phone does land, and the card asks for the code once.
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    pending[2]!.resolve(readModel({ phone: null }));
    await settle();
    expect(bodyOf(island).phone?.phone).toBeNull();
    expect(ensures()).toBe(1);
  });

  it("m2: an OLDER read that answers LATE never overwrites a newer one — neither its list nor its failure", async () => {
    stubPage();
    // The list route answers in the order the TEST releases, not the order asked.
    const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    // The server's org has the one destination the newer read answers with — so its read model offers it (I-1).
    const s = serve({ current: null, targets: [TARGETS[1]!] });
    const base = apiV1.getMockImplementation()!;
    apiV1.mockImplementation((url, options) =>
      `${options?.method ?? "GET"} ${url}` === LIST
        ? new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
        : base(url, options),
    );
    const island = track(renderIsland(PhoneTab, TAB));
    await settle();
    expect(pending.length, "the mount's read is in flight").toBe(1);
    bodyOf(island).onRetryTargets();
    await settle();
    expect(pending.length, "Retry asked again").toBe(2);
    pending[1]!.resolve([TARGETS[1]!]);
    await settle();
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t2"]);
    pending[0]!.resolve([TARGETS[0]!]);
    await settle();
    expect(listOf(bodyOf(island).targets).map((t) => t.id), "the late answer of the older read is dropped").toEqual(["t2"]);
    expect(bodyOf(island).selectedTargetId).toBe("t2");

    // The same for a late FAILURE: a newer read's list stands.
    bodyOf(island).onRetryTargets();
    await settle();
    bodyOf(island).onRetryTargets();
    await settle();
    expect(pending.length).toBe(4);
    pending[3]!.resolve(TARGETS);
    await settle();
    pending[2]!.reject(new TypeError("Failed to fetch"));
    await settle();
    expect(bodyOf(island).targets.status, "a late failure of an older read never replaces the newer list").toBe("ok");
    expect(listOf(bodyOf(island).targets).map((t) => t.id)).toEqual(["t1", "t2"]);
    void s;
  });

  // B8 re-review item 2 (ruling: m-8 is a regression). Before T11 every entitled organiser bought match credits in this
  // panel. With `capture-qr-v2` off the panel is the OBS overlay, and the purchase must still be one tap away — the same
  // chooser, the same one-Checkout-Session lock, the same embedded sheet, through the SAME container code the Phone tab
  // uses (`useCreditCheckout`), and nothing of the phone path: no stream code minted, no read model read.
  describe("capture-qr-v2 OFF keeps the credit purchase (B8 re-review item 2)", () => {
    const CREDITS = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const };
    const creditsBody = (island: { tree: () => ReactElement[] }) => {
      const el = island.tree().find((e) => e.type === StreamCreditsBody);
      if (!el) throw new Error("no StreamCreditsBody in the container's tree");
      return { props: propsOf(el) as Record<string, unknown>, tree: walk(expandWithHooks(StreamCreditsBody, propsOf(el) as never)) };
    };

    it("composition: flag OFF mounts the credits under the OBS overlay with the page's own credit facts; flag ON leaves them to the Phone tab; a switched-off org or a relay-less deployment has none", () => {
      const facts = { streamBalance: 4, streamSplit: { monthly: 2, pack: 2, total: 4 }, monthlyAllowance: 5, currency: "usd" as const };
      const off = openPanel({ relayEntitled: true, phoneCapture: false, ...facts }).tree();
      const credits = off.find((el) => el.type === StreamCredits);
      expect(credits, "flag off: the purchase is on the panel").toBeDefined();
      expect(propsOf(credits!)).toEqual({ fixtureId: FIXTURE.id, orgId: "o-1", ...facts });
      const lead = off.findIndex((el) => attr(el, "data-testid") === "stream-lead");
      expect(lead, "premise: the OBS overlay is the panel").toBeGreaterThanOrEqual(0);
      expect(off.indexOf(credits!), "under the OBS overlay").toBeGreaterThan(lead);
      // The positive pair: flag on — the Phone tab carries the purchase, so no second copy.
      expect(openPanel({ relayEntitled: true, phoneCapture: true, ...facts }).tree().find((el) => el.type === StreamCredits)).toBeUndefined();
      let gated = 0;
      for (const o of [{ relayEntitled: false }, { relayEntitled: true, relayDisabled: true }]) {
        expect(openPanel({ ...o, phoneCapture: false }).tree().find((el) => el.type === StreamCredits), JSON.stringify(o)).toBeUndefined();
        gated++;
      }
      expect(gated).toBe(2);
    });

    // B8 re-review P4: the flag clause of the mount. Flag ON, the purchase is the Phone tab's alone — an organiser who
    // switches to OBS must not get a second purchase UI (at balance 0 a forced chooser, with its own N2 lock beside the
    // Phone tab's).
    it("P4: one purchase per panel — flag ON on the OBS tab: none (the Phone tab owns it); flag ON on the Phone tab: exactly the tab's own; flag OFF: exactly one, under the overlay", () => {
      const owners = (tree: ReactElement[]) => tree.filter((el) => el.type === StreamCredits || el.type === PhoneTab).map((el) => el.type);
      let checked = 0;
      for (const streamBalance of [0, 4]) {
        const onObs = open({ relayEntitled: true, phoneCapture: true, streamBalance }).tree();
        expect(byTestId(onObs, "stream-lead"), `balance ${streamBalance}: PREMISE — the OBS tab is shown`).toBeDefined();
        expect(byTestId(onObs, "stream-tab-phone"), `balance ${streamBalance}: PREMISE — flag on, the Phone tab exists`).toBeDefined();
        expect(owners(onObs), `balance ${streamBalance}: flag on, OBS tab — no second purchase`).toEqual([]);
        expect(owners(openPanel({ relayEntitled: true, phoneCapture: true, streamBalance }).tree()), `balance ${streamBalance}: flag on, Phone tab`).toEqual([PhoneTab]);
        expect(owners(openPanel({ relayEntitled: true, phoneCapture: false, streamBalance }).tree()), `balance ${streamBalance}: flag off`).toEqual([StreamCredits]);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("flag OFF → buy credits is REACHABLE: the balance and Buy more; Buy more opens every pack and Close; a tile takes the secret and mounts the embedded sheet; nothing of the phone path is called", async () => {
      checkout.fetch.mockResolvedValueOnce({ ok: true, clientSecret: "cs_test_flag_off" });
      const island = track(renderIsland(StreamCredits, CREDITS));
      await settle();
      let b = creditsBody(island);
      expect(textAt(b.tree, "stream-balance")).toBe(m("stream.phone.credits.other", { n: 3 }));
      const buyMore = byTestId(b.tree, "stream-buy-more");
      expect(buyMore, "Buy more is on the panel").toBeDefined();
      expect(attr(buyMore!, "disabled")).toBeFalsy();
      expect(byTestId(b.tree, "stream-buy-pack-5"), "closed until asked").toBeUndefined();
      click(buyMore);
      b = creditsBody(island);
      let tiles = 0;
      for (const pack of STREAM_CREDIT_PACKS) {
        expect(attr(byTestId(b.tree, `stream-buy-pack-${pack.size}`)!, "disabled"), `tile ${pack.size}`).toBeFalsy();
        tiles++;
      }
      expect(tiles, "anti-vacuity: the catalogue declares packs").toBeGreaterThan(0);
      expect(byTestId(b.tree, "stream-credits-close"), "an opened chooser closes").toBeDefined();
      click(byTestId(b.tree, "stream-buy-pack-5"));
      await settle();
      expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "o-1", fixtureId: "f-1", pack: 5 });
      const sheet = lazySheet(island.tree());
      expect(sheet, "the embedded checkout sheet").toBeDefined();
      expect(propsOf(sheet!).clientSecret).toBe("cs_test_flag_off");
      expect(creditsBody(island).props.showBuy, "the chooser closes behind the sheet").toBe(false);
      expect(calls(), "no stream code, no read model, no session read — the phone path is the flag's").toEqual([]);
    });

    it("flag OFF at balance 0: the chooser IS the section (no Buy more, no Close); a 402 at checkout is the switched-off state, never a priced upgrade", async () => {
      checkout.fetch.mockResolvedValueOnce({ ok: false, error: "plan_lacks_relay", status: 402 });
      const island = track(renderIsland(StreamCredits, { ...CREDITS, streamBalance: 0 }));
      await settle();
      const b = creditsBody(island);
      for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(b.tree, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
      expect(byTestId(b.tree, "stream-buy-more")).toBeUndefined();
      expect(byTestId(b.tree, "stream-credits-close"), "a forced chooser has nothing behind it").toBeUndefined();
      click(byTestId(b.tree, `stream-buy-pack-${STREAM_CREDIT_PACKS[0]!.size}`));
      await settle();
      const gated = creditsBody(island).tree;
      expect(byTestId(gated, "stream-switched-off"), "402 → switched off").toBeDefined();
      expect(byTestId(gated, "stream-buy-pack-5"), "…and no tiles to buy what the plan refused").toBeUndefined();
      expect(lazySheet(island.tree())).toBeUndefined();
    });
  });
});
