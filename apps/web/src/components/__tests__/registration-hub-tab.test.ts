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
});
