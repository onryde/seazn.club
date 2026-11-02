// Match Day E2 item 6 — the Remote scoring panel can be put away: "Hide ✕" on the open panel, one row ("Remote scoring · Scorer
// link ready  [Show QR] [Copy link]") when hidden, the choice remembered per court in sessionStorage, and a default that depends
// on whether a hand-over is the next step. All of it is OPT-IN (`hide`): the fixture console's mount of the same panel must not
// change, so the first block pins the panel WITHOUT the prop.
//
// Driven through the REAL component's own handlers under `renderIsland` (apps/web vitest has no DOM). The `apiV1` double keeps
// the real `ApiV1Error` class; every POST/DELETE is recorded, so "Copy link never revokes" and "Show QR never reissues" are
// assertions about the wire, not about a label. The hook harness attaches no DOM refs, so keyboard focus hand-over is the e2e's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DeviceLinkPanel, type DeviceLinkHide } from "@/components/v2/device-link-panel";
import { SeaznQrImage } from "@/components/v2/seazn-qr-image";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { messages } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

type Link = { id: string; label: string | null; expires_at: string | null; created_at: string };

const api = vi.hoisted(() => ({
  posts: [] as string[],
  deletes: [] as string[],
  active: null as Link | null,
  refuse: null as { message: string; status: number; code: string } | null,
  /** The FIRST read (a GET) fails, as a transient error or a non-editor's 403 would. */
  failRead: false,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        api.posts.push(url);
        if (api.refuse !== null) throw new actual.ApiV1Error(api.refuse.message, api.refuse.status, api.refuse.code);
        // ENSURE: re-shows the live link, or makes the first one.
        api.active ??= { id: "l-new", label: null, expires_at: null, created_at: "2026-10-31T11:00:00.000Z" };
        return { ...api.active, secret: "dl_sealed_secret" };
      }
      if (options?.method === "DELETE") {
        api.deletes.push(url);
        return {};
      }
      if (options?.method === undefined) {
        if (api.failRead) throw new Error("read failed");
        return api.active;
      }
      throw new Error(`device-link-panel-hide.test.tsx's apiV1 double has no case for ${options.method} ${url}`);
    }),
  };
});

vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: vi.fn(async () => ({ src: "data:image/svg+xml;charset=utf-8,DLINK", modules: 57 })),
}));

const SEALED: Link = { id: "l1", label: null, expires_at: null, created_at: "2026-10-31T10:00:00.000Z" };
const ORIGIN = "https://sheets.example";
const KEY = "seazn.matchDay.scorer.c-3";
const PROPS = { fixtureId: "f1", sportKey: "badminton", viewerPlan: "pro" as const, embedded: true, compact: true };
const t = (key: Parameters<typeof tRuntime>[1], vars?: Record<string, string | number>) => tRuntime(messages, key, vars);
const HEADING = <h3 id="md-scorer-f1">Remote scoring</h3>;
const hide = (o: Partial<DeviceLinkHide> = {}): DeviceLinkHide => ({ storageKey: KEY, heading: HEADING, initiallyOpen: true, followLink: false, ...o });

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
const click = (el: ReactElement | undefined) => {
  if (el === undefined) throw new Error("the control to click did not render");
  (propsOf(el).onClick as () => void)();
};
const state = (tree: ReactElement[]) => {
  const panel = tree.find((el) => propsOf(el)["data-role"] === "device-link-panel");
  return panel === undefined ? null : ((propsOf(panel)["data-hide-state"] as string | undefined) ?? "none");
};
const dlinkQr = (tree: ReactElement[]) => tree.find((el) => el.type === SeaznQrImage && propsOf(el).testId === "dlink-qr");

/** A `sessionStorage` the test can read back, and the `window` pieces the storage hook touches. */
let store: Map<string, string>;
let clipboard: string[];
function stubBrowser(opts: { throws?: boolean; clipboard?: "ok" | "missing" | "denied" } = {}) {
  store = new Map();
  clipboard = [];
  const storage = {
    getItem: (k: string) => {
      if (opts.throws) throw new Error("SecurityError");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
  };
  vi.stubGlobal("window", {
    location: { origin: ORIGIN },
    get sessionStorage() {
      if (opts.throws) throw new Error("SecurityError");
      return storage;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const mode = opts.clipboard ?? "ok";
  vi.stubGlobal(
    "navigator",
    mode === "missing"
      ? {}
      : { clipboard: { writeText: async (text: string) => (mode === "denied" ? Promise.reject(new Error("NotAllowedError")) : void clipboard.push(text)) } },
  );
}

beforeEach(() => {
  api.posts = [];
  api.deletes = [];
  api.active = SEALED;
  api.refuse = null;
  api.failRead = false;
  stubBrowser();
});
afterEach(() => vi.unstubAllGlobals());

describe("without the `hide` prop the panel is exactly what it was (the fixture console's mount)", () => {
  it("compact: no Hide, no hide state, the whole body", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    const tree = island.tree();
    expect(state(tree)).toBe("none");
    expect(byTestId(tree, "device-link-hide")).toBeUndefined();
    expect(byTestId(tree, "device-link-show")).toBeDefined();
    expect(byTestId(tree, "device-link-row-show")).toBeUndefined();
  });

  it("the full (non-compact) panel ignores a `hide` it is handed: Hide belongs to the compact panel only", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, compact: false, hide: hide({ initiallyOpen: false }) });
    await flush();
    expect(byTestId(island.tree(), "device-link-hide")).toBeUndefined();
    expect(byTestId(island.tree(), "device-link-row-show")).toBeUndefined();
    expect(byTestId(island.tree(), "device-link-show")).toBeDefined();
  });
});

describe("open: the panel with Hide ✕ in its heading row", () => {
  it("Hide is a real button, a 44px target, named for what it hides, beside the host's heading and before the body", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide() });
    await flush();
    const tree = island.tree();
    expect(state(tree)).toBe("open");
    const button = byTestId(tree, "device-link-hide")!;
    expect(button.type).toBe("button");
    expect(String(propsOf(button).className)).toMatch(/\bmin-h-11\b/);
    expect(String(propsOf(button).className)).toMatch(/\bmin-w-11\b/);
    expect(propsOf(button)["aria-label"]).toBe(t("dlink.hideLabel"));
    expect(textOf(button)).toBe(t("dlink.hide"));
    expect(tree.some((el) => propsOf(el).id === "md-scorer-f1"), "the host's own heading is shown").toBe(true);
    // The body is still the compact panel's: the hand-over button, with the More fold after it.
    expect(byTestId(tree, "device-link-show")).toBeDefined();
    expect(byTestId(tree, "device-link-more")).toBeDefined();
  });

  it("Hide puts the panel away to the row and REMEMBERS it in sessionStorage under the host's key", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide() });
    await flush();
    click(byTestId(island.tree(), "device-link-hide"));
    await flush();
    expect(state(island.tree())).toBe("hidden");
    expect(store.get(KEY)).toBe("hidden");
    expect(byTestId(island.tree(), "device-link-hide")).toBeUndefined();
    expect(byTestId(island.tree(), "device-link-more"), "nothing of the body is left").toBeUndefined();
    expect(api.deletes, "hiding never touches the link").toEqual([]);
    expect(api.posts).toEqual([]);
  });
});

describe("hidden: one row — heading · state · [Show QR] [Copy link]", () => {
  const hidden = () => hide({ initiallyOpen: false });

  it("a link is live: 'Scorer link ready', Show QR and Copy link — and no QR, no body", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    const tree = island.tree();
    expect(state(tree)).toBe("hidden");
    expect(textOf(byTestId(tree, "device-link-row-state")!)).toContain(t("dlink.linkReady"));
    expect(textOf(byTestId(tree, "device-link-row-show")!)).toBe(t("dlink.showQr"));
    expect(textOf(byTestId(tree, "device-link-row-copy")!)).toBe(t("dlink.copy"));
    expect(tree.some((el) => propsOf(el).id === "md-scorer-f1"), "the host's heading stays").toBe(true);
    expect(dlinkQr(tree)).toBeUndefined();
    for (const id of ["device-link-row-show", "device-link-row-copy"]) {
      expect(String(propsOf(byTestId(tree, id)!).className), id).toMatch(/\bmin-h-11\b/);
      expect(byTestId(tree, id)!.type, id).toBe("button");
    }
  });

  it("no link yet: 'No scorer link yet' and a Create button — there is nothing to copy", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    const tree = island.tree();
    expect(textOf(byTestId(tree, "device-link-row-state")!)).toContain(t("dlink.noLink"));
    expect(textOf(byTestId(tree, "device-link-row-create")!)).toBe(t("dlink.create"));
    expect(byTestId(tree, "device-link-row-copy")).toBeUndefined();
    expect(byTestId(tree, "device-link-row-show")).toBeUndefined();
  });

  it("before the first read lands the row claims nothing about the link (no 'ready', no 'none yet')", () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    expect(byTestId(island.tree(), "device-link-row-state")).toBeUndefined();
  });

  it("Copy link copies the SAME sealed link through ENSURE — never a reissue, never a revoke — and says so", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
    expect(api.deletes).toEqual([]);
    expect(clipboard).toEqual([`${ORIGIN}/score/dl_sealed_secret`]);
    expect(state(island.tree()), "copying does not open the panel").toBe("hidden");
    expect(textOf(byTestId(island.tree(), "device-link-row-copy")!)).toBe(t("dlink.copied"));
    expect(island.text()).toContain(t("dlink.copied")); // the sr-only status line
  });

  it("m8: with NO clipboard the row never says Copied - it offers the link selected, and says Select and copy", async () => {
    stubBrowser({ clipboard: "missing" });
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    const tree = island.tree();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
    expect(api.deletes).toEqual([]);
    expect(textOf(byTestId(tree, "device-link-row-copy")!), "the button did not turn into 'Link copied'").toBe(t("dlink.copy"));
    expect(island.text()).not.toContain(t("dlink.copied"));
    const field = byTestId(tree, "device-link-select-input")!;
    expect(propsOf(field).value).toBe(`${ORIGIN}/score/dl_sealed_secret`);
    expect(propsOf(field).readOnly).toBe(true);
    expect(textOf(byTestId(tree, "device-link-select")!)).toContain(t("dlink.selectCopy"));
    expect(state(tree), "the panel stays as it was").toBe("hidden");
  });

  it("m8: a clipboard that REFUSES (a page without permission) falls back the same way - the link is still offered, never 'Copied', never a raw error", async () => {
    stubBrowser({ clipboard: "denied" });
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    const tree = island.tree();
    expect(propsOf(byTestId(tree, "device-link-select-input")!).value).toBe(`${ORIGIN}/score/dl_sealed_secret`);
    expect(island.text()).not.toContain(t("dlink.copied"));
    expect(island.text()).not.toContain("NotAllowedError");
  });

  it("m8: with a clipboard, nothing to select - it copies, says Copied, and the fallback field never appears (the opposite branch)", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    expect(byTestId(island.tree(), "device-link-select-input")).toBeUndefined();
    expect(clipboard).toEqual([`${ORIGIN}/score/dl_sealed_secret`]);
  });

  it("m8: the open panel's own Copy link takes the same fallback when there is no clipboard, and copies when there is one", async () => {
    stubBrowser({ clipboard: "missing" });
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) });
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    click(byTestId(island.tree(), "device-link-copy"));
    await flush();
    expect(propsOf(byTestId(island.tree(), "device-link-select-input")!).value).toBe(`${ORIGIN}/score/dl_sealed_secret`);

    stubBrowser();
    const ok = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) });
    await flush();
    click(byTestId(ok.tree(), "device-link-show"));
    await flush();
    click(byTestId(ok.tree(), "device-link-copy"));
    await flush();
    expect(clipboard).toEqual([`${ORIGIN}/score/dl_sealed_secret`]);
    expect(byTestId(ok.tree(), "device-link-select-input")).toBeUndefined();
  });

  it("Show QR opens the panel, remembers it open, and shows the SAME link's QR (ensure, never /reissue)", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-show"));
    await flush();
    const tree = island.tree();
    expect(state(tree)).toBe("open");
    expect(store.get(KEY)).toBe("open");
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
    expect(api.deletes).toEqual([]);
    expect(dlinkQr(tree), "the QR is on screen").toBeDefined();
    expect(byTestId(tree, "device-link-hide"), "and Hide is there to put it away again").toBeDefined();
  });

  it("Create (no link yet) opens the panel and makes the first link there", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-create"));
    await flush();
    expect(state(island.tree())).toBe("open");
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
    expect(dlinkQr(island.tree())).toBeDefined();
  });

  it("a refused copy puts the localised failure in the row, not an exception, and copies nothing", async () => {
    api.refuse = { message: "Payment required", status: 402, code: "PAYMENT_REQUIRED" };
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hidden() });
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    expect(clipboard).toEqual([]);
    expect(state(island.tree())).toBe("hidden");
    expect(island.text()).not.toContain(t("dlink.copied"));
    expect(island.text()).toContain(t("dlink.failed"));
  });

  it("the SEQUENCE: hide, copy, show, hide again — the link is the same one throughout and the choice follows the last press", async () => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide() });
    await flush();
    click(byTestId(island.tree(), "device-link-hide"));
    await flush();
    click(byTestId(island.tree(), "device-link-row-copy"));
    await flush();
    click(byTestId(island.tree(), "device-link-row-show"));
    await flush();
    expect(state(island.tree())).toBe("open");
    click(byTestId(island.tree(), "device-link-hide"));
    await flush();
    expect(state(island.tree())).toBe("hidden");
    expect(store.get(KEY)).toBe("hidden");
    expect(clipboard).toEqual([`${ORIGIN}/score/dl_sealed_secret`]);
    expect(api.deletes).toEqual([]);
    expect(api.active?.id).toBe(SEALED.id);
  });
});

describe("the default, before anything is remembered", () => {
  it("initiallyOpen decides it when the host knows (a playing court): true opens, false hides — whatever link is live", async () => {
    let checked = 0;
    for (const initiallyOpen of [true, false]) {
      for (const link of [SEALED, null]) {
        api.active = link;
        const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen, followLink: false }) });
        await flush();
        expect(state(island.tree()), `initiallyOpen=${initiallyOpen} link=${link !== null}`).toBe(initiallyOpen ? "open" : "hidden");
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("followLink (m4/m8): the first paint claims nothing - the hidden row - then no link live -> open at the first read; a link already live -> it STAYS hidden, it never opens and collapses", async () => {
    api.active = null;
    const noLink = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) });
    expect(state(noLink.tree()), "first paint: nobody knows yet, so nothing is opened for the read to take back").toBe("hidden");
    await flush();
    expect(state(noLink.tree()), "no hand-over made: the next step is to make one, so it opens").toBe("open");

    api.active = SEALED;
    const linked = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) });
    expect(state(linked.tree())).toBe("hidden");
    await flush();
    expect(state(linked.tree()), "a hand-over already made: out of the way - and never open in between").toBe("hidden");
    expect(byTestId(linked.tree(), "device-link-row-show"), "with its Show QR one press away").toBeDefined();
  });

  it("followLink, the first read FAILS: the host's initiallyOpen speaks (the panel is not left blank), both ways", async () => {
    api.failRead = true;
    let checked = 0;
    for (const initiallyOpen of [true, false]) {
      const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true, initiallyOpen }) });
      expect(state(island.tree())).toBe("hidden");
      await flush();
      expect(state(island.tree()), `initiallyOpen=${initiallyOpen}`).toBe(initiallyOpen ? "open" : "hidden");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("followLink is LATCHED at the first read: making the link under the organiser's hands does not close the panel they are using", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) });
    await flush();
    click(byTestId(island.tree(), "device-link-mint"));
    await flush();
    expect(api.active, "a link now exists").not.toBeNull();
    expect(state(island.tree())).toBe("open");
    expect(dlinkQr(island.tree()), "and its QR is the thing on screen").toBeDefined();
  });

  it("the default is decided at MOUNT: the host's initiallyOpen changing later (the desk's 'No scorer' clearing once a link is made) neither closes nor opens an open panel", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) });
    await flush();
    expect(state(island.tree())).toBe("open");
    island.rerender({ ...PROPS, hide: hide({ initiallyOpen: false }) }); // the board re-read: nobody is "unscored" any more
    await flush();
    expect(state(island.tree())).toBe("open");
    // ...and the other way round: a hidden panel stays hidden when the host's guess flips to open.
    const hiddenIsland = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: false }) });
    await flush();
    hiddenIsland.rerender({ ...PROPS, hide: hide({ initiallyOpen: true }) });
    await flush();
    expect(state(hiddenIsland.tree())).toBe("hidden");
  });

  it("an organiser's choice beats followLink, even if it arrives before the first read: Show QR before the read lands keeps the panel open on a live link", async () => {
    api.active = SEALED;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) });
    click(byTestId(island.tree(), "device-link-row-create")); // the first paint's only door, before the read lands
    await flush();
    expect(state(island.tree()), "followLink would have kept a live link hidden").toBe("open");
    expect(store.get(KEY)).toBe("open");
  });

  it("a hide AFTER the panel opened on 'no link' holds - and a live link's panel the organiser opened is not collapsed by the read", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) });
    await flush();
    expect(state(island.tree())).toBe("open");
    click(byTestId(island.tree(), "device-link-hide"));
    await flush();
    expect(state(island.tree())).toBe("hidden");
    expect(store.get(KEY)).toBe("hidden");
  });
});

describe("remembered per court in sessionStorage", () => {
  const hydrated = () => ({ hydrate: true });

  it("a remembered 'hidden' beats an open default, and a remembered 'open' beats a hidden one (both directions)", async () => {
    let checked = 0;
    for (const [remembered, initiallyOpen] of [["hidden", true], ["open", false]] as const) {
      stubBrowser();
      store.set(KEY, remembered);
      const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen }) }, undefined, hydrated());
      await flush();
      expect(state(island.tree()), `${remembered} vs initiallyOpen=${initiallyOpen}`).toBe(remembered);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a remembered choice beats followLink too", async () => {
    store.set(KEY, "open");
    api.active = SEALED; // followLink would have collapsed it
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ followLink: true }) }, undefined, hydrated());
    await flush();
    expect(state(island.tree())).toBe("open");
  });

  it("another court's choice does not move this one (the key is the host's, per court)", async () => {
    store.set("seazn.matchDay.scorer.c-4", "hidden");
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) }, undefined, hydrated());
    await flush();
    expect(state(island.tree())).toBe("open");
  });

  it("an item that is neither 'open' nor 'hidden' (stale, hand-edited) is ignored: the default applies", async () => {
    store.set(KEY, "collapsed");
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) }, undefined, hydrated());
    await flush();
    expect(state(island.tree())).toBe("open");
  });

  it("the server render knows nothing of storage: the default, whatever is remembered (no hydration mismatch)", () => {
    store.set(KEY, "hidden");
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide({ initiallyOpen: true }) }); // no hydrate: the server snapshot
    expect(state(island.tree())).toBe("open");
  });

  it("a tab that refuses storage still hides and shows for as long as it lives, and never throws", async () => {
    stubBrowser({ throws: true });
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, hide: hide() }, undefined, hydrated());
    await flush();
    click(byTestId(island.tree(), "device-link-hide"));
    await flush();
    expect(state(island.tree())).toBe("hidden");
    click(byTestId(island.tree(), "device-link-row-show"));
    await flush();
    expect(state(island.tree())).toBe("open");
  });
});
