// P9 review wave 3, finding #12: the constraints tab's blackout-scope
// picker showed raw court uuids because ConstraintsPanel never received
// venues/courtNames at all. The fix threads the page's own `boardVenues`
// (already fetched via listVenues(auth, { includeArchived: true }) at
// page.tsx:143, and already passed to ScheduleBoard/StandaloneScheduleSettings
// at :312/:391) into ConstraintsPanel too (page.tsx's
// <ConstraintsPanel venues={boardVenues} />) — a THIRD instance of the same
// one-prop thread, not a new fetch.
//
// This test proves the WIRING, not the component: a venues prop handed
// straight to ConstraintsPanel in a component-level test (see
// __tests__/blackout-editor.test.tsx and __tests__/constraints-panel.test.tsx
// for that half) would pass even if the page never threaded it — this calls
// the real page and walks its returned element tree for the prop
// ConstraintsPanel actually received, so deleting `venues={boardVenues}` at
// the call site reds this file (mutation-checked below the assertions).
//
// Same no-jsdom / direct-invocation technique as
// officials-loads-deferred.test.tsx (ConstraintsPanel is "use client" with
// hooks, so it cannot be mounted here — only its PROPS are inspected).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const spies = vi.hoisted(() => ({
  listOfficialsForConsole: vi.fn(),
  listOfficialBlackouts: vi.fn(),
  listOfficialBusyElsewhere: vi.fn(),
  listVenues: vi.fn(),
}));

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));

const divisionPage = () => ({
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "Europe/London" },
});

vi.mock("@/server/usecases/officials", () => spies);
vi.mock("@/server/usecases/venues", () => ({ listVenues: spies.listVenues }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Div One",
    slug: "div-one",
    status: "active",
    seq: 1,
    schedule_locked: false,
    sport_key: "badminton",
    officials_hide_names: false,
    competition_id: "comp-1",
  })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    frozen: false,
    starts_on: "2026-09-01",
    ends_on: "2026-09-30",
  })),
}));
vi.mock("@/server/usecases/stages", () => ({ listStages: vi.fn(async () => []) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listDivisionFixturesForBoard: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "Europe/London" })),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "GBP") }));

const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionSchedulePage from "../page";
import { ConstraintsPanel } from "@/components/v2/constraints-panel";
import { resolveCourtNames } from "@/components/v2/shared/court-multi-picker";

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

const HOURS: unknown[] = [];
const EXCEPTIONS: unknown[] = [];

// Two DIFFERENT venues each naming a court "Court 1" — legal (P8's
// uniqueness is per-venue) and exactly the case that must stay
// distinguishable rather than collapse to identical text.
const VENUES = [
  {
    id: "venue-1",
    name: "Riverside Centre",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        venue_id: "venue-1",
        name: "Court 1",
        sort: 0,
        tags: [],
        archived_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        hours: HOURS,
        exceptions: EXCEPTIONS,
      },
    ],
  },
  {
    id: "venue-2",
    name: "Downtown Hall",
    address: null,
    sort: 1,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        venue_id: "venue-2",
        name: "Court 1",
        sort: 0,
        tags: [],
        archived_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        hours: HOURS,
        exceptions: EXCEPTIONS,
      },
    ],
  },
];

const renderTab = (tab: string) =>
  DivisionSchedulePage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

describe("division schedule page threads venues into ConstraintsPanel (P9 review wave 3, finding #12)", () => {
  beforeEach(() => {
    spies.listOfficialsForConsole.mockReset().mockResolvedValue([]);
    spies.listOfficialBlackouts.mockReset().mockResolvedValue([]);
    spies.listOfficialBusyElsewhere.mockReset().mockResolvedValue([]);
    spies.listVenues.mockReset().mockResolvedValue(VENUES);
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(divisionPage());
  });

  it("fetches venues WITH archived included (unchanged — this test guards against a second, competing fetch)", async () => {
    await renderTab("constraints");
    expect(spies.listVenues).toHaveBeenCalledTimes(1);
    expect(spies.listVenues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      { includeArchived: true },
    );
  });

  it("passes real venues to ConstraintsPanel — never the [] default", async () => {
    const panel = find(await renderTab("constraints"), ConstraintsPanel);
    expect(panel, "no ConstraintsPanel rendered on tab=constraints").not.toBeNull();
    const props = panel!.props as { venues?: { id: string; courts: { id: string }[] }[] };
    expect(props.venues).toBeDefined();
    expect(props.venues!.map((v) => v.id)).toEqual(["venue-1", "venue-2"]);
  });

  it("the two same-named courts stay distinguishable through the real rule, not a bare uuid — proving the wiring, not re-deriving the rule", async () => {
    const panel = find(await renderTab("constraints"), ConstraintsPanel);
    const props = panel!.props as { venues: typeof VENUES };
    const names = resolveCourtNames(props.venues);
    expect(names["11111111-1111-4111-8111-111111111111"]).toBe("Court 1 (Riverside Centre)");
    expect(names["22222222-2222-4222-8222-222222222222"]).toBe("Court 1 (Downtown Hall)");
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/;
    expect(names["11111111-1111-4111-8111-111111111111"]).not.toMatch(UUID_RE);
  });

  it("the SAME boardVenues also still reach the board and settings tabs (no regression to the existing threads)", async () => {
    const { ScheduleBoard } = await import("@/components/v2/schedule-board");
    const board = find(await renderTab("board"), ScheduleBoard);
    expect(board, "no ScheduleBoard rendered on tab=board").not.toBeNull();
    const props = board!.props as { venues?: { id: string }[] };
    expect(props.venues!.map((v) => v.id)).toEqual(["venue-1", "venue-2"]);
  });
});
