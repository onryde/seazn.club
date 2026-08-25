// RS004 W2 — the registration hub's `?tab=` derivation, tested as a pure
// function (dispatch requirement: exported and proven directly, not only
// through the page). Mirrors the division page's server-side tab pattern
// (d/[divSlug]/page.tsx) but has no role-gated tab: the hub itself is
// owner/admin-only (the page's own guard), so both tabs are always offered.
import { describe, expect, it } from "vitest";
import {
  REGISTRATION_HUB_TABS,
  resolveRegistrationHubTab,
} from "@/components/registration-hub-tab";

describe("resolveRegistrationHubTab", () => {
  it("defaults to settings when no tab is requested", () => {
    expect(resolveRegistrationHubTab(undefined)).toBe("settings");
  });

  it("falls back to settings on an unrecognised tab value", () => {
    expect(resolveRegistrationHubTab("bogus")).toBe("settings");
  });

  it("falls back to settings on an empty string", () => {
    expect(resolveRegistrationHubTab("")).toBe("settings");
  });

  it("honours an explicit settings tab", () => {
    expect(resolveRegistrationHubTab("settings")).toBe("settings");
  });

  it("honours an explicit registrants tab", () => {
    expect(resolveRegistrationHubTab("registrants")).toBe("registrants");
  });

  it("exposes exactly the two hub tabs, in landing order", () => {
    expect(REGISTRATION_HUB_TABS).toEqual(["settings", "registrants"]);
  });

  // RS004 W2b review finding 3 — coverage only, not a behaviour fix: the
  // whitelist `.includes()` check is safe by construction against ANY value
  // it does not recognise, so both cases below already passed before this
  // wave and still pass after it. Characterisation tests, pinning that
  // safety rather than proving a bug was fixed.
  it("characterisation: falls back to settings on a case-varying ?tab=Settings — no case-insensitive matching", () => {
    expect(resolveRegistrationHubTab("Settings")).toBe("settings");
  });

  it("characterisation: falls back to settings on Next's array-valued repeated ?tab=a&tab=b", () => {
    // Next's real runtime shape for a repeated query key is a string[],
    // which the page's `{ tab?: string }` searchParams type doesn't
    // capture — the cast exercises that shape directly (production code
    // never manufactures this value itself; Next's own request parsing
    // does) rather than asserting something TS would reject as written.
    expect(resolveRegistrationHubTab(["a", "b"] as unknown as string)).toBe("settings");
  });
});
