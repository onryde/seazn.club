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
//   * `TargetForm` — its own island (it holds state).
// What none of this can see — layout, the cascade, a real Stripe iframe, a
// real server — is the browser pass and Task 15's walkthrough.
//
// One sport, on purpose: the Phone tab reads no sport (the relay is
// sport-agnostic); the W1 style-strip describes above sweep three.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { renderIsland, propsOf, walk, expandWithHooks, textOf } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { UpgradeGate } from "@/components/upgrade-gate";
import { defaultThemeFor, themesForSport } from "@/components/overlay/theme-registry";
import { ApiV1Error } from "@/lib/client-v1";
import type { CaptureQrV1 } from "@/lib/capture-qr";
import { messages, type MessageKey } from "@/lib/messages";
import { STREAM_CREDIT_PACKS } from "@/lib/stream-credit-packs";
import { DESTINATION_NOT_ALLOWED, destinationRefusal, type DestinationRefusal } from "@/lib/stream-destinations";
import {
  DESTINATION_REFUSAL_KEYS,
  END_REASON_KEYS,
  FAIL_REASON_KEYS,
  STREAM_POLL_MS,
  qrText,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { StreamTargetKind, type StreamTarget } from "@/server/api-v1/schemas";
import {
  FixtureStreamPanel,
  FixtureStreamToggle,
  PhoneTab,
  PhoneTabBody,
  QR_RENDER_OPTIONS,
  TARGET_KINDS,
  TargetForm,
  CANVAS_H,
  CANVAS_W,
  PREVIEW_MAX_W_PX,
  previewScaleFor,
  stepRadio,
  type PhoneTabBodyProps,
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

// Both `?stream=open` readers (the panel's tab and the toggle's auto-open) call `useSearchParams`.
const searchParamsMock = vi.hoisted(() => {
  let p = new URLSearchParams("");
  return { set: (n: URLSearchParams) => { p = n; }, get: () => p };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => searchParamsMock.get(),
}));

// D17: the embedded-checkout trio, doubled the way pass-checkout-parity.test.tsx does it.
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
    sportKey: "football",
    overlayDict: {},
    viewerPlan: "community",
    orgId: "o-1",
    streamBalance: 3,
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

beforeEach(() => {
  apiV1.mockReset();
  apiV1.mockImplementation(async () => ({}));
  fetchOverlayFixture.mockClear();
  searchParamsMock.set(new URLSearchParams(""));
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

describe("the preview is the real stage, seeded from the row", () => {
  it("renders <OverlayStage> inside the strip, on the row's own fixture", () => {
    const tree = open().tree();
    expect(byTestId(tree, "stream-preview"), "the 360px strip").toBeDefined();
    const stage = stageOf(tree);
    expect(propsOf(stage).fixtureId).toBe(FIXTURE.id);
    expect(propsOf(stage).fit, "the console preview scales its own wrapper").toBeFalsy();
    expect(propsOf(stage).realtime, "the console never opens a realtime channel").toBe(false);
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

/** The checksummed contract's own valid payload (docs/contracts) — a real QR, not one typed here. */
const QR = JSON.parse(
  readFileSync(join(__dirname, "../../../../../..", "docs/contracts/fixtures/capture-qr.v1/valid.json"), "utf8"),
) as CaptureQrV1;

const session = (over: Partial<StreamSessionView> = {}): StreamSessionView => ({
  id: "s1", fixtureId: "f-1", mode: "passthrough", state: "warming", desiredState: "live",
  failReason: null, health: null, ingest: { state: "disconnected", protocol: null },
  qr: QR, balance: 2, startedAt: null, endedAt: null, replayUrl: null,
  target: { id: "t1", kind: "youtube", label: "Club" }, fixtureDecided: false, endReason: null, creditUsed: false,
  ...over,
});

const TARGETS: StreamTarget[] = [
  { id: "t1", kind: "youtube", label: "Club", watchUrl: null, createdAt: "2026-09-01T10:00:00.000Z" },
  { id: "t2", kind: "twitch", label: "Alt", watchUrl: null, createdAt: "2026-09-02T10:00:00.000Z" },
];

describe("the Phone tab reads the §5.3 gate, then hands the container the context (D15)", () => {
  const phone = (o: Partial<StreamPanelContext>) => {
    const island = open(o);
    click(byTestId(island.tree(), "stream-tab-phone"));
    return island;
  };

  it("without streaming.relay it is the UpgradeGate for THAT key, and no session control", () => {
    const tree = phone({ relayEntitled: false }).tree();
    expect(byTestId(tree, "stream-phone-gate"), "the gate card").toBeDefined();
    const gate = tree.find((el) => el.type === UpgradeGate);
    expect(gate, "no <UpgradeGate>").toBeDefined();
    expect(propsOf(gate!).feature).toBe("streaming.relay");
    expect(tree.find((el) => el.type === PhoneTab), "no container behind the gate").toBeUndefined();
  });

  it("with streaming.relay it mounts the container with THIS row's fixture and the page's org, balance and plan", () => {
    const tree = phone({ relayEntitled: true, orgId: "o-77", streamBalance: 4, viewerPlan: "pro" }).tree();
    expect(tree.find((el) => el.type === UpgradeGate), "no upsell once entitled").toBeUndefined();
    const tab = tree.find((el) => el.type === PhoneTab);
    expect(tab, "the Phone tab body is not the container").toBeDefined();
    // Each value differs from ctx()'s default, so a prop wired to the wrong field (or a constant) cannot pass.
    expect(propsOf(tab!)).toMatchObject({ fixtureId: FIXTURE.id, orgId: "o-77", streamBalance: 4, viewerPlan: "pro" });
  });

  it("buying is the EMBEDDED checkout in the repo's Modal, never a navigation (owner ruling 8) — the source half", () => {
    // The behaviour is driven below (PhoneTab — checkout). This pins the negative the node harness cannot drive: no
    // hosted-checkout hop anywhere in the module.
    const src = readFileSync(join(__dirname, "..", "fixture-stream-panel.tsx"), "utf8");
    expect(src).toMatch(/EmbeddedCheckoutProvider/);
    expect(src).toMatch(/data-testid="stream-checkout-modal"/);
    expect(src).toMatch(/fetchRelayCheckoutClientSecret/);
    expect(src).not.toMatch(/window\.location\.assign|checkout\.stripe\.com/);
    // C22: the 402 gate is read off STATUS — `CheckoutSecretResult` has no code field.
    expect(src).toMatch(/result\.status === 402/);
    expect(src).not.toMatch(/result\.code/);
    // C1: the idle tab's balance has a source when there is no session.
    expect(src).toMatch(/view \? view\.balance : streamBalance/);
    // De: the reveal flag exists.
    expect(src).toMatch(/\?reveal=1/);
    // The legacy transport prefixes nothing and drops the extras (404s here) — v1 only.
    expect(src).not.toMatch(/from "@\/lib\/client"/);
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
      // The Phone tab's own controls live in `PhoneTabBody` / `TargetForm`; their floor is swept state by state below.
    }
    // The positive pair: without it an empty tree passes every check above. Two passes × (the registry's style tabs +
    // the six OBS-tab controls) — derived from the registry, so a fourth theme moves the floor with it.
    expect(seen.length, "nothing was checked").toBe(2 * (themesForSport("football").length + 6));
    expect(seen.length).toBeGreaterThanOrEqual(16);
  });

  it("and the toggle in the row itself does too", () => {
    const button = renderIsland(FixtureStreamToggle, { open: false, onToggle: () => {}, fixtureId: "f-1" })
      .tree()
      .find((el) => attr(el, "data-testid") === "fixture-stream-toggle");
    expect(String(propsOf(button!).className ?? "")).toMatch(TAPPABLE);
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
    for (const [name, tree] of bodyStates()) {
      const hidden = tree.filter((el) => /(^|\s)(max-)?md:hidden(\s|$)/.test(String(propsOf(el).className ?? "")));
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
  });
});

describe("the toggle", () => {
  it("carries the wave's testid, an accessible name and its expanded state", () => {
    const tree = renderIsland(FixtureStreamToggle, { open: false, onToggle: () => {}, fixtureId: "f-1" }).tree();
    const button = byTestId(tree, "fixture-stream-toggle");
    expect(button, "no fixture-stream-toggle").toBeDefined();
    expect(propsOf(button!)["aria-expanded"]).toBe(false);
    expect(propsOf(button!)["aria-label"]).toBe(messages["stream.toggle"]);
  });
});

// ─── The checkout return (owner ruling 4, re-ruled on C19) ────────────────────────────────────────────────────────
describe("the checkout return opens THIS row's panel on the Phone tab", () => {
  const RETURN = "tab=fixtures&fixture=f1&stream=open&checkout=success&session_id=cs_test_1";

  it("?stream=open&fixture=<this id> fires onToggle once; another fixture's id, an absent query, and an already-open row do not", () => {
    const calls: string[] = [];
    searchParamsMock.set(new URLSearchParams(RETURN));
    renderIsland(FixtureStreamToggle, { open: false, fixtureId: "f1", onToggle: () => calls.push("f1") });
    expect(calls, "the row this URL names opens itself").toEqual(["f1"]);
    // The three negatives, each on its own — two guards covering for each other are each untested (class 3).
    renderIsland(FixtureStreamToggle, { open: false, fixtureId: "f2", onToggle: () => calls.push("f2") });
    searchParamsMock.set(new URLSearchParams("tab=fixtures&fixture=f1"));
    renderIsland(FixtureStreamToggle, { open: false, fixtureId: "f1", onToggle: () => calls.push("no-flag") });
    searchParamsMock.set(new URLSearchParams(""));
    renderIsland(FixtureStreamToggle, { open: false, fixtureId: "f1", onToggle: () => calls.push("bare") });
    searchParamsMock.set(new URLSearchParams(RETURN));
    renderIsland(FixtureStreamToggle, { open: true, fixtureId: "f1", onToggle: () => calls.push("already") });
    expect(calls, "no other row, no bare URL, and never a toggle on an open row").toEqual(["f1"]);
  });

  it("the second render is not a second open: once the organiser shuts the row, it STAYS shut (class 13, the ref)", () => {
    const calls: number[] = [];
    searchParamsMock.set(new URLSearchParams(RETURN));
    const onToggle = () => calls.push(calls.length);
    const island = renderIsland(FixtureStreamToggle, { open: false, fixtureId: "f1", onToggle });
    expect(calls).toHaveLength(1);
    island.rerender({ open: true, fixtureId: "f1", onToggle }); // the row opened
    island.rerender({ open: false, fixtureId: "f1", onToggle }); // the organiser shut it — the URL still says open
    expect(calls, "a shut row sprang back open").toHaveLength(1);
  });

  it("the panel it opens starts on the PHONE tab for that fixture, and on OBS for any other", () => {
    searchParamsMock.set(new URLSearchParams(RETURN.replace("fixture=f1", `fixture=${FIXTURE.id}`)));
    const here = open({ relayEntitled: true }).tree();
    expect(attr(byTestId(here, "stream-tab-phone")!, "aria-selected")).toBe(true);
    expect(byTestId(here, "stream-phone-gate"), "the Phone tab body").toBeDefined();
    searchParamsMock.set(new URLSearchParams(RETURN.replace("fixture=f1", "fixture=some-other-row")));
    const other = open({ relayEntitled: true }).tree();
    expect(attr(byTestId(other, "stream-tab-obs")!, "aria-selected")).toBe(true);
    expect(byTestId(other, "stream-phone-gate")).toBeUndefined();
    searchParamsMock.set(new URLSearchParams(`tab=fixtures&fixture=${FIXTURE.id}`));
    expect(attr(byTestId(open({ relayEntitled: true }).tree(), "stream-tab-obs")!, "aria-selected"), "no flag, no Phone tab").toBe(true);
  });
});

// ─── PhoneTabBody: every §8a / §8b state from the projection alone ──────────────────────────────────────────────────
const NOW = new Date("2026-09-14T12:00:00Z");
const BODY: PhoneTabBodyProps = {
  view: null, balance: 0, targets: [], busy: false, createError: null, checkoutError: null,
  selectedTargetId: null, mode: "clean", qrDataUrl: null, now: NOW, copied: false, showTargetForm: false, showBuy: false,
  onSelectTarget: () => {}, onAddTarget: () => {}, onMode: () => {}, onGoLive: () => {}, onStop: () => {}, onCancel: () => {},
  onBuy: () => {}, onAgain: () => {}, onCopy: () => {}, onShowBuy: () => {}, onSaveTarget: async () => {},
};
const body = (p: Partial<PhoneTabBodyProps> = {}): ReactElement[] => walk(expandWithHooks(PhoneTabBody, { ...BODY, ...p }));
const textAt = (tree: ReactElement[], id: string): string => {
  const el = byTestId(tree, id);
  if (!el) throw new Error(`no ${id} in the tree`);
  return textOf(el).replace(/\s+/g, " ").trim();
};

/** Every state the body renders, named — the sweeps below iterate THIS list and assert they read all of it. */
function bodyStates(): [string, ReactElement[]][] {
  return [
    ["idle, balance 0 (the credits card)", body({ view: null, balance: 0 })],
    ["idle, balance 2", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1" })],
    ["idle, the destination form open", body({ view: null, balance: 2, targets: TARGETS, selectedTargetId: "t1", showTargetForm: true })],
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

  it("no destination yet: the select says to add one and Go live is disabled — the empty case", () => {
    const tree = body({ view: null, balance: 2, targets: [], selectedTargetId: null });
    expect(textAt(tree, "stream-target")).toBe(m("stream.phone.destination.none"));
    expect(propsOf(byTestId(tree, "stream-go-live")!).disabled).toBe(true);
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

  it("a refused create shows the E5 create-error copy, keyed by code; target_in_use NAMES the court (D12)", () => {
    const tree = body({ view: null, balance: 1, createError: { code: "storage_exhausted", holder: null } });
    expect(textAt(tree, "stream-create-error")).toBe(m("stream.error.storage_exhausted"));
    const named = body({ view: null, balance: 1, createError: { code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel" } } });
    expect(textAt(named, "stream-create-error")).toBe(m("stream.error.target_in_use", { destination: "Club channel", court: "Court 3" }));
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

  it("failed: the reason copy, Try again — and no end-reason chip (P1-F-b: a failed row carries none)", () => {
    const failed = body({ view: session({ state: "failed", qr: null, failReason: "target_rejected" }), balance: 1 });
    expect(textAt(failed, "stream-fail-reason")).toBe(m(FAIL_REASON_KEYS.target_rejected));
    expect(byTestId(failed, "stream-retry")).toBeDefined();
    expect(byTestId(failed, "stream-end-reason")).toBeUndefined();
    for (const reason of ["provision_timeout", "admission_timeout"] as const) {
      expect(textAt(body({ view: session({ state: "failed", qr: null, failReason: reason }), balance: 1 }), "stream-fail-reason"), reason).toBe(m(FAIL_REASON_KEYS[reason]));
    }
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

// ─── TargetForm (D10, D11) ─────────────────────────────────────────────────────────────────────────────────────────
describe("TargetForm — the platform is labelled, the ingest URL is checked BEFORE it is sent", () => {
  type Save = PhoneTabBodyProps["onSaveTarget"];
  const form = (onSave: Save = async () => {}) => renderIsland(TargetForm, { onSave, onCancel: () => {} });
  const type = (island: ReturnType<typeof form>, id: string, value: string) =>
    (propsOf(byTestId(island.tree(), id)!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const submit = async (island: ReturnType<typeof form>) => {
    await (propsOf(byTestId(island.tree(), "stream-target-form")!).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    await Promise.resolve();
  };
  const fill = (island: ReturnType<typeof form>, rtmpUrl: string) => {
    type(island, "stream-target-label", "Club channel");
    type(island, "stream-target-rtmp", rtmpUrl);
    type(island, "stream-target-key", "live-key-123");
  };

  it("the kind select offers exactly the StreamTargetKind enum, opens at YouTube, and never shows a raw enum id (no LinkedIn)", () => {
    expect([...TARGET_KINDS]).toEqual([...StreamTargetKind.options]);
    const tree = form().tree();
    const select = byTestId(tree, "stream-target-kind")!;
    expect(attr(select, "value")).toBe("youtube");
    const options = walk(propsOf(select).children as ReactElement[]).filter((el) => el.type === "option");
    expect(options.map((o) => attr(o, "value"))).toEqual([...StreamTargetKind.options]);
    const labels = options.map((o) => textOf(o));
    expect(labels).toEqual(["YouTube", "Facebook", "Twitch", "Kick", m("stream.target.kind.other")]);
    for (const l of labels) expect(l).not.toMatch(/custom_rtmp|linkedin/i);
  });

  it("an ingest URL the allowlist refuses is refused INLINE, by its rule, and never sent (D10)", async () => {
    // The rulebook is lane C's validator: each URL's premise is asserted against it, then the FORM must show that rule's copy.
    const ROWS: [string, DestinationRefusal][] = [
      ["rtmps://evil.example/live2", "host"],
      ["https://a.rtmps.youtube.com/live2", "scheme"],
      ["rtmps://a.rtmps.youtube.com", "path"],
    ];
    let checked = 0;
    for (const [url, rule] of ROWS) {
      expect(destinationRefusal(url), `premise: ${url}`).toBe(rule);
      const onSave = vi.fn<Save>(async () => {});
      const island = form(onSave);
      fill(island, url);
      await submit(island);
      expect(onSave, url).not.toHaveBeenCalled();
      expect(textAt(island.tree(), "stream-target-error"), url).toBe(m(DESTINATION_REFUSAL_KEYS[rule]));
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("an allowed URL is sent — with surrounding whitespace too, which the server trims (it is not a refusal)", async () => {
    const onSave = vi.fn<Save>(async () => {});
    const island = form(onSave);
    fill(island, "  rtmps://a.rtmps.youtube.com/live2 ");
    await submit(island);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ kind: "youtube", label: "Club channel", streamKey: "live-key-123" });
    expect(byTestId(island.tree(), "stream-target-error")).toBeUndefined();
  });

  it("the server's 422 DESTINATION_NOT_ALLOWED shows the SAME rule copy; any other failure the generic one", async () => {
    const refused = form(async () => { throw new ApiV1Error("refused", 422, DESTINATION_NOT_ALLOWED, { rule: "port" }); });
    fill(refused, "rtmps://a.rtmps.youtube.com/live2");
    await submit(refused);
    expect(textAt(refused.tree(), "stream-target-error")).toBe(m(DESTINATION_REFUSAL_KEYS.port));
    const other = form(async () => { throw new ApiV1Error("The stream key is empty", 422, "ERROR"); });
    fill(other, "rtmps://a.rtmps.youtube.com/live2");
    await submit(other);
    expect(textAt(other.tree(), "stream-target-error")).toBe(m("stream.target.error"));
  });

  it("every field and button carries the unprefixed 44px floor", () => {
    const TAPPABLE = /(^|\s)(min-h-11|h-11)(\s|$)/;
    const tree = form().tree();
    let seen = 0;
    for (const el of tree) {
      if (!["button", "select", "input"].includes(String(el.type))) continue;
      seen++;
      expect(String(attr(el, "className") ?? ""), String(attr(el, "data-testid") ?? el.type)).toMatch(TAPPABLE);
    }
    expect(seen).toBe(7); // label, kind, url, key, watch, save, cancel
  });
});

// ─── PhoneTab: the container, driven (D15) ─────────────────────────────────────────────────────────────────────────
describe("PhoneTab — fetch, poll, reveal and every action, through the real v1 paths", () => {
  type Server = {
    current: StreamSessionView | null;
    targets: StreamTarget[];
    failCurrent?: boolean;
    create?: () => unknown;
    stop?: () => unknown;
    saveTarget?: (json: unknown) => unknown;
  };
  const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, viewerPlan: "pro" as const };
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
      if (key === "GET /api/v1/orgs/o-1/stream-targets") return s.targets;
      if (key === "POST /api/v1/orgs/o-1/stream-targets") return s.saveTarget!(options?.json);
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
    expect(island.tree().find((el) => el.type === PhoneTabBody)).toBeUndefined();
    expect([...calls()].sort()).toEqual([CURRENT, "GET /api/v1/orgs/o-1/stream-targets"]);
    await settle();
    expect(byTestId(island.tree(), "stream-loading")).toBeUndefined();
    expect(bodyOf(island).view, "no session: idle").toBeNull();
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

  it("opens at the FIRST destination (created_at order, as the route returns it) and at clean feed; no destination → none selected", async () => {
    const two = track(await mount({ current: null, targets: TARGETS }));
    expect(bodyOf(two).selectedTargetId).toBe("t1");
    expect(bodyOf(two).mode).toBe("clean");
    expect(bodyOf(two).targets.map((t) => t.id)).toEqual(["t1", "t2"]);
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
    // The QR is encoded CLIENT-side from the payload itself, with §7.6's settings.
    expect(qrcode.toDataURL).toHaveBeenCalledWith(qrText(QR), QR_RENDER_OPTIONS);
    expect(bodyOf(island).qrDataUrl).toBe(`data:image/png;base64,len${qrText(QR).length}`);
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    bodyOf(island).onCopy();
    await settle();
    expect(writeText).toHaveBeenCalledWith(qrText(QR));
    expect(bodyOf(island).copied).toBe(true);
    expect(reveals(), "taking the paste code IS a reveal").toBe(2);
    s.current = session({ id: "s2" });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_MS);
    await settle();
    expect(reveals(), "a new session's QR is a new disclosure").toBe(3);
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

  it("refusals: target_in_use carries the holder (D12); a plan refusal from CREATE is the UpgradeGate, never a retry", async () => {
    const s = serve({ current: null, targets: TARGETS });
    s.create = () => { throw new ApiV1Error("in use", 409, "target_in_use", { holder: { fixtureId: "f-9", courtName: "Court 3", label: "Club" } }); };
    const inUse = track(await mount(s));
    bodyOf(inUse).onGoLive();
    await settle();
    expect(bodyOf(inUse).createError).toEqual({ code: "target_in_use", holder: { courtName: "Court 3", label: "Club" } });

    const plan = serve({ current: null, targets: TARGETS });
    plan.create = () => { throw new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature: "x", feature_key: "streaming.relay", reason: "This feature needs a plan upgrade." }); };
    const gated = track(await mount(plan));
    bodyOf(gated).onGoLive();
    await settle();
    const gate = gated.tree().find((el) => el.type === UpgradeGate);
    expect(gate, "the plan refusal is not the upgrade surface").toBeDefined();
    expect(propsOf(gate!)).toMatchObject({ feature: "streaming.relay", compact: true, viewerPlan: "pro" });
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
    expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
    expect(bodyOf(island).view?.state).toBe("ending");
  });

  it("Cancel on the QR stops the session WITHOUT the on-air confirm — nothing is broadcasting yet", async () => {
    const s = serve({ current: session({ id: "s1" }), targets: TARGETS });
    s.stop = () => session({ id: "s1", state: "completed", qr: null });
    const island = track(await mount(s));
    bodyOf(island).onCancel();
    await settle();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(calls()).toContain("POST /api/v1/fixtures/f-1/stream-sessions/s1/stop");
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
    expect(bodyOf(offline).createError).toEqual({ code: "unknown", holder: null });
  });

  it("checkout (owner ruling 8): the secret up front, then the EMBEDDED checkout in the repo's Modal; 402 → the gate; 403 → owner copy; anything else → checkout copy (D13)", async () => {
    checkout.fetch.mockResolvedValueOnce({ ok: true, clientSecret: "cs_test_secret_1" });
    const island = track(await mount({ current: null, targets: TARGETS }));
    bodyOf(island).onShowBuy();
    bodyOf(island).onBuy(5);
    await settle();
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "o-1", fixtureId: "f-1", pack: 5 });
    const tree = island.tree();
    expect(tree.find((el) => el.type === Modal), "no Modal").toBeDefined();
    expect(propsOf(tree.find((el) => el.type === Modal)!).title).toBe(m("stream.credits.title"));
    expect(byTestId(tree, "stream-checkout-modal")).toBeDefined();
    const provider = tree.find((el) => el.type === EmbeddedCheckoutProvider);
    expect(propsOf(provider!).options).toEqual({ clientSecret: "cs_test_secret_1" });
    expect(propsOf(provider!).stripe).toBe(stripe.promise);
    expect(bodyOf(island).showBuy, "the chooser closes behind the sheet").toBe(false);
    // closing the sheet unmounts it
    (propsOf(tree.find((el) => el.type === Modal)!).onClose as () => void)();
    expect(island.tree().find((el) => el.type === Modal)).toBeUndefined();

    let checked = 0;
    for (const [status, expected] of [[403, "owner"], [400, "unknown"], [503, "unknown"], [null, "unknown"]] as const) {
      checkout.fetch.mockResolvedValueOnce({ ok: false, error: "no", status });
      const refused = track(await mount({ current: null, targets: TARGETS }));
      bodyOf(refused).onBuy(1);
      await settle();
      expect(bodyOf(refused).checkoutError, String(status)).toBe(expected);
      expect(bodyOf(refused).createError, "never the create copy").toBeNull();
      expect(refused.tree().find((el) => el.type === Modal)).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(4);

    checkout.fetch.mockResolvedValueOnce({ ok: false, error: "plan_lacks_relay", status: 402 });
    const gated = track(await mount({ current: null, targets: TARGETS }));
    bodyOf(gated).onBuy(20);
    await settle();
    expect(propsOf(gated.tree().find((el) => el.type === UpgradeGate)!)).toMatchObject({ feature: "streaming.relay", viewerPlan: "pro" });
  });

  it("D11: re-saving the SAME destination replaces its row (A19 answers with the existing one); a new one is appended and selected", async () => {
    const s = serve({ current: null, targets: TARGETS });
    s.saveTarget = () => ({ ...TARGETS[0]!, label: "Club HQ" });
    const island = track(await mount(s));
    bodyOf(island).onAddTarget();
    expect(bodyOf(island).showTargetForm).toBe(true);
    bodyOf(island).onSelectTarget("t2");
    const resaved = bodyOf(island).onSaveTarget({ kind: "youtube", label: "Club HQ", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k", watchUrl: "" });
    await settle();
    await resaved;
    expect(bodyOf(island).targets.map((t) => t.id), "a duplicate option / React key").toEqual(["t1", "t2"]);
    expect(bodyOf(island).targets[0]!.label).toBe("Club HQ");
    expect(bodyOf(island).selectedTargetId).toBe("t1");
    expect(bodyOf(island).showTargetForm).toBe(false);
    const post = apiV1.mock.calls.find(([url, o]) => url === "/api/v1/orgs/o-1/stream-targets" && o?.method === "POST");
    expect(post?.[1]?.json, "an empty watch link is omitted, never sent as ''").toEqual({ kind: "youtube", label: "Club HQ", rtmpUrl: "rtmps://a.rtmps.youtube.com/live2", streamKey: "k" });
    s.saveTarget = () => ({ id: "t3", kind: "custom_rtmp", label: "Vimeo", watchUrl: null, createdAt: "2026-09-03T10:00:00.000Z" });
    const added = bodyOf(island).onSaveTarget({ kind: "custom_rtmp", label: "Vimeo", rtmpUrl: "rtmps://rtmp-global.cloud.vimeo.com/live", streamKey: "k2", watchUrl: "https://vimeo.com/123" });
    await settle();
    await added;
    expect(bodyOf(island).targets.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(bodyOf(island).selectedTargetId).toBe("t3");
  });

  it("Try again on a failed session is the same return to idle as Start another — the refusal cleared, the destination kept", async () => {
    const s = serve({ current: session({ id: "s5", state: "failed", qr: null, failReason: "target_rejected" }), targets: TARGETS });
    const island = track(await mount(s));
    bodyOf(island).onAgain();
    expect(bodyOf(island).view).toBeNull();
    expect(bodyOf(island).selectedTargetId).toBe("t1");
  });
});
