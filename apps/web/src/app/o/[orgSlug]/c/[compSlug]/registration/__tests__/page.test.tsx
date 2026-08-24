// RS004 W2 — the registration hub route: the owner/admin guard and the
// server-side `?tab=` switch.
//
// `requireCompetitionPage` (page-auth.ts:192-201) already 404s a SCORER on
// its own — that is pre-existing, trusted behaviour, not this page's code, so
// the "propagates the guard's refusal" case below proves this page does not
// accidentally swallow it (no try/catch around the call). A VIEWER reaches
// `requireCompetitionPage` fine with `canEdit:false` (only a scorer is turned
// away there) — registration data is more sensitive than the read-only
// competition-settings page a viewer may already open, so THIS page adds its
// own `canEdit` check. That is the behaviour this file's guard tests actually
// exercise.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const h = vi.hoisted(() => ({
  canEdit: true,
  refuseInGuard: false,
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => {
    if (h.refuseInGuard) throw new Error("NOT_FOUND");
    return {
      auth: { orgId: "org-1" },
      org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
      competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
      canEdit: h.canEdit,
    };
  },
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    name: "Summer League",
    slug: "summer-league",
  }),
}));

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

import Page from "../page";
import { walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });
const noTab = Promise.resolve({});

beforeEach(() => {
  h.canEdit = true;
  h.refuseInGuard = false;
});

describe("registration hub — owner/admin guard", () => {
  it("renders for an editor (owner/admin)", async () => {
    await expect(Page({ params, searchParams: noTab })).resolves.toBeTruthy();
  });

  it("404s a member who cannot edit (viewer)", async () => {
    h.canEdit = false;
    await expect(Page({ params, searchParams: noTab })).rejects.toThrow("NOT_FOUND");
  });

  it("propagates the guard's own refusal (e.g. a scorer) without swallowing it", async () => {
    h.refuseInGuard = true;
    await expect(Page({ params, searchParams: noTab })).rejects.toThrow("NOT_FOUND");
  });
});

describe("registration hub — ?tab= switching", () => {
  it("defaults to the Settings panel with no ?tab=", async () => {
    const tree = walk(await Page({ params, searchParams: noTab }));
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
  });

  it("falls back to Settings on a garbage ?tab=", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "bogus" }) }));
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
  });

  it("switches to the Registrants panel with ?tab=registrants", async () => {
    const tree = walk(
      await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }),
    );
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(false);
  });
});
