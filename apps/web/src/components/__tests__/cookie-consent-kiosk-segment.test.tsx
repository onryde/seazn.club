// OWNER RULING (2026-09-16): the /present board renders no consent banner. A
// venue TV has nobody to dismiss it, so it sat over the board all day, and
// below the TV cut-off the same route shows the "made for a TV" card, where the
// banner covered "Open the live page" at 320 — the card's only real control.
// Nothing is withheld by hiding it: PostHog inits opt_out_capturing_by_default
// and opts in only on an explicit Accept (instrumentation-client.ts), so a
// banner-free page captures nothing.
//
// Driven through `renderIsland` with `next/navigation` mocked, the way
// `cookie-consent-overlay-segment.test.tsx` does it — a source scan could not
// tell a rendered banner from a suppressed one, which is the whole claim. The
// same `window` / bare-global `localStorage` stubs are needed: vitest runs
// `environment: "node"` here, and the component's effect touches both.
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
  return renderIsland(CookieConsent, {}).tree().length > 0;
};

describe("CookieConsent on the kiosk board", () => {
  it("renders nothing on either /present board, so a venue TV never carries it", () => {
    expect(shown("/shared/acme/summer-cup/present"), "competition board").toBe(false);
    expect(shown("/shared/acme/summer-cup/div-a/present"), "division board").toBe(false);
  });

  it("still renders on the pages around it — the positive pair", () => {
    // Without these the assertion above passes on a component that renders
    // nothing anywhere. The stub localStorage holds no consent, so this is the
    // visitor's normal first visit.
    expect(shown("/shared/acme/summer-cup"), "the competition hub the card links to").toBe(true);
    expect(shown("/shared/acme/summer-cup/div-a"), "a division page").toBe(true);
  });

  it("is matched on the path's shape, so a competition actually slugged \"present\" keeps its banner", () => {
    // `/shared/<org>/present` is a hub page, not a board: a bare endsWith
    // check would silently strip consent from it.
    expect(shown("/shared/acme/present"), "a competition slugged present").toBe(true);
    // And a deeper page that merely ends in the word is not a board either.
    expect(shown("/shared/acme/summer-cup/div-a/fixtures/present"), "a fixture slugged present").toBe(true);
    // A path of the same SHAPE outside /shared is not a board either. Without
    // this case, dropping the `parts[0] === "shared"` test kills nothing —
    // every other path here is under /shared, so the check is free to be wrong.
    expect(shown("/orgs/acme/summer-cup/present"), "an organiser route of the same shape").toBe(true);
  });
});
