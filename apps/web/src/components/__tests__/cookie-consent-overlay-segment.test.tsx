// vitest runs `environment: "node"` here, so this drives the component through
// `renderIsland` with `next/navigation` mocked — a source-scan test (the
// convention the two existing cookie-consent tests use) could not tell a
// rendered banner from a suppressed one, which is the whole claim.
//
// RE-PIN (2026-09-09): `renderIsland` returns a HANDLE
// (`{ tree, text, rerender, unmount }`), never the rendered element itself —
// `expect(renderIsland(...)).toBeNull()` (as drafted) would always fail, since
// the handle is never null. Assert on `.tree()` instead: `walk(null)` (the
// default `expand`) returns `[]` when the component's own output is null.
//
// Also needed, neither of which the two existing cookie-consent tests exercise
// (both are static source scans): `window` (the effect always calls
// `window.addEventListener`/`removeEventListener`, and `readActiveLocale()`
// reads `window.location.pathname` once `typeof window !== "undefined"`) and
// a bare global `localStorage` (`@/lib/consent` reads the bare global, not
// `window.localStorage`). Both are `undefined` in this repo's `environment:
// "node"` vitest — confirmed via `node -e "console.log(typeof window)"`.
import { describe, expect, it, vi } from "vitest";

const pathname = { current: "/" };
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
});
vi.stubGlobal("window", {
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { pathname: "/" },
});

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { CookieConsent } from "../cookie-consent";

describe("CookieConsent on the overlay segment", () => {
  it("renders nothing under /overlay/, so OBS cannot composite it into a broadcast", () => {
    pathname.current = "/overlay/fixtures/11111111-1111-1111-1111-111111111111";
    expect(renderIsland(CookieConsent, {}).tree()).toEqual([]);
  });

  it("still renders on the public match page — the positive pair", () => {
    // Without this case the assertion above passes on a component that renders
    // nothing anywhere, which is a different (and much worse) bug. The stub
    // localStorage above has no CONSENT_KEY set, so `needsConsentPrompt()`
    // is true by default — the visitor's normal "first visit" state — and the
    // effect's own `setVisible(true)` drives a second pass through the
    // harness before `.tree()` is read.
    pathname.current = "/shared/acme/summer-cup/div-a/fixtures/1";
    expect(renderIsland(CookieConsent, {}).tree().length).toBeGreaterThan(0);
  });
});
