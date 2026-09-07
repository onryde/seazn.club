// #230 item 4 — the schedule page must not pay for officials data on tabs that
// never show it.
//
// The page loaded `listOfficialsForConsole`, `listOfficialBlackouts` and
// `listOfficialBusyElsewhere` inside its top-level `Promise.all`, unconditional
// on `tab`. Board, Settings, Constraints and History therefore each paid for
// the whole org officials roster plus a cross-organisation busy read on every
// navigation. `listOfficialBusyElsewhere` is the one that matters: it runs on
// the bare superuser connection by design (officials.ts:113-137 — the read
// straddles two orgs, so `withTenant` cannot express it), and a deliberately
// cross-tenant read should execute when someone is actually looking at the
// Officials tab, not on every board load.
//
// `officialsMeta` in the same file was already gated on `tab === "officials"`,
// so these three were the outliers, not a deliberate exception.
//
// Blackouts are the exception to the exception: the board's AI preflight line
// ("N with blackout dates" — ai-preflight.tsx:99) is fed by
// `ScheduleBoard.officialsWithBlackout`, which is derived from this list. So
// blackouts load on board AND officials; the roster and the busy read load on
// officials only. That split is asserted below in both directions.
//
// No jsdom in this workspace, and ScheduleBoard is a client component with
// hooks — so this calls the server component and walks the returned element
// tree for props rather than rendering it (same reasoning as the source-text
// assertion in app/__tests__/tab-strips-scrollable.test.ts, one level up).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const spies = vi.hoisted(() => ({
  listOfficialsForConsole: vi.fn(),
  listOfficialBlackouts: vi.fn(),
  listOfficialBusyElsewhere: vi.fn(),
}));

// Hoisted so a single test can hand the page a differently-shaped membership;
// the default is re-installed in `beforeEach`.
const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));

/** The shape `requireDivisionPage` really returns. `org` is NOT optional on it
 *  (`page-auth.ts:28`, `org: OrgMembership`) — this stub used to omit it, which
 *  only typechecked because a `vi.mock` factory is untyped, and stayed harmless
 *  for exactly as long as nothing read it. */
/*  No DEFAULT on `timezone`: `divisionPage(undefined)` would silently take it
 *  and hand back a zoned org, so the payer-placeholder test below would assert
 *  against the wrong fixture. Callers state the zone, or state its absence. */
const divisionPage = (timezone: string | undefined) => ({
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone },
});

const OFFICIALS = [
  {
    id: "off-1",
    display_name: "Ada Ref",
    role_keys: ["referee"],
    entrant_id: null,
    max_per_day: 2,
    email: "ada@example.test",
    claimed: true,
    invite_pending: false,
  },
  {
    id: "off-2",
    display_name: "Bo Ump",
    role_keys: ["umpire"],
    entrant_id: null,
    max_per_day: null,
    email: null,
    claimed: false,
    invite_pending: true,
  },
];
// Two DISTINCT officials, three rows: the board prop is a distinct-id count, so
// a test with one row per official could not tell `.length` from `new Set(…)`.
const BLACKOUTS = [
  { official_id: "off-1", date: "2026-09-01", note: null },
  { official_id: "off-1", date: "2026-09-02", note: null },
  { official_id: "off-2", date: "2026-09-03", note: "away" },
];
const BUSY = [{ official_id: "off-1", scheduled_at: "2026-09-04T10:00:00.000Z" }];

vi.mock("@/server/usecases/officials", () => spies);

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
// Both readers are mocked: the board tab reads through the narrower
// listDivisionFixturesForBoard projection (F1 — it omits the five bracket
// round-role columns the board never renders), every other caller still
// reads the full row. Mocking only one leaves the page importing a name the
// factory does not export, which vitest rejects at module load.
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listDivisionFixturesForBoard: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "Europe/London" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "GBP") }));

// `withTenant` serves the feed-row read and the officials marks/reports block;
// neither is what this test is about, so both get an empty tagged-template tx.
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionSchedulePage from "../page";
import { ScheduleBoard } from "@/components/v2/schedule-board";
import { OfficialsPanel } from "@/components/v2/officials-panel";

/** Depth-first search of a returned server-component tree for one element type. */
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

const renderTab = (tab?: string) =>
  DivisionSchedulePage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  });

describe("division schedule page defers officials loads to the officials tab", () => {
  beforeEach(() => {
    spies.listOfficialsForConsole.mockReset().mockResolvedValue(OFFICIALS);
    spies.listOfficialBlackouts.mockReset().mockResolvedValue(BLACKOUTS);
    spies.listOfficialBusyElsewhere.mockReset().mockResolvedValue(BUSY);
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(divisionPage("Europe/London"));
  });

  // `undefined` is the real default landing (no ?tab= on the first visit) and
  // is listed separately from "board" so a gate keyed on the raw search param
  // rather than the resolved tab cannot pass.
  for (const tab of [undefined, "board", "settings", "constraints", "history"]) {
    it(`does not read the officials roster or the cross-org busy table on tab=${tab ?? "(default)"}`, async () => {
      await renderTab(tab);
      expect(spies.listOfficialsForConsole).not.toHaveBeenCalled();
      expect(spies.listOfficialBusyElsewhere).not.toHaveBeenCalled();
    });
  }

  for (const tab of ["settings", "constraints", "history"]) {
    it(`does not read blackouts on tab=${tab} either — only board needs the count`, async () => {
      await renderTab(tab);
      expect(spies.listOfficialBlackouts).not.toHaveBeenCalled();
    });
  }

  it("still gives the board its blackout COUNT, which feeds the AI preflight line", async () => {
    const board = find(await renderTab("board"), ScheduleBoard);
    expect(board, "no ScheduleBoard rendered on tab=board").not.toBeNull();
    expect(spies.listOfficialBlackouts).toHaveBeenCalledTimes(1);
    // Distinct officials, not rows: BLACKOUTS has 3 rows across 2 officials.
    expect((board!.props as { officialsWithBlackout: number }).officialsWithBlackout).toBe(2);
  });

  it("still gives the officials tab the roster, the blackouts and the busy rows", async () => {
    const panel = find(await renderTab("officials"), OfficialsPanel);
    expect(panel, "no OfficialsPanel rendered on tab=officials").not.toBeNull();
    const props = panel!.props as {
      officials: { id: string }[];
      blackouts: typeof BLACKOUTS;
      busyElsewhere: typeof BUSY;
    };
    expect(props.officials.map((o) => o.id)).toEqual(["off-1", "off-2"]);
    expect(props.blackouts).toEqual(BLACKOUTS);
    expect(props.busyElsewhere).toEqual(BUSY);
    expect(spies.listOfficialsForConsole).toHaveBeenCalledTimes(1);
    expect(spies.listOfficialBlackouts).toHaveBeenCalledTimes(1);
    expect(spies.listOfficialBusyElsewhere).toHaveBeenCalledTimes(1);
  });

  // The page resolves the governing venue clock from `page.org.timezone`, and
  // one real caller cannot supply it: the PAYER PLACEHOLDER branch of
  // `requireDivisionPage` (page-auth.ts:179) builds `org` from four fields and
  // casts it `as unknown as OrgMembership`, so `timezone` is genuinely absent
  // there. That cast means tsc will never flag it. `resolveVenueTz` is what
  // makes it safe — a missing zone falls through to DEFAULT_TZ (tz.ts:44-51)
  // — so this pins the fallback rather than the crash, and would fail against
  // any future non-null-safe read (`page.org.timezone.trim()`, a helper that
  // throws on undefined, a switch to `settings.orgTz`).
  it("falls back to UTC when the membership carries no timezone (payer placeholder)", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue(divisionPage(undefined));
    const board = find(await renderTab("board"), ScheduleBoard);
    expect(board, "no ScheduleBoard rendered on tab=board").not.toBeNull();
    const { settings } = board!.props as { settings: { orgTz: string } };
    expect(settings.orgTz).toBe("UTC");

    // Control: the same path with a zone present must NOT report UTC, or the
    // assertion above would hold for a page that ignored `org.timezone`.
    pageAuth.requireDivisionPage.mockResolvedValue(divisionPage("Pacific/Auckland"));
    const zoned = find(await renderTab("board"), ScheduleBoard);
    expect((zoned!.props as { settings: { orgTz: string } }).settings.orgTz).toBe(
      "Pacific/Auckland",
    );
  });
});
