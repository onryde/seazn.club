// F3 Task 5 (5a) — the division page computes roster drift for AT MOST one
// stage (the root — progression === null) and threads it into StagesPanel as
// `rosterDrift[stageId]`. Same harness as the sibling
// seed-proposal-stage-pairing.test.tsx in this directory (no jsdom in this
// workspace, and the page hands data to client islands with hooks, so this
// calls the async server component directly and walks the returned element
// tree — component-ui-i18n / server-component-page-test memory).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(),
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
// Spec 2026-09-30 §2 (T6): the fixtures tab's one stream read is `openStreamStates` (the run sheet's chip) — this page
// test is not about streaming, so it is an empty double.
vi.mock("@/server/usecases/stream-sessions", () => ({
  openStreamStates: async () => ({}),
}));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";

/** First element of the given type in a server-component tree (mirrors
 *  officials-loads-deferred.test.tsx's `find` — this page renders exactly
 *  one StagesPanel, unlike ProgressionPanel's per-stage list). */
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

const ROOT_STAGE = { id: "stage-root", name: "Root", kind: "league", config: {}, progression: null };
const SETUP_PROGRESSION = {
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
  placement: "rank_order",
  timing: "setup",
};
const KO_STAGE = { id: "stage-ko", name: "KO", kind: "knockout", config: {}, progression: SETUP_PROGRESSION };

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const DRIFT_RESULT = { ghosts: [{ id: "e1", display_name: "Ghost Gwen" }], unplaced: [] };

const renderTab = (tab = "fixtures") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

describe("division fixtures tab threads roster drift into StagesPanel for the root stage only", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue(DRIFT_RESULT);
  });

  it("calls getStageRosterDrift with the root stage's id and threads the result into StagesPanel keyed by that id", async () => {
    stagesSpies.listStages.mockReset().mockResolvedValue([ROOT_STAGE, KO_STAGE]);

    const tree = await renderTab();
    const panel = find(tree, StagesPanel);
    expect(panel).not.toBeNull();
    expect((panel!.props as { rosterDrift?: unknown }).rosterDrift).toEqual({ "stage-root": DRIFT_RESULT });

    const calledWith = stagesSpies.getStageRosterDrift.mock.calls.map((args: unknown[]) => args[1]);
    expect(calledWith).toEqual(["stage-root"]);
  });

  it("never calls getStageRosterDrift, and passes an empty rosterDrift, when no stage is a root (every stage has a progression source)", async () => {
    const koOnly = { ...KO_STAGE, id: "stage-ko-only" };
    stagesSpies.listStages.mockReset().mockResolvedValue([koOnly]);

    const tree = await renderTab();
    const panel = find(tree, StagesPanel);
    expect((panel!.props as { rosterDrift?: unknown }).rosterDrift).toEqual({});
    expect(stagesSpies.getStageRosterDrift).not.toHaveBeenCalled();
  });

  it("never calls getStageRosterDrift for a viewer (canEdit=false) — organiser-only, same gating as getSeedProposal", async () => {
    stagesSpies.listStages.mockReset().mockResolvedValue([ROOT_STAGE]);
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });

    const tree = await renderTab();
    const panel = find(tree, StagesPanel);
    expect((panel!.props as { rosterDrift?: unknown }).rosterDrift).toEqual({});
    expect(stagesSpies.getStageRosterDrift).not.toHaveBeenCalled();
  });

  it("never calls getStageRosterDrift off the fixtures tab", async () => {
    stagesSpies.listStages.mockReset().mockResolvedValue([ROOT_STAGE]);

    await renderTab("standings");
    expect(stagesSpies.getStageRosterDrift).not.toHaveBeenCalled();
  });
});
