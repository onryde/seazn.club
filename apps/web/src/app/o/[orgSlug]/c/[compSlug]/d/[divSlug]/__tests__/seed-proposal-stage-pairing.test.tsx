// Review finding 5 (P6/D4b task B fix round 1, MINOR). The division page
// zips `seedingStages[i] <-> seedProposals[i]` when it renders one
// ProgressionPanel per propose/confirm stage (page.tsx: `seedingStages =
// stages.filter(s => s.progression?.timing === "setup")`, `seedProposals =
// Promise.all(seedingStages.map(s => getSeedProposal(auth, s.id)))`, then
// `seedingStages.map((st, i) => <ProgressionPanel ... proposal={seedProposals[i]
// ?? null} .../>)`). Every existing test and the e2e drive exactly ONE
// such stage, so this pairing has never been exercised with two.
//
// F2 (unified progression field): was `s.seeding != null` — the field is
// gone, and the naive rename `s.progression != null` would ALSO catch
// on_complete (auto-seed) stages, which never go through propose/confirm
// (Decision 3: the two DB-level flows stay separate). The describe block
// below adds a case proving an on_complete stage gets NO panel, which the
// naive rename would fail.
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
  // F3 Task 5 (5a) — page.tsx now also calls getStageRosterDrift for the
  // one root (progression === null) stage, gated the same as getSeedProposal
  // just above (tab==="fixtures" && editable). The "third, non-seeding
  // stage" case below sets stageMid's progression to null specifically to
  // prove IT gets no ProgressionPanel — which makes it a root stage too, so
  // this mock has to exist or that render throws instead of asserting.
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
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
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
// Task 14 P1: the fixtures tab resolves the checkout's currency (`preferredCurrency` reads cookies/headers), which has
// no request scope in a direct page call. Not what this suite pins.
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
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
const SETUP_PROGRESSION = {
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
  placement: "rank_order",
  timing: "setup",
};
const STAGE_X = {
  id: "stage-x",
  name: "Stage X",
  kind: "group",
  config: {},
  progression: SETUP_PROGRESSION,
};
const STAGE_Y = {
  id: "stage-y",
  name: "Stage Y",
  kind: "group",
  config: {},
  progression: SETUP_PROGRESSION,
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
    const stageMid = { id: "stage-mid", name: "Mid", kind: "league", config: {}, progression: null };
    stagesSpies.listStages.mockResolvedValue([STAGE_X, stageMid, STAGE_Y]);

    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(2); // stage-mid has no progression, gets no panel

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

  // The crux of the F2 conversion: `s.progression != null` alone is NOT the
  // right filter — Decision 3 keeps the two DB-level flows (auto-seed on
  // completion vs propose/confirm at setup) separate, and an on_complete
  // stage never goes through getSeedProposal/ProgressionPanel. A stage
  // carrying a real progression spec but timing: "on_complete" must get NO
  // panel, same as a stage with no progression at all.
  it("an on_complete stage (auto-seed) gets NO ProgressionPanel, even though it carries a real progression spec", async () => {
    const stageAutoSeed = {
      id: "stage-auto",
      name: "Auto",
      kind: "knockout",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "on_complete",
      },
    };
    stagesSpies.listStages.mockResolvedValue([STAGE_X, stageAutoSeed]);

    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(1);
    expect((panels[0]!.props as { stageId: string }).stageId).toBe("stage-x");

    const calledWith = stagesSpies.getSeedProposal.mock.calls.map((args: unknown[]) => args[1]);
    expect(calledWith).toEqual(["stage-x"]);
  });
});

// Code review finding (this session): the `seedingSourcesReady` derivation
// itself — the "previous"-stage resolution + status check that decides the
// `sourceReady` prop — had no test exercising it with realistic `seq`/
// `status` data; every other case above leaves `proposal` non-null, so
// `sourceReady` is computed but never asserted. This mirrors
// resolveProgressionSource's own SQL (stage-seeding.ts:73-91) FIELD-FOR-
// FIELD: "previous" = the same-division stage with the largest `seq` less
// than the target's.
describe("division fixtures tab: sourceReady mirrors resolveProgressionSource's own gate", () => {
  const ROOT_INCOMPLETE = {
    id: "stage-root",
    name: "Root",
    kind: "group",
    config: {},
    progression: null,
    division_id: "div-1",
    seq: 1,
    status: "in_progress",
  };
  const ROOT_COMPLETE = { ...ROOT_INCOMPLETE, status: "complete" };
  const SETUP_STAGE = {
    id: "stage-ko",
    name: "KO",
    kind: "knockout",
    config: {},
    progression: SETUP_PROGRESSION,
    division_id: "div-1",
    seq: 2,
    status: "setup",
  };

  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.getSeedProposal.mockReset().mockResolvedValue(null);
  });

  it("sourceReady=false while the 'previous' (nearest lower-seq) stage hasn't completed", async () => {
    stagesSpies.listStages.mockResolvedValue([ROOT_INCOMPLETE, SETUP_STAGE]);
    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(1);
    expect((panels[0]!.props as { sourceReady: boolean }).sourceReady).toBe(false);
  });

  it("sourceReady=true once that same 'previous' stage is complete", async () => {
    stagesSpies.listStages.mockResolvedValue([ROOT_COMPLETE, SETUP_STAGE]);
    const tree = await renderFixturesTab();
    const panels = findAll(tree, ProgressionPanel);
    expect(panels).toHaveLength(1);
    expect((panels[0]!.props as { sourceReady: boolean }).sourceReady).toBe(true);
  });
});
