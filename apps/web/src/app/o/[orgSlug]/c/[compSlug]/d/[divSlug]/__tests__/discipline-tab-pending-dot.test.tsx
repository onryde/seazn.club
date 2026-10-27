// Discipline 3A (owner-approved 2026-10-27): pending bans waiting on the organiser show as an amber dot INSIDE the
// Discipline tab's label — on EVERY tab, because a card raises its ban while the organiser is on fixtures or standings.
// Organiser-approved, never auto-enabled: no dot unless the sport has a card model and the org is entitled
// (`getDisciplineRules`' pass-scoped gate let it in) — rules on OR off, since a referee's report and a manual record
// raise a pending ban with the rules off (F7, 2026-10-27); and nothing is counted for a viewer. Same harness as pending-seed-proposal-badge.test.tsx (no jsdom here): the async server component is
// called directly and its element tree walked, reading PROPS — an absent prop is simply absent, never "$undefined".
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
    sport_key: "football",
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
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
  })),
}));
const disc = vi.hoisted(() => ({
  getDisciplineRules: vi.fn(),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
  countBansToReview: vi.fn(),
}));
vi.mock("@/server/usecases/discipline", () => disc);
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionPage from "../page";
import { PaymentRequiredError } from "@/lib/errors";
import en from "@/dictionaries/en/ui.json";

type DotProps = { "data-pending-suspensions"?: number; "data-pending-seed-proposals"?: number; title?: string; className?: string; children?: ReactNode };

function find(node: ReactNode, attr: keyof DotProps, out: ReactElement<DotProps>[] = []): ReactElement<DotProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) find(child as ReactNode, attr, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const props = node.props as DotProps;
  if (props[attr] !== undefined) out.push(node as ReactElement<DotProps>);
  find(props.children, attr, out);
  return out;
}
const dots = (tree: ReactNode) => find(tree, "data-pending-suspensions");
const srText = (el: ReactElement<DotProps>): string => {
  const inner = el.props.children as ReactElement<{ children?: ReactNode }>;
  return String(inner.props.children);
};

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const RULES_ON = { enabled: true, rules: { accumulation: [], dismissal: [] }, sportColors: [] };

const renderTab = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

describe("Discipline 3A — pending bans are visible from every tab, as a dot on the Discipline tab", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset().mockResolvedValue(null);
    disc.getDisciplineRules.mockReset().mockResolvedValue(RULES_ON);
    disc.countBansToReview.mockReset().mockResolvedValue(0);
  });

  // Empty case first: rules on, entitled, nothing pending.
  it("shows NO dot when nothing is pending", async () => {
    expect(dots(await renderTab("standings"))).toHaveLength(0);
    expect(disc.countBansToReview, "rig: the count WAS asked for").toHaveBeenCalledTimes(1);
  });

  it.each(["standings", "entrants", "stats", "settings", "fixtures", "discipline"])(
    "shows the dot with its count on the %s tab when bans are pending",
    async (tab) => {
      disc.countBansToReview.mockResolvedValue(2);
      const found = dots(await renderTab(tab));
      expect(found).toHaveLength(1);
      expect(found[0]!.props["data-pending-suspensions"]).toBe(2);
      expect(found[0]!.props.title).toBe(en["disc.tab.pendingHint"]);
      expect(srText(found[0]!)).toBe("2 bans awaiting your review");
    },
  );

  it("reads singular at one", async () => {
    disc.countBansToReview.mockResolvedValue(1);
    const [dot] = dots(await renderTab("standings"));
    expect(srText(dot!)).toBe("1 ban awaiting your review");
  });

  it("is the SAME dot as the seed-proposal badge — inside the label, no width of its own", async () => {
    disc.countBansToReview.mockResolvedValue(1);
    stagesSpies.listStages.mockResolvedValue([
      { id: "stage-root", name: "Root", kind: "league", config: {}, progression: null },
      {
        id: "stage-ko", name: "KO", kind: "knockout", config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "setup" },
      },
    ]);
    stagesSpies.getSeedProposal.mockResolvedValue({ id: "p", stageId: "stage-ko", status: "draft", computed: {} });
    const tree = await renderTab("standings");
    const [ban] = dots(tree);
    const [seed] = find(tree, "data-pending-seed-proposals");
    expect(seed, "rig: the seed badge renders beside it").toBeDefined();
    expect(ban!.props.className).toBe(seed!.props.className);
  });

  // F7 (owner-approved 2026-10-27): a referee's report or a manual record raises a pending ban with the rules OFF — the
  // dot shows it, rules on or off; nothing is switched on.
  it("rules OFF with nothing pending ⇒ no dot (the count is still asked)", async () => {
    disc.getDisciplineRules.mockResolvedValue({ ...RULES_ON, enabled: false });
    expect(dots(await renderTab("standings"))).toHaveLength(0);
    expect(disc.countBansToReview, "rig: asked with the rules off").toHaveBeenCalledTimes(1);
  });

  it("rules OFF with bans pending (a referee's report) ⇒ the dot, with its count", async () => {
    disc.getDisciplineRules.mockResolvedValue({ ...RULES_ON, enabled: false });
    disc.countBansToReview.mockResolvedValue(3);
    const found = dots(await renderTab("standings"));
    expect(found).toHaveLength(1);
    expect(found[0]!.props["data-pending-suspensions"]).toBe(3);
    expect(srText(found[0]!)).toBe("3 bans awaiting your review");
  });

  it("NOT entitled (the pass-scoped gate 402s) ⇒ no dot, and the count is never read", async () => {
    disc.getDisciplineRules.mockRejectedValue(new PaymentRequiredError("discipline.enforced"));
    disc.countBansToReview.mockResolvedValue(3);
    expect(dots(await renderTab("standings"))).toHaveLength(0);
    expect(disc.countBansToReview).not.toHaveBeenCalled();
  });

  it("a sport with no card model (no Discipline tab) ⇒ no dot, and the count is never read", async () => {
    disc.getDisciplineRules.mockResolvedValue(null);
    disc.countBansToReview.mockResolvedValue(3);
    expect(dots(await renderTab("standings"))).toHaveLength(0);
    expect(disc.countBansToReview).not.toHaveBeenCalled();
  });

  it("a viewer sees no dot, and nothing is counted for them — organiser-only", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    disc.countBansToReview.mockResolvedValue(3);
    expect(dots(await renderTab("standings"))).toHaveLength(0);
    expect(disc.countBansToReview).not.toHaveBeenCalled();
  });
});
