// F3 Task 5c (owner ruling 14 — seeding stays propose-and-confirm, no
// auto-confirm). The ruling's stated consequence: organisers need a VISIBLE
// prompt that a proposal is waiting, or a published bracket sits full of
// placeholders after the results are already in.
//
// The load-bearing part is that the badge appears on EVERY tab, not just
// fixtures. The organiser is usually on entrants or standings when the group
// stage finishes — which is exactly the moment the proposal appears — and
// ProgressionPanel (the only thing that renders proposal state today) is
// mounted on the fixtures tab alone.
//
// Same harness as the sibling roster-drift-stage-wiring.test.tsx: no jsdom in
// this workspace, so this calls the async server component directly and walks
// the returned element tree.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Div One",
    slug: "div",
    status: "setup",
    sport_key: "generic",
    variant_key: "score",
    config: {},
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

/** Every element in the tree carrying the badge's data attribute. Anchoring on
 *  the attribute rather than on a class keeps this honest if the dot is
 *  restyled — and reading it off props (not serialised HTML) sidesteps the
 *  `"$undefined"` trap, since an absent prop is simply not present here. */
type BadgeProps = { "data-pending-seed-proposals"?: number; children?: ReactNode };

function badges(node: ReactNode, out: ReactElement<BadgeProps>[] = []): ReactElement<BadgeProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) badges(child as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as BadgeProps;
  if (props["data-pending-seed-proposals"] !== undefined) {
    out.push(node as ReactElement<BadgeProps>);
  }
  badges(props.children, out);
  return out;
}

const ROOT_STAGE = { id: "stage-root", name: "Root", kind: "league", config: {}, progression: null };
const KO_STAGE = {
  id: "stage-ko",
  name: "KO",
  kind: "knockout",
  config: {},
  progression: {
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
    placement: "rank_order",
    timing: "setup",
  },
};

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const proposal = (status: string) => ({ id: "prop-1", stageId: "stage-ko", status, computed: {} });

const renderTab = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

describe("F3 Task 5c — a waiting seed proposal is visible from every tab", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([ROOT_STAGE, KO_STAGE]);
    stagesSpies.getSeedProposal.mockReset();
  });

  // The regression this pins: before 5c the proposal was fetched only when
  // tab === "fixtures", so on any other tab the organiser saw nothing at all.
  it.each(["standings", "entrants", "stats", "settings"])(
    "shows the badge on the %s tab when a draft proposal is waiting",
    async (tab) => {
      stagesSpies.getSeedProposal.mockResolvedValue(proposal("draft"));

      const found = badges(await renderTab(tab));
      expect(found).toHaveLength(1);
      expect(found[0]!.props["data-pending-seed-proposals"]).toBe(1);
    },
  );

  it("shows the badge for a stale proposal too — it is equally waiting on a human", async () => {
    stagesSpies.getSeedProposal.mockResolvedValue(proposal("stale"));

    expect(badges(await renderTab("standings"))).toHaveLength(1);
  });

  it("shows NO badge once the proposal is confirmed — done never nags", async () => {
    stagesSpies.getSeedProposal.mockResolvedValue(proposal("confirmed"));

    expect(badges(await renderTab("standings"))).toHaveLength(0);
  });

  it("shows NO badge when no proposal exists yet", async () => {
    stagesSpies.getSeedProposal.mockResolvedValue(null);

    expect(badges(await renderTab("standings"))).toHaveLength(0);
  });

  it("shows NO badge to a viewer, and never reads a proposal for them — organiser-only", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    stagesSpies.getSeedProposal.mockResolvedValue(proposal("draft"));

    expect(badges(await renderTab("standings"))).toHaveLength(0);
    expect(stagesSpies.getSeedProposal).not.toHaveBeenCalled();
  });

  it("counts every waiting stage, not just the first", async () => {
    const ko2 = { ...KO_STAGE, id: "stage-ko-2", name: "Plate" };
    stagesSpies.listStages.mockResolvedValue([ROOT_STAGE, KO_STAGE, ko2]);
    stagesSpies.getSeedProposal.mockResolvedValue(proposal("draft"));

    const found = badges(await renderTab("entrants"));
    expect(found).toHaveLength(1);
    expect(found[0]!.props["data-pending-seed-proposals"]).toBe(2);
  });
});
