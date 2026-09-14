// N1d d6 — the public /present kiosk is built for a screen across a hall, and a
// spectator who opens its link on a phone got a TV board squeezed into 390px
// with no way to the page made for them. The kiosk now pins a banner over the
// top on a narrow viewport: "Made for a TV or big screen", a link to the hub
// (filtered to the division on a division kiosk), Full screen where the
// browser has the API, and a ✕ remembered in localStorage.
//
// Two layers here. The PURE pieces (`kiosk-tv-hint-logic.ts`): the hub link,
// the show/hide rule, the storage read/write that must survive a browser that
// throws, and the Fullscreen API probe. And the COMPONENT's wiring of them.
//
// How the component is witnessed without a DOM. Real React answers
// `useSyncExternalStore` with the SERVER snapshot on the server and on
// hydration's first client pass; that is the "no banner until mounted" rule,
// and the plain render below keeps that answer. The "browser" cases swap
// `useSyncExternalStore` for a reader of the CLIENT snapshot, so the
// component's own snapshot functions run against a stubbed `window` and
// `document`: the media query it asks, the storage it reads, the API it probes.
//
// What this cannot see, and e2e/kiosk-tv-hint.spec.ts exists for: a real
// resize or rotation reaching the subscription, the 44px hit area as painted
// (a `min-h-11` class in the markup is not a measurement), a reload reading
// the stored dismissal back, and the page at 320 without horizontal scroll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const store = vi.hoisted(() => ({ browser: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <T,>(
      _subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T => (store.browser || getServerSnapshot === undefined ? getSnapshot() : getServerSnapshot()),
  };
});

import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { readDivisionParam } from "../use-tab-param";
import {
  KIOSK_TV_HINT_QUERY,
  KIOSK_TV_HINT_STORAGE_KEY,
  canRequestFullscreen,
  kioskHubHref,
  readTvHintDismissed,
  shouldShowTvHint,
  writeTvHintDismissed,
} from "../kiosk-tv-hint-logic";
import { KioskTvHint, subscribeToNarrowViewport } from "../kiosk-tv-hint";

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the pure pieces ----------------------------------------------------------

describe("kioskHubHref: the hub page a phone should open instead", () => {
  it("a competition kiosk links the competition's hub, with no filter", () => {
    expect(kioskHubHref("club", "spring-cup")).toBe("/shared/club/spring-cup");
    expect(kioskHubHref("club", "spring-cup", null)).toBe("/shared/club/spring-cup");
    expect(kioskHubHref("club", "spring-cup", "")).toBe("/shared/club/spring-cup");
  });

  it("a division kiosk links the same hub filtered to its division, and the hub's own reader reads that division back", () => {
    const href = kioskHubHref("club", "spring-cup", "under-12s");
    expect(href).toBe("/shared/club/spring-cup?division=under-12s");

    vi.stubGlobal("window", { location: { search: new URL(href, "https://seazn.test").search } });
    expect(readDivisionParam()).toBe("under-12s");
  });
});

describe("shouldShowTvHint: narrow and not dismissed, nothing else", () => {
  it.each([
    { narrow: true, dismissed: false, show: true },
    { narrow: true, dismissed: true, show: false },
    { narrow: false, dismissed: false, show: false },
    { narrow: false, dismissed: true, show: false },
  ])("narrow=$narrow dismissed=$dismissed -> $show", ({ narrow, dismissed, show }) => {
    expect(shouldShowTvHint({ narrow, dismissed })).toBe(show);
  });
});

describe("the remembered dismissal: localStorage, and a browser whose storage throws", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    };
  };

  it("uses the key the brief names, and reads back what it wrote", () => {
    expect(KIOSK_TV_HINT_STORAGE_KEY).toBe("seazn:kiosk-tv-hint-dismissed");
    const { data, storage } = memory();
    expect(readTvHintDismissed(() => storage)).toBe(false);
    expect(writeTvHintDismissed(() => storage)).toBe(true);
    expect([...data.keys()]).toEqual([KIOSK_TV_HINT_STORAGE_KEY]);
    expect(readTvHintDismissed(() => storage)).toBe(true);
  });

  it("storage whose ACCESS throws (blocked site data): reads not-dismissed, the write reports failure, neither throws", () => {
    const denied = () => {
      throw new Error("SecurityError");
    };
    expect(readTvHintDismissed(denied)).toBe(false);
    expect(writeTvHintDismissed(denied)).toBe(false);
  });

  it("storage whose CALLS throw (private mode, quota): the same", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readTvHintDismissed(() => broken)).toBe(false);
    expect(writeTvHintDismissed(() => broken)).toBe(false);
  });

  it("no storage at all: not dismissed, and nothing written", () => {
    expect(readTvHintDismissed(() => null)).toBe(false);
    expect(writeTvHintDismissed(() => null)).toBe(false);
  });
});

describe("canRequestFullscreen: the button exists only where the API does", () => {
  it("true with a requestFullscreen function on the root element; false without one, or without a document", () => {
    expect(canRequestFullscreen({ documentElement: { requestFullscreen: () => Promise.resolve() } })).toBe(true);
    expect(canRequestFullscreen({ documentElement: {} })).toBe(false);
    expect(canRequestFullscreen(undefined)).toBe(false);
  });
});

// --- the component ------------------------------------------------------------

const HREF = "/shared/club/spring-cup?division=under-12s";
const LABELS = {
  region: "(region name)",
  message: "(made for a tv)",
  phoneView: "(open phone view)",
  fullScreen: "(full screen)",
  dismiss: "(dismiss)",
};
const hint = () => createElement(KioskTvHint, { hubHref: HREF, labels: LABELS });

/** A browser's answer to a `(max-width: Npx)` query at `width`. Any other
 *  query shape fails the test rather than being guessed at. */
function matchesWidth(query: string, width: number): boolean {
  const m = /^\(max-width:\s*(\d+)px\)$/.exec(query);
  if (!m) throw new Error(`unexpected media query: ${query}`);
  return width <= Number(m[1]);
}

interface BrowserOpts {
  width: number;
  stored?: string | null;
  storage?: "ok" | "access-throws" | "calls-throw";
  fullscreen?: boolean;
}

function stubBrowser({ width, stored = null, storage = "ok", fullscreen = true }: BrowserOpts) {
  const data = new Map<string, string>();
  if (stored !== null) data.set(KIOSK_TV_HINT_STORAGE_KEY, stored);
  const setItem = vi.fn((k: string, v: string) => {
    if (storage === "calls-throw") throw new Error("QuotaExceededError");
    data.set(k, v);
  });
  const getItem = vi.fn((k: string) => {
    if (storage === "calls-throw") throw new Error("SecurityError");
    return data.get(k) ?? null;
  });
  const added: (() => void)[] = [];
  const removed: (() => void)[] = [];
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    matches: matchesWidth(query, width),
    addEventListener: (type: string, fn: () => void) => {
      if (type === "change") added.push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type === "change") removed.push(fn);
    },
  }));
  const win: Record<string, unknown> = { matchMedia };
  Object.defineProperty(win, "localStorage", {
    get() {
      if (storage === "access-throws") throw new Error("SecurityError");
      return { getItem, setItem };
    },
  });
  vi.stubGlobal("window", win);
  const requestFullscreen = vi.fn(() => Promise.resolve());
  vi.stubGlobal("document", { documentElement: fullscreen ? { requestFullscreen } : {} });
  return { data, setItem, matchMedia, added, removed, requestFullscreen };
}

const byTestId = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);

describe("<KioskTvHint>: when it shows", () => {
  beforeEach(() => {
    store.browser = false;
  });

  it("the server render, and hydration's first client pass: nothing, even on a phone", () => {
    stubBrowser({ width: 390 });
    expect(renderToStaticMarkup(hint())).toBe("");
  });

  it("a phone (390) once mounted: a named region with the message, the hub link, Full screen, and a labelled ✕", () => {
    stubBrowser({ width: 390 });
    store.browser = true;
    const html = renderToStaticMarkup(hint());

    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-label="${LABELS.region}"`);
    expect(html).toContain('data-testid="kiosk-tv-hint"');
    expect(html).toContain(`>${LABELS.message}<`);
    expect(html).toMatch(new RegExp(`<a[^>]*href="${HREF.replace(/[?]/g, "\\?")}"[^>]*>${LABELS.phoneView.replace(/[()]/g, "\\$&")}</a>`));
    expect(html).toContain(`>${LABELS.fullScreen}</button>`);
    expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${LABELS.dismiss.replace(/[()]/g, "\\$&")}"`));
    // The 44px floor as a class on all three controls. A class, not a
    // measurement: the e2e measures the painted box.
    expect(html.match(/\bmin-h-11\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it.each([
    { width: 320, show: true },
    { width: 1023, show: true },
    { width: 1024, show: false },
    { width: 1280, show: false },
  ])("width $width -> shown: $show, from the browser's answer to the kiosk's media query", ({ width, show }) => {
    const { matchMedia } = stubBrowser({ width });
    store.browser = true;
    expect(renderToStaticMarkup(hint()) !== "").toBe(show);
    expect(matchMedia).toHaveBeenCalledWith(KIOSK_TV_HINT_QUERY);
    expect(KIOSK_TV_HINT_QUERY).toBe("(max-width: 1023px)");
  });

  it("a dismissal remembered in storage keeps it hidden on a phone", () => {
    stubBrowser({ width: 390, stored: "1" });
    store.browser = true;
    expect(renderToStaticMarkup(hint())).toBe("");
  });

  it.each(["access-throws", "calls-throw"] as const)(
    "storage that %s cannot remember a dismissal, and does not break the board: the hint shows",
    (storage) => {
      stubBrowser({ width: 390, storage });
      store.browser = true;
      expect(renderToStaticMarkup(hint())).toContain('data-testid="kiosk-tv-hint"');
    },
  );

  it("no Fullscreen API: no Full screen button, and the link and ✕ stay", () => {
    stubBrowser({ width: 390, fullscreen: false });
    store.browser = true;
    const html = renderToStaticMarkup(hint());
    expect(html).toContain('data-testid="kiosk-tv-hint-phone-view"');
    expect(html).toContain('data-testid="kiosk-tv-hint-dismiss"');
    expect(html).not.toContain("kiosk-tv-hint-full-screen");
    expect(html).not.toContain(LABELS.fullScreen);
  });
});

describe("<KioskTvHint>: its controls", () => {
  beforeEach(() => {
    store.browser = true;
  });

  it("✕ hides it and writes the dismissal under the key", () => {
    const { setItem, data } = stubBrowser({ width: 390 });
    const island = renderIsland(KioskTvHint, { hubHref: HREF, labels: LABELS });
    const [dismiss] = byTestId(island.tree(), "kiosk-tv-hint-dismiss");
    expect(propsOf(dismiss!)["aria-label"]).toBe(LABELS.dismiss);

    (propsOf(dismiss!).onClick as () => void)();

    expect(setItem).toHaveBeenCalledWith(KIOSK_TV_HINT_STORAGE_KEY, "1");
    expect(data.get(KIOSK_TV_HINT_STORAGE_KEY)).toBe("1");
    expect(byTestId(island.tree(), "kiosk-tv-hint")).toHaveLength(0);
  });

  it("✕ with storage that throws on write still hides it for this visit, and does not throw", () => {
    const { setItem } = stubBrowser({ width: 390, storage: "calls-throw" });
    const island = renderIsland(KioskTvHint, { hubHref: HREF, labels: LABELS });
    expect(byTestId(island.tree(), "kiosk-tv-hint")).toHaveLength(1);
    const [dismiss] = byTestId(island.tree(), "kiosk-tv-hint-dismiss");

    expect(() => (propsOf(dismiss!).onClick as () => void)()).not.toThrow();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(byTestId(island.tree(), "kiosk-tv-hint")).toHaveLength(0);
  });

  it("Full screen asks the document's root element for full screen, once", () => {
    const { requestFullscreen } = stubBrowser({ width: 390 });
    const island = renderIsland(KioskTvHint, { hubHref: HREF, labels: LABELS });
    const [full] = byTestId(island.tree(), "kiosk-tv-hint-full-screen");

    (propsOf(full!).onClick as () => void)();

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(byTestId(island.tree(), "kiosk-tv-hint"), "the banner stays until dismissed").toHaveLength(1);
  });

  it("subscribes to the query's change event (a resize or rotation) and lets go of the same listener", () => {
    const { matchMedia, added, removed } = stubBrowser({ width: 390 });
    const onChange = vi.fn();

    const off = subscribeToNarrowViewport(onChange);
    expect(matchMedia).toHaveBeenCalledWith(KIOSK_TV_HINT_QUERY);
    expect(added.length).toBe(1);
    added[0]!();
    expect(onChange).toHaveBeenCalledTimes(1);

    off();
    expect(removed).toEqual(added);
  });
});

// N1e e2 (review-n1d m2) — the ✕ was the last item of the wrapping controls
// group, so on a phone (and in es/fr/nl, whose buttons are wide) it wrapped
// onto a row of its own at the bottom left. The banner is now two rows: the
// message and the ✕, then the two buttons, which wrap only among themselves.
// Where the ✕ lands on screen is e2e/kiosk-tv-hint.spec.ts's to measure; this
// pins the structure that puts it there.
describe("<KioskTvHint>: the ✕ shares the first row with the message (N1e e2)", () => {
  beforeEach(() => {
    store.browser = true;
  });

  /** The test ids of the elements rendered inside `el`, in document order. */
  const idsInside = (el: ReactElement) =>
    walk(propsOf(el).children as ReactElement)
      .map((child) => propsOf(child)["data-testid"])
      .filter((id): id is string => typeof id === "string");

  it("row 1 is the message then the ✕, and does not wrap; row 2 is the two buttons, and never holds the ✕", () => {
    stubBrowser({ width: 320 });
    const tree = renderIsland(KioskTvHint, { hubHref: HREF, labels: LABELS }).tree();
    const [top] = byTestId(tree, "kiosk-tv-hint-top");
    const [actions] = byTestId(tree, "kiosk-tv-hint-actions");
    expect(top, "a first row").toBeDefined();
    expect(actions, "a second row").toBeDefined();

    expect(idsInside(top!)).toEqual(["kiosk-tv-hint-message", "kiosk-tv-hint-dismiss"]);
    expect(idsInside(actions!)).toEqual(["kiosk-tv-hint-phone-view", "kiosk-tv-hint-full-screen"]);
    expect(
      tree.map((el) => propsOf(el)["data-testid"]).filter((id) => id === "kiosk-tv-hint-top" || id === "kiosk-tv-hint-actions"),
      "row 1 comes first",
    ).toEqual(["kiosk-tv-hint-top", "kiosk-tv-hint-actions"]);
    expect(String(propsOf(top!).className), "row 1 never wraps the ✕ below the message").not.toMatch(/\bflex-wrap\b/);
  });
});

// N1e e8 (review-n1d G3) — iOS Safari 13 and older give a MediaQueryList with
// no `addEventListener`, only the legacy `addListener`/`removeListener`. The
// subscription runs in a passive effect, so a throw there took the whole kiosk
// to the error screen.
describe("subscribeToNarrowViewport: an old Safari's MediaQueryList (N1e e8)", () => {
  function stubLegacyMatchMedia(api: "legacy" | "none") {
    const added: (() => void)[] = [];
    const removed: (() => void)[] = [];
    const list: Record<string, unknown> = { media: KIOSK_TV_HINT_QUERY, matches: true };
    if (api === "legacy") {
      list.addListener = (fn: () => void) => void added.push(fn);
      list.removeListener = (fn: () => void) => void removed.push(fn);
    }
    const matchMedia = vi.fn(() => list);
    vi.stubGlobal("window", { matchMedia });
    return { list, matchMedia, added, removed };
  }

  it("no addEventListener: subscribes through addListener, and lets go of the same listener through removeListener", () => {
    const { list, added, removed } = stubLegacyMatchMedia("legacy");
    expect("addEventListener" in list, "the premise: an old Safari list").toBe(false);
    const onChange = vi.fn();

    let off: () => void = () => undefined;
    expect(() => {
      off = subscribeToNarrowViewport(onChange);
    }).not.toThrow();
    expect(added).toEqual([onChange]);
    added[0]!();
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(() => off()).not.toThrow();
    expect(removed).toEqual([onChange]);
  });

  it("neither API: no subscription and no throw (the banner keeps the width it read first)", () => {
    const { matchMedia } = stubLegacyMatchMedia("none");
    const off = subscribeToNarrowViewport(vi.fn());
    expect(matchMedia).toHaveBeenCalledWith(KIOSK_TV_HINT_QUERY);
    expect(() => off()).not.toThrow();
  });
});
