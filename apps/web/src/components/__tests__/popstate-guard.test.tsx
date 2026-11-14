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

const added = vi.hoisted(() => ({ popstate: [] as unknown[], removed: [] as unknown[], go: vi.fn() }));
beforeEach(() => {
  added.popstate.length = 0;
  added.removed.length = 0;
  added.go.mockClear();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: unknown) => type === "popstate" && added.popstate.push(fn),
    removeEventListener: (type: string, fn: unknown) => type === "popstate" && added.removed.push(fn),
    history: { go: added.go },
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

  // T24 re-review n7: the empty case asserts what "untouched" means - the router still hears it (no stop), the browser's own
  // handling stands (no preventDefault) and no history step is taken - after a guard was held and let go, the state every page
  // that stops guarding leaves behind.
  it("empty case: with no guard held (never, or held and released), a popstate passes untouched", () => {
    const untouched = () => {
      const e = { stopImmediatePropagation: vi.fn(), stopPropagation: vi.fn(), preventDefault: vi.fn() };
      runPopStateGuard(e as unknown as PopStateEvent);
      return e;
    };
    const stopper = (e: PopStateEvent) => {
      e.stopImmediatePropagation();
      window.history.go(1);
    };
    const release = holdPopState(stopper);
    // The positive pair: while held, the guard does stop it.
    expect(untouched().stopImmediatePropagation).toHaveBeenCalledTimes(1);
    release();
    added.go.mockClear();
    let checked = 0;
    for (const e of [untouched(), untouched()]) {
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(e.stopPropagation).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
      checked++;
    }
    expect(added.go, "no history step").not.toHaveBeenCalled();
    expect(checked).toBe(2);
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
