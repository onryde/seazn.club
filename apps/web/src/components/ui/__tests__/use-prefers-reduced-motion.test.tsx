// Title sponsor poster, Task 3: `usePrefersReducedMotion`, the one shared reader of the visitor's reduced-motion setting (spec §7.8). The
// showcase's rotation reads it: reduced motion means nothing rotates on its own.
//
// It is read through `useSyncExternalStore`, so the SERVER snapshot is `false` - the markup the server sends and the first client render
// that must match it carry no guess - and the live value arrives after hydration. `apps/web` vitest has no DOM, so the island is driven
// through the hook harness in its `hydrate: true` mode with `window.matchMedia` stubbed (the harness models React's after-hydration
// re-read), and the real server snapshot is read by real React's `renderToStaticMarkup`.
//
// Sport-agnostic: no sport sweep (one reason, stated once).
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion";

/** The one query the hook may ask. Anything else is a bug, so the stub throws on it. */
const QUERY = "(prefers-reduced-motion: reduce)";

function Probe(): ReactElement {
  return createElement("div", { "data-reduced": String(usePrefersReducedMotion()) });
}
const reduced = (tree: ReactElement[]): string => String(propsOf(tree[0]!)["data-reduced"]);

/** A `matchMedia` stub that remembers its listeners, so a test can flip the setting the way a visitor's OS does. */
function stubMotion(initial: boolean) {
  const state = { matches: initial, listeners: new Set<() => void>(), asked: [] as string[] };
  vi.stubGlobal("window", {
    matchMedia: (q: string) => {
      state.asked.push(q);
      if (q !== QUERY) throw new Error(`unexpected media query ${q}`);
      return {
        get matches() {
          return state.matches;
        },
        addEventListener: (type: string, cb: () => void) => {
          expect(type).toBe("change");
          state.listeners.add(cb);
        },
        removeEventListener: (_type: string, cb: () => void) => void state.listeners.delete(cb),
      };
    },
  });
  return {
    state,
    set(next: boolean) {
      state.matches = next;
      for (const cb of [...state.listeners]) cb();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePrefersReducedMotion", () => {
  it("the server snapshot is false, even where the browser would say true (real React, no hydration)", () => {
    stubMotion(true);
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-reduced="false"');
  });

  it("the server snapshot is false with no window at all (the real server)", () => {
    expect(typeof window, "premise: this environment has no window").toBe("undefined");
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-reduced="false"');
  });

  it("before hydration it reads false, and after hydration it reads the live true", () => {
    const m = stubMotion(true);
    // Not hydrated: the harness's default is the server snapshot for ever.
    expect(reduced(renderIsland(Probe, {}, walk).tree())).toBe("false");
    // Hydrated: the post-commit store check re-renders with the live value.
    expect(reduced(renderIsland(Probe, {}, walk, { hydrate: true }).tree())).toBe("true");
    expect(m.state.asked.every((q) => q === QUERY), "only the reduced-motion query was ever asked").toBe(true);
    expect(m.state.asked.length, "anti-vacuity: the live value was read").toBeGreaterThan(0);
  });

  it("a visitor who has NOT asked for reduced motion reads false after hydration (the twin of the case above)", () => {
    stubMotion(false);
    expect(reduced(renderIsland(Probe, {}, walk, { hydrate: true }).tree())).toBe("false");
  });

  it("a `change` event flips it live, both ways, and the listener is registered exactly once (sequence)", () => {
    const m = stubMotion(true);
    const island = renderIsland(Probe, {}, walk, { hydrate: true });
    expect(reduced(island.tree())).toBe("true");
    expect(m.state.listeners.size, "one subscription").toBe(1);

    m.set(false);
    expect(reduced(island.tree()), "the OS setting turned off").toBe("false");
    m.set(true);
    expect(reduced(island.tree()), "and on again (a second call)").toBe("true");
    expect(m.state.listeners.size, "still one subscription after two changes").toBe(1);
  });

  it("with no window it reads false and does not throw, even when hydrating (nothing to ask, nothing to subscribe to)", () => {
    expect(typeof window).toBe("undefined");
    expect(() => renderIsland(Probe, {}, walk, { hydrate: true })).not.toThrow();
    expect(reduced(renderIsland(Probe, {}, walk, { hydrate: true }).tree())).toBe("false");
  });

  it("with a window that has no matchMedia it reads false and does not throw", () => {
    vi.stubGlobal("window", {});
    expect(reduced(renderIsland(Probe, {}, walk, { hydrate: true }).tree())).toBe("false");
    expect(walk(createElement(Probe)).length).toBeGreaterThan(0);
  });
});
