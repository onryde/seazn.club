// CookieConsent as a SEQUENCE (ESLint L3). "Consent needed" used to be copied
// into state by a mount effect; it is now read from storage through a store,
// with an in-tab override for an explicit choice or a reopen. The transitions a
// visitor can actually make, in order: first visit → choose → reopen from
// Cookie settings → choose again; plus the server render, a returning visitor,
// and a choice made in another tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/shared/acme/summer-cup" }));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CookieConsent } from "../cookie-consent";
import { CONSENT_KEY, CONSENT_REOPEN_EVENT, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "@/lib/consent";

let store: Map<string, string>;
let listeners: Map<string, Set<() => void>>;
const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());

beforeEach(() => {
  store = new Map();
  listeners = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", {
    addEventListener: (t: string, fn: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(fn);
    },
    removeEventListener: (t: string, fn: () => void) => listeners.get(t)?.delete(fn),
    location: { pathname: "/shared/acme/summer-cup" },
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderIsland(CookieConsent, {}, undefined, { hydrate: true });
const shown = (island: ReturnType<typeof mount>) => island.tree().length > 0;
/** Accept carries a testid; Reject is the banner's other button. */
const press = (island: ReturnType<typeof mount>, which: "accept" | "reject") => {
  const buttons = island.tree().filter((el) => el.type === "button");
  expect(buttons, "the banner's two choices").toHaveLength(2);
  const button = buttons.find((el) =>
    which === "accept"
      ? propsOf(el)["data-testid"] === "cookie-accept"
      : propsOf(el)["data-testid"] === undefined,
  );
  expect(button, `no ${which} button`).toBeDefined();
  (propsOf(button!).onClick as () => void)();
};

describe("CookieConsent — the sequence a visitor walks", () => {
  it("server render is empty — the server cannot see the visitor's storage", () => {
    expect(renderToStaticMarkup(<CookieConsent />)).toBe("");
  });

  it("first visit → Reject hides it → Cookie settings reopens it → Accept hides it again", () => {
    const island = mount();
    expect(shown(island), "first visit must show the banner").toBe(true);

    press(island, "reject");
    expect(store.get(CONSENT_KEY)).toBe("rejected");
    expect(shown(island)).toBe(false);

    fire(CONSENT_REOPEN_EVENT);
    expect(shown(island), "withdrawal must be as easy as granting").toBe(true);

    press(island, "accept");
    expect(store.get(CONSENT_KEY)).toBe("accepted");
    expect(shown(island)).toBe(false);
  });

  it("a returning visitor whose choice covers the current policy sees nothing", () => {
    store.set(CONSENT_KEY, "accepted");
    store.set(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    expect(shown(mount())).toBe(false);
  });

  it("a choice under an OLDER policy version re-prompts", () => {
    store.set(CONSENT_KEY, "accepted");
    store.set(CONSENT_VERSION_KEY, "an-older-version");
    expect(shown(mount())).toBe(true);
  });

  it("a choice made in another tab hides this tab's banner (storage event)", () => {
    const island = mount();
    expect(shown(island)).toBe(true);
    store.set(CONSENT_KEY, "accepted");
    store.set(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    fire("storage");
    expect(shown(island)).toBe(false);
  });
});
