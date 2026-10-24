// W2c Task 20 (S4): the division page hands the settings form the two locks, each from its own source. The form's lock lines
// are proven by division-settings-lock-lines.test.tsx and the loader by division-locked-fields.test.ts; what neither can see
// is the page's own call (AGENTS.md class 1, the inert seam: a prop the form declares and nothing sends). This calls the
// async server component with the settings tab and reads the props on the <DivisionSettings> element it returns:
//  - `lockedFields` is what the loader answered for THIS division under THIS session (not a constant, not empty);
//  - `structureLocked` is "a fixture exists" (the stage-graph door) and nothing else - it must NOT follow the loader, which
//    answers [] for a generated division that no stage has started.
// Same mock scaffold as registration-hub-link.test.tsx in this dir: no jsdom, so the returned element tree is walked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { RefusedField } from "@/lib/rule-errors";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
const competitionsSpy = vi.hoisted(() => ({ getCompetition: vi.fn() }));
const fixturesSpy = vi.hoisted(() => ({
  listDivisionFixtures: vi.fn(),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
const lockSpy = vi.hoisted(() => ({ divisionLockedFields: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/competitions", () => competitionsSpy);
vi.mock("@/server/usecases/fixtures", () => fixturesSpy);
vi.mock("@/server/usecases/rule-locks", () => lockSpy);

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
    sport_key: "badminton",
    variant_key: "short",
    module_version: "1.0.0",
    config: {},
    tiebreakers: undefined,
    auto_posts: false,
    show_seeds: true,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({
  divisionConsumesSlotOnArchive: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
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
vi.mock("@/server/usecases/stream-sessions", () => ({
  openStreamStates: async () => ({}),
}));

import DivisionPage from "../page";
import { DivisionSettings } from "@/components/v2/division-settings";

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

/** A generated, unplayed fixture row - the columns the page reads (a stored terminal row is not what this test is about). */
const FIXTURE = {
  id: "fx-1",
  stage_id: "stage-a",
  status: "scheduled",
  scheduled_at: null,
  home_entrant_id: "e-ana",
  away_entrant_id: "e-ben",
  home_slot_label: null,
  away_slot_label: null,
  outcome: null,
  round: 1,
  position: 0,
  fixture_no: 1,
};

const LOCKS: RefusedField[] = [
  { field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: "stage-a", stageName: "Pool A" },
  { field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: "stage-a", stageName: "Pool A" },
];

const renderSettings = () =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "settings" }),
  });

async function settingsProps(): Promise<{ structureLocked: boolean; lockedFields: RefusedField[] }> {
  const found = findAll(await renderSettings(), DivisionSettings);
  expect(found, "the settings tab renders exactly one <DivisionSettings>").toHaveLength(1);
  return found[0]!.props as { structureLocked: boolean; lockedFields: RefusedField[] };
}

describe("the division page hands the settings form its two locks, each from its own source", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    stagesSpies.getSeedProposal.mockReset();
    stagesSpies.getStageRosterDrift.mockReset().mockResolvedValue({ ghosts: [], unplaced: [] });
    competitionsSpy.getCompetition
      .mockReset()
      .mockResolvedValue({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" });
    fixturesSpy.listDivisionFixtures.mockReset().mockResolvedValue([]);
    lockSpy.divisionLockedFields.mockReset().mockResolvedValue([]);
  });

  it("lockedFields is what the loader answered, asked for THIS division under THIS session", async () => {
    lockSpy.divisionLockedFields.mockResolvedValue(LOCKS);
    const props = await settingsProps();
    expect(props.lockedFields).toEqual(LOCKS);
    expect(lockSpy.divisionLockedFields).toHaveBeenCalledTimes(1);
    expect(lockSpy.divisionLockedFields).toHaveBeenCalledWith(PAGE.auth, "div-1");
  });

  it("the empty case: a loader that locks nothing hands the form an empty list (not undefined)", async () => {
    const props = await settingsProps();
    expect(props.lockedFields).toEqual([]);
  });

  it("structureLocked follows the fixtures, not the loader: fixtures and NO started stage lock the structure and nothing else", async () => {
    fixturesSpy.listDivisionFixtures.mockResolvedValue([FIXTURE]);
    lockSpy.divisionLockedFields.mockResolvedValue([]);
    const props = await settingsProps();
    expect(props.structureLocked, "a fixture exists: the stage graph is history").toBe(true);
    expect(props.lockedFields, "no stage has started: no rule is locked").toEqual([]);
  });

  it("no fixtures: the structure is open, and a loader that locks something does not close it", async () => {
    fixturesSpy.listDivisionFixtures.mockResolvedValue([]);
    lockSpy.divisionLockedFields.mockResolvedValue(LOCKS);
    const props = await settingsProps();
    expect(props.structureLocked).toBe(false);
    expect(props.lockedFields).toEqual(LOCKS);
  });
});
