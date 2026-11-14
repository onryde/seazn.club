// B7 T24 fix round 1 G1 — the one popstate listener that can hold a Back before Next's router sees it.
//
// Chromium runs a window's popstate listeners in the order they were added (the capture flag changes nothing at the target),
// and Next's router adds its own when the app first hydrates. A page that adds one later runs after the router — whose
// transition React flushes synchronously inside the popstate, unmounting the page (and removing its listener) before the
// listener is reached. So the listener is added once by the root layout, whose effects commit before the router's (a child's
// effects run before its parent's), and a page lends it a guard while it has something to protect.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { PopStateGuardRoot, holdPopState, runPopStateGuard } from "@/components/popstate-guard";

const added = vi.hoisted(() => ({ popstate: [] as unknown[], removed: [] as unknown[] }));
beforeEach(() => {
  added.popstate.length = 0;
  added.removed.length = 0;
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: unknown) => type === "popstate" && added.popstate.push(fn),
    removeEventListener: (type: string, fn: unknown) => type === "popstate" && added.removed.push(fn),
  });
  return () => vi.unstubAllGlobals();
});

const event = () => ({ stopImmediatePropagation: vi.fn() }) as unknown as PopStateEvent;

describe("popstate guard", () => {
  it("the root adds ONE window listener on mount, the guard runner, and takes it away on unmount", () => {
    const island = renderIsland(PopStateGuardRoot, {});
    expect(added.popstate).toEqual([runPopStateGuard]);
    island.unmount();
    expect(added.removed).toEqual([runPopStateGuard]);
  });

  it("empty case: with no guard held, a popstate passes untouched", () => {
    expect(() => runPopStateGuard(event())).not.toThrow();
  });

  it("runs the guard held now; a newer hold replaces it; a release only lets go of its own hold", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = holdPopState(first);
    const e1 = event();
    runPopStateGuard(e1);
    expect(first).toHaveBeenCalledWith(e1);
    const releaseSecond = holdPopState(second);
    runPopStateGuard(event());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // A stale release (the first page's cleanup running late) must not drop the second page's guard.
    releaseFirst();
    runPopStateGuard(event());
    expect(second).toHaveBeenCalledTimes(2);
    releaseSecond();
    runPopStateGuard(event());
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("the root layout mounts the root — the only place early enough to run before Next's router", () => {
    const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/import \{ PopStateGuardRoot \} from "@\/components\/popstate-guard";/);
    expect(layout).toMatch(/<PopStateGuardRoot \/>/);
  });
});
