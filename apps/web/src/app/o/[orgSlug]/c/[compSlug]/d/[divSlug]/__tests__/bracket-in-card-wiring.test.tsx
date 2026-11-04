// Match Day E1 item 3 (owner 2026-11-01): the bracket tree left the page (above the stage cards) for the single-elimination
// knockout stage's own card. The page is the seam - it decides which stages still draw above the cards and what the cards are handed
// to draw with - so it is driven here through the real async page, the way `chess-individual-only-wiring.test.tsx` beside it does
// (the server component called directly, its returned tree walked). Fixtures are the ENGINE'S OWN generator output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "es" | "fr" | "nl",
  sport_key: "generic",
  variant_key: "score",
  config: {} as Record<string, unknown>,
  moduleEntrantModel: null as unknown,
  /** Match Day E1 item 3: the stages and fixtures the page reads. */
  stages: [] as Record<string, unknown>[],
  fixtures: [] as Record<string, unknown>[],
  /** Match Day C4: a billing-frozen competition makes the page's `editable` false while `canEdit` stays true. */
  frozen: false,
  /** Match Day E1 item 7: the roster the page reads; `[]` is the empty division. */
  entrants: [] as Record<string, unknown>[],
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => state.stages),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(async () => false),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: state.frozen, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => state.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "setup",
    sport_key: state.sport_key,
    variant_key: state.variant_key,
    module_version: "1.0.0",
    config: state.config,
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
    camera_policy: null,
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({ divisionConsumesSlotOnArchive: vi.fn(async () => false) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => state.fixtures),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/entrants")>();
  return { ...actual, listEntrants: vi.fn(async () => state.entrants) };
});
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: state.moduleEntrantModel,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: [],
  })),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});

import DivisionPage from "../page";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const renderPage = (tab = "entrants") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

function findAll(node: ReactNode, match: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (match(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, match, out);
  return out;
}


import { generateDoubleElim, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import { BracketPanel } from "@/components/v2/bracket-panel";
import { StagesPanel } from "@/components/v2/stages-panel";

const rowsFor = (stageId: string, gen: GeneratedBracket, deLanes = false) => {
  const counters = new Map<string, number>();
  return gen.fixtures.map((f, i) => {
    const lane = f.bracket ?? "WB";
    const offset = !deLanes ? 0 : lane === "LB" ? gen.rounds : lane === "GF" ? 2 * gen.rounds : 0;
    const round_no = offset + f.round + 1;
    const key = `${lane}:${round_no}`;
    const seq = (counters.get(key) ?? 0) + 1;
    counters.set(key, seq);
    return {
      id: f.id, stage_id: stageId, division_id: "div-1", pool_id: null, round_no, seq_in_round: seq, fixture_no: i + 1,
      home_entrant_id: f.home ?? null, away_entrant_id: f.away ?? null, home_slot_label: null, away_slot_label: null,
      scheduled_at: null, venue: null, court_label: null, court_id: null, court_name: null, officials: null,
      status: "scheduled", outcome: null, schedule_source: null, schedule_locked: false, created_at: "",
    };
  });
};
const stageOf = (id: string, seq: number, kind: string, name: string) => ({
  id, seq, kind, name, config: {}, progression: null, status: "active", division_id: "div-1", created_at: "",
});
const T4 = ["T1", "T2", "T3", "T4"];

beforeEach(() => {
  state.locale = "en";
  state.stages = [];
  state.fixtures = [];
  state.entrants = [];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
});

describe("division page: the bracket is drawn in the stage's card, not above it (E1 item 3)", () => {
  it("a single-elimination knockout is handed to its card (the panel gets the badges and headlines the tree needs) and the page draws no tree of its own", async () => {
    state.stages = [stageOf("st-ko", 1, "knockout", "Knockout")];
    state.fixtures = rowsFor("st-ko", generateSingleElim({ entrants: T4 }));
    expect(state.fixtures.length, "premise: a bracket exists").toBeGreaterThan(0);
    const tree = await renderPage("fixtures");
    expect(findAll(tree, (el) => el.type === BracketPanel), "no page-level tree for a card-drawn stage").toHaveLength(0);
    const panels = findAll(tree, (el) => el.type === StagesPanel);
    expect(panels, "premise: the stage cards rendered").toHaveLength(1);
    const props = panels[0]!.props as { entrantBadges?: unknown; headlines?: unknown; fixtures: unknown[] };
    expect(props.entrantBadges, "the card's tree needs the crests the page loaded").toBeDefined();
    expect(props.headlines, "...and the scoreline headlines").toBeDefined();
    expect(props.fixtures).toHaveLength(state.fixtures.length);
  });

  it("a double-elimination stage and a stepladder keep their page-level view, exactly one tree each", async () => {
    let checked = 0;
    for (const [kind, rows] of [
      ["double_elim", rowsFor("st-x", generateDoubleElim({ entrants: T4 }), true)],
      ["stepladder", rowsFor("st-x", generateStepladder({ entrants: T4 }))],
    ] as const) {
      state.stages = [stageOf("st-x", 1, kind, "Playoffs")];
      state.fixtures = rows;
      expect(rows.length, `${kind}: premise`).toBeGreaterThan(0);
      const trees = findAll(await renderPage("fixtures"), (el) => el.type === BracketPanel);
      expect(trees, kind).toHaveLength(1);
      expect((trees[0]!.props as { kind: string }).kind).toBe(kind);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("both in one division: only the double-elimination stage's tree stays on the page", async () => {
    state.stages = [stageOf("st-ko", 1, "knockout", "Knockout"), stageOf("st-de", 2, "double_elim", "Losers' route")];
    state.fixtures = [...rowsFor("st-ko", generateSingleElim({ entrants: T4 })), ...rowsFor("st-de", generateDoubleElim({ entrants: ["U1", "U2", "U3", "U4"] }), true)];
    const trees = findAll(await renderPage("fixtures"), (el) => el.type === BracketPanel);
    expect(trees).toHaveLength(1);
    expect((trees[0]!.props as { kind: string }).kind).toBe("double_elim");
  });

  it("a knockout with no bracket yet draws nothing anywhere (the empty case)", async () => {
    state.stages = [stageOf("st-ko", 1, "knockout", "Knockout")];
    state.fixtures = [];
    const tree = await renderPage("fixtures");
    expect(findAll(tree, (el) => el.type === BracketPanel)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === StagesPanel), "premise: the cards still render").toHaveLength(1);
  });
});
