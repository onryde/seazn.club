// Quick match plan 2, Task 10 review I-1: the guest's home reads FRESH when the browser restores it from the back-forward
// cache. A phone's browser (iOS Safari above all) keeps the home whole in memory when the guest taps Score, and its Back
// shows that copy, script state and all, without asking the server: the hero still says "Up next" over a match the guest has
// just scored. `force-dynamic` (no-store) does not stop it. `QuickMatchRefreshOnRestore` listens for the one signal a restore
// gives, `pageshow` with `persisted` true, and loads the page again; an ordinary load is already fresh and costs nothing
// more. A reload rather than `router.refresh()`: the island also renders, whole-page, in the server tests that
// `renderToStaticMarkup` the home, where the router hook throws (no app router is mounted). Rendering it is the fifth case.
//
// No DOM (vitest `environment: "node"`): the island runs through the no-DOM `renderIsland` harness against a stubbed
// `window` that records its listeners (score-form.test.tsx's harness) and counts `location.reload()`.
// The browser witness is e2e/quick-match.spec.ts's bfcache case, on a Chromium launched WITH its back-forward cache.
//
// The contract: renders nothing; ONE pageshow listener; a restore reloads once, every restore (a second Back too); an
// ordinary load (persisted false) reloads nothing (the empty case); after unmount, nothing is listening. And the seam: the
// live home mounts it, the dead screen (nothing to refresh) does not.
//
// Sport: not applicable (the island reloads a page; it knows no sport).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { QuickMatchRefreshOnRestore } from "../refresh-on-restore";

const h = { reloaded: 0 };
let pageListeners: Map<string, Set<(e: unknown) => void>>;
beforeEach(() => {
  h.reloaded = 0;
  pageListeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!pageListeners.has(type)) pageListeners.set(type, new Set());
      pageListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => pageListeners.get(type)?.delete(fn),
    location: {
      reload: () => {
        h.reloaded += 1;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
const firePageshow = (persisted: boolean) => [...(pageListeners.get("pageshow") ?? [])].forEach((fn) => fn({ persisted }));
const listening = () => pageListeners.get("pageshow")?.size ?? 0;

describe("QuickMatchRefreshOnRestore: a home restored from the back-forward cache asks for itself again", () => {
  it("renders nothing and listens once", () => {
    const i = renderIsland(QuickMatchRefreshOnRestore, {});
    expect(i.tree(), "renders nothing").toEqual([]);
    expect(listening(), "one pageshow listener").toBe(1);
    i.rerender({});
    expect(listening(), "a re-render does not stack a second").toBe(1);
  });

  it("an ordinary load reloads nothing; a restore reloads once, and so does the next one", () => {
    renderIsland(QuickMatchRefreshOnRestore, {});
    firePageshow(false);
    expect(h.reloaded, "an ordinary load is already fresh").toBe(0);
    firePageshow(true);
    expect(h.reloaded, "restored from the back-forward cache").toBe(1);
    firePageshow(false);
    expect(h.reloaded).toBe(1);
    firePageshow(true);
    expect(h.reloaded, "a second Back to the restored home").toBe(2);
  });

  it("after unmount nothing is listening, and a restore reloads nothing", () => {
    const i = renderIsland(QuickMatchRefreshOnRestore, {});
    i.unmount();
    expect(listening()).toBe(0);
    firePageshow(true);
    expect(h.reloaded).toBe(0);
  });

  it("renders on the server with no app router mounted (the home's server tests render the page whole)", () => {
    vi.unstubAllGlobals();   // a server render has no window at all
    expect(renderToStaticMarkup(createElement(QuickMatchRefreshOnRestore))).toBe("");
  });

  it("the live home mounts it once; the dead screen, with nothing to refresh, does not", () => {
    const src = readFileSync(new URL("../../../app/q/[token]/page.tsx", import.meta.url), "utf8");
    const dead = src.indexOf("<QuickMatchDead");
    const live = src.indexOf("<QuickMatchHomeView");
    expect(dead, "the dead screen's return").toBeGreaterThan(0);
    expect(live, "the live home's return").toBeGreaterThan(dead);
    const mounts = [...src.matchAll(/<QuickMatchRefreshOnRestore\s*\/>/g)].map((m) => m.index);
    expect(mounts, "mounted exactly once").toHaveLength(1);
    expect(mounts[0]!, "in the live home's return, beside the view").toBeGreaterThan(dead);
    expect(mounts[0]!).toBeLessThan(live);
    expect(src.slice(src.lastIndexOf("return", live), live), "in the same return as the view").toContain("<QuickMatchRefreshOnRestore");
  });
});
