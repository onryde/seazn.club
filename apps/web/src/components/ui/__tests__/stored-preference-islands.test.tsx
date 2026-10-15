// TipCallout + ViewToggleContainer (ESLint L3): both remembered a per-browser
// choice by copying a `localStorage` item into state from a mount effect. Both
// now read it through `useLocalStorageItem`. What each owes, in sequence:
// the server render (which cannot see storage), the render after hydration,
// the user's own change, and a storage that throws (Safari private mode used
// to throw out of the old effect).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { TipCallout } from "../tip";
import { ViewToggleContainer } from "../view-toggle";

let store: Map<string, string>;
let throws = false;
beforeEach(() => {
  store = new Map();
  throws = false;
  vi.stubGlobal("window", {
    get localStorage() {
      if (throws) throw new Error("SecurityError");
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TIP_KEY = "seazn.tip.division.start-locks";

describe("TipCallout", () => {
  const mount = () =>
    renderIsland(TipCallout, { id: "division.start-locks" as const }, undefined, { hydrate: true });
  const dismiss = (island: ReturnType<typeof mount>) => {
    const x = island.tree().find((el) => el.type === "button");
    expect(x, "dismiss button").toBeDefined();
    (propsOf(x!).onClick as () => void)();
  };

  it("server render shows nothing — a dismissed callout must never flash", () => {
    expect(renderToStaticMarkup(<TipCallout id="division.start-locks" />)).toBe("");
  });

  it("first visit shows it after hydration; ✕ hides it and remembers", () => {
    const island = mount();
    expect(island.tree().length).toBeGreaterThan(0);
    dismiss(island);
    expect(island.tree()).toEqual([]);
    expect(store.get(TIP_KEY)).toBe("1");
  });

  it("a remembered dismissal keeps it hidden on the next visit", () => {
    store.set(TIP_KEY, "1");
    expect(mount().tree()).toEqual([]);
  });

  it("a throwing storage neither crashes the page nor blocks the ✕", () => {
    throws = true;
    const island = mount();
    expect(island.tree().length, "unreadable storage reads as 'not dismissed'").toBeGreaterThan(0);
    dismiss(island);
    expect(island.tree()).toEqual([]);
  });
});

describe("ViewToggleContainer", () => {
  const KEY = "seazn.view.competitions";
  const mount = () =>
    renderIsland(ViewToggleContainer, { storageKey: KEY, toggle: true, children: null }, undefined, {
      hydrate: true,
    });
  const viewOf = (island: ReturnType<typeof mount>) =>
    propsOf(island.tree().find((el) => propsOf(el)["data-view"] !== undefined)!)["data-view"];
  const press = (island: ReturnType<typeof mount>, index: number) => {
    const buttons = island.tree().filter((el) => el.type === "button");
    expect(buttons).toHaveLength(2);
    (propsOf(buttons[index]!).onClick as () => void)();
  };

  it("server render is cards even when the browser saved list (no mismatch at hydration)", () => {
    store.set(KEY, "list");
    expect(renderToStaticMarkup(<ViewToggleContainer storageKey={KEY} toggle>{null}</ViewToggleContainer>)).toContain(
      'data-view="cards"',
    );
  });

  it("the saved view after hydration; empty case and a junk value both read as cards", () => {
    store.set(KEY, "list");
    expect(viewOf(mount())).toBe("list");
    store.clear();
    expect(viewOf(mount())).toBe("cards");
    store.set(KEY, "grid-of-doom");
    expect(viewOf(mount())).toBe("cards");
  });

  it("a pick switches at once and is remembered; a second pick switches back", () => {
    const island = mount();
    press(island, 1);
    expect(viewOf(island)).toBe("list");
    expect(store.get(KEY)).toBe("list");
    press(island, 0);
    expect(viewOf(island)).toBe("cards");
    expect(store.get(KEY)).toBe("cards");
  });

  it("a storage that refuses the write still switches the view", () => {
    const island = mount();
    throws = true;
    press(island, 1);
    expect(viewOf(island)).toBe("list");
  });

  it("a pick belongs to the storage key it was made under: another key shows its OWN saved view", () => {
    // The differential is deliberate: the pick is "cards" and the other key
    // saved "list", so a pick that leaked across keys shows cards, and the
    // saved view shows list. (Same value on both sides would pass either way.)
    const OTHER = "seazn.view.divisions";
    store.set(OTHER, "list");
    const island = mount();
    press(island, 0); // cards, under KEY — held in state as well as written
    expect(viewOf(island)).toBe("cards");
    island.rerender({ storageKey: OTHER, toggle: true, children: null });
    expect(viewOf(island), "the other key's saved view, not the pick made under KEY").toBe("list");
    // ...and the empty case for the new key: nothing saved reads as cards, even
    // though the pick made under KEY was "list" this time.
    store.delete(OTHER);
    island.rerender({ storageKey: KEY, toggle: true, children: null });
    press(island, 1); // list, under KEY
    expect(viewOf(island)).toBe("list");
    island.rerender({ storageKey: OTHER, toggle: true, children: null });
    expect(viewOf(island)).toBe("cards");
  });
});
