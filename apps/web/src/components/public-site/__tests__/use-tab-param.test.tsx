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
import {
  readDivisionParam,
  readSearchParam,
  readTabParam,
  subscribeToTabParam,
  useDivisionParam,
  useSearchParam,
  useTabParam,
  writeDivisionParam,
  writeSearchParam,
  writeTabParam,
} from "../use-tab-param";

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

/** A `window` with a mutable href and a recording history, for the writer. */
function stubHistory(href: string) {
  const replaced: string[] = [];
  const pushed: string[] = [];
  vi.stubGlobal("window", {
    location: { href, search: new URL(href).search },
    history: {
      replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
      pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
    },
  });
  return { replaced, pushed };
}

describe("readDivisionParam", () => {
  it("reads the division the URL names, by NAME beside a tab", () => {
    stubWindow("?tab=matches&division=premier");
    expect(readDivisionParam()).toBe("premier");
  });

  it("a bare ?division= is the empty string, which MatchesTab folds to All", () => {
    stubWindow("?division=");
    expect(readDivisionParam()).toBe("");
  });

  it("no ?division= is null — and it is not confused with ?tab=", () => {
    stubWindow("?tab=premier");
    expect(readDivisionParam()).toBeNull();
  });
});

describe("writeDivisionParam", () => {
  it("sets the division and KEEPS the tab — a chip tap must not throw the spectator off Matches", () => {
    const { replaced, pushed } = stubHistory("https://seazn.test/shared/o/c?tab=matches");
    writeDivisionParam("premier");
    expect(replaced).toEqual(["https://seazn.test/shared/o/c?tab=matches&division=premier"]);
    expect(pushed).toEqual([]);
  });

  it("All REMOVES the parameter rather than writing an empty one", () => {
    // `?division=` would read back as "" — handled, but a URL a spectator
    // copies should not carry a parameter that means nothing.
    const { replaced } = stubHistory("https://seazn.test/shared/o/c?tab=matches&division=premier");
    writeDivisionParam(null);
    expect(replaced).toEqual(["https://seazn.test/shared/o/c?tab=matches"]);
  });

  it("replaces an existing division rather than appending a second one", () => {
    const { replaced } = stubHistory("https://seazn.test/shared/o/c?division=open&tab=matches");
    writeDivisionParam("premier");
    expect(replaced).toEqual(["https://seazn.test/shared/o/c?division=premier&tab=matches"]);
  });
});

describe("useDivisionParam", () => {
  it("hands React a null SERVER snapshot and the division reader as the live one", () => {
    let seen: {
      subscribe: (fn: () => void) => () => void;
      getSnapshot: () => string | null;
      getServerSnapshot?: () => string | null;
    } | null = null;
    const internals = (
      React as unknown as {
        __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
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
      value = useDivisionParam();
    } finally {
      internals.H = previous;
    }
    expect(value).toBeNull();
    expect(seen!.subscribe).toBe(subscribeToTabParam);
    expect(seen!.getServerSnapshot!()).toBeNull();
    // The live snapshot reads DIVISION, not tab: a hook wired to the tab
    // reader would answer "matches" here.
    stubWindow("?tab=matches&division=premier");
    expect(seen!.getSnapshot()).toBe("premier");
  });
});

// ------------------------------------------------ the generic pair (plan R6)
//
// The Knockout tab's `?view=` is the third parameter this module serves, so the
// reader and writer became generic and the named ones above became wrappers.
// Every test ABOVE this line is unchanged and still green — that is the
// wrappers' contract. What follows pins the generic functions themselves.

/** Record the three arguments a hook hands React, through React's own
 *  dispatcher slot — the same technique the two tests above use inline. */
function captureStore(call: () => string | null) {
  const seen: {
    subscribe: (fn: () => void) => () => void;
    getSnapshot: () => string | null;
    getServerSnapshot?: () => string | null;
  }[] = [];
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H;
  internals.H = {
    useSyncExternalStore(
      subscribe: (fn: () => void) => () => void,
      getSnapshot: () => string | null,
      getServerSnapshot?: () => string | null,
    ) {
      seen.push({ subscribe, getSnapshot, getServerSnapshot });
      return getServerSnapshot ? getServerSnapshot() : getSnapshot();
    },
  };
  let value: string | null;
  try {
    value = call();
  } finally {
    internals.H = previous;
  }
  return { value, seen };
}

describe("readSearchParam", () => {
  it("reads ANY parameter by name — a value, a bare one as the empty string, an absent one as null", () => {
    stubWindow("?tab=knockout&view=draw&division=");
    expect(readSearchParam("view")).toBe("draw");
    expect(readSearchParam("tab")).toBe("knockout");
    expect(readSearchParam("division")).toBe("");
    expect(readSearchParam("filter")).toBeNull();
  });
});

describe("writeSearchParam", () => {
  it("sets the named parameter with replaceState and KEEPS every other one", () => {
    const { replaced, pushed } = stubHistory(
      "https://seazn.test/shared/o/c?tab=knockout&division=premier",
    );
    writeSearchParam("view", "draw");
    expect(replaced).toEqual([
      "https://seazn.test/shared/o/c?tab=knockout&division=premier&view=draw",
    ]);
    expect(pushed).toEqual([]);
  });

  it("null REMOVES the parameter — Rounds is the default, so a link carries no `view=rounds`", () => {
    const { replaced } = stubHistory("https://seazn.test/shared/o/c?tab=knockout&view=draw");
    writeSearchParam("view", null);
    expect(replaced).toEqual(["https://seazn.test/shared/o/c?tab=knockout"]);
  });

  it("the named writers still write their own names through it (the wrapper cannot be pointed at another)", () => {
    const { replaced } = stubHistory("https://seazn.test/shared/o/c?view=draw");
    writeTabParam("knockout");
    expect(replaced).toEqual(["https://seazn.test/shared/o/c?view=draw&tab=knockout"]);
  });
});

describe("useSearchParam", () => {
  it("a null SERVER snapshot, and a live snapshot that reads THAT name", () => {
    const { value, seen } = captureStore(() => useSearchParam("view"));
    expect(value).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.subscribe).toBe(subscribeToTabParam);
    expect(seen[0]!.getServerSnapshot).toBeTypeOf("function");
    expect(seen[0]!.getServerSnapshot!()).toBeNull();
    stubWindow("?tab=knockout&view=draw");
    expect(seen[0]!.getSnapshot()).toBe("draw");
  });

  it("getSnapshot is the SAME function on every render for one name, and a different one per name", () => {
    // A fresh `() => readSearchParam(name)` per call hands React a new
    // `getSnapshot` identity on every render. Cached per name instead, so the
    // store React sees is stable exactly as the two named hooks' were.
    const first = captureStore(() => useSearchParam("view")).seen[0]!;
    const again = captureStore(() => useSearchParam("view")).seen[0]!;
    const other = captureStore(() => useSearchParam("division")).seen[0]!;
    expect(again.getSnapshot).toBe(first.getSnapshot);
    expect(other.getSnapshot).not.toBe(first.getSnapshot);
  });
});
