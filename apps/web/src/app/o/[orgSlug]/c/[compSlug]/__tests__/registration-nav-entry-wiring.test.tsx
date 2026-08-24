// RS004 W2 — the competition overview's "Registration" nav entry: live
// counts (open divisions, total registered) computed from the query the page
// ALREADY runs (`listDivisionCardStats`, card-stats.ts) — no second query, no
// client fetch, no N+1 per division — and shown only to a role that may edit.
//
// Mock recipe copied from the proven
// competition-header-trial-promise.test.tsx (same page, same shape) plus the
// two mocks this test actually varies: `listDivisions`/`listDivisionCardStats`
// carry real per-division data so the counts are computed from something.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";

const h = vi.hoisted(() => ({ canEdit: true }));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: h.canEdit,
  }),
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    org_id: "org-1",
    name: "Summer League",
    slug: "summer-league",
    description: null,
    starts_on: null,
    ends_on: null,
    visibility: "private",
    branding: null,
    status: "live",
    created_at: new Date().toISOString(),
    discoverable: false,
    discovery: null,
    frozen: false,
  }),
}));

// Two open-for-registration divisions, one closed — 9 + 5 = 14 registered
// entrants total, matching the badges asserted below.
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: async () => [
    { id: "d-1", name: "Open", slug: "open", sport_key: "generic", archived_at: null },
    { id: "d-2", name: "U18", slug: "u18", sport_key: "generic", archived_at: null },
    { id: "d-3", name: "Masters", slug: "masters", sport_key: "generic", archived_at: null },
  ],
}));

vi.mock("@/server/usecases/card-stats", () => ({
  listDivisionCardStats: async () =>
    new Map([
      [
        "d-1",
        {
          division_id: "d-1",
          entrants: 9,
          capacity: null,
          stage_kinds: [],
          registration_open: true,
          played: 0,
          total: 0,
          next: null,
        },
      ],
      [
        "d-2",
        {
          division_id: "d-2",
          entrants: 5,
          capacity: null,
          stage_kinds: [],
          registration_open: true,
          played: 0,
          total: 0,
          next: null,
        },
      ],
      [
        "d-3",
        {
          division_id: "d-3",
          entrants: 0,
          capacity: null,
          stage_kinds: [],
          registration_open: false,
          played: 0,
          total: 0,
          next: null,
        },
      ],
    ]),
  nextLine: () => null,
  formatLabel: () => null,
}));

vi.mock("@/server/public-site/data", () => ({ resolveLogoUrl: () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/billing", () => ({
  checkoutTrialDays: (sub?: { trial_used_at: string | null }) => (sub?.trial_used_at ? 0 : 14),
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([{ trial_used_at: null }]);
  },
}));

import Page from "../page";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });

beforeEach(() => {
  h.canEdit = true;
});

describe("competition overview — the Registration nav entry", () => {
  it("shows live counts computed from the existing card-stats query: 2 open divisions of 3, 14 registered", async () => {
    const tree = walk(await Page({ params }));
    const entry = tree.find((e) => e.type === RegistrationHubNavEntry);
    expect(entry).toBeTruthy();
    const props = propsOf(entry!);
    expect(props.openBadge).toContain("2");
    expect(props.registeredBadge).toContain("14");
    expect(props.href).toBe("/o/riverside/c/summer-league/registration");
  });

  it("hides the entry for a role that cannot edit (viewer/scorer)", async () => {
    h.canEdit = false;
    const tree = walk(await Page({ params }));
    expect(tree.some((e) => e.type === RegistrationHubNavEntry)).toBe(false);
  });
});
