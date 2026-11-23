// W5 follow-ups B3 (perf-measure-report P3): the public division page sent every tab's panel in one document - at the caps
// the hidden Fixtures panel was 43k of the Standings view's 45k DOM nodes, and `Schedule`'s fixtures went over the wire twice
// (rendered rows plus the client prop). Now each tab is its own ISR document: the bare route carries Schedule only, and
// `tab/standings` / `tab/entrants` (the proxy's rewrite of `?tab=`) carry theirs, while the tab bar stays whole. The
// Schedule's fixtures go over packed and must unpack to exactly the rows the loader returned.
//
// The scene is a knockout division with fixtures and entrants (Bracket in Standings, cards in Entrants), behind the same
// loader seam as the page's other plumbing tests. Every tab is checked (DIVISION_TABS), and a tab param the page does not
// route is no page.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/table-withdrawals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/table-withdrawals")>()),
  loadTableWithdrawals: async () => [],
}));
vi.mock("@/server/public-site/points-adjustments", () => ({ loadPointsAdjustments: async () => [] }));
vi.mock("@/server/public-site/bestnth-basis", () => ({ loadBestNthBases: async () => new Map() }));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { Bracket } from "@/components/public-site/bracket";
import { PackedSchedule } from "@/components/public-site/packed-schedule";
import { Tabs } from "@/components/public-site/tabs";
import { DIVISION_TABS } from "@/lib/division-tabs";
import { unpackRows } from "@/lib/packed-rows";
import type { PublicFixture } from "@/server/public-site/data";
import DivisionHomePage from "../page";

function find(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) find(child, type, out);
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) find(value, type, out);
  }
  return out;
}

const T = "2026-10-01T09:00:00.000Z";
const fixture = (id: string, round: number, seq: number, home: string | null, away: string | null, status: string): PublicFixture =>
  ({
    id, stage_id: "ko", pool_id: null, round_no: round, seq_in_round: seq, home_entrant_id: home, away_entrant_id: away,
    status, scheduled_at: T, court_label: null, winner_entrant_id: status === "decided" ? home : null, summary: null,
    home_slot_label: null, away_slot_label: null,
  }) as unknown as PublicFixture;
const entrant = (id: string, name: string, seed: number) =>
  ({ id, name, seed, kind: "team", status: "active", club_name: null, members: [], badge_url: null }) as unknown;

const scene = () => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
  competition: { id: "c1", org_id: "o1", name: "Cup", slug: "cup", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
  division: {
    id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "badminton", variant_key: "doubles",
    status: "active", module_version: null, tiebreakers: null, sport_name: null, entrant_count: 4, config: {},
  },
  stages: [{ id: "ko", division_id: "d1", seq: 1, kind: "knockout", name: "Knockout", status: "active" }],
  pools: [],
  fixtures: [
    fixture("f1", 1, 1, "e1", "e4", "decided"),
    fixture("f2", 1, 2, "e2", "e3", "scheduled"),
    fixture("f3", 2, 1, null, null, "scheduled"),
  ],
  standings: [],
  entrants: [entrant("e1", "Side 1", 1), entrant("e2", "Side 2", 2), entrant("e3", "Side 3", 3), entrant("e4", "Side 4", 4)],
  tz: "UTC",
});
const params = { orgSlug: "test-org", competitionSlug: "cup", divisionSlug: "open" };
const documentFor = (tab: string | undefined) =>
  DivisionHomePage({ params: Promise.resolve(tab === undefined ? params : { ...params, tab }) });

describe("B3 the public division page is one document per tab", () => {
  it("each tab's document carries the whole tab bar, its own panel and no other; the bar opens on that panel", async () => {
    getPublicDivision.mockResolvedValue(scene());
    let checked = 0;
    for (const tab of DIVISION_TABS) {
      const root = await documentFor(tab === "schedule" ? undefined : tab);
      const bars = find(root, Tabs);
      expect(bars, `${tab}: one tab bar`).toHaveLength(1);
      const bar = bars[0]!.props as { ids: string[]; initial: number; children: unknown[] };
      expect(bar.ids, `${tab}: every tab is still offered`).toEqual([...DIVISION_TABS]);
      expect(bar.initial, `${tab}: the bar opens on this document's panel`).toBe(DIVISION_TABS.indexOf(tab));
      expect(bar.children.map((c) => c != null), `${tab}: only its own panel is rendered`).toEqual(DIVISION_TABS.map((t) => t === tab));
      // The heavy content follows its panel: the fixtures list only in Schedule, the Bracket only in Standings.
      expect(find(root, PackedSchedule).length, `${tab}: fixtures list`).toBe(tab === "schedule" ? 1 : 0);
      expect(find(root, Bracket).length, `${tab}: bracket`).toBe(tab === "standings" ? 1 : 0);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every tab").toBe(3);
  });

  it("the Schedule's fixtures go over packed and unpack to exactly the rows the loader returned", async () => {
    const data = scene();
    getPublicDivision.mockResolvedValue(data);
    const [schedule] = find(await documentFor(undefined), PackedSchedule);
    const sent = (schedule!.props as { fixtures: unknown }).fixtures;
    expect(Array.isArray(sent), "premise: packed, not the array").toBe(false);
    const back = unpackRows(JSON.parse(JSON.stringify(sent)) as never);
    expect(back).toEqual(JSON.parse(JSON.stringify(data.fixtures)));
    expect(back.length, "anti-vacuity").toBe(3);
  });

  it("a tab the page does not route is no page - Schedule has the bare route, and an unknown name is nothing", async () => {
    getPublicDivision.mockResolvedValue(scene());
    let refused = 0;
    for (const tab of ["schedule", "fixtures", "Standings", ""]) {
      await expect(documentFor(tab), `tab/${tab}`).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
      refused += 1;
    }
    expect(refused).toBe(4);
  });
});
