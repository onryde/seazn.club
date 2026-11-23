// W5 follow-ups B1 (perf-measure-report P1): the org division page loaded the division's whole fixture list into
// `<LaunchActions fixtures>` on EVERY tab - 5.1 MB of flight at the caps - although LaunchActions reads it only to let the
// Start gate dialog name the matches it refuses, and Start is offered only while scoring is closed (`divisionScoringClosed`,
// status setup|scheduled). Once the division has started the list reaches LaunchActions empty and the confirmation's one
// question ("are there fixtures?") travels as a boolean. Before Start nothing changes.
//
// Same scaffold as division-header-sport-label.test.tsx (no jsdom: the async server component called directly, its tree
// walked). The sweep reads every element the page returns on the three non-fixtures tabs and fails on any prop that IS the
// loaded list - the positive pair (before Start, LaunchActions carries it) proves the sweep can see it.
// single-sport (generic): the prop rides the division status, never a sport rule.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";


const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "es" | "fr" | "nl",
  sport_key: "generic",
  variant_key: "score",
  status: "active",
  fixtures: [] as Record<string, unknown>[],
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(async () => false),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => state.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: state.status,
    sport_key: state.sport_key,
    variant_key: state.variant_key,
    module_version: "1.0.0",
    config: {},
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
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
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
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
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
  // As the real one: a `privilegedPrelude` (match-day's sealed read of the round opens, `withRoundOpensToday`) runs first, on the
  // same transaction, before `fn`.
  withTenant: async (_orgId: string, fn: (t: unknown) => unknown, opts?: { privilegedPrelude?: (t: unknown) => Promise<void> }) => {
    await opts?.privilegedPrelude?.(tx);
    return fn(tx);
  },
  statementCount: () => 0,
}));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});

import DivisionPage from "../page";
import { LaunchActions } from "@/components/v2/launch-actions";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const renderPage = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child as ReactNode, visit);
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

const fixture = (i: number) => ({
  id: `fx-${i}`,
  fixture_no: i,
  stage_id: "st-1",
  pool_id: null,
  round_no: 1,
  seq_in_round: i,
  home_entrant_id: `e-${2 * i}`,
  away_entrant_id: `e-${2 * i + 1}`,
  status: i === 1 ? "decided" : "scheduled",
  slot_id: null,
  court_id: null,
});

async function launchProps(tab: string): Promise<{ fixtures: unknown[]; fixturesExist: unknown }> {
  const found: ReactElement[] = [];
  walk(await renderPage(tab), (el) => {
    if (el.type === LaunchActions) found.push(el);
  });
  expect(found, `${tab}: exactly one LaunchActions in the header`).toHaveLength(1);
  return found[0]!.props as { fixtures: unknown[]; fixturesExist: unknown };
}

beforeEach(() => {
  state.status = "active";
  state.fixtures = [fixture(1), fixture(2), fixture(3)];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
});

describe("B1 LaunchActions gets the fixture list only before Start", () => {
  it("started (active, completed): every tab hands LaunchActions no list, and says the fixtures exist as a boolean", async () => {
    let checked = 0;
    for (const status of ["active", "completed"]) {
      state.status = status;
      for (const tab of ["entrants", "fixtures", "standings", "stats"]) {
        const p = await launchProps(tab);
        expect(p.fixtures, `${status} ${tab}: no list`).toEqual([]);
        expect(p.fixturesExist, `${status} ${tab}: the confirmation still knows fixtures exist`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two statuses x four tabs").toBe(8);
  });

  it("before Start (setup, scheduled): the gate dialog still gets the whole list, so it can name the matches it refuses", async () => {
    let checked = 0;
    for (const status of ["setup", "scheduled"]) {
      state.status = status;
      const p = await launchProps("entrants");
      expect(p.fixtures, status).toBe(state.fixtures);
      expect(p.fixturesExist, status).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the empty case: no fixtures at all reads fixturesExist false, before and after Start", async () => {
    state.fixtures = [];
    for (const status of ["setup", "active"]) {
      state.status = status;
      expect((await launchProps("entrants")).fixturesExist, status).toBe(false);
    }
  });

  it("no non-fixtures tab of a started division hands any element the loaded list (the positive pair: before Start, LaunchActions does)", async () => {
    const carriers = async (tab: string) => {
      const out: string[] = [];
      let elements = 0;
      walk(await renderPage(tab), (el) => {
        elements++;
        for (const [k, v] of Object.entries(el.props as Record<string, unknown>)) {
          if (v === state.fixtures) out.push(`${typeof el.type === "function" ? el.type.name : String(el.type)}.${k}`);
        }
      });
      expect(elements, `${tab}: anti-vacuity - the tree was walked`).toBeGreaterThan(10);
      return out;
    };
    state.status = "setup";
    expect(await carriers("standings"), "the positive pair: before Start the sweep sees LaunchActions carry it").toContain("LaunchActions.fixtures");
    state.status = "active";
    let checked = 0;
    for (const tab of ["entrants", "standings", "stats"]) {
      expect(await carriers(tab), `${tab}: nothing carries the list`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
