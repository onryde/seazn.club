// Review finding 5 (P6/D4b task B fix round 1, MINOR). The division page
// zips `seedingStages[i] <-> seedProposals[i]` when it renders one
// ProgressionPanel per `.seeding`-declared stage (page.tsx: `seedingStages =
// stages.filter(s => s.seeding != null)`, `seedProposals =
// Promise.all(seedingStages.map(s => getSeedProposal(auth, s.id)))`, then
// `seedingStages.map((st, i) => <ProgressionPanel ... proposal={seedProposals[i]
// ?? null} .../>)`). Every existing test and the e2e drive exactly ONE
// `.seeding` stage, so this pairing has never been exercised with two.
//
// `Promise.all` preserves input order, so this is correct by construction —
// not a live bug — but nothing stops a FUTURE refactor (a `.sort()` inserted
// between the two computation sites, or a zip against the wrong array) from
// silently mis-pairing a stage with someone else's proposal. This is the
// cheap regression that would catch it: two real `.seeding` stages, two
// distinguishable proposals, assert each rendered panel holds its OWN
// stage's proposal by CONTENT, not just that two panels exist.
//
// No jsdom in this workspace, and the page hands data to client islands with
// hooks — so this calls the async server component directly and walks the
// returned element tree, exactly as
// schedule/__tests__/officials-loads-deferred.test.tsx does for its sibling
// page (component-ui-i18n / server-component-page-test memory).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "active",
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    config: {},
    tiebreakers: undefined,
    eligibility: [],
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
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    frozen: false,
    visibility: "private",
    slug: "comp-one",
  })),
}));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
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

import DivisionPage from "../page";
import { ProgressionPanel } from "@/components/v2/progression-panel";

/** Depth-first search of a returned server-component tree, collecting EVERY
 *  element of the given type (not just the first — unlike the `find` helper
 *  in officials-loads-deferred.test.tsx, this test needs both panels). */
function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

// Neither is a bracket/americano/ladder kind — the fixtures-tab JSX branch
// that matters here (seedingStages.map) is keyed purely on `.seeding != null`,
// independent of `kind`, so a neutral kind keeps this test from also having
// to stand up BracketPanel's own data (entrantLogos/headlines).
const STAGE_X = {
  id: "stage-x",
  name: "Stage X",
  kind: "group",
  config: {},
  qualification: null,
  seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }], placement: "rank_order" },
};
const STAGE_Y = {
  id: "stage-y",
  name: "Stage Y",
  kind: "group",
  config: {},
  qualification: null,
  seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }], placement: "rank_order" },
};

const PROPOSAL_X = {
  id: "px",
  stageId: "stage-x",
  status: "draft" as const,
  computed: { qualifiers: [], ties: [], standingsHash: "hash-x" },
};
const PROPOSAL_Y = {
  id: "py",
  stageId: "stage-y",
  status: "draft" as const,
  computed: { qualifiers: [], ties: [], standingsHash: "hash-y" },
};

const renderFixturesTab = () =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "fixtures" }),
  });

describe("division fixtures tab pairs each .seeding stage with its OWN proposal", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([STAGE_X, STAGE_Y]);
    stagesSpies.getSeedProposal.mockReset().mockImplementation(async (_auth: unknown, stageId: string) =>
      stageId === "stage-x" ? PROPOSAL_X : stageId === "stage-y" ? PROPOSAL_Y : null,
    );
  });

  it("renders one ProgressionPanel per seeding stage, each holding its OWN stage's proposal — never swapped", async () => {
    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(2);

    const byStage = Object.fromEntries(
      panels.map((p) => [(p.props as { stageId: string }).stageId, (p.props as { proposal: unknown }).proposal]),
    );
    expect(byStage["stage-x"]).toEqual(PROPOSAL_X);
    expect(byStage["stage-y"]).toEqual(PROPOSAL_Y);
  });

  it("a third, non-seeding stage inserted between them still pairs correctly — not an accident of a 2-item array", async () => {
    const stageMid = { id: "stage-mid", name: "Mid", kind: "league", config: {}, qualification: null, seeding: null };
    stagesSpies.listStages.mockResolvedValue([STAGE_X, stageMid, STAGE_Y]);

    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(2); // stage-mid has no .seeding, gets no panel

    const byStage = Object.fromEntries(
      panels.map((p) => [(p.props as { stageId: string }).stageId, (p.props as { proposal: unknown }).proposal]),
    );
    expect(byStage["stage-x"]).toEqual(PROPOSAL_X);
    expect(byStage["stage-y"]).toEqual(PROPOSAL_Y);
  });

  it("getSeedProposal is called once per seeding stage, each with that stage's OWN id", async () => {
    await renderFixturesTab();
    const calledWith = stagesSpies.getSeedProposal.mock.calls.map((args: unknown[]) => args[1]);
    expect(calledWith.sort()).toEqual(["stage-x", "stage-y"]);
  });
});
