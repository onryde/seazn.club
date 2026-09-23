// Pools read Pool A above Pool B on every surface that draws one standings
// table per pool — the order is `lib/pool-order.ts`'s, the one authority.
//
// The public division page and the embed are driven here with their data
// doors mocked, and the `StandingsTable` elements each returns are read in
// tree order. The pools' ids sort OPPOSITE to their names and the snapshots
// arrive in id order, so a page that sorts by pool id (the division page did)
// or keeps query order (the embed did) reads B first and reds here.
//
// The hub is `competition-hub.test.ts`'s ("pools read Pool A above Pool B").
// The organiser console reads its pools through its own tenant query; that
// page needs a signed-in organiser to render, so its wiring is pinned from
// the source below and driven for real in `e2e/standings-qualification.spec.ts`.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));
const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import type { PublicEntrant, PublicStandings } from "@/server/public-site/data";
import EmbedWidgetPage from "@/app/embed/divisions/[id]/[widget]/page";
import DivisionHomePage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page";
import { StandingsTable } from "../standings-table";

// "f…" sorts after "0…": Pool A's id is the LATER one.
const POOL_A = "ffffffff-0000-4000-8000-00000000000a";
const POOL_B = "00000000-0000-4000-8000-00000000000b";

const entrant = (id: string, seed: number): PublicEntrant => ({
  id,
  division_id: "d1",
  kind: "individual",
  display_name: `Side ${id}`,
  seed,
  status: "confirmed",
  members: [],
  team_display: null,
  badge_url: null,
});

const snap = (pool_id: string, ids: [string, string]): PublicStandings => ({
  stage_id: "st",
  pool_id,
  updated_at: "2026-09-20T12:00:00.000Z",
  rows: ids.map((entrantId, i) => ({
    entrantId,
    played: 1,
    won: i === 0 ? 1 : 0,
    drawn: 0,
    lost: i === 0 ? 0 : 1,
    points: i === 0 ? 3 : 0,
    metrics: { for: i === 0 ? 2 : 0, against: i === 0 ? 0 : 2, diff: i === 0 ? 2 : -2 },
    rank: i + 1,
  })),
});

const payload = () => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Test Comp",
    slug: "test-comp",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  },
  division: {
    id: "d1",
    competition_id: "c1",
    name: "Open",
    slug: "open",
    description: null,
    sport_key: "generic",
    variant_key: "score",
    status: "active",
    module_version: "1.0.0",
    tiebreakers: null,
    sport_name: null,
    entrant_count: 4,
  },
  stages: [{ id: "st", division_id: "d1", seq: 1, kind: "group", name: "Groups", status: "active" }],
  // The pools list in B, A order and the snapshots in id order (B first).
  pools: [
    { id: POOL_B, stage_id: "st", key: "B", name: "Pool B" },
    { id: POOL_A, stage_id: "st", key: "A", name: "Pool A" },
  ],
  fixtures: [],
  standings: [snap(POOL_B, ["e3", "e4"]), snap(POOL_A, ["e1", "e2"])],
  entrants: [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3), entrant("e4", 4)],
  tz: "UTC",
});

type TableProps = Parameters<typeof StandingsTable>[0];

/** Every `StandingsTable` element in the tree a page returns, in tree order. */
function tables(node: unknown, out: ReactElement<TableProps>[] = []): ReactElement<TableProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) tables(child, out);
  } else if (isValidElement(node)) {
    if (node.type === StandingsTable) {
      out.push(node as ReactElement<TableProps>);
      return out;
    }
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) tables(value, out);
  }
  return out;
}

describe("pool order on the pages that draw one standings table per pool", () => {
  it("public division page: Pool A, then Pool B", async () => {
    getPublicDivision.mockResolvedValue(payload());
    const root = await DivisionHomePage({
      params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
    });
    const drawn = tables(root);
    expect(drawn.map((el) => el.props.caption)).toEqual(["Groups — Pool A", "Groups — Pool B"]);
    // Each caption over its OWN pool's rows — the order moved the tables,
    // not just the labels.
    expect(drawn.map((el) => el.props.rows.map((r) => r.entrantId))).toEqual([["e1", "e2"], ["e3", "e4"]]);
  });

  it("embed standings widget: Pool A, then Pool B", async () => {
    embedDivisionData.mockResolvedValue({ ok: true, data: { ...payload(), sponsors: [] } });
    const root = await EmbedWidgetPage({ params: Promise.resolve({ id: "d1", widget: "standings" }) });
    const drawn = tables(root);
    expect(drawn.map((el) => el.props.caption)).toEqual(["Groups — Pool A", "Groups — Pool B"]);
    expect(drawn.map((el) => el.props.rows.map((r) => r.entrantId))).toEqual([["e1", "e2"], ["e3", "e4"]]);
  });

  it("organiser console: its pools are put in order by the same helper, not left to the query", () => {
    const src = readFileSync(join(process.cwd(), "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bcomparePools\b[^}]*\} from "@\/lib\/pool-order"/);
    expect(src).toMatch(/\.sort\(comparePools\)/);
  });

  it("no surface sorts pools by id any more", () => {
    for (const file of [
      "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
      "src/app/embed/divisions/[id]/[widget]/page.tsx",
      "src/server/public-site/competition-hub.ts",
      "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
    ]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, file).not.toMatch(/pool_id \?\? ""\)\.localeCompare/);
    }
  });
});
