// RS004 W2 — the competition overview's "Registration" nav entry: live
// counts (open divisions, total registered) computed from the query the page
// ALREADY runs (`listDivisionCardStats`, card-stats.ts) — no second query, no
// client fetch, no N+1 per division — and shown only to a role that may edit.
//
// RS004 W2b review finding 1: `registered`/`awaiting_confirmation` replaced
// `entrants` as the pill's source (an `entrants` row only exists once an
// entry is materialised — see card-stats-registration-counts.test.ts for the
// real-Postgres proof that the QUERY counts correctly). This file proves the
// separate, narrower thing: that the PAGE sums the right fields into the
// right badge props. `registered` is deliberately set DIFFERENT from
// `entrants` per division below — if the page regressed to reading
// `entrants` again, these assertions would catch it.
//
// Mock recipe copied from the proven
// competition-header-trial-promise.test.tsx (same page, same shape) plus the
// two mocks this test actually varies: `listDivisions`/`listDivisionCardStats`
// carry real per-division data so the counts are computed from something.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";

const h = vi.hoisted(() => {
  // Two open-for-registration divisions, one closed. `registered` sums to
  // 17 (9 + 7 + 1) — NOT 14 (the old `entrants` sum, 9 + 5 + 0) — and
  // `awaiting_confirmation` sums to 3 (0 + 2 + 1): d-2 carries 2 entries not
  // yet confirmed (e.g. manual-approval pending/paid) on top of its 5
  // materialised entrants, and d-3 carries 1 waitlisted entry despite being
  // CLOSED (registration_open: false) and having zero entrants — exactly
  // the "closed division with real registrations that read as zero" bug
  // finding 1 reported.
  const defaultStats = () =>
    new Map<string, Record<string, unknown>>([
      [
        "d-1",
        {
          division_id: "d-1",
          entrants: 9,
          registered: 9,
          awaiting_confirmation: 0,
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
          registered: 7,
          awaiting_confirmation: 2,
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
          registered: 1,
          awaiting_confirmation: 1,
          capacity: null,
          stage_kinds: [],
          registration_open: false,
          played: 0,
          total: 0,
          next: null,
        },
      ],
    ]);
  return { canEdit: true, stats: defaultStats(), defaultStats };
});

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
  listDivisionCardStats: async () => h.stats,
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
  h.stats = h.defaultStats();
});

describe("competition overview — the Registration nav entry", () => {
  it("shows live counts computed from the existing card-stats query: 2 open divisions of 3, 17 registered, 3 awaiting confirmation", async () => {
    const tree = walk(await Page({ params }));
    const entry = tree.find((e) => e.type === RegistrationHubNavEntry);
    expect(entry).toBeTruthy();
    const props = propsOf(entry!);
    expect(props.openBadge).toContain("2");
    // 9 + 7 + 1 = 17 (`registered`) — NOT 14 (the old `entrants` sum,
    // 9 + 5 + 0). A regression back to reading `.entrants` would fail this.
    expect(props.registeredBadge).toContain("17");
    expect(props.registeredBadge).not.toContain("14");
    // 0 + 2 + 1 = 3, including d-3's 1 waitlisted entry despite that
    // division being CLOSED and having zero entrants.
    expect(props.awaitingBadge).toContain("3");
    expect(props.href).toBe("/o/riverside/c/summer-league/registration");
  });

  it("omits the awaiting-confirmation badge entirely (not a literal '0') once nothing needs it", async () => {
    h.stats = new Map(
      [...h.defaultStats()].map(([id, s]) => [id, { ...s, awaiting_confirmation: 0 }]),
    );
    const tree = walk(await Page({ params }));
    const entry = tree.find((e) => e.type === RegistrationHubNavEntry);
    expect(propsOf(entry!).awaitingBadge).toBeUndefined();
  });

  it("hides the entry for a role that cannot edit (viewer/scorer)", async () => {
    h.canEdit = false;
    const tree = walk(await Page({ params }));
    expect(tree.some((e) => e.type === RegistrationHubNavEntry)).toBe(false);
  });
});
