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
import { EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { renderIsland, propsOf, walk, expandWithHooks, textOf } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { UpgradeGate } from "@/components/upgrade-gate";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { defaultThemeFor, themesForSport } from "@/components/overlay/theme-registry";
import { ApiV1Error } from "@/lib/client-v1";
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { messages, type MessageKey } from "@/lib/messages";
import { STREAM_CREDIT_PACKS, streamPack, streamPackPriceAmounts } from "@/lib/stream-credit-packs";
import { SUPPORTED_CURRENCIES, formatMinor } from "@/lib/currency";
import { LOCALES } from "@/lib/i18n-constants";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { CREDIT_REUSE_HOURS } from "@/server/relay/config";
import {
  END_REASON_KEYS,
  FAIL_REASON_KEYS,
  STREAM_POLL_MS,
  qrText,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { StreamTargetKind, type StreamTarget } from "@/server/api-v1/schemas";
import { platformName } from "@/components/v2/stream-platform-mark";
import {
  CheckoutSheetBoundary,
  FixtureStreamPanel,
  PhoneStopProbe,
  PhoneTab,
  PhoneTabBody,
  QR_RENDER_OPTIONS,
  CANVAS_H,
  CANVAS_W,
  PREVIEW_MAX_W_PX,
  previewScaleFor,
  stepRadio,
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

// The encoder is doubled so its INPUT (the payload and the §7.6 options) is what the test reads.
const qrcode = vi.hoisted(() => ({
  toDataURL: vi.fn<(text: string, opts?: unknown) => Promise<string>>(async (text) => `data:image/png;base64,len${text.length}`),
}));
vi.mock("qrcode", () => ({ default: { toDataURL: qrcode.toDataURL } }));

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
    ...o,
  };
}

function open(o: Partial<StreamPanelContext> = {}) {
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

/** The checksummed contract's own valid payload (docs/contracts) — a real QR, not one typed here. */
const QR = JSON.parse(
  readFileSync(join(__dirname, "../../../../../..", "docs/contracts/fixtures/capture-qr.v1/valid.json"), "utf8"),
) as CaptureQrV1;

const session = (over: Partial<StreamSessionView> = {}): StreamSessionView => ({
  id: "s1", fixtureId: "f-1", mode: "passthrough", state: "warming", desiredState: "live",
  failReason: null, health: null, ingest: { state: "disconnected", protocol: null }, output: null,
  qr: QR, balance: 2, startedAt: null, endedAt: null, replayUrl: null,
  target: { id: "t1", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: false,
  restartFree: false,
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
    const tree = phone({ relayEntitled: true, orgId: "o-77", streamBalance: 4, streamSplit: split, monthlyAllowance: 5, currency: "inr" }).tree();
    expect(byTestId(tree, "stream-switched-off"), "no refusal once entitled").toBeUndefined();
    const tab = tree.find((el) => el.type === PhoneTab);
    expect(tab, "the Phone tab body is not the container").toBeDefined();
    // Each value differs from ctx()'s default, so a prop wired to the wrong field (or a constant) cannot pass.
    expect(propsOf(tab!)).toMatchObject({ fixtureId: FIXTURE.id, orgId: "o-77", streamBalance: 4, streamSplit: split, monthlyAllowance: 5, currency: "inr" });
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
    // De: the reveal flag exists.
    expect(src).toMatch(/\?reveal=1/);
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

  // D16: the Phone tab's stepper is the ONE sanctioned branch — the `ol` at ≥ 768 and its one-line twin below — and
  // it is the only pair. Every other control is a single instance, the same at every width.
  it("across every PhoneTabBody state, ONLY the stream-step / stream-steps pair is hidden by width, and every other control appears once", () => {
    const MD_HIDDEN = /(^|\s)md:hidden(\s|$)/; // anchored: `max-md:hidden` must not satisfy it (AGENTS.md)
    const MAX_MD_HIDDEN = /(^|\s)max-md:hidden(\s|$)/;
    let states = 0;
    let stepped = 0;
    for (const [name, tree] of bodyStates()) {
      const hidden = tree.filter((el) => /(^|\s)(max-)?md:hidden(\s|$)/.test(String(propsOf(el).className ?? "")));
      // B3: the credits-only state has no stepper at all — so nothing in it is hidden by width either.
      if (CREDITS_ONLY.has(name)) {
        expect(hidden, name).toEqual([]);
        states++;
        continue;
      }
      stepped++;
      expect(hidden.map((el) => attr(el, "data-testid")).sort(), name).toEqual(["stream-step", "stream-steps"]);
      expect(String(attr(byTestId(tree, "stream-step")!, "className")), name).toMatch(MD_HIDDEN);
      expect(String(attr(byTestId(tree, "stream-step")!, "className")), name).not.toMatch(MAX_MD_HIDDEN);
      expect(String(attr(byTestId(tree, "stream-steps")!, "className")), name).toMatch(MAX_MD_HIDDEN);
      const ids = tree.map((el) => attr(el, "data-testid")).filter((id): id is string => typeof id === "string");
      const repeated = ids.filter((id, i) => ids.indexOf(id) !== i && id !== "stream-health-chip");
      expect(repeated, `${name}: a control is rendered twice`).toEqual([]);
      states++;
    }
    expect(states).toBe(bodyStates().length);
    expect(states).toBeGreaterThanOrEqual(8);
    expect(stepped, "every state skipped the stepper check").toBe(states - CREDITS_ONLY.size);
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

  it("T5: `openedByReturn` opens on the PHONE tab and strips the return; without it, OBS (the positive pair)", () => {
    searchParamsMock.set(new URLSearchParams(RETURN));
    const here = panel(true).tree();
    expect(attr(byTestId(here, "stream-tab-phone")!, "aria-selected"), "the fixture page's return lands on Phone").toBe(true);
    expect(byTestId(here, "stream-phone-gate"), "the Phone tab body").toBeDefined();
    expect(router.replace, "the return's params are stripped (G5)").toHaveBeenCalledWith(PATHNAME, { scroll: false });
    router.replace.mockReset();
    // The same URL without the page's word: an ordinary open.
    const ordinary = panel(false).tree();
    expect(attr(byTestId(ordinary, "stream-tab-obs")!, "aria-selected"), "no openedByReturn, no Phone tab").toBe(true);
    expect(byTestId(ordinary, "stream-phone-gate")).toBeUndefined();
    expect(router.replace, "an ordinary open strips nothing").not.toHaveBeenCalled();
  });

  it("T6: the old run-sheet return URL (`?stream=open&fixture=<this id>`) opens nothing by itself — the URL is no longer a reader", () => {
    searchParamsMock.set(new URLSearchParams(`tab=fixtures&fixture=${FIXTURE.id}&${RETURN}`));
    const tree = panel(undefined).tree();
    expect(attr(byTestId(tree, "stream-tab-obs")!, "aria-selected"), "OBS, as any ordinary open").toBe(true);
    expect(byTestId(tree, "stream-phone-gate")).toBeUndefined();
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
  view: null, balance: 0, targets: { status: "ok", list: [] }, busy: false, createError: null, checkoutError: null,
  selectedTargetId: null, mode: "clean", qrDataUrl: null, now: NOW, copied: false, showBuy: false,
  planGate: false, stopFailed: false, checkoutOpen: false, currency: "gbp", split: null, monthlyAllowance: 0, restartFree: false,
  onSelectTarget: () => {}, onRetryTargets: () => {}, onMode: () => {}, onGoLive: () => {}, onStop: () => {}, onCancel: () => {},
  onBuy: () => {}, onAgain: () => {}, onCopy: () => {}, onShowBuy: () => {}, onTileIntent: () => {},
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
function bodyStates(): [string, ReactElement[]][] {
  return [
    ["idle, balance 0 (the credits card)", body({ view: null, balance: 0 })],
    ["idle, balance 2", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" })],
    ["idle, no destinations yet", body({ view: null, balance: 2, targets: [], selectedTargetId: null })],
    ["idle, the destination list failed to load", body({ view: null, balance: 2, targets: { status: "error" }, selectedTargetId: null })],
    ["idle, the destination list loading", body({ view: null, balance: 2, targets: { status: "loading" }, selectedTargetId: null })],
    ["idle, a refused create", body({ view: null, balance: 1, targets: TARGETS, selectedTargetId: "t1", createError: { code: "storage_exhausted", holder: null } })],
    ["idle, Buy more opened", body({ view: null, balance: 2, showBuy: true, checkoutError: "owner" })],
    ["provisioning", body({ view: session({ state: "provisioning", qr: null }), balance: 2 })],
    ["warming, the QR", body({ view: session(), balance: 2, qrDataUrl: "data:image/png;base64,AAAA" })],
    ["live", body({ view: session({ state: "live", startedAt: "2026-09-14T11:50:00Z", qr: null, fixtureDecided: true, health: { fps: 30, bitrateKbps: 2900, lastBeatAt: "2026-09-14T11:59:56Z" } }), balance: 1 })],
    ["ending", body({ view: session({ state: "ending", startedAt: "2026-09-14T11:50:00Z", qr: null }), balance: 1 })],
    ["ended", body({ view: session({ state: "completed", qr: null, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", replayUrl: "https://www.youtube.com/watch?v=abc", endReason: "stopped", creditUsed: true }), balance: 1 })],
    ["failed", body({ view: session({ state: "failed", qr: null, failReason: "no_credits" }), balance: 0 })],
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

  it("balance 2 and no session: idle controls, opening at clean feed with scorebug DISABLED, the first destination selected", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" });
    expect(textAt(tree, "stream-balance")).toBe(m("stream.phone.credits.other", { n: 2 }));
    expect(attr(byTestId(tree, "stream-target")!, "value")).toBe("t1");
    expect(propsOf(byTestId(tree, "stream-mode-clean")!)["aria-checked"]).toBe(true);
    expect(propsOf(byTestId(tree, "stream-mode-clean")!).disabled, "the positive pair: clean is enabled").toBeFalsy();
    expect(propsOf(byTestId(tree, "stream-mode-scorebug")!).disabled).toBe(true); // composed is R2's; the seam is visible
    expect(propsOf(byTestId(tree, "stream-mode-scorebug")!)["aria-checked"]).toBe(false);
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
    for (const view of [null, session({ state: "live", startedAt: "2026-09-14T11:50:00Z", qr: null })]) {
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

  it("warming: the QR image (a real alt), the paste code equal to the payload (a real name), the caption, Cancel — one centred column at the QR box's own width", () => {
    const v = session();
    const tree = body({ view: v, balance: 2, qrDataUrl: "data:image/png;base64,AAAA" });
    const img = byTestId(tree, "stream-qr")!;
    expect(attr(img, "src")).toBe("data:image/png;base64,AAAA");
    expect(String(attr(img, "className"))).toContain("w-[min(264px,100%)]");
    expect(attr(img, "alt")).toBe(m("stream.phone.qr.alt"));
    const field = byTestId(tree, "stream-qr-text")!;
    expect(attr(field, "value")).toBe(JSON.stringify(v.qr));
    expect(attr(field, "readOnly")).toBe(true);
    expect(attr(field, "aria-label")).toBe(m("stream.phone.qr.field"));
    // §8a: the paste field takes the QR BOX's width — the same width class on both, so they cannot drift apart.
    const box = byTestId(tree, "stream-qr-box")!;
    const width = String(attr(box, "className")).match(/(^|\s)(max-w-\[\d+px\])(\s|$)/)?.[2];
    expect(width, "the QR box has no max width").toBeDefined();
    expect(String(attr(byTestId(tree, "stream-qr-field")!, "className")).split(/\s+/)).toContain(width);
    expect(String(attr(byTestId(tree, "stream-qr-column")!, "className"))).toMatch(/(^|\s)items-center(\s|$)/);
    expect(byTestId(tree, "stream-cancel")).toBeDefined();
    expect(textAt(tree, "stream-step")).toBe(m("stream.phone.stepOf", { n: 2, label: m("stream.phone.step2") }));
    // The copy button's accessible name at ≥ 768 (icon-only there) is its sr-only text.
    expect(textAt(tree, "stream-qr-copy")).toBe(m("stream.phone.qr.copy"));
    expect(textAt(body({ view: v, balance: 2, copied: true }), "stream-qr-copy")).toBe(m("stream.phone.qr.copied"));
  });

  it("warming before the encoder answers: a placeholder the QR's size, and the paste code is ALREADY there (§8a: always rendered)", () => {
    const tree = body({ view: session(), balance: 2, qrDataUrl: null });
    expect(byTestId(tree, "stream-qr")).toBeUndefined();
    expect(byTestId(tree, "stream-qr-text")).toBeDefined();
  });

  it("live: REC + elapsed, the health chips led by the INGEST STATE (C6), the solid red Stop; the decided chip only when decided", () => {
    const live = session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z", ingest: { state: "connected", protocol: "srt" } });
    const tree = body({ view: live, balance: 1 });
    expect(byTestId(tree, "stream-rec")).toBeDefined();
    expect(textAt(tree, "stream-elapsed")).toBe("10:00");
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
    const tree = body({ view: session({ state: "ending", qr: null, target: { id: "t1", kind: "youtube", label: "Club TV" } }), balance: 1 });
    expect(textAt(tree, "stream-ending")).toBe(m("stream.phone.ending", { destination: "Club TV" }));
    expect(byTestId(tree, "stream-stop")).toBeUndefined();
  });

  it("ended: duration; '1 credit used' ONLY when the ledger says so (D3); the replay link only with a replay; the end reason", () => {
    const base = { state: "completed" as const, qr: null, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "max_duration" as const };
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
      const never = body({ view: session({ state: "completed", qr: null, startedAt: null, endedAt: "2026-09-14T11:45:00Z", endReason, creditUsed: false }), balance: 1 });
      expect(endedChips(never), `${endReason}: one chip, and it is the never-live one`).toEqual(["stream-ended-never-live"]);
      expect(textAt(never, "stream-ended-never-live"), endReason).toBe(m("stream.phone.ended.neverLive"));
      expect(textAt(never, "stream-ended"), endReason).not.toContain(m("stream.phone.ended.duration", { duration: "0:00" }));
      expect(textAt(never, "stream-ended"), `${endReason}: the reason is not restated`).not.toContain(m(END_REASON_KEYS[endReason]));
      expect(byTestId(never, "stream-again"), endReason).toBeDefined();
      // The positive pair, UNCHANGED: once it went live the card shows its duration and its end reason — a paid stop adds
      // "1 credit used", a free restart inside the reuse window does not.
      const live = { state: "completed" as const, qr: null, startedAt: "2026-09-14T11:44:45Z", endedAt: "2026-09-14T11:45:00Z", endReason };
      const paid = body({ view: session({ ...live, creditUsed: true }), balance: 1 });
      expect(endedChips(paid), `${endReason}: paid stop`).toEqual(["stream-ended-duration", "stream-credit-used", "stream-end-reason"]);
      expect(textAt(paid, "stream-ended-duration"), endReason).toBe(m("stream.phone.ended.duration", { duration: "0:15" }));
      expect(textAt(paid, "stream-end-reason"), endReason).toBe(m(END_REASON_KEYS[endReason]));
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
    const failed = body({ view: session({ state: "failed", qr: null, failReason: "target_rejected" }), balance: 1 });
    expect(textAt(failed, "stream-fail-reason")).toBe(m(FAIL_REASON_KEYS.target_rejected));
    expect(byTestId(failed, "stream-retry")).toBeDefined();
    expect(byTestId(failed, "stream-end-reason")).toBeUndefined();
    for (const reason of ["provision_timeout", "admission_timeout"] as const) {
      expect(textAt(body({ view: session({ state: "failed", qr: null, failReason: reason }), balance: 1 }), "stream-fail-reason"), reason).toBe(m(FAIL_REASON_KEYS[reason]));
    }
  });

  it("B3: balance < 1 and no session is the heading and the credits card ONLY — no 'Ready' pill, no stepper; a credit brings both back", () => {
    const tree = body({ view: null, balance: 0 });
    expect(textOf(tree.find((el) => el.type === "h4")!)).toContain(m("stream.phone.title"));
    expect(byTestId(tree, "stream-buy-pack-5"), "the credits card").toBeDefined();
    for (const id of ["stream-state-pill", "stream-step", "stream-steps"]) expect(byTestId(tree, id), id).toBeUndefined();
    // The positive pair, one credit up: the pill and the stepper are back (and the tiles are not).
    const funded = body({ view: null, balance: 1, targets: TARGETS, selectedTargetId: "t1" });
    for (const id of ["stream-state-pill", "stream-step", "stream-steps", "stream-go-live"]) expect(byTestId(funded, id), id).toBeDefined();
    expect(byTestId(funded, "stream-buy-pack-5")).toBeUndefined();
    // …and a FAILED session at balance 0 is not idle: it keeps its pill and stepper (the no_credits failure explains itself).
    const failed = body({ view: session({ state: "failed", qr: null, failReason: "no_credits" }), balance: 0 });
    expect(byTestId(failed, "stream-state-pill")).toBeDefined();
  });

  // I-1 (lane-close review): admission waives the credit for a restart inside the fixture's reuse window
  // (stream-credits.ts `reuseWindowOpen`), so an org at balance 0 may start this match again — but the tab forced the
  // chooser at balance 0 and no path reached Go live. The projection now says so (`restartFree`) and the tab obeys it.
  it("I-1: idle at balance 0 with a FREE restart is Go live plus the free-restart line — not the forced chooser; without it, the tiles", () => {
    const free = body({ view: null, balance: 0, restartFree: true, targets: TARGETS, selectedTargetId: "t1" });
    const go = byTestId(free, "stream-go-live");
    expect(go, "a free restart at balance 0 reaches Go live").toBeDefined();
    expect(propsOf(go!).disabled, "…and it is enabled").toBeFalsy();
    let tiles = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      expect(byTestId(free, `stream-buy-pack-${pack.size}`), `no forced tile ${pack.size}`).toBeUndefined();
      tiles++;
    }
    expect(tiles, "no packs declared — the absence above would be vacuous").toBeGreaterThan(0);
    expect(textAt(free, "stream-restart-free")).toBe(m("stream.phone.restartFree"));
    // Not credits-only (B3): a startable tab keeps its pill and stepper.
    for (const id of ["stream-state-pill", "stream-step", "stream-steps"]) expect(byTestId(free, id), id).toBeDefined();
    // Still no balance chip and no Buy more — the org holds nothing to count or top up from here.
    expect(byTestId(free, "stream-balance")).toBeUndefined();

    // The positive pair, the SAME balance-0 idle with the window shut: the forced tiles, no Go live, no line.
    const shut = body({ view: null, balance: 0, restartFree: false, targets: TARGETS, selectedTargetId: "t1" });
    for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(shut, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
    expect(byTestId(shut, "stream-go-live")).toBeUndefined();
    expect(byTestId(shut, "stream-restart-free")).toBeUndefined();
    expect(byTestId(body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" }), "stream-restart-free"), "funded, window shut: no line").toBeUndefined();

    // A funded org restarting inside the window is told the same true thing: this start will not spend a credit.
    expect(textAt(body({ view: null, balance: 2, restartFree: true, targets: TARGETS, selectedTargetId: "t1" }), "stream-restart-free")).toBe(m("stream.phone.restartFree"));
    // …and only at idle, where the start is: a running or finished session never shows it.
    const up = [
      session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z", restartFree: true }),
      session({ state: "completed", qr: null, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true, restartFree: true }),
      session({ state: "failed", qr: null, failReason: "no_inbound_timeout", balance: 0, restartFree: true }),
    ];
    for (const v of up) expect(byTestId(body({ view: v, balance: 0, restartFree: true }), "stream-restart-free"), v.state).toBeUndefined();
  });

  /** The free-restart copy M-4 retired, per locale: it said the window ran "after it went live", as if each restart
   *  opened a new one. */
  const RETIRED_RESTART_FREE_COPY: Readonly<Record<string, string>> = {
    en: "Restarting this match is free for 24 hours after it went live.",
    es: "Reiniciar este partido es gratis durante 24 horas desde que empezó a emitirse.",
    fr: "Relancer ce match est gratuit pendant 24 heures après son passage en direct.",
    nl: "Deze wedstrijd opnieuw starten is gratis tot 24 uur nadat hij live ging.",
  };

  it("I-1: the free-restart line says the reuse window's own hours, in every locale", () => {
    // Taken from the relay's declaration (config.ts CREDIT_REUSE_HOURS — the hours `withinReuseWindow` counts), never
    // typed here: a window moved to 12 h leaves every locale's "24" a lie, and this is where that shows.
    let locales = 0;
    for (const l of LOCALES) {
      const line = uiDict(l)["stream.phone.restartFree"];
      expect(line?.length, `${l}: the key exists`).toBeGreaterThan(0);
      expect(line, `${l} names the window's hours`).toMatch(new RegExp(`\\b${CREDIT_REUSE_HOURS}\\b`));
      if (l !== "en") expect(line, `${l} is translated`).not.toBe(uiDict("en")["stream.phone.restartFree"]);
      // M-4 (lane-close re-review): the window is anchored on the FIRST go-live, and a restart does not extend it. The
      // retired copy ("free for 24 hours after it went live") read as a fresh window per restart; no locale keeps it.
      expect(line, `${l} still carries the retired copy`).not.toBe(RETIRED_RESTART_FREE_COPY[l]);
      locales++;
    }
    expect(locales).toBe(4);
    // The owner-ruled English, with the digit taken from the declaration as above.
    expect(uiDict("en")["stream.phone.restartFree"]).toBe(
      `Restarting this match is free within ${CREDIT_REUSE_HOURS} hours of first going live.`,
    );
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
    const live = session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: live, balance: 2, planGate: true, showBuy: true });
    expect(byTestId(tree, "stream-stop"), "a plan refusal took Stop away from a live stream").toBeDefined();
    expect(byTestId(tree, "stream-rec")).toBeDefined();
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
    const live = session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: live, balance: 1, stopFailed: true });
    expect(textAt(tree, "stream-stop-error")).toBe(m("stream.error.stop"));
    expect(attr(byTestId(tree, "stream-stop-error")!, "role")).toBe("alert");
    expect(byTestId(tree, "stream-create-error")).toBeUndefined();
    expect(byTestId(body({ view: live, balance: 1 }), "stream-stop-error"), "the empty case").toBeUndefined();
    // A later read that finds it ended makes "did not stop" false — the card must not keep saying it.
    const ended = session({ state: "completed", qr: null, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z" });
    expect(byTestId(body({ view: ended, balance: 1, stopFailed: true }), "stream-stop-error")).toBeUndefined();
  });

  it("N1/N3: the failure copy names the control ON SCREEN — Cancel before live, Stop once live — and nothing while it ends", () => {
    expect(m("stream.error.cancel"), "premise: the two sentences differ").not.toBe(m("stream.error.stop"));
    const EXPECTED: [string, StreamSessionView, string | null][] = [
      ["provisioning", session({ state: "provisioning", qr: null }), m("stream.error.cancel")],
      ["warming", session({ state: "warming" }), m("stream.error.cancel")],
      ["live", session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), m("stream.error.stop")],
      ["ending", session({ state: "ending", qr: null, startedAt: "2026-09-14T11:50:00Z" }), null],
      ["failed", session({ state: "failed", qr: null, failReason: "machine_crash" }), null],
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
    const tree = body({ view: session({ state: "failed", qr: null, failReason: null }), balance: 1 });
    expect(textAt(tree, "stream-fail-reason")).toBe(m("stream.fail.unknown"));
    expect(m("stream.fail.unknown"), "the premise: the two sentences differ").not.toBe(m(FAIL_REASON_KEYS.machine_crash));
  });

  it("m12: ending disables EVERY control — Buy more and an open chooser's tiles and Close included", () => {
    const ending = session({ state: "ending", qr: null, startedAt: "2026-09-14T11:50:00Z" });
    const tree = body({ view: ending, balance: 2, showBuy: true });
    const ids = ["stream-buy-more", "stream-credits-close", ...STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`)];
    for (const id of ids) expect(attr(byTestId(tree, id)!, "disabled"), id).toBe(true);
    // The positive pair: live, the same controls are live.
    const live = body({ view: session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true });
    for (const id of ids) expect(attr(byTestId(live, id)!, "disabled"), id).toBeFalsy();
  });

  it("N2: while a checkout sheet is open (or still loading) every tile is disabled; the positive pair enables them", () => {
    const ids = STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`);
    let checked = 0;
    for (const [name, props] of [
      ["forced, balance 0", { view: null, balance: 0 }],
      ["Buy more opened, live", { view: session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true }],
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
      ["Buy more opened, live", { view: session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true }],
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
    const tree = body({ view: session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), balance: 2, showBuy: true, onTileIntent: () => {} });
    const warmers = tree.filter((el) => typeof attr(el, "onPointerEnter") === "function");
    expect(warmers.map((el) => attr(el, "data-testid")).sort()).toEqual(STREAM_CREDIT_PACKS.map((p) => `stream-buy-pack-${p.size}`).sort());
  });

  it("B7: each native select names its selection in a title, so a clipped option is still readable", () => {
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t2" });
    expect(attr(byTestId(tree, "stream-target")!, "title")).toBe(`Alt (${platformName(m, "twitch")})`);
    expect(String(attr(byTestId(tree, "stream-target")!, "className")).split(/\s+/)).toEqual(expect.arrayContaining(["w-full", "min-w-0"]));
  });

  it("the state pill: its copy and §8a's colour per state, the live dot only when live", () => {
    const PILL_CLASS: Record<string, string> = {
      "idle, balance 2": "bg-slate-100", provisioning: "bg-amber-100", "warming, the QR": "bg-amber-100", live: "bg-red-100",
      ending: "bg-slate-100", ended: "bg-emerald-100", failed: "bg-red-50",
    };
    let checked = 0;
    for (const [name, tree] of bodyStates()) {
      if (!(name in PILL_CLASS)) continue;
      const pill = byTestId(tree, "stream-state-pill")!;
      expect(String(attr(pill, "className")), name).toContain(PILL_CLASS[name]);
      expect(Boolean(byTestId(tree, "stream-live-dot")), name).toBe(name === "live");
      checked++;
    }
    expect(checked).toBe(Object.keys(PILL_CLASS).length);
  });

  it("phone first: every stream-* control in every state carries the unprefixed 44px floor", () => {
    const TAPPABLE = /(^|\s)(min-h-11|h-11)(\s|$)/;
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

  it("the mode control is a radiogroup with arrow keys over the ENABLED options only (composed is disabled this wave)", () => {
    const both = [{ id: "clean", enabled: true }, { id: "scorebug", enabled: true }] as const;
    expect(stepRadio(both, "clean", "ArrowRight")).toBe("scorebug");
    expect(stepRadio(both, "scorebug", "ArrowRight"), "wraps").toBe("clean");
    expect(stepRadio(both, "clean", "ArrowLeft"), "wraps backwards").toBe("scorebug");
    expect(stepRadio(both, "clean", "ArrowDown")).toBe("scorebug");
    expect(stepRadio(both, "clean", "Enter"), "not an arrow").toBe("clean");
    const oneEnabled = [{ id: "clean", enabled: true }, { id: "scorebug", enabled: false }] as const;
    expect(stepRadio(oneEnabled, "clean", "ArrowRight"), "a disabled option is skipped").toBe("clean");
    // The body wires it: an arrow on the group never selects the disabled scorebug.
    const picked: string[] = [];
    const tree = body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", onMode: (x) => picked.push(x) });
    const group = byTestId(tree, "stream-mode")!;
    expect(attr(group, "role")).toBe("radiogroup");
    (propsOf(group).onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault: () => {}, currentTarget: { querySelector: () => null } });
    expect(picked).toEqual([]);
    // Roving tabindex: the checked radio is the one tab stop.
    expect(attr(byTestId(tree, "stream-mode-clean")!, "tabIndex")).toBe(0);
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
describe("PhoneTab — fetch, poll, reveal and every action, through the real v1 paths", () => {
  type Server = {
    current: StreamSessionView | null;
    targets: StreamTarget[];
    failCurrent?: boolean;
    /** The destination list's read fails (a network error) while set. */
    failTargets?: boolean;
    create?: () => unknown;
    stop?: () => unknown;
  };
  const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const };
  const CURRENT = "GET /api/v1/fixtures/f-1/stream-sessions/current";

  function serve(s: Server): Server {
    apiV1.mockImplementation(async (url, options) => {
      // Every response lands a TIMER hop later, as a network answer does — never in the same microtask run. Without it a
      // component that re-requests on every answer (a reveal per poll, say) would spin the microtask queue forever and
      // hang the runner instead of failing the count that exists to catch it.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const method = options?.method ?? "GET";
      const key = `${method} ${url}`;
      if (key === CURRENT || key === `${CURRENT}?reveal=1`) {
        if (s.failCurrent) throw new TypeError("Failed to fetch");
        // A fresh object per response, as JSON off the wire is — an identity-keyed effect must not be flattered.
        return s.current === null ? null : structuredClone(s.current);
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
  const reveals = () => calls().filter((c) => c === `${CURRENT}?reveal=1`).length;
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
    qrcode.toDataURL.mockClear();
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
    expect([...calls()].sort()).toEqual([CURRENT, "GET /api/v1/orgs/o-1/stream-targets"]);
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

  it("C1: no session → the SERVER-resolved balance; a session → its projection's fresher number, which Start another keeps", async () => {
    const idle = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(idle).balance).toBe(TAB.streamBalance);
    // 1, not the page's 3: the right answer differs from the wrong one's constant.
    const done = track(await mount({ current: session({ id: "s0", state: "completed", qr: null, balance: 1 }), targets: TARGETS }));
    expect(bodyOf(done).balance).toBe(1);
    bodyOf(done).onAgain();
    expect(bodyOf(done).view, "Start another returns the tab to idle").toBeNull();
    expect(bodyOf(done).balance, "…and keeps the fresher balance, not the page-load one").toBe(1);
  });

  // I-1: the review's own case. A restart whose phone never connected failed (no_inbound_timeout) at balance 0, inside
  // the reuse window of the match's paid go-live — admission would waive the credit, so Try again must reach Go live.
  it("I-1: a failed no_inbound_timeout session at balance 0 INSIDE the window → Try again shows Go live and no forced tiles; OUTSIDE → the tiles", async () => {
    const failed = { id: "s2", state: "failed" as const, qr: null, failReason: "no_inbound_timeout" as const, balance: 0 };
    let checked = 0;
    for (const restartFree of [true, false]) {
      const island = track(await mount({ current: session({ ...failed, restartFree }), targets: TARGETS }));
      expect(bodyOf(island).restartFree, `${restartFree}: the container hands the projection's answer down`).toBe(restartFree);
      expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-retry"), "Try again is on the failed card").toBeDefined();
      bodyOf(island).onAgain();
      const b = bodyOf(island);
      expect(b.view, "Try again returns the tab to idle").toBeNull();
      expect(b.balance, "the projection's balance, kept").toBe(0);
      // …and the answer survives the dismiss: it is the FIXTURE's window, not the dismissed card's.
      expect(b.restartFree, `${restartFree}: kept across Try again`).toBe(restartFree);
      const tree = walk(expandWithHooks(PhoneTabBody, b));
      if (restartFree) {
        expect(byTestId(tree, "stream-go-live"), "inside the window: Go live").toBeDefined();
        expect(byTestId(tree, "stream-buy-pack-5"), "inside the window: no forced tiles").toBeUndefined();
        expect(byTestId(tree, "stream-restart-free")).toBeDefined();
      } else {
        expect(byTestId(tree, "stream-go-live"), "outside the window: no Go live").toBeUndefined();
        for (const pack of STREAM_CREDIT_PACKS) expect(byTestId(tree, `stream-buy-pack-${pack.size}`), `tile ${pack.size}`).toBeDefined();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("I-1: the balance-0 ENDED card still offers Start another, and it leads to Go live inside the window", async () => {
    const ended = session({ id: "s1", state: "completed", qr: null, startedAt: "2026-09-14T11:00:00Z", endedAt: "2026-09-14T11:45:00Z", endReason: "stopped", creditUsed: true, balance: 0, restartFree: true });
    const island = track(await mount({ current: ended, targets: TARGETS }));
    expect(byTestId(walk(expandWithHooks(PhoneTabBody, bodyOf(island))), "stream-again"), "Start another at balance 0").toBeDefined();
    bodyOf(island).onAgain();
    const tree = walk(expandWithHooks(PhoneTabBody, bodyOf(island)));
    expect(byTestId(tree, "stream-go-live")).toBeDefined();
    expect(byTestId(tree, "stream-buy-pack-5")).toBeUndefined();
    // The go-live it leads to POSTs a create like any other; the server (createSession → reuseWindowOpen) decides.
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled, "a destination is selected").toBeFalsy();
  });

  it("opens at the FIRST destination (created_at order, as the route returns it) and at clean feed; no destination → none selected", async () => {
    const two = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(two).selectedTargetId).toBe("t1");
    expect(bodyOf(two).mode).toBe("clean");
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

  it("a poll is not a reveal (De): the QR's first showing reveals ONCE, polls never do, Copy does, and the next session reveals once more", async () => {
    const s = { current: session(), targets: TARGETS };
    const island = track(await mount(s));
    expect(reveals(), "the QR's first showing").toBe(1);
    const before = plainPolls();
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS * 3);
    await settle();
    expect(plainPolls() - before, "three polls ran").toBe(3);
    expect(reveals(), "polls are not reveals").toBe(1);
    // The QR is encoded CLIENT-side from the payload itself, with §7.6's settings — ONCE per payload (m10): every poll is
    // a fresh object off the wire, and an effect keyed on the object re-encoded the same symbol on each.
    expect(qrcode.toDataURL).toHaveBeenCalledWith(qrText(QR), QR_RENDER_OPTIONS);
    expect(qrcode.toDataURL, "the same payload was re-encoded per poll").toHaveBeenCalledTimes(1);
    expect(bodyOf(island).qrDataUrl).toBe(`data:image/png;base64,len${qrText(QR).length}`);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    bodyOf(island).onCopy();
    await settle();
    expect(writeText).toHaveBeenCalledWith(qrText(QR));
    expect(bodyOf(island).copied).toBe(true);
    expect(reveals(), "taking the paste code IS a reveal").toBe(2);
    // m4: the next session carries a DIFFERENT payload. Until the encoder answers for it, there is no image — never the
    // previous session's symbol under the new session's paste code.
    const QR2: CaptureQrV1 = { ...QR, sid: "7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6" };
    expect(qrText(QR2), "premise: the two payloads differ").not.toBe(qrText(QR));
    let answer: (url: string) => void = () => {};
    qrcode.toDataURL.mockImplementationOnce(() => new Promise<string>((resolve) => { answer = resolve; }));
    s.current = session({ id: "s2", qr: QR2 });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(reveals(), "a new session's QR is a new disclosure").toBe(3);
    expect(qrcode.toDataURL).toHaveBeenLastCalledWith(qrText(QR2), QR_RENDER_OPTIONS);
    expect(bodyOf(island).qrDataUrl, "s1's symbol was painted over s2's payload").toBeNull();
    answer("data:image/png;base64,S2");
    await settle();
    expect(bodyOf(island).qrDataUrl).toBe("data:image/png;base64,S2");
  });

  it("m5: a clipboard that REFUSES is neither a reveal nor 'Copied'", async () => {
    const island = track(await mount({ current: session(), targets: TARGETS }));
    expect(reveals()).toBe(1);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => { throw new Error("NotAllowedError"); });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    bodyOf(island).onCopy();
    await settle();
    expect(writeText, "the copy was attempted").toHaveBeenCalledTimes(1);
    expect(reveals(), "nothing was taken, so nothing was disclosed").toBe(1);
    expect(bodyOf(island).copied).toBe(false);
  });

  it("§7.6's encoding settings are the sheet's: EC-M and a 4-module quiet zone", () => {
    const sheet = readFileSync(SHEET_PATH, "utf8");
    const row = sheet.split("\n").find((l) => l.startsWith("| QR encoding |"));
    expect(row, "§8a lost its QR encoding row").toBeDefined();
    expect(row!).toMatch(/EC-M/);
    expect(row!).toMatch(/4-module quiet zone/);
    expect(QR_RENDER_OPTIONS).toMatchObject({ errorCorrectionLevel: "M", margin: 4 });
  });

  it("polls while a session is in flight and STOPS once it is terminal — nothing polls behind an ended card", async () => {
    const s = { current: session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS };
    const island = track(await mount(s));
    s.current = session({ state: "completed", qr: null });
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
    const s = serve({ current: session({ id: "s0", state: "completed", qr: null, balance: 0 }), targets: TARGETS });
    s.create = () => { throw new ApiV1Error("no credits", 402, "no_credits", { featureKey: "streaming.relay" }); };
    const island = track(await mount(s));
    bodyOf(island).onAgain();
    bodyOf(island).onGoLive();
    await settle();
    expect(bodyOf(island).view, "the old session came back over the refusal").toBeNull();
    expect(bodyOf(island).createError).toEqual({ code: "no_credits", holder: null });
    // An active_session refusal is the other way round: the running session IS the answer, so it is shown.
    const running = session({ id: "s9", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" });
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
    const s = serve({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
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
    s.current = session({ id: "s1", state: "completed", qr: null, startedAt: "2026-09-14T11:50:00Z", endedAt: "2026-09-14T11:58:00Z", endReason: "stopped", creditUsed: true });
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
    const s = serve({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    s.stop = () => session({ id: "s1", state: "ending", qr: null });
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
    s.stop = () => session({ id: "s1", state: "completed", qr: null });
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
    went.stop = () => session({ id: "s1", state: "ending", qr: null });
    const live = track(await mount(went));
    went.current = session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:59:00Z" });
    confirmMock.mockResolvedValueOnce(false);
    let base = stops();
    bodyOf(live).onCancel();
    await settle();
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger", title: m("stream.phone.stop.title"), ...STOP_CONFIRM_EXTRAS }));
    expect(stops() - base, "a declined confirm still stopped a live stream").toBe(0);
    expect(bodyOf(live).view?.state, "the card shows what the read found").toBe("live");

    // The read fails: nobody knows whether it is on air, so it is the confirming stop.
    const blind = serve({ current: session({ id: "s1" }), targets: TARGETS });
    blind.stop = () => session({ id: "s1", state: "ending", qr: null });
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
    gone.current = session({ id: "s1", state: "failed", qr: null, failReason: "admission_timeout" });
    confirmMock.mockClear();
    base = stops();
    bodyOf(done).onCancel();
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(stops() - base).toBe(0);
    expect(bodyOf(done).view?.state).toBe("failed");
  });

  it("D14: a refused stop reads the server again (it may already have ended); only a failed read says so", async () => {
    const s = serve({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
    s.stop = () => { s.current = session({ id: "s1", state: "completed", qr: null }); throw new ApiV1Error("not running", 409, "not_active"); };
    const ended = track(await mount(s));
    bodyOf(ended).onStop();
    await settle();
    expect(bodyOf(ended).view?.state, "server state is the truth").toBe("completed");
    expect(bodyOf(ended).createError).toBeNull();

    const down = serve({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS });
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
    const live = session({ state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z", balance: 2 });
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

  describe("PhoneStopProbe — an org without the relay can still stop what is on air (G2)", () => {
    async function probe(s: Server) {
      serve(s);
      const island = track(renderIsland(PhoneStopProbe, { fixtureId: "f-1" }));
      await settle();
      return island;
    }

    it("no session, or a finished one: renders NOTHING, and reads only `current` — never the org's destinations", async () => {
      let checked = 0;
      for (const current of [null, session({ state: "completed", qr: null }), session({ state: "failed", qr: null })]) {
        apiV1.mockClear();
        const island = await probe({ current, targets: TARGETS });
        expect(island.tree(), String(current?.state)).toEqual([]);
        expect(calls(), String(current?.state)).toEqual([CURRENT]);
        checked++;
      }
      expect(checked).toBe(3);
    });

    it("live: the pill (announced), REC + elapsed and a confirming Stop that POSTs THIS session's stop", async () => {
      const s = { current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS } as Server;
      s.stop = () => { s.current = session({ id: "s1", state: "ending", qr: null }); return s.current; };
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
      s.current = session({ id: "s1", state: "completed", qr: null });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(island.tree()).toEqual([]);
    });

    it("F1: a probe the frozen division page mounts NAMES its fixture; a row's own probe (no label) adds no line", async () => {
      const live = () => ({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS }) as Server;
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
      click(byTestId(island.tree(), "stream-cancel"));
      await settle();
      expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
      // N1: a failed CANCEL says so, and names the Cancel button still on screen — never "tap Stop stream again".
      expect(textAt(island.tree(), "stream-stop-error")).toBe(m("stream.error.cancel"));
      expect(byTestId(island.tree(), "stream-cancel"), "the control the copy names").toBeDefined();
    });

    it("N3: a stop that LANDED behind a lost response says nothing once a read finds it ending", async () => {
      const s = { current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS } as Server;
      s.stop = () => { s.failCurrent = true; throw new TypeError("Failed to fetch"); };
      const island = await probe(s);
      click(byTestId(island.tree(), "stream-stop"));
      await settle();
      expect(textAt(island.tree(), "stream-stop-error"), "premise: the stop could not be confirmed").toBe(m("stream.error.stop"));
      // The network comes back and the stop had in fact landed.
      s.failCurrent = false;
      s.current = session({ id: "s1", state: "ending", qr: null, startedAt: "2026-09-14T11:50:00Z" });
      await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
      await settle();
      expect(byTestId(island.tree(), "stream-ending")).toBeDefined();
      expect(byTestId(island.tree(), "stream-stop-error"), "'did not stop' beside 'ending'").toBeUndefined();
    });

    // m3 (lane-close fix, ruled 2026-09-29): a first read that FAILED is not an answer. Before, the probe read "no view"
    // as idle, idle as terminal, and never polled — so a stream on air behind one dropped request left the organiser
    // with no Stop until a reload. It now keeps reading at STREAM_POLL_MS until a read lands, and stops once one does.
    it("m3: a FAILED first read keeps polling at STREAM_POLL_MS until a read lands — then shows the live stream's Stop", async () => {
      const s = { current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS, failCurrent: true } as Server;
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
      for (const answer of [null, session({ id: "s1", state: "completed", qr: null })]) {
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
    const s = serve({ current: session({ id: "s1", state: "live", qr: null, startedAt: "2026-09-14T11:50:00Z" }), targets: TARGETS, failCurrent: true });
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

  it("the list's first read is LOADING, then ok; a FAILED read is the error state (never 'none'), and Retry re-reads it and selects the first destination", async () => {
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
    expect(bodyOf(island).selectedTargetId, "t2 was removed in Directory: the first remaining").toBe("t1");
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
    const s = serve({ current: session({ id: "s5", state: "failed", qr: null, failReason: "target_rejected" }), targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onAgain();
    expect(bodyOf(island).view).toBeNull();
    expect(bodyOf(island).selectedTargetId).toBe("t1");
  });
});
