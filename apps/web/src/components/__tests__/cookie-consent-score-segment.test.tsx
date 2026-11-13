// OWNER RULING (2026-11-13): the scoring pad (`/score/<token>`) renders no consent banner. A scorer at a court taps the
// pad's bottom controls on a phone, and the banner sat over them; there is nothing to consent to there, because PostHog
// inits opt_out_capturing_by_default and opts in only on an explicit Accept (instrumentation-client.ts).
//
// Driven through `renderIsland` with `next/navigation` mocked, as `cookie-consent-kiosk-segment.test.tsx` does, with the
// same `window` / `localStorage` stubs (vitest runs `environment: "node"` here).
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

const shown = (path: string) => {
  pathname.current = path;
  // Hydrate mode: "consent needed" is read from storage after hydration, so the default mode would show nothing anywhere
  // and make the "renders nothing" half of this file vacuous.
  return renderIsland(CookieConsent, {}, undefined, { hydrate: true }).tree().length > 0;
};

describe("CookieConsent on the scoring pad", () => {
  it("renders nothing on /score/<token>", () => {
    expect(shown("/score/abc123token")).toBe(false);
  });

  it("still renders on the pages around it — the positive pair", () => {
    expect(shown("/"), "home").toBe(true);
    expect(shown("/live/acme/summer-cup"), "a hub page").toBe(true);
  });

  it("is matched on the path's shape, so other pages keep their banner", () => {
    expect(shown("/live/acme/cup/scores"), "a hub page ending in scores").toBe(true);
    expect(shown("/live/acme/score/abc"), "a hub page with a score segment").toBe(true);
    expect(shown("/o/acme/score/abc"), "an org route with a score segment").toBe(true);
    expect(shown("/score"), "/score alone is not a pad").toBe(true);
    expect(shown("/score/abc/extra"), "a deeper path is not the pad").toBe(true);
    expect(shown("/scores/abc"), "a different first segment").toBe(true);
  });
});
