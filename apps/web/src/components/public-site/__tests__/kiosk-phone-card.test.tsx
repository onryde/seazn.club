// OWNER RULING C1 (2026-09-15) — the kiosk on a phone. A /present board (and
// an organiser noticeboard) opened below the TV cut-off shows a full-screen
// card, "This board is made for a TV", with Open the live page, and below it a
// small Show the board anyway that shows the board exactly as it is today,
// broken phone layout included. It replaces the "made for a TV" banner (N1d
// d6), which has no surface left once the card exists.
//
// Controller rulings built here (not the owner's): the card is below 1024px
// (Tailwind lg, the banner's old cut-off); which of card and board shows is
// decided by CSS classes, never a JS width read, so neither flashes at any
// width; the choice is remembered on the device through localStorage, wrapped
// so a throwing storage cannot break the board; a board chosen anyway carries
// no banner.
//
// Two layers. The PURE pieces (`kiosk-phone-card-logic.ts`): the hub link and
// the remembered choice. The GATE's wiring: which classes each state renders,
// the remembered choice read after mount, and the Show the board anyway tap.
//
// How the gate is witnessed without a DOM. Real React answers
// `useSyncExternalStore` with the SERVER snapshot on the server and on
// hydration's first client pass: that is "no choice yet", the plain render
// below. The "browser" cases swap it for a reader of the CLIENT snapshot, so
// the gate's own snapshot function reads a stubbed `window.localStorage`.
//
// What this cannot see, and e2e/kiosk-phone-card.spec.ts exists for: that
// `lg:hidden` / `max-lg:hidden` actually hide at a real viewport, a resize
// swapping them with no reload, the painted 44px, a tap landing, the choice
// surviving a real reload, and the card at 320 with nothing cut off.
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

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { readDivisionParam } from "../use-tab-param";
import {
  KIOSK_BOARD_CHOSEN_STORAGE_KEY,
  kioskHubHref,
  readBoardChosen,
  writeBoardChosen,
} from "../kiosk-phone-card-logic";
import { KioskPhoneGate } from "../kiosk-phone-card";

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the pure pieces ----------------------------------------------------------

describe("kioskHubHref: where Open the live page goes on a public kiosk", () => {
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

describe("the remembered choice: localStorage, and a browser whose storage throws", () => {
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

  it("one key, and it reads back what it wrote", () => {
    expect(KIOSK_BOARD_CHOSEN_STORAGE_KEY).toBe("seazn:kiosk-board-chosen");
    const { data, storage } = memory();
    expect(readBoardChosen(() => storage)).toBe(false);
    expect(writeBoardChosen(() => storage)).toBe(true);
    expect([...data.entries()]).toEqual([[KIOSK_BOARD_CHOSEN_STORAGE_KEY, "1"]]);
    expect(readBoardChosen(() => storage)).toBe(true);
  });

  it("any other stored value is not a choice", () => {
    for (const value of ["0", "", "true", "yes"]) {
      const { data, storage } = memory();
      data.set(KIOSK_BOARD_CHOSEN_STORAGE_KEY, value);
      expect(readBoardChosen(() => storage), JSON.stringify(value)).toBe(false);
    }
  });

  it("storage whose ACCESS throws (blocked site data): reads no choice, the write reports failure, neither throws", () => {
    const denied = () => {
      throw new Error("SecurityError");
    };
    expect(readBoardChosen(denied)).toBe(false);
    expect(writeBoardChosen(denied)).toBe(false);
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
    expect(readBoardChosen(() => broken)).toBe(false);
    expect(writeBoardChosen(() => broken)).toBe(false);
  });

  it("no storage at all: no choice, and nothing written", () => {
    expect(readBoardChosen(() => null)).toBe(false);
    expect(writeBoardChosen(() => null)).toBe(false);
  });
});

// --- the gate -----------------------------------------------------------------

const HREF = "/shared/club/spring-cup?division=under-12s";
const LABELS = {
  title: "(made for a tv)",
  openLive: "(open the live page)",
  showBoard: "(show the board anyway)",
};
const BOARD = createElement("div", { "data-probe": "board" }, "the board");
const props = { liveHref: HREF, labels: LABELS, children: BOARD };
const gate = () => createElement(KioskPhoneGate, props);

function stubBrowser({ stored = null, storage = "ok" }: { stored?: string | null; storage?: "ok" | "access-throws" | "calls-throw" } = {}) {
  const data = new Map<string, string>();
  if (stored !== null) data.set(KIOSK_BOARD_CHOSEN_STORAGE_KEY, stored);
  const setItem = vi.fn((k: string, v: string) => {
    if (storage === "calls-throw") throw new Error("QuotaExceededError");
    data.set(k, v);
  });
  const getItem = vi.fn((k: string) => {
    if (storage === "calls-throw") throw new Error("SecurityError");
    return data.get(k) ?? null;
  });
  const win: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(win, "localStorage", {
    get() {
      if (storage === "access-throws") throw new Error("SecurityError");
      return { getItem, setItem };
    },
  });
  vi.stubGlobal("window", win);
  return { data, setItem, getItem };
}

/** The opening tag carrying `data-testid="<id>"`, or null. */
const tagOf = (html: string, id: string) => new RegExp(`<[a-z]+\\b[^>]*\\bdata-testid="${id}"[^>]*>`).exec(html)?.[0] ?? null;
/** A class list is a SET: exact tokens, never a regex (`lg:hidden` is a substring of `max-lg:hidden`). */
const classesIn = (tag: string) => new Set((/\bclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean));
/** Tokens that put a box on screen at lg and up, which would undo `lg:hidden`. */
const SHOWN_AT_LG = /^(?:lg|xl|2xl):(?:block|flex|grid|inline|inline-block|inline-flex|inline-grid|contents|table|flow-root)$/;
const hiddenTokens = (classes: Set<string>) => [...classes].filter((c) => /(?:^|:)hidden$/.test(c));

const byTestId = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);

describe("<KioskPhoneGate>: before any choice (the server render, and hydration's first pass)", () => {
  beforeEach(() => {
    store.browser = false;
  });

  it("renders the card AND the board; CSS picks one: the card hides from lg up, the board hides below lg", () => {
    stubBrowser();
    const html = renderToStaticMarkup(gate());
    const card = tagOf(html, "kiosk-phone-card");
    const board = tagOf(html, "kiosk-board");
    expect(card, "the card is rendered").not.toBeNull();
    expect(board, "the board wrapper is rendered").not.toBeNull();
    expect(html).toContain('data-probe="board"');

    const cardClasses = classesIn(card!);
    const boardClasses = classesIn(board!);
    expect(hiddenTokens(cardClasses), "the card: hidden from lg up, and at no other breakpoint").toEqual(["lg:hidden"]);
    expect([...cardClasses].filter((c) => SHOWN_AT_LG.test(c)), "nothing shows the card again at lg+").toEqual([]);
    expect(hiddenTokens(boardClasses), "the board: hidden below lg, and at no other breakpoint").toEqual(["max-lg:hidden"]);
  });

  it("a stored choice does not change the server render: the device's choice is read after mount, the width only by CSS", () => {
    stubBrowser({ stored: "1" });
    const html = renderToStaticMarkup(gate());
    expect(tagOf(html, "kiosk-phone-card")).not.toBeNull();
    expect(hiddenTokens(classesIn(tagOf(html, "kiosk-board")!))).toEqual(["max-lg:hidden"]);
  });

  it("the card is a region named by its heading, with the live link and a Show the board anyway button, each a 44px target with a visible focus ring", () => {
    stubBrowser();
    const html = renderToStaticMarkup(gate());
    const card = tagOf(html, "kiosk-phone-card")!;
    const labelledBy = /\baria-labelledby="([^"]+)"/.exec(card)?.[1];
    expect(labelledBy, "the card names itself by a heading").toBeTruthy();
    expect(html).toMatch(new RegExp(`<h[12][^>]*\\bid="${labelledBy}"[^>]*>${LABELS.title.replace(/[()]/g, "\\$&")}</h[12]>`));

    const live = tagOf(html, "kiosk-phone-card-open-live");
    expect(live, "Open the live page").toMatch(/^<a\b/);
    expect(live).toContain(`href="${HREF}"`);
    expect(html).toMatch(new RegExp(`data-testid="kiosk-phone-card-open-live"[^>]*>${LABELS.openLive.replace(/[()]/g, "\\$&")}</a>`));

    const show = tagOf(html, "kiosk-phone-card-show-board");
    expect(show, "Show the board anyway").toMatch(/^<button\b/);
    expect(show).toContain('type="button"');
    expect(html).toMatch(new RegExp(`data-testid="kiosk-phone-card-show-board"[^>]*>${LABELS.showBoard.replace(/[()]/g, "\\$&")}</button>`));

    // A class, not a measurement: the e2e measures the painted box.
    for (const [what, tag] of [["live link", live!], ["show board", show!]] as const) {
      const classes = classesIn(tag);
      expect(classes.has("min-h-11"), `${what}: 44px floor`).toBe(true);
      expect(classes.has("focus-visible:outline-2"), `${what}: focus ring`).toBe(true);
    }
  });

  it("the card is not part of the board: it comes before it, holds none of it, and carries no slide animation", () => {
    stubBrowser();
    const html = renderToStaticMarkup(gate());
    const cardAt = html.indexOf('data-testid="kiosk-phone-card"');
    const boardAt = html.indexOf('data-testid="kiosk-board"');
    expect(cardAt).toBeGreaterThanOrEqual(0);
    expect(cardAt).toBeLessThan(boardAt);
    expect(html.slice(cardAt, boardAt)).not.toContain('data-probe="board"');
    expect([...classesIn(tagOf(html, "kiosk-phone-card")!)].filter((c) => c.startsWith("animate-"))).toEqual([]);
  });

  it("the retired TV hint banner is nowhere", () => {
    stubBrowser();
    expect(renderToStaticMarkup(gate())).not.toContain("kiosk-tv-hint");
  });
});

describe("<KioskPhoneGate>: a device that already chose the board", () => {
  beforeEach(() => {
    store.browser = true;
  });

  it("no card, and the board is hidden at no width", () => {
    stubBrowser({ stored: "1" });
    const html = renderToStaticMarkup(gate());
    expect(tagOf(html, "kiosk-phone-card")).toBeNull();
    expect(hiddenTokens(classesIn(tagOf(html, "kiosk-board")!))).toEqual([]);
    expect(html).toContain('data-probe="board"');
  });

  it("no stored choice once mounted: the card, and the board still hidden below lg", () => {
    stubBrowser();
    const html = renderToStaticMarkup(gate());
    expect(tagOf(html, "kiosk-phone-card")).not.toBeNull();
    expect(hiddenTokens(classesIn(tagOf(html, "kiosk-board")!))).toEqual(["max-lg:hidden"]);
  });

  it.each(["access-throws", "calls-throw"] as const)(
    "storage that %s cannot remember a choice and does not break the page: the card shows",
    (storage) => {
      stubBrowser({ storage });
      let html = "";
      expect(() => {
        html = renderToStaticMarkup(gate());
      }).not.toThrow();
      expect(tagOf(html, "kiosk-phone-card")).not.toBeNull();
    },
  );
});

describe("<KioskPhoneGate>: Show the board anyway", () => {
  beforeEach(() => {
    store.browser = true;
  });

  it("remembers the choice under the key and shows the board at once, in this visit", () => {
    const { setItem, data } = stubBrowser();
    const island = renderIsland(KioskPhoneGate, props);
    expect(byTestId(island.tree(), "kiosk-phone-card")).toHaveLength(1);
    const [show] = byTestId(island.tree(), "kiosk-phone-card-show-board");

    (propsOf(show!).onClick as () => void)();

    expect(setItem).toHaveBeenCalledWith(KIOSK_BOARD_CHOSEN_STORAGE_KEY, "1");
    expect(data.get(KIOSK_BOARD_CHOSEN_STORAGE_KEY)).toBe("1");
    expect(byTestId(island.tree(), "kiosk-phone-card")).toHaveLength(0);
    const [board] = byTestId(island.tree(), "kiosk-board");
    expect(hiddenTokens(new Set(String(propsOf(board!).className ?? "").split(/\s+/).filter(Boolean)))).toEqual([]);
  });

  it("with storage that throws on write, still shows the board for this visit, and does not throw", () => {
    const { setItem } = stubBrowser({ storage: "calls-throw" });
    const island = renderIsland(KioskPhoneGate, props);
    const [show] = byTestId(island.tree(), "kiosk-phone-card-show-board");

    expect(() => (propsOf(show!).onClick as () => void)()).not.toThrow();

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(byTestId(island.tree(), "kiosk-phone-card")).toHaveLength(0);
  });
});
