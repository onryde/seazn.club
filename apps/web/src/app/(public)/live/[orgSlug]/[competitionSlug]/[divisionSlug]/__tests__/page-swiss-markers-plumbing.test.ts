// W3 app-B T3 (owner Q2, 2026-11-03): the public division page hands its Swiss stage's REAL fixtures to the standings table,
// so a bye and a late join are marked on the page a spectator opens. The marker words and the markup are unit-tested in
// `standings-swiss-parity.test.ts`; what only THIS page decides is whether it ever passes the facts at all (a table built with
// no `swissFacts` is green everywhere else and prints nothing - AGENTS.md class 1, the inert seam).
//
// The page is an async server component called with its data door mocked; the `StandingsTable` it builds is found in the
// returned tree and rendered on its own (Node vitest has no DOM) - the shape of `page-departed-entrant-status-plumbing`
// beside this file. Scene: three players, a late third who joins at round 3, and round 3's pairing bye for the second.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { StandingsTable } from "@/components/public-site/standings-table";
import type { PublicEntrant } from "@/server/public-site/data";
import DivisionHomePage from "../page";

const NAMES = { a: "Ada Early", b: "Bo Bye", c: "Cyd Late" } as const;
const entrant = (id: string, name: string, seed: number): PublicEntrant =>
  ({ id, division_id: "d1", kind: "individual", display_name: name, seed, status: "confirmed", members: [], team_display: null, badge_url: null }) as unknown as PublicEntrant;

const fixture = (id: string, round: number, ext_key: string, home: string, away: string | null, outcome: unknown) => ({
  id,
  division_id: "d1",
  stage_id: "sw",
  pool_id: null,
  round_no: round,
  seq_in_round: 1,
  home_entrant_id: home,
  away_entrant_id: away,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "decided",
  outcome,
  summary: null,
  last_seq: null,
  ext_key,
});
const win = (winner: string, loser: string) => ({ kind: "win", winner, loser });

const FIXTURES = [
  fixture("f1", 1, "sw-r1-b1", "a", "b", win("a", "b")),
  fixture("f2", 2, "sw-r2-b1", "a", "b", win("a", "b")),
  fixture("f3", 3, "sw-r3-b1", "a", "c", win("a", "c")),
  fixture("f4", 3, "sw-r3-bye", "b", null, { kind: "award", winner: "b", loser: null, reason: "bye" }),
];

const divisionData = (fixtures: unknown[]) => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "en" },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 3 },
  stages: [{ id: "sw", division_id: "d1", seq: 1, kind: "swiss", name: "Swiss", status: "active", swiss_rounds: 5 }],
  pools: [],
  fixtures,
  standings: [
    {
      stage_id: "sw",
      pool_id: null,
      updated_at: "2026-11-03T00:00:00.000Z",
      rows: (["a", "b", "c"] as const).map((id, i) => ({ entrantId: id, played: 3 - i, won: 3 - i, drawn: 0, lost: 0, points: 2 * (3 - i), metrics: { gf: 3, ga: 0, gd: 3 }, rank: i + 1 })),
    },
  ],
  entrants: [entrant("a", NAMES.a, 1), entrant("b", NAMES.b, 2), entrant("c", NAMES.c, 3)],
  tz: "UTC",
});

/** Every element anywhere in a server component's returned tree. */
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function standingsTable(fixtures: unknown[]) {
  getPublicDivision.mockResolvedValue(divisionData(fixtures));
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  const tables = elements(root).filter((el) => el.type === StandingsTable);
  expect(tables, "the page builds one StandingsTable for its one Swiss stage").toHaveLength(1);
  return tables[0]!;
}
async function standingsHtml(fixtures: unknown[]) {
  return renderToStaticMarkup(await standingsTable(fixtures));
}

const nameCell = (html: string, name: string) => {
  const hit = [...html.matchAll(/<th scope="row"[\s\S]*?<\/th>/g)].map((m) => m[0]).find((c) => c.includes(name));
  expect(hit, `no standings row cell for ${name}`).toBeDefined();
  return hit!;
};

describe("public division page - a Swiss bye and a late join reach the standings marked", () => {
  it("the bye holder carries a bye mark, the late entrant a late mark, and the on-time byeless entrant neither", async () => {
    const html = await standingsHtml(FIXTURES);
    expect(nameCell(html, NAMES.b)).toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.b)).not.toContain('data-marker="late"');
    expect(nameCell(html, NAMES.c)).toContain('data-marker="late"');
    expect(nameCell(html, NAMES.c)).not.toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.a), "Ada played every round and sat out none").not.toContain("data-marker=");
  });

  it("the page names the stage's kind to the table: the Swiss ladders' format is the Swiss table's (`stageKind`, owner Q2 scope)", async () => {
    const table = await standingsTable(FIXTURES);
    expect((table.props as { stageKind?: string }).stageKind, "the stage here is a Swiss").toBe("swiss");
  });

  it("empty case: a Swiss with no fixtures yet marks nobody (and renders without a marker line)", async () => {
    const html = await standingsHtml([]);
    expect([...html.matchAll(/<th scope="row"/g)].length, "rows checked").toBe(3);
    expect(html).not.toContain("data-marker=");
  });
});
