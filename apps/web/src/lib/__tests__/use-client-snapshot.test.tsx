// The shared hydration-safe browser reads (ESLint L3). Two halves, and both are
// owed: the SERVER half is what keeps hydration from mismatching (the markup
// must be what the replaced `useState` default rendered), and the LIVE half is
// the value the replaced mount effect used to copy into state. A test of only
// one half passes on a hook that returns a constant.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import {
  readLocalStorageItem,
  useHydrated,
  useLocalStorageItem,
  useMediaQuery,
  useOrigin,
  writeLocalStorageItem,
} from "../use-client-snapshot";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A window with just what these hooks touch: an origin, a storage, and the
 *  listeners a `storage` event would reach. */
function stubWindow(opts: { origin?: string; store?: Map<string, string>; throws?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>();
  const store = opts.store ?? new Map<string, string>();
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
  const mq = { matches: false, listeners: new Set<() => void>() };
  vi.stubGlobal("window", {
    location: { origin: opts.origin ?? "https://seazn.club" },
    get localStorage() {
      if (opts.throws) throw new Error("SecurityError");
      return storage;
    },
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    matchMedia: () => ({
      get matches() {
        return mq.matches;
      },
      addEventListener: (_: string, fn: () => void) => mq.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => mq.listeners.delete(fn),
    }),
  });
  return {
    store,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    mq,
  };
}

/** A one-hook component that prints what the hook returned. */
function probeOf(useValue: () => unknown) {
  return function Probe() {
    return <span>{String(useValue())}</span>;
  };
}

describe("useHydrated", () => {
  const Probe = probeOf(useHydrated);
  it("server markup and the hydration render say false", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>false</span>");
  });
  it("true once hydration has committed", () => {
    const island = renderIsland(Probe, {}, undefined, { hydrate: true });
    expect(island.text()).toBe("true");
  });
});

describe("useOrigin", () => {
  const Probe = probeOf(useOrigin);
  it("empty on the server, so a URL built from it stays site-relative", () => {
    stubWindow();
    expect(renderToStaticMarkup(<Probe />)).toBe("<span></span>");
  });
  it("the page's origin after hydration", () => {
    stubWindow({ origin: "https://club.example" });
    const island = renderIsland(Probe, {}, undefined, { hydrate: true });
    expect(island.text()).toBe("https://club.example");
  });
});

describe("useLocalStorageItem", () => {
  const Probe = probeOf(() => useLocalStorageItem("k"));

  it("null on the server even when the item exists — the server cannot see it", () => {
    stubWindow({ store: new Map([["k", "stored"]]) });
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>null</span>");
  });

  it("the stored item after hydration; null when absent (the empty case)", () => {
    stubWindow({ store: new Map([["k", "stored"]]) });
    expect(renderIsland(Probe, {}, undefined, { hydrate: true }).text()).toBe("stored");
    stubWindow();
    expect(renderIsland(Probe, {}, undefined, { hydrate: true }).text()).toBe("null");
  });

  it("another tab's write re-renders through the storage event", () => {
    const w = stubWindow();
    const island = renderIsland(Probe, {}, undefined, { hydrate: true });
    expect(w.listenerCount("storage")).toBe(1);
    w.store.set("k", "from-another-tab");
    w.fire("storage");
    expect(island.text()).toBe("from-another-tab");
  });

  it("a throwing storage reads null and refuses the write, never throws", () => {
    stubWindow({ throws: true });
    expect(readLocalStorageItem("k")).toBeNull();
    expect(writeLocalStorageItem("k", "v")).toBe(false);
    expect(renderIsland(Probe, {}, undefined, { hydrate: true }).text()).toBe("null");
  });

  it("a successful write is read back", () => {
    stubWindow();
    expect(writeLocalStorageItem("k", "v")).toBe(true);
    expect(readLocalStorageItem("k")).toBe("v");
  });
});

describe("useMediaQuery", () => {
  const Probe = probeOf(() => useMediaQuery("(max-width: 640px)"));
  it("false on the server even where the query matches", () => {
    const w = stubWindow();
    w.mq.matches = true;
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>false</span>");
  });
  it("the live match after hydration, and it follows a change event", () => {
    const w = stubWindow();
    w.mq.matches = true;
    const island = renderIsland(Probe, {}, undefined, { hydrate: true });
    expect(island.text()).toBe("true");
    w.mq.matches = false;
    w.mq.listeners.forEach((fn) => fn());
    expect(island.text()).toBe("false");
  });
});
