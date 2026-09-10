// The ONE `?tab=` reader on the public surface (spectator W2, Task 11).
//
// This suite exists because `apps/web` vitest is `environment: "node"` with no
// jsdom, so the hook's own browser arm is unreachable from a component render:
// `renderToStaticMarkup` takes `getServerSnapshot` (null, by contract), and the
// shared `_hook-harness` dispatcher does the same thing deliberately
// (`_hook-harness.tsx`'s `useSyncExternalStore` comment). Every component test
// on this surface therefore sees the PRE-DEEP-LINK arm and only that arm — the
// exact gap `tabs.test.tsx` writes up for its own file.
//
// So the two halves that DO have a browser in them are tested here as plain
// functions against a stubbed `window`, which is the only layer at which they
// are witnessable at all without adding jsdom to every suite in the workspace.
// What is still not provable anywhere in vitest: that React calls `subscribe`
// and re-reads on a real `popstate`. That is React's contract, not ours, and it
// belongs to the post-mount e2e leg.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { readTabParam, subscribeToTabParam, useTabParam } from "../use-tab-param";

type Listener = () => void;

/** A `window` with just the two surfaces the module touches. Returned rather
 *  than only installed, so a test can read what was registered instead of
 *  asserting that a call was merely made. */
function stubWindow(search: string) {
  const listeners: { type: string; fn: Listener }[] = [];
  const removed: { type: string; fn: Listener }[] = [];
  const fake = {
    location: { search },
    addEventListener: (type: string, fn: Listener) => listeners.push({ type, fn }),
    removeEventListener: (type: string, fn: Listener) => removed.push({ type, fn }),
  };
  vi.stubGlobal("window", fake);
  return { listeners, removed, fake };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readTabParam", () => {
  it("reads the tab the URL names", () => {
    stubWindow("?tab=table");
    expect(readTabParam()).toBe("table");
  });

  it("a bare ?tab= is the EMPTY STRING, not null — the caller's membership test is what folds it away", () => {
    // `URLSearchParams.get` returns "" for a valueless parameter, and Task 8's
    // review F2 is the record of what happens when a caller assumes null: `""`
    // matches no tab id, so it must reach the caller as a value that FAILS a
    // membership test rather than as "absent", or a `?? fallback` written
    // against null silently keeps it.
    stubWindow("?tab=");
    expect(readTabParam()).toBe("");
  });

  it("no ?tab= at all is null (positive pair for the two above)", () => {
    stubWindow("?division=premier");
    expect(readTabParam()).toBeNull();
  });

  it("reads the parameter by NAME, not by position", () => {
    // A `split("=")[1]`-shaped implementation passes the first three cases and
    // fails this one.
    stubWindow("?division=premier&tab=stats&filter=live");
    expect(readTabParam()).toBe("stats");
  });
});

describe("subscribeToTabParam", () => {
  it("subscribes popstate and hands back the exact unsubscribe React needs", () => {
    // Back/Forward changes the URL under the page without any render, so the
    // store is only correct if `popstate` is subscribed. And the returned
    // cleanup must remove THE SAME function object — a cleanup that removed a
    // fresh closure would leak a listener per subscription with nothing to see.
    const { listeners, removed } = stubWindow("?tab=teams");
    const onChange = () => {};
    const unsubscribe = subscribeToTabParam(onChange);
    expect(listeners).toEqual([{ type: "popstate", fn: onChange }]);
    expect(removed).toEqual([]);
    unsubscribe();
    expect(removed).toEqual([{ type: "popstate", fn: onChange }]);
  });
});

describe("useTabParam", () => {
  it("hands React a SERVER snapshot of null — the contract that keeps an ISR page from hydration-mismatching", () => {
    // Read through React's own dispatcher rather than by calling the hook:
    // `useSyncExternalStore` is the hook, and what this pins is which of the
    // three arguments React is given. The dispatcher records the call and
    // answers with the server snapshot, exactly as `_hook-harness` and a real
    // SSR render both do.
    let seen: {
      subscribe: (fn: () => void) => () => void;
      getSnapshot: () => string | null;
      getServerSnapshot?: () => string | null;
    } | null = null;
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
          H: unknown;
        };
      }
    ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = {
      useSyncExternalStore(
        subscribe: (fn: () => void) => () => void,
        getSnapshot: () => string | null,
        getServerSnapshot?: () => string | null,
      ) {
        seen = { subscribe, getSnapshot, getServerSnapshot };
        return getServerSnapshot ? getServerSnapshot() : getSnapshot();
      },
    };
    let value: string | null;
    try {
      value = useTabParam();
    } finally {
      internals.H = previous;
    }
    expect(value).toBeNull();
    expect(seen).not.toBeNull();
    // A third argument that is ABSENT would make React call `getSnapshot`
    // during SSR, which reads `window` and throws. Its presence is the whole
    // contract, so it is asserted, not assumed.
    expect(seen!.getServerSnapshot).toBeTypeOf("function");
    expect(seen!.getServerSnapshot!()).toBeNull();
    // And the live snapshot is the browser read — same function the direct
    // tests above pin, so the hook cannot be wired to a different one.
    stubWindow("?tab=matches");
    expect(seen!.getSnapshot()).toBe("matches");
  });
});
