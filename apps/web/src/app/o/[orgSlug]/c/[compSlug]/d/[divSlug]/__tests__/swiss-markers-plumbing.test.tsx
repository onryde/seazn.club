// W3 app-B T3 (owner Q2, 2026-11-03): the organiser console's division page marks a Swiss bye and a late join on its standings
// table. The words and the markup are pinned in `standings-swiss-parity.test.ts`; what only THIS page decides is whether it
// hands the table the facts of the stage's real fixtures at all - a table built with no `swissFacts` renders a perfectly good
// table with nothing on it (AGENTS.md class 1, the inert seam). Same harness as `qualification-plumbing.test.tsx` beside this
// file: the page's data doors are doubled, the async server component is called directly, and the `StandingsTable` it returns
// is rendered on its own. Scene: Ada and Bo play rounds 1-2, Cyd joins at round 3 (rounds 1-2 are hers to miss) where Bo sits
// out on the pairing bye.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const scene = vi.hoisted(() => ({
  stages: [] as unknown[],
  fixtures: [] as unknown[],
  entrants: [] as unknown[],
  pools: {} as Record<string, unknown[]>,
  snaps: {} as Record<string, unknown>,
  locale: "en",
}));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(async () => scene.stages),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async (_auth: unknown, stageId: string, poolId?: string) => scene.snaps[`${stageId}:${poolId ?? ""}`] ?? { rows: [] }),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(),
}));
const qual = vi.hoisted(() => ({ listStageQualificationMeta: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/stage-qualification", () => qual);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => scene.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Open",
    status: "active",
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    // The live cfg the forecast's per-match bounds come from.
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } },
    tiebreakers: null,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({
  divisionConsumesSlotOnArchive: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "private", slug: "comp-one" })),
}));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => scene.fixtures),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/entrants")>()),
  listEntrants: vi.fn(async () => scene.entrants),
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => builtinModules.find((m) => m.key === "generic")),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
// The page's own tenant reads: only the pools query answers.
const tx = (strings: unknown, ...values: unknown[]) =>
  Promise.resolve(
    Array.isArray(strings) && strings.join("?").includes("from pools") ? (scene.pools[values[0] as string] ?? []) : [],
  );
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionPage from "../page";
import { StandingsTable } from "@/components/public-site/standings-table";
import { unpinnedRulesDoc } from "@/server/engine-db/__tests__/helpers/table-rules-doc";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const DIVISION_CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 } };
const NAMES: Record<string, string> = { A: "Ada Swiss", B: "Bo Swiss", C: "Cyd Swiss" };

let fixtureNo = 0;
const fx = (id: string, round: number, ext_key: string, home: string, away: string | null, outcome: unknown) => ({
  id,
  stage_id: "sw",
  pool_id: null,
  round_no: round,
  seq_in_round: 1,
  fixture_no: ++fixtureNo,
  home_entrant_id: home,
  away_entrant_id: away,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  status: "decided",
  outcome,
  ext_key,
});
const FIXTURES = [
  fx("f1", 1, "sw-r1-b1", "A", "B", { kind: "win", winner: "A", loser: "B" }),
  fx("f2", 2, "sw-r2-b1", "A", "B", { kind: "win", winner: "A", loser: "B" }),
  fx("f3", 3, "sw-r3-b1", "A", "C", { kind: "win", winner: "A", loser: "C" }),
  fx("f4", 3, "sw-r3-bye", "B", null, { kind: "award", winner: "B", loser: null, reason: "bye" }),
];
const row = (entrantId: string, rank: number, played: number, won: number) => ({
  entrantId,
  rank,
  played,
  won,
  drawn: 0,
  lost: played - won,
  points: 3 * won,
  metrics: { for: won, against: 0, diff: won },
});

function swissScene(fixtures: unknown[]) {
  scene.stages = [{ id: "sw", name: "Swiss", kind: "swiss", seq: 1, status: "active", config: { rounds: 5 }, progression: null }];
  scene.fixtures = fixtures;
  scene.entrants = ["A", "B", "C"].map((id, i) => ({ id, display_name: NAMES[id], status: "confirmed", seed: i + 1 }));
  scene.pools = {};
  scene.snaps = {
    "sw:": { stage_id: "sw", pool_id: null, rows: [row("A", 1, 3, 3), row("B", 2, 2, 0), row("C", 3, 1, 0)] },
  };
  qual.listStageQualificationMeta.mockResolvedValue(
    new Map([
      [
        "sw",
        {
          qualify_count: null,
          qualify_per_group: false,
          next_stage_name: null,
          swiss_rounds: 5,
          points_rule: null,
          has_rank_overrides: false,
          table_rules: unpinnedRulesDoc({ module: builtinModules.find((m) => m.key === "generic")!, kind: "swiss", divisionConfig: DIVISION_CFG }),
        },
      ],
    ]),
  );
}

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function standingsTable() {
  const root = await DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "standings" }),
  });
  const tables = elements(root).filter((el) => el.type === StandingsTable);
  expect(tables, "one StandingsTable for the one Swiss stage").toHaveLength(1);
  return tables[0]!;
}
async function standingsHtml() {
  return renderToStaticMarkup(await standingsTable());
}

const nameCell = (html: string, name: string) => {
  const hit = [...html.matchAll(/<th scope="row"[\s\S]*?<\/th>/g)].map((m) => m[0]).find((c) => c.includes(name));
  expect(hit, `no standings row cell for ${name}`).toBeDefined();
  return hit!;
};

describe("organiser console - a Swiss bye and a late join reach the standings marked", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    qual.listStageQualificationMeta.mockReset();
    scene.locale = "en";
  });

  it("the bye holder carries a bye mark, the late entrant a late mark, and the on-time byeless entrant neither", async () => {
    swissScene(FIXTURES);
    const html = await standingsHtml();
    expect(nameCell(html, NAMES.B!)).toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.B!)).not.toContain('data-marker="late"');
    expect(nameCell(html, NAMES.C!)).toContain('data-marker="late"');
    expect(nameCell(html, NAMES.C!)).not.toContain('data-marker="bye"');
    expect(nameCell(html, NAMES.A!), "Ada played every round and sat out none").not.toContain("data-marker=");
  });

  it("the page names the stage's kind to the table: the Swiss ladders' format is the Swiss table's (`stageKind`, owner Q2 scope)", async () => {
    swissScene(FIXTURES);
    const table = await standingsTable();
    expect((table.props as { stageKind?: string }).stageKind, "the stage here is a Swiss").toBe("swiss");
  });

  it("empty case: a Swiss with no fixtures yet marks nobody", async () => {
    swissScene([]);
    const html = await standingsHtml();
    expect([...html.matchAll(/<th scope="row"/g)].length, "rows checked").toBe(3);
    expect(html).not.toContain("data-marker=");
  });
});
