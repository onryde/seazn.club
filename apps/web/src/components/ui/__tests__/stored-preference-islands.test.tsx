// TipCallout (ESLint L3): it remembered a per-browser choice by copying a
// `localStorage` item into state from a mount effect, and now reads it through
// `useLocalStorageItem`. (ViewToggleContainer, its old twin here, was deleted
// with the org home's list view — Match Day C7.) What it owes, in sequence:
// the server render (which cannot see storage), the render after hydration,
// the user's own change, and a storage that throws (Safari private mode used
// to throw out of the old effect).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { TipCallout } from "../tip";

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

// Any registered tip: TipCallout is keyed by id. It was the division start-locks tip until UI5 item 1 removed that
// banner (2026-11-03); the component itself is generic and keeps its contract.
const TIP_ID = "division.visibility" as const;
const TIP_KEY = `seazn.tip.${TIP_ID}`;

describe("TipCallout", () => {
  const mount = () =>
    renderIsland(TipCallout, { id: TIP_ID }, undefined, { hydrate: true });
  const dismiss = (island: ReturnType<typeof mount>) => {
    const x = island.tree().find((el) => el.type === "button");
    expect(x, "dismiss button").toBeDefined();
    (propsOf(x!).onClick as () => void)();
  };

  it("server render shows nothing — a dismissed callout must never flash", () => {
    expect(renderToStaticMarkup(<TipCallout id={TIP_ID} />)).toBe("");
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
