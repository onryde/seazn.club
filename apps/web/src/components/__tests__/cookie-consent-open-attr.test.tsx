// The banner's one signal to the page under it: `data-consent-open` on <html> while it is painted (CONSENT_OPEN_ATTR).
// The quick match Start bar un-docks on it (components/quick-match/setup-form.tsx; setup-form.test.tsx pins the variant
// to the constant), so the bar neither hides under the banner nor covers its buttons (quick match T4 review, m5).
//
// The sequence a visitor walks, as in cookie-consent-sequence.test.tsx: first visit → choose → reopen → choose again; a
// returning visitor; and the overlay, where the banner is never painted, so the attribute must never be set either.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/en/play" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CONSENT_OPEN_ATTR, CookieConsent } from "../cookie-consent";
import { CONSENT_KEY, CONSENT_REOPEN_EVENT, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } from "@/lib/consent";

let store: Map<string, string>;
let listeners: Map<string, Set<() => void>>;
let attrs: Set<string>;
const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());
const open = () => attrs.has(CONSENT_OPEN_ATTR);

beforeEach(() => {
  nav.pathname = "/en/play";
  store = new Map();
  listeners = new Map();
  attrs = new Set();
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
    location: { pathname: nav.pathname },
  });
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string) => void attrs.add(name),
      removeAttribute: (name: string) => void attrs.delete(name),
    },
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true } as Response)));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const mount = () => renderIsland(CookieConsent, {}, undefined, { hydrate: true });
const press = (island: ReturnType<typeof mount>, testid: string | undefined) => {
  const button = island.tree().find((el) => el.type === "button" && propsOf(el)["data-testid"] === testid);
  expect(button, `no ${testid ?? "reject"} button`).toBeDefined();
  (propsOf(button!).onClick as () => void)();
};

describe("CookieConsent sets data-consent-open on <html> exactly while it is painted", () => {
  it("names the attribute the Start bar's variant reads", () => {
    expect(CONSENT_OPEN_ATTR).toBe("data-consent-open");
  });

  it("first visit → set; Reject → gone; Cookie settings → set; Accept → gone", () => {
    const island = mount();
    expect(island.tree().length > 0, "the banner shows").toBe(true);
    expect(open()).toBe(true);
    press(island, undefined);
    expect(island.tree()).toHaveLength(0);
    expect(open(), "the banner went, so did the attribute").toBe(false);
    fire(CONSENT_REOPEN_EVENT);
    expect(open(), "reopened").toBe(true);
    press(island, "cookie-accept");
    expect(open()).toBe(false);
  });

  it("a returning visitor whose choice covers the policy: no banner, no attribute", () => {
    store.set(CONSENT_KEY, "accepted");
    store.set(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    const island = mount();
    expect(island.tree()).toHaveLength(0);
    expect(open()).toBe(false);
  });

  it("the overlay paints no banner, so it sets no attribute, though the visitor has never chosen", () => {
    nav.pathname = "/overlay/abc";
    const island = mount();
    expect(island.tree()).toHaveLength(0);
    expect(open()).toBe(false);
  });

  it("the scoring pad paints no banner, so it sets no attribute, though the visitor has never chosen", () => {
    nav.pathname = "/score/abc123token";
    const island = mount();
    expect(island.tree()).toHaveLength(0);
    expect(open()).toBe(false);
  });
});
