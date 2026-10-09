// W2a fix round 1 (M3, M10) — the division page reads a recorded abandon awaiting its settle the way the desk does.
// A knockout whose only fixture (the final) was abandoned with nobody decided is stored `abandoned`, so every fixture
// is terminal — the shape that read "Finished" (addendum 9). The page must hand `resolvePhase` the hold
// (`awaitsSettle`, from `listFixturesAwaitingSettle`) and thread the same ids to the run sheet (M10). The division page
// renders no phase pill, so this is asserted where the phase goes: StagesPanel's `phase` prop. Same harness as the
// sibling roster-drift-stage-wiring.test.tsx (no jsdom; the async server component is called directly and its returned
// element tree walked).
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
const fixtureSpies = vi.hoisted(() => ({
  listDivisionFixtures: vi.fn(),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/fixtures", () => fixtureSpies);
const deskSpies = vi.hoisted(() => ({ listFixturesAwaitingSettle: vi.fn() }));
vi.mock("@/server/usecases/competition-desk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/competition-desk")>()),
  listFixturesAwaitingSettle: deskSpies.listFixturesAwaitingSettle,
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

const KO_STAGE = { id: "stage-ko", name: "Cup", kind: "knockout", seq: 1, status: "active", config: {}, progression: null };
/** The final, abandoned with nobody decided — every fixture of the division is stored terminal. */
const FINAL = {
  id: "fx-final",
  stage_id: "stage-ko",
  status: "abandoned",
  scheduled_at: null,
  home_entrant_id: "e-ana",
  away_entrant_id: "e-ben",
  home_slot_label: null,
  away_slot_label: null,
  outcome: { kind: "abandoned", reason: "floodlights" },
  round: 1,
  position: 0,
  fixture_no: 1,
};

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const renderTab = () =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "fixtures" }),
  });

type PanelProps = { phase?: string; awaitingSettle?: readonly string[] };

describe("the division page reads an abandoned final awaiting its settle as owed work (fix round 1, M3/M10)", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([KO_STAGE]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    fixtureSpies.listDivisionFixtures.mockReset().mockResolvedValue([FINAL]);
  });

  it("positive pair first: the same final NOT awaiting a settle (a table-stage abandon, say) reads finished", async () => {
    deskSpies.listFixturesAwaitingSettle.mockReset().mockResolvedValue(new Set());
    const panel = find(await renderTab(), StagesPanel);
    expect(panel, "the fixtures tab mounts StagesPanel").not.toBeNull();
    const props = panel!.props as PanelProps;
    // Rulebook, not this code: every fixture terminal and nothing owed is the division-phase.ts rule-2 "finished".
    expect(props.phase).toBe("finished");
    expect(props.awaitingSettle).toEqual([]);
  });

  it("the final awaiting its settle is NOT finished (addendum 9), and its id reaches the run sheet (M10)", async () => {
    deskSpies.listFixturesAwaitingSettle.mockReset().mockResolvedValue(new Set([FINAL.id]));
    const panel = find(await renderTab(), StagesPanel);
    expect(panel).not.toBeNull();
    const props = panel!.props as PanelProps;
    expect(props.phase, "a held final is owed work, never Finished").not.toBe("finished");
    expect(props.phase).toBeDefined();
    expect(props.awaitingSettle).toEqual([FINAL.id]);
    expect(deskSpies.listFixturesAwaitingSettle).toHaveBeenCalledTimes(1);
    expect(deskSpies.listFixturesAwaitingSettle.mock.calls[0]![1], "asked about THIS division").toBe("div-1");
  });
});
