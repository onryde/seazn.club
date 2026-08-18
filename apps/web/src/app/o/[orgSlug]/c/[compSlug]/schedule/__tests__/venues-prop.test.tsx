// P9 review wave 3, finding #4: the joint (competition) board rendered
// <ScheduleBoard> WITHOUT the `venues` prop, which defaults to []. With no
// venues, ScheduleBoard's own `courtNamesById` (built via resolveCourtNames)
// is empty on the whole page — column headers, the swap button, MovePanel's
// court <select> and the settings card's court picker all showed bare uuids,
// and the picker offered nothing to select. The division board
// (../../d/[divSlug]/schedule/page.tsx) already fetches
// `listVenues(auth, { includeArchived: true })` and passes it through — this
// proves the joint page now does the same, archived courts included (an
// archived court still holding a placed fixture must still render its NAME).
//
// No jsdom in this workspace, and ScheduleBoard is a client component with
// hooks, so this calls the server component directly and walks the returned
// element tree for its `venues` prop — same technique as
// d/[divSlug]/schedule/__tests__/officials-loads-deferred.test.tsx. This
// proves the WIRING, not the component: a courtNames/venues prop handed
// straight to a component in a unit test would pass even if the page never
// threaded it through.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const spies = vi.hoisted(() => ({ listVenues: vi.fn() }));
vi.mock("@/server/usecases/venues", () => spies);

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: vi.fn(async () => ({
    auth: { orgId: "org-1", userId: "user-1", role: "owner" },
    canEdit: true,
    org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "Europe/London" },
    competition: { id: "comp-1", slug: "comp" },
  })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    name: "Comp One",
    frozen: false,
    starts_on: "2026-09-01",
    ends_on: "2026-09-30",
  })),
}));
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: vi.fn(async () => [
    { id: "div-1", name: "Div One", slug: "div-one", status: "active", seq: 1, schedule_locked: false },
  ]),
}));
vi.mock("@/server/usecases/stages", () => ({ listStages: vi.fn(async () => []) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixturesForBoard: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "Europe/London" })),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "usd") }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
}));

import CompetitionSchedulePage from "../page";
import { ScheduleBoard } from "@/components/v2/schedule-board";
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

const renderPage = () =>
  CompetitionSchedulePage({ params: Promise.resolve({ orgSlug: "org", compSlug: "comp" }) });

describe("joint competition schedule page feeds ScheduleBoard its venues (P9 review wave 3, finding #4)", () => {
  beforeEach(() => {
    spies.listVenues.mockReset().mockResolvedValue(VENUES);
  });

  it("fetches venues WITH archived included, same as the division board", async () => {
    await renderPage();
    expect(spies.listVenues).toHaveBeenCalledTimes(1);
    expect(spies.listVenues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      { includeArchived: true },
    );
  });

  it("passes the fetched venues to ScheduleBoard — never the [] default", async () => {
    const board = find(await renderPage(), ScheduleBoard);
    expect(board, "no ScheduleBoard rendered").not.toBeNull();
    const props = board!.props as { venues?: { id: string; courts: { id: string }[] }[] };
    expect(props.venues).toBeDefined();
    expect(props.venues!.map((v) => v.id)).toEqual(["venue-1", "venue-2"]);
  });

  it("two courts sharing a bare name in different venues stay distinguishable through the real rule — never a bare uuid", async () => {
    const board = find(await renderPage(), ScheduleBoard);
    const props = board!.props as { venues: typeof VENUES };
    const names = resolveCourtNames(props.venues);
    expect(names["11111111-1111-4111-8111-111111111111"]).toBe("Court 1 (Riverside Centre)");
    expect(names["22222222-2222-4222-8222-222222222222"]).toBe("Court 1 (Downtown Hall)");
    expect(names["11111111-1111-4111-8111-111111111111"]).not.toBe(
      names["22222222-2222-4222-8222-222222222222"],
    );
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/;
    expect(names["11111111-1111-4111-8111-111111111111"]).not.toMatch(UUID_RE);
    expect(names["22222222-2222-4222-8222-222222222222"]).not.toMatch(UUID_RE);
  });
});
